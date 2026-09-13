import { remoteWorkerToolBudgetOperationId, type AsyncStorage } from "@goatcitadel/storage";
import type { LlmService } from "./llm-service.js";
import type { RemoteWorkerToolModelBudgetInput } from "./remote-worker-effect-runtime.js";
import { routeReceiptFor } from "./remote-worker-inference-service.js";

/** A tool's model requests use fresh holds from the same operator grant pool as
 * inference. An initial inference reservation never authorizes a later tool. */
export class RemoteWorkerToolModelBudgetRuntime {
  constructor(private readonly dependencies: {
    storage: Pick<AsyncStorage, "remoteWorkerAssignments" | "remoteWorkerBudgets">;
    llm: Pick<LlmService, "runWithDispatchAuthority">;
  }) {}

  async run<T>(input: RemoteWorkerToolModelBudgetInput, operation: () => Promise<T>): Promise<T> {
    const { storage, llm } = this.dependencies;
    const protectedAuthority = input.fence.protectedAuthority;
    if (!protectedAuthority) throw new Error("Worker tool model dispatch requires protected execution authority.");
    await input.checkExecution();
    const execution = await storage.remoteWorkerAssignments.resolveActiveChatExecution(input.fence, protectedAuthority);
    const manifest = execution.authority.assignment.manifest;
    const key = { registryWorkspaceId: input.fence.registryWorkspaceId, assignmentId: input.fence.assignmentId,
      assignmentGeneration: input.fence.assignmentGeneration, intentId: input.intent.intentId };
    const lineage = { workspaceId: manifest.executionWorkspaceId, sessionId: manifest.sessionId,
      turnId: manifest.turnId, durableRunId: manifest.durableRunId, taskId: manifest.taskId,
      workerId: execution.authority.generation.workerId, contextIntentHash: execution.workload.contextSnapshotSha256,
      parentOperationId: remoteWorkerToolBudgetOperationId(input.intent.intentId) };
    // Recovery may settle completed usage even when no further request is made.
    await storage.remoteWorkerBudgets.reconcileToolAttempts(key);
    let active = true;
    try {
      return await llm.runWithDispatchAuthority(lineage, async (attempt) => {
        if (!active) throw new Error("Worker tool execution has ended.");
        await input.checkExecution();
        await storage.remoteWorkerBudgets.authorizeToolAttempt({ ...key, protectedAuthority,
          leaseTokenSha256: input.fence.leaseTokenSha256, effectSelector: input.intent.effectSelector,
          canonicalArgsSha256: input.intent.canonicalArgsSha256, workerIdempotencyKey: input.intent.workerIdempotencyKey,
          usageEventId: attempt.usageEventId, route: routeReceiptFor(attempt.route) });
      }, operation);
    } finally {
      active = false;
      // Canonical unknown outcomes stay held. This does not synthesize usage or
      // make failed/ambiguous tools retryable; the effect owner retains that truth.
      await storage.remoteWorkerBudgets.reconcileToolAttempts(key);
    }
  }
}
