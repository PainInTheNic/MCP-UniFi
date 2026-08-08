#!/usr/bin/env node
/**
 * unifi-mcp-server — MCP server for managing Ubiquiti UniFi infrastructure
 * through the official UniFi Network API (Integration API).
 *
 * Runs locally over stdio: the MCP client (e.g. Claude Code) launches this
 * process, sends JSON-RPC on stdin, and reads responses from stdout. All
 * logging must therefore go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, redactUrl } from "./config.js";
import { UniFiClient } from "./unifi-client.js";
import { registerSiteTools } from "./tools/sites.js";
import { registerDeviceTools } from "./tools/devices.js";
import { registerClientTools } from "./tools/clients.js";
import { registerNetworkTools } from "./tools/networks.js";
import { registerWifiTools } from "./tools/wifi.js";
import { registerFirewallTools } from "./tools/firewall.js";
import { registerVoucherTools } from "./tools/vouchers.js";
import { registerSwitchingTools } from "./tools/switching.js";
import { registerSupportingResourceTools } from "./tools/supporting.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new UniFiClient(config);

  const server = new McpServer(
    {
      name: "unifi-mcp-server",
      title: "UniFi Network",
      version: "1.0.0",
    },
    {
      instructions:
        "Tools for managing a Ubiquiti UniFi network via the official Integration API. " +
        "Start with unifi_list_sites to discover the site ID other tools accept (it is auto-detected when the console has one site). " +
        "List tools support UniFi filter expressions like \"state.eq('OFFLINE')\" and 'responseFormat: json' for raw data. " +
        "Tools annotated destructive (restart, unadopt, power-cycle, revoke access, delete) change live infrastructure — confirm with the user first.",
    },
  );

  registerSiteTools(server, client);
  registerDeviceTools(server, client);
  registerClientTools(server, client);
  registerNetworkTools(server, client);
  registerWifiTools(server, client);
  registerFirewallTools(server, client);
  registerVoucherTools(server, client);
  registerSwitchingTools(server, client);
  registerSupportingResourceTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: close the transport so in-flight work settles, then exit.
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(`unifi-mcp-server running (console: ${redactUrl(config.baseUrl)}, TLS verify: ${config.tlsVerify})`);
  if (!config.tlsVerify) {
    console.error(
      "unifi-mcp-server WARNING: TLS certificate verification is DISABLED (UNIFI_TLS_VERIFY=false). " +
        "An on-path attacker could intercept the API key. Acceptable on a trusted LAN with a self-signed console cert; " +
        "install a proper certificate and remove the flag to close this gap.",
    );
  }
  if (/^http:\/\//i.test(config.baseUrl)) {
    console.error(
      "unifi-mcp-server WARNING: UNIFI_BASE_URL uses http:// — the API key is sent in cleartext and can be read by anyone " +
        "on the network path. UniFi consoles serve HTTPS by default; use an https:// URL (with UNIFI_TLS_VERIFY=false if the " +
        "cert is self-signed) instead.",
    );
  }
}

main().catch((error) => {
  console.error("unifi-mcp-server failed to start:", error);
  process.exit(1);
});
