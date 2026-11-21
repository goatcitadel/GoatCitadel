import { expect, it, vi } from "vitest";
import {
  resolveBackgroundLearningReadiness,
  type BackgroundLearningReadinessDeps,
} from "./background-learning-readiness.js";

function fixture(): BackgroundLearningReadinessDeps {
  return {
    readConfiguration: async () => ({
      autonomyEnabled: true,
      memoryEnabled: true,
      memoryAdministrationEnabled: true,
      skillDraftsEnabled: false,
      maintenanceEnabled: false,
    }),
    sourceEligible: async () => true,
    providerReady: async () => true,
    budgetReady: async () => ({ ready: true }),
  };
}
it("disables extraction when no learning destination is ready", async () => {
  const deps = fixture();
  deps.readConfiguration = async () => ({
    autonomyEnabled: true,
    memoryEnabled: false,
    memoryAdministrationEnabled: false,
    skillDraftsEnabled: false,
    maintenanceEnabled: false,
  });
  const provider = vi.fn(async () => true);
  deps.providerReady = provider;
  expect(await resolveBackgroundLearningReadiness(deps, { workspaceId: "A", sessionId: "s" })).toMatchObject({
    canExtractMemory: false,
    canDraftSkill: false,
    canEvaluateMaintenance: false,
    memory: { state: "disabled" },
  });
  expect(provider).not.toHaveBeenCalled();
});
it("fails closed on storage, source, provider and unknown budget failures", async () => {
  for (const key of ["readConfiguration", "sourceEligible", "providerReady", "budgetReady"] as const) {
    const deps = fixture();
    deps[key] = vi.fn(async () => {
      throw new Error("sensitive backend error");
    }) as never;
    const result = await resolveBackgroundLearningReadiness(deps, { workspaceId: "A", sessionId: "s" });
    expect(result.canExtractMemory).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  }
  const deps = fixture();
  deps.budgetReady = async () => ({ ready: false, reasonCode: "usage_unknown" });
  expect(await resolveBackgroundLearningReadiness(deps, { workspaceId: "A", sessionId: "s" })).toMatchObject({
    budget: { state: "blocked", reasonCode: "usage_unknown" },
    canExtractMemory: false,
  });
});
it("rechecks readiness after configuration changes and selects only available destinations", async () => {
  const deps = fixture();
  expect(await resolveBackgroundLearningReadiness(deps, { workspaceId: "A", sessionId: "s" })).toMatchObject({
    canExtractMemory: true,
    canDraftSkill: false,
  });
  deps.readConfiguration = async () => ({
    autonomyEnabled: true,
    memoryEnabled: false,
    memoryAdministrationEnabled: false,
    skillDraftsEnabled: true,
    maintenanceEnabled: false,
  });
  expect(await resolveBackgroundLearningReadiness(deps, { workspaceId: "A", sessionId: "s" })).toMatchObject({
    canExtractMemory: false,
    canDraftSkill: true,
  });
  deps.sourceEligible = async () => false;
  expect(await resolveBackgroundLearningReadiness(deps, { workspaceId: "A", sessionId: "s" })).toMatchObject({
    source: { state: "blocked" },
    canDraftSkill: false,
  });
});
