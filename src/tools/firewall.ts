/**
 * Firewall & policy tools: zone-based firewall policies, firewall zones,
 * ACL rules, and DNS policies. Reads plus one carefully-scoped write
 * (enable/disable an existing policy).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, formatAction, jsonBlock, jsonResult, line, lines, textResult } from "../format.js";
import {
  configField,
  filterField,
  guard,
  limitField,
  offsetField,
  responseFormatField,
  runCreate,
  runDelete,
  runListTool,
  runUpdate,
  siteIdField,
  uuidField,
} from "./shared.js";

/** metadata.origin distinguishes USER_DEFINED from SYSTEM_DEFINED/DERIVED objects. */
interface UniFiMetadata {
  origin?: string;
}

/** A string on older UniFi Network versions, an object on newer ones (see formatAction). */
type PolicyAction = string | { type?: string; allowReturnTraffic?: boolean };

interface FirewallPolicy {
  id: string;
  name?: string;
  enabled?: boolean;
  action?: PolicyAction;
  source?: { zoneId?: string };
  destination?: { zoneId?: string };
  metadata?: UniFiMetadata;
  [key: string]: unknown;
}

interface FirewallZone {
  id: string;
  name?: string;
  networkIds?: string[];
  metadata?: UniFiMetadata;
  [key: string]: unknown;
}

/** " [system]" tag for objects the user did not create and usually cannot edit. */
function systemTag(metadata?: UniFiMetadata): string {
  return metadata?.origin && metadata.origin !== "USER_DEFINED" ? " [system]" : "";
}

interface AclRule {
  id: string;
  name?: string;
  enabled?: boolean;
  action?: PolicyAction;
  type?: string;
  [key: string]: unknown;
}

interface DnsPolicy {
  id: string;
  domain?: string;
  type?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** Traffic matching lists: reusable named IP/domain lists referenced by firewall policies. */
interface TrafficMatchingList {
  id: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

export function registerFirewallTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_firewall_policies",
    {
      title: "List Firewall Policies",
      description:
        "List zone-based firewall policies on a site: name, action (ALLOW/BLOCK/REJECT), enabled state, and whether system-defined. Use unifi_get_firewall_policy for full match criteria. Filter examples: \"name.like('*Block*')\", \"metadata.origin.eq('USER_DEFINED')\".",
      inputSchema: {
        siteId: siteIdField,
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, filter, limit, offset, responseFormat }) => {
      // Zone names, so each policy reads "Internal → External" rather than two UUIDs. Markdown only,
      // and best effort: if the zones can't be read, the IDs are shown instead.
      const zoneNames = new Map<string, string>();
      if (responseFormat !== ResponseFormat.JSON) {
        try {
          const site = await client.resolveSiteId(siteId);
          const zones = await client.page<FirewallZone>(`/v1/sites/${site}/firewall/zones`, { limit: 200 });
          for (const z of zones.data) if (z.name) zoneNames.set(z.id, z.name);
        } catch {
          // fall back to zone IDs below
        }
      }
      const zone = (id?: string) => (id ? (zoneNames.get(id) ?? `\`${id}\``) : "?");
      return runListTool<FirewallPolicy>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/firewall/policies`,
        heading: "Firewall policies",
        emptyMessage: "No firewall policies found on this site.",
        formatItem: (p) =>
          lines(
            `- **${p.name ?? "unnamed"}** — ${formatAction(p.action)}${p.enabled === false ? " (disabled)" : ""}${systemTag(p.metadata)}`,
            line("  id", `\`${p.id}\``),
            p.source?.zoneId || p.destination?.zoneId ? line("  zones", `${zone(p.source?.zoneId)} → ${zone(p.destination?.zoneId)}`) : undefined,
          ),
      });
    },
  );

  server.registerTool(
    "unifi_get_firewall_policy",
    {
      title: "Get Firewall Policy Details",
      description:
        "Get the full definition of one firewall policy by ID: source/destination zones and matchers, protocol, action, schedule, logging. IDs come from unifi_list_firewall_policies.",
      inputSchema: {
        siteId: siteIdField,
        policyId: uuidField("Firewall policy ID (UUID from unifi_list_firewall_policies)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, policyId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const p = await client.get<FirewallPolicy>(`/v1/sites/${site}/firewall/policies/${policyId}`);
        // Full policy objects are complex and vary by matcher type — raw JSON
        // is the honest representation.
        return textResult(jsonBlock(p));
      }),
  );

  server.registerTool(
    "unifi_set_firewall_policy_enabled",
    {
      title: "Enable/Disable Firewall Policy",
      description:
        "Enable or disable an existing user-defined firewall policy (system/predefined policies cannot be modified). This changes live traffic filtering — confirm with the user before toggling a policy, and double-check WHICH policy with unifi_get_firewall_policy first.",
      inputSchema: {
        siteId: siteIdField,
        policyId: uuidField("Firewall policy ID (UUID from unifi_list_firewall_policies)"),
        enabled: z.boolean().describe("true to enable the policy, false to disable it"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, policyId, enabled }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        // The API's PATCH only covers loggingEnabled, so toggling requires a
        // full read-modify-write with PUT.
        const policy = await client.get<FirewallPolicy>(`/v1/sites/${site}/firewall/policies/${policyId}`);
        if (policy.enabled === enabled) {
          return textResult(`Firewall policy "${policy.name ?? policyId}" is already ${enabled ? "enabled" : "disabled"} — no change made.`);
        }
        // Send only the update-schema fields: server-managed id/index/metadata
        // are response-only and not part of the "Create or update" contract.
        const { id: _id, index: _index, metadata: _metadata, ...updatable } = policy;
        // The body is the raw (unredacted) policy plus a boolean, so a
        // "[redacted]" in it is the user's own name/description text, not a
        // placeholder copied back from a read: skip the write-back guard.
        await client.put(
          `/v1/sites/${site}/firewall/policies/${policyId}`,
          { ...updatable, enabled },
          { bodyFromConsole: true },
        );
        return textResult(`Firewall policy "${policy.name ?? policyId}" is now ${enabled ? "ENABLED" : "DISABLED"}.`);
      }),
  );

  server.registerTool(
    "unifi_list_firewall_zones",
    {
      title: "List Firewall Zones",
      description:
        "List the firewall zones on a site (e.g. Internal, External, Gateway, VPN, Hotspot, plus custom zones) and which networks belong to each. Zone IDs appear in firewall policies' source/destination.",
      inputSchema: {
        siteId: siteIdField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, responseFormat }) =>
      runListTool<FirewallZone>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        path: (site) => `/v1/sites/${site}/firewall/zones`,
        heading: "Firewall zones",
        emptyMessage: "No firewall zones found on this site.",
        formatItem: (zn) =>
          lines(
            `- **${zn.name ?? "unnamed"}**${systemTag(zn.metadata)}`,
            line("  id", `\`${zn.id}\``),
            line("  networks", zn.networkIds?.length ? zn.networkIds.map((n) => `\`${n}\``).join(", ") : undefined),
          ),
      }),
  );

  server.registerTool(
    "unifi_list_acl_rules",
    {
      title: "List ACL Rules",
      description:
        "List layer-2/switch ACL rules on a site with name, action, and enabled state. These are switching-level ACLs, separate from zone firewall policies. Filter example: \"action.eq('BLOCK')\".",
      inputSchema: {
        siteId: siteIdField,
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, filter, limit, offset, responseFormat }) =>
      runListTool<AclRule>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/acl-rules`,
        heading: "ACL rules",
        emptyMessage: "No ACL rules found on this site.",
        formatItem: (r) =>
          lines(
            `- **${r.name ?? "unnamed"}** — ${formatAction(r.action)}${r.enabled === false ? " (disabled)" : ""}`,
            line("  id", `\`${r.id}\``),
            line("  type", r.type),
          ),
      }),
  );

  server.registerTool(
    "unifi_get_acl_rule",
    {
      title: "Get ACL Rule Details",
      description:
        "Get the full definition of one layer-2/switch ACL rule by ID: source/destination filters (IP- or MAC-based), enforcing-device filter, action, and index. IDs come from unifi_list_acl_rules.",
      inputSchema: {
        siteId: siteIdField,
        aclRuleId: uuidField("ACL rule ID (UUID from unifi_list_acl_rules)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, aclRuleId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const rule = await client.get<AclRule>(`/v1/sites/${site}/acl-rules/${aclRuleId}`);
        // Source/destination/enforcing-device filters are discriminated unions
        // whose shape varies by type — raw JSON is the honest representation.
        return textResult(jsonBlock(rule));
      }),
  );

  server.registerTool(
    "unifi_list_dns_policies",
    {
      title: "List DNS Policies",
      description:
        "List custom local DNS records and forward-domain policies on a site — A/AAAA/CNAME/MX/SRV/TXT records and FORWARD_DOMAIN rules the gateway resolves locally. NOTE: this is local DNS record management, NOT DNS content filtering or domain blocking. Each entry has a domain, a record type, and enabled state. Filter example: \"domain.like('*.home.arpa')\".",
      inputSchema: {
        siteId: siteIdField,
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, filter, limit, offset, responseFormat }) =>
      runListTool<DnsPolicy>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/dns/policies`,
        heading: "DNS records / policies",
        emptyMessage: "No local DNS records or forward-domain policies configured on this site.",
        formatItem: (p) =>
          lines(
            `- **${p.domain ?? "unnamed"}**${p.type ? ` (${p.type})` : ""}${p.enabled === false ? " (disabled)" : ""}`,
            line("  id", `\`${p.id}\``),
          ),
      }),
  );

  server.registerTool(
    "unifi_get_dns_policy",
    {
      title: "Get DNS Policy Details",
      description:
        "Get one local DNS record / forward-domain policy by ID: domain, record type (A/AAAA/CNAME/MX/SRV/TXT/FORWARD_DOMAIN), and enabled state. This is local DNS record management, not content filtering. IDs come from unifi_list_dns_policies.",
      inputSchema: {
        siteId: siteIdField,
        dnsPolicyId: uuidField("DNS policy ID (UUID from unifi_list_dns_policies)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, dnsPolicyId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const p = await client.get<DnsPolicy>(`/v1/sites/${site}/dns/policies/${dnsPolicyId}`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(p));
        return textResult(
          lines(
            `## ${p.domain ?? "DNS policy"}${p.enabled === false ? " (disabled)" : ""}`,
            line("ID", `\`${p.id}\``),
            line("Domain", p.domain),
            line("Type", p.type),
            line("Enabled", p.enabled === undefined ? undefined : p.enabled ? "yes" : "no"),
          ),
        );
      }),
  );

  // Traffic matching lists: reusable named IP/domain lists referenced by firewall policies.
  server.registerTool(
    "unifi_list_traffic_matching_lists",
    {
      title: "List Traffic Matching Lists",
      description:
        "List reusable traffic-matching lists on a site — named IP-address or port lists (type IPV4_ADDRESSES / IPV6_ADDRESSES / PORTS) that firewall policies reference instead of inlining addresses. Use unifi_get_traffic_matching_list for one list's entries.",
      inputSchema: {
        siteId: siteIdField,
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, filter, limit, offset, responseFormat }) =>
      runListTool<TrafficMatchingList>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/traffic-matching-lists`,
        heading: "Traffic matching lists",
        emptyMessage: "No traffic matching lists configured on this site.",
        formatItem: (t) =>
          lines(
            `- **${t.name ?? "unnamed"}**${t.type ? ` (${t.type})` : ""}`,
            line("  id", `\`${t.id}\``),
          ),
      }),
  );

  server.registerTool(
    "unifi_get_traffic_matching_list",
    {
      title: "Get Traffic Matching List",
      description:
        "Get one traffic-matching list by ID, including its entries. IDs come from unifi_list_traffic_matching_lists.",
      inputSchema: {
        siteId: siteIdField,
        trafficMatchingListId: uuidField("Traffic matching list ID (UUID from unifi_list_traffic_matching_lists)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, trafficMatchingListId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const t = await client.get<TrafficMatchingList>(
          `/v1/sites/${site}/traffic-matching-lists/${trafficMatchingListId}`,
        );
        // Entry contents vary by list type — raw JSON is the honest representation.
        return textResult(jsonBlock(t));
      }),
  );

  // ---- Firewall policies: create / update / delete / reorder ----
  server.registerTool(
    "unifi_create_firewall_policy",
    {
      title: "Create Firewall Policy",
      description:
        "Create a zone-based firewall policy. 'config' is the full policy object; required: name, enabled, action (ALLOW/BLOCK/REJECT), source, destination, ipProtocolScope, loggingEnabled. Model it on an existing policy fetched via unifi_get_firewall_policy. CAUTION: a new ALLOW/BLOCK policy changes live traffic filtering — confirm with the user.",
      inputSchema: {
        siteId: siteIdField,
        config: configField(
          "Full firewall policy object. Required: name, enabled, action, source, destination, ipProtocolScope, loggingEnabled. See unifi_get_firewall_policy for the shape.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, config }) =>
      runCreate<FirewallPolicy>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/firewall/policies`,
        body: config,
        label: "firewall policy",
      }),
  );

  server.registerTool(
    "unifi_update_firewall_policy",
    {
      title: "Update Firewall Policy",
      description:
        "Replace a user-defined firewall policy (full PUT). Fetch the current object with unifi_get_firewall_policy, modify it, and pass it as 'config' (system-defined policies cannot be edited). CAUTION: this changes live traffic filtering — confirm with the user and double-check WHICH policy. For a simple enable/disable use unifi_set_firewall_policy_enabled instead. IDs come from unifi_list_firewall_policies.",
      inputSchema: {
        siteId: siteIdField,
        policyId: uuidField("Firewall policy ID (UUID from unifi_list_firewall_policies)"),
        config: configField("Full firewall policy object to write (fetch current via unifi_get_firewall_policy, then modify)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, policyId, config }) =>
      runUpdate<FirewallPolicy>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/firewall/policies/${policyId}`,
        body: config,
        label: `firewall policy ${policyId}`,
      }),
  );

  server.registerTool(
    "unifi_delete_firewall_policy",
    {
      title: "Delete Firewall Policy",
      description:
        "Delete a user-defined firewall policy. CAUTION: irreversible and changes live traffic filtering — confirm with the user and verify the policy with unifi_get_firewall_policy first. System-defined policies cannot be deleted. IDs come from unifi_list_firewall_policies.",
      inputSchema: {
        siteId: siteIdField,
        policyId: uuidField("Firewall policy ID (UUID from unifi_list_firewall_policies)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, policyId }) =>
      runDelete({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/firewall/policies/${policyId}`,
        label: `firewall policy ${policyId}`,
      }),
  );

  server.registerTool(
    "unifi_get_firewall_policy_ordering",
    {
      title: "Get Firewall Policy Ordering",
      description:
        "Get the current evaluation order of user-defined firewall policies for one source→destination zone pair — the policy IDs split into those evaluated before and after the system-defined policies. Use this before unifi_reorder_firewall_policies. Zone IDs come from unifi_list_firewall_zones.",
      inputSchema: {
        siteId: siteIdField,
        sourceFirewallZoneId: uuidField("Source firewall zone ID (from unifi_list_firewall_zones)"),
        destinationFirewallZoneId: uuidField("Destination firewall zone ID (from unifi_list_firewall_zones)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, sourceFirewallZoneId, destinationFirewallZoneId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const ordering = await client.get(`/v1/sites/${site}/firewall/policies/ordering`, {
          sourceFirewallZoneId,
          destinationFirewallZoneId,
        });
        return jsonResult("", ordering);
      }),
  );

  server.registerTool(
    "unifi_reorder_firewall_policies",
    {
      title: "Reorder Firewall Policies",
      description:
        "Set the evaluation order of user-defined firewall policies for one source→destination zone pair. The API splits user policies into those evaluated BEFORE the zone's system-defined policies and those AFTER, so pass two ordered lists. Use unifi_get_firewall_policy_ordering (or model on the current order) to see the existing split. CAUTION: order determines which rule wins — reordering changes what traffic is allowed/blocked; confirm with the user. Zone IDs come from unifi_list_firewall_zones; policy IDs from unifi_list_firewall_policies.",
      inputSchema: {
        siteId: siteIdField,
        sourceFirewallZoneId: uuidField("Source firewall zone ID (from unifi_list_firewall_zones)"),
        destinationFirewallZoneId: uuidField("Destination firewall zone ID (from unifi_list_firewall_zones)"),
        beforeSystemDefined: z
          .array(z.string().uuid())
          .describe("User-defined policy IDs evaluated BEFORE the system-defined policies for this zone pair, in order"),
        afterSystemDefined: z
          .array(z.string().uuid())
          .describe("User-defined policy IDs evaluated AFTER the system-defined policies for this zone pair, in order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, sourceFirewallZoneId, destinationFirewallZoneId, beforeSystemDefined, afterSystemDefined }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const q = new URLSearchParams({ sourceFirewallZoneId, destinationFirewallZoneId }).toString();
        await client.put(`/v1/sites/${site}/firewall/policies/ordering?${q}`, {
          orderedFirewallPolicyIds: { beforeSystemDefined, afterSystemDefined },
        });
        return textResult(
          `Reordered firewall policies for the given zone pair (${beforeSystemDefined.length} before, ${afterSystemDefined.length} after the system-defined policies).`,
        );
      }),
  );

  // ---- Firewall zones: create / update / delete (custom zones only) ----
  server.registerTool(
    "unifi_create_firewall_zone",
    {
      title: "Create Custom Firewall Zone",
      description:
        "Create a custom firewall zone grouping one or more networks. 'config' requires name (string) and networkIds (array of network UUIDs from unifi_list_networks). Returns the created zone.",
      inputSchema: {
        siteId: siteIdField,
        config: configField("Zone object. Required: name (string), networkIds (array of network UUIDs)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, config }) =>
      runCreate<FirewallZone>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/firewall/zones`,
        body: config,
        label: "firewall zone",
      }),
  );

  server.registerTool(
    "unifi_update_firewall_zone",
    {
      title: "Update Firewall Zone",
      description:
        "Replace a firewall zone (full PUT) — e.g. change which networks belong to it. Fetch the current zone via unifi_list_firewall_zones, modify, and pass as 'config'. CAUTION: moving networks between zones changes which firewall policies apply to them; confirm with the user. IDs come from unifi_list_firewall_zones.",
      inputSchema: {
        siteId: siteIdField,
        zoneId: uuidField("Firewall zone ID (UUID from unifi_list_firewall_zones)"),
        config: configField("Full zone object to write. Typically name + networkIds."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, zoneId, config }) =>
      runUpdate<FirewallZone>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/firewall/zones/${zoneId}`,
        body: config,
        label: `firewall zone ${zoneId}`,
      }),
  );

  server.registerTool(
    "unifi_delete_firewall_zone",
    {
      title: "Delete Custom Firewall Zone",
      description:
        "Delete a custom firewall zone. Only custom (user-defined) zones can be deleted — system zones cannot. CAUTION: irreversible; policies referencing this zone may be affected. Confirm with the user. IDs come from unifi_list_firewall_zones.",
      inputSchema: {
        siteId: siteIdField,
        zoneId: uuidField("Firewall zone ID (UUID from unifi_list_firewall_zones)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, zoneId }) =>
      runDelete({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/firewall/zones/${zoneId}`,
        label: `firewall zone ${zoneId}`,
      }),
  );

  // ---- ACL rules: create / update / delete / reorder ----
  server.registerTool(
    "unifi_create_acl_rule",
    {
      title: "Create ACL Rule",
      description:
        "Create a layer-2/switch ACL rule. 'config' requires action (ALLOW/BLOCK), enabled, name, type; plus sourceFilter/destinationFilter/enforcingDeviceFilter as needed. Model it on an existing rule fetched via unifi_get_acl_rule. CAUTION: changes switching-level access; confirm with the user.",
      inputSchema: {
        siteId: siteIdField,
        config: configField(
          "Full ACL rule object. Required: action, enabled, name, type. See unifi_get_acl_rule for the filter shapes.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, config }) =>
      runCreate<AclRule>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/acl-rules`,
        body: config,
        label: "ACL rule",
      }),
  );

  server.registerTool(
    "unifi_update_acl_rule",
    {
      title: "Update ACL Rule",
      description:
        "Replace an ACL rule (full PUT). Fetch the current rule via unifi_get_acl_rule, modify, and pass as 'config'. CAUTION: changes switching-level access; confirm with the user. IDs come from unifi_list_acl_rules.",
      inputSchema: {
        siteId: siteIdField,
        aclRuleId: uuidField("ACL rule ID (UUID from unifi_list_acl_rules)"),
        config: configField("Full ACL rule object to write (fetch current via unifi_get_acl_rule, then modify)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, aclRuleId, config }) =>
      runUpdate<AclRule>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/acl-rules/${aclRuleId}`,
        body: config,
        label: `ACL rule ${aclRuleId}`,
      }),
  );

  server.registerTool(
    "unifi_delete_acl_rule",
    {
      title: "Delete ACL Rule",
      description:
        "Delete an ACL rule. CAUTION: irreversible and changes switching-level access; confirm with the user. IDs come from unifi_list_acl_rules.",
      inputSchema: {
        siteId: siteIdField,
        aclRuleId: uuidField("ACL rule ID (UUID from unifi_list_acl_rules)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, aclRuleId }) =>
      runDelete({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/acl-rules/${aclRuleId}`,
        label: `ACL rule ${aclRuleId}`,
      }),
  );

  server.registerTool(
    "unifi_get_acl_rule_ordering",
    {
      title: "Get ACL Rule Ordering",
      description:
        "Get the current evaluation order of user-defined ACL rules (an ordered list of rule IDs). Use this before unifi_reorder_acl_rules.",
      inputSchema: {
        siteId: siteIdField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const ordering = await client.get(`/v1/sites/${site}/acl-rules/ordering`);
        return jsonResult("", ordering);
      }),
  );

  server.registerTool(
    "unifi_reorder_acl_rules",
    {
      title: "Reorder ACL Rules",
      description:
        "Set the evaluation order of user-defined ACL rules. Pass every user-defined ACL rule ID in the desired order (see unifi_get_acl_rule_ordering for the current order). CAUTION: order determines which rule wins; confirm with the user. IDs come from unifi_list_acl_rules.",
      inputSchema: {
        siteId: siteIdField,
        orderedAclRuleIds: z
          .array(z.string().uuid())
          .describe("User-defined ACL rule IDs in the desired evaluation order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, orderedAclRuleIds }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        await client.put(`/v1/sites/${site}/acl-rules/ordering`, { orderedAclRuleIds });
        return textResult(`Reordered ${orderedAclRuleIds.length} ACL rule(s).`);
      }),
  );

  // ---- DNS records / policies: create / update / delete ----
  server.registerTool(
    "unifi_create_dns_policy",
    {
      title: "Create DNS Record / Policy",
      description:
        "Create a local DNS record or forward-domain policy. 'config' requires type (A_RECORD/AAAA_RECORD/CNAME_RECORD/MX_RECORD/SRV_RECORD/TXT_RECORD/FORWARD_DOMAIN) and enabled, plus the type-specific fields (e.g. domain + ipv4Address + ttlSeconds for A_RECORD; domain + ipAddress for FORWARD_DOMAIN). This is local DNS record management, NOT domain blocking. Easiest: model it on an existing entry fetched via unifi_get_dns_policy (responseFormat='json').",
      inputSchema: {
        siteId: siteIdField,
        config: configField(
          "Full DNS record/policy object. Required: type, enabled, plus type-specific fields (domain, ipv4Address, etc.). See unifi_get_dns_policy.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, config }) =>
      runCreate<DnsPolicy>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/dns/policies`,
        body: config,
        label: "DNS record/policy",
      }),
  );

  server.registerTool(
    "unifi_update_dns_policy",
    {
      title: "Update DNS Record / Policy",
      description:
        "Replace a local DNS record / forward-domain policy (full PUT). Fetch the current object via unifi_get_dns_policy, modify, and pass as 'config'. IDs come from unifi_list_dns_policies.",
      inputSchema: {
        siteId: siteIdField,
        dnsPolicyId: uuidField("DNS policy ID (UUID from unifi_list_dns_policies)"),
        config: configField("Full DNS record/policy object to write (fetch current via unifi_get_dns_policy, then modify)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, dnsPolicyId, config }) =>
      runUpdate<DnsPolicy>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/dns/policies/${dnsPolicyId}`,
        body: config,
        label: `DNS record/policy ${dnsPolicyId}`,
      }),
  );

  server.registerTool(
    "unifi_delete_dns_policy",
    {
      title: "Delete DNS Record / Policy",
      description:
        "Delete a local DNS record / forward-domain policy. CAUTION: irreversible; confirm with the user. IDs come from unifi_list_dns_policies.",
      inputSchema: {
        siteId: siteIdField,
        dnsPolicyId: uuidField("DNS policy ID (UUID from unifi_list_dns_policies)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, dnsPolicyId }) =>
      runDelete({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/dns/policies/${dnsPolicyId}`,
        label: `DNS record/policy ${dnsPolicyId}`,
      }),
  );

  // ---- Traffic matching lists: create / update / delete ----
  server.registerTool(
    "unifi_create_traffic_matching_list",
    {
      title: "Create Traffic Matching List",
      description:
        "Create a reusable traffic-matching list (named IP-address or port list referenced by firewall policies). 'config' requires name and type (IPV4_ADDRESSES / IPV6_ADDRESSES / PORTS), plus the list entries. Model it on an existing list via unifi_get_traffic_matching_list.",
      inputSchema: {
        siteId: siteIdField,
        config: configField("Full traffic-matching-list object. Required: name, type, plus entries. See unifi_get_traffic_matching_list."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, config }) =>
      runCreate<TrafficMatchingList>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/traffic-matching-lists`,
        body: config,
        label: "traffic matching list",
      }),
  );

  server.registerTool(
    "unifi_update_traffic_matching_list",
    {
      title: "Update Traffic Matching List",
      description:
        "Replace a traffic-matching list (full PUT). Fetch the current list via unifi_get_traffic_matching_list, modify, and pass as 'config'. CAUTION: firewall policies referencing this list will use the new entries; confirm with the user. IDs come from unifi_list_traffic_matching_lists.",
      inputSchema: {
        siteId: siteIdField,
        trafficMatchingListId: uuidField("Traffic matching list ID (UUID from unifi_list_traffic_matching_lists)"),
        config: configField("Full traffic-matching-list object to write (fetch current first, then modify)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, trafficMatchingListId, config }) =>
      runUpdate<TrafficMatchingList>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/traffic-matching-lists/${trafficMatchingListId}`,
        body: config,
        label: `traffic matching list ${trafficMatchingListId}`,
      }),
  );

  server.registerTool(
    "unifi_delete_traffic_matching_list",
    {
      title: "Delete Traffic Matching List",
      description:
        "Delete a traffic-matching list. CAUTION: irreversible; firewall policies referencing it may break. Confirm with the user. IDs come from unifi_list_traffic_matching_lists.",
      inputSchema: {
        siteId: siteIdField,
        trafficMatchingListId: uuidField("Traffic matching list ID (UUID from unifi_list_traffic_matching_lists)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, trafficMatchingListId }) =>
      runDelete({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/traffic-matching-lists/${trafficMatchingListId}`,
        label: `traffic matching list ${trafficMatchingListId}`,
      }),
  );
}
