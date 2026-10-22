import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  assessDeepResearchEvidence,
  buildDeepResearchThinEvidenceFooter,
  DEEP_RESEARCH_THIN_EVIDENCE_FOOTER,
} from "./deep-research-evidence.js";

let runCounter = 0;

function toolRun(
  toolName: string,
  url: string | undefined,
  status: ChatToolRunRecord["status"] = "executed",
): ChatToolRunRecord {
  runCounter += 1;
  return {
    toolRunId: `run-${runCounter}`,
    turnId: "turn-1",
    sessionId: "session-1",
    toolName,
    status,
    startedAt: "2026-10-21T00:00:00.000Z",
    ...(url === undefined ? {} : { args: { url } }),
  };
}

function landedRun(argsUrl: string, result: Record<string, unknown>): ChatToolRunRecord {
  return { ...toolRun("browser.navigate", argsUrl), result };
}

describe("assessDeepResearchEvidence", () => {
  it("counts the host a page landed on, not the requested URL, when they differ", () => {
    const sameLanding = assessDeepResearchEvidence([
      landedRun("https://a.com/go", { finalUrl: "https://shared.example/one" }),
      landedRun("https://b.com/go", { finalUrl: "https://www.shared.example/two" }),
    ]);
    expect(sameLanding).toEqual({ openedHosts: ["shared.example"], thin: true });

    const differentLanding = assessDeepResearchEvidence([
      landedRun("https://redirect.example/r?1", { finalUrl: "https://a.com/page" }),
      landedRun("https://redirect.example/r?2", { url: "https://b.org/page" }),
    ]);
    expect(differentLanding).toEqual({ openedHosts: ["a.com", "b.org"], thin: false });
  });

  it("falls back to the requested URL when the result carries no string landing URL", () => {
    const result = assessDeepResearchEvidence([
      landedRun("https://a.com/page", { finalUrl: 42 }),
      landedRun("https://b.org/page", { finalUrl: "  ", url: null }),
    ]);
    expect(result).toEqual({ openedHosts: ["a.com", "b.org"], thin: false });
  });

  it("ignores a page that landed on a non-http(s) URL", () => {
    const result = assessDeepResearchEvidence([
      landedRun("https://a.com/page", { finalUrl: "file:///etc/hosts" }),
      landedRun("https://b.org/page", {}),
    ]);
    expect(result).toEqual({ openedHosts: ["b.org"], thin: true });
  });

  it("treats www. and the bare domain as one source", () => {
    const result = assessDeepResearchEvidence([
      toolRun("browser.navigate", "https://www.a.com/one"),
      toolRun("browser.navigate", "https://a.com/two"),
    ]);
    expect(result).toEqual({ openedHosts: ["a.com"], thin: true });
  });

  it("counts two different sites as independent sources", () => {
    const result = assessDeepResearchEvidence([
      toolRun("browser.navigate", "https://a.com/page"),
      toolRun("browser.navigate", "https://b.org/page"),
    ]);
    expect(result).toEqual({ openedHosts: ["a.com", "b.org"], thin: false });
  });

  it("counts browser.extract and http.get as opened pages", () => {
    const result = assessDeepResearchEvidence([
      toolRun("browser.extract", "https://a.com/page"),
      toolRun("http.get", "https://B.org/data"),
    ]);
    expect(result).toEqual({ openedHosts: ["a.com", "b.org"], thin: false });
  });

  it("ignores failed, blocked, and approval-gated runs", () => {
    const result = assessDeepResearchEvidence([
      toolRun("browser.navigate", "https://a.com/page"),
      toolRun("browser.navigate", "https://b.org/page", "failed"),
      toolRun("http.get", "https://c.net/page", "blocked"),
      toolRun("browser.extract", "https://d.io/page", "approval_required"),
    ]);
    expect(result).toEqual({ openedHosts: ["a.com"], thin: true });
  });

  it("ignores searches, other tools, and runs without a usable URL", () => {
    const result = assessDeepResearchEvidence([
      toolRun("browser.search", "https://search.example/?q=x"),
      toolRun("fs.read", "https://a.com/page"),
      toolRun("browser.navigate", undefined),
      toolRun("browser.navigate", "not a url"),
      toolRun("http.get", "file:///etc/hosts"),
    ]);
    expect(result).toEqual({ openedHosts: [], thin: true });
  });
});

describe("buildDeepResearchThinEvidenceFooter", () => {
  it("uses the exact footer copy", () => {
    expect(DEEP_RESEARCH_THIN_EVIDENCE_FOOTER).toBe(
      "Note: Deep research opened fewer than two independent sources for this answer, so treat it as preliminary.",
    );
  });

  it("flags a Deep turn whose web tools opened fewer than two sites", () => {
    const toolRuns = [toolRun("browser.search", undefined), toolRun("browser.navigate", "https://a.com/page")];
    expect(buildDeepResearchThinEvidenceFooter({ webMode: "deep", toolRuns })).toBe(DEEP_RESEARCH_THIN_EVIDENCE_FOOTER);
  });

  it("flags a Deep turn whose only web search failed", () => {
    const toolRuns = [toolRun("browser.search", undefined, "failed")];
    expect(buildDeepResearchThinEvidenceFooter({ webMode: "deep", toolRuns })).toBe(DEEP_RESEARCH_THIN_EVIDENCE_FOOTER);
  });

  it("stays silent when no web tool ran, such as a greeting that skipped the seed search", () => {
    expect(buildDeepResearchThinEvidenceFooter({ webMode: "deep", toolRuns: [] })).toBeUndefined();
    expect(
      buildDeepResearchThinEvidenceFooter({
        webMode: "deep",
        toolRuns: [toolRun("fs.read", undefined), toolRun("browser.search", undefined, "blocked")],
      }),
    ).toBeUndefined();
  });

  it("stays silent when two independent sites were opened", () => {
    const toolRuns = [
      toolRun("browser.search", undefined),
      toolRun("browser.navigate", "https://a.com/page"),
      toolRun("browser.navigate", "https://b.org/page"),
    ];
    expect(buildDeepResearchThinEvidenceFooter({ webMode: "deep", toolRuns })).toBeUndefined();
  });

  it("counts only search and page-opening runs as web research", () => {
    expect(
      buildDeepResearchThinEvidenceFooter({
        webMode: "deep",
        toolRuns: [toolRun("http.post", "https://hooks.example/notify"), toolRun("browser.interact", undefined)],
      }),
    ).toBeUndefined();
    expect(
      buildDeepResearchThinEvidenceFooter({
        webMode: "deep",
        toolRuns: [toolRun("http.get", "https://a.com/x", "failed")],
      }),
    ).toBe(DEEP_RESEARCH_THIN_EVIDENCE_FOOTER);
  });

  it("stays silent for a delegated result contract or a paused turn", () => {
    const toolRuns = [toolRun("browser.search", undefined)];
    expect(
      buildDeepResearchThinEvidenceFooter({ webMode: "deep", toolRuns, delegatedResultContract: true }),
    ).toBeUndefined();
    expect(buildDeepResearchThinEvidenceFooter({ webMode: "deep", toolRuns, paused: true })).toBeUndefined();
  });

  it("flags a delegated child without a result contract so its note travels in its prose to the parent", () => {
    const toolRuns = [toolRun("browser.search", undefined)];
    // `delegatedChildTurn: true` is what the old skip keyed on; it is no longer an input, so the cast
    // keeps this a regression guard that fails if the skip returns.
    const input = { webMode: "deep", toolRuns, delegatedResultContract: false, delegatedChildTurn: true } as const;
    expect(buildDeepResearchThinEvidenceFooter(input)).toBe(DEEP_RESEARCH_THIN_EVIDENCE_FOOTER);
  });

  it("stays silent outside Deep mode", () => {
    const toolRuns = [toolRun("browser.search", undefined)];
    for (const webMode of ["auto", "quick", "off"] as const) {
      expect(buildDeepResearchThinEvidenceFooter({ webMode, toolRuns })).toBeUndefined();
    }
  });
});
