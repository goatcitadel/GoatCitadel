import { expect, it, vi } from "vitest";
import { AssistantReadinessService, type AssistantReadinessDeps } from "./assistant-readiness-service.js";
const learning = () => ({
  source: { state: "ready" as const },
  provider: { state: "ready" as const },
  budget: { state: "ready" as const },
  memory: { state: "ready" as const },
  skill: { state: "disabled" as const },
  maintenance: { state: "disabled" as const },
  canExtractMemory: true,
  canDraftSkill: false,
  canEvaluateMaintenance: false,
});
function fixture() {
  const read = vi.fn(async () => ({
    workspaceId: "A",
    sessionId: "s",
    active: true,
    privateOperator: true,
    memoryMode: "auto" as const,
    configRevision: 4,
    memoryEnabled: true,
    flags: {
      memoryLifecycleAdminV1Enabled: false,
      memoryCorpusRecallV1Enabled: false,
      backgroundSkillDraftsV1Enabled: false,
      autonomyV1Disabled: false,
      commitmentScheduledTurnsV1Enabled: false,
    },
  }));
  const deps: AssistantReadinessDeps = {
    readSession: read,
    readLearningReadiness: async () => learning(),
    readFollowThroughReadiness: async () => ({
      followUp: { state: "disabled", reasonCode: "commitment_scheduling_disabled" },
      scheduledWork: { state: "ready" },
    }),
  };
  return { read, deps, service: new AssistantReadinessService(deps) };
}
it("memory_disabled_has_exact_scoped_setup_action and installation flags require installation scope", async () => {
  const f = fixture(),
    result = await f.service.getAssistantReadiness("s", "A");
  expect(result.items.find((item) => item.id === "memory")).toMatchObject({
    state: "disabled",
    scope: "installation",
    nextAction: {
      kind: "review_change_plan",
      label: "Review memory setup",
      request: {
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "memoryLifecycleAdminV1Enabled", enabled: true },
      },
    },
  });
  expect(f.read).toHaveBeenCalledTimes(1);
});
it("missing_owner_is_unavailable_not_zero and foreign_session_readiness_is_not_found", async () => {
  const f = fixture();
  f.deps.readFollowThroughReadiness = async () => {
    throw new Error("Fixture owner outage");
  };
  expect(
    (await f.service.getAssistantReadiness("s", "A")).items.find((item) => item.id === "scheduled_work"),
  ).toMatchObject({ state: "unavailable", reasons: ["owner_unavailable"] });
  await expect(f.service.getAssistantReadiness("s", "B")).rejects.toThrow();
});
it("scheduled Chat being disabled offers its exact installation setup instead of reporting readiness", async () => {
  const f = fixture();
  f.deps.readFollowThroughReadiness = async () => ({
    followUp: { state: "ready" },
    scheduledWork: { state: "disabled", reasonCode: "scheduled_chat_disabled" },
  });
  expect(
    (await f.service.getAssistantReadiness("s", "A")).items.find((item) => item.id === "scheduled_work"),
  ).toMatchObject({
    state: "disabled",
    scope: "installation",
    nextAction: {
      request: {
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "scheduledChatTurnsV1Enabled", enabled: true },
      },
    },
  });
});
it("distinguishes drafting readiness from actual reviewed-skill use and offers its exact setup", async () => {
  const f = fixture();
  f.deps.readLearningReadiness = async () => ({ ...learning(), skill: { state: "ready" }, canDraftSkill: true });
  const result = await f.service.getAssistantReadiness("s", "A");
  expect(result).toMatchObject({
    reviewedSkillUse: { state: "disabled", reasonCode: "skill_instructions_disabled" },
    reviewedSkillUseSetup: {
      request: {
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "chatSkillInstructionsV1Enabled", enabled: true },
      },
    },
  });
  const state = await f.read();
  f.deps.readSession = async () => ({ ...state, flags: { ...state.flags, chatSkillInstructionsV1Enabled: true } });
  expect(await f.service.getAssistantReadiness("s", "A")).toMatchObject({ reviewedSkillUse: { state: "ready" } });
  expect((await f.service.getAssistantReadiness("s", "A")).reviewedSkillUseSetup).toBeUndefined();
});
