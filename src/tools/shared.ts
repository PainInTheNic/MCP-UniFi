/**
 * Shared plumbing for tool implementations: common Zod fragments, the
 * site-scoped list-tool runner, and uniform error handling.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UniFiApiError, UniFiClient } from "../unifi-client.js";
import {
  CHARACTER_LIMIT,
  ResponseFormat,
  UniFiPage,
  errorResult,
  jsonBlock,
  paginationFooter,
  textResult,
} from "../format.js";

/**
 * Optional site selector shared by every site-scoped tool.
 * UUID-constrained: IDs are interpolated into URL paths, so free-form strings
 * could redirect a request to a different endpoint (e.g. via "../").
 */
export const siteIdField = z
  .string()
  .uuid("siteId must be a UUID")
  .optional()
  .describe(
    "Site ID (UUID from unifi_list_sites). Optional — when the console has exactly one site it is used automatically.",
  );

/** UUID-constrained resource ID field (same path-injection rationale as siteIdField). */
export const uuidField = (description: string) =>
  z.string().uuid("must be a UUID").describe(description);

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(200)
  .default(50)
  .describe("Maximum number of results to return (1-200, default 50)");

export const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of results to skip, for pagination (default 0)");

/**
 * UniFi filter expression, e.g. "state.eq('ONLINE')" or
 * "and(access.type.eq('GUEST'), name.isNotNull())". Passed straight through
 * as the `filter` query param.
 */
export const filterField = z
  .string()
  .optional()
  .describe(
    "Optional UniFi filter expression: property.function(args) with functions eq, ne, like, in, isNull, isNotNull and more; combinators and(...), or(...), not(...). Strings in single quotes. Examples: \"state.eq('OFFLINE')\", \"access.type.eq('GUEST')\", \"name.like('Office*')\". Note: which properties are filterable varies by endpoint — a 400 error means that property/function is not supported here.",
  );

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for a compact human-readable summary (default), 'json' for full raw API data");

/**
 * Run a tool body with uniform error handling. UniFiApiError messages are
 * crafted to be shown to the model; anything else gets a generic wrapper.
 */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UniFiApiError) return errorResult(`Error: ${error.message}`);
    return errorResult(`Error: unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ListToolOptions<T> {
  client: UniFiClient;
  /** Site-relative path builder, e.g. (siteId) => `/v1/sites/${siteId}/devices` */
  path: (siteId: string) => string;
  siteId?: string;
  limit: number;
  offset: number;
  format: ResponseFormat;
  /** Extra query params (filter etc.) */
  params?: Record<string, unknown>;
  /** Markdown heading, e.g. "Adopted devices" */
  heading: string;
  /** One markdown bullet (or multi-line block) per item. */
  formatItem: (item: T) => string;
  /** Message when the list is empty. */
  emptyMessage: string;
}

/** Fetch one page of a site-scoped list endpoint and format it. */
export async function runListTool<T>(opts: ListToolOptions<T>): Promise<CallToolResult> {
  return guard(async () => {
    const siteId = await opts.client.resolveSiteId(opts.siteId);
    const page = await opts.client.page<T>(opts.path(siteId), {
      limit: opts.limit,
      offset: opts.offset,
      ...opts.params,
    });

    if (page.data.length === 0) {
      // Distinguish "collection is empty" from "paged past the end" — the
      // latter must not read as "nothing exists".
      if (page.totalCount > 0 && page.offset > 0) {
        return textResult(
          `No results at offset ${page.offset} — the collection has ${page.totalCount} item(s) total. Use a smaller offset.`,
        );
      }
      return textResult(opts.emptyMessage);
    }

    if (opts.format === ResponseFormat.JSON) {
      return textResult(jsonBlock(page));
    }

    // Build the body within a character budget so the pagination footer
    // always survives — truncating from the end would destroy it exactly
    // when the response is large and the model needs it most.
    const heading = `## ${opts.heading}\n\n`;
    const footer = paginationFooter(page as UniFiPage<unknown>);
    const budget = CHARACTER_LIMIT - heading.length - footer.length - 250;
    const bullets: string[] = [];
    let used = 0;
    for (const item of page.data) {
      const bullet = opts.formatItem(item);
      if (used + bullet.length + 1 > budget) break;
      bullets.push(bullet);
      used += bullet.length + 1;
    }
    const omitted = page.data.length - bullets.length;
    const note =
      omitted > 0
        ? `\n\n[${omitted} of this page's ${page.data.length} items omitted to fit the size limit — use a smaller 'limit' or a filter.]`
        : "";
    return textResult(heading + bullets.join("\n") + note + "\n" + footer);
  });
}
