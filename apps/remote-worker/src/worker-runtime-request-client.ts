import { createHash, randomBytes } from "node:crypto";
import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_REQUEST_PAGE_BYTES, normalizeRemoteWorkerRuntimeRequestPageSubmission, normalizeRemoteWorkerRuntimeRequestPage,
  type RemoteWorkerRuntimeRequestPage } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerNativeContinuation, type RemoteWorkerNativeContinuation } from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Download only; never starts a process or persists command/environment bytes.
 * Caller holds its current lease for the transfer. Failure requires reconciliation
 * rather than repeating a launch or silently selecting different work. */
export async function downloadWorkerRuntimeRequest(context: RouteContext, lease: LeaseBinding, signal?: AbortSignal,
  suppliedContinuation?: RemoteWorkerNativeContinuation) {
  const binding = Object.freeze({ ...lease }), captured = Object.freeze({ ...context, credential: Object.freeze({ ...context.credential }) });
  const continuation = suppliedContinuation === undefined ? undefined : normalizeRemoteWorkerNativeContinuation(suppliedContinuation);
  if (continuation && (continuation.decision !== "approved" || continuation.assignmentGeneration !== binding.assignmentGeneration))
    throw new Error("Native download requires its approved assignment continuation.");
  const deadline = AbortSignal.timeout(60000), stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const chunks: Buffer[] = []; let first: RemoteWorkerRuntimeRequestPage | undefined;
  for (let offset = 0; !first || offset < first.totalBytes; offset += REMOTE_WORKER_RUNTIME_REQUEST_PAGE_BYTES) {
    stop.throwIfAborted();
    const submission = normalizeRemoteWorkerRuntimeRequestPageSubmission({ kind: "runtime.request.page", offset,
      nonce: first?.expectation.nonce ?? null, requestSha256: first?.expectation.requestSha256 ?? null, challenge: randomBytes(32).toString("hex"),
      ...(continuation ? { continuation } : {}) });
    const pageStop = AbortSignal.any([stop, AbortSignal.timeout(5000)]);
    const response = await callProtectedRoute({ ...captured, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
      operation: "assignment.settlement.submit", idempotencyKey: `runtime-request:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
        assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
      signal: pageStop, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
    pageStop.throwIfAborted();
    const body = response.body, page = normalizeRemoteWorkerRuntimeRequestPage(body.runtimeRequestPage);
    if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
        body.disposition !== "runtime_request_page" || body.registryWorkspaceId !== binding.registryWorkspaceId ||
        page.registryWorkspaceId !== binding.registryWorkspaceId || page.assignmentId !== binding.assignmentId ||
        page.assignmentGeneration !== binding.assignmentGeneration || page.leaseRevision !== binding.leaseRevision ||
        canonicalJsonString(page.submission) !== canonicalJsonString(submission) || (first && (page.totalBytes !== first.totalBytes ||
          page.jsonSha256 !== first.jsonSha256 || canonicalJsonString(page.expectation) !== canonicalJsonString(first.expectation))))
      throw new Error("Native request page does not bind this download.");
    first ??= page; chunks.push(Buffer.from(page.bytesHex, "hex"));
  }
  stop.throwIfAborted();
  const bytes = Buffer.concat(chunks);
  if (!first || bytes.length !== first.totalBytes || createHash("sha256").update(bytes).digest("hex") !== first.jsonSha256)
    throw new Error("Native request download is incomplete or changed.");
  const request = normalizeWindowsRuntimeDispatch(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (canonicalJsonString(prepareWindowsRuntimeDispatch(request).expectation) !== canonicalJsonString(first.expectation))
    throw new Error("Downloaded executable bytes differ from their admitted expectation.");
  stop.throwIfAborted();
  return Object.freeze({ request, expected: first.expectation });
}
