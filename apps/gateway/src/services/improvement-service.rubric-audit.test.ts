import { describe, it, expect } from "vitest";
import { evaluateDecisionReplayRuleScores, type DecisionReplayCandidate } from "./improvement-replay.js";

describe("Improvement rubric is class-first (numeric, not free-form)", () => {
  it("evaluateDecisionReplayRuleScores returns five numeric class scores", () => {
    const candidate = {
      decisionType: "chat_turn",
      status: "completed",
    } as DecisionReplayCandidate;
    const result = evaluateDecisionReplayRuleScores(candidate, []);
    expect(typeof result.scores.honesty).toBe("number");
    expect(typeof result.scores.blockerQuality).toBe("number");
    expect(typeof result.scores.retryQuality).toBe("number");
    expect(typeof result.scores.toolEvidence).toBe("number");
    expect(typeof result.scores.actionability).toBe("number");
    for (const value of Object.values(result.scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("scores are deterministic for identical inputs (no free-form LLM text)", () => {
    const candidate = {
      decisionType: "chat_turn",
      status: "failed",
    } as DecisionReplayCandidate;
    const a = evaluateDecisionReplayRuleScores(candidate, []);
    const b = evaluateDecisionReplayRuleScores(candidate, []);
    expect(a.scores).toEqual(b.scores);
  });

  it("returns class-first signal strings (not free-form descriptions)", () => {
    const candidate = {
      decisionType: "chat_turn",
      status: "failed",
    } as DecisionReplayCandidate;
    const result = evaluateDecisionReplayRuleScores(candidate, []);
    // Signal strings are short class identifiers like 'chat_turn_failed', not sentences
    for (const signal of result.signals) {
      expect(signal.length).toBeLessThan(64);
      expect(signal).not.toMatch(/\s{2,}/); // no double spaces (rules out long sentences)
    }
  });
});
