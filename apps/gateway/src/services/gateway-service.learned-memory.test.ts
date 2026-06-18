import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  extractLearnedMemoryCandidates,
  hasProblematicBrowserRun,
  isQuestionLikeMemoryLine,
  looksLowConfidenceResponse,
  shouldExtractLearnedMemoryContent,
} from "./learned-memory-utils.js";

describe("gateway learned-memory hygiene", () => {
  it("treats blocked/fallback assistant text as low confidence", () => {
    expect(
      looksLowConfidenceResponse("A source blocked automated browsing on movieinsider.com, so I'm falling back."),
    ).toBe(true);
    expect(looksLowConfidenceResponse("I hit a tool issue that was not safe to keep retrying.")).toBe(true);
  });

  it("does not extract facts or constraints from question-like user lines", () => {
    expect(isQuestionLikeMemoryLine("What movies are coming out this week?")).toBe(true);
    expect(isQuestionLikeMemoryLine("Can we do this without adding more risk")).toBe(true);
    expect(extractLearnedMemoryCandidates("What movies are coming out this week?", "user")).toEqual([]);
    expect(extractLearnedMemoryCandidates("Can we do this without adding more risk", "user")).toEqual([]);
  });

  it("skips assistant memory extraction when a turn contains blocked browser runs", () => {
    const blockedRun: ChatToolRunRecord = {
      toolRunId: "tool-1",
      turnId: "turn-1",
      sessionId: "sess-1",
      toolName: "browser.navigate",
      status: "executed",
      startedAt: "2026-03-10T00:00:00.000Z",
      finishedAt: "2026-03-10T00:00:01.000Z",
      result: {
        url: "https://www.movieinsider.com/movies",
        finalUrl: "https://www.movieinsider.com/movies",
        engineTier: "playwright_mcp",
        fallbackChain: [
          {
            toolName: "browser.navigate",
            engineTier: "builtin",
            status: "failed",
            browserFailureClass: "remote_blocked",
            url: "https://www.movieinsider.com/movies",
          },
          {
            toolName: "browser.navigate",
            engineTier: "playwright_mcp",
            status: "executed",
            url: "https://www.imdb.com/calendar/",
          },
        ],
      },
    };

    expect(hasProblematicBrowserRun([blockedRun])).toBe(true);
    expect(
      shouldExtractLearnedMemoryContent("Here are the release leads I found.", {
        role: "assistant",
        sourceRef: "assistant-1",
        trace: {
          status: "completed",
          toolRuns: [blockedRun],
        },
      }),
    ).toBe(false);
  });
});
