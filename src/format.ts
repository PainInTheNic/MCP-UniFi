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

/** What every redacted credential value is replaced with. */
export const REDACTED = "[redacted]";

/**
 * Keys whose STRING values are treated as credentials and blanked before any
 * response leaves the server. String-only by design: fields like
 * `presharedKeyNetworkIds` (an array of IDs) must NOT be redacted.
 *
 * "token" counts only at the END of a key (token, accessToken, access_token,
 * X-Auth-Token), so metadata such as tokenType or tokenExpiresAt stays
 * readable. A leading "x_" is the legacy Network API's own marker for secret
 * fields (x_passphrase, x_iapp_key, x_shadow...).
 */
const SECRET_KEY =
  /passphrase|passw(?:or)?d|psk|secret|credential|(?:api|auth|private|pre[_-]?shared)[_-]?key|token$|^x_/i;

function redactInPlace(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === "string" && SECRET_KEY.test(key)) {
      (obj as Record<string, unknown>)[key] = REDACTED;
    } else {
      redactInPlace(value);
    }
  }
}

/**
 * Paths (e.g. "securityConfiguration.passphrase", "entries[2].secret") of
 * every string in `value` that contains the REDACTED placeholder. Writes are
 * checked with this: a placeholder copied back from a redacted read would
 * otherwise be stored as the literal new credential.
 */
export function findRedactedPlaceholders(value: unknown, path = ""): string[] {
  if (typeof value === "string") return value.includes(REDACTED) ? [path || "(the whole body)"] : [];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findRedactedPlaceholders(item, `${path}[${i}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    findRedactedPlaceholders(item, path ? `${path}.${key}` : key),
  );
}

/** Deep-clone a value with all credential-looking string fields blanked. */
export function redactedClone<T>(value: T): T {
  const clone = structuredClone(value);
  redactInPlace(clone);
  return clone;
}

/** Render an object as an indented JSON code block (credentials redacted). */
export function jsonBlock(value: unknown): string {
  return "```json\n" + JSON.stringify(redactedClone(value), null, 2) + "\n```";
}

/**
 * Result for JSON-mode responses: emits the (redacted) object both as a
 * human-readable ```json block AND as machine-parseable structuredContent,
 * so clients don't have to string-parse the text.
 */
export function jsonResult(prefix: string, value: unknown): CallToolResult {
  const safe = redactedClone(value);
  const structured =
    safe && typeof safe === "object" && !Array.isArray(safe)
      ? (safe as Record<string, unknown>)
      : { data: safe };
  const body = "```json\n" + JSON.stringify(safe, null, 2) + "\n```";
  return textResult((prefix ? prefix + "\n\n" : "") + body, structured);
}

/**
 * A firewall policy's or ACL rule's action as text. Newer UniFi Network versions
 * (seen on 10.6) return an object such as { type: "ALLOW", allowReturnTraffic: true };
 * older ones a plain string. Anything else renders as "?".
 */
export function formatAction(action: unknown): string {
  if (typeof action === "string" && action !== "") return action;
  if (action !== null && typeof action === "object") {
    const a = action as { type?: unknown; allowReturnTraffic?: unknown };
    if (typeof a.type === "string" && a.type !== "") {
      return a.type + (a.allowReturnTraffic === true ? " (+return traffic)" : "");
    }
  }
  return "?";
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
