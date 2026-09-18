import { describe, expect, it } from "vitest";
import { MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, type MeshCapabilityManifest } from "@goatcitadel/contracts";
import { createWorkerMeshDirectoryListBinding, createWorkerMeshDirectoryListDescriptor } from "./worker-mesh-directory-list.js";
import { workerMeshHash } from "./worker-mesh-capability-data.js";
import type { WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";
import { WindowsWorkerDirectoryRefusedError, type WindowsWorkerDirectoryResult } from "./worker-windows-directory-protocol.js";

async function fixture() {
  const descriptor = createWorkerMeshDirectoryListDescriptor("documents");
  const unsignedEntry = { localId: "directory.list", kind: "tool" as const, capabilityId: "mesh:node-a:tool:directory.list",
    descriptor, descriptorSha256: workerMeshHash(descriptor), permissionEnvelopeSha256: workerMeshHash(descriptor.permissions) };
  const entry = { ...unsignedEntry, entrySha256: workerMeshHash(unsignedEntry) };
  const unsigned = { schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, workspaceId: "workspace-a", nodeId: "node-a",
    admissionGeneration: 1, publisherGeneration: 1, publicationKey: "list-files", publicationLeaseFencingToken: 1,
    entries: [entry], createdAt: new Date().toISOString() };
  const manifest: MeshCapabilityManifest = { ...unsigned, manifestSha256: workerMeshHash(unsigned) };
  let currentIdentity = "01".repeat(24), checks = 0, lists = 0, revokedAt = Infinity;
  let afterList = () => undefined;
  let result: Partial<WindowsWorkerDirectoryResult> = {};
  const configuration = { manifest, localId: entry.localId, rootId: "documents", rootPath: "C:\\workspace\\documents",
    signal: new AbortController().signal, assertConfigurationCurrent: async () => {
      if (++checks >= revokedAt) throw new Error("revoked");
    } };
  const executor = { inspect: async () => currentIdentity,
    list: async (input: { path: string; rootIdentity: string }): Promise<WindowsWorkerDirectoryResult> => {
      lists++;
      expect(input.rootIdentity).toBe("01".repeat(24));
      afterList();
      return { rootIdentity: "01".repeat(24), entries: [{ name: "note.txt", type: "file" }], truncated: false, ...result };
    } };
  const binding = await createWorkerMeshDirectoryListBinding(configuration, executor);
  const request = (args: Record<string, unknown> = { path: "." }): WorkerMeshCapabilityExecutionRequest => ({
    entry, input: args, signal: new AbortController().signal,
    envelope: { manifestSha256: manifest.manifestSha256, workspaceId: manifest.workspaceId,
      nodeId: manifest.nodeId } as WorkerMeshCapabilityExecutionRequest["envelope"],
  });
  return { binding, request, configuration, executor, entry, lists: () => lists,
    replaceRoot: () => { currentIdentity = "02".repeat(24); }, revokeAt: (check: number) => { revokedAt = check; },
    afterList: (action: () => undefined) => { afterList = action; },
    result: (value: Partial<WindowsWorkerDirectoryResult>) => { result = value; } };
}

describe("governed destination directory listing", () => {
  it("requires read-only root permission and returns relative names with explicit truncation", async () => {
    const f = await fixture();
    expect(f.entry.descriptor.effectPosture).toBe("read_only");
    expect(f.entry.descriptor.permissions.filesystemWrite).toEqual([]);
    for (const path of [".", "nested/folder"]) {
      f.result({ truncated: true });
      expect(await f.binding.owner.execute(f.request({ path }))).toEqual({ disposition: "succeeded",
        output: { path, entries: [{ name: "note.txt", type: "file" }], truncated: true } });
    }
  });
  it.each(["permissions", "inputSchema", "outputSchema", "effectPosture", "idempotency", "semanticVersion"])(
    "refuses a publication that invents %s", async field => {
      const f = await fixture();
      Object.assign(f.entry.descriptor, { [field]: field.endsWith("Schema") ? { type: "object" }
        : field === "permissions" ? { ...f.entry.descriptor.permissions, filesystemWrite: ["workspace://documents"] } : "other" });
      await expect(createWorkerMeshDirectoryListBinding(f.configuration, f.executor)).rejects.toThrow();
      expect(f.lists()).toBe(0);
    });
  it.each(["", "..", "../outside", "folder/../x", "/", "C:/outside", "a:stream", "folder\\x", "NUL", "folder/", "x//z", "x.", "\ud800"])(
    "refuses unsafe input %j before execution", async path => {
      const f = await fixture();
      await expect(f.binding.owner.execute(f.request({ path }))).rejects.toThrow();
      expect(f.lists()).toBe(0);
    });
  it("does not allow recursive flags, root replacement, mismatched scope, or cancelled requests", async () => {
    for (const change of ["extension", "root", "scope", "configuration", "cancel"] as const) {
      const f = await fixture(), request = f.request();
      if (change === "extension") Object.assign(request.input, { recursive: true });
      if (change === "root") f.replaceRoot();
      if (change === "scope") Object.assign(request.envelope, { nodeId: "other" });
      if (change === "configuration") f.revokeAt(2);
      if (change === "cancel") Object.assign(request, { signal: AbortSignal.abort() });
      await expect(f.binding.owner.execute(request)).rejects.toThrow();
      expect(f.lists()).toBe(0);
    }
  });
  it("withholds names after local revocation, changed root, cancellation or a wrong native receipt", async () => {
    for (const change of ["root", "configuration", "cancel", "receipt"] as const) {
      const f = await fixture(), request = f.request();
      if (change === "root") f.afterList(() => { f.replaceRoot(); });
      if (change === "configuration") f.revokeAt(3);
      if (change === "cancel") f.afterList(() => { Object.assign(request, { signal: AbortSignal.abort() }); });
      if (change === "receipt") f.result({ rootIdentity: "02".repeat(24) });
      await expect(f.binding.owner.execute(request)).rejects.toThrow();
      expect(f.lists()).toBe(1);
    }
  });
  it("enforces the published response budget", async () => {
    const f = await fixture(); f.entry.descriptor.resourceLimits.maxResponseBytes = 64;
    const binding = await createWorkerMeshDirectoryListBinding(f.configuration, f.executor);
    await expect(binding.owner.execute(f.request())).rejects.toThrow();
  });
  it("settles an acknowledged native refusal as failed without inventing an uncertain effect", async () => {
    const f = await fixture();
    const binding = await createWorkerMeshDirectoryListBinding(f.configuration, { ...f.executor,
      list: async () => { throw new WindowsWorkerDirectoryRefusedError(); } });
    expect(await binding.owner.execute(f.request({ path: "missing" }))).toEqual({
      disposition: "failed", errorCode: "native_directory_list_refused",
    });
    const malformed = await createWorkerMeshDirectoryListBinding(f.configuration, { ...f.executor,
      list: async () => { throw new Error("invalid native response"); } });
    await expect(malformed.owner.execute(f.request())).rejects.toThrow();
  });
});
