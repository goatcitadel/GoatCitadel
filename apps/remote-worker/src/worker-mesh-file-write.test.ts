import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, type MeshCapabilityManifest } from "@goatcitadel/contracts";
import { createWorkerMeshFileWriteBinding, createWorkerMeshFileWriteDescriptor } from "./worker-mesh-file-write.js";
import { workerMeshHash } from "./worker-mesh-capability-data.js";
import type { WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";
import type { WindowsWorkerFileResult } from "./worker-windows-file-executor.js";

async function fixture() {
  const descriptor = createWorkerMeshFileWriteDescriptor("documents");
  const unsignedEntry = { localId: "file.write", kind: "tool" as const, capabilityId: "mesh:node-a:tool:file.write",
    descriptor, descriptorSha256: workerMeshHash(descriptor), permissionEnvelopeSha256: workerMeshHash(descriptor.permissions) };
  const entry = { ...unsignedEntry, entrySha256: workerMeshHash(unsignedEntry) };
  const unsigned = { schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, workspaceId: "workspace-a", nodeId: "node-a",
    admissionGeneration: 1, publisherGeneration: 1, publicationKey: "write-files", publicationLeaseFencingToken: 1,
    entries: [entry], createdAt: new Date().toISOString() };
  const manifest: MeshCapabilityManifest = { ...unsigned, manifestSha256: workerMeshHash(unsigned) };
  let currentIdentity = "01".repeat(24), checks = 0, writes = 0, revokedAt = Infinity;
  let result: Partial<WindowsWorkerFileResult> = {};
  const configuration = { manifest, localId: entry.localId, rootId: "documents", rootPath: "C:\\workspace\\documents",
    signal: new AbortController().signal, assertConfigurationCurrent: async () => {
      if (++checks >= revokedAt) throw new Error("revoked");
    } };
  const executor = { inspect: async () => currentIdentity,
    write: async (input: { content: string; expectedContent: string | null }): Promise<WindowsWorkerFileResult> => {
      writes++;
      return { error: 0, effectStarted: true, created: input.expectedContent === null, bytes: Buffer.byteLength(input.content),
        rootIdentity: currentIdentity, sha256: createHash("sha256").update(input.content).digest("hex"), ...result };
    } };
  const binding = await createWorkerMeshFileWriteBinding(configuration, executor);
  const request = (args: Record<string, unknown> = { path: "note.txt", content: "after", expectedContent: "before" }): WorkerMeshCapabilityExecutionRequest => ({
    entry, input: args, signal: new AbortController().signal,
    envelope: { manifestSha256: manifest.manifestSha256, workspaceId: manifest.workspaceId,
      nodeId: manifest.nodeId } as WorkerMeshCapabilityExecutionRequest["envelope"],
  });
  return { binding, request, configuration, executor, entry, writes: () => writes,
    replaceRoot: () => { currentIdentity = "02".repeat(24); }, revokeAt: (check: number) => { revokedAt = check; },
    result: (value: Partial<WindowsWorkerFileResult>) => { result = value; } };
}

describe("governed destination write binding", () => {
  it("exposes local write permissions and returns a content hash without file contents", async () => {
    const f = await fixture();
    expect(f.entry.descriptor.effectPosture).toBe("write_local");
    expect(f.entry.descriptor.idempotency).toBe("none");
    expect(f.entry.descriptor.permissions.filesystemWrite).toEqual(["workspace://documents"]);
    expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: "succeeded", output: {
      path: "note.txt", bytes: 5, sha256: createHash("sha256").update("after").digest("hex"), created: false,
    } });
    expect(f.writes()).toBe(1);
  });
  it.each(["permissions", "inputSchema", "outputSchema", "effectPosture", "idempotency", "semanticVersion"])(
    "refuses a publication that invents %s authority", async (field) => {
      const f = await fixture();
      Object.assign(f.entry.descriptor, { [field]: field.endsWith("Schema") ? { type: "object" }
        : field === "permissions" ? { ...f.entry.descriptor.permissions, filesystemWrite: ["workspace://other"] } : "other" });
      await expect(createWorkerMeshFileWriteBinding(f.configuration, f.executor)).rejects.toThrow();
      expect(f.writes()).toBe(0);
    });
  it.each([
    { path: "../x", content: "x", expectedContent: null },
    { path: "note.txt", content: "x" },
    { path: "note.txt", content: "x", expectedContent: null, rootPath: "C:\\" },
    { path: "note.txt", content: "é".repeat(16385), expectedContent: null },
    { path: "note.txt", content: "\ud800", expectedContent: null },
  ])("refuses invalid arguments before native execution %#", async (args) => {
    const f = await fixture();
    await expect(f.binding.owner.execute(f.request(args))).rejects.toThrow();
    expect(f.writes()).toBe(0);
  });
  it("rejects a changed root, revoked local configuration and mismatched remote scope", async () => {
    for (const change of ["root", "configuration", "scope", "cancel"] as const) {
      const f = await fixture();
      const request = f.request();
      if (change === "root") f.replaceRoot();
      if (change === "configuration") f.revokeAt(2);
      if (change === "scope") Object.assign(request.envelope, { nodeId: "other" });
      if (change === "cancel") Object.assign(request, { signal: AbortSignal.abort() });
      await expect(f.binding.owner.execute(request)).rejects.toThrow();
      expect(f.writes()).toBe(0);
    }
  });
  it("distinguishes a refusal before mutation from an uncertain post-boundary result", async () => {
    for (const effectStarted of [false, true]) {
      const f = await fixture(); f.result({ error: 5, effectStarted });
      expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: effectStarted ? "unknown" : "failed",
        errorCode: effectStarted ? "native_file_write_uncertain" : "native_file_write_refused" });
    }
  });
  it("withholds success if native receipt bytes or content hash differ", async () => {
    for (const result of [{ bytes: 4 }, { sha256: "00".repeat(32) }, { created: true }]) {
      const f = await fixture(); f.result(result);
      expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: "unknown", errorCode: "native_file_write_receipt_mismatch" });
    }
  });
  it("refuses an impossible published response budget before a write", async () => {
    const f = await fixture();
    f.entry.descriptor.resourceLimits.maxResponseBytes = 64;
    const binding = await createWorkerMeshFileWriteBinding(f.configuration, f.executor);
    await expect(binding.owner.execute(f.request())).rejects.toThrow();
    expect(f.writes()).toBe(0);
  });
});
