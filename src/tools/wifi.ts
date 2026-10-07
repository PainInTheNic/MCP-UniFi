/**
 * WiFi tools: the broadcast SSIDs ("WiFi Broadcasts" in UniFi terms).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, jsonBlock, line, lines, textResult } from "../format.js";
import {
  configField,
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
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, limit, offset, responseFormat }) =>
      runListTool<WifiBroadcast>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
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
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, wifiId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        const w = await client.get<WifiBroadcast>(`/v1/sites/${site}/wifi/broadcasts/${wifiId}`);
        // Passphrases are blanked centrally by jsonBlock/jsonResult; the
        // markdown branch below never reads a credential field.
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(w));
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
          ) + "\n\nUse responseFormat='json' for the complete configuration.",
        );
      }),
  );

  server.registerTool(
    "unifi_create_wifi",
    {
      title: "Create WiFi Network (SSID)",
      description:
        "Create a new WiFi network (SSID / broadcast). 'config' is the full broadcast object. Because the required fields vary by type (a STANDARD SSID additionally needs advertiseDeviceName, arpProxyEnabled, broadcastingFrequenciesGHz, and bssTransitionEnabled on top of the base name, enabled, type, securityConfiguration, network, hideName, clientIsolationEnabled, uapsdEnabled, channel2gLockedTo6, dtimPeriod2gLockedTo3, multicastToUnicastConversionEnabled), the reliable path is to fetch an existing SSID with unifi_get_wifi (responseFormat='json'), copy its shape, and change name/network. Reads show the passphrase as '[redacted]' and a config still containing that placeholder is refused, so set a real passphrase in securityConfiguration (ask the user). Returns the created SSID.",
      inputSchema: {
        siteId: siteIdField,
        config: configField(
          "Full WiFi broadcast object. Required: name, enabled, type, securityConfiguration, network, and the radio booleans. See unifi_get_wifi (json) for the shape.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, config }) =>
      runCreate<WifiBroadcast>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/wifi/broadcasts`,
        body: config,
        label: "WiFi network",
      }),
  );

  server.registerTool(
    "unifi_update_wifi",
    {
      title: "Update WiFi Network (SSID)",
      description:
        "Replace the configuration of an existing WiFi SSID (full PUT). Fetch the current object with unifi_get_wifi (responseFormat='json'), modify it, and pass the whole object as 'config'. NOTE: reads show the passphrase as '[redacted]', and a config still containing that placeholder is refused before anything is sent (it would otherwise become the literal new passphrase) — put the real passphrase back in securityConfiguration (ask the user for it). CAUTION: reconfiguring an SSID disconnects its connected clients — confirm with the user. IDs come from unifi_list_wifi.",
      inputSchema: {
        siteId: siteIdField,
        wifiId: uuidField("WiFi broadcast ID (UUID from unifi_list_wifi)"),
        config: configField("Full WiFi broadcast object to write (fetch current via unifi_get_wifi, then modify)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, wifiId, config }) =>
      runUpdate<WifiBroadcast>({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/wifi/broadcasts/${wifiId}`,
        body: config,
        label: `WiFi network ${wifiId}`,
      }),
  );

  server.registerTool(
    "unifi_delete_wifi",
    {
      title: "Delete WiFi Network (SSID)",
      description:
        "Delete a WiFi SSID. CAUTION: irreversible — connected clients lose this network. Confirm with the user. Set force=true to delete even if other resources reference it. IDs come from unifi_list_wifi.",
      inputSchema: {
        siteId: siteIdField,
        wifiId: uuidField("WiFi broadcast ID (UUID from unifi_list_wifi)"),
        force: z
          .boolean()
          .default(false)
          .describe("Delete even if other resources still reference this SSID (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, wifiId, force }) =>
      runDelete({
        client,
        siteId,
        path: (s) => `/v1/sites/${s}/wifi/broadcasts/${wifiId}`,
        label: `WiFi network ${wifiId}`,
        params: { force },
      }),
  );
}
