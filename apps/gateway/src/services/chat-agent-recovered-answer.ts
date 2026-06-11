import type { ChatToolRunRecord, ChatWebMode } from "@goatcitadel/contracts";
import {
  extractBrowserToolUrl,
  extractUsefulVisitedBrowserUrl,
  normalizeRecoveredContentText,
  queryExplicitlyRequestsUseCases,
  readBrowserStatusNumber,
  readFirstString,
  toolNameMatchesAnyKnownTool,
} from "./chat-agent-browser-results.js";
import {
  looksLikePromptLabConcreteFileCandidate,
  normalizePromptLabFilePath,
  selectPromptLabConcreteReadPathsFromSearchResult,
} from "./chat-agent-prompt-lab-evidence.js";

export function inferBlockedSourceFailure(
  toolRuns: ChatToolRunRecord[],
): { host?: string; failureClass: string } | undefined {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (!run?.result || typeof run.result !== "object") {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const topLevelFailure = readBlockedSourceFailure(result);
    if (topLevelFailure) {
      return {
        host: readBlockedSourceHost(result, run.args),
        failureClass: topLevelFailure,
      };
    }
    const fallbackChain = Array.isArray(result.fallbackChain) ? result.fallbackChain : [];
    for (let chainIndex = fallbackChain.length - 1; chainIndex >= 0; chainIndex -= 1) {
      const entry = fallbackChain[chainIndex];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const failureClass = readBlockedSourceFailure(record);
      if (!failureClass) {
        continue;
      }
      return {
        host: readBlockedSourceHost(record),
        failureClass,
      };
    }
  }
  return undefined;
}

function readBlockedSourceFailure(result: Record<string, unknown>): string | undefined {
  const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
  if (failureClass === "remote_blocked" || failureClass === "http_error") {
    return failureClass;
  }
  return undefined;
}

export function readBlockedSourceHost(
  result: Record<string, unknown>,
  args?: Record<string, unknown>,
): string | undefined {
  const url = extractBrowserToolUrl(result) ?? (typeof args?.url === "string" ? args.url : undefined);
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function collectObservedToolEvidencePaths(toolRuns: ChatToolRunRecord[]): string[] {
  const observed = new Map<string, { path: string; score: number }>();
  const add = (value: unknown, score: number): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = normalizePromptLabFilePath(value);
    if (!normalized || !looksLikePromptLabConcreteFileCandidate(normalized)) {
      return;
    }
    const key = normalized.toLowerCase();
    const current = observed.get(key);
    if (!current || score > current.score) {
      observed.set(key, { path: normalized, score });
    }
  };
  for (const run of toolRuns) {
    const isConcreteRead = toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"]));
    add(run.args?.path, isConcreteRead ? 100 : 30);
    const result = run.result as Record<string, unknown> | undefined;
    add(result?.path, isConcreteRead ? 110 : 35);
    if (Array.isArray(result?.matches)) {
      const selectedMatchPaths = selectPromptLabConcreteReadPathsFromSearchResult(result);
      let rank = selectedMatchPaths.length;
      for (const matchPath of selectedMatchPaths) {
        add(matchPath, 80 + rank);
        rank -= 1;
      }
    }
  }
  return [...observed.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((entry) => entry.path)
    .slice(0, 8);
}

export function recoverTitleUrlItems(
  toolRuns: ChatToolRunRecord[],
  limit: number,
): Array<{ title: string | null; url: string }> {
  const items: Array<{ title: string | null; url: string }> = [];
  const seen = new Set<string>();
  for (const run of toolRuns) {
    const result = run.result;
    if (!result || typeof result !== "object") {
      continue;
    }
    collectTitleUrlPairs(result as Record<string, unknown>, items, seen, limit);
    if (items.length >= limit) {
      break;
    }
  }
  return items.slice(0, limit);
}

function collectTitleUrlPairs(
  node: unknown,
  out: Array<{ title: string | null; url: string }>,
  seen: Set<string>,
  limit: number,
): void {
  if (out.length >= limit || node === null || node === undefined) {
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectTitleUrlPairs(entry, out, seen, limit);
      if (out.length >= limit) {
        return;
      }
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : typeof record.href === "string" ? record.href : undefined;
  if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
    seen.add(url);
    out.push({
      title: typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : null,
      url,
    });
    if (out.length >= limit) {
      return;
    }
  }
  for (const value of Object.values(record)) {
    collectTitleUrlPairs(value, out, seen, limit);
    if (out.length >= limit) {
      return;
    }
  }
}

export function buildFetchedContentBudgetFallback(
  webMode: ChatWebMode,
  toolRuns: ChatToolRunRecord[],
  userPrompt: string,
): string | undefined {
  return buildRecoveredEvidenceAnswer(userPrompt, toolRuns, {
    note:
      webMode === "deep"
        ? "This is a partial answer recovered before the deep pass finished."
        : "This is a partial answer recovered before the turn hit its response budget.",
  });
}

export function buildSearchResultBudgetFallback(
  webMode: ChatWebMode,
  toolRuns: ChatToolRunRecord[],
): string | undefined {
  const recoveredItems = recoverTitleUrlItems(toolRuns, 5);
  if (recoveredItems.length === 0) {
    return undefined;
  }
  const blockedSource = inferBlockedSourceFailure(toolRuns);
  const lines = [
    blockedSource
      ? `A source blocked automated browsing${blockedSource.host ? ` on ${blockedSource.host}` : ""}, so I’m falling back to the strongest leads I recovered so far:`
      : webMode === "deep"
        ? "I ran out of time before I could finish the full deep-research pass, but these look like the strongest leads so far:"
        : "I ran out of time before I could finish a full pass, but these look like the strongest leads so far:",
    "",
    ...recoveredItems.slice(0, 3).map((item, index) => `${index + 1}. ${formatRecoveredSearchLead(item)}`),
    "",
    webMode === "deep"
      ? "If you want, ask me to continue from these results and narrow them down."
      : "If you want, ask me to continue from these results and narrow them down, or retry in Deep mode for a slower pass.",
  ];
  return lines.join("\n");
}

interface RecoveredFetchedContentEvidence {
  title?: string;
  url?: string;
  text: string;
}

function recoverFetchedContentEvidence(toolRuns: ChatToolRunRecord[]): RecoveredFetchedContentEvidence | undefined {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (
      !run ||
      run.status !== "executed" ||
      !run.result ||
      typeof run.result !== "object" ||
      (run.toolName !== "browser.navigate" && run.toolName !== "browser.extract" && run.toolName !== "http.get")
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (failureClass && failureClass !== "no_results") {
      continue;
    }
    const status = readBrowserStatusNumber(result.status);
    if (typeof status === "number" && status >= 400) {
      continue;
    }
    const text = normalizeRecoveredContentText(
      readFirstString(result.contentText, result.text, result.bodySnippet, result.textSnippet, result.message),
    );
    if (!text || text.length < 80) {
      continue;
    }
    return {
      title: readFirstString(result.title),
      url: extractUsefulVisitedBrowserUrl(result) ?? extractBrowserToolUrl(result),
      text,
    };
  }
  return undefined;
}

const RECOVERED_CONTENT_PROMPT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "find",
  "for",
  "how",
  "i",
  "into",
  "is",
  "me",
  "of",
  "online",
  "out",
  "please",
  "tell",
  "that",
  "the",
  "top",
  "what",
  "with",
]);

const RECOVERED_CONTENT_BOILERPLATE_PATTERNS = [
  /\bthis website uses cookies\b/i,
  /\blearn more got it\b/i,
  /\bskip to content\b/i,
  /\bfree trial\b/i,
  /\bbook demo\b/i,
  /\bsearch support login\b/i,
  /\bshare on linkedin\b/i,
  /\btable of contents\b/i,
  /\bready to get started\b/i,
  /\bstart free trial\b/i,
  /\bopen a new account\b/i,
  /\bproduct integrations pricing resources company\b/i,
  /\bblog\s*>\b/i,
];

function summarizeRecoveredFetchedContent(value: string, limit: number, userPrompt?: string): string[] {
  const normalized = normalizeRecoveredContentText(value);
  if (!normalized) {
    return [];
  }
  const promptTerms = extractRecoveredContentPromptTerms(userPrompt);
  const rawSegments = normalized.split(/(?<=[.!?])\s+|\s*[•·]\s+|\s{2,}/);
  const rankedSegments: Array<{
    segment: string;
    score: number;
    index: number;
  }> = [];
  const seen = new Set<string>();
  rawSegments.forEach((rawSegment, index) => {
    const segment = normalizeRecoveredContentText(rawSegment);
    if (!segment || segment.length < 45) {
      return;
    }
    const dedupeKey = segment.toLowerCase();
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    rankedSegments.push({
      segment,
      score: scoreRecoveredContentSegment(segment, promptTerms, userPrompt),
      index,
    });
  });

  const preferred = rankedSegments
    .filter((item) => item.score > -40)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => truncatePlainText(item.segment, 220));
  if (preferred.length > 0) {
    return preferred;
  }

  const firstUsable = rankedSegments.sort((left, right) => left.index - right.index).find((item) => item.score > -1000);
  if (firstUsable) {
    return [truncatePlainText(firstUsable.segment, 220)];
  }

  return [truncatePlainText(normalized, 280)];
}

function extractRecoveredContentPromptTerms(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const matches = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    if (match.length < 3 || RECOVERED_CONTENT_PROMPT_STOPWORDS.has(match)) {
      continue;
    }
    unique.add(match);
  }
  return [...unique];
}

function scoreRecoveredContentSegment(segment: string, promptTerms: string[], userPrompt?: string): number {
  const normalized = segment.toLowerCase();
  if (RECOVERED_CONTENT_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return -1000;
  }

  const useCaseIntent = queryExplicitlyRequestsUseCases(userPrompt ?? "");
  let score = 0;
  if (segment.length >= 70 && segment.length <= 260) {
    score += 8;
  }
  if (/\b(rest api|rest apis|api|apis)\b/i.test(segment)) {
    score += 8;
  }
  if (
    /\b(used|use case|use cases|used for|widely used|commonly used|applications?|integrat(?:e|ion|ions)|backends?|mobile|automation|workflow|workflows|partner-facing|web services?)\b/i.test(
      segment,
    )
  ) {
    score += 20;
  }
  if (/\b(for example|for instance|such as|might use)\b/i.test(segment)) {
    score += 10;
  }
  if (/\b(what is|how do|benefits?|best practices?|security)\b/i.test(segment)) {
    score -= 10;
  }
  if (
    /\b(published:|technical writer and editor|senior technology editor|hypertext transfer protocol|architectural style)\b/i.test(
      segment,
    )
  ) {
    score -= 24;
  }
  if (
    /\b(application\/json|application\/xml|application\/x-web\+xml|application\/x-www-form-urlencoded|multipart|crud|http verb|restful web services)\b/i.test(
      segment,
    )
  ) {
    score -= 28;
  }
  if (/\b(sign up|trial|demo|pricing|company|support|login)\b/i.test(segment)) {
    score -= 20;
  }
  if (useCaseIntent) {
    if (
      /\b(cloud consumers|cloud services?|distributed environments|web services?|web and mobile|mobile and web|integrations?|automation|sites such as|partner|public api|iot|devices?)\b/i.test(
        segment,
      )
    ) {
      score += 18;
    }
    if (/\b(logical choice|ways to|widely used across|commonly used across|used across)\b/i.test(segment)) {
      score += 12;
    }
    if (
      /\b(client|server|resource|endpoint|header|body|uri|url|requests?|responses?|http method|http methods|programming languages?|json|xml|plain text|create, retrieve, update|fundamentally relies|principal parts|self descriptive|stateless)\b/i.test(
        segment,
      )
    ) {
      score -= 16;
    }
    if (
      /^(the client is|the server is|the resource is|client requests include|a rest api fundamentally relies|a rest api uses existing http methodologies|usually, response details|the server provides)\b/i.test(
        normalized,
      )
    ) {
      score -= 24;
    }
  }
  for (const term of promptTerms) {
    if (normalized.includes(term)) {
      score += 4;
    }
  }
  return score;
}

interface SearchSnippetEvidence {
  title?: string;
  url?: string;
  snippet: string;
}

function recoverSearchSnippetEvidence(toolRuns: ChatToolRunRecord[]): SearchSnippetEvidence[] {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (
      !run ||
      run.toolName !== "browser.search" ||
      run.status !== "executed" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const results = Array.isArray((run.result as Record<string, unknown>).results)
      ? ((run.result as Record<string, unknown>).results as Array<Record<string, unknown>>)
      : [];
    const snippets = results
      .map((item) => ({
        title: typeof item.title === "string" ? item.title : undefined,
        url: typeof item.url === "string" ? item.url : undefined,
        snippet: normalizeRecoveredContentText(typeof item.snippet === "string" ? item.snippet : "") ?? "",
      }))
      .filter((item) => item.snippet.length >= 40);
    if (snippets.length > 0) {
      return snippets;
    }
  }
  return [];
}

function collectRecoveredAnswerPoints(toolRuns: ChatToolRunRecord[], userPrompt: string, limit: number): string[] {
  const points: string[] = [];
  const seen = new Set<string>();
  const pushPoint = (value: string) => {
    const normalized = normalizeRecoveredContentText(value);
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    points.push(normalized);
  };

  const fetchedContent = recoverFetchedContentEvidence(toolRuns);
  if (fetchedContent) {
    for (const point of summarizeRecoveredFetchedContent(fetchedContent.text, Math.max(limit, 4), userPrompt)) {
      pushPoint(point);
    }
  }

  for (const run of toolRuns) {
    if (
      run.status !== "executed" ||
      (run.toolName !== "file.read_range" && run.toolName !== "fs.read") ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const content =
      typeof (run.result as Record<string, unknown>).content === "string"
        ? ((run.result as Record<string, unknown>).content as string)
        : "";
    if (!content.trim()) {
      continue;
    }
    for (const point of summarizeRecoveredFetchedContent(content, 2, userPrompt)) {
      pushPoint(point);
    }
    if (points.length >= limit) {
      break;
    }
  }

  for (const evidence of recoverSearchSnippetEvidence(toolRuns)) {
    for (const point of summarizeRecoveredFetchedContent(evidence.snippet, 1, userPrompt)) {
      pushPoint(point);
    }
    if (points.length >= limit) {
      break;
    }
  }

  return points.slice(0, limit);
}

export function buildRecoveredEvidenceAnswer(
  userPrompt: string,
  toolRuns: ChatToolRunRecord[],
  options: {
    note: string;
  },
): string | undefined {
  const points = collectRecoveredAnswerPoints(toolRuns, userPrompt, 5);
  if (points.length === 0) {
    return undefined;
  }
  const fetchedContent = recoverFetchedContentEvidence(toolRuns);
  const firstSearchLead = recoverSearchSnippetEvidence(toolRuns)[0];
  const sourceTitle =
    fetchedContent?.title?.trim() ??
    firstSearchLead?.title?.trim() ??
    (fetchedContent?.url
      ? formatRecoveredSearchLead({ title: null, url: fetchedContent.url })
      : firstSearchLead?.url
        ? formatRecoveredSearchLead({ title: null, url: firstSearchLead.url })
        : undefined);
  const sourceUrl = fetchedContent?.url ?? firstSearchLead?.url;
  const lines = [
    buildRecoveredEvidenceIntro(userPrompt),
    "",
    ...points.map((point, index) => `${index + 1}. ${truncatePlainText(point, 220)}`),
  ];
  if (sourceTitle || sourceUrl) {
    const sourceLine = sourceUrl ? `${sourceTitle ?? sourceUrl} - ${sourceUrl}` : sourceTitle;
    lines.push("", `Primary source: ${sourceLine}`);
  }
  lines.push("", options.note);
  return lines.join("\n");
}

function buildRecoveredEvidenceIntro(userPrompt: string): string {
  const normalized = userPrompt.toLowerCase();
  if (
    /\btop\s+\d+\b.*\b(use|uses|use case|use cases)\b/.test(normalized) ||
    /\b(use case|use cases)\b/.test(normalized)
  ) {
    return "Based on the sources I did retrieve, these look like the strongest relevant use cases:";
  }
  if (/\bcompare|comparison|differences?\b/.test(normalized)) {
    return "Based on the sources I did retrieve, these are the strongest comparison points:";
  }
  return "Based on the sources I did retrieve, these are the strongest relevant points:";
}

export function summarizeToolRunForSynthesis(run: ChatToolRunRecord, userPrompt?: string): string {
  const baseParts = [
    `- ${run.toolName}`,
    `[${run.status}]`,
    run.error ? `error: ${run.error}` : undefined,
    run.failureGuidance ? `guidance: ${run.failureGuidance}` : undefined,
  ].filter(Boolean);
  const fileReadSummary = summarizeFileReadToolRunForSynthesis(run);
  if (fileReadSummary) {
    return `${baseParts.join(" ")} ${fileReadSummary}`;
  }
  if (run.result && typeof run.result === "object") {
    if (run.toolName === "browser.search") {
      const searchLeads = recoverSearchSnippetEvidence([run])
        .slice(0, 3)
        .map(
          (item) =>
            `${item.title ?? item.url ?? "result"}${item.snippet ? ` :: ${truncatePlainText(item.snippet, 140)}` : ""}`,
        );
      if (searchLeads.length > 0) {
        return `${baseParts.join(" ")} results: ${searchLeads.join(" | ")}`;
      }
    }
    if (run.toolName === "browser.navigate" || run.toolName === "browser.extract" || run.toolName === "http.get") {
      const fetched = recoverFetchedContentEvidence([run]);
      if (fetched) {
        const summaryPoints = summarizeRecoveredFetchedContent(fetched.text, 3, userPrompt);
        const source = fetched.url ?? fetched.title ?? "fetched page";
        if (summaryPoints.length > 0) {
          return `${baseParts.join(" ")} source: ${source} content: ${summaryPoints.join(" | ")}`;
        }
      }
    }
  }
  if (run.result) {
    return `${baseParts.join(" ")} result: ${truncateJson(run.result, 280)}`;
  }
  return baseParts.join(" ");
}

function summarizeFileReadToolRunForSynthesis(run: ChatToolRunRecord): string | undefined {
  if (run.toolName !== "file.read_range" && run.toolName !== "fs.read") {
    return undefined;
  }
  if (!run.result || typeof run.result !== "object") {
    return undefined;
  }
  const result = run.result as Record<string, unknown>;
  const pathValue = typeof result.path === "string" ? result.path : undefined;
  const contentValue = typeof result.content === "string" ? result.content.trim() : "";
  if (!contentValue) {
    return undefined;
  }
  const contentSummary = truncatePlainText(contentValue, 700);
  return [pathValue ? `file: ${pathValue}` : undefined, `content: ${contentSummary}`].filter(Boolean).join(" ");
}

export function formatRecoveredSearchLead(item: { title: string | null; url: string }): string {
  const title = item.title?.trim();
  if (title) {
    return title;
  }
  try {
    const parsed = new URL(item.url);
    return parsed.hostname;
  } catch {
    return item.url;
  }
}

export function truncatePlainText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const truncated = value.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace >= Math.max(40, Math.floor(maxChars * 0.6))) {
    return `${truncated.slice(0, lastSpace).trim()}...`;
  }
  return `${truncated.trim()}...`;
}

function truncateJson(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) {
    return serialized;
  }
  return `${serialized.slice(0, maxChars)}...`;
}
