import type { BigIntStats } from "node:fs";
import path from "node:path";
import type { MeshToolCapabilityDescriptor } from "@goatcitadel/contracts";
import { assertWorkerLocalPathPart, inspectWorkerLocalPath, readWorkerLocalFile, sameWorkerLocalFile } from "./worker-local-file-reader.js";
import { snapshotWorkerMeshValue, workerMeshHash, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";
import type { WorkerMeshCapabilityBinding, WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";

export const WORKER_MESH_FILE_READ_MAX_BYTES = 32 * 1024;
const inputSchema = { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
  required: ["path"], additionalProperties: false };
const outputSchema = { type: "object", properties: {
  path: { type: "string" }, bytes: { type: "integer", minimum: 0, maximum: WORKER_MESH_FILE_READ_MAX_BYTES },
  content: { type: "string" },
}, required: ["path", "bytes", "content"], additionalProperties: false };

/** Native contract of the shipped reader; publishers can narrow limits, not invent tool behavior. */
export function createWorkerMeshFileReadDescriptor(rootId: string): MeshToolCapabilityDescriptor {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(rootId)) throw workerMeshRejected();
  return {
    kind: "tool", title: "Read a destination workspace file", semanticVersion: "1.0.0",
    effectPosture: "read_only", idempotency: "intrinsic",
    permissions: { schemaVersion: "goatcitadel.mesh-capability-permissions.v1", filesystemRead: [`workspace://${rootId}`],
      filesystemWrite: [], networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
    resourceLimits: { timeoutMs: 10_000, maxRequestBytes: 2048, maxResponseBytes: 64 * 1024 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 120_000, timeoutMs: 5_000 },
    inputSchema: structuredClone(inputSchema), outputSchema: structuredClone(outputSchema),
  };
}

export async function createWorkerMeshFileReadBinding(input: {
  readonly manifest: WorkerMeshCapabilityBinding["manifest"];
  readonly localId: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly assertConfigurationCurrent: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<WorkerMeshCapabilityBinding> {
  const manifest = snapshotWorkerMeshValue(input.manifest, 512 * 1024, true);
  const entry = manifest.entries.find((item) => item.localId === input.localId);
  const contract = createWorkerMeshFileReadDescriptor(input.rootId);
  if (!entry || entry.kind !== "tool" || entry.descriptor.kind !== "tool" ||
    entry.descriptor.semanticVersion !== contract.semanticVersion || entry.descriptor.effectPosture !== contract.effectPosture ||
    entry.descriptor.idempotency !== contract.idempotency ||
    workerMeshHash(entry.descriptor.permissions) !== workerMeshHash(contract.permissions) ||
    workerMeshHash(entry.descriptor.inputSchema) !== workerMeshHash(contract.inputSchema) ||
    workerMeshHash(entry.descriptor.outputSchema) !== workerMeshHash(contract.outputSchema)) throw workerMeshRejected();
  const rootPath = input.rootPath;
  const rootIdentity = await inspectWorkerLocalPath(rootPath, input.signal);
  if (!rootIdentity.isDirectory() || rootPath === path.parse(rootPath).root) throw workerMeshRejected();
  const assertConfigurationCurrent = input.assertConfigurationCurrent;
  const checkRoot = async (signal: AbortSignal): Promise<BigIntStats> => {
    const current = await inspectWorkerLocalPath(rootPath, signal);
    if (!current.isDirectory() || !sameWorkerLocalFile(current, rootIdentity)) throw workerMeshRejected();
    return current;
  };
  const resolveRequest = (request: WorkerMeshCapabilityExecutionRequest) => {
    if (request.entry.entrySha256 !== entry.entrySha256 || request.envelope.manifestSha256 !== manifest.manifestSha256 ||
      request.envelope.workspaceId !== manifest.workspaceId || request.envelope.nodeId !== manifest.nodeId) throw workerMeshRejected();
    const args = workerMeshRecord(request.input, ["path"]);
    if (typeof args.path !== "string" || args.path.length > 1024) throw workerMeshRejected();
    const parts = args.path.split("/");
    for (const part of parts) assertWorkerLocalPathPart(part);
    return { relativePath: args.path, file: path.join(rootPath, ...parts) };
  };
  const assertCurrent = async (request: WorkerMeshCapabilityExecutionRequest) => {
    request.signal.throwIfAborted();
    resolveRequest(request);
    await assertConfigurationCurrent(request.signal);
    await checkRoot(request.signal);
  };
  return { manifest, localId: input.localId, owner: {
    assertCurrent,
    execute: async (request) => {
      await assertCurrent(request);
      const target = resolveRequest(request);
      const bytes = await readWorkerLocalFile(target.file, WORKER_MESH_FILE_READ_MAX_BYTES, request.signal, async () => {
        await checkRoot(request.signal);
        await assertConfigurationCurrent(request.signal);
      });
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const output = { path: target.relativePath, bytes: bytes.length, content };
      snapshotWorkerMeshValue(output, Math.min(entry.descriptor.resourceLimits.maxResponseBytes, 64 * 1024));
      request.signal.throwIfAborted();
      return { disposition: "succeeded", output };
    },
  } };
}
