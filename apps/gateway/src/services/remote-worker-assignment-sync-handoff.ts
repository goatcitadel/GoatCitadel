import type { ResolvedRemoteWorkerAssignmentParentRecovery } from "@goatcitadel/contracts";
import type {
  RemoteWorkerAssignmentProtectedCommitFence,
  ResolveRemoteWorkerAssignmentControlReadInput,
} from "@goatcitadel/storage";
import type { RemoteWorkerChatApprovalWaitReadPort } from "./remote-worker-chat-approval-wait-read-service.js";

interface HandoffDependencies {
  readonly assignments: {
    resolveChatParentRecoveryByLeaseTokenHash(
      input: ResolveRemoteWorkerAssignmentControlReadInput,
      fence: RemoteWorkerAssignmentProtectedCommitFence,
    ): ResolvedRemoteWorkerAssignmentParentRecovery | undefined | Promise<ResolvedRemoteWorkerAssignmentParentRecovery | undefined>;
  };
  readonly approvalWait?: RemoteWorkerChatApprovalWaitReadPort;
}

/** Parent recovery takes precedence over approval waiting. These reads neither
 * renew a lease nor wake a run; the protocol retains exact response validation. */
export async function readWorkerAssignmentSyncHandoff(
  deps: HandoffDependencies,
  input: ResolveRemoteWorkerAssignmentControlReadInput,
  fence: RemoteWorkerAssignmentProtectedCommitFence,
) {
  const recovery = await deps.assignments.resolveChatParentRecoveryByLeaseTokenHash(input, fence);
  if (recovery) return { recovery, waiting: undefined };
  return { recovery: undefined, waiting: await deps.approvalWait?.read(input, fence) };
}
