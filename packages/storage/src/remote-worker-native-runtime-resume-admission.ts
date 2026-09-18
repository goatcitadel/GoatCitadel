import { remoteWorkerAssignmentCanonicalSha256 as digest, type ApprovalRequest } from "@goatcitadel/contracts";
import type { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";

/** Called inside native admission's approval/assignment transaction, before and
 * after capacity writes. The repository owns the active parent and rotated lease;
 * this check binds that execution to the exact canonical native decision. */
export function assertNativeRuntimeChatResume(
  assignments: RemoteWorkerAssignmentRepository,
  command: Parameters<RemoteWorkerAssignmentRepository["resolveActiveChatApprovalResume"]>[0],
  protectedAuthority: Parameters<RemoteWorkerAssignmentRepository["resolveActiveChatApprovalResume"]>[1],
  approval: ApprovalRequest,
): void {
  const resume = assignments.resolveActiveChatApprovalResume(command, protectedAuthority);
  if (approval.status !== "approved" || approval.kind !== "remote_worker.native_runtime" ||
      !resume || resume.material.schemaVersion !== "goatcitadel.remote-worker-native-runtime-resume.v1" ||
      resume.material.approvalId !== approval.approvalId || resume.material.approvalSha256 !== digest(approval) ||
      resume.material.nativeRuntimeBindingSha256 !== digest(approval.payload.nativeRuntime))
    throw new Error("Native runtime admission requires its exact protected Chat resume.");
}
