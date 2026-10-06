/**
 * Authenticated HTTP client for the official UniFi Network API
 * (the "Integration API", available on UniFi OS consoles running
 * Network 9.0+ at https://<console>/proxy/network/integration/v1/...).
 *
 * Centralizes: authentication header, TLS handling for self-signed
 * console certificates, error translation into actionable messages,
 * and default-site resolution.
 */

import axios, { AxiosError, type AxiosInstance } from "axios";
import { Agent } from "node:https";
import { redactUrl, type UniFiConfig } from "./config.js";
import type { UniFiPage } from "./format.js";

/** Error carrying a message that is safe and useful to show the model. */
export class UniFiApiError extends Error {}

interface UniFiSite {
  id: string;
  internalReference?: string;
  name?: string;
}

/** Envelope returned by the legacy (pre-Integration) Network API. */
interface LegacyEnvelope<T> {
  meta?: { rc?: string; msg?: string };
  data?: T[];
}

export class UniFiClient {
  private readonly http: AxiosInstance;
  private readonly legacyBaseUrl: string;
  private cachedSites: UniFiSite[] | null = null;

  constructor(private readonly config: UniFiConfig) {
    this.http = axios.create({
      baseURL: `${config.baseUrl}${config.apiPath}`,
      timeout: 20_000,
      headers: {
        "X-API-KEY": config.apiKey,
        Accept: "application/json",
      },
      httpsAgent: new Agent({ rejectUnauthorized: config.tlsVerify }),
    });
    // "/proxy/network/integration" -> "/proxy/network/api"
    this.legacyBaseUrl = `${config.baseUrl}${config.apiPath.replace(/\/integration$/, "")}/api`;
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>("GET", path, undefined, params);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  async delete<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>("DELETE", path, undefined, params);
  }

  /** GET a paginated list endpoint. */
  async page<T>(path: string, params?: Record<string, unknown>): Promise<UniFiPage<T>> {
    return this.get<UniFiPage<T>>(path, params);
  }

  /**
   * GET from the console's legacy Network API (/proxy/network/api/...), which
   * also accepts the API key. Undocumented and unversioned — use only for data
   * the Integration API does not expose, since Ubiquiti may change it freely.
   * Absolute URL, so axios bypasses the Integration API baseURL.
   */
  async getLegacy<T>(path: string): Promise<T[]> {
    const envelope = await this.request<LegacyEnvelope<T>>("GET", `${this.legacyBaseUrl}${path}`);
    if (envelope?.meta?.rc !== "ok") {
      const msg = envelope?.meta?.msg ? `: ${envelope.meta.msg}` : "";
      throw new UniFiApiError(`Legacy Network API call ${path} failed${msg}.`);
    }
    return envelope.data ?? [];
  }

  /**
   * Resolve the site to operate on. Most consoles have exactly one site, so
   * tools accept an optional siteId and fall back to the only site when
   * unambiguous.
   */
  async resolveSiteId(siteId?: string): Promise<string> {
    if (siteId && siteId.trim() !== "") return siteId.trim();
    const sites = await this.listSites();
    if (sites.length === 1) return sites[0].id;
    const names = sites.map((s) => `"${s.name ?? s.internalReference ?? "?"}" (id: ${s.id})`).join(", ");
    throw new UniFiApiError(
      `This console has ${sites.length} sites, so 'siteId' is required. Available sites: ${names || "none found"}.`,
    );
  }

  /**
   * Resolve a site to its legacy short name (e.g. "default"), which legacy API
   * paths use instead of the UUID. Charset-checked before it goes into a path.
   */
  async resolveSiteReference(siteId?: string): Promise<string> {
    const id = await this.resolveSiteId(siteId);
    const ref = (await this.listSites()).find((s) => s.id === id)?.internalReference;
    if (!ref || !/^[A-Za-z0-9_-]+$/.test(ref)) {
      throw new UniFiApiError(`Site ${id} was not found on this console, or has no usable internal reference.`);
    }
    return ref;
  }

  private async listSites(): Promise<UniFiSite[]> {
    if (this.cachedSites === null) {
      const page = await this.page<UniFiSite>("/v1/sites", { limit: 200 });
      this.cachedSites = page.data;
    }
    return this.cachedSites;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    params?: Record<string, unknown>,
  ): Promise<T> {
    try {
      const response = await this.http.request<T>({ method, url: path, data: body, params });
      return response.data;
    } catch (error) {
      throw new UniFiApiError(this.describeError(error, method, redactUrl(path)));
    }
  }

  /** Translate transport/API failures into messages that say what to do next. */
  private describeError(error: unknown, method: string, path: string): string {
    if (axios.isAxiosError(error)) {
      const e = error as AxiosError<{ message?: string; statusName?: string }>;

      if (e.response) {
        const status = e.response.status;
        const apiMessage = e.response.data?.message ?? e.response.data?.statusName ?? "";
        const detail = apiMessage ? ` API message: "${apiMessage}".` : "";
        switch (status) {
          case 400:
            return `Bad request (400) for ${method} ${path}.${detail} Check parameter values and formats.`;
          case 401:
            return `Authentication failed (401). The UNIFI_API_KEY is missing, invalid, or expired. Create a new key in the UniFi console under Settings > Control Plane > Integrations.${detail}`;
          case 403:
            return `Permission denied (403) for ${method} ${path}. The API key's role may not allow this operation.${detail}`;
          case 404:
            return `Not found (404) for ${method} ${path}.${detail} If the ID is definitely correct, this console/Network version may not support this endpoint.`;
          case 429: {
            const retryAfter = e.response.headers?.["retry-after"];
            const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : " Wait a moment and retry.";
            return `Rate limit exceeded (429).${wait}${detail}`;
          }
          default:
            return `UniFi API request failed with status ${status} for ${method} ${path}.${detail}`;
        }
      }

      const code = e.code ?? "";
      if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
        return `Cannot reach the UniFi console at ${redactUrl(this.config.baseUrl)} (${code}). Check UNIFI_BASE_URL, and that this machine is on the same network/VPN as the console.`;
      }
      if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
        return `Request to the UniFi console timed out. The console may be busy or unreachable from this machine.`;
      }
      if (
        code.startsWith("ERR_TLS") ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "ERR_CERT_AUTHORITY_INVALID"
      ) {
        return `TLS certificate validation failed connecting to ${redactUrl(this.config.baseUrl)}. UniFi consoles use self-signed certificates by default. If this console's cert is self-signed and the connection path is a trusted LAN, the user can set UNIFI_TLS_VERIFY=false — but that disables verification entirely and would let an on-path attacker intercept the API key, so it is their call to make, not yours.`;
      }
      return `Network error calling the UniFi API: ${e.message}`;
    }
    if (error instanceof Error) return `Unexpected error: ${error.message}`;
    return `Unexpected error: ${String(error)}`;
  }
}
