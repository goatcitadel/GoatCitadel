import {
  DEFAULT_WEB_SEARCH_ENGINE_ORDER,
  WEB_SEARCH_NATIVE_ENGINES,
  isWebSearchEngineOrder,
  type ChangePlanRecord,
  type WebSearchCredentialTargetId,
  type WebSearchNativeEngine,
} from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";

export const WEB_SEARCH_ANCHOR = "web-search";
const WEB_SEARCH_KEY_ANCHOR_PREFIX = "web-search-key-";

/** The anchor of one key's row in Web & Search ("search.brave" becomes "web-search-key-brave"). */
export function webSearchKeyAnchor(targetId: WebSearchCredentialTargetId): string {
  return `${WEB_SEARCH_KEY_ANCHOR_PREFIX}${targetId.slice("search.".length)}`;
}

export function isWebSearchKeyAnchor(hash: string): boolean {
  return (["search.firecrawl", "search.brave", "search.parallel"] as const).some(
    (targetId) => webSearchKeyAnchor(targetId) === hash,
  );
}

export const HOSTED_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
export const LOCAL_FIRECRAWL_BASE_URL = "http://127.0.0.1:3002";

export const ENGINE_LABELS: Readonly<Record<WebSearchNativeEngine, string>> = {
  duckduckgo: "DuckDuckGo",
  bing: "Bing",
  google: "Google",
};

/** The governed draft hook holds string values, so the engine order travels as "duckduckgo,bing". */
export function encodeEngineOrder(order: readonly WebSearchNativeEngine[]): string {
  return order.join(",");
}

export function decodeEngineOrder(value: string): WebSearchNativeEngine[] {
  const order = value.split(",").filter(Boolean);
  return isWebSearchEngineOrder(order) ? [...order] : [...DEFAULT_WEB_SEARCH_ENGINE_ORDER];
}

export function readEngineOrder(settings: RuntimeSettingsResponse): string | undefined {
  const order = settings.web?.search?.engineOrder;
  return isWebSearchEngineOrder(order) ? encodeEngineOrder(order) : undefined;
}

/** Rows for the order editor: enabled engines in order, then the disabled ones. */
export function engineRows(order: readonly WebSearchNativeEngine[]) {
  const disabled = WEB_SEARCH_NATIVE_ENGINES.filter((engine) => !order.includes(engine));
  return [
    ...order.map((engine, index) => ({ engine, enabled: true, position: index })),
    ...disabled.map((engine) => ({ engine, enabled: false, position: -1 })),
  ];
}

export function toggleEngine(order: readonly WebSearchNativeEngine[], engine: WebSearchNativeEngine) {
  if (!order.includes(engine)) return [...order, engine];
  // At least one engine stays on: native search needs somewhere to go.
  return order.length > 1 ? order.filter((item) => item !== engine) : [...order];
}

export function moveEngine(order: readonly WebSearchNativeEngine[], engine: WebSearchNativeEngine, delta: -1 | 1) {
  const index = order.indexOf(engine);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return [...order];
  const next = [...order];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function describeEngineOrder(order: readonly WebSearchNativeEngine[]): string {
  const [first, ...rest] = order.map((engine) => ENGINE_LABELS[engine]);
  return rest.length ? `${first}, then ${rest.join(", then ")}` : `${first} only`;
}

export const matchesEngineOrderPlan = (plan: ChangePlanRecord, submitted: string) =>
  plan.request.kind === "runtime_configuration" &&
  plan.request.change.operation === "web_search_configuration" &&
  encodeEngineOrder(plan.request.change.config.engineOrder) === submitted &&
  plan.target.ownerId === "runtime_settings";

export interface FirecrawlDraft {
  enabled: boolean;
  baseUrl: string;
  defaultReadBackend: "native" | "firecrawl";
  fallbackToNative: boolean;
  timeoutMs: number;
}

/** Stable string form, so the governed draft hook can compare and persist the whole form. */
export function encodeFirecrawlDraft(draft: FirecrawlDraft): string {
  return JSON.stringify([
    draft.enabled,
    draft.baseUrl,
    draft.defaultReadBackend,
    draft.fallbackToNative,
    draft.timeoutMs,
  ]);
}

export function decodeFirecrawlDraft(value: string): FirecrawlDraft {
  const [enabled, baseUrl, defaultReadBackend, fallbackToNative, timeoutMs] = JSON.parse(value) as [
    boolean,
    string,
    "native" | "firecrawl",
    boolean,
    number,
  ];
  return { enabled, baseUrl, defaultReadBackend, fallbackToNative, timeoutMs };
}

export function readFirecrawlDraft(settings: RuntimeSettingsResponse): string | undefined {
  const firecrawl = settings.web?.firecrawl;
  if (!firecrawl || typeof firecrawl.baseUrl !== "string") return undefined;
  return encodeFirecrawlDraft({
    enabled: firecrawl.enabled,
    baseUrl: firecrawl.baseUrl,
    defaultReadBackend: firecrawl.defaultReadBackend,
    fallbackToNative: firecrawl.fallbackToNative,
    timeoutMs: firecrawl.timeoutMs,
  });
}

export const matchesFirecrawlPlan = (plan: ChangePlanRecord, submitted: string) => {
  if (plan.request.kind !== "runtime_configuration") return false;
  const change = plan.request.change;
  if (change.operation !== "web_firecrawl_configuration") return false;
  const draft = decodeFirecrawlDraft(submitted);
  return change.config.enabled === draft.enabled && change.config.baseUrl === draft.baseUrl;
};

export function firecrawlUrlProblem(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Use an http or https URL.";
    if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname) && !isLanIpv4(parsed.hostname)) {
      return "Use https for a remote Firecrawl.";
    }
    return undefined;
  } catch {
    return "Enter a full URL, for example https://api.firecrawl.dev.";
  }
}

export function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Client-side preview of the Gateway allowlist check, used only to offer the "add host" step.
 * The Gateway re-checks on save and on every tool call. Like the Gateway, a loopback or private LAN address passes
 * only by an exact host and port entry; a hostname-only entry or a wildcard does not cover it. A channel bridge
 * keeps its own looser reading, so it asks with `hostOnlyEntriesCoverPrivate`.
 */
export function isBaseUrlAllowlisted(
  baseUrl: string,
  allowlist: readonly string[],
  options: { hostOnlyEntriesCoverPrivate?: boolean } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (isLocalHost(parsed.hostname) && parsed.port === "3002") return true;
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  // The Gateway always refuses these for a service address, listed or not (a channel bridge keeps its own reading).
  if (!options.hostOnlyEntriesCoverPrivate && isReservedHost(hostname)) return false;
  if (!options.hostOnlyEntriesCoverPrivate && (isLocalHost(hostname) || isLanIpv4(hostname))) {
    return allowlist.some((raw) => raw.trim().toLowerCase() === host);
  }
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "*" || entry === host || entry === hostname) return true;
    return entry.startsWith("*.") && hostname.endsWith(entry.slice(1));
  });
}

/** Whether this exact host and port is already an entry in the allowlist. */
function isListedExactly(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((raw) => raw.trim().toLowerCase() === host);
}

/**
 * Why the Gateway refuses the address: "not_listed" (adding it can help), "reserved" (a private or reserved address it
 * never allows for this service) or "refused" (listed, and refused for a reason this page cannot name).
 */
export type FirecrawlGapCause = "not_listed" | "reserved" | "refused";

/**
 * Where the Firecrawl page says the Gateway refuses the address, and which host the add button would add. The cause is
 * "refused" when adding cannot help: the host is already listed, or it is a private or reserved address the Gateway
 * does not allow for this service.
 */
export function firecrawlAllowlistGap(input: {
  draft: FirecrawlDraft;
  saved?: { enabled: boolean; baseUrl: string; baseUrlAllowlisted?: boolean };
  allowlist: readonly string[];
  draftDirty: boolean;
  lastCheck?: "ok" | "reachable" | "unauthorized" | "unreachable" | "blocked";
}): { host: string; source: "draft" | "gateway"; cause: FirecrawlGapCause } | undefined {
  const { draft, saved, allowlist, draftDirty, lastCheck } = input;
  const causeOf = (baseUrl: string, host: string): FirecrawlGapCause =>
    isReservedHost(hostnameOf(baseUrl)) ? "reserved" : isListedExactly(host, allowlist) ? "refused" : "not_listed";
  if (draftDirty) {
    const host = hostOf(draft.baseUrl);
    if (!host || !draft.enabled || firecrawlUrlProblem(draft.baseUrl)) return undefined;
    return isBaseUrlAllowlisted(draft.baseUrl, allowlist)
      ? undefined
      : { host, source: "draft", cause: causeOf(draft.baseUrl, host) };
  }
  if (!saved?.enabled) return undefined;
  const refused = saved.baseUrlAllowlisted === false || lastCheck === "blocked";
  const host = hostOf(saved.baseUrl);
  return refused && host ? { host, source: "gateway", cause: causeOf(saved.baseUrl, host) } : undefined;
}

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Addresses the Gateway never allows for a service address, whatever the allowlist says: localhost and any 127.x (the
 * canonical local port is accepted before this is asked), IPv6 loopback, unspecified, link-local, site-local, private,
 * documentation and multicast ranges, `.local` names and the cloud-metadata host, 169.254.x, the documentation and
 * relay IPv4 ranges and other reserved IPv4. An IPv4-mapped IPv6 address is judged by its IPv4 part.
 */
function isReservedHost(hostname: string): boolean {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname === "metadata.google.internal") {
    return true;
  }
  if (hostname.startsWith("[")) return isReservedIpv6(hostname.slice(1, -1));
  return isReservedIpv4(hostname);
}

function isReservedIpv6(inner: string): boolean {
  const mapped = mappedIpv4(inner);
  if (mapped) return isReservedIpv4(mapped) || isLanIpv4(mapped);
  return (
    inner === "::1" || inner === "::" || /^(fe[89abcdef]|f[cd]|ff)/u.test(inner) || /^2001:0?db8(:|$)/u.test(inner)
  );
}

/** The IPv4 address inside `::ffff:a.b.c.d` or its hex form `::ffff:hhhh:hhhh` (how a URL spells it), if it is one. */
function mappedIpv4(inner: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(inner);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(inner);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function isReservedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) return false;
  const [a = -1, b = -1, c = -1] = parts.map(Number);
  return (
    hostname === "100.100.100.200" ||
    a === 0 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/** A self-hosted Firecrawl on the LAN usually serves plain http; the Gateway allows it only by an exact allowlist entry. */
function isLanIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) return false;
  const [a = -1, b = -1] = parts.map(Number);
  // 100.100.100.200 is a cloud-metadata address the Gateway always blocks.
  return (
    hostname !== "100.100.100.200" &&
    (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
  );
}
