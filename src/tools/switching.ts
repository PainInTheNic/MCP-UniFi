/**
 * Switching topology tools: link aggregation (LAGs), multi-chassis LAG
 * domains for redundant switch pairs, and switch stacks. Advanced/niche —
 * most single-switch sites will have none of these configured.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

interface LagMember {
  deviceId?: string;
  portIdxs?: number[];
}

interface Lag {
  id: string;
  type?: string;
  members?: LagMember[];
  [key: string]: unknown;
}

interface McLagPeer {
  deviceId?: string;
  linkPortIdxs?: number[];
  role?: string;
}

interface McLagDomain {
  id: string;
  name?: string;
  lags?: Lag[];
  peers?: McLagPeer[];
  [key: string]: unknown;
}

interface SwitchStackMember {
  deviceId?: string;
}

interface SwitchStack {
  id: string;
  name?: string;
  members?: SwitchStackMember[];
  lags?: Lag[];
  [key: string]: unknown;
}

function memberSummary(members?: LagMember[]): string | undefined {
  if (!members || members.length === 0) return undefined;
  return members
    .map((m) => `${m.deviceId ?? "?"}${m.portIdxs?.length ? ` (ports: ${m.portIdxs.join(", ")})` : ""}`)
    .join("; ");
}

export function registerSwitchingTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_lags",
    {
      title: "List Link Aggregation Groups",
      description:
        "List Link Aggregation Groups (LAGs) on a site — bundles of switch ports acting as one logical link (LACP trunks). Use unifi_get_lag for one LAG's full membership.",
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
      runListTool<Lag>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/switching/lags`,
        heading: "Link aggregation groups (LAGs)",
        emptyMessage:
          "No link aggregation groups configured on this site (this feature is only relevant with switches running LACP trunks).",
        formatItem: (l) =>
          lines(
            `- **LAG**${l.type ? ` (${l.type})` : ""}`,
            line("  id", `\`${l.id}\``),
            line("  members", memberSummary(l.members)),
          ),
      }),
  );

  server.registerTool(
    "unifi_get_lag",
    {
      title: "Get LAG Details",
      description:
        "Get one Link Aggregation Group by ID: its type and member devices/ports. IDs come from unifi_list_lags.",
      inputSchema: {
        siteId: siteIdField,
        lagId: uuidField("LAG ID (UUID from unifi_list_lags)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, lagId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const l = await client.get<Lag>(`/v1/sites/${site}/switching/lags/${lagId}`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(l));
        return textResult(
          lines(
            `## LAG${l.type ? ` (${l.type})` : ""}`,
            line("ID", `\`${l.id}\``),
            line("Members", memberSummary(l.members)),
          ),
        );
      }),
  );

  server.registerTool(
    "unifi_list_mclag_domains",
    {
      title: "List MC-LAG Domains",
      description:
        "List Multi-Chassis LAG (MC-LAG) domains on a site — pairs of switches presenting shared LAGs for redundancy. Use unifi_get_mclag_domain for one domain's details.",
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
      runListTool<McLagDomain>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/switching/mc-lag-domains`,
        heading: "MC-LAG domains",
        emptyMessage: "No MC-LAG domains configured on this site (used only for redundant switch pairs).",
        formatItem: (d) => {
          const peers = (d.peers ?? [])
            .map((p) => `${p.deviceId ?? "?"}${p.role ? ` [${p.role}]` : ""}`)
            .join(", ");
          return lines(
            `- **${d.name ?? "unnamed"}**`,
            line("  id", `\`${d.id}\``),
            line("  peers", peers || undefined),
          );
        },
      }),
  );

  server.registerTool(
    "unifi_get_mclag_domain",
    {
      title: "Get MC-LAG Domain Details",
      description:
        "Get one MC-LAG domain by ID: peer switches (and their roles/link ports) and the LAGs shared across them. IDs come from unifi_list_mclag_domains.",
      inputSchema: {
        siteId: siteIdField,
        mcLagDomainId: uuidField("MC-LAG domain ID (UUID from unifi_list_mclag_domains)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, mcLagDomainId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const d = await client.get<McLagDomain>(`/v1/sites/${site}/switching/mc-lag-domains/${mcLagDomainId}`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(d));
        const peers = (d.peers ?? [])
          .map(
            (p) =>
              `  - ${p.deviceId ?? "?"}${p.role ? ` [${p.role}]` : ""}${p.linkPortIdxs?.length ? ` (link ports: ${p.linkPortIdxs.join(", ")})` : ""}`,
          )
          .join("\n");
        return textResult(
          lines(
            `## MC-LAG domain: ${d.name ?? d.id}`,
            line("ID", `\`${d.id}\``),
            line("LAGs", d.lags?.length ? String(d.lags.length) : undefined),
            peers ? `- **Peers**:\n${peers}` : undefined,
          ) + "\n\nUse responseFormat='json' for the complete configuration.",
        );
      }),
  );

  server.registerTool(
    "unifi_list_switch_stacks",
    {
      title: "List Switch Stacks",
      description:
        "List switch stacks on a site — multiple physical switches managed as one logical unit. Use unifi_get_switch_stack for one stack's members.",
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
      runListTool<SwitchStack>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/switching/switch-stacks`,
        heading: "Switch stacks",
        emptyMessage: "No switch stacks configured on this site.",
        formatItem: (s) =>
          lines(
            `- **${s.name ?? "unnamed"}** — ${s.members?.length ?? 0} member(s)`,
            line("  id", `\`${s.id}\``),
            line(
              "  members",
              s.members?.length ? s.members.map((m) => `\`${m.deviceId ?? "?"}\``).join(", ") : undefined,
            ),
          ),
      }),
  );

  server.registerTool(
    "unifi_get_switch_stack",
    {
      title: "Get Switch Stack Details",
      description:
        "Get one switch stack by ID: its member devices and any LAGs on the stack. IDs come from unifi_list_switch_stacks.",
      inputSchema: {
        siteId: siteIdField,
        switchStackId: uuidField("Switch stack ID (UUID from unifi_list_switch_stacks)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, switchStackId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const s = await client.get<SwitchStack>(`/v1/sites/${site}/switching/switch-stacks/${switchStackId}`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(s));
        const members = (s.members ?? []).map((m) => `  - \`${m.deviceId ?? "?"}\``).join("\n");
        return textResult(
          lines(
            `## Switch stack: ${s.name ?? s.id}`,
            line("ID", `\`${s.id}\``),
            line("LAGs", s.lags?.length ? String(s.lags.length) : undefined),
            members ? `- **Members**:\n${members}` : undefined,
          ) + "\n\nUse responseFormat='json' for the complete configuration.",
        );
      }),
  );
}
