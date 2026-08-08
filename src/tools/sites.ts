/**
 * Discovery tools: application info and site listing. These are the natural
 * "start here" calls — every other tool is scoped to a site.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, jsonBlock, lines, line, paginationFooter, textResult } from "../format.js";
import { guard, limitField, offsetField, responseFormatField } from "./shared.js";

interface Site {
  id: string;
  internalReference?: string;
  name?: string;
}

interface ApplicationInfo {
  applicationVersion?: string;
  [key: string]: unknown;
}

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
    "unifi_list_sites",
    {
      title: "List UniFi Sites",
      description:
        "List the sites managed by this UniFi console. Returns each site's name and ID. Most consoles have exactly one site; its ID is what other tools accept as 'siteId' (they auto-detect it when there is only one site).",
      inputSchema: {
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, response_format }) =>
      guard(async () => {
        const page = await client.page<Site>("/v1/sites", { limit, offset });
        if (page.data.length === 0) return textResult("No sites found on this console.");
        if (response_format === ResponseFormat.JSON) return textResult(jsonBlock(page));
        const body = page.data
          .map((s) => `- **${s.name ?? s.internalReference ?? "unnamed"}** — id: \`${s.id}\``)
          .join("\n");
        return textResult(`## Sites\n\n${body}\n${paginationFooter(page)}`);
      }),
  );
}
