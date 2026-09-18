import { canonicalJsonString } from "@goatcitadel/contracts";
import {
  RemoteWorkerInferenceRuntime,
  type RemoteWorkerInferenceRuntimeDependencies,
} from "./remote-worker-inference-runtime.js";
import { projectRemoteWorkerNativeChatWorkload } from "./remote-worker-native-chat-workload.js";
import { RemoteWorkerArtifactRuntime } from "./remote-worker-artifact-runtime.js";
import { RemoteWorkerNativeArtifactStore } from "./remote-worker-native-artifact-store.js";
import { RemoteWorkerNativeArtifactSettlement } from "./remote-worker-native-artifact-settlement.js";
import { createRemoteWorkerNativeFileReconciler } from "./remote-worker-native-file-reconciliation.js";
import { RemoteWorkerNativeFileTransferService } from "./remote-worker-native-file-transfer.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { RemoteWorkerChatToolRuntime } from "./remote-worker-chat-tool-runtime.js";
import { RemoteWorkerToolModelBudgetRuntime } from "./remote-worker-tool-model-budget-runtime.js";
import {
  RemoteWorkerEffectRuntime,
  type RemoteWorkerEffectRuntimeDependencies,
} from "./remote-worker-effect-runtime.js";
import type { AsyncStorage } from "@goatcitadel/storage";
import { snapshotRemoteWorkerNativeCapacityPageAssignment, snapshotRemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import { normalizeRemoteWorkerNativePoolPageSubmission, normalizeRemoteWorkerNativePoolCleanupPageSubmission } from "@goatcitadel/contracts";
import type { LlmService } from "./llm-service.js";
import type { RemoteWorkerAssignmentExecutionOwnerDependencies } from "./remote-worker-assignment-runtime-composition.js";
import { REMOTE_WORKER_NATIVE_CELL_POLICY } from "./remote-worker-native-cell-policy.js";
import { RemoteWorkerRuntimeRequestProducer } from "./remote-worker-runtime-request-producer.js";
import { RemoteWorkerRuntimeInstallReviewService } from "./remote-worker-runtime-install-review-service.js";
import { RemoteWorkerInstallationCapacityOwner, type RemoteWorkerInstallationPolicy } from "./remote-worker-installation-capacity-owner.js";
import { RemoteWorkerInstallationSessionOwner } from "./remote-worker-installation-session.js";
import { RemoteWorkerInstallationRpc } from "./remote-worker-installation-rpc.js";
import { RemoteWorkerNativeFileOperator } from "./remote-worker-native-file-operator.js";
import type { RemoteWorkerNativeRuntimePolicyPort } from "./remote-worker-native-runtime-policy.js";
import { RemoteWorkerNativeReviewOperator } from "./remote-worker-native-review-operator.js";
import { createRemoteWorkerRuntimeReadOwners } from "./remote-worker-runtime-cleanup.js";
import { createRemoteWorkerRuntimeOutputRetainer } from "./remote-worker-runtime-output.js";
import { createRemoteWorkerNativeFileValidator, type RemoteWorkerNativeFileValidationPort } from "./remote-worker-native-file-validation.js";
import type { ApprovalRuntime } from "./approval-runtime-service.js";

export interface RemoteWorkerExecutionOwnersDependencies
  extends RemoteWorkerInferenceRuntimeDependencies, Omit<RemoteWorkerEffectRuntimeDependencies, "withToolModelBudget"> {
  storage: AsyncStorage;
  llm: Pick<LlmService, "resolveDispatchRoute" | "chatCompletionsWithDispatchGuard" | "runWithDispatchAuthority">;
  artifactRoot: string;
  approvals: Pick<ApprovalRuntime, "createApproval">;
  nativeRuntimePolicy?: RemoteWorkerNativeRuntimePolicyPort;
  nativeInstallationPolicy?: RemoteWorkerInstallationPolicy;
}

/** Shared by the native Gateway composition and its connected-process proof. */
export function createRemoteWorkerExecutionOwners(
  dependencies: RemoteWorkerExecutionOwnersDependencies,
): RemoteWorkerAssignmentExecutionOwnerDependencies & { readonly nativeRuntimeRequests: RemoteWorkerRuntimeRequestProducer;
  readonly nativeInstallationReviews: RemoteWorkerRuntimeInstallReviewService;
  readonly nativeInstallationReservations: RemoteWorkerInstallationCapacityOwner;
  readonly nativeInstallationSessions: RemoteWorkerInstallationSessionOwner;
  readonly nativeFiles: RemoteWorkerNativeFileValidationPort; readonly nativeArtifacts: RemoteWorkerNativeArtifactStore;
  readonly nativeArtifactSettlement: RemoteWorkerNativeArtifactSettlement; readonly nativeFileTransfers: RemoteWorkerNativeFileTransferService;
  readonly operatorNativeFiles: RemoteWorkerNativeFileOperator; readonly operatorNativeRuntime: RemoteWorkerNativeReviewOperator } {
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
  const nativeRuntimeRequests = new RemoteWorkerRuntimeRequestProducer(dependencies.storage, dependencies.approvals, {
    authorize: async input => {
      if (!dependencies.nativeRuntimePolicy) throw new Error("Native runtime requires its Gateway policy owner.");
      await dependencies.nativeRuntimePolicy.authorize(input);
    },
    admit: async input => {
      if (!dependencies.nativeRuntimePolicy) throw new Error("Native admission requires its Gateway policy owner.");
      return dependencies.nativeRuntimePolicy.admit(input);
    },
    authorizeAdmitted: async input => {
      if (!dependencies.nativeRuntimePolicy) throw new Error("Native authorization requires its Gateway policy owner.");
      await dependencies.nativeRuntimePolicy.authorizeAdmitted(input);
    },
  });
  const nativeInstallationReviews = new RemoteWorkerRuntimeInstallReviewService(dependencies.storage, dependencies.approvals);
  const installationPolicy = dependencies.nativeInstallationPolicy;
  const nativeInstallationReservations = new RemoteWorkerInstallationCapacityOwner(dependencies.storage, {
    verify: async (selection, signal) => {
      if (!installationPolicy) throw new Error("Installation reservation requires its current Gateway policy owner.");
      await installationPolicy.verify(selection, signal);
    },
  });
  const nativeFiles = createRemoteWorkerNativeFileValidator(dependencies.storage);
  const nativeInstallationSessions = new RemoteWorkerInstallationSessionOwner(nativeInstallationReservations, dependencies.storage);
  const installationSessions = new RemoteWorkerInstallationRpc(dependencies.storage, nativeInstallationSessions);
  const operatorNativeRuntime = new RemoteWorkerNativeReviewOperator(nativeRuntimeRequests, undefined, nativeInstallationReviews);
  const nativeCas = new RemoteWorkerArtifactStore(dependencies.artifactRoot);
  const nativeArtifacts = new RemoteWorkerNativeArtifactStore(dependencies.storage, nativeFiles, nativeCas);
  const nativeArtifactSettlement = new RemoteWorkerNativeArtifactSettlement(dependencies.storage, nativeArtifacts, nativeCas);
  const nativeFileTransfers = new RemoteWorkerNativeFileTransferService(dependencies.storage, nativeArtifacts, nativeArtifactSettlement);
  return {
    nativeRuntimeRequests,
    nativeInstallationReviews,
    nativeInstallationReservations,
    nativeInstallationSessions,
    operatorNativeRuntime,
    nativeFiles,
    nativeArtifacts,
    nativeArtifactSettlement,
    nativeFileTransfers,
    operatorNativeFiles: new RemoteWorkerNativeFileOperator(dependencies.storage.remoteWorkerNativeFileReceipts, nativeCas),
    projectWorkload: (workload, scope) => projectRemoteWorkerNativeChatWorkload(dependencies.storage, workload, scope),
    inference: new RemoteWorkerInferenceRuntime(dependencies),
    settlement: {
      installationSessions,
      nativeReviewAuthority: operatorNativeRuntime,
      nativeFileReconciliation: createRemoteWorkerNativeFileReconciler(dependencies.storage, nativeArtifactSettlement, nativeFileTransfers),
      nativeFileTransfers,
      nativeFileAuthorization: nativeArtifacts,
      nativeCapacityPages: {
        exchange: async ({ signal, ...input }) => {
          const command = snapshotRemoteWorkerNativeCapacityPageAssignment(input);
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerNativeCapacityPages.exchangeWithAssignment(command);
          signal?.throwIfAborted();
          return result;
        },
      },
      nativePool: {
        read: async ({ signal, submission, ...input }) => {
          const authority = snapshotRemoteWorkerCellCapacityAuthority(input);
          signal?.throwIfAborted();
          const result = submission.kind === "cell.native_pool.cleanup.page"
            ? await dependencies.storage.remoteWorkerNativePools.readCleanupPageForAssignment({ ...authority, submission: normalizeRemoteWorkerNativePoolCleanupPageSubmission(submission) })
            : await dependencies.storage.remoteWorkerNativePools.readPageForAssignment({ ...authority, submission: normalizeRemoteWorkerNativePoolPageSubmission(submission) });
          signal?.throwIfAborted();
          return result;
        },
      },
      runtimeRequests: nativeRuntimeRequests,
      ...createRemoteWorkerRuntimeReadOwners(dependencies.storage),
      runtimeOutputs: createRemoteWorkerRuntimeOutputRetainer(dependencies.storage),
      artifacts: new RemoteWorkerArtifactRuntime(dependencies.storage, dependencies.artifactRoot),
      effects,
      chatTools: new RemoteWorkerChatToolRuntime({ ...dependencies, effects }),
      cellBackingCapacity: {
        exchange: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerCellBackingCapacity.exchangeWithAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
      },
      cellCapacity: {
        exchange: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerCellCapacity.exchangeWithAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
      },
      cellObjectInventory: {
        exchange: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerCellCapacity.exchangeInventoryWithAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
      },
      cellObjectInventoryPages: {
        exchange: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerCellCapacity.exchangeInventoryPageWithAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
      },
      runtimeResults: {
        exchange: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerRuntimeResults.exchangePageForAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
      },
      runtimeInstalls: {
        select: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerRuntimeInstalls.selectForAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
        exchange: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerRuntimeInstalls.exchangeForAssignment(input);
          signal?.throwIfAborted();
          return result;
        },
      },
      runtimeAuthorization: {
        authorize: async ({ signal, ...input }) => {
          signal?.throwIfAborted();
          const result = await dependencies.storage.remoteWorkerRuntimeResults.authorizeForAssignment(input);
          signal?.throwIfAborted();
          const expected = canonicalJsonString(result);
          await nativeRuntimeRequests.authorizePolicyForRequest({ ...input, signal });
          const current = await dependencies.storage.remoteWorkerRuntimeResults.authorizeForAssignment(input);
          if (canonicalJsonString(current) !== expected) throw new Error("Native execution authority changed during policy evaluation.");
          signal?.throwIfAborted();
          return result;
        },
      },
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
