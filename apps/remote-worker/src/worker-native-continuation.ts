import { canonicalJsonString, normalizeRemoteWorkerNativeContinuation, REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
  type RemoteWorkerNativeContinuation } from "@goatcitadel/contracts";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
import { readWorkload } from "./connected-worker-routes.js";
import { normalizeRemoteWorkerNativeChatContext, normalizeRemoteWorkerNativeChatHistory, remoteWorkerNativeChatContextSha256 } from "@goatcitadel/contracts";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";

/** Trusted host composition only. Implementations must bind selection/admission
 * to this exact continuation and retain results through the Gateway. Returning
 * from this owner never settles the parent Chat turn. */
export interface WorkerNativeContinuationOwner {
  run(input: { context: RouteContext; lease: LeaseBinding; owner: WorkerAssignmentLeaseOwner;
    continuation: RemoteWorkerNativeContinuation; signal?: AbortSignal; observed: Record<string, unknown> }): Promise<{ lease: LeaseBinding }>;
}

function verifyNativeWorkload(workload: Record<string, unknown>, lease: LeaseBinding) {
  const continuation = normalizeRemoteWorkerNativeContinuation(workload.nativeContinuation);
  const native = workload.nativeChatContext ? normalizeRemoteWorkerNativeChatContext(workload.nativeChatContext) : undefined;
  const history = Object.hasOwn(workload, "nativeChatHistory") ? normalizeRemoteWorkerNativeChatHistory(workload.nativeChatHistory) : undefined;
  if (history && (!native || history.nativeContextSha256 !== remoteWorkerNativeChatContextSha256(native) ||
    history.contextSnapshotSha256 !== workload.contextSnapshotSha256)) throw new Error("Native history is not bound to this workload.");
  const names = ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentManifestSha256", "durableRunId", "durableRunVersion",
    "durableRunPayloadSha256", "capabilityProfileId", "capabilityProfileSha256", "contextSnapshotSha256"];
  const identity = Object.fromEntries(names.map(name => [name, workload[name]]));
  if (identity.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION ||
      identity.registryWorkspaceId !== lease.registryWorkspaceId || identity.assignmentId !== lease.assignmentId ||
      continuation.assignmentGeneration !== lease.assignmentGeneration ||
      (native && canonicalJsonString(native.continuation) !== canonicalJsonString(continuation)) ||
      sha256Utf8(canonicalJsonString({ ...identity, nativeContinuation: continuation, ...(native ? { nativeChatContext: native } : {}),
        ...(history ? { nativeChatHistory: history } : {}) })) !== workload.workloadSha256)
    throw new Error("Native continuation differs from the assignment workload.");
  return { continuation, native };
}
export async function routeWorkerNativeContinuation(input: {
  workload: Record<string, unknown>; context: RouteContext; lease: LeaseBinding; owner: WorkerAssignmentLeaseOwner;
  nativeRuntime?: WorkerNativeContinuationOwner; signal?: AbortSignal; observed: Record<string, unknown>;
}): Promise<{ kind: "chat"; lease: LeaseBinding; workload: Record<string, unknown> } | { kind: "waiting" }> {
  if (!Object.hasOwn(input.workload, "nativeContinuation")) {
    if (Object.hasOwn(input.workload, "nativeChatContext")) throw new Error("Native Chat context has no continuation.");
    return { kind: "chat", lease: input.lease, workload: input.workload };
  }
  input.signal?.throwIfAborted();
  const { continuation, native } = verifyNativeWorkload(input.workload, input.lease);
  input.observed.nativeContinuation = continuation;
  if (native) return { kind: "chat", lease: input.lease, workload: input.workload };
  if (continuation.decision === "rejected") {
    input.observed.awaiting = "native_parent_continuation";
    return { kind: "waiting" };
  }
  if (!input.nativeRuntime || !input.context.credential.protectedKey || !input.context.protectedKeys) {
    input.observed.awaiting = "native_runtime_owner";
    return { kind: "waiting" };
  }
  const result = await input.nativeRuntime.run({ context: input.context, lease: Object.freeze({ ...input.lease }), owner: input.owner,
    continuation, signal: input.signal, observed: input.observed });
  input.signal?.throwIfAborted();
  if (result.lease.registryWorkspaceId !== input.lease.registryWorkspaceId || result.lease.assignmentId !== input.lease.assignmentId ||
      result.lease.assignmentGeneration !== input.lease.assignmentGeneration || !Number.isSafeInteger(result.lease.leaseRevision) ||
      result.lease.leaseRevision < input.lease.leaseRevision || typeof result.lease.leaseToken !== "string" || !result.lease.leaseToken)
    throw new Error("Native continuation returned a different assignment lease.");
  const stop = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  const refreshed = await readWorkload(input.context, result.lease,
    `native-chat:${sha256Utf8(canonicalJsonString({ continuation, leaseRevision: result.lease.leaseRevision }))}`, stop);
  stop.throwIfAborted();
  const workload = refreshed.body.workload as Record<string, unknown>, next = verifyNativeWorkload(workload, result.lease);
  if (canonicalJsonString(next.continuation) !== canonicalJsonString(continuation)) throw new Error("Native continuation changed before Chat resume.");
  if (!next.native) { input.observed.awaiting = "native_parent_continuation"; return { kind: "waiting" }; }
  input.observed.awaiting = undefined;
  return { kind: "chat", lease: result.lease, workload };
}
