import { describe, expect, it } from "vitest";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

describe("HX-306 utility model-usage attribution matrix", () => {
  const utilityKinds = [
    "approval_explanation",
    "background_memory_extraction",
    "background_skill_suggestion",
    "commitment_classification",
    "proactive_denovo_planning",
    "chat_execution_plan_draft",
    "memory_context_distillation",
    "memory_candidate_consolidation",
    "memory_maintenance_consolidation",
    "research_summary",
    "prompt_pack_model_judge",
    "improvement_decision_replay_judge",
    "surface_router_judge",
    "mason_answer_extraction",
    "dev_provider_exercise",
  ] as const;

  it.each(utilityKinds)("classifies %s as a utility without request metadata", (utilityKind) => {
    const attribution = createUtilityModelUsageAttribution({
      operationId: `utility-proof:${utilityKind}`,
      utilityKind,
      requestedProviderId: "provider-a",
      requestedModelId: "model-a",
      lineage: {
        workspaceId: "workspace-a",
        sessionId: "session-a",
        turnId: "turn-a",
        durableRunId: "run-a",
        taskId: "task-a",
        agentId: "utility-agent",
      },
    });

    expect(attribution).toEqual({
      operationId: `utility-proof:${utilityKind}`,
      callKind: "utility",
      utilityKind,
      requestedProviderId: "provider-a",
      requestedModelId: "model-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      turnId: "turn-a",
      durableRunId: "run-a",
      taskId: "task-a",
      agentId: "utility-agent",
    });
    expect(attribution).not.toHaveProperty("metadata");
  });
});
