/**
 * Hotspot voucher tools: create and manage guest WiFi access codes.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UniFiClient } from "../unifi-client.js";
import { ResponseFormat, jsonBlock, line, lines, textResult } from "../format.js";
import {
  filterField,
  guard,
  limitField,
  offsetField,
  responseFormatField,
  runListTool,
  siteIdField,
  uuidField,
} from "./shared.js";

interface Voucher {
  id: string;
  code?: string;
  name?: string;
  createdAt?: string;
  expired?: boolean;
  expiresAt?: string;
  authorizedGuestCount?: number;
  authorizedGuestLimit?: number;
  timeLimitMinutes?: number;
  [key: string]: unknown;
}

function voucherBullet(v: Voucher): string {
  return lines(
    `- **${v.code ?? "?"}**${v.name ? ` (${v.name})` : ""}${v.expired ? " [expired]" : ""}`,
    line("  id", `\`${v.id}\``),
    line("  time limit", v.timeLimitMinutes !== undefined ? `${v.timeLimitMinutes} min` : undefined),
    line(
      "  guests",
      v.authorizedGuestLimit !== undefined ? `${v.authorizedGuestCount ?? 0}/${v.authorizedGuestLimit}` : undefined,
    ),
    line("  created", v.createdAt),
  );
}

export function registerVoucherTools(server: McpServer, client: UniFiClient): void {
  server.registerTool(
    "unifi_list_vouchers",
    {
      title: "List Hotspot Vouchers",
      description:
        "List guest hotspot vouchers on a site, including the voucher codes, usage counts, and expiry status. Vouchers are access codes guests redeem on the captive portal.",
      inputSchema: {
        siteId: siteIdField,
        filter: filterField,
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, filter, limit, offset, response_format }) =>
      runListTool<Voucher>({
        client,
        siteId,
        limit,
        offset,
        format: response_format,
        params: filter ? { filter } : undefined,
        path: (site) => `/v1/sites/${site}/hotspot/vouchers`,
        heading: "Hotspot vouchers",
        emptyMessage: "No hotspot vouchers found on this site.",
        formatItem: voucherBullet,
      }),
  );

  server.registerTool(
    "unifi_generate_vouchers",
    {
      title: "Generate Hotspot Vouchers",
      description:
        "Generate new guest hotspot voucher codes with optional time/data/bandwidth limits. Returns the generated codes — share them with guests to grant WiFi access.",
      inputSchema: {
        siteId: siteIdField,
        count: z.number().int().min(1).max(1000).default(1).describe("How many voucher codes to generate (default 1)"),
        name: z.string().min(1).max(255).describe("Label for this batch of vouchers, e.g. 'Weekend guests'"),
        timeLimitMinutes: z.number().int().min(1).default(1440).describe("Minutes each voucher grants access for (default 1440 = 24h)"),
        authorizedGuestLimit: z.number().int().min(1).optional().describe("How many guests may redeem one voucher (omit for unlimited)"),
        dataUsageLimitMBytes: z.number().int().min(1).optional().describe("Data cap per guest in megabytes (omit for unlimited)"),
        rxRateLimitKbps: z.number().int().min(2).optional().describe("Download rate limit in Kbps (omit for unlimited)"),
        txRateLimitKbps: z.number().int().min(2).optional().describe("Upload rate limit in Kbps (omit for unlimited)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ siteId, count, name, timeLimitMinutes, authorizedGuestLimit, dataUsageLimitMBytes, rxRateLimitKbps, txRateLimitKbps }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        // Note: unlike list endpoints, voucher generation returns {vouchers: [...]}
        const result = await client.post<{ vouchers?: Voucher[] }>(`/v1/sites/${site}/hotspot/vouchers`, {
          count,
          name,
          timeLimitMinutes,
          ...(authorizedGuestLimit !== undefined && { authorizedGuestLimit }),
          ...(dataUsageLimitMBytes !== undefined && { dataUsageLimitMBytes }),
          ...(rxRateLimitKbps !== undefined && { rxRateLimitKbps }),
          ...(txRateLimitKbps !== undefined && { txRateLimitKbps }),
        });
        const vouchers = result.vouchers ?? [];
        const codes = vouchers.map((v) => `- **${v.code ?? "?"}** (id: \`${v.id}\`)`).join("\n");
        return textResult(`Generated ${vouchers.length} voucher(s) labeled "${name}" (${timeLimitMinutes} min each):\n\n${codes}`);
      }),
  );

  server.registerTool(
    "unifi_delete_voucher",
    {
      title: "Delete Hotspot Voucher",
      description:
        "Delete one hotspot voucher by ID, revoking the code. IDs come from unifi_list_vouchers. This cannot be undone — confirm with the user first.",
      inputSchema: {
        siteId: siteIdField,
        voucherId: uuidField("Voucher ID (UUID from unifi_list_vouchers)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ siteId, voucherId }) =>
      guard(async () => {
        const site = await client.resolveSiteId(siteId);
        await client.delete(`/v1/sites/${site}/hotspot/vouchers/${voucherId}`);
        return textResult(`Voucher ${voucherId} deleted.`);
      }),
  );
}
