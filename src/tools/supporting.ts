/**
 * Supporting/reference-data tools: lookup tables the rest of the API refers
 * to by ID (DPI application and category IDs used in traffic rules, country
 * codes for radio settings, RADIUS profiles for enterprise WiFi, device tags
 * for organization). Mostly useful for resolving IDs seen elsewhere into
 * human-readable names.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UniFiClient } from "../unifi-client.js";
import { line, lines } from "../format.js";
import {
  filterField,
  limitField,
  offsetField,
  responseFormatField,
  runListTool,
  siteIdField,
} from "./shared.js";

interface Country {
  code?: string;
  name?: string;
}

interface DpiApplication {
  id?: number;
  name?: string;
}

interface DpiCategory {
  id?: number;
  name?: string;
}

interface DeviceTag {
  id: string;
  name?: string;
  deviceIds?: string[];
  [key: string]: unknown;
}

interface RadiusProfile {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export function registerSupportingResourceTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_countries",
    {
      title: "List Countries",
      description:
        "List ISO country codes and names known to the console (console-wide, not site-scoped). These codes appear in radio/regulatory settings — useful for resolving a country code to its name.",
      inputSchema: {
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ filter, limit, offset, responseFormat }) =>
      runListTool<Country>({
        client,
        consoleWide: true,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: () => `/v1/countries`,
        heading: "Countries",
        emptyMessage: "No countries returned by the console.",
        formatItem: (c) => `- **${c.name ?? "?"}** (\`${c.code ?? "?"}\`)`,
      }),
  );

  server.registerTool(
    "unifi_list_dpi_applications",
    {
      title: "List DPI Applications",
      description:
        "List the Deep Packet Inspection (DPI) application catalog (console-wide, not site-scoped). Each entry's numeric ID is what traffic-identification and QoS rules reference. Use a filter like \"name.like('*Netflix*')\" to find one.",
      inputSchema: {
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ filter, limit, offset, responseFormat }) =>
      runListTool<DpiApplication>({
        client,
        consoleWide: true,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: () => `/v1/dpi/applications`,
        heading: "DPI applications",
        emptyMessage: "No DPI applications returned by the console.",
        formatItem: (a) => `- **${a.name ?? "?"}** (id: ${a.id ?? "?"})`,
      }),
  );

  server.registerTool(
    "unifi_list_dpi_categories",
    {
      title: "List DPI Application Categories",
      description:
        "List Deep Packet Inspection (DPI) application categories — the groupings that DPI applications belong to (console-wide, not site-scoped).",
      inputSchema: {
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ filter, limit, offset, responseFormat }) =>
      runListTool<DpiCategory>({
        client,
        consoleWide: true,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: () => `/v1/dpi/categories`,
        heading: "DPI application categories",
        emptyMessage: "No DPI categories returned by the console.",
        formatItem: (c) => `- **${c.name ?? "?"}** (id: ${c.id ?? "?"})`,
      }),
  );

  server.registerTool(
    "unifi_list_device_tags",
    {
      title: "List Device Tags",
      description:
        "List user-defined device tags (labels/groups) on a site and which devices carry each tag. Device IDs correspond to unifi_list_devices.",
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
      runListTool<DeviceTag>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/device-tags`,
        heading: "Device tags",
        emptyMessage: "No device tags configured on this site.",
        formatItem: (t) => {
          const ids = t.deviceIds ?? [];
          const idList = ids.length > 0 && ids.length <= 10 ? `\n  ${ids.map((i) => `\`${i}\``).join(", ")}` : "";
          return (
            lines(
              `- **${t.name ?? "unnamed"}** — ${ids.length} device(s)`,
              line("  id", `\`${t.id}\``),
            ) + idList
          );
        },
      }),
  );

  server.registerTool(
    "unifi_list_radius_profiles",
    {
      title: "List RADIUS Profiles",
      description:
        "List RADIUS server profiles on a site — used by enterprise/802.1X WiFi authentication (referenced from WiFi broadcast security settings). List only; the API has no single-item GET for RADIUS profiles.",
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
      runListTool<RadiusProfile>({
        client,
        siteId,
        limit,
        offset,
        format: responseFormat,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/radius/profiles`,
        heading: "RADIUS profiles",
        emptyMessage: "No RADIUS profiles configured on this site.",
        formatItem: (r) => lines(`- **${r.name ?? "unnamed"}**`, line("  id", `\`${r.id}\``)),
      }),
  );
}
