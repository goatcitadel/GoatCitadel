import {
  normalizeWebSearchEngineOrder,
  type ToolAccessEvaluateRequest,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import {
  assertNotPrivateOrReservedHost,
  isHostAllowed,
  isOfficialResearchSearchInvocation,
} from "@goatcitadel/policy-engine";
import type { WebRuntimeConfig } from "../config.js";

const BROWSER_READ_TOOLS = new Set(["browser.search", "browser.navigate", "browser.extract"]);

/**
 * Fills operator web defaults into browser and docs-ingest tool arguments: the Firecrawl backend
 * and its connection settings, and the native search engine order.
 *
 * A Firecrawl base URL outside the outbound allowlist (set through an environment variable or a
 * direct config edit, which skip the Settings guard) would make the policy engine block every
 * read. When the operator allows native fallback, reads use native instead. With fallback off,
 * Firecrawl stays selected so the block and its allowlist reason stay visible.
 *
 * A caller-supplied `firecrawlBaseUrl` or `firecrawlApiKeyEnv` is left in place only so the
 * policy engine can refuse it: the engine reads the endpoint from these settings through its
 * `resolveFirecrawlEndpoint` hook and blocks a call that names a different one.
 */
export function applyRuntimeBrowserBackendDefaults<TRequest extends ToolInvokeRequest | ToolAccessEvaluateRequest>(
  request: TRequest,
  web: WebRuntimeConfig,
  networkAllowlist: readonly string[],
): TRequest {
  if (!request.args || typeof request.args !== "object") {
    return request;
  }
  const firecrawl = web.firecrawl;
  const args = { ...request.args } as Record<string, unknown>;
  const explicitBackend = typeof args.backend === "string" ? args.backend.trim().toLowerCase() : undefined;
  const allowlisted = isFirecrawlBaseUrlAllowlisted(firecrawl.baseUrl, networkAllowlist);
  const rerouteToNative = firecrawl.enabled && !allowlisted && firecrawl.fallbackToNative;
  const firecrawlUsable = firecrawl.enabled && !rerouteToNative;

  if (BROWSER_READ_TOOLS.has(request.toolName)) {
    // The operator order always replaces a caller-supplied one: engines turned off stay off.
    if (request.toolName === "browser.search") {
      args.searchEngineOrder = normalizeWebSearchEngineOrder(web.search?.engineOrder);
    }
    // A model that picked Brave or Parallel (engine or providers) asked for the official search
    // backend; a Firecrawl default would turn that request into a Firecrawl one.
    if (request.toolName === "browser.search" && !explicitBackend && isOfficialResearchSearchInvocation(args)) {
      args.backend = "official";
      return { ...request, args };
    }
    if (!explicitBackend && firecrawlUsable) {
      args.backend = firecrawl.defaultReadBackend;
    }
    if (explicitBackend === "firecrawl" && rerouteToNative) {
      args.backend = "native";
    }
    const wantsFirecrawl =
      firecrawlUsable &&
      (explicitBackend === "firecrawl" || (!explicitBackend && firecrawl.defaultReadBackend === "firecrawl"));
    if (wantsFirecrawl) {
      args.firecrawlBaseUrl = args.firecrawlBaseUrl ?? firecrawl.baseUrl;
      args.firecrawlTimeoutMs = args.firecrawlTimeoutMs ?? firecrawl.timeoutMs;
      args.firecrawlApiKeyEnv = args.firecrawlApiKeyEnv ?? firecrawl.apiKeyEnv;
      args.firecrawlFallbackToNative = args.firecrawlFallbackToNative ?? firecrawl.fallbackToNative;
    }
    return { ...request, args };
  }

  if (request.toolName === "docs.ingest" && args.sourceType === "url") {
    const hasExplicitDocsBackend = args.backend !== undefined && args.backend !== null;
    if (!hasExplicitDocsBackend && firecrawlUsable && firecrawl.defaultReadBackend === "firecrawl") {
      args.backend = "firecrawl";
    }
    if (args.backend === "firecrawl" && rerouteToNative) {
      args.backend = "native";
    }
    if (args.backend === "firecrawl") {
      args.firecrawlBaseUrl = args.firecrawlBaseUrl ?? firecrawl.baseUrl;
      args.firecrawlTimeoutMs = args.firecrawlTimeoutMs ?? firecrawl.timeoutMs;
      args.firecrawlApiKeyEnv = args.firecrawlApiKeyEnv ?? firecrawl.apiKeyEnv;
    }
    return { ...request, args };
  }

  return request;
}

/**
 * Mirrors the policy engine: the canonical local port is always allowed; other hosts need the
 * allowlist and a public address, or an exact allowlist entry for a private LAN IPv4 host.
 */
export function isFirecrawlBaseUrlAllowlisted(baseUrl: string, networkAllowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if ((parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "3002") {
    return true;
  }
  if (!isHostAllowed(parsed.toString(), [...networkAllowlist])) return false;
  try {
    assertNotPrivateOrReservedHost(parsed.toString(), networkAllowlist);
    return true;
  } catch {
    return false;
  }
}
