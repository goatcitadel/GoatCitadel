import type { ChatToolRunRecord, ChatWebMode } from "@goatcitadel/contracts";

/** Tools that open a page. A search result list does not count as an opened source. */
const PAGE_OPENING_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
/** Runs that count as web research: a search or a page open. Posts and page interactions do not. */
export const WEB_RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["browser.search", ...PAGE_OPENING_TOOL_NAMES]);
const MIN_INDEPENDENT_SOURCES = 2;

export const DEEP_RESEARCH_THIN_EVIDENCE_FOOTER =
  "Note: Deep research opened fewer than two independent sources for this answer, so treat it as preliminary.";

export interface DeepResearchEvidenceAssessment {
  /** Distinct hostnames the pages opened this turn landed on, lowercased, without a leading `www.`, in first-seen order. */
  openedHosts: string[];
  /** True when fewer than two distinct hostnames were opened. */
  thin: boolean;
}

/**
 * Where the page ended up: the post-redirect URL the tool reported, else the requested URL. A
 * redirector or a shortener would otherwise count as the source instead of the site it led to.
 */
function landedUrl(run: ChatToolRunRecord): string | undefined {
  for (const value of [run.result?.finalUrl, run.result?.url, run.args?.url]) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/** The site a URL points at: its lowercased hostname without a leading `www.`, for http(s) URLs only. */
export function hostnameOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return hostname.length > 0 ? hostname : undefined;
}

/** The site an executed page-opening run landed on; undefined for searches and for runs that did not execute. */
export function openedHostname(run: ChatToolRunRecord): string | undefined {
  if (run.status !== "executed" || !PAGE_OPENING_TOOL_NAMES.has(run.toolName)) {
    return undefined;
  }
  const rawUrl = landedUrl(run);
  return rawUrl === undefined ? undefined : hostnameOf(rawUrl);
}

/**
 * Counts the distinct sites a turn actually opened, by the host each page landed on. Only executed
 * page-opening runs with an http(s) URL count; failed, blocked, or approval-gated runs and plain searches do not.
 */
export function assessDeepResearchEvidence(toolRuns: readonly ChatToolRunRecord[]): DeepResearchEvidenceAssessment {
  const openedHosts: string[] = [];
  for (const run of toolRuns) {
    const hostname = openedHostname(run);
    if (hostname && !openedHosts.includes(hostname)) {
      openedHosts.push(hostname);
    }
  }
  return { openedHosts, thin: openedHosts.length < MIN_INDEPENDENT_SOURCES };
}

/**
 * Returns the thin-evidence footer for a Deep research turn in which at least one search or page
 * open ran (executed or failed) but fewer than two independent sites were opened. A Deep turn that
 * ran no such tool, such as a greeting that skipped the seed search, gets no footer. Neither does a
 * delegated child whose answer must match a result contract, or a turn paused for approval or input.
 * A delegated child without a result contract keeps its note in its prose, which the parent turn
 * stitches into its output.
 */
export function buildDeepResearchThinEvidenceFooter(input: {
  webMode: ChatWebMode;
  toolRuns: readonly ChatToolRunRecord[];
  /** The turn's answer is a structured delegated result; appended text would break the contract. */
  delegatedResultContract?: boolean;
  /** The turn ends waiting for an approval or the operator's input, not with an answer. */
  paused?: boolean;
}): string | undefined {
  if (input.webMode !== "deep" || input.delegatedResultContract || input.paused) {
    return undefined;
  }
  const webToolRan = input.toolRuns.some(
    (run) => WEB_RESEARCH_TOOL_NAMES.has(run.toolName) && (run.status === "executed" || run.status === "failed"),
  );
  if (!webToolRan || !assessDeepResearchEvidence(input.toolRuns).thin) {
    return undefined;
  }
  return DEEP_RESEARCH_THIN_EVIDENCE_FOOTER;
}
