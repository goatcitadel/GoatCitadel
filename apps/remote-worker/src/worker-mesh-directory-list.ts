import type { MeshToolCapabilityDescriptor } from "@goatcitadel/contracts";
import { assertWorkerLocalPathPart } from "./worker-local-file-reader.js";
import { snapshotWorkerMeshValue, workerMeshHash, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";
import type { WorkerMeshCapabilityBinding, WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";
import { createWindowsWorkerDirectoryExecutor, type WindowsWorkerDirectoryExecutor } from "./worker-windows-file-executor.js";
import { WORKER_DIRECTORY_MAX_ENTRIES, WindowsWorkerDirectoryRefusedError } from "./worker-windows-directory-protocol.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const inputSchema = { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
  required: ["path"], additionalProperties: false };
const outputSchema = { type: "object", properties: {
  path: { type: "string" }, truncated: { type: "boolean" },
  entries: { type: "array", maxItems: WORKER_DIRECTORY_MAX_ENTRIES, items: { type: "object", properties: {
    name: { type: "string", minLength: 1, maxLength: 255 }, type: { enum: ["file", "directory", "unavailable"] },
  }, required: ["name", "type"], additionalProperties: false } },
}, required: ["path", "entries", "truncated"], additionalProperties: false };

export function createWorkerMeshDirectoryListDescriptor(rootId: string): MeshToolCapabilityDescriptor {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(rootId)) throw workerMeshRejected();
  return { kind: "tool", title: "List a destination workspace directory", semanticVersion: "1.0.0",
    effectPosture: "read_only", idempotency: "intrinsic",
    permissions: { schemaVersion: "goatcitadel.mesh-capability-permissions.v1", filesystemRead: [`workspace://${rootId}`],
      filesystemWrite: [], networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
    resourceLimits: { timeoutMs: 10_000, maxRequestBytes: 8192, maxResponseBytes: MAX_RESPONSE_BYTES },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 120_000, timeoutMs: 5_000 },
    inputSchema: structuredClone(inputSchema), outputSchema: structuredClone(outputSchema) };
}

export async function createWorkerMeshDirectoryListBinding(input: {
  readonly manifest: WorkerMeshCapabilityBinding["manifest"];
  readonly localId: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly assertConfigurationCurrent: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}, executor: WindowsWorkerDirectoryExecutor = createWindowsWorkerDirectoryExecutor()): Promise<WorkerMeshCapabilityBinding> {
  const manifest = snapshotWorkerMeshValue(input.manifest, 512 * 1024, true);
  const entry = manifest.entries.find((item) => item.localId === input.localId);
  const contract = createWorkerMeshDirectoryListDescriptor(input.rootId);
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
    const args = workerMeshRecord(request.input, ["path"]);
    if (typeof args.path !== "string" || !args.path || args.path.length > 1024 || Buffer.from(args.path, "utf8").toString("utf8") !== args.path)
      throw workerMeshRejected();
    if (args.path !== ".") {
      const parts = args.path.split("/");
      if (parts.length > 32) throw workerMeshRejected();
      for (const part of parts) assertWorkerLocalPathPart(part);
    }
    return { rootPath, rootIdentity, path: args.path };
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
      await assertConfigurationCurrent(request.signal);
      request.signal.throwIfAborted();
      let result;
      try { result = await executor.list(target, request.signal); }
      catch (error) {
        // A valid native refusal is a completed read with no returned names. It
        // must not strand the worker behind an unknown-effect receipt.
        if (error instanceof WindowsWorkerDirectoryRefusedError)
          return { disposition: "failed", errorCode: "native_directory_list_refused" };
        throw error;
      }
      if (result.rootIdentity !== rootIdentity) throw workerMeshRejected();
      // An observation supplies no later write authority. Recheck local selection
      // after the helper exits before exposing names to the Gateway.
      await assertCurrent(request);
      const output = { path: target.path, entries: result.entries, truncated: result.truncated };
      snapshotWorkerMeshValue(output, Math.min(entry.descriptor.resourceLimits.maxResponseBytes, MAX_RESPONSE_BYTES));
      return { disposition: "succeeded", output };
    },
  } };
}
