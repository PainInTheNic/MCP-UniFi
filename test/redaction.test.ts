/**
 * Credential redaction in responses (src/format.ts). Offline: pure functions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, jsonBlock, jsonResult, redactedClone } from "../src/format.js";

test("redacts credential-looking string keys in every common spelling", () => {
  const secretKeys = [
    "passphrase",
    "password",
    "saePassword",
    "passwd",
    "psk",
    "wpaPsk",
    "secret",
    "sharedSecret",
    "client_secret",
    "credentials",
    "apiKey",
    "api_key",
    "x-api-key",
    "X-API-KEY",
    "authKey",
    "privateKey",
    "private_key",
    "presharedKey",
    "pre_shared_key",
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "X-Auth-Token",
    "x_passphrase",
    "x_iapp_key",
    "x_shadow",
  ];
  const input = Object.fromEntries(secretKeys.map((k) => [k, "hunter22"]));
  const out = redactedClone(input) as Record<string, unknown>;
  for (const key of secretKeys) {
    assert.equal(out[key], REDACTED, `expected "${key}" to be redacted`);
  }
});

test("leaves useful non-secret fields readable", () => {
  const input = {
    name: "Office",
    tokenType: "BEARER",
    tokenExpiresAt: "2026-10-07T00:00:00Z",
    tokenCount: "12",
    maxTokens: "4096",
    publicKey: "pubkey-abc",
    keyId: "k1",
    code: "12345-67890", // voucher codes are meant to be shown
    securityConfiguration: { type: "WPA2_PERSONAL" },
  };
  assert.deepEqual(redactedClone(input), input);
});

test("redacts string values only, never arrays, numbers or booleans under secret keys", () => {
  const input = {
    presharedKeyNetworkIds: ["11111111-1111-1111-1111-111111111111"],
    passwordRequired: true,
    secretRotationDays: 30,
    psk: null,
  };
  assert.deepEqual(redactedClone(input), input);
});

test("redacts deep inside nested objects and arrays", () => {
  const input = {
    securityConfiguration: { type: "WPA2_PERSONAL", passphrase: "correct horse" },
    radius: { servers: [{ host: "10.0.0.5", sharedSecret: "s3cr3t" }] },
  };
  const out = redactedClone(input);
  assert.equal(out.securityConfiguration.passphrase, REDACTED);
  assert.equal(out.securityConfiguration.type, "WPA2_PERSONAL");
  assert.equal(out.radius.servers[0].sharedSecret, REDACTED);
  assert.equal(out.radius.servers[0].host, "10.0.0.5");
});

test("does not mutate the original object", () => {
  const input = { passphrase: "correct horse" };
  redactedClone(input);
  assert.equal(input.passphrase, "correct horse");
});

test("jsonBlock and jsonResult never emit the raw credential", () => {
  const wifi = { name: "Home", securityConfiguration: { passphrase: "correct horse" } };
  assert.ok(!jsonBlock(wifi).includes("correct horse"));

  const result = jsonResult("Updated.", wifi);
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert.ok(!text.includes("correct horse"));
  assert.ok(!JSON.stringify(result.structuredContent).includes("correct horse"));
  assert.ok(text.includes(REDACTED));
});
