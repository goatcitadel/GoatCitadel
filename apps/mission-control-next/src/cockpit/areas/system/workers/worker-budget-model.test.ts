import { describe, expect, it } from "vitest";
import { acknowledgementMatches, validateBudgetDraft } from "./worker-budget-model";

describe("validateBudgetDraft", () => {
  it("accepts at least two requests and a dollar limit, in micro-dollars", () => {
    expect(validateBudgetDraft({ requests: "5", cost: "1.25", minutes: "30" })).toEqual({
      ok: true,
      limits: { maxRequests: 5, maxCostMicrousd: 1_250_000, minutes: 30 },
    });
  });

  it.each([
    { requests: "1", cost: "1", minutes: "30" },
    { requests: "", cost: "1", minutes: "30" },
    { requests: "2.5", cost: "1", minutes: "30" },
    { requests: "3", cost: "", minutes: "30" },
    { requests: "3", cost: "-1", minutes: "30" },
  ])("refuses %o", (draft) => {
    expect(validateBudgetDraft(draft)).toEqual({
      ok: false,
      message: "Enter a request limit of at least 2 and a dollar limit.",
    });
  });
});

describe("acknowledgementMatches", () => {
  const request = { grantId: "g", workerGeneration: 3, maxRequests: 5, maxCostMicrousd: 10 };
  it("requires an exact echo with a revision of at least 1", () => {
    expect(acknowledgementMatches(request, { ...request, revision: 1 })).toBe(true);
    expect(acknowledgementMatches(request, { ...request, revision: 0 })).toBe(false);
    expect(acknowledgementMatches(request, { ...request, maxRequests: 6, revision: 1 })).toBe(false);
    expect(acknowledgementMatches(request, null)).toBe(false);
  });
});
