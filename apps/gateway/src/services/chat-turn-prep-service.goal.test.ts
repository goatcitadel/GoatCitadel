import { describe, expect, it } from "vitest";
import {
  applyGoalToGuidanceSystemInstruction,
  advanceGoalForTurn,
  DEFAULT_GOAL_TURN_BUDGET,
} from "./chat-turn-prep-service.js";

describe("applyGoalToGuidanceSystemInstruction", () => {
  it("returns base instruction when goal is null", () => {
    expect(applyGoalToGuidanceSystemInstruction({ baseInstruction: "base", goal: null })).toBe("base");
  });
  it("returns empty string when no goal and no base instruction", () => {
    expect(applyGoalToGuidanceSystemInstruction({ baseInstruction: undefined, goal: null })).toBe("");
  });
  it("returns just the goal block when goal is set but no base instruction", () => {
    expect(applyGoalToGuidanceSystemInstruction({ baseInstruction: undefined, goal: "ship kanban" })).toContain(
      "Pinned goal: ship kanban",
    );
  });
  it("prepends Pinned goal section when goal is set", () => {
    const out = applyGoalToGuidanceSystemInstruction({ baseInstruction: "base", goal: "ship kanban" });
    expect(out).toContain("Pinned goal: ship kanban");
    expect(out).toContain("base");
    expect(out.indexOf("Pinned goal")).toBeLessThan(out.indexOf("base"));
  });
});

describe("advanceGoalForTurn", () => {
  it("returns { cleared: false } when below budget", () => {
    expect(advanceGoalForTurn({ turnsUsed: 1, turnBudget: 20 })).toEqual({ cleared: false });
  });
  it("returns { cleared: true } when at or above budget", () => {
    expect(advanceGoalForTurn({ turnsUsed: 20, turnBudget: 20 })).toEqual({ cleared: true });
    expect(advanceGoalForTurn({ turnsUsed: 25, turnBudget: 20 })).toEqual({ cleared: true });
  });
  it("treats null budget as DEFAULT_GOAL_TURN_BUDGET", () => {
    expect(advanceGoalForTurn({ turnsUsed: DEFAULT_GOAL_TURN_BUDGET - 1, turnBudget: null })).toEqual({
      cleared: false,
    });
    expect(advanceGoalForTurn({ turnsUsed: DEFAULT_GOAL_TURN_BUDGET, turnBudget: null })).toEqual({ cleared: true });
  });
});
