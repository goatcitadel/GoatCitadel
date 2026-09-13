import {
  RemoteWorkerInferenceRuntime,
  type RemoteWorkerInferenceRuntimeDependencies,
} from "./remote-worker-inference-runtime.js";
import { RemoteWorkerArtifactRuntime } from "./remote-worker-artifact-runtime.js";
import { RemoteWorkerChatToolRuntime } from "./remote-worker-chat-tool-runtime.js";
import { RemoteWorkerToolModelBudgetRuntime } from "./remote-worker-tool-model-budget-runtime.js";
import {
  RemoteWorkerEffectRuntime,
  type RemoteWorkerEffectRuntimeDependencies,
} from "./remote-worker-effect-runtime.js";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { LlmService } from "./llm-service.js";
import type { RemoteWorkerAssignmentExecutionOwnerDependencies } from "./remote-worker-assignment-runtime-composition.js";
import { REMOTE_WORKER_NATIVE_CELL_POLICY } from "./remote-worker-native-cell-policy.js";

export interface RemoteWorkerExecutionOwnersDependencies
  extends RemoteWorkerInferenceRuntimeDependencies, Omit<RemoteWorkerEffectRuntimeDependencies, "withToolModelBudget"> {
  storage: AsyncStorage;
  llm: Pick<LlmService, "resolveDispatchRoute" | "chatCompletionsWithDispatchGuard" | "runWithDispatchAuthority">;
  artifactRoot: string;
}

/** Shared by the native Gateway composition and its connected-process proof. */
export function createRemoteWorkerExecutionOwners(
  dependencies: RemoteWorkerExecutionOwnersDependencies,
): RemoteWorkerAssignmentExecutionOwnerDependencies {
  const modelBudgets = new RemoteWorkerToolModelBudgetRuntime(dependencies);
  // Both explicit effects and retained model-call selections share this owner.
  const effectRuntime = new RemoteWorkerEffectRuntime({ ...dependencies,
    withToolModelBudget: (input, operation) => modelBudgets.run(input, operation),
  });
  const effects = {
    dispatchEffect: async (input: Parameters<RemoteWorkerEffectRuntime["dispatchEffect"]>[0]) => {
      const result = await effectRuntime.dispatchEffect(input);
      // Terminal replay may bypass the coordinator entirely. Settle already
      // recorded usage on this path as well, without renewing execution authority.
      await dependencies.storage.remoteWorkerBudgets.reconcileToolAttempts({
        registryWorkspaceId: input.fence.registryWorkspaceId, assignmentId: input.fence.assignmentId,
        assignmentGeneration: input.fence.assignmentGeneration, intentId: result.intentId,
      });
      return result;
    },
  };
  return {
    inference: new RemoteWorkerInferenceRuntime(dependencies),
    settlement: {
      artifacts: new RemoteWorkerArtifactRuntime(dependencies.storage, dependencies.artifactRoot),
      effects,
      chatTools: new RemoteWorkerChatToolRuntime({ ...dependencies, effects }),
      cellProvisioning: {
        prepare: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerCellProvisioning.prepareForAssignment({
            ...input, policy: REMOTE_WORKER_NATIVE_CELL_POLICY });
          signal?.throwIfAborted();
          return result;
        },
        exchange: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerCellProvisioning.exchangeWithAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
      },
    },
  };
}
