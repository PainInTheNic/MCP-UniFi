/**
 * The client must never follow a redirect (which would forward the X-API-KEY
 * header to wherever Location points) and must explain a 3xx clearly.
 * Offline: two throwaway HTTP servers on 127.0.0.1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UniFiApiError, UniFiClient } from "../src/unifi-client.js";

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test("a cross-host redirect is not followed and yields a clear error", async (t) => {
  // The "other host": records anything that reaches it.
  const leaked: IncomingHttpHeaders[] = [];
  const other = await listen((req, res) => {
    leaked.push(req.headers);
    res.end("{}");
  });
  t.after(() => other.server.close());

  const consoleServer = await listen((_req, res) => {
    res.writeHead(302, { Location: `${other.origin}/collect?stolen=1` });
    res.end();
  });
  t.after(() => consoleServer.server.close());

  const client = new UniFiClient({
    baseUrl: consoleServer.origin,
    apiKey: "test-key",
    tlsVerify: true,
    apiPath: "/proxy/network/integration",
  });

  await assert.rejects(client.get("/v1/sites"), (error: unknown) => {
    assert.ok(error instanceof UniFiApiError);
    assert.match(error.message, /redirect \(302\)/);
    assert.match(error.message, new RegExp(`to ${other.origin}/collect `));
    assert.doesNotMatch(error.message, /stolen/); // query string is not echoed
    assert.match(error.message, /UNIFI_BASE_URL/);
    return true;
  });
  assert.equal(leaked.length, 0, "the redirect target must never be contacted");
});
