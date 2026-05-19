import type {
  DurableRunRecord,
  OrchestrationPlan,
  OrchestrationPlanWorkflowPayload,
  OrchestrationRun,
} from "@goatcitadel/contracts";

const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_WORKTREE_BASE_REF = "HEAD";

export function parseOrchestrationWorkflowPayload(run: DurableRunRecord): OrchestrationPlanWorkflowPayload | undefined {
  const payload = run.payload as Partial<OrchestrationPlanWorkflowPayload> | undefined;
  if (!payload || payload.version !== "orchestration.plan.execute.v1") {
    return undefined;
  }
  if (
    typeof payload.orchestrationRunId !== "string" ||
    typeof payload.planId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.requestedAt !== "string"
  ) {
    return undefined;
  }
  if (
    !isOptionalString(payload.operatorId) ||
    !isOptionalString(payload.authActorId) ||
    !isOptionalString(payload.authActorSource) ||
    !isOptionalString(payload.permissionProfileId) ||
    !isOptionalString(payload.localOperatorOverrideId)
  ) {
    return undefined;
  }
  return payload as OrchestrationPlanWorkflowPayload;
}

export function buildDurableMetadata(
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    orchestration: {
      planId: plan.planId,
      runId: run.runId,
      workspaceId: run.workspaceId ?? DEFAULT_WORKSPACE_ID,
      executionState: run.executionState ?? "created",
      worktreePath: run.worktreePath ?? null,
      worktreeStatus: run.worktreeStatus ?? "uninitialized",
      worktreeBaseRef: run.worktreeBaseRef ?? DEFAULT_WORKTREE_BASE_REF,
      currentWaveId: run.currentWaveId ?? null,
      currentPhaseId: run.currentPhaseId ?? null,
      pendingApprovalPhaseId: run.pendingApprovalPhaseId ?? null,
      operatorId: run.operatorId ?? null,
      authActorId: run.authActorId ?? null,
      authActorSource: run.authActorSource ?? null,
      permissionProfileId: run.permissionProfileId ?? null,
      localOperatorOverrideId: run.localOperatorOverrideId ?? null,
      ...overrides,
    },
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function buildCheckpointDetails(
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  durableRunId?: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    planState: {
      planId: plan.planId,
      status: run.status,
      currentWaveId: run.currentWaveId ?? null,
      currentPhaseId: run.currentPhaseId ?? null,
      totalIterations: run.totalIterations,
      totalCostUsd: run.totalCostUsd,
    },
    durableWorkerState: {
      durableRunId: durableRunId ?? run.durableRunId ?? null,
      executionState: run.executionState ?? null,
    },
    worktreeState: {
      worktreePath: run.worktreePath ?? null,
      worktreeStatus: run.worktreeStatus ?? null,
      worktreeBaseRef: run.worktreeBaseRef ?? null,
    },
    approvalState: {
      pendingApprovalPhaseId: run.pendingApprovalPhaseId ?? null,
      pendingApprovedBy: run.pendingApprovedBy ?? null,
      pendingCostIncrementUsd: run.pendingCostIncrementUsd ?? null,
    },
    policyState: {
      operatorId: run.operatorId ?? null,
      authActorId: run.authActorId ?? null,
      authActorSource: run.authActorSource ?? null,
      permissionProfileId: run.permissionProfileId ?? null,
      localOperatorOverrideId: run.localOperatorOverrideId ?? null,
    },
    ...extras,
  };
}
