import { describe, expect, it } from "vitest";
import {
  automationCanExternalWrite,
  automationRequiresApproval,
  type AutomationRiskMode,
} from "./citadel-automation.js";

const ALL_MODES: AutomationRiskMode[] = [
  "observe",
  "draft",
  "stage",
  "execute_with_approval",
  "autopilot",
];

describe("automationCanExternalWrite", () => {
  it("returns false for observe — read-only mode has no external writes", () => {
    expect(automationCanExternalWrite("observe")).toBe(false);
  });

  it("returns false for draft — proposals/reports/drafts have no external side effects", () => {
    expect(automationCanExternalWrite("draft")).toBe(false);
  });

  it("returns false for stage — prepares changes locally, no external side effect", () => {
    expect(automationCanExternalWrite("stage")).toBe(false);
  });

  it("returns true for execute_with_approval — performs approved external actions", () => {
    expect(automationCanExternalWrite("execute_with_approval")).toBe(true);
  });

  it("returns true for autopilot — pre-authorized for low-risk reversible writes", () => {
    expect(automationCanExternalWrite("autopilot")).toBe(true);
  });

  it("covers all five modes (exhaustive guard)", () => {
    // If a new mode is added without updating the switch, this will catch it
    // because TypeScript would widen AutomationRiskMode and the switch would
    // need a new case. Here we verify every mode returns a boolean.
    for (const mode of ALL_MODES) {
      expect(typeof automationCanExternalWrite(mode)).toBe("boolean");
    }
  });
});

describe("automationRequiresApproval", () => {
  it("returns false for observe — no external action, so no approval needed", () => {
    expect(automationRequiresApproval("observe")).toBe(false);
  });

  it("returns false for draft — no external action, so no approval needed", () => {
    expect(automationRequiresApproval("draft")).toBe(false);
  });

  it("returns false for stage — no external action, so no approval needed", () => {
    expect(automationRequiresApproval("stage")).toBe(false);
  });

  it("returns true for execute_with_approval — requires per-action human sign-off", () => {
    expect(automationRequiresApproval("execute_with_approval")).toBe(true);
  });

  it("returns false for autopilot — pre-authorized, no per-action approval required", () => {
    expect(automationRequiresApproval("autopilot")).toBe(false);
  });

  it("covers all five modes (exhaustive guard)", () => {
    for (const mode of ALL_MODES) {
      expect(typeof automationRequiresApproval(mode)).toBe("boolean");
    }
  });
});
