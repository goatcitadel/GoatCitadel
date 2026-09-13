import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, type MeshCapabilityManifest } from "@goatcitadel/contracts";
import { createWorkerMeshMcpHttpBinding, createWorkerMeshMcpHttpDescriptor } from "./worker-mesh-mcp-http.js";
import { exchangeWorkerMcpHttp, workerMcpEndpoint } from "./worker-mcp-http-transport.js";
import { workerMeshHash } from "./worker-mesh-capability-data.js";
import { loadWorkerMeshToolRegistry, WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION } from "./worker-mesh-tool-registry.js";
import type { WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";
import { destinationMcpTools, startDestinationMcpFixture } from "./worker-destination-mcp.test-fixture.js";
import { SERVER_CERT_PEM, SERVER_KEY_PEM } from "./worker-wire-client-tls.test-fixture.js";
import { loadWorkerMcpBearerCredential, type WorkerMcpBearerCredentialReference } from "./worker-mcp-bearer-credential.js";
import { createWorkerMeshFileReadDescriptor } from "./worker-mesh-file-read.js";
import { createWorkerMeshFileWriteDescriptor } from "./worker-mesh-file-write.js";
import * as nativeFiles from "./worker-windows-file-executor.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(authenticated = false) {
  const root = await mkdtemp(path.join(tmpdir(), "gc-worker-mcp-"));
  cleanup.push(async () => {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir())); expect(path.basename(root)).toMatch(/^gc-worker-mcp-/u);
    await rm(root, { recursive: true, force: true });
  });
  const documents = path.join(root, "documents"); await mkdir(documents);
  await writeFile(path.join(documents, "note.txt"), "Orion 7.\n", { flag: "wx" });
  const token = `fixture-${randomUUID()}`;
  const credentialFile = path.join(root, "mcp.token");
  const credentialBytes = `${token}\r\n`;
  if (authenticated) await writeFile(credentialFile, credentialBytes, { flag: "wx" });
  const authorization: WorkerMcpBearerCredentialReference | undefined = authenticated ?
    { type: "bearer_file", file: credentialFile, sha256: createHash("sha256").update(credentialBytes).digest("hex") } : undefined;
  const server = await startDestinationMcpFixture(documents, authenticated ? { bearerToken: token } : {}); cleanup.push(server.close);
  const descriptor = createWorkerMeshMcpHttpDescriptor(server.endpoint, destinationMcpTools, authorization);
  const unsignedEntry = { localId: "mcp.notes", kind: "mcp_server" as const, capabilityId: "mesh:node-a:mcp_server:mcp.notes",
    descriptor, descriptorSha256: workerMeshHash(descriptor), permissionEnvelopeSha256: workerMeshHash(descriptor.permissions) };
  const entry = { ...unsignedEntry, entrySha256: workerMeshHash(unsignedEntry) };
  const unsigned = { schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, workspaceId: "workspace-a", nodeId: "node-a",
    admissionGeneration: 1, publisherGeneration: 1, publicationKey: "mcp-notes", publicationLeaseFencingToken: 1,
    entries: [entry], createdAt: new Date().toISOString() };
  const manifest: MeshCapabilityManifest = { ...unsigned, manifestSha256: workerMeshHash(unsigned) };
  const record = { toolName: "mcp.http", manifest, localId: entry.localId, endpoint: server.endpoint, tools: destinationMcpTools,
    ...(authorization ? { authorization } : {}) };
  const configFile = path.join(root, "registry.json");
  const bytes = JSON.stringify({ schemaVersion: WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION, workspaceId: manifest.workspaceId,
    nodeId: manifest.nodeId, bindings: [record] });
  await writeFile(configFile, bytes, { flag: "wx" });
  const reference = { file: configFile, sha256: createHash("sha256").update(bytes).digest("hex") };
  let current = true;
  const configuration = { ...record, signal: AbortSignal.timeout(5000), assertConfigurationCurrent: async () => { if (!current) throw new Error("revoked"); } };
  const binding = await createWorkerMeshMcpHttpBinding(configuration);
  const request = (args: Record<string, unknown> = { toolName: "note.read", arguments: { path: "note.txt" } }): WorkerMeshCapabilityExecutionRequest => ({
    entry, input: args, signal: AbortSignal.timeout(5000), assertRemoteCurrent: async () => undefined,
    envelope: { manifestSha256: manifest.manifestSha256,
      workspaceId: manifest.workspaceId, nodeId: manifest.nodeId } as WorkerMeshCapabilityExecutionRequest["envelope"],
  });
  return { root, documents, token, credentialFile, authorization, server, binding, request, configuration, record, unsigned, entry, reference, manifest, revoke: () => { current = false; } };
}

describe("destination MCP HTTP owner", () => {
  it.each(["json", "sse"])("authenticates every %s lifecycle request with a separately pinned credential", async (mode) => {
    const f = await fixture(true); f.server.setMode(mode);
    await expect(loadWorkerMeshToolRegistry(f.reference, { workspaceId: f.manifest.workspaceId, nodeId: f.manifest.nodeId }, AbortSignal.timeout(5000))).resolves.toBeDefined();
    expect(await f.binding.owner.execute(f.request())).toMatchObject({ disposition: "succeeded" });
    expect(f.server.calls).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "DELETE"]);
    expect(f.server.authorizationChecks).toEqual([true, true, true, true, true]);
    expect(f.entry.descriptor.semanticVersion).toBe("1.1.0");
    expect(f.entry.descriptor.configurationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(f.manifest)).not.toContain(f.token);
    expect(JSON.stringify(f.manifest)).not.toContain(f.credentialFile);
  });
  it("refuses changed credential bytes before dispatch and never silently adopts them", async () => {
    const f = await fixture(true);
    const changed = `changed-${randomUUID()}`;
    await writeFile(f.credentialFile, changed);
    expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: "failed", errorCode: "destination_mcp_refused" });
    expect(f.server.authorizationChecks).toEqual([]);
    await expect(createWorkerMeshMcpHttpBinding({ ...f.configuration, authorization: { ...f.authorization!, sha256: createHash("sha256").update(changed).digest("hex") } })).rejects.toThrow();
    await expect(loadWorkerMeshToolRegistry(f.reference, { workspaceId: f.manifest.workspaceId, nodeId: f.manifest.nodeId }, AbortSignal.timeout(5000))).rejects.toThrow();
  });
  it("rechecks credential identity after discovery before releasing tool authority", async () => {
    const f = await fixture(true);
    f.server.onList(async () => { await writeFile(f.credentialFile, `rotated-${randomUUID()}`); });
    expect(await f.binding.owner.execute(f.request())).toMatchObject({ disposition: "failed" });
    expect(f.server.toolCalls()).toBe(0);
    expect(f.server.calls).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });
  it("does not reuse an approved credential binding for another endpoint, file or anonymous connection", async () => {
    const f = await fixture(true);
    const otherFile = path.join(f.root, "other.token");
    await writeFile(otherFile, `${f.token}\r\n`, { flag: "wx" });
    for (const changes of [{ endpoint: `${f.server.endpoint}/other` }, { authorization: undefined },
      { authorization: { ...f.authorization!, file: otherFile } }]) {
      await expect(createWorkerMeshMcpHttpBinding({ ...f.configuration, ...changes })).rejects.toThrow();
    }
    expect(f.server.authorizationChecks).toEqual([]);
  });
  it.each(["fs.read", "fs.write"])("keeps bearer credentials outside every %s tool root", async (toolName) => {
    const f = await fixture(true);
    // This isolates registry separation; the packaged probe covers the native writer.
    if (toolName === "fs.write") vi.spyOn(nativeFiles, "createWindowsWorkerFileExecutor").mockReturnValue({
      inspect: async () => "01".repeat(24), write: async () => { throw new Error("No write in registry validation."); },
    });
    const descriptor = (toolName === "fs.read" ? createWorkerMeshFileReadDescriptor : createWorkerMeshFileWriteDescriptor)("documents");
    const unsignedEntry = { localId: "file", kind: "tool" as const, capabilityId: "mesh:node-a:tool:file", descriptor,
      descriptorSha256: workerMeshHash(descriptor), permissionEnvelopeSha256: workerMeshHash(descriptor.permissions) };
    const entry = { ...unsignedEntry, entrySha256: workerMeshHash(unsignedEntry) };
    const unsigned = { ...f.unsigned, entries: [entry] };
    const manifest = { ...unsigned, manifestSha256: workerMeshHash(unsigned) };
    const scope = { workspaceId: manifest.workspaceId, nodeId: manifest.nodeId };
    for (const rootPath of [f.root, f.documents]) {
      const bytes = JSON.stringify({ schemaVersion: WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION, ...scope,
        bindings: [f.record, { toolName, manifest, localId: entry.localId, rootId: "documents", rootPath }] });
      await writeFile(f.reference.file, bytes);
      const load = loadWorkerMeshToolRegistry({ file: f.reference.file, sha256: createHash("sha256").update(bytes).digest("hex") }, scope, AbortSignal.timeout(5000));
      if (rootPath === f.root) await expect(load).rejects.toThrow();
      else await expect(load).resolves.toBeDefined();
    }
    expect(f.server.authorizationChecks).toEqual([]);
  });
  it("does not send the credential when it changes after socket connection", async () => {
    const f = await fixture(true);
    const credential = await loadWorkerMcpBearerCredential(f.authorization, async () => undefined, AbortSignal.timeout(5000));
    let checks = 0;
    await expect(exchangeWorkerMcpHttp({ endpoint: f.server.endpoint, method: "initialize", params: {}, id: 1,
      authorization: credential.authorization, signal: AbortSignal.timeout(5000), assertCurrent: async () => {
        if (++checks === 2) await writeFile(f.credentialFile, `revoked-${randomUUID()}`);
        await credential.assertCurrent(AbortSignal.timeout(5000));
      } })).rejects.toThrow();
    expect(checks).toBe(2);
    expect(f.server.authorizationChecks).toEqual([]);
  });
  it("withholds echoed credentials from successful output and retains post-dispatch uncertainty", async () => {
    const f = await fixture(true); f.server.setMode("echo-auth");
    const result = await f.binding.owner.execute(f.request());
    expect(result).toEqual({ disposition: "unknown", errorCode: "destination_mcp_outcome_uncertain" });
    expect(JSON.stringify(result)).not.toContain(f.token);
    expect(f.server.toolCalls()).toBe(1);
  });
  it("does not refresh or retry a refused bearer credential", async () => {
    const f = await fixture(true); f.server.setBearerToken(`other-${randomUUID()}`);
    expect(await f.binding.owner.execute(f.request())).toMatchObject({ disposition: "failed" });
    expect(f.server.authorizationChecks).toEqual([false]);
    expect(f.server.toolCalls()).toBe(0);
  });
  it("refuses credential header injection, malformed files, extra fields and linked credential files", async () => {
    const f = await fixture(true);
    for (const bytes of ["short", "token-with-enough-length\r\nX-Injected: yes", " ", "x".repeat(8193), Buffer.from([0xff])]) {
      await writeFile(f.credentialFile, bytes);
      const reference = { ...f.authorization!, sha256: createHash("sha256").update(bytes).digest("hex") };
      await expect(loadWorkerMcpBearerCredential(reference, async () => undefined, AbortSignal.timeout(5000))).rejects.toThrow();
    }
    await writeFile(f.credentialFile, f.token);
    const reference = { ...f.authorization!, sha256: createHash("sha256").update(f.token).digest("hex") };
    await expect(loadWorkerMcpBearerCredential({ ...reference, token: f.token }, async () => undefined, AbortSignal.timeout(5000))).rejects.toThrow();
    await link(f.credentialFile, path.join(f.root, "credential-alias"));
    await expect(loadWorkerMcpBearerCredential(reference, async () => undefined, AbortSignal.timeout(5000))).rejects.toThrow();
    await expect(exchangeWorkerMcpHttp({ endpoint: f.server.endpoint, method: "initialize", params: {}, id: 1,
      authorization: `Bearer ${f.token}\r\nX-Injected: yes`, signal: AbortSignal.timeout(5000), assertCurrent: async () => undefined })).rejects.toThrow();
    expect(f.server.authorizationChecks).toEqual([]);
  });
  it.each(["json", "sse", "sse-cr", "sse-crlf"])("executes a real file-reading server with %s and closes its session", async (mode) => {
    const f = await fixture(); f.server.setMode(mode);
    expect(await loadWorkerMeshToolRegistry(f.reference, { workspaceId: f.manifest.workspaceId, nodeId: f.manifest.nodeId }, AbortSignal.timeout(5000))).toBeDefined();
    expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: "succeeded", output: {
      content: [{ type: "text", text: "Orion 7.\n" }], structuredContent: { content: "Orion 7.\n" }, isError: false } });
    expect(f.server.calls).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "DELETE"]);
    expect(f.server.toolCalls()).toBe(1);
  });
  it.each(["schema-drift", "protocol-drift", "cursor-loop", "redirect", "wrong-id"])("refuses %s before tools/call", async (mode) => {
    const f = await fixture(); f.server.setMode(mode);
    expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: "failed", errorCode: "destination_mcp_refused" });
    expect(f.server.toolCalls()).toBe(0);
  });
  it.each(["disconnect", "output-drift", "oversized", "tool-error"])("retains uncertainty for %s after tools/call", async (mode) => {
    const f = await fixture(); f.server.setMode(mode);
    expect(await f.binding.owner.execute(f.request())).toEqual({ disposition: "unknown", errorCode: "destination_mcp_outcome_uncertain" });
    expect(f.server.toolCalls()).toBe(1);
  });
  it("rechecks configuration after discovery and refuses revoked calls", async () => {
    const f = await fixture(); f.server.onList(async () => f.revoke());
    expect(await f.binding.owner.execute(f.request())).toMatchObject({ disposition: "failed" });
    expect(f.server.toolCalls()).toBe(0);
  });
  it("requires fresh runtime authority after asynchronous discovery", async () => {
    const f = await fixture();
    let current = true;
    f.server.onList(async () => { current = false; });
    const request = { ...f.request(), assertRemoteCurrent: async () => { if (!current) throw new Error("remote activation revoked"); } };
    expect(await f.binding.owner.execute(request)).toMatchObject({ disposition: "failed" });
    expect(f.server.toolCalls()).toBe(0);
    await expect(f.binding.owner.assertCurrent({ ...f.request(), assertRemoteCurrent: undefined })).rejects.toThrow();
  });
  it("rechecks authority after socket connection before sending a request body", async () => {
    const f = await fixture();
    let checks = 0, dispatched = false;
    await expect(exchangeWorkerMcpHttp({ endpoint: f.server.endpoint, method: "tools/call", params: {}, id: 1,
      signal: AbortSignal.timeout(2000), assertCurrent: async () => { if (++checks === 2) throw new Error("revoked"); },
      beforeSend: () => { dispatched = true; } })).rejects.toThrow(/refused/u);
    expect(checks).toBe(2);
    expect(dispatched).toBe(false);
    expect(f.server.calls).toEqual([]);
  });
  it("refuses an untrusted HTTPS certificate before sending MCP data", async () => {
    let requests = 0, dispatched = false;
    const server = createHttpsServer({ cert: SERVER_CERT_PEM, key: SERVER_KEY_PEM }, (_request, response) => {
      requests++; response.writeHead(500).end();
    });
    cleanup.push(async () => { const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed; });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test listener");
    await expect(exchangeWorkerMcpHttp({ endpoint: `https://127.0.0.1:${address.port}/mcp`, method: "initialize", params: {}, id: 1,
      signal: AbortSignal.timeout(2000), assertCurrent: async () => undefined,
      beforeSend: () => { dispatched = true; } })).rejects.toThrow(/refused/u);
    expect(requests).toBe(0);
    expect(dispatched).toBe(false);
  });
  it("rejects invalid arguments and unreviewed tool names without any network dispatch", async () => {
    const f = await fixture();
    for (const args of [{ toolName: "other", arguments: {} }, { toolName: "note.read", arguments: { path: "other.txt" } },
      { toolName: "note.read", arguments: { path: "note.txt", extra: true } }])
      expect(await f.binding.owner.execute(f.request(args))).toMatchObject({ disposition: "failed" });
    expect(f.server.calls).toEqual([]);
  });
  it("cancellation after dispatch closes the connection and preserves uncertainty", async () => {
    const f = await fixture(); f.server.setMode("hang");
    const result = await f.binding.owner.execute({ ...f.request(), signal: AbortSignal.timeout(500) });
    expect(result).toMatchObject({ disposition: "unknown" }); expect(f.server.toolCalls()).toBe(1);
  });
  it("does not downgrade an unknown MCP effect or widen the endpoint permission", async () => {
    for (const update of [{ effectPosture: "read_only" }, { permissions: { ...createWorkerMeshMcpHttpDescriptor("http://127.0.0.1:1/mcp", destinationMcpTools).permissions } }]) {
      const f = await fixture(); Object.assign(f.entry.descriptor, update);
      await expect(createWorkerMeshMcpHttpBinding(f.configuration)).rejects.toThrow();
      expect(f.server.calls).toEqual([]);
    }
  });
  it.each(["http://example.com/mcp", "http://localhost/mcp", "https://user:secret@example.com/mcp", "https://example.com/mcp?token=x",
    "file:///C:/mcp", "https://example.com/mcp#fragment", "http://127.1/mcp"])("rejects unapproved endpoint form %s", (endpoint) => {
    expect(() => workerMcpEndpoint(endpoint)).toThrow();
  });
});
