import type { ChatCitationRecord, ChatToolRunRecord } from "@goatcitadel/contracts";

/** Tools that open a page. A search result list does not count as an opened source. */
const PAGE_OPENING_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}*_>]$/;
/** Separators that join two URLs in one token: a markdown link's `](`, a comma, or a table pipe. */
const JOINED_URL_SEPARATOR_PATTERN = /\]\(|[,|]/;
const SCHEME_AND_HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/**
 * Compares URLs ignoring a trailing `/`, a `#fragment`, a leading `www.` on the host, and the case
 * of the scheme and host. The path keeps its case.
 */
function normalizeUrl(rawUrl: string): string {
  return rawUrl
    .trim()
    .replace(SCHEME_AND_HOST_PATTERN, (schemeAndHost) => schemeAndHost.toLowerCase())
    .replace(/#.*$/, "")
    .replace(/^(https?:\/\/)www\./i, "$1")
    .replace(/\/+$/, "");
}

/** Adds a candidate URL and each form of it with trailing prose or markdown punctuation removed. */
function addUrlCandidate(urls: Set<string>, rawCandidate: string): void {
  let candidate = rawCandidate;
  urls.add(normalizeUrl(candidate));
  while (TRAILING_PUNCTUATION_PATTERN.test(candidate)) {
    candidate = candidate.slice(0, -1);
    urls.add(normalizeUrl(candidate));
  }
}

/**
 * Every URL the answer text mentions. A token such as `https://a.com/x](https://a.com/x)` or
 * `https://a.com/x,https://b.com/y` is also split on `](`, `,` and `|`, and each piece is a candidate.
 */
function collectUrlsFromText(text: string): Set<string> {
  const urls = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT_PATTERN)) {
    addUrlCandidate(urls, match[0]);
    for (const piece of match[0].split(JOINED_URL_SEPARATOR_PATTERN)) {
      if (piece.length > 0) {
        addUrlCandidate(urls, piece);
      }
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
