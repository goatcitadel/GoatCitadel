import { createHash, randomBytes } from "node:crypto";
import { canonicalJsonString, normalizeRemoteWorkerInstallationReply, normalizeRemoteWorkerCellProvisioningExchange,
  normalizeRemoteWorkerRuntimeInstallRequest, normalizeRemoteWorkerNativePoolSnapshot, normalizeRemoteWorkerNativeCapacityLayout,
  remoteWorkerRuntimeInstallRequestSha256, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  REMOTE_WORKER_INSTALLATION_BUFFER_BYTES, REMOTE_WORKER_INSTALLATION_PAGE_BYTES,
  type RemoteWorkerInstallationAction, type RemoteWorkerRuntimeInstallRequest } from "@goatcitadel/contracts";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { WindowsWorkerInstallationCaptureAdmission } from "./worker-windows-installation-capture.js";
import type { WorkerControllerAttestationTransport } from "./worker-controller-attestation-relay.js";

const refused = () => new Error("Installed worker session differs from its protected Gateway exchange.");
const hex = (value: unknown) => Buffer.from(canonicalJsonString(value)).toString("hex");
function json(value: string): Record<string, unknown> {
  const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex")));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw refused(); return data as Record<string, unknown>;
}

/** Protected RPC client only. It forwards opaque native signatures and never
 * verifies itself into controller authority or manufactures a success reply. */
export async function openWorkerInstallationSession(context: RouteContext, suppliedLease: LeaseBinding,
  suppliedRequest: RemoteWorkerRuntimeInstallRequest, signal: AbortSignal) {
  const lease = Object.freeze({ ...suppliedLease }), request = normalizeRemoteWorkerRuntimeInstallRequest(suppliedRequest);
  const requestSha256 = remoteWorkerRuntimeInstallRequestSha256(request), sessionId = randomBytes(32).toString("hex");
  let sequence = 0, busy = false, closed = false;
  let controller: WorkerControllerAttestationTransport | undefined, connectionNonceHex: string | undefined;
  const control = () => { signal.throwIfAborted(); if (closed) throw refused(); };
  const exchange = async (action: RemoteWorkerInstallationAction, payloadHex = "") => {
    control();
    const submission = Object.freeze({ kind: "runtime.install.session", sessionId, sequence: ++sequence, action, payloadHex });
    const response = await callProtectedRoute({ ...context, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
      operation: "assignment.settlement.submit", idempotencyKey: `installation-session:${sha256Utf8(canonicalJsonString(submission))}`,
      signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...lease, submission } });
    control();
    const body = response.body, reply = normalizeRemoteWorkerInstallationReply(body.installationSession);
    if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
        body.disposition !== "installation_session" || body.registryWorkspaceId !== lease.registryWorkspaceId ||
        reply.sessionId !== sessionId || reply.sequence !== sequence) throw refused();
    return reply;
  };
  const pump = async (action: RemoteWorkerInstallationAction, payload = "") => {
    let reply = await exchange(action, payload);
    while (reply.event === "challenge") {
      if (!controller) throw refused();
      const proof = json(reply.payloadHex);
      if (typeof proof.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(proof.nonce) || !Number.isSafeInteger(proof.ordinal) ||
          (proof.ordinal as number) < 1 || (proof.ordinal as number) > 65536) throw refused();
      const result = await controller.challenge(proof.nonce, proof.ordinal as number, signal);
      reply = await exchange("proof", hex(result));
    }
    return reply;
  };
  let reply = await exchange("prepare", hex({ nonce: request.nonce, requestSha256 }));
  const chunks: Buffer[] = []; let length = 0, expectedLength: number | undefined, expectedHash: string | undefined;
  while (true) {
    if (reply.event !== "material") throw refused();
    const page = json(reply.payloadHex);
    if (page.offset !== length || !Number.isSafeInteger(page.total) || (page.total as number) < 1 ||
        (page.total as number) > REMOTE_WORKER_INSTALLATION_BUFFER_BYTES || typeof page.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(page.sha256) ||
        typeof page.bytesHex !== "string" || !/^(?:[a-f0-9]{2})+$/u.test(page.bytesHex) || page.bytesHex.length > 2 * REMOTE_WORKER_INSTALLATION_PAGE_BYTES ||
        (expectedLength !== undefined && expectedLength !== page.total) || (expectedHash !== undefined && expectedHash !== page.sha256)) throw refused();
    expectedLength = page.total as number; expectedHash = page.sha256;
    const bytes = Buffer.from(page.bytesHex, "hex"); chunks.push(bytes); length += bytes.length;
    if (length > expectedLength) throw refused();
    if (length === expectedLength) break;
    reply = await exchange("material");
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw refused();
  const material = json(bytes.toString("hex"));
  const history = normalizeRemoteWorkerCellProvisioningExchange(material.history);
  const selected = normalizeRemoteWorkerRuntimeInstallRequest(material.request);
  const supplied = material.capture as Record<string, unknown> | undefined;
  if (!supplied || typeof supplied.captureNonce !== "string" || !/^[a-f0-9]{64}$/u.test(supplied.captureNonce) ||
      typeof supplied.referencesJson !== "string" || canonicalJsonString(selected) !== canonicalJsonString(request) ||
      history.registryWorkspaceId !== lease.registryWorkspaceId || history.assignmentId !== lease.assignmentId ||
      history.assignmentGeneration !== lease.assignmentGeneration || history.leaseRevision !== lease.leaseRevision) throw refused();
  const capture = Object.freeze({ pool: normalizeRemoteWorkerNativePoolSnapshot(supplied.pool),
    layout: normalizeRemoteWorkerNativeCapacityLayout(supplied.layout), captureNonce: supplied.captureNonce, referencesJson: supplied.referencesJson });
  const serialize = async (operation: () => Promise<void>) => {
    control(); if (busy) { closed = true; throw refused(); } busy = true;
    try { await operation(); control(); } catch (error) { closed = true; throw error; } finally { busy = false; }
  };
  const admission = Object.freeze<WindowsWorkerInstallationCaptureAdmission>({
    connected: async (nonce, _signal, transport) => serialize(async () => {
      if (controller || !transport || !/^[a-f0-9]{64}$/u.test(nonce)) throw refused();
      transport.signal.throwIfAborted(); controller = transport; connectionNonceHex = nonce;
    }),
    capture: async (responseHex, binding) => serialize(async () => {
      if (!controller || binding.connectionNonceHex !== connectionNonceHex || binding.installationNonce !== request.nonce || binding.requestSha256 !== requestSha256) throw refused();
      const bytes = Buffer.from(responseHex, "hex");
      for (let offset = 0; offset < bytes.length; offset += REMOTE_WORKER_INSTALLATION_PAGE_BYTES) {
        const chunk = bytes.subarray(offset, offset + REMOTE_WORKER_INSTALLATION_PAGE_BYTES);
        const result = await exchange("capture", chunk.toString("hex"));
        if (result.event !== "uploaded" || json(result.payloadHex).offset !== offset + chunk.length) throw refused();
      }
      if ((await pump("start", hex(binding))).event !== "ready") throw refused();
    }),
    verify: async challenge => serialize(async () => {
      if (challenge.byteLength !== 144 || (await pump("verify", Buffer.from(challenge).toString("hex"))).event !== "ready") throw refused();
    }),
    finish: async join => serialize(async () => {
      if ((await pump("finish")).event !== "finish") throw refused();
      await join();
      if ((await exchange("joined")).event !== "complete") throw refused();
    }),
  });
  return Object.freeze({ history, request, capture, admission, close: () => { closed = true; } });
}
