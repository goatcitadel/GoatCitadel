import type { ChatCitationRecord, ChatToolRunRecord } from "@goatcitadel/contracts";

/** Tools that open a page. A search result list does not count as an opened source. */
const PAGE_OPENING_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}*_>]$/;

/** Compares URLs ignoring a trailing `/`, a `#fragment`, and a leading `www.` on the host. */
function normalizeUrl(rawUrl: string): string {
  return rawUrl
    .trim()
    .replace(/#.*$/, "")
    .replace(/^(https?:\/\/)www\./i, "$1")
    .replace(/\/+$/, "");
}

/** Every URL the answer text mentions, plus each form with trailing prose or markdown punctuation removed. */
function collectUrlsFromText(text: string): Set<string> {
  const urls = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT_PATTERN)) {
    let candidate = match[0];
    urls.add(normalizeUrl(candidate));
    while (TRAILING_PUNCTUATION_PATTERN.test(candidate)) {
      candidate = candidate.slice(0, -1);
      urls.add(normalizeUrl(candidate));
    }
  }
  return urls;
}

/** URLs of executed page-opening runs, including the post-redirect URL the citation was recorded under. */
function collectOpenedPageUrls(toolRuns: readonly ChatToolRunRecord[]): Set<string> {
  const urls = new Set<string>();
  for (const run of toolRuns) {
    if (run.status !== "executed" || !PAGE_OPENING_TOOL_NAMES.has(run.toolName)) {
      continue;
    }
    for (const value of [run.args?.url, run.result?.finalUrl, run.result?.url]) {
      if (typeof value === "string" && value.trim().length > 0) {
        urls.add(normalizeUrl(value));
      }
    }
  }
  return urls;
}

function dedupeWebCitations(citations: readonly ChatCitationRecord[]): ChatCitationRecord[] {
  const seen = new Set<string>();
  const result: ChatCitationRecord[] = [];
  for (const citation of citations) {
    if (citation.sourceType === "web") {
      const key = normalizeUrl(citation.url);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    result.push(citation);
  }
  return result;
}

/**
 * Narrows a turn's citations to the ones the answer relied on, so a Deep research turn does not
 * persist every search result of every search. Non-web citations are always kept. Web citations
 * are kept when the answer text names their URL; when it names none (for example it cites by
 * number), the pages the turn actually opened are kept instead. When neither identifies a web
 * citation, the input is returned unchanged rather than dropping all evidence.
 */
export function selectAnswerCitations(input: {
  citations: readonly ChatCitationRecord[];
  assistantContent: string;
  toolRuns: readonly ChatToolRunRecord[];
}): ChatCitationRecord[] {
  const { citations, assistantContent, toolRuns } = input;
  const mentionedUrls = collectUrlsFromText(assistantContent);
  const isMentioned = (citation: ChatCitationRecord) =>
    citation.sourceType === "web" && mentionedUrls.has(normalizeUrl(citation.url));

  let keepWeb: (citation: ChatCitationRecord) => boolean = isMentioned;
  if (!citations.some(isMentioned)) {
    const openedUrls = collectOpenedPageUrls(toolRuns);
    const isOpened = (citation: ChatCitationRecord) =>
      citation.sourceType === "web" && openedUrls.has(normalizeUrl(citation.url));
    if (!citations.some(isOpened)) {
      return [...citations];
    }
    keepWeb = isOpened;
  }

  return dedupeWebCitations(citations.filter((citation) => citation.sourceType !== "web" || keepWeb(citation)));
}
