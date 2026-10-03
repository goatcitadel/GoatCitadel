import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildUnverifiedLocalReviewAnswer,
  buildVerifiedLocalReviewComparisonAnswer,
  collectLocalReviewProfileEvidence,
  isLocalReviewRankingTurn,
} from "./chat-local-review-evidence.js";

function run(toolName: string, result: Record<string, unknown>, status = "executed"): ChatToolRunRecord {
  return { toolName, status, result } as ChatToolRunRecord;
}

describe("local review evidence", () => {
  it("does not treat search snippets as verified ratings or a ranking", () => {
    const toolRuns = [
      run("browser.search", {
        results: [
          { title: "Clown A", url: "https://example.com/clown-a", snippet: "5.0 from 4 reviews" },
          { title: "Search", url: "https://www.google.com/search?q=clowns", snippet: "Many clowns" },
        ],
      }),
    ];
    expect(collectLocalReviewProfileEvidence(toolRuns)).toEqual([]);
    const answer = buildUnverifiedLocalReviewAnswer(toolRuns, "funniest best reviewed clowns near 91303");
    expect(answer).toContain("Unranked search leads");
    expect(answer).toContain("https://example.com/clown-a");
    expect(answer).not.toContain("5.0 from 4 reviews");
    expect(answer).not.toContain("google.com");
    expect(answer).toContain("ratings alone cannot establish who is funniest");
  });

  it("counts distinct opened candidate pages with rating and count, not aliases or directories", () => {
    const toolRuns = [
      run("browser.navigate", {
        finalUrl: "https://example.com/clown-a",
        title: "Clown A",
        contentText: "Clown A performs parties. 5.0 (4 reviews)",
      }),
      run("browser.extract", {
        finalUrl: "https://example.com/clown-a#reviews",
        title: "Clown A alias",
        text: "5.0 (4 reviews)",
      }),
      run("http.get", {
        finalUrl: "https://example.com/clown-b",
        title: "Clown B",
        textSnippet: "Clown B, 4.8 stars 41 reviews",
      }),
      run("browser.navigate", {
        finalUrl: "https://example.com/clowns-los-angeles",
        title: "Top 10 Clowns in Los Angeles",
        contentText: "5.0 (100 reviews)",
      }),
      run("browser.navigate", {
        finalUrl: "https://example.com/clown-c",
        title: "Blocked",
        textSnippet: "Cloudflare Ray ID. 5.0 (100 reviews)",
      }),
      run("browser.navigate", {
        finalUrl: "https://example.com/clown-d",
        title: "Clown D",
        status: "403",
        textSnippet: "Clown D. 5.0 (100 reviews)",
      }),
    ];
    expect(collectLocalReviewProfileEvidence(toolRuns)).toEqual([
      { url: "https://example.com/clown-a", title: "Clown A", rating: 5, reviewCount: 4 },
      { url: "https://example.com/clown-b", title: "Clown B", rating: 4.8, reviewCount: 41 },
    ]);
    const answer = buildVerifiedLocalReviewComparisonAnswer(toolRuns, "funniest best reviewed clowns near 91303");
    expect(answer.indexOf("Clown A")).toBeLessThan(answer.indexOf("Clown B"));
    expect(answer).toContain("5/5 from 4 reviews");
    expect(answer).toContain("4.8/5 from 41 reviews");
    expect(answer).not.toContain("Top 10 Clowns");
    expect(answer).toContain("Ratings alone cannot establish who is funniest");
  });

  it("targets local review comparisons without gating ordinary review research", () => {
    expect(isLocalReviewRankingTurn("best reviewed clowns near 91303", true)).toBe(true);
    expect(isLocalReviewRankingTurn("find clown reviews near 91303", true)).toBe(false);
    expect(isLocalReviewRankingTurn("best reviewed testing libraries", false)).toBe(false);
  });
});
