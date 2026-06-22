/* eslint-disable no-console */
/**
 * Pure HTTP primitives extracted from client.ts (Step 9).
 *
 * Only zero-coupling helpers live here: no module state, no diagnostics,
 * no auth storage. Functions that mutate or read module-level state stay in
 * client.ts.
 */

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 8787;
export const DEFAULT_GATEWAY_HOST_ALLOWLIST: string[] = [];
export const MAX_SSE_BUFFER_CHARS = 256_000;
export const MAX_SSE_EVENT_PREVIEW_CHARS = 180;

export const SAFE_RETRY_METHODS = new Set(["GET", "HEAD"]);
export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
export const SAFE_REQUEST_RETRY_DELAYS_MS = [250];
export const BROWSER_MUTATION_INTENT_HEADER = "x-goatcitadel-browser-intent";
export const BROWSER_MUTATION_INTENT_VALUE = "mutation";

export type GatewayAuthMode = "none" | "token" | "basic";

export interface ParsedApiError {
  body?: unknown;
  authMode?: GatewayAuthMode;
}

export interface ApiRequestErrorOptions {
  kind: "http" | "network" | "protocol";
  method: string;
  path: string;
  status?: number;
  body?: unknown;
  bodyText?: string;
  authMode?: GatewayAuthMode;
  cause?: unknown;
}

export class ApiRequestError extends Error {
  public readonly kind: "http" | "network" | "protocol";

  public readonly method: string;

  public readonly path: string;

  public readonly status?: number;

  public readonly body?: unknown;

  public readonly bodyText?: string;

  public readonly authMode?: GatewayAuthMode;

  public constructor(message: string, options: ApiRequestErrorOptions) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = options.kind;
    this.method = options.method;
    this.path = options.path;
    this.status = options.status;
    this.body = options.body;
    this.bodyText = options.bodyText;
    this.authMode = options.authMode;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

export function normalizeHttpMethod(method?: string): string {
  return (method ?? "GET").toUpperCase();
}

export function shouldRetrySafeRequest(method: string, error?: ApiRequestError): boolean {
  if (!SAFE_RETRY_METHODS.has(method) || !error) {
    return false;
  }
  if (error.kind === "network") {
    return true;
  }
  if (error.kind === "protocol") {
    return false;
  }
  return error.status !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(error.status);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export function unwrapApiResponse<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload && ("success" in payload || "meta" in payload)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

export function isPrivateOrCarrierGradeIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 100 && b >= 64 && b <= 127;
}

export function isTrustedGatewayHost(hostname: string, rawAllowlist?: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".ts.net")) {
    return true;
  }
  if (isPrivateOrCarrierGradeIpv4(host)) {
    return true;
  }
  const allowlist = (rawAllowlist ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const mergedAllowlist = [...DEFAULT_GATEWAY_HOST_ALLOWLIST, ...allowlist];
  return mergedAllowlist.some((entry) => {
    if (entry.startsWith(".")) {
      return host.endsWith(entry);
    }
    return host === entry;
  });
}

export function inferDefaultGatewayBaseUrl(): string {
  if (typeof window === "undefined") {
    return `http://${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const host = window.location.hostname || DEFAULT_GATEWAY_HOST;
  if (isTrustedGatewayHost(host, import.meta.env.VITE_GATEWAY_ALLOWED_HOSTS)) {
    return `${protocol}//${host}:${DEFAULT_GATEWAY_PORT}`;
  }
  console.warn(
    `[goatcitadel] refusing inferred gateway host "${host}" because it is not trusted; ` +
      `falling back to ${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}. Set VITE_GATEWAY_ALLOWED_HOSTS to override.`,
  );
  return `${protocol}//${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
}

export function inferOriginSurface(path: string): string {
  if (path.startsWith("/api/v1/chat")) {
    return "chat";
  }
  if (path.startsWith("/api/v1/addons")) {
    return "addons";
  }
  if (path.startsWith("/api/v1/voice")) {
    return "voice";
  }
  if (path.startsWith("/api/v1/mcp")) {
    return "mcp";
  }
  if (path.startsWith("/api/v1/integrations")) {
    return "integrations";
  }
  return "app";
}

export function normalizeAuthMode(value: unknown): GatewayAuthMode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const authMode = (value as { authMode?: unknown }).authMode;
  return authMode === "none" || authMode === "token" || authMode === "basic" ? authMode : undefined;
}

export function parseApiError(text: string): ParsedApiError {
  if (!text) {
    return {};
  }
  try {
    const body = JSON.parse(text) as unknown;
    return {
      body,
      authMode: normalizeAuthMode(body),
    };
  } catch {
    return {
      body: text,
    };
  }
}
