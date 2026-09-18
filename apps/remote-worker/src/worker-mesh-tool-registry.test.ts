import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, type MeshCapabilityManifest } from "@goatcitadel/contracts";
import { createWorkerMeshFileReadBinding, createWorkerMeshFileReadDescriptor } from "./worker-mesh-file-read.js";
import { workerMeshHash } from "./worker-mesh-capability-data.js";
import { readWorkerLocalFile } from "./worker-local-file-reader.js";
import type { WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";
import { loadWorkerMeshToolRegistry, WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION } from "./worker-mesh-tool-registry.js";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "goat-worker-tool-registry-"));
  roots.push(root);
  const directory = path.join(root, "documents");
  await mkdir(directory);
  const file = path.join(directory, "note.txt");
  await writeFile(file, "Orion 7.\n", { flag: "wx" });
  const descriptor = createWorkerMeshFileReadDescriptor("documents");
  const unsignedEntry = { localId: "file.read", kind: "tool" as const, capabilityId: "mesh:node-a:tool:file.read",
    descriptor, descriptorSha256: workerMeshHash(descriptor), permissionEnvelopeSha256: workerMeshHash(descriptor.permissions) };
  const entry = { ...unsignedEntry, entrySha256: workerMeshHash(unsignedEntry) };
  const unsigned = { schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, workspaceId: "workspace-a", nodeId: "node-a",
    admissionGeneration: 1, publisherGeneration: 2, publicationKey: "read-files", publicationLeaseFencingToken: 3,
    entries: [entry], createdAt: new Date().toISOString() };
  const manifest: MeshCapabilityManifest = { ...unsigned, manifestSha256: workerMeshHash(unsigned) };
  const registry = { schemaVersion: WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION, workspaceId: manifest.workspaceId, nodeId: manifest.nodeId,
    bindings: [{ toolName: "fs.read", manifest, localId: entry.localId, rootId: "documents", rootPath: directory }] };
  const configFile = path.join(root, "registry.json");
  const persist = async () => {
    const bytes = JSON.stringify(registry);
    await writeFile(configFile, bytes);
    return { file: configFile, sha256: sha(bytes) };
  };
  const reference = await persist();
  let revoked = false;
  const binding = await createWorkerMeshFileReadBinding({ manifest, localId: entry.localId, rootId: "documents", rootPath: directory,
    signal: signal(), assertConfigurationCurrent: async () => { if (revoked) throw new Error("revoked"); } });
  const request = (args: Record<string, unknown> = { path: "note.txt" }): WorkerMeshCapabilityExecutionRequest => ({
    entry, input: args, signal: signal(), envelope: { manifestSha256: manifest.manifestSha256,
      workspaceId: manifest.workspaceId, nodeId: manifest.nodeId } as WorkerMeshCapabilityExecutionRequest["envelope"],
  });
  return { root, directory, file, manifest, entry, registry, configFile, persist, reference, binding, request,
    scope: { workspaceId: manifest.workspaceId, nodeId: manifest.nodeId }, revoke: () => { revoked = true; } };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^goat-worker-tool-registry-/u);
    await rm(root, { recursive: true, force: true });
  }
});

describe("shipped worker file tool and local registry", () => {
  it("loads an exact published reader and returns real UTF-8 bytes without exposing host paths", async () => {
    const f = await fixture();
    expect(await loadWorkerMeshToolRegistry(f.reference, f.scope, signal())).toBeDefined();
    await f.binding.owner.assertCurrent(f.request());
    expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: "succeeded",
      output: { path: "note.txt", bytes: 9, content: "Orion 7.\n" } });
    expect(await readFile(f.file, "utf8")).toBe("Orion 7.\n");
  });

  it.each(["../secret.txt", "folder/../note.txt", "", "/note.txt", "C:/note.txt", "note.txt:secret", "folder\\note.txt",
    "folder//note.txt", "note.txt.", "note.txt ", "NUL", "COM1.txt", "aux.txt", "*.txt"])("rejects unsafe relative input %j", async (name) => {
    const f = await fixture();
    await expect(f.binding.owner.execute(f.request({ path: name }))).rejects.toThrow();
  });

  it("rejects native argument extensions even if a caller bypasses the schema worker", async () => {
    const f = await fixture();
    await expect(f.binding.owner.execute(f.request({ path: "note.txt", rootPath: f.root }))).rejects.toThrow();
  });

  it.each(["fs.write", "fs.list", "mcp.invoke", "shell.exec"])("does not turn a read-only publication into a %s executor", async (name) => {
    const f = await fixture();
    f.registry.bindings[0]!.toolName = name;
    await expect(loadWorkerMeshToolRegistry(await f.persist(), f.scope, signal())).rejects.toThrow();
  });

  it("rejects a changed registry digest, extra configuration and foreign scope", async () => {
    const f = await fixture();
    await expect(loadWorkerMeshToolRegistry({ ...f.reference, sha256: "a".repeat(64) }, f.scope, signal())).rejects.toThrow();
    await expect(loadWorkerMeshToolRegistry(f.reference, { ...f.scope, nodeId: "other" }, signal())).rejects.toThrow();
    Object.assign(f.registry, { approvalId: "not-authority" });
    await expect(loadWorkerMeshToolRegistry(await f.persist(), f.scope, signal())).rejects.toThrow();
  });

  it.each(["permissions", "inputSchema", "outputSchema", "effectPosture", "semanticVersion"])("rejects a descriptor that invents %s behavior", async (field) => {
    const f = await fixture();
    const descriptor = f.manifest.entries[0]!.descriptor;
    Object.assign(descriptor, { [field]: field === "permissions" ? { ...descriptor.permissions, filesystemWrite: ["workspace://documents"] }
      : field.endsWith("Schema") ? { type: "object" } : "other" });
    await expect(createWorkerMeshFileReadBinding({ manifest: f.manifest, localId: f.entry.localId, rootId: "documents", rootPath: f.directory,
      signal: signal(), assertConfigurationCurrent: async () => undefined })).rejects.toThrow();
  });

  it("rechecks local revocation at execution after a successful preflight", async () => {
    const f = await fixture();
    await f.binding.owner.assertCurrent(f.request());
    f.revoke();
    await expect(f.binding.owner.execute(f.request())).rejects.toThrow();
  });

  it("rejects root replacement and does not silently adopt a new directory", async () => {
    const f = await fixture();
    await rename(f.directory, path.join(f.root, "old-documents"));
    await mkdir(f.directory);
    await writeFile(f.file, "unreviewed replacement");
    await expect(f.binding.owner.execute(f.request())).rejects.toThrow();
  });

  it("rejects a real junction escape and hard links", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "private fixture");
    await symlink(outside, path.join(f.directory, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(f.binding.owner.execute(f.request({ path: "escape/secret.txt" }))).rejects.toThrow();
    await link(path.join(outside, "secret.txt"), path.join(f.directory, "linked.txt"));
    await expect(f.binding.owner.execute(f.request({ path: "linked.txt" }))).rejects.toThrow();
  });

  it("bounds files and rejects invalid UTF-8, directories and cancelled reads", async () => {
    const f = await fixture();
    await writeFile(f.file, Buffer.alloc(32 * 1024 + 1));
    await expect(f.binding.owner.execute(f.request())).rejects.toThrow();
    await writeFile(f.file, Buffer.from([0xff]));
    await expect(f.binding.owner.execute(f.request())).rejects.toThrow();
    await mkdir(path.join(f.directory, "nested"));
    await expect(f.binding.owner.execute(f.request({ path: "nested" }))).rejects.toThrow();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(f.binding.owner.execute({ ...f.request(), signal: cancelled.signal })).rejects.toThrow();
  });

  it("withholds bytes if content or the final local grant changes during the read", async () => {
    const f = await fixture();
    let checks = 0;
    await expect(readWorkerLocalFile(f.file, 1024, signal(), async () => {
      if (++checks === 1) await writeFile(f.file, "changed!\n");
    })).rejects.toThrow();
    checks = 0;
    await expect(readWorkerLocalFile(f.file, 1024, signal(), async () => {
      if (++checks === 2) throw new Error("revoked");
    })).rejects.toThrow();
    expect(checks).toBe(2);
  });
});
