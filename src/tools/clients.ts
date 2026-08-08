/**
 * Client tools: the devices *connected to* the network (laptops, phones,
 * cameras, IoT). Distinct from "devices", which are the UniFi hardware.
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

interface ClientSummary {
  id: string;
  name?: string;
  type?: string;
  ipAddress?: string;
  macAddress?: string;
  connectedAt?: string;
  uplinkDeviceId?: string;
  access?: { type?: string };
  [key: string]: unknown;
}

function clientBullet(c: ClientSummary): string {
  const kind = c.type ? ` (${c.type.toLowerCase()})` : "";
  return lines(
    `- **${c.name ?? c.macAddress ?? "unknown"}**${kind}`,
    line("  id", `\`${c.id}\``),
    line("  IP", c.ipAddress),
    line("  MAC", c.macAddress),
    line("  connected since", c.connectedAt),
  );
}

export function registerClientTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_clients",
    {
      title: "List Connected Clients",
      description:
        "List clients currently connected to the network (laptops, phones, IoT, etc.) with name, IP, MAC, connection type (WIRED/WIRELESS/VPN/TELEPORT), and connect time. Note: this shows CURRENTLY CONNECTED clients only. Filter examples: \"type.eq('WIRELESS')\", \"access.type.eq('GUEST')\", \"ipAddress.eq('192.168.1.50')\".",
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
      runListTool<ClientSummary>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/clients`,
        heading: "Connected clients",
        emptyMessage: "No clients are currently connected.",
        formatItem: clientBullet,
      }),
  );

  server.registerTool(
    "unifi_get_client",
    {
      title: "Get Connected Client Details",
      description:
        "Get full details for one currently connected client by ID (IDs come from unifi_list_clients): connection type, IP/MAC, access type (default/guest), uplink device, and connection time.",
      inputSchema: {
        siteId: siteIdField,
        clientId: uuidField("Client ID (UUID from unifi_list_clients)"),
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, clientId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const c = await client.get<ClientSummary>(`/v1/sites/${site}/clients/${clientId}`);
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(c));
        return textResult(
          lines(
            `## ${c.name ?? c.macAddress ?? "Client"}`,
            line("ID", `\`${c.id}\``),
            line("Type", c.type),
            line("IP", c.ipAddress),
            line("MAC", c.macAddress),
            line("Access", c.access?.type),
            line("Connected since", c.connectedAt),
            line("Uplink device ID", c.uplinkDeviceId ? `\`${c.uplinkDeviceId}\`` : undefined),
          ),
        );
      }),
  );

  server.registerTool(
    "unifi_authorize_guest_access",
    {
      title: "Authorize Guest Access",
      description:
        "Authorize a client for guest network access (hotspot/captive-portal networks), optionally with time, data, or bandwidth limits. Only meaningful for clients on a guest network. NOTE: re-authorizing an already-authorized guest cancels the existing authorization, restarts the expiry clock, and resets traffic counters — do not retry this call casually.",
      inputSchema: {
        siteId: siteIdField,
        clientId: uuidField("Client ID (UUID from unifi_list_clients)"),
        timeLimitMinutes: z.number().int().min(1).optional().describe("Minutes until access expires (omit for no time limit)"),
        dataUsageLimitMBytes: z.number().int().min(1).optional().describe("Data cap in megabytes (omit for unlimited)"),
        rxRateLimitKbps: z.number().int().min(2).optional().describe("Download rate limit in Kbps (omit for unlimited)"),
        txRateLimitKbps: z.number().int().min(2).optional().describe("Upload rate limit in Kbps (omit for unlimited)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, clientId, timeLimitMinutes, dataUsageLimitMBytes, rxRateLimitKbps, txRateLimitKbps }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const result = await client.post<{ grantedAuthorization?: { expiresAt?: string } }>(
          `/v1/sites/${site}/clients/${clientId}/actions`,
          {
            action: "AUTHORIZE_GUEST_ACCESS",
            ...(timeLimitMinutes !== undefined && { timeLimitMinutes }),
            ...(dataUsageLimitMBytes !== undefined && { dataUsageLimitMBytes }),
            ...(rxRateLimitKbps !== undefined && { rxRateLimitKbps }),
            ...(txRateLimitKbps !== undefined && { txRateLimitKbps }),
          },
        );
        const expires = result.grantedAuthorization?.expiresAt;
        return textResult(`Guest access authorized for client ${clientId}.${expires ? ` Expires at ${expires}.` : ""}`);
      }),
  );

  server.registerTool(
    "unifi_unauthorize_guest_access",
    {
      title: "Revoke Guest Access",
      description:
        "Revoke (unauthorize) a guest client's network access. The client is kicked back to the captive portal. Only meaningful for clients on a guest network. Confirm with the user before revoking someone's access.",
      inputSchema: {
        siteId: siteIdField,
        clientId: uuidField("Client ID (UUID from unifi_list_clients)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, clientId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        await client.post(`/v1/sites/${site}/clients/${clientId}/actions`, { action: "UNAUTHORIZE_GUEST_ACCESS" });
        return textResult(`Guest access revoked for client ${clientId}.`);
      }),
  );
}
