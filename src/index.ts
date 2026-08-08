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
import { loadConfig } from "./config.js";
import { UniFiClient } from "./unifi-client.js";
import { registerSiteTools } from "./tools/sites.js";
import { registerDeviceTools } from "./tools/devices.js";
import { registerClientTools } from "./tools/clients.js";
import { registerNetworkTools } from "./tools/networks.js";
import { registerWifiTools } from "./tools/wifi.js";
import { registerFirewallTools } from "./tools/firewall.js";
import { registerVoucherTools } from "./tools/vouchers.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new UniFiClient(config);

  const server = new McpServer({
    name: "unifi-mcp-server",
    version: "1.0.0",
  });

  registerSiteTools(server, client);
  registerDeviceTools(server, client);
  registerClientTools(server, client);
  registerNetworkTools(server, client);
  registerWifiTools(server, client);
  registerFirewallTools(server, client);
  registerVoucherTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`unifi-mcp-server running (console: ${config.baseUrl}, TLS verify: ${config.tlsVerify})`);
  if (!config.tlsVerify) {
    console.error(
      "unifi-mcp-server WARNING: TLS certificate verification is DISABLED (UNIFI_TLS_VERIFY=false). " +
        "An on-path attacker could intercept the API key. Acceptable on a trusted LAN with a self-signed console cert; " +
        "install a proper certificate and remove the flag to close this gap.",
    );
  }
}

main().catch((error) => {
  console.error("unifi-mcp-server failed to start:", error);
  process.exit(1);
});
