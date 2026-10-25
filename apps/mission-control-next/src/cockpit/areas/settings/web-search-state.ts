import {
  DEFAULT_WEB_SEARCH_ENGINE_ORDER,
  WEB_SEARCH_NATIVE_ENGINES,
  isWebSearchEngineOrder,
  type ChangePlanRecord,
  type WebSearchNativeEngine,
} from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";

export const WEB_SEARCH_ANCHOR = "web-search";
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
 * The Gateway re-checks on save and on every tool call.
 */
export function isBaseUrlAllowlisted(baseUrl: string, allowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (isLocalHost(parsed.hostname) && parsed.port === "3002") return true;
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "*" || entry === host || entry === hostname) return true;
    return entry.startsWith("*.") && hostname.endsWith(entry.slice(1));
  });
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
