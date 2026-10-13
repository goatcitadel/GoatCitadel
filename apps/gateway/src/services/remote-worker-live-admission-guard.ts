import type { DurableRunRecord, RemoteWorkerAdmissionReference } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type {
  RemoteWorkerChatAuthorityDependencies,
  RemoteWorkerChatExecution,
} from "./remote-worker-chat-authority.js";

/** Live admission is checked through the Gateway owner; a worker cannot issue it. */
export async function resolveRemoteWorkerLiveAdmissionAuthority(
  dependencies: RemoteWorkerChatAuthorityDependencies,
  execution: RemoteWorkerChatExecution,
  assertCurrent: () => Promise<void>,
) {
  if (!execution.workload.admissionReference) return undefined;
  if (!dependencies.resolveAdmissionAuthority)
    throw new Error("Remote worker admission reference owner is unavailable.");
  await assertCurrent();
  return dependencies.resolveAdmissionAuthority({
    reference: execution.workload.admissionReference,
    durableRunId: execution.workload.durableRunId,
    taskId: execution.authority.assignment.manifest.taskId,
    assertCurrent,
  });
}

export async function assertRemoteWorkerOfferAdmission(
  dependencies: RemoteWorkerChatAuthorityDependencies & { storage: AsyncStorage },
  reference: RemoteWorkerAdmissionReference,
  run: DurableRunRecord,
  taskId: string | undefined,
): Promise<void> {
  if (!dependencies.resolveAdmissionAuthority) throw new Error("Remote Chat admission owner is unavailable.");
  await dependencies.resolveAdmissionAuthority({
    reference,
    durableRunId: run.runId,
    taskId,
    assertCurrent: async () => {
      await dependencies.storage.sessionMutationAdmissions.assertActiveTurnWrite({
        ...reference.scope,
        durableClaim: { durableRunId: run.runId, leaseOwnerId: run.leaseOwnerId!, attemptCount: run.attemptCount },
        requireExactDurablePayloadIdentity: true,
      });
    },
  });
}
