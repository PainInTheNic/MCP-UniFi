/**
 * Firewall & policy tools: zone-based firewall policies, firewall zones,
 * ACL rules, and DNS policies. Reads plus one carefully-scoped write
 * (enable/disable an existing policy).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, jsonBlock, line, lines, textResult } from "../format.js";
import {
  filterField,
  guard,
  limitField,
  offsetField,
  responseFormatField,
  runListTool,
  siteIdField,
  uuidField,
} from "./shared.js";

/** metadata.origin distinguishes USER_DEFINED from SYSTEM_DEFINED/DERIVED objects. */
interface UniFiMetadata {
  origin?: string;
}

interface FirewallPolicy {
  id: string;
  name?: string;
  enabled?: boolean;
  action?: string;
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
  action?: string;
  type?: string;
  [key: string]: unknown;
}

interface DnsPolicy {
  id: string;
  name?: string;
  domain?: string;
  type?: string;
  enabled?: boolean;
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
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, filter, limit, offset, response_format }) =>
      runListTool<FirewallPolicy>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/firewall/policies`,
        heading: "Firewall policies",
        emptyMessage: "No firewall policies found on this site.",
        formatItem: (p) =>
          lines(
            `- **${p.name ?? "unnamed"}** — ${p.action ?? "?"}${p.enabled === false ? " (disabled)" : ""}${systemTag(p.metadata)}`,
            line("  id", `\`${p.id}\``),
          ),
      }),
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
        await client.put(`/v1/sites/${site}/firewall/policies/${policyId}`, { ...policy, enabled });
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
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, response_format }) =>
      runListTool<FirewallZone>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
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
        "List layer-2/switch ACL rules on a site with name, action, and enabled state. These are switching-level ACLs, separate from zone firewall policies.",
      inputSchema: {
        siteId: siteIdField,
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, response_format }) =>
      runListTool<AclRule>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        path: (site) => `/v1/sites/${site}/acl-rules`,
        heading: "ACL rules",
        emptyMessage: "No ACL rules found on this site.",
        formatItem: (r) =>
          lines(
            `- **${r.name ?? "unnamed"}** — ${r.action ?? "?"}${r.enabled === false ? " (disabled)" : ""}`,
            line("  id", `\`${r.id}\``),
            line("  type", r.type),
          ),
      }),
  );

  server.registerTool(
    "unifi_list_dns_policies",
    {
      title: "List DNS Policies",
      description: "List DNS filtering/policy entries on a site (e.g. domain blocks) with name and enabled state.",
      inputSchema: {
        siteId: siteIdField,
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, response_format }) =>
      runListTool<DnsPolicy>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        path: (site) => `/v1/sites/${site}/dns/policies`,
        heading: "DNS policies",
        emptyMessage: "No DNS policies found on this site.",
        formatItem: (p) =>
          lines(
            `- **${p.domain ?? p.name ?? "unnamed"}**${p.type ? ` (${p.type})` : ""}${p.enabled === false ? " (disabled)" : ""}`,
            line("  id", `\`${p.id}\``),
          ),
      }),
  );
}
