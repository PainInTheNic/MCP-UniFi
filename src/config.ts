/**
 * Configuration for the UniFi MCP server.
 *
 * All settings come from environment variables so no secrets ever live in
 * code or in the Claude Code registration command history:
 *
 *   UNIFI_BASE_URL   (required) Console address, e.g. "https://192.168.1.1"
 *                    or "https://unifi.example.com". Just the origin — the
 *                    integration API path is appended automatically.
 *   UNIFI_API_KEY    (required) API key created in the UniFi console under
 *                    Settings > Control Plane > Integrations.
 *   UNIFI_TLS_VERIFY (optional) TLS certificate validation, default "true"
 *                    (secure by default). UniFi consoles ship with self-signed
 *                    certificates — if yours does, set this to "false"
 *                    explicitly, understanding that it allows on-path
 *                    interception of the API key.
 *   UNIFI_API_PATH   (optional) Override for the API path prefix. Defaults to
 *                    "/proxy/network/integration" (UniFi OS consoles: UDM,
 *                    UDR, Cloud Key, Cloud Gateway).
 */

export interface UniFiConfig {
  baseUrl: string;
  apiKey: string;
  tlsVerify: boolean;
  apiPath: string;
}

export function loadConfig(): UniFiConfig {
  const baseUrl = process.env.UNIFI_BASE_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.UNIFI_API_KEY?.trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("UNIFI_BASE_URL (e.g. https://192.168.1.1)");
  if (!apiKey) missing.push("UNIFI_API_KEY (create one in UniFi console: Settings > Control Plane > Integrations)");
  if (missing.length > 0) {
    // stderr only: stdout is reserved for the MCP JSON-RPC stream
    console.error(`unifi-mcp-server: missing required environment variables:\n  - ${missing.join("\n  - ")}`);
    process.exit(1);
  }

  if (!/^https?:\/\//i.test(baseUrl!)) {
    console.error(`unifi-mcp-server: UNIFI_BASE_URL must start with http:// or https:// (got "${baseUrl}")`);
    process.exit(1);
  }

  return {
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    tlsVerify: process.env.UNIFI_TLS_VERIFY?.trim().toLowerCase() !== "false",
    apiPath: process.env.UNIFI_API_PATH?.trim().replace(/\/+$/, "") || "/proxy/network/integration",
  };
}

/**
 * Strip any userinfo (user:pass@) from a URL before it is shown in logs or
 * error text, so embedded credentials never surface. UniFi uses header auth so
 * this is defensive, but cheap.
 */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//");
}
