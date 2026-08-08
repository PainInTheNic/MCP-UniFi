/**
 * Network-topology tools: LAN networks/VLANs, WAN interfaces, and VPN.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, jsonBlock, line, lines, textResult } from "../format.js";
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

interface NetworkReferences {
  referenceResources?: Array<{
    resourceType?: string;
    referenceCount?: number;
    references?: Array<{ referenceId?: string }>;
  }>;
}

export function registerNetworkTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_networks",
    {
      title: "List Networks (LANs/VLANs)",
      description:
        "List the configured LAN networks/VLANs on a site with name, VLAN ID, management type, and enabled state. Use unifi_get_network for one network's full configuration including subnet and DHCP. Filter example: \"vlanId.eq(20)\".",
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
      runListTool<Network>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
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
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, networkId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const n = await client.get<Network>(`/v1/sites/${site}/networks/${networkId}`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(n));
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
          ) + "\n\nUse responseFormat='json' for the complete configuration.",
        );
      }),
  );

  server.registerTool(
    "unifi_get_network_references",
    {
      title: "Get Network References",
      description:
        "List what depends on a LAN network/VLAN — clients, devices, WiFi SSIDs, static/OSPF routes, NAT rules, SD-WAN. Check this BEFORE deleting or heavily reconfiguring a network to see what would break. IDs come from unifi_list_networks.",
      inputSchema: {
        siteId: siteIdField,
        networkId: uuidField("Network ID (UUID from unifi_list_networks)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, networkId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const refs = await client.get<NetworkReferences>(`/v1/sites/${site}/networks/${networkId}/references`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(refs));
        const used = (refs.referenceResources ?? []).filter((r) => (r.referenceCount ?? 0) > 0);
        if (used.length === 0) {
          return textResult("No other resources reference this network — safe to delete without breaking dependents.");
        }
        const body = used
          .map((r) => {
            const ids = (r.references ?? []).map((x) => x.referenceId).filter((x): x is string => !!x);
            const idList = ids.length > 0 && ids.length <= 10 ? `\n  ${ids.map((i) => `\`${i}\``).join(", ")}` : "";
            return `- **${r.resourceType ?? "?"}**: ${r.referenceCount} reference(s)${idList}`;
          })
          .join("\n");
        return textResult(`## Resources referencing this network\n\n${body}`);
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
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, responseFormat }) =>
      runListTool<WanInterface>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
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
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, kind, limit, offset, responseFormat }) =>
      runListTool<VpnServer>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
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

  server.registerTool(
    "unifi_create_network",
    {
      title: "Create Network (LAN/VLAN)",
      description:
        "Create a new LAN network / VLAN on a site. 'config' is the full network object; required for all: name (string), vlanId (integer), management (string), enabled (boolean). For GATEWAY/SWITCH-managed networks (management != \"UNMANAGED\"), ipv4Configuration (subnet + DHCP) is ALSO required — plus, for GATEWAY, isolationEnabled, internetAccessEnabled, and cellularBackupEnabled. Easiest: model it on an existing network fetched via unifi_get_network with responseFormat='json', changing name/vlanId/subnet. Returns the created network.",
      inputSchema: {
        siteId: siteIdField,
        config: configField(
          "Full network object. Required: name, vlanId, management, enabled (+ ipv4Configuration and, for GATEWAY, isolationEnabled/internetAccessEnabled/cellularBackupEnabled). See unifi_get_network (json) for the full shape.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, config }) =>
      runCreate<Network>({ client, siteId, path: (s) => `/v1/sites/${s}/networks`, body: config, label: "network" }),
  );

  server.registerTool(
    "unifi_update_network",
    {
      title: "Update Network (LAN/VLAN)",
      description:
        "Replace the configuration of an existing LAN network / VLAN (full PUT). Fetch the current object with unifi_get_network (responseFormat='json'), change what you need, and pass the whole object as 'config'. CAUTION: changing subnet/VLAN/DHCP can disconnect every client on this network — confirm with the user first. IDs come from unifi_list_networks.",
      inputSchema: {
        siteId: siteIdField,
        networkId: uuidField("Network ID (UUID from unifi_list_networks)"),
        config: configField("Full network object to write (fetch current via unifi_get_network, then modify)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, networkId, config }) =>
      runUpdate<Network>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/networks/${networkId}`,
        body: config,
        label: `network ${networkId}`,
      }),
  );

  server.registerTool(
    "unifi_delete_network",
    {
      title: "Delete Network (LAN/VLAN)",
      description:
        "Delete a LAN network / VLAN. CAUTION: irreversible — clients on it lose their network and dependent WiFi/firewall/routes may break. Check unifi_get_network_references first and confirm with the user. Set force=true to delete even while other resources still reference it. IDs come from unifi_list_networks.",
      inputSchema: {
        siteId: siteIdField,
        networkId: uuidField("Network ID (UUID from unifi_list_networks)"),
        force: z
          .boolean()
          .default(false)
          .describe("Delete even if other resources still reference this network (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, networkId, force }) =>
      runDelete({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/networks/${networkId}`,
        label: `network ${networkId}`,
        params: { force },
      }),
  );
}
