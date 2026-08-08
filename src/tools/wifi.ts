/**
 * WiFi tools: the broadcast SSIDs ("WiFi Broadcasts" in UniFi terms).
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

/** In UniFi terms `name` IS the SSID; security lives under securityConfiguration. */
interface WifiBroadcast {
  id: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  hideName?: boolean; // detail endpoint only
  securityConfiguration?: { type?: string };
  /** LAN association: NATIVE (untagged) or SPECIFIC with a networkId. */
  network?: { type?: string; networkId?: string };
  [key: string]: unknown;
}

export function registerWifiTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_wifi",
    {
      title: "List WiFi Networks (SSIDs)",
      description:
        "List the WiFi networks (broadcast SSIDs) configured on a site, with enabled state and security type. Passwords are never included. Use unifi_get_wifi for one SSID's full settings.",
      inputSchema: {
        siteId: siteIdField,
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, response_format }) =>
      runListTool<WifiBroadcast>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        path: (site) => `/v1/sites/${site}/wifi/broadcasts`,
        heading: "WiFi networks (SSIDs)",
        emptyMessage: "No WiFi networks configured on this site.",
        formatItem: (w) =>
          lines(
            `- **${w.name ?? "unnamed"}**${w.enabled === false ? " (disabled)" : ""}`,
            line("  id", `\`${w.id}\``),
            line("  security", w.securityConfiguration?.type),
          ),
      }),
  );

  server.registerTool(
    "unifi_get_wifi",
    {
      title: "Get WiFi Network Details",
      description:
        "Get the full configuration of one WiFi network (SSID) by ID: security settings, associated LAN network, band/AP settings. IDs come from unifi_list_wifi. Passphrases are redacted.",
      inputSchema: {
        siteId: siteIdField,
        wifiId: uuidField("WiFi broadcast ID (UUID from unifi_list_wifi)"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, wifiId, response_format }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const w = await client.get<WifiBroadcast>(`/v1/sites/${site}/wifi/broadcasts/${wifiId}`);
        // Never surface WiFi passphrases into the conversation, in either format.
        redactSecrets(w);
        if (response_format === ResponseFormat.JSON) return textResult(jsonBlock(w));
        return textResult(
          lines(
            `## ${w.name ?? "WiFi network"}${w.enabled === false ? " (disabled)" : ""}${w.hideName ? " [hidden SSID]" : ""}`,
            line("ID", `\`${w.id}\``),
            line("Type", w.type),
            line("Security", w.securityConfiguration?.type),
            line(
              "LAN network",
              w.network?.type === "SPECIFIC" && w.network.networkId
                ? `\`${w.network.networkId}\` (see unifi_get_network)`
                : w.network?.type,
            ),
          ) + "\n\nUse response_format='json' for the complete configuration.",
        );
      }),
  );
}

/** Recursively blank out any key that looks like a credential. */
function redactSecrets(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (/passphrase|password|psk|secret/i.test(key) && typeof value === "string") {
      (obj as Record<string, unknown>)[key] = "[redacted]";
    } else {
      redactSecrets(value);
    }
  }
}
