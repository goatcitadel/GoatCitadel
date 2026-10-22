import type { ChatToolRunRecord, ChatWebMode } from "@goatcitadel/contracts";
import { WEB_TOOL_NAMES } from "../chat-tool-families.js";

/** Tools that open a page. A search result list does not count as an opened source. */
const PAGE_OPENING_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
const MIN_INDEPENDENT_SOURCES = 2;

export const DEEP_RESEARCH_THIN_EVIDENCE_FOOTER =
  "Note: Deep research opened fewer than two independent sources for this answer, so treat it as preliminary.";

export interface DeepResearchEvidenceAssessment {
  /** Distinct hostnames opened this turn, lowercased, without a leading `www.`, in first-seen order. */
  openedHosts: string[];
  /** True when fewer than two distinct hostnames were opened. */
  thin: boolean;
}

function openedHostname(run: ChatToolRunRecord): string | undefined {
  if (run.status !== "executed" || !PAGE_OPENING_TOOL_NAMES.has(run.toolName)) {
    return undefined;
  }
  const rawUrl = run.args?.url;
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return hostname.length > 0 ? hostname : undefined;
}

/**
 * Counts the distinct sites a turn actually opened. Only executed page-opening runs with an
 * http(s) URL count; failed, blocked, or approval-gated runs and plain searches do not.
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
 * Returns the thin-evidence footer for a Deep research turn in which at least one web tool ran
 * (executed or failed) but fewer than two independent sites were opened. A Deep turn that ran no
 * web tool, such as a greeting that skipped the seed search, gets no footer.
 */
export function buildDeepResearchThinEvidenceFooter(input: {
  webMode: ChatWebMode;
  toolRuns: readonly ChatToolRunRecord[];
}): string | undefined {
  if (input.webMode !== "deep") {
    return undefined;
  }
  const webToolRan = input.toolRuns.some(
    (run) => WEB_TOOL_NAMES.has(run.toolName) && (run.status === "executed" || run.status === "failed"),
  );
  if (!webToolRan || !assessDeepResearchEvidence(input.toolRuns).thin) {
    return undefined;
  }
  return DEEP_RESEARCH_THIN_EVIDENCE_FOOTER;
}
