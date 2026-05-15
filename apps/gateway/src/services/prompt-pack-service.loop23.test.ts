import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { buildPromptPackJudgeRecord, clampPromptScore, normalizePromptTestCode } from "./prompt-pack-service.js";

describe("prompt-pack service loop23 helper coverage", () => {
  it("normalizes prompt test codes across legacy, dotted, all, and unknown formats", () => {
    expect(normalizePromptTestCode(" all ")).toBe("all");
    expect(normalizePromptTestCode("001.02.0003")).toBe("1.2.3");
    expect(normalizePromptTestCode("test-7")).toBe("TEST-07");
    expect(normalizePromptTestCode("TEST-A9")).toBe("TEST-A09");
    expect(normalizePromptTestCode("prompt-pack-special-case")).toBe("PROMPT-PACK-SPECIAL-CASE");
  });

  it("clamps prompt scores and treats positive fractional numeric inputs as partial credit", () => {
    expect(clampPromptScore("2")).toBe(2);
    expect(clampPromptScore(1.8)).toBe(1);
    expect(clampPromptScore(0.49)).toBe(1);
    expect(clampPromptScore(-10)).toBe(0);
    expect(clampPromptScore("not-a-score")).toBe(0);
  });

  it("classifies model judge status for success, repaired schema, fallback, rate limits, and hard errors", () => {
    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        ruleSignals: ["complete_answer"],
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
      }),
    ).toMatchObject({ status: "ok", usedModelJudge: true });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        ruleSignals: [],
        attemptCount: 2,
        fallbackUsed: false,
        repairedSchema: true,
      }),
    ).toMatchObject({ status: "schema_repair", attemptCount: 2 });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: false,
        ruleSignals: ["rule_only"],
        attemptCount: 0,
        fallbackUsed: true,
        repairedSchema: false,
      }),
    ).toMatchObject({ status: "fallback", ruleSignals: ["rule_only"] });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        modelJudgeError: "429 Too Many Requests",
        ruleSignals: [],
        attemptCount: 3,
        fallbackUsed: false,
        repairedSchema: false,
      }),
    ).toMatchObject({ status: "rate_limited", modelJudgeError: "429 Too Many Requests" });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        modelJudgeError: "judge returned malformed output",
        ruleSignals: [],
        attemptCount: 3,
        fallbackUsed: false,
        repairedSchema: true,
      }),
    ).toMatchObject({ status: "error", modelJudgeError: "judge returned malformed output" });
  });
});
