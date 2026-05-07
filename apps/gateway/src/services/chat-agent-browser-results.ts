import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import type { McpBrowserFallbackTarget } from "./mcp-runtime.js";

const REMOTE_BLOCK_MARKERS = [
  "attention required!",
  "just a moment...",
  "you have been blocked",
  "security verification",
  "cloudflare ray id",
  "captcha",
  "enable javascript and cookies",
  "sorry, you have been blocked",
];

const SEARCH_RESULT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "lately",
  "latest",
  "me",
  "near",
  "news",
  "now",
  "of",
  "on",
  "recent",
  "recently",
  "right",
  "tell",
  "the",
  "today",
  "what",
  "whats",
  "what's",
  "with",
]);

const SEARCH_PORTAL_HOST_PATTERNS = [
  /^google\./i,
  /^www\.google\./i,
  /^bing\.com$/i,
  /^www\.bing\.com$/i,
  /^([a-z0-9-]+\.)?duckduckgo\.com$/i,
  /^search\.yahoo\.com$/i,
  /^www\.search\.yahoo\.com$/i,
];

const COMMUNITY_HOST_PATTERNS = [
  /(^|\.)reddit\.com$/i,
  /(^|\.)quora\.com$/i,
  /(^|\.)stackoverflow\.com$/i,
  /(^|\.)stackexchange\.com$/i,
];

const NEWS_PORTAL_HOST_PATTERNS = [
  /(^|\.)yahoo\.com$/i,
  /(^|\.)msn\.com$/i,
  /(^|\.)aol\.com$/i,
  /(^|\.)newsbreak\.com$/i,
];

const DIRECT_NEWS_PUBLISHER_HOST_PATTERNS = [
  /(^|\.)reuters\.com$/i,
  /(^|\.)apnews\.com$/i,
  /(^|\.)abcnews\.go\.com$/i,
  /(^|\.)abcnews\.com$/i,
  /(^|\.)nytimes\.com$/i,
  /(^|\.)wsj\.com$/i,
  /(^|\.)washingtonpost\.com$/i,
  /(^|\.)usatoday\.com$/i,
  /(^|\.)npr\.org$/i,
  /(^|\.)cnn\.com$/i,
  /(^|\.)foxnews\.com$/i,
  /(^|\.)cbsnews\.com$/i,
  /(^|\.)nbcnews\.com$/i,
  /(^|\.)bbc\.com$/i,
  /(^|\.)theguardian\.com$/i,
  /(^|\.)politico\.com$/i,
  /(^|\.)axios\.com$/i,
  /(^|\.)bloomberg\.com$/i,
];

const BROWSER_REUSE_INVALIDATING_TOOL_NAMES = new Set([
  "browser.navigate",
  "browser.extract",
  "browser.interact",
  "browser.cookies.get",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.get",
  "browser.storage.set",
  "browser.storage.clear",
  "browser.context.configure",
]);

export interface BrowserResultCandidate {
  url: string;
  title?: string;
  snippet?: string;
  hostname: string;
  path: string;
  sourceRunIndex: number;
}

export function withBrowserFallbackChain(
  result: Record<string, unknown>,
  fallbackChain: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (fallbackChain.length === 0) {
    return result;
  }
  return {
    ...result,
    fallbackChain: fallbackChain.map((entry) => ({ ...entry })),
  };
}

export function shouldAttemptBrowserFallback(toolName: string, failureClass?: string): boolean {
  if (!failureClass) {
    return false;
  }
  if (toolName === "browser.search") {
    return (
      failureClass === "no_results" ||
      failureClass === "remote_blocked" ||
      failureClass === "http_error" ||
      failureClass === "rate_limited" ||
      failureClass === "runtime_error"
    );
  }
  return (
    failureClass === "remote_blocked" ||
    failureClass === "http_error" ||
    failureClass === "unusable_output" ||
    failureClass === "runtime_error" ||
    failureClass === "rate_limited"
  );
}

export function resolveBrowserFallbackToolName(target: McpBrowserFallbackTarget, toolName: string): string | undefined {
  if (toolName === "browser.search") {
    return target.searchToolName;
  }
  if (toolName === "browser.navigate") {
    return target.navigateToolName ?? target.fetchToolName ?? target.extractToolName;
  }
  if (toolName === "browser.extract") {
    return target.extractToolName ?? target.fetchToolName ?? target.navigateToolName;
  }
  if (toolName === "http.get") {
    return target.fetchToolName ?? target.extractToolName ?? target.navigateToolName;
  }
  return undefined;
}

export function buildBrowserFallbackArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "browser.search") {
    return {
      query: args.query,
      maxResults: args.maxResults,
    };
  }
  return {
    url: args.url,
    maxChars: args.maxChars,
    timeoutMs: args.timeoutMs,
  };
}

export function buildBrowserFallbackChainEntry(input: {
  toolName: string;
  engineTier: string;
  engineLabel: string;
  result?: Record<string, unknown>;
  error?: string;
  browserFailureClass?: string;
  status: "executed" | "failed";
}): Record<string, unknown> {
  return {
    toolName: input.toolName,
    engineTier: input.engineTier,
    engineLabel: input.engineLabel,
    status: input.status,
    url: extractBrowserToolUrl(input.result),
    finalUrl: readFirstString(input.result?.finalUrl, input.result?.url),
    httpStatus: readBrowserStatusNumber(input.result?.status),
    browserFailureClass: input.browserFailureClass,
    error: input.error,
  };
}

export function normalizeBrowserToolResult(
  toolName: string,
  result: Record<string, unknown>,
  metadata: {
    engineTier: string;
    engineLabel: string;
  },
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...result,
    engineTier: metadata.engineTier,
    engineLabel: metadata.engineLabel,
  };
  if (toolName === "browser.search" && Array.isArray(result.results)) {
    normalized.results = result.results;
  }
  return normalized;
}

export function normalizeMcpBrowserToolResult(
  toolName: string,
  output: Record<string, unknown>,
  metadata: {
    engineTier: string;
    engineLabel: string;
    args: Record<string, unknown>;
  },
): Record<string, unknown> {
  const structured = output.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? (structured as Record<string, unknown>)
      : output;
  if (toolName === "browser.search") {
    const rawResults = Array.isArray(base.results) ? base.results : Array.isArray(output.results) ? output.results : [];
    return {
      ...base,
      ...output,
      results: rawResults,
      url: typeof base.url === "string" ? base.url : output.url,
      finalUrl: typeof base.finalUrl === "string" ? base.finalUrl : output.finalUrl,
      engineTier: metadata.engineTier,
      engineLabel: metadata.engineLabel,
    };
  }
  const textSnippet = readFirstString(
    base.textSnippet,
    base.bodySnippet,
    base.text,
    output.contentText,
    output.message,
  );
  const title = readFirstString(base.title, output.title);
  const finalUrl = readFirstString(base.finalUrl, output.finalUrl, base.url, output.url, metadata.args.url);
  return {
    ...base,
    ...output,
    url: readFirstString(base.url, output.url, metadata.args.url),
    finalUrl,
    title,
    textSnippet,
    status: readBrowserStatusNumber(base.status, output.status),
    engineTier: metadata.engineTier,
    engineLabel: metadata.engineLabel,
  };
}

export function classifyBrowserToolResult(
  toolName: string,
  result: Record<string, unknown> | undefined,
  error?: string,
): {
  failureClass?: string;
  error?: string;
} {
  if (error) {
    return {
      failureClass: "runtime_error",
      error,
    };
  }
  if (!result) {
    return {
      failureClass: "unusable_output",
      error: "browser result was empty",
    };
  }
  const status = readBrowserStatusNumber(result.status);
  const normalizedText = readBrowserResultText(result).toLowerCase();
  const errorText = (typeof result.error === "string" ? result.error : (error ?? "")).toLowerCase();
  if (status === 429 || errorText.includes("429") || errorText.includes("rate limit")) {
    return {
      failureClass: "rate_limited",
      error: buildRemoteBlockedMessage(status, undefined) || "rate limited by remote service",
    };
  }
  const remoteBlockMarker = REMOTE_BLOCK_MARKERS.find((marker) => normalizedText.includes(marker));
  if (status === 401 || status === 403 || remoteBlockMarker) {
    return {
      failureClass: "remote_blocked",
      error: buildRemoteBlockedMessage(status, remoteBlockMarker),
    };
  }
  if (typeof status === "number" && status >= 400) {
    return {
      failureClass: "http_error",
      error: `source returned HTTP ${status}`,
    };
  }
  if (toolName === "browser.search") {
    const results = Array.isArray(result.results) ? result.results : [];
    if (results.length === 0) {
      return {
        failureClass: "no_results",
        error: "no usable search results were returned",
      };
    }
    return {};
  }
  const hasUsefulText = normalizedText.length >= 40;
  const hasUsefulUrl = typeof result.finalUrl === "string" || typeof result.url === "string";
  if (!hasUsefulText && !hasUsefulUrl) {
    return {
      failureClass: "unusable_output",
      error: "browser result did not include usable page content",
    };
  }
  return {};
}

export function buildRemoteBlockedMessage(status?: number, marker?: string): string {
  const reason = marker?.includes("cloudflare")
    ? "Cloudflare"
    : marker?.includes("captcha")
      ? "captcha challenge"
      : marker?.includes("javascript")
        ? "browser challenge"
        : "automation block";
  if (typeof status === "number") {
    return `remote site blocked automation (${reason} ${status})`;
  }
  return `remote site blocked automation (${reason})`;
}

export function readBrowserResultText(result: Record<string, unknown>): string {
  return [
    readFirstString(result.title),
    readFirstString(result.textSnippet),
    readFirstString(result.bodySnippet),
    readFirstString(result.contentText),
    readFirstString(result.message),
  ]
    .filter(Boolean)
    .join(" ");
}

export function readBrowserStatusNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

export function extractBrowserToolUrl(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) {
    return undefined;
  }
  return readFirstString(result.finalUrl, result.url);
}

export function readFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function findReusableBrowserToolResult(
  toolName: string,
  rawArgs: Record<string, unknown>,
  args: Record<string, unknown>,
  priorToolRuns: ChatToolRunRecord[] | undefined,
): ChatToolRunRecord | undefined {
  const normalizedToolName = normalizeToolNameForComparison(toolName);
  const bypassCacheRequested =
    isTruthyBypassCacheFlag(rawArgs.bypassCache) || isTruthyBypassCacheFlag(args.bypassCache);
  if (bypassCacheRequested) {
    return undefined;
  }
  if (!priorToolRuns || priorToolRuns.length === 0) {
    return undefined;
  }
  if (toolName !== "http.get" && toolName !== "browser.navigate" && toolName !== "browser.extract") {
    if (
      normalizedToolName !== "http.get" &&
      normalizedToolName !== "browser.navigate" &&
      normalizedToolName !== "browser.extract"
    ) {
      return undefined;
    }
  }
  if (typeof rawArgs.url !== "string" || rawArgs.url.trim().length === 0) {
    return undefined;
  }
  const requestedUrl = normalizeBrowserReuseUrl(typeof args.url === "string" ? args.url : undefined);
  if (!requestedUrl) {
    return undefined;
  }
  if (normalizedToolName === "browser.navigate") {
    return findReusableRecentBrowserNavigateResult(requestedUrl, priorToolRuns);
  }
  if (normalizedToolName === "browser.extract") {
    return findReusableRecentBrowserExtractResult(requestedUrl, priorToolRuns);
  }
  for (let index = priorToolRuns.length - 1; index >= 0; index -= 1) {
    const run = priorToolRuns[index];
    if (
      !run ||
      normalizeToolNameForComparison(run.toolName) !== normalizedToolName ||
      run.status !== "executed" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const resolvedUrl = normalizeBrowserReuseUrl(
      extractUsefulVisitedBrowserUrl(result) ??
        extractBrowserToolUrl(result) ??
        (typeof run.args?.url === "string" ? run.args.url : undefined),
    );
    if (!resolvedUrl || resolvedUrl !== requestedUrl) {
      continue;
    }
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      continue;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      continue;
    }
    const usefulText = normalizeRecoveredContentText(
      readFirstString(result.textSnippet, result.bodySnippet, result.contentText, result.text, result.message),
    );
    if (!usefulText) {
      continue;
    }
    return run;
  }
  return undefined;
}

function isTruthyBypassCacheFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return false;
}

function findReusableRecentBrowserExtractResult(
  requestedUrl: string,
  priorToolRuns: ChatToolRunRecord[],
): ChatToolRunRecord | undefined {
  for (let index = priorToolRuns.length - 1; index >= 0; index -= 1) {
    const run = priorToolRuns[index];
    if (!run || run.status !== "executed") {
      continue;
    }
    if (!BROWSER_REUSE_INVALIDATING_TOOL_NAMES.has(run.toolName)) {
      if (!BROWSER_REUSE_INVALIDATING_TOOL_NAMES.has(normalizeToolNameForComparison(run.toolName) ?? "")) {
        continue;
      }
    }
    if (
      normalizeToolNameForComparison(run.toolName) !== "browser.navigate" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      return undefined;
    }
    const result = run.result as Record<string, unknown>;
    const resolvedUrl = normalizeBrowserReuseUrl(
      extractUsefulVisitedBrowserUrl(result) ??
        extractBrowserToolUrl(result) ??
        (typeof run.args?.url === "string" ? run.args.url : undefined),
    );
    if (!resolvedUrl || resolvedUrl !== requestedUrl) {
      return undefined;
    }
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      return undefined;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      return undefined;
    }
    const usefulText = normalizeRecoveredContentText(
      readFirstString(result.contentText, result.text, result.bodySnippet, result.textSnippet, result.message),
    );
    if (!usefulText || usefulText.length < 160) {
      return undefined;
    }
    return run;
  }
  return undefined;
}

function findReusableRecentBrowserNavigateResult(
  requestedUrl: string,
  priorToolRuns: ChatToolRunRecord[],
): ChatToolRunRecord | undefined {
  for (let index = priorToolRuns.length - 1; index >= 0; index -= 1) {
    const run = priorToolRuns[index];
    if (!run || run.status !== "executed") {
      continue;
    }
    if (!BROWSER_REUSE_INVALIDATING_TOOL_NAMES.has(normalizeToolNameForComparison(run.toolName) ?? "")) {
      continue;
    }
    if (
      normalizeToolNameForComparison(run.toolName) !== "browser.navigate" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      return undefined;
    }
    const result = run.result as Record<string, unknown>;
    const resolvedUrl = normalizeBrowserReuseUrl(
      extractUsefulVisitedBrowserUrl(result) ??
        extractBrowserToolUrl(result) ??
        (typeof run.args?.url === "string" ? run.args.url : undefined),
    );
    if (!resolvedUrl || resolvedUrl !== requestedUrl) {
      return undefined;
    }
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      return undefined;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      return undefined;
    }
    const usefulText = normalizeRecoveredContentText(
      readFirstString(result.contentText, result.text, result.bodySnippet, result.textSnippet, result.message),
    );
    if (!usefulText) {
      return undefined;
    }
    return run;
  }
  return undefined;
}

export function inferRecentBrowserVisitedUrl(toolRuns: ChatToolRunRecord[]): string | undefined {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (!run || run.status !== "executed" || !run.result || typeof run.result !== "object") {
      continue;
    }
    const usefulUrl = extractUsefulVisitedBrowserUrl(run.result as Record<string, unknown>);
    if (usefulUrl) {
      return usefulUrl;
    }
  }
  return undefined;
}

export function hasUsefulVisitedBrowserUrl(run: ChatToolRunRecord): boolean {
  return Boolean(
    run.result &&
    typeof run.result === "object" &&
    extractUsefulVisitedBrowserUrl(run.result as Record<string, unknown>),
  );
}

export function extractUsefulVisitedBrowserUrl(result: Record<string, unknown>): string | undefined {
  const candidateValues = [result.finalUrl, result.url];
  for (const value of candidateValues) {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
      continue;
    }
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (isSearchPortalHost(hostname) || isLikelyLandingOrResultsPath(pathname)) {
        continue;
      }
      return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function normalizeBrowserReuseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function tokenizeBrowserSearchText(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !SEARCH_RESULT_STOPWORDS.has(token));
  return [...new Set(tokens)];
}

export function normalizeBrowserSearchText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeToolNameForComparison(toolName: string | undefined): string | undefined {
  if (typeof toolName !== "string") {
    return undefined;
  }
  if (toolName.includes(".")) {
    return toolName;
  }
  const firstSeparator = toolName.indexOf("_");
  if (firstSeparator < 0) {
    return toolName;
  }
  return `${toolName.slice(0, firstSeparator)}.${toolName.slice(firstSeparator + 1)}`;
}

export function buildToolNameComparisonAliases(toolName: string | undefined): Set<string> {
  const aliases = new Set<string>();
  const normalized = normalizeToolNameForComparison(toolName)?.toLowerCase();
  if (!normalized) {
    return aliases;
  }
  aliases.add(normalized);
  aliases.add(normalized.replace(/\./g, "_"));
  aliases.add(normalized.replace(/_/g, "."));
  return aliases;
}

export function toolNameMatchesUsedToolSet(expectedToolName: string, usedToolNames: Set<string>): boolean {
  for (const alias of buildToolNameComparisonAliases(expectedToolName)) {
    if (usedToolNames.has(alias)) {
      return true;
    }
  }
  return false;
}

export function toolNameMatchesAnyKnownTool(toolName: string | undefined, expectedToolNames: Set<string>): boolean {
  const aliases = buildToolNameComparisonAliases(toolName);
  for (const expected of expectedToolNames) {
    for (const alias of buildToolNameComparisonAliases(expected)) {
      if (aliases.has(alias)) {
        return true;
      }
    }
  }
  return false;
}

export function isSearchPortalHost(hostname: string): boolean {
  return SEARCH_PORTAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

export function isLikelyLandingOrResultsPath(pathname: string): boolean {
  return /\/(search|results|topics|topic|tag|tags)(\/|$)/i.test(pathname);
}

export function isLikelyCommunityHost(hostname: string): boolean {
  return COMMUNITY_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

export function isLikelyNewsPortalHost(hostname: string): boolean {
  return NEWS_PORTAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

export function isLikelyDirectNewsPublisherHost(hostname: string): boolean {
  return DIRECT_NEWS_PUBLISHER_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

export function queryExplicitlyRequestsCommunitySources(value: string): boolean {
  return /\b(reddit|quora|stack ?overflow|stackexchange|forum|forums|community|communities|discussion|discussions)\b/i.test(
    value,
  );
}

export function isLikelyNewsOrCurrentEventsQuery(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /\b(latest|today|right now|news|recent|recently|lately)\b/.test(normalized) ||
    /\bcurrent\s+(news|events|headlines?|score|scores|markets?)\b/.test(normalized) ||
    normalized.includes("what's going on with") ||
    normalized.includes("whats going on with")
  );
}

export function queryExplicitlyRequestsUseCases(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\b(use case|use cases|used for|top\s+\d+\s+uses?|ways?\s+.*\bused|applications?)\b/.test(normalized);
}

export function scoreBrowserResultCandidate(
  candidate: BrowserResultCandidate,
  query: string,
  queryTokens: string[],
  options: {
    newsLike: boolean;
    preferDirectNewsPublisher: boolean;
  },
): number {
  const { newsLike, preferDirectNewsPublisher } = options;
  const normalizedTitle = normalizeBrowserSearchText(candidate.title);
  const normalizedSnippet = normalizeBrowserSearchText(candidate.snippet);
  const normalizedPath = normalizeBrowserSearchText(candidate.path);
  const normalizedQuery = normalizeBrowserSearchText(query);
  const useCaseIntent = queryExplicitlyRequestsUseCases(query);
  const titleMatches = countMatchingQueryTokens(normalizedTitle, queryTokens);
  const snippetMatches = countMatchingQueryTokens(normalizedSnippet, queryTokens);
  const pathMatches = countMatchingQueryTokens(normalizedPath, queryTokens);
  let score = 0;
  if (normalizedQuery.length >= 8 && normalizedTitle.includes(normalizedQuery)) {
    score += 5;
  }
  if (titleMatches >= 2) {
    score += 5;
  } else if (titleMatches === 1) {
    score += 2;
  }
  if (snippetMatches >= 2) {
    score += 3;
  } else if (snippetMatches === 1) {
    score += 1;
  }
  if (pathMatches >= 2) {
    score += 2;
  } else if (pathMatches === 1) {
    score += 1;
  }
  if (!candidate.title && !candidate.snippet) {
    score -= 3;
  }
  if (isSearchPortalHost(candidate.hostname)) {
    score -= 5;
  }
  if (isLikelyLandingOrResultsPath(candidate.path)) {
    score -= 2;
  }
  if (!newsLike && isLikelyCommunityHost(candidate.hostname) && !queryExplicitlyRequestsCommunitySources(query)) {
    score -= 6;
  }
  if (useCaseIntent) {
    const title = candidate.title ?? "";
    const snippet = candidate.snippet ?? "";
    const exactUseCaseTitle = /\b(use case|use cases)\b/i.test(title);
    const useCaseTitle =
      /\b(use case|use cases|used for|applications?|examples?|real[- ]world|in practice|commonly used|widely used)\b/i.test(
        title,
      );
    const useCaseSnippet =
      /\b(use case|use cases|used for|applications?|examples?|commonly used|widely used|integrations?|automation|workflows?|web and mobile|mobile and web|partner api|partner apis|third-party services?)\b/i.test(
        snippet,
      );
    const definitionTitle =
      /\b(what is|benefits?|definition|basics?|principles?|architectural style|http methods?)\b/i.test(title);
    const definitionSnippet = /\b(what is|benefits?|architectural style|http requests?|crud|data formats?)\b/i.test(
      snippet,
    );
    const definitionPath = /\/definition(\/|$)|\/discover\/what-is|\/what-is[-/]/i.test(candidate.path);

    if (exactUseCaseTitle) {
      score += 11;
    } else if (useCaseTitle) {
      score += 5;
    }
    if (useCaseSnippet) {
      score += 7;
    }
    if (/\/guide(\/|$)/i.test(candidate.path)) {
      score += 2;
    }
    if (definitionTitle && !exactUseCaseTitle) {
      score -= 6;
    }
    if (definitionSnippet && !useCaseSnippet) {
      score -= 4;
    }
    if (definitionPath) {
      score -= 9;
    }
  }
  if (newsLike) {
    if (
      /\/(news|politics|article|story)(\/|$)/i.test(candidate.path) ||
      /\b(news|times|post|reuters|apnews|axios|politico|npr|cnn|abc|nbc|cbs|fox)\b/i.test(candidate.hostname)
    ) {
      score += 2;
    }
    if (isLikelyDirectNewsPublisherHost(candidate.hostname)) {
      score += 3;
    }
    if (preferDirectNewsPublisher && isLikelyNewsPortalHost(candidate.hostname)) {
      score -= 4;
    }
  } else if (!isSearchPortalHost(candidate.hostname)) {
    score += 1;
  }
  score -= candidate.sourceRunIndex * 0.001;
  return score;
}

function countMatchingQueryTokens(haystack: string, queryTokens: string[]): number {
  if (!haystack || queryTokens.length === 0) {
    return 0;
  }
  return queryTokens.reduce((count, token) => (haystack.includes(token) ? count + 1 : count), 0);
}

export function normalizeRecoveredContentText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  return normalized || undefined;
}
