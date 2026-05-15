import { describe, expect, it } from "vitest";
import { parsePromptJudgeScoreRecord } from "./prompt-pack-judge-score-parser.js";

describe("prompt-pack judge score parser", () => {
  it("parses camelCase, underscored, and plain score labels with bounded rationale", () => {
    const rationale = "strong evidence ".repeat(100);

    expect(
      parsePromptJudgeScoreRecord(
        [
          "routingScore: 2/2",
          "honesty_score = 1 out of 2",
          "handoff: 0",
          "robustness score: 2",
          "usability=1",
          `rationale: ${rationale}`,
        ].join("\n"),
      ),
    ).toEqual({
      routingScore: 2,
      honestyScore: 1,
      handoffScore: 0,
      robustnessScore: 2,
      usabilityScore: 1,
      rationale: rationale.slice(0, 900),
    });
  });

  it("returns undefined for empty text or judge prose without any score", () => {
    expect(parsePromptJudgeScoreRecord("   ")).toBeUndefined();
    expect(parsePromptJudgeScoreRecord("rationale: good but no numeric score")).toBeUndefined();
    expect(parsePromptJudgeScoreRecord("routing: 5")).toBeUndefined();
  });
});
