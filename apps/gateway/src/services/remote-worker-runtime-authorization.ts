import { normalizeRemoteWorkerRuntimeAuthorizationSubmission, normalizeRemoteWorkerRuntimeAuthorizationReceipt,
  REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION, type RemoteWorkerRuntimeAuthorizationSubmission,
  type RemoteWorkerRuntimeResultExpectation } from "@goatcitadel/contracts";
import type { RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";
type RemoteWorkerRuntimeResultAuthority = Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission">;

export interface RemoteWorkerRuntimeAuthorizationPort {
  authorize(input: RemoteWorkerRuntimeResultAuthority & { nonce: string; requestSha256: string; phase: "execution" | "delivery"; signal?: AbortSignal }):
    RemoteWorkerRuntimeResultExpectation | Promise<RemoteWorkerRuntimeResultExpectation>;
}
export async function authorizeRemoteWorkerRuntime(owner: RemoteWorkerRuntimeAuthorizationPort | undefined,
  input: RemoteWorkerRuntimeResultAuthority & { submission: RemoteWorkerRuntimeAuthorizationSubmission; signal?: AbortSignal }) {
  if (!owner || !input.protectedAuthority) throw rejected("Native runtime authorization is unavailable.");
  const submission = normalizeRemoteWorkerRuntimeAuthorizationSubmission(input.submission);
  const binding = Object.freeze({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId,
    assignmentGeneration: input.assignmentGeneration, leaseRevision: input.leaseRevision });
  const authority = { ...binding, leaseTokenSha256: input.leaseTokenSha256, protectedAuthority: Object.freeze({
    credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }), meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }),
    nonce: submission.nonce, requestSha256: submission.requestSha256, phase: submission.phase, signal: input.signal };
  authority.signal?.throwIfAborted();
  const expectation = await owner.authorize(Object.freeze(authority));
  authority.signal?.throwIfAborted();
  return normalizeRemoteWorkerRuntimeAuthorizationReceipt({ schemaVersion: REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION,
    ...binding, submission, expectation });
}
