/**
 * Network-topology tools: LAN networks/VLANs, WAN interfaces, and VPN.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, jsonBlock, line, lines, textResult } from "../format.js";
import {
  guard,
  limitField,
  offsetField,
  responseFormatField,
  runListTool,
  siteIdField,
  uuidField,
} from "./shared.js";

interface Network {
  id: string;
  name?: string;
  enabled?: boolean;
  default?: boolean;
  vlanId?: number;
  management?: string;
  // Detail endpoint only (gateway-managed networks); the list has no IP data.
  ipv4Configuration?: {
    hostIpAddress?: string;
    prefixLength?: number;
    dhcpConfiguration?: {
      mode?: string; // SERVER | RELAY
      ipAddressRange?: { start?: string; stop?: string };
      leaseTimeSeconds?: number;
    };
  };
  [key: string]: unknown;
}

/** WAN overview objects carry only id and name. */
interface WanInterface {
  id: string;
  name?: string;
  [key: string]: unknown;
}

interface VpnServer {
  id: string;
  name?: string;
  enabled?: boolean;
  type?: string;
  [key: string]: unknown;
}

export function registerNetworkTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_networks",
    {
      title: "List Networks (LANs/VLANs)",
      description:
        "List the configured LAN networks/VLANs on a site with name, VLAN ID, management type, and enabled state. Use unifi_get_network for one network's full configuration including subnet and DHCP.",
      inputSchema: {
        siteId: siteIdField,
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, response_format }) =>
      runListTool<Network>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        path: (site) => `/v1/sites/${site}/networks`,
        heading: "Networks (LANs/VLANs)",
        emptyMessage: "No networks configured on this site.",
        formatItem: (n) =>
          lines(
            `- **${n.name ?? "unnamed"}**${n.default ? " [default]" : ""}${n.enabled === false ? " (disabled)" : ""}`,
            line("  id", `\`${n.id}\``),
            line("  VLAN", n.vlanId),
            line("  management", n.management),
          ),
      }),
  );

  server.registerTool(
    "unifi_get_network",
    {
      title: "Get Network Details",
      description:
        "Get the full configuration of one LAN network/VLAN by ID: subnet, gateway, DHCP range and state, VLAN ID. IDs come from unifi_list_networks.",
      inputSchema: {
        siteId: siteIdField,
        networkId: uuidField("Network ID (UUID from unifi_list_networks)"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, networkId, response_format }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const n = await client.get<Network>(`/v1/sites/${site}/networks/${networkId}`);
        if (response_format === ResponseFormat.JSON) return textResult(jsonBlock(n));
        const ip = n.ipv4Configuration;
        const dhcp = ip?.dhcpConfiguration;
        return textResult(
          lines(
            `## ${n.name ?? "Network"}${n.default ? " [default]" : ""}${n.enabled === false ? " (disabled)" : ""}`,
            line("ID", `\`${n.id}\``),
            line("VLAN ID", n.vlanId),
            line("Management", n.management),
            line(
              "Gateway IP / subnet",
              ip?.hostIpAddress ? `${ip.hostIpAddress}${ip.prefixLength !== undefined ? `/${ip.prefixLength}` : ""}` : undefined,
            ),
            line(
              "DHCP",
              dhcp?.mode === undefined
                ? undefined
                : dhcp.mode === "SERVER"
                  ? `server (${dhcp.ipAddressRange?.start ?? "?"} - ${dhcp.ipAddressRange?.stop ?? "?"}${dhcp.leaseTimeSeconds ? `, lease ${dhcp.leaseTimeSeconds}s` : ""})`
                  : dhcp.mode.toLowerCase(),
            ),
          ) + "\n\nUse response_format='json' for the complete configuration.",
        );
      }),
  );

  server.registerTool(
    "unifi_list_wans",
    {
      title: "List WAN Interfaces",
      description: "List the WAN (internet uplink) interfaces configured on a site (ID and name).",
      inputSchema: {
        siteId: siteIdField,
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, response_format }) =>
      runListTool<WanInterface>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        path: (site) => `/v1/sites/${site}/wans`,
        heading: "WAN interfaces",
        emptyMessage: "No WAN interfaces found on this site.",
        formatItem: (w) =>
          lines(
            `- **${w.name ?? "WAN"}**`,
            line("  id", `\`${w.id}\``),
          ),
      }),
  );

  server.registerTool(
    "unifi_list_vpn",
    {
      title: "List VPN Servers and Tunnels",
      description:
        "List VPN configuration on a site: 'servers' lists VPN servers (e.g. WireGuard/L2TP for remote access), 'site_to_site' lists site-to-site VPN tunnels.",
      inputSchema: {
        siteId: siteIdField,
        kind: z
          .enum(["servers", "site_to_site"])
          .default("servers")
          .describe("Which VPN objects to list: 'servers' (remote-access VPN) or 'site_to_site' (tunnels between sites)"),
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, kind, limit, offset, response_format }) =>
      runListTool<VpnServer>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        path: (site) =>
          kind === "servers" ? `/v1/sites/${site}/vpn/servers` : `/v1/sites/${site}/vpn/site-to-site-tunnels`,
        heading: kind === "servers" ? "VPN servers" : "Site-to-site VPN tunnels",
        emptyMessage: `No ${kind === "servers" ? "VPN servers" : "site-to-site VPN tunnels"} configured on this site.`,
        formatItem: (v) =>
          lines(
            `- **${v.name ?? "VPN"}**${v.enabled === false ? " (disabled)" : ""}`,
            line("  id", `\`${v.id}\``),
            line("  type", v.type),
          ),
      }),
  );
}
