/**
 * Discovery tools: application info and site listing. These are the natural
 * "start here" calls — every other tool is scoped to a site.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, jsonBlock, jsonResult, lines, line, paginationFooter, textResult } from "../format.js";
import { guard, limitField, offsetField, responseFormatField, siteIdField } from "./shared.js";

interface Site {
  id: string;
  internalReference?: string;
  name?: string;
}

interface ApplicationInfo {
  applicationVersion?: string;
  [key: string]: unknown;
}

/** Subset of the legacy stat/sysinfo record this server reads. */
interface SysInfo {
  name?: string;
  hostname?: string;
  ubnt_device_type?: string;
  console_display_version?: string;
  version?: string;
  previous_version?: string;
  update_available?: boolean;
  update_downloaded?: boolean;
  timezone?: string;
  [key: string]: unknown;
}

const yesNo = (value: boolean | undefined) => (value === undefined ? undefined : value ? "yes" : "no");

export function registerSiteTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_get_application_info",
    {
      title: "Get UniFi Application Info",
      description:
        "Get the UniFi Network application version running on the console. Useful as a connectivity check — if this fails, the base URL or API key is misconfigured.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const info = await client.get<ApplicationInfo>("/v1/info");
        return textResult(
          lines(
            "## UniFi Network application",
            line("Version", info.applicationVersion),
          ) + `\n\nConnectivity to the console is working.`,
        );
      }),
  );

  server.registerTool(
    "unifi_get_system_info",
    {
      title: "Get UniFi System Info",
      description:
        "Get console system info: UniFi Network application version, whether a Network application update is available or already downloaded, the previous Network version, and the console model and UniFi OS version. Use this to answer 'are there app updates?' (for device firmware updates use unifi_get_device). Reads the console's legacy, undocumented Network API, so it may break on future Network versions. It cannot report UniFi OS or other app (Protect, Access...) update availability — that endpoint needs an admin login session, not an API key.",
      inputSchema: {
        siteId: siteIdField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, responseFormat }) =>
      guard(async () => {
        const site = await client.resolveSiteReference(siteId);
        const [info] = await client.getLegacy<SysInfo>(`/s/${site}/stat/sysinfo`);
        if (!info) return textResult("The console returned no system info.");
        if (responseFormat === ResponseFormat.JSON) return jsonResult("", info);
        return textResult(
          lines(
            `## ${info.name ?? info.hostname ?? "UniFi console"}`,
            line("Model", info.ubnt_device_type),
            line("UniFi OS version", info.console_display_version),
            line("Network application version", info.version),
            line("Network update available", yesNo(info.update_available)),
            line("Network update downloaded", yesNo(info.update_downloaded)),
            line("Previous Network version", info.previous_version),
            line("Timezone", info.timezone),
          ) +
            "\n\nUniFi OS and other app (Protect, Access...) update availability is not readable with an API key — check Settings > Control Plane > Updates in the console.",
        );
      }),
  );

  server.registerTool(
    "unifi_list_sites",
    {
      title: "List UniFi Sites",
      description:
        "List the sites managed by this UniFi console. Returns each site's name and ID. Most consoles have exactly one site; its ID is what other tools accept as 'siteId' (they auto-detect it when there is only one site).",
      inputSchema: {
        limit: limitField,
        offset: offsetField,
        responseFormat: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, responseFormat }) =>
      guard(async () => {
        const page = await client.page<Site>("/v1/sites", { limit, offset });
        if (page.data.length === 0) return textResult("No sites found on this console.");
        if (responseFormat === ResponseFormat.JSON) return textResult(jsonBlock(page));
        const body = page.data
          .map((s) => `- **${s.name ?? s.internalReference ?? "unnamed"}** — id: \`${s.id}\``)
          .join("\n");
        return textResult(`## Sites\n\n${body}\n${paginationFooter(page)}`);
      }),
  );
}
