/**
 * The "[redacted]" write-back guard: create/update bodies that still carry the
 * placeholder reads put in place of credentials must be refused before any
 * request is made. Offline: fake clients and a stubbed axios adapter only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { REDACTED, findRedactedPlaceholders, jsonResult } from "../src/format.js";
import { UniFiApiError, UniFiClient, assertNoRedactedPlaceholder } from "../src/unifi-client.js";
import { runCreate, runUpdate } from "../src/tools/shared.js";
import { registerFirewallTools } from "../src/tools/firewall.js";
import { registerVoucherTools } from "../src/tools/vouchers.js";

const WIFI_ID = "22222222-2222-2222-2222-222222222222";

/** A WiFi object as a fetch-modify-PUT flow would hand it back after a redacted read. */
function readBackWifi(): Record<string, unknown> {
  const fromApi = {
    id: WIFI_ID,
    name: "Home",
    enabled: true,
    securityConfiguration: { type: "WPA2_PERSONAL", passphrase: "correct horse" },
  };
  // What the model actually sees: the structuredContent of a JSON-mode read.
  return structuredClone(jsonResult("", fromApi).structuredContent!) as Record<string, unknown>;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

/** A stand-in UniFiClient that records every call; none should happen on a refusal. */
function recordingClient() {
  const calls: string[] = [];
  const client = {
    resolveSiteId: async () => {
      calls.push("resolveSiteId");
      return "11111111-1111-1111-1111-111111111111";
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      return { id: "new" };
    },
    put: async (path: string) => {
      calls.push(`PUT ${path}`);
      return { id: WIFI_ID };
    },
  } as unknown as UniFiClient;
  return { client, calls };
}

test("findRedactedPlaceholders reports the path of every placeholder, deep", () => {
  const body = {
    name: "ok",
    securityConfiguration: { passphrase: REDACTED },
    radius: { servers: [{ host: "10.0.0.5" }, { host: "10.0.0.6", secret: REDACTED }] },
    entries: [REDACTED, "fine"],
    note: `prefix ${REDACTED} suffix`,
  };
  assert.deepEqual(findRedactedPlaceholders(body), [
    "securityConfiguration.passphrase",
    "radius.servers[1].secret",
    "entries[0]",
    "note",
  ]);
});

test("findRedactedPlaceholders ignores clean bodies and non-string values", () => {
  assert.deepEqual(
    findRedactedPlaceholders({ name: "redacted", n: 1, b: true, x: null, list: [1, "a"], nested: {} }),
    [],
  );
  assert.deepEqual(findRedactedPlaceholders(undefined), []);
  assert.deepEqual(findRedactedPlaceholders(REDACTED), ["(the whole body)"]);
});

test("a redacted read fed straight back is caught at the passphrase", () => {
  assert.deepEqual(findRedactedPlaceholders(readBackWifi()), ["securityConfiguration.passphrase"]);
});

test("assertNoRedactedPlaceholder throws a UniFiApiError naming the field and the fix", () => {
  assert.throws(
    () => assertNoRedactedPlaceholder(readBackWifi()),
    (error: unknown) => {
      assert.ok(error instanceof UniFiApiError);
      assert.match(error.message, /securityConfiguration\.passphrase/);
      assert.match(error.message, /\[redacted\]/);
      assert.match(error.message, /real value/);
      assert.match(error.message, /leave the field out/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertNoRedactedPlaceholder({ securityConfiguration: { passphrase: "correct horse" } }));
});

test("the refusal does not claim a non-credential field is a credential", () => {
  assert.throws(
    () => assertNoRedactedPlaceholder({ name: `promo ${REDACTED}` }),
    (error: unknown) => {
      assert.ok(error instanceof UniFiApiError);
      assert.match(error.message, /at name\./);
      assert.doesNotMatch(error.message, /that credential/);
      assert.match(error.message, /if it is a credential/);
      return true;
    },
  );
});

test("assertNoRedactedPlaceholder caps a long list of paths", () => {
  const body = { entries: Array.from({ length: 15 }, () => REDACTED) };
  assert.throws(() => assertNoRedactedPlaceholder(body), /entries\[9\], and 5 more/);
});

test("runUpdate refuses a placeholder before resolving the site or sending the PUT", async () => {
  const { client, calls } = recordingClient();
  const result = await runUpdate({
    client,
    path: (s) => `/v1/sites/${s}/wifi/broadcasts/${WIFI_ID}`,
    body: readBackWifi(),
    label: `WiFi network ${WIFI_ID}`,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Refusing to write/);
  assert.match(textOf(result), /securityConfiguration\.passphrase/);
  assert.deepEqual(calls, []);
});

test("runCreate refuses a placeholder before resolving the site or sending the POST", async () => {
  const { client, calls } = recordingClient();
  const result = await runCreate({
    client,
    path: (s) => `/v1/sites/${s}/networks`,
    body: { name: "Lab", vpn: { peers: [{ presharedKey: REDACTED }] } },
    label: "network",
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /vpn\.peers\[0\]\.presharedKey/);
  assert.deepEqual(calls, []);
});

test("runUpdate and runCreate pass a clean body through", async () => {
  const { client, calls } = recordingClient();
  const body = readBackWifi();
  (body.securityConfiguration as Record<string, unknown>).passphrase = "correct horse";
  const updated = await runUpdate({ client, path: (s) => `/v1/sites/${s}/wifi/broadcasts/${WIFI_ID}`, body, label: "WiFi" });
  const created = await runCreate({ client, path: (s) => `/v1/sites/${s}/wifi/broadcasts`, body, label: "WiFi" });
  assert.notEqual(updated.isError, true);
  assert.notEqual(created.isError, true);
  assert.deepEqual(calls, [
    "resolveSiteId",
    `PUT /v1/sites/11111111-1111-1111-1111-111111111111/wifi/broadcasts/${WIFI_ID}`,
    "resolveSiteId",
    "POST /v1/sites/11111111-1111-1111-1111-111111111111/wifi/broadcasts",
  ]);
});

/**
 * A real UniFiClient whose transport is stubbed, so nothing leaves the process.
 * `respond` supplies the response data per request (default {ok: true}).
 */
function stubbedClient(respond: (config: InternalAxiosRequestConfig) => unknown = () => ({ ok: true })) {
  const sent: string[] = [];
  const bodies: unknown[] = [];
  const client = new UniFiClient({
    baseUrl: "https://console.invalid",
    apiKey: "test-key",
    tlsVerify: true,
    apiPath: "/proxy/network/integration",
  });
  const http = (client as unknown as { http: AxiosInstance }).http;
  http.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    sent.push(`${config.method?.toUpperCase()} ${config.url}`);
    if (config.data !== undefined) bodies.push(JSON.parse(config.data as string));
    return { data: respond(config), status: 200, statusText: "OK", headers: {}, config };
  };
  return { client, sent, bodies };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Register a tool module on a stand-in server and return its handlers by name. */
function toolHandlers(register: (server: McpServer, client: UniFiClient) => void, client: UniFiClient) {
  const handlers: Record<string, ToolHandler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  register(server, client);
  return handlers;
}

test("every client write method (POST/PUT/PATCH) refuses a placeholder without sending", async () => {
  const { client, sent } = stubbedClient();
  const body = { name: "Guests", securityConfiguration: { passphrase: REDACTED } };
  await assert.rejects(client.post("/v1/x", body), UniFiApiError);
  await assert.rejects(client.put("/v1/x", body), UniFiApiError);
  await assert.rejects(client.patch("/v1/x", body), UniFiApiError);
  assert.deepEqual(sent, []);
});

test("client write methods send clean bodies normally", async () => {
  const { client, sent } = stubbedClient();
  await client.put("/v1/x", { name: "Guests" });
  await client.post("/v1/y", { action: "RESTART" });
  assert.deepEqual(sent, ["PUT /v1/x", "POST /v1/y"]);
});

test("put with bodyFromConsole skips the guard; a plain put still refuses", async () => {
  const { client, sent } = stubbedClient();
  const body = { name: `Block ${REDACTED} host`, enabled: false };
  await assert.rejects(client.put("/v1/x", body), UniFiApiError);
  await client.put("/v1/x", body, { bodyFromConsole: true });
  assert.deepEqual(sent, ["PUT /v1/x"]);
});

test("unifi_set_firewall_policy_enabled toggles a policy whose own text contains the placeholder", async () => {
  const SITE = "11111111-1111-1111-1111-111111111111";
  const POLICY = "33333333-3333-3333-3333-333333333333";
  // The console's raw, unredacted policy: the user named it with the text itself.
  const stored = { id: POLICY, index: 7, metadata: { origin: "USER_DEFINED" }, name: `Block ${REDACTED} host`, enabled: true };
  const { client, sent, bodies } = stubbedClient((config) => (config.method === "get" ? stored : {}));
  const handlers = toolHandlers(registerFirewallTools, client);

  const result = await handlers["unifi_set_firewall_policy_enabled"]({ siteId: SITE, policyId: POLICY, enabled: false });
  assert.notEqual(result.isError, true, textOf(result));
  assert.deepEqual(sent, [
    `GET /v1/sites/${SITE}/firewall/policies/${POLICY}`,
    `PUT /v1/sites/${SITE}/firewall/policies/${POLICY}`,
  ]);
  assert.deepEqual(bodies, [{ name: `Block ${REDACTED} host`, enabled: false }]);
});

test("unifi_generate_vouchers refuses a placeholder in 'name' before any request, even on a cold site cache", async () => {
  const { client, sent } = stubbedClient();
  const handlers = toolHandlers(registerVoucherTools, client);

  const result = await handlers["unifi_generate_vouchers"]({ count: 1, name: `promo ${REDACTED}`, timeLimitMinutes: 60 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Refusing to write/);
  assert.match(textOf(result), /at name\./);
  assert.deepEqual(sent, [], "not even the site lookup may go out");
});
