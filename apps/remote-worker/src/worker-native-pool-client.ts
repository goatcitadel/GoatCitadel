import { randomUUID } from "node:crypto";
import { assembleRemoteWorkerNativePoolPages, canonicalJsonString, normalizeRemoteWorkerNativePoolPage,
  assembleRemoteWorkerNativePoolCleanupPages, type RemoteWorkerNativePoolCleanupSnapshot, type RemoteWorkerNativePoolCleanupPageSubmission,
  REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  type RemoteWorkerNativePoolPage, type RemoteWorkerNativePoolPageSubmission, type RemoteWorkerNativePoolSnapshot } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Caller retains its stable lease through collection and consumption. The
 * read-only authority callback must not renew that lease or write local state.
 * A failed or changed transfer is discarded; it never becomes partial evidence. */
interface NativePoolReadInput {
  readonly context: RouteContext;
  readonly lease: LeaseBinding;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
}
export function readWorkerNativePoolOnLease(input: NativePoolReadInput): Promise<RemoteWorkerNativePoolSnapshot> {
  return read(input, "cell.native_pool.page", "native_pool_page", assembleRemoteWorkerNativePoolPages, value => value);
}
export function readWorkerNativePoolCleanupOnLease(input: NativePoolReadInput): Promise<RemoteWorkerNativePoolCleanupSnapshot> {
  return read(input, "cell.native_pool.cleanup.page", "native_pool_cleanup_page", assembleRemoteWorkerNativePoolCleanupPages, value => value.pool);
}
async function read<T>(input: NativePoolReadInput,
  kind: RemoteWorkerNativePoolPageSubmission["kind"] | RemoteWorkerNativePoolCleanupPageSubmission["kind"],
  disposition: "native_pool_page" | "native_pool_cleanup_page", assemble: (pages: readonly RemoteWorkerNativePoolPage[]) => T,
  poolOf: (value: T) => RemoteWorkerNativePoolSnapshot): Promise<T> {
  const { signal, assertCurrent } = input;
  const context = Object.freeze({ ...input.context, credential: Object.freeze({ ...input.context.credential }) });
  const lease = Object.freeze({ ...input.lease });
  if (lease.registryWorkspaceId !== context.credential.registryWorkspaceId ||
      !Number.isSafeInteger(context.credential.workerGeneration) || context.credential.workerGeneration < 1)
    throw new Error("Native pool read differs from its retained worker credential.");
  const check = async () => { signal.throwIfAborted(); await assertCurrent(); signal.throwIfAborted(); };
  const requestId = randomUUID(), pages: RemoteWorkerNativePoolPage[] = [];
  let offset = 0, byteLength = 1, snapshotSha256: string | null = null;
  while (offset < byteLength) {
    await check();
    const submission = Object.freeze({ kind, offset, snapshotSha256 });
    const response = await callProtectedRoute({ ...context,
      rawPath: "/api/v1/remote-workers/assignment-settlement-submissions", operation: "assignment.settlement.submit",
      idempotencyKey: `native-pool:${sha256Utf8(canonicalJsonString({ requestId, registryWorkspaceId: lease.registryWorkspaceId,
        assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration, leaseRevision: lease.leaseRevision, submission }))}`,
      signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...lease, submission } });
    await check();
    const body = response.body;
    if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
        body.disposition !== disposition || body.registryWorkspaceId !== lease.registryWorkspaceId)
      throw new Error("Native pool page response differs from the protected request.");
    const page = normalizeRemoteWorkerNativePoolPage(body.nativePoolPage);
    if (page.offset !== offset || (snapshotSha256 !== null && (page.snapshotSha256 !== snapshotSha256 || page.byteLength !== byteLength)))
      throw new Error("Native pool snapshot changed during transfer.");
    snapshotSha256 = page.snapshotSha256;
    byteLength = page.byteLength;
    pages.push(page);
    offset += REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES;
  }
  const result = assemble(pages), snapshot = poolOf(result);
  if (snapshot.registryWorkspaceId !== lease.registryWorkspaceId || snapshot.assignmentId !== lease.assignmentId ||
      snapshot.assignmentGeneration !== lease.assignmentGeneration || snapshot.leaseRevision !== lease.leaseRevision ||
      snapshot.workerGeneration !== context.credential.workerGeneration)
    throw new Error("Native pool snapshot differs from its current assignment or worker generation.");
  await check();
  return result;
}
