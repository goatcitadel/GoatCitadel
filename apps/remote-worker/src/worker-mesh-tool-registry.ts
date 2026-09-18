import { createHash } from "node:crypto";
import path from "node:path";
import type { MeshCapabilityManifest } from "@goatcitadel/contracts";
import { assertMeshCapabilityManifestDigests } from "@goatcitadel/contracts";
import { readWorkerLocalFile } from "./worker-local-file-reader.js";
import { createWorkerMeshFileReadBinding } from "./worker-mesh-file-read.js";
import { createWorkerMeshFileWriteBinding } from "./worker-mesh-file-write.js";
import { createWorkerMeshDirectoryListBinding } from "./worker-mesh-directory-list.js";
import { createWorkerMeshMcpHttpBinding, type WorkerMcpNativeTool } from "./worker-mesh-mcp-http.js";
import { WorkerMeshCapabilityRuntime, type WorkerMeshCapabilityBinding } from "./worker-mesh-capability-runtime.js";
import { snapshotWorkerMeshValue, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";
import { workerMcpBearerReference } from "./worker-mcp-bearer-credential.js";

export const WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION = "goatcitadel.worker-mesh-tools.v1";
const MAX_REGISTRY_BYTES = 512 * 1024;

export interface WorkerMeshToolRegistryReference { readonly file: string; readonly sha256: string }

/** Operator-owned local configuration is pinned independently of a remote publication.
 * It can only select compiled-in adapters. It cannot provide code, approval or activation. */
export async function loadWorkerMeshToolRegistry(
  reference: WorkerMeshToolRegistryReference,
  scope: { readonly workspaceId: string; readonly nodeId: string },
  signal: AbortSignal,
): Promise<WorkerMeshCapabilityRuntime> {
  const { file, sha256 } = reference;
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw workerMeshRejected();
  const readConfiguration = async (signal: AbortSignal) => {
    const bytes = await readWorkerLocalFile(file, MAX_REGISTRY_BYTES, signal);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw workerMeshRejected();
    return bytes;
  };
  try {
    const bytes = await readConfiguration(signal);
    const configuration = workerMeshRecord(snapshotWorkerMeshValue(JSON.parse(bytes.toString("utf8")), MAX_REGISTRY_BYTES, true),
      ["schemaVersion", "workspaceId", "nodeId", "bindings"]);
    if (configuration.schemaVersion !== WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION ||
      configuration.workspaceId !== scope.workspaceId || configuration.nodeId !== scope.nodeId ||
      !Array.isArray(configuration.bindings) || configuration.bindings.length < 1 || configuration.bindings.length > 32)
      throw workerMeshRejected();
    const bindings: WorkerMeshCapabilityBinding[] = [];
    const credentialFiles: string[] = [], filesystemRoots: string[] = [];
    for (const value of configuration.bindings) {
      const binding = workerMeshRecord(value, ["toolName", "manifest", "localId", "rootId", "rootPath", "endpoint", "tools", "authorization"],
        ["rootId", "rootPath", "endpoint", "tools", "authorization"]);
      if (typeof binding.localId !== "string") throw workerMeshRejected();
      const manifest = binding.manifest as MeshCapabilityManifest;
      assertMeshCapabilityManifestDigests(manifest);
      if (manifest.workspaceId !== scope.workspaceId || manifest.nodeId !== scope.nodeId) throw workerMeshRejected();
      if (binding.toolName === "mcp.http") {
        workerMeshRecord(value, ["toolName", "manifest", "localId", "endpoint", "tools", "authorization"], ["authorization"]);
        if (typeof binding.endpoint !== "string" || !Array.isArray(binding.tools)) throw workerMeshRejected();
        const authorization = binding.authorization === undefined ? undefined : workerMcpBearerReference(binding.authorization);
        if (authorization) credentialFiles.push(authorization.file);
        bindings.push(await createWorkerMeshMcpHttpBinding({ manifest, localId: binding.localId, endpoint: binding.endpoint,
          ...(authorization ? { authorization } : {}),
          tools: binding.tools as WorkerMcpNativeTool[], signal,
          assertConfigurationCurrent: async (signal) => { await readConfiguration(signal); } }));
        continue;
      }
      workerMeshRecord(value, ["toolName", "manifest", "localId", "rootId", "rootPath"]);
      if ((binding.toolName !== "fs.read" && binding.toolName !== "fs.write" && binding.toolName !== "fs.list") ||
        typeof binding.rootId !== "string" || typeof binding.rootPath !== "string") throw workerMeshRejected();
      const createBinding = binding.toolName === "fs.read" ? createWorkerMeshFileReadBinding
        : binding.toolName === "fs.list" ? createWorkerMeshDirectoryListBinding : createWorkerMeshFileWriteBinding;
      filesystemRoots.push(binding.rootPath);
      bindings.push(await createBinding({ manifest, localId: binding.localId,
        rootId: binding.rootId, rootPath: binding.rootPath, signal,
        assertConfigurationCurrent: async (signal) => { await readConfiguration(signal); },
      }));
    }
    for (const root of filesystemRoots) for (const file of credentialFiles) {
      const relative = path.relative(root, file);
      if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)))
        throw workerMeshRejected();
    }
    return new WorkerMeshCapabilityRuntime(bindings);
  } catch {
    throw workerMeshRejected();
  }
}
