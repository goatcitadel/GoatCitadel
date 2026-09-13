import { createHash } from "node:crypto";
import type { MeshToolCapabilityDescriptor } from "@goatcitadel/contracts";
import { assertWorkerLocalPathPart } from "./worker-local-file-reader.js";
import { snapshotWorkerMeshValue, workerMeshHash, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";
import type { WorkerMeshCapabilityBinding, WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";
import { createWindowsWorkerFileExecutor, type WindowsWorkerFileExecutor } from "./worker-windows-file-executor.js";

const MAX_BYTES = 32 * 1024;
const inputSchema = { type: "object", properties: {
  path: { type: "string", minLength: 1, maxLength: 1024 }, content: { type: "string", maxLength: MAX_BYTES },
  expectedContent: { type: ["string", "null"], maxLength: MAX_BYTES },
}, required: ["path", "content", "expectedContent"], additionalProperties: false };
const outputSchema = { type: "object", properties: {
  path: { type: "string" }, bytes: { type: "integer", minimum: 0, maximum: MAX_BYTES },
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, created: { type: "boolean" },
}, required: ["path", "bytes", "sha256", "created"], additionalProperties: false };

export function createWorkerMeshFileWriteDescriptor(rootId: string): MeshToolCapabilityDescriptor {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(rootId)) throw workerMeshRejected();
  return { kind: "tool", title: "Write a destination workspace file after checking its previous content", semanticVersion: "1.0.0",
    effectPosture: "write_local", idempotency: "none",
    permissions: { schemaVersion: "goatcitadel.mesh-capability-permissions.v1", filesystemRead: [`workspace://${rootId}`],
      filesystemWrite: [`workspace://${rootId}`], networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
    resourceLimits: { timeoutMs: 10_000, maxRequestBytes: 256 * 1024, maxResponseBytes: 8192 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 120_000, timeoutMs: 5_000 },
    inputSchema: structuredClone(inputSchema), outputSchema: structuredClone(outputSchema) };
}

export async function createWorkerMeshFileWriteBinding(input: {
  readonly manifest: WorkerMeshCapabilityBinding["manifest"];
  readonly localId: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly assertConfigurationCurrent: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}, executor: WindowsWorkerFileExecutor = createWindowsWorkerFileExecutor()): Promise<WorkerMeshCapabilityBinding> {
  const manifest = snapshotWorkerMeshValue(input.manifest, 512 * 1024, true);
  const entry = manifest.entries.find((item) => item.localId === input.localId);
  const contract = createWorkerMeshFileWriteDescriptor(input.rootId);
  if (!entry || entry.kind !== "tool" || entry.descriptor.kind !== "tool" ||
    entry.descriptor.semanticVersion !== contract.semanticVersion || entry.descriptor.effectPosture !== contract.effectPosture ||
    entry.descriptor.idempotency !== contract.idempotency ||
    workerMeshHash(entry.descriptor.permissions) !== workerMeshHash(contract.permissions) ||
    workerMeshHash(entry.descriptor.inputSchema) !== workerMeshHash(contract.inputSchema) ||
    workerMeshHash(entry.descriptor.outputSchema) !== workerMeshHash(contract.outputSchema)) throw workerMeshRejected();
  const rootPath = input.rootPath;
  const rootIdentity = await executor.inspect(rootPath, input.signal);
  const assertConfigurationCurrent = input.assertConfigurationCurrent;
  const resolveRequest = (request: WorkerMeshCapabilityExecutionRequest) => {
    if (request.entry.entrySha256 !== entry.entrySha256 || request.envelope.manifestSha256 !== manifest.manifestSha256 ||
      request.envelope.workspaceId !== manifest.workspaceId || request.envelope.nodeId !== manifest.nodeId) throw workerMeshRejected();
    const args = workerMeshRecord(request.input, ["path", "content", "expectedContent"]);
    if (typeof args.path !== "string" || args.path.length > 1024 || typeof args.content !== "string" ||
      (args.expectedContent !== null && typeof args.expectedContent !== "string")) throw workerMeshRejected();
    const parts = args.path.split("/");
    if (parts.length > 32) throw workerMeshRejected();
    for (const part of parts) assertWorkerLocalPathPart(part);
    for (const content of [args.content, args.expectedContent]) {
      if (content !== null && (Buffer.byteLength(content, "utf8") > MAX_BYTES || Buffer.from(content, "utf8").toString("utf8") !== content))
        throw workerMeshRejected();
    }
    return { rootPath, rootIdentity, path: args.path, content: args.content, expectedContent: args.expectedContent };
  };
  const assertCurrent = async (request: WorkerMeshCapabilityExecutionRequest) => {
    request.signal.throwIfAborted();
    resolveRequest(request);
    await assertConfigurationCurrent(request.signal);
    if (await executor.inspect(rootPath, request.signal) !== rootIdentity) throw workerMeshRejected();
    request.signal.throwIfAborted();
  };
  return { manifest, localId: input.localId, owner: {
    assertCurrent,
    execute: async (request) => {
      await assertCurrent(request);
      const target = resolveRequest(request);
      const output = { path: target.path, bytes: Buffer.byteLength(target.content, "utf8"),
        sha256: createHash("sha256").update(target.content, "utf8").digest("hex"), created: target.expectedContent === null };
      // Refuse an impossible published response budget before touching the file.
      snapshotWorkerMeshValue(output, Math.min(entry.descriptor.resourceLimits.maxResponseBytes, 8192));
      await assertConfigurationCurrent(request.signal);
      request.signal.throwIfAborted();
      const result = await executor.write(target, request.signal);
      if (result.error) return { disposition: result.effectStarted ? "unknown" : "failed",
        errorCode: result.effectStarted ? "native_file_write_uncertain" : "native_file_write_refused" };
      if (result.bytes !== output.bytes || result.sha256 !== output.sha256 || result.created !== output.created)
        return { disposition: "unknown", errorCode: "native_file_write_receipt_mismatch" };
      return { disposition: "succeeded", output };
    },
  } };
}
