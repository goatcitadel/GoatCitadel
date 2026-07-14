import { lookup as nodeDnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { redactSecretText, type EgressDecision } from "@goatcitadel/contracts";
import { Agent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";
import {
  assertSafeRedirectTransition,
  HttpMutationOutcomeUnknownError,
  isHttpRequestSafeToRetry,
} from "./http-request-policy.js";

const DISALLOWED_HOSTS = new Set(["0.0.0.0", "169.254.169.254", "metadata.google.internal", "100.100.100.200"]);
const DEFAULT_GLOBAL_FETCH = globalThis.fetch;

// SECURITY (codex finding #25b, #26): Channel integrations embed secrets in
// URLs (BlueBubbles `?password=…`, Telegram `/bot<token>/…`, Zalo path tokens).
// When `assertHostAllowed` throws, callers like `commsInvoke` propagate
// `error.message` into delivery error records — which previously exposed the
// raw URL including query/path/userinfo. Always pass user-supplied URLs
// through `redactUrlForError` before formatting an Error message.
export function redactUrlForError(input: string): string {
  if (typeof input !== "string" || !input.trim()) {
    return "<empty>";
  }
  try {
    const url = new URL(input.trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    // Bare host inputs like `localhost:8080` reach here. Strip anything after
    // the first `/` (path), `?` (query), and `@` (userinfo) so we never echo
    // secret-bearing path/query data when the input was URL-shaped but
    // missing a scheme.
    const trimmed = input.trim();
    const withoutPath = trimmed.split(/[/?#]/, 1)[0] ?? "";
    const withoutUserinfo = withoutPath.includes("@")
      ? withoutPath.slice(withoutPath.lastIndexOf("@") + 1)
      : withoutPath;
    return withoutUserinfo || "<unparseable>";
  }
}

export function isHostAllowed(hostOrUrl: string, allowlist: string[]): boolean {
  return evaluateHostEgress(hostOrUrl, allowlist).allowed;
}

export function evaluateHostEgress(hostOrUrl: string, allowlist: string[]): EgressDecision {
  const parsed = parseHost(hostOrUrl);
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();

  if (parsed.invalidReason) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: false,
      approvalState: "blocked",
      reason: parsed.invalidReason,
    };
  }

  if (!host && !hostname) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: false,
      approvalState: "blocked",
      reason: "Host is empty.",
    };
  }

  const isPrivateOrReserved = isPrivateOrReservedHost(hostname);
  const matchedPattern = allowlist.find(
    (pattern) => matchesAllowlistPattern(host, pattern) || matchesAllowlistPattern(hostname, pattern),
  );

  if (!matchedPattern) {
    const redacted = redactUrlForError(hostOrUrl);
    return {
      target: hostOrUrl,
      hostname,
      allowed: false,
      approvalState: isPrivateOrReserved ? "blocked" : "approval_required",
      reason: isPrivateOrReserved
        ? `Private, loopback, or reserved host is blocked: ${redacted}`
        : `Host is not yet allowlisted: ${redacted}`,
    };
  }

  if (!isPrivateOrReserved) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: true,
      approvalState: "not_required",
      reason: "Host matches network allowlist.",
      matchedAllowlistPattern: matchedPattern,
    };
  }

  if (isExplicitLoopbackPattern(matchedPattern, hostname)) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: true,
      approvalState: "not_required",
      reason: "Loopback host explicitly allowlisted.",
      matchedAllowlistPattern: matchedPattern,
    };
  }

  return {
    target: hostOrUrl,
    hostname,
    allowed: false,
    approvalState: "blocked",
    reason: `Private, metadata, or reserved host is blocked: ${redactUrlForError(hostOrUrl)}`,
    matchedAllowlistPattern: matchedPattern,
  };
}

export function assertHostAllowed(hostOrUrl: string, allowlist: string[]): void {
  const decision = evaluateHostEgress(hostOrUrl, allowlist);
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }
}

// SECURITY (codex finding #11, #12): For features like Firecrawl ingestion
// where the user/agent supplies an arbitrary base URL that may legitimately
// be on any public host, we still must block private/reserved/loopback/
// metadata destinations. This helper enforces only the SSRF half of the
// allowlist: it accepts any public host, rejects any private one.
export function assertNotPrivateOrReservedHost(hostOrUrl: string): void {
  const parsed = parseHost(hostOrUrl);
  if (parsed.invalidReason) {
    throw new Error(`${parsed.invalidReason.trim()} (${redactUrlForError(hostOrUrl)})`);
  }
  if (!parsed.host && !parsed.hostname) {
    throw new Error(`Host is empty: ${redactUrlForError(hostOrUrl)}`);
  }
  if (isPrivateOrReservedHost(parsed.hostname.toLowerCase())) {
    throw new Error(`Private, metadata, or reserved host is blocked: ${redactUrlForError(hostOrUrl)}`);
  }
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 5;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_FETCH_BODY_TIMEOUT_MS = 15_000;

export interface FetchAllowlistedOptions {
  allowlist: string[];
  additionalAllowlists?: string[][];
  timeoutMs?: number;
  bodyReadTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  trustedCrossOriginHeaders?: string[];
  init?: RequestInit;
  dnsLookup?: DnsLookupFunction;
}

export interface FetchBodyReadLimits {
  timeoutMs: number;
  maxBytes: number;
}

export type DnsLookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;
type FetchWithDispatcher = (input: string, init: RequestInit & { dispatcher: Dispatcher }) => Promise<Response>;

// SECURITY (codex finding #11, #12, #14, #22, #23): A single outbound HTTP
// helper that:
//   1. validates the host against the egress allowlist,
//   2. does manual redirect handling and re-validates each hop against the
//      same allowlist (so allowlisted public hosts cannot 30x to private/
//      metadata addresses),
//   3. caps the redirect chain,
//   4. never includes the request URL in error messages (use the redacted
//      form so secret-bearing query/path data does not leak into delivery
//      errors or model tool transcripts).
//
// Callers replacing bare `fetch()` must NOT layer their own follow-redirect
// logic on top of this — the helper already follows redirects safely.
export async function fetchAllowlisted(url: string, options: FetchAllowlistedOptions): Promise<Response> {
  const allowlist = options.allowlist;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_FETCH_MAX_REDIRECTS;
  let currentUrl = url;
  let hops = 0;
  let lastResponse: Response | undefined;

  while (true) {
    assertHostAllowed(currentUrl, allowlist);
    for (const additionalAllowlist of options.additionalAllowlists ?? []) {
      if (additionalAllowlist.length > 0) {
        assertHostAllowed(currentUrl, additionalAllowlist);
      }
    }

    const controller = new AbortController();
    const userSignal = options.init?.signal;
    if (userSignal) {
      if (userSignal.aborted) {
        controller.abort(userSignal.reason);
      } else {
        userSignal.addEventListener("abort", () => controller.abort(userSignal.reason), { once: true });
      }
    }
    const timeout = setTimeout(() => controller.abort(new Error("fetchAllowlisted timed out")), timeoutMs);

    try {
      lastResponse = await fetchGuardedOnce(
        currentUrl,
        allowlist,
        {
          ...options.init,
          redirect: "manual",
          signal: controller.signal,
          dnsLookup: options.dnsLookup,
        },
        resolveFetchBodyReadLimits(options),
      );
    } finally {
      clearTimeout(timeout);
    }

    if (lastResponse.status < 300 || lastResponse.status >= 400) {
      return lastResponse;
    }

    const location = lastResponse.headers.get("location");
    if (!location) {
      return lastResponse;
    }
    try {
      hops += 1;
      if (hops > maxRedirects) {
        throw new Error(`fetchAllowlisted blocked: too many redirects (${hops}) from ${redactUrlForError(url)}`);
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new Error(`fetchAllowlisted blocked: malformed redirect Location from ${redactUrlForError(url)}`);
      }
      assertSafeRedirectTransition(currentUrl, nextUrl, options.init ?? {}, options.trustedCrossOriginHeaders);
      assertHostAllowed(nextUrl, allowlist);
      for (const additionalAllowlist of options.additionalAllowlists ?? []) {
        if (additionalAllowlist.length > 0) {
          assertHostAllowed(nextUrl, additionalAllowlist);
        }
      }
      currentUrl = nextUrl;
    } catch (error) {
      if (!isHttpRequestSafeToRetry(options.init)) {
        throw new HttpMutationOutcomeUnknownError("fetchAllowlisted", error);
      }
      throw error;
    }
  }
}

export async function fetchAllowlistedOnce(url: string, options: FetchAllowlistedOptions): Promise<Response> {
  assertHostAllowed(url, options.allowlist);
  for (const additionalAllowlist of options.additionalAllowlists ?? []) {
    if (additionalAllowlist.length > 0) {
      assertHostAllowed(url, additionalAllowlist);
    }
  }
  return fetchGuardedOnce(
    url,
    options.allowlist,
    {
      ...options.init,
      redirect: "manual",
      dnsLookup: options.dnsLookup,
    },
    resolveFetchBodyReadLimits(options),
  );
}

export function evaluateDangerousHostBypass(
  hostOrUrl: string,
  allowlist: string[],
): {
  blocked: boolean;
  shouldAudit: boolean;
  hostname: string;
  reason: string;
} {
  const decision = evaluateHostEgress(hostOrUrl, allowlist);
  if (decision.allowed) {
    return {
      blocked: false,
      shouldAudit: false,
      hostname: decision.hostname,
      reason: decision.reason,
    };
  }
  if (decision.approvalState === "blocked") {
    return {
      blocked: true,
      shouldAudit: false,
      hostname: decision.hostname,
      reason: decision.reason,
    };
  }
  return {
    blocked: false,
    shouldAudit: true,
    hostname: decision.hostname,
    reason: `Low-level bypass audit marker for public network target outside the allowlist: ${redactUrlForError(hostOrUrl)}`,
  };
}

export function assertHostAllowedInDangerProfile(hostOrUrl: string, allowlist: string[]): void {
  const decision = evaluateDangerousHostBypass(hostOrUrl, allowlist);
  if (decision.blocked) {
    throw new Error(decision.reason);
  }
}

function parseHost(hostOrUrl: string): { host: string; hostname: string; invalidReason?: string } {
  const trimmed = normalizeUrlAuthorityWhitespace(hostOrUrl.trim());
  if (!trimmed) {
    return { host: "", hostname: "" };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.host || parsed.hostname) {
      // SECURITY: when the URL contains an IPv6 host (`http://[fc00::1]/`),
      // the WHATWG URL parser keeps the brackets in `hostname`. Strip them
      // here so the IPv6 family detection in isPrivateOrReservedHost sees
      // `fc00::1` (which `isIP()` recognises) instead of `[fc00::1]` (which
      // it does not). Without this, every bracketed IPv6 form bypasses the
      // SSRF guard — including ULA, link-local, loopback, and IPv4-mapped
      // metadata addresses.
      return {
        host: parsed.host,
        hostname: stripIpv6Brackets(parsed.hostname),
      };
    }
    if (trimmed.includes("://")) {
      return invalidHost(hostOrUrl, "Host URL is malformed.");
    }
  } catch {
    if (trimmed.includes("://")) {
      const authority = trimmed.slice(trimmed.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
      if (/\s/.test(authority)) {
        return invalidHost(hostOrUrl, "Host contains invalid whitespace.");
      }
      return invalidHost(hostOrUrl, "Host URL is malformed.");
    }
  }

  const firstSlash = trimmed.indexOf("/");
  const withoutPath = firstSlash >= 0 ? trimmed.slice(0, firstSlash) : trimmed;

  if (withoutPath.startsWith("[")) {
    const end = withoutPath.indexOf("]");
    if (end > 0) {
      const host = withoutPath.slice(0, end + 1);
      const portSuffix = withoutPath.slice(end + 1);
      if (portSuffix && !/^:\d+$/.test(portSuffix)) {
        return invalidHost(hostOrUrl, "Host port is malformed.");
      }
      return {
        host: `${host}${portSuffix}`,
        hostname: withoutPath.slice(1, end),
      };
    }
  }

  if (/\s/.test(withoutPath)) {
    return invalidHost(hostOrUrl, "Host contains invalid whitespace.");
  }
  const colonCount = (withoutPath.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const parts = withoutPath.split(":");
    const hostname = parts[0]!;
    const port = parts[1]!;
    if (port && !/^\d+$/.test(port)) {
      return invalidHost(hostOrUrl, "Host port is malformed.");
    }
    if (isMalformedIpv4Literal(hostname)) {
      return invalidHost(hostOrUrl, "IPv4 host is malformed.");
    }
    return {
      host: withoutPath,
      hostname,
    };
  }

  if (isMalformedIpv4Literal(withoutPath)) {
    return invalidHost(hostOrUrl, "IPv4 host is malformed.");
  }

  return {
    host: withoutPath,
    hostname: withoutPath,
  };
}

function normalizeUrlAuthorityWhitespace(input: string): string {
  return input.replace(/^([a-z][a-z0-9+.-]*:)\s*\/\s*\/\s*/i, "$1//");
}

function invalidHost(input: string, reason: string): { host: string; hostname: string; invalidReason: string } {
  return {
    host: "",
    hostname: "",
    invalidReason: `${reason} ${redactUrlForError(input)}`,
  };
}

function isMalformedIpv4Literal(hostname: string): boolean {
  return /^\d+(?:\.\d+)+$/.test(hostname) && isIP(hostname) !== 4;
}

function matchesAllowlistPattern(candidate: string, pattern: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();

  if (!normalizedPattern.includes("*")) {
    return normalizedCandidate === normalizedPattern;
  }

  if (normalizedPattern === "*") {
    return true;
  }

  const segments = normalizedPattern.split("*");
  const firstSegment = segments[0]!;
  if (firstSegment && !normalizedCandidate.startsWith(firstSegment)) {
    return false;
  }
  let cursor = firstSegment.length;

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (!segment) {
      continue;
    }
    const nextIndex = normalizedCandidate.indexOf(segment, cursor);
    if (nextIndex < 0) {
      return false;
    }
    cursor = nextIndex + segment.length;
  }

  const lastSegment = segments[segments.length - 1]!;
  return !lastSegment || normalizedCandidate.endsWith(lastSegment);
}

function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (!lower) {
    return true;
  }
  if (DISALLOWED_HOSTS.has(lower)) {
    return true;
  }
  if (lower === "localhost" || lower.endsWith(".local")) {
    return true;
  }

  const ipVersion = isIP(lower);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(lower);
  }
  if (ipVersion === 6) {
    return isBlockedIpv6(lower);
  }
  return false;
}

async function fetchGuardedOnce(
  url: string,
  allowlist: string[],
  init: RequestInit & { dnsLookup?: DnsLookupFunction },
  bodyLimits: FetchBodyReadLimits,
): Promise<Response> {
  const { dnsLookup, ...fetchInit } = init;
  // PERF (POLICY-003): The guarded dispatcher is reused across requests that
  // share the same DNS-lookup function, target host:port, and allowlist
  // signature instead of being constructed per request. Each `Agent` carries
  // its own connection pool + keep-alive timers; rebuilding one on every HTTP
  // GET/POST, redirect hop, browser fallback, comms send, and ingestion fetch
  // churned handles/timers and defeated connection reuse on a long-lived
  // gateway. The guarded DNS lookup (DNS-rebinding defense) and every other
  // request option are preserved exactly — only the Agent lifecycle changes
  // from per-request to a bounded shared cache. The dispatcher is intentionally
  // NOT closed here: it is shared and long-lived. All callers buffer the
  // response body immediately (`res.text()/json()/arrayBuffer()`), so reuse is
  // safe; if streaming is added later, the body must be fully consumed before
  // the shared Agent is destroyed.
  const dispatcher = getGuardedDispatcher(url, allowlist, dnsLookup);
  const fetchImpl = (globalThis.fetch === DEFAULT_GLOBAL_FETCH
    ? undiciFetch
    : globalThis.fetch) as unknown as FetchWithDispatcher;
  try {
    const response = await fetchImpl(url, {
      ...fetchInit,
      dispatcher,
    });
    return wrapBoundedFetchResponse(response, bodyLimits);
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.includes("resolved address is blocked")) {
      throw cause;
    }
    throw redactFetchError(error);
  }
}

function redactFetchError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(redactSecretText(String(error)).value);
  }
  const redacted = new Error(redactSecretText(error.message).value);
  redacted.name = error.name;
  if (error.stack) {
    redacted.stack = redactSecretText(error.stack).value;
  }
  return redacted;
}

function resolveFetchBodyReadLimits(options: FetchAllowlistedOptions): FetchBodyReadLimits {
  return {
    maxBytes: normalizePositiveInteger(options.maxResponseBytes, DEFAULT_FETCH_MAX_RESPONSE_BYTES),
    timeoutMs: normalizePositiveInteger(options.bodyReadTimeoutMs, DEFAULT_FETCH_BODY_TIMEOUT_MS),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function wrapBoundedFetchResponse(response: Response, limits: FetchBodyReadLimits): Response {
  const boundedText = async () => new TextDecoder().decode(await readBoundedResponseArrayBuffer(response, limits));
  const boundedJson = async () => JSON.parse(await boundedText()) as unknown;
  const boundedArrayBuffer = async () => readBoundedResponseArrayBuffer(response, limits);

  return new Proxy(response, {
    get(target, property) {
      if (property === "text") {
        return boundedText;
      }
      if (property === "json") {
        return boundedJson;
      }
      if (property === "arrayBuffer") {
        return boundedArrayBuffer;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// SECURITY: sanctioned bounded-read path for callers that fetch a `Response`
// directly (i.e. bypass `fetchAllowlisted`, typically because the target is
// operator-configured trusted infra like a loopback embeddings server) but
// still must not buffer an unbounded body into memory.
export async function readBoundedResponseJson(response: Response, limits: FetchBodyReadLimits): Promise<unknown> {
  try {
    const buffer = await readBoundedResponseArrayBuffer(response, limits);
    return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("fetchAllowlisted blocked: ")) {
      throw new Error(error.message.slice("fetchAllowlisted blocked: ".length), { cause: error });
    }
    throw error;
  }
}

async function readBoundedResponseArrayBuffer(response: Response, limits: FetchBodyReadLimits): Promise<ArrayBuffer> {
  const body = response.body;
  if (!body) {
    return new ArrayBuffer(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
      reject(new Error("fetchAllowlisted blocked: response body read timed out"));
    }, limits.timeoutMs);
  });

  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeoutPromise]);
      if (result.done) {
        break;
      }
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > limits.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`fetchAllowlisted blocked: response body exceeded ${limits.maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (timedOut) {
      throw error;
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

// Bound on guarded Agents retained per DNS-lookup function. Distinct
// host:port + allowlist signatures each get their own Agent (so per-request
// security context is preserved); the bound prevents the cache itself from
// growing without limit on a long-lived process. When exceeded, the oldest
// entry is evicted and its Agent destroyed.
const MAX_GUARDED_DISPATCHERS_PER_LOOKUP = 64;

// `dnsLookup` is part of the Agent's behavioral signature (it drives the
// guarded resolution). Keying via a WeakMap lets per-test custom lookups be
// reclaimed with their closures and keeps the production node lookup on its own
// bucket without serializing function identity into a string key.
const guardedDispatcherCache = new WeakMap<DnsLookupFunction, Map<string, Dispatcher>>();

function getGuardedDispatcher(url: string, allowlist: string[], dnsLookup?: DnsLookupFunction): Dispatcher {
  const resolvedLookup = dnsLookup ?? nodeDnsLookup;
  const cacheKey = guardedDispatcherCacheKey(url, allowlist);
  if (cacheKey === undefined) {
    // Malformed/unparseable host (callers normally assert the host first, so
    // this is a defensive fallback): do not cache — fall back to a fresh,
    // request-scoped Agent to avoid an unbounded key space.
    return createGuardedDispatcher(url, allowlist, resolvedLookup);
  }
  let byKey = guardedDispatcherCache.get(resolvedLookup);
  if (!byKey) {
    byKey = new Map<string, Dispatcher>();
    guardedDispatcherCache.set(resolvedLookup, byKey);
  }
  const existing = byKey.get(cacheKey);
  if (existing) {
    return existing;
  }
  const dispatcher = createGuardedDispatcher(url, allowlist, resolvedLookup);
  byKey.set(cacheKey, dispatcher);
  if (byKey.size > MAX_GUARDED_DISPATCHERS_PER_LOOKUP) {
    const oldestKey = byKey.keys().next().value;
    if (oldestKey !== undefined) {
      const evicted = byKey.get(oldestKey);
      byKey.delete(oldestKey);
      void evicted?.close().catch(() => undefined);
    }
  }
  return dispatcher;
}

// The guarded lookup's behavior depends only on the target host:port and the
// allowlist (never the path/query), so requests that differ only by path reuse
// the same Agent. Returns `undefined` for hosts `parseHost` cannot resolve.
function guardedDispatcherCacheKey(url: string, allowlist: string[]): string | undefined {
  const parsed = parseHost(url);
  if (parsed.invalidReason) {
    return undefined;
  }
  const hostKey = (parsed.host || parsed.hostname).toLowerCase();
  if (!hostKey) {
    return undefined;
  }
  // A NUL byte cannot appear in a URL host or an allowlist pattern, so a NUL
  // separator keeps the host/allowlist boundary unambiguous even if a caller
  // supplies an unusual allowlist entry.
  const separator = String.fromCharCode(0);
  return `${hostKey}${separator}${allowlist.join(separator)}`;
}

function createGuardedDispatcher(url: string, allowlist: string[], dnsLookup?: DnsLookupFunction): Dispatcher {
  return new Agent({
    connect: {
      lookup: createGuardedDnsLookup(url, allowlist, dnsLookup ?? nodeDnsLookup),
    },
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}

export function createGuardedDnsLookup(
  hostOrUrl: string,
  allowlist: string[],
  dnsLookup: DnsLookupFunction = nodeDnsLookup,
): DnsLookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family);
        return;
      }
      const normalized = normalizeLookupCallbackResult(address, family, options);
      const blockedAddress = findBlockedResolvedAddress(hostOrUrl, allowlist, normalized.address);
      if (blockedAddress) {
        callback(
          new Error(`Private, metadata, or reserved resolved address is blocked: ${redactUrlForError(hostOrUrl)}`),
          normalized.address,
          normalized.family,
        );
        return;
      }
      callback(null, normalized.address, normalized.family);
    });
  };
}

function normalizeLookupCallbackResult(
  address: string | LookupAddress[],
  family: number | undefined,
  options: LookupOptions,
): { address: string | LookupAddress[]; family?: number } {
  if ((options as LookupOptions & { all?: boolean }).all) {
    return {
      address: Array.isArray(address) ? address : [{ address, family: family ?? inferAddressFamily(address) }],
    };
  }
  if (Array.isArray(address)) {
    const first = address[0];
    return {
      address: first?.address ?? "",
      family: first?.family,
    };
  }
  return {
    address,
    family: family ?? inferAddressFamily(address),
  };
}

function inferAddressFamily(address: string): number {
  const version = isIP(stripIpv6Brackets(address.toLowerCase()));
  return version === 4 || version === 6 ? version : 0;
}

function findBlockedResolvedAddress(
  hostOrUrl: string,
  allowlist: string[],
  address: string | LookupAddress[],
): string | undefined {
  const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
  return addresses.find(
    (candidate) =>
      isPrivateOrReservedHost(stripIpv6Brackets(candidate.toLowerCase())) &&
      !isResolvedLoopbackAllowed(hostOrUrl, allowlist, candidate),
  );
}

function isResolvedLoopbackAllowed(hostOrUrl: string, allowlist: string[], resolvedAddress: string): boolean {
  const parsed = parseHost(hostOrUrl);
  if (parsed.invalidReason) {
    return false;
  }
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const matchedPattern = allowlist.find(
    (pattern) => matchesAllowlistPattern(host, pattern) || matchesAllowlistPattern(hostname, pattern),
  );
  if (!matchedPattern || !isExplicitLoopbackPattern(matchedPattern, hostname)) {
    return false;
  }
  return isLoopbackAddress(resolvedAddress);
}

function isLoopbackAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.toLowerCase());
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1";
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  const [a = -1, b = -1, c = -1] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return true;
  }
  if (a === 192 && b === 88 && c === 99) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) {
    return true;
  }
  if (a === 203 && b === 0 && c === 113) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fec") ||
    lower.startsWith("fed") ||
    lower.startsWith("fee") ||
    lower.startsWith("fef") ||
    lower.startsWith("2001:db8:")
  ) {
    return true;
  }
  // IPv4-mapped IPv6 (RFC 4291) — `::ffff:a.b.c.d` or the canonical
  // `::ffff:hhhh:hhhh` Node normalizes IPv4 octets into. Recurse through the
  // IPv4 reserved-range check so an attacker cannot reach 169.254.169.254
  // (AWS metadata), 100.100.100.200 (Alibaba), or any RFC1918 host via the
  // IPv4-mapped IPv6 form.
  const mapped = extractIpv4MappedAddress(lower);
  if (mapped) {
    return isPrivateOrReservedIpv4(mapped);
  }
  return false;
}

function extractIpv4MappedAddress(ipv6Lower: string): string | undefined {
  // SECURITY (F-M6): a bare-host input is NOT canonicalised by `new URL()`, so
  // the IPv4-mapped prefix can arrive uncompressed (`0:0:0:0:0:ffff:…`) or
  // partially compressed in addition to the compressed `::ffff:…` form Node
  // emits. `isIP()` classifies all of them as family 6, so the bare-host SSRF
  // path would otherwise let `0:0:0:0:0:ffff:169.254.169.254` reach the cloud
  // metadata endpoint. Fold any leading run of all-zero groups before `ffff:`
  // down to the canonical `::ffff:` prefix before matching.
  const canonical = ipv6Lower.replace(/^(?:0{1,4}:){2,5}ffff:/, "::ffff:").replace(/^0{1,4}:ffff:/, "::ffff:");

  // Dotted-quad mapped form: `::ffff:169.254.169.254`
  const dottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(canonical);
  if (dottedMatch) {
    return dottedMatch[1];
  }
  // Hex-quad mapped form: `::ffff:a9fe:a9fe` (Node's canonical normalisation
  // of the dotted form, returned via `new URL().hostname`).
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (hexMatch) {
    const high = Number.parseInt(hexMatch[1] ?? "", 16);
    const low = Number.parseInt(hexMatch[2] ?? "", 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      const octet = (value: number, shift: number) => (value >>> shift) & 0xff;
      return [octet(high, 8), octet(high, 0), octet(low, 8), octet(low, 0)].join(".");
    }
  }
  return undefined;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isExplicitLoopbackPattern(pattern: string, hostname: string): boolean {
  const normalizedPattern = pattern.toLowerCase().trim();
  const normalizedHost = hostname.toLowerCase();
  if (normalizedHost === "localhost") {
    return normalizedPattern === "localhost" || normalizedPattern.startsWith("localhost:");
  }
  if (normalizedHost === "127.0.0.1") {
    return normalizedPattern === "127.0.0.1" || normalizedPattern.startsWith("127.0.0.1:");
  }
  if (normalizedHost === "::1") {
    return normalizedPattern === "::1" || normalizedPattern === "[::1]" || normalizedPattern.startsWith("[::1]:");
  }
  return false;
}
