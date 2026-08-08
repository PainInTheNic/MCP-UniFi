/**
 * Shared response-formatting helpers.
 *
 * Every tool supports two output styles:
 *  - "markdown": compact, human-readable summaries (default — cheapest for
 *    the model to read)
 *  - "json": full raw API data for when every field matters
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Maximum characters a single tool response may contain. */
export const CHARACTER_LIMIT = 25_000;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Standard paginated envelope returned by every UniFi list endpoint. */
export interface UniFiPage<T> {
  offset: number;
  limit: number;
  count: number;
  totalCount: number;
  data: T[];
}

/** Pagination summary appended to list-tool output. */
export function paginationFooter(page: UniFiPage<unknown>): string {
  const shownEnd = page.offset + page.count;
  const hasMore = shownEnd < page.totalCount;
  let footer = `\nShowing ${page.offset + 1}-${shownEnd} of ${page.totalCount}.`;
  if (hasMore) footer += ` More available: pass offset=${shownEnd} to continue.`;
  return footer;
}

/** Wrap a finished string (already formatted) as an MCP tool result. */
export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  const truncated =
    text.length > CHARACTER_LIMIT
      ? text.slice(0, CHARACTER_LIMIT) +
        `\n\n[Response truncated at ${CHARACTER_LIMIT} characters; any JSON above may be incomplete. On list tools, narrow the result with a smaller 'limit'/'offset' or a 'filter'; on single-item tools, the object itself is simply large.]`
      : text;
  const result: CallToolResult = { content: [{ type: "text", text: truncated }] };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

/** Wrap an error message as an MCP tool result with isError set. */
export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Render an object as an indented JSON code block. */
export function jsonBlock(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

/** "key: value" line, omitted entirely when the value is null/undefined/empty. */
export function line(label: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return `- **${label}**: ${String(value)}`;
}

/** Join defined lines, dropping omitted ones. */
export function lines(...items: Array<string | undefined>): string {
  return items.filter((l): l is string => l !== undefined).join("\n");
}

/** Human-readable seconds → "3d 4h 12m" style uptime. */
export function formatUptime(seconds: number | undefined | null): string | undefined {
  if (seconds === undefined || seconds === null) return undefined;
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

/** Bytes → human-readable size. */
export function formatBytes(bytes: number | undefined | null): string | undefined {
  if (bytes === undefined || bytes === null) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}
