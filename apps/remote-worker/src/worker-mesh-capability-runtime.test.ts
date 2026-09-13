import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerRuntimeBundleManifestSha256,
  type MeshCapabilityInvocationDispatchEnvelope,
  type MeshCapabilityManifest,
  type MeshToolCapabilityDescriptor,
  type RemoteWorkerMeshCapabilityResponse,
} from "@goatcitadel/contracts";
import type { RouteContext } from "./connected-worker-routes.js";
import { createFileWorkerDurableState, createInMemoryWorkerDurableState, type WorkerDurableStatePort } from "./worker-durable-state.js";
import { exchangeWorkerMeshCapability } from "./worker-mesh-capability-client.js";
import { snapshotWorkerMeshValue, workerMeshHash } from "./worker-mesh-capability-data.js";
import { WorkerMeshCapabilityRuntime, type WorkerMeshCapabilityBinding } from "./worker-mesh-capability-runtime.js";
import { readWorkerMeshJournal } from "./worker-mesh-capability-journal.js";
import { createWorkerNativeWorkspaceRecord } from "./worker-native-workspace-record.js";

function protectedLaunch() {
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
    files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }] };
  const identity = (value: string) => "1".repeat(16) + value.repeat(32);
  return { jobName: `gc-cell-${"1".repeat(32)}`, appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`,
    image: "C:\\runtime\\entry.exe", commandLine: '"C:\\runtime\\entry.exe" private-fixture-argument',
    directory: "C:\\work", runtimeRoot: "C:\\runtime", imageSha256: "a".repeat(64),
    directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"), runtimeBundle,
    runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { FIXTURE_SECRET: "private-fixture-environment" },
    limits: { processLimit: 1, memoryBytes: 65536, cpuMilli: 1000, wallMs: 5000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 4096 },
    protectedWorkspace: { parentPath: "C:\\private-fixture-cells", parentIdentity: identity("1"), rootIdentity: identity("2"),
      controlIdentity: identity("3"), runtimeIdentity: identity("4"), workIdentity: identity("5"),
      ownerSid: "S-1-5-21-1-2-3-1001", controllerSid: "S-1-5-80-1-2-3-4-5" } };
}

function fixture(state: WorkerDurableStatePort = createInMemoryWorkerDurableState(), timeoutMs = 30_000,
  schemas: Partial<Pick<MeshToolCapabilityDescriptor, "inputSchema" | "outputSchema">> = {}) {
  const args = { value: "private input" };
  const descriptor: MeshToolCapabilityDescriptor = {
    kind: "tool", title: "Controlled local tool", semanticVersion: "1.0.0", effectPosture: "write_local",
    permissions: { schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
      filesystemRead: [], filesystemWrite: ["workspace://fixture"], networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
    resourceLimits: { timeoutMs, maxRequestBytes: 1024, maxResponseBytes: 1024 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, idempotency: "none",
    ...schemas,
  };
  const unsignedEntry = { localId: "local.write", kind: "tool" as const, capabilityId: "mesh:node-a:tool:local.write",
    descriptor, descriptorSha256: workerMeshHash(descriptor), permissionEnvelopeSha256: workerMeshHash(descriptor.permissions) };
  const entry = { ...unsignedEntry, entrySha256: workerMeshHash(unsignedEntry) };
  const unsignedManifest = { schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION, workspaceId: "workspace-a", nodeId: "node-a",
    admissionGeneration: 1, publisherGeneration: 2, publicationKey: "owned-local", publicationLeaseFencingToken: 3,
    entries: [entry], createdAt: new Date().toISOString() };
  const manifest: MeshCapabilityManifest = { ...unsignedManifest, manifestSha256: workerMeshHash(unsignedManifest) };
  const envelope: MeshCapabilityInvocationDispatchEnvelope = {
    schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION, invocationId: "invocation-a", idempotencyKey: "tool-run:a",
    workspaceId: "workspace-a", sessionId: "session-a", turnId: "turn-a", runId: "run-a", capabilityId: entry.capabilityId,
    executionProfileSha256: workerMeshHash("profile"), manifestSha256: manifest.manifestSha256,
    entrySha256: entry.entrySha256, descriptorSha256: entry.descriptorSha256, permissionEnvelopeSha256: entry.permissionEnvelopeSha256,
    activationId: "activation-a", activationRevision: 4, nodeId: "node-a", publisherGeneration: 2,
    publicationLeaseFencingToken: 3, inputSha256: workerMeshHash(args), deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    approvalId: "approval-a",
  };
  const journalKey = `mesh-execution-${workerMeshHash({ workspaceId: "workspace-a", nodeId: "node-a", registryWorkspaceId: "registry-a", workerGeneration: 1 })}`;
  const calls: string[] = [];
  const owner = {
    assertCurrent: vi.fn<WorkerMeshCapabilityBinding["owner"]["assertCurrent"]>(async () => { calls.push("local-policy"); }),
    execute: vi.fn<WorkerMeshCapabilityBinding["owner"]["execute"]>(async () => {
      calls.push("effect");
      expect(JSON.parse((await state.read(journalKey))!).active.phase).toBe("executing");
      return { disposition: "succeeded", output: { value: "local result" } };
    }),
  };
  const exchange = vi.fn<typeof exchangeWorkerMeshCapability>(async (request) => {
    const payload = request.payload;
    calls.push(payload.action);
    let result: unknown;
    if (payload.action === "pending") result = { items: [envelope] };
    else if (payload.action === "input") result = { invocationId: envelope.invocationId, inputSha256: envelope.inputSha256, input: args };
    else if (payload.action === "progress") result = { accepted: true, sequence: 1 };
    else if (payload.action === "settle") {
      const active = JSON.parse((await state.read(journalKey))!).active;
      expect(active).toMatchObject({ phase: "settlement_pending", submission: payload.submission });
      const { output: _output, ...durable } = payload.submission;
      const material = { workspaceId: envelope.workspaceId, ...durable,
        idempotencyKey: `mesh-capability-settlement:node:${envelope.nodeId}:${envelope.invocationId}` };
      result = { settlement: { ...material, requestSha256: workerMeshHash(material), settledAt: new Date().toISOString() }, replayed: false };
    } else throw new Error("unexpected test action");
    return { schemaVersion: payload.schemaVersion, operation: "mesh.capability.exchange", action: payload.action,
      workspaceId: payload.workspaceId, nodeId: "node-a", result } as RemoteWorkerMeshCapabilityResponse;
  });
  const bindings = [{ manifest, localId: entry.localId, owner }];
  const run = () => new WorkerMeshCapabilityRuntime(bindings, exchange);
  const input = { state, context: { credential: { registryWorkspaceId: "registry-a", workerGeneration: 1 } } as RouteContext,
    workspaceId: "workspace-a", nodeId: "node-a" };
  return { state, journalKey, args, envelope, manifest, entry, calls, owner, exchange, bindings, run, input };
}

describe("destination mesh execution and retained settlement", () => {
  it("retains immutable workspace recovery metadata locally without publishing launch material", async () => {
    const h = fixture(), launch = protectedLaunch();
    let retain: NonNullable<Parameters<WorkerMeshCapabilityBinding["owner"]["execute"]>[0]["retainNativeWorkspace"]>;
    h.owner.execute.mockImplementation(async (request) => {
      retain = request.retainNativeWorkspace!;
      await retain(launch);
      const active = JSON.parse((await h.state.read(h.journalKey))!).active;
      expect(active.nativeWorkspace).toMatchObject({ invocationId: h.envelope.invocationId, envelopeSha256: workerMeshHash(h.envelope),
        launchSha256: workerMeshHash(launch), workspace: launch.protectedWorkspace });
      await retain(launch);
      return { disposition: "succeeded", output: { value: "local result" } };
    });
    const result = await h.run().runNext(h.input);
    const raw = (await h.state.read(h.journalKey))!;
    expect(raw).not.toContain("private-fixture-argument");
    expect(raw).not.toContain("private-fixture-environment");
    expect(JSON.stringify(result)).not.toContain("nativeWorkspace");
    expect(JSON.stringify(h.exchange.mock.calls)).not.toContain("private-fixture-cells");
    const journal = await readWorkerMeshJournal(h.state, h.journalKey);
    expect(journal.receipts[0]!.nativeWorkspace?.workspace).toEqual(launch.protectedWorkspace);
    await expect(retain!(launch)).rejects.toThrow();
    expect(await h.state.read(h.journalKey)).toBe(raw);
    await expect(h.run().runNext(h.input)).resolves.toEqual({ status: "idle" });
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("preserves the workspace when interrupted execution is recovered as uncertain", async () => {
    const memory = createInMemoryWorkerDurableState();
    let fail = true;
    const h = fixture({ ...memory, write: async (key, value) => {
      if (fail && JSON.parse(value).active?.phase === "settlement_pending") throw new Error("interrupted before settlement");
      await memory.write(key, value);
    } });
    h.owner.execute.mockImplementation(async (request) => {
      await request.retainNativeWorkspace!(protectedLaunch());
      return { disposition: "succeeded", output: { value: "local result" } };
    });
    await expect(h.run().runNext(h.input)).rejects.toThrow("interrupted before settlement");
    const record = JSON.parse((await memory.read(h.journalKey))!).active.nativeWorkspace;
    fail = false;
    const result = await h.run().runNext(h.input);
    expect(result).toMatchObject({ recovered: true, manualReconciliationRequired: true, receipt: { disposition: "unknown" } });
    expect(JSON.parse((await memory.read(h.journalKey))!).receipts[0].nativeWorkspace).toEqual(record);
    expect(h.owner.execute).toHaveBeenCalledOnce();
    await expect(h.run().runNext(h.input)).rejects.toThrow();
  });

  it.each(["reject", "drop"])("prevents native entry when workspace persistence is %s", async (mode) => {
    const memory = createInMemoryWorkerDurableState();
    const h = fixture({ ...memory, write: async (key, value) => {
      if (JSON.parse(value).active?.nativeWorkspace) {
        if (mode === "reject") throw new Error("workspace write rejected");
        return;
      }
      await memory.write(key, value);
    } });
    let entries = 0;
    h.owner.execute.mockImplementation(async (request) => {
      await request.retainNativeWorkspace!(protectedLaunch());
      entries++;
      return { disposition: "succeeded", output: { value: "local result" } };
    });
    await expect(h.run().runNext(h.input)).rejects.toThrow();
    expect(entries).toBe(0);
    expect(h.calls).not.toContain("settle");
    expect(JSON.parse((await memory.read(h.journalKey))!).active.phase).toBe("executing");
  });

  it("joins an interrupted workspace write before publishing settlement", async () => {
    const memory = createInMemoryWorkerDurableState();
    let release!: () => void, writing!: () => void;
    const waiting = new Promise<void>((resolve) => { writing = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cancellation = new AbortController();
    const h = fixture({ ...memory, write: async (key, value) => {
      if (JSON.parse(value).active?.phase === "executing" && JSON.parse(value).active.nativeWorkspace) { writing(); await held; }
      await memory.write(key, value);
    } });
    let entries = 0;
    h.owner.execute.mockImplementation(async (request) => {
      await request.retainNativeWorkspace!(protectedLaunch());
      entries++;
      return { disposition: "succeeded", output: { value: "local result" } };
    });
    const operation = h.run().runNext({ ...h.input, signal: cancellation.signal });
    await waiting;
    cancellation.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).not.toContain("settle");
    release();
    await expect(operation).rejects.toThrow(); // caller cancellation also fences settlement transport
    expect(entries).toBe(0);
    const pending = JSON.parse((await memory.read(h.journalKey))!).active;
    expect(pending).toMatchObject({ phase: "settlement_pending", submission: { disposition: "unknown" } });
    expect(pending.nativeWorkspace.workspace).toEqual(protectedLaunch().protectedWorkspace);
    await expect(h.run().runNext(h.input)).resolves.toMatchObject({ recovered: true, receipt: { disposition: "unknown" } });
    expect(JSON.parse((await memory.read(h.journalKey))!).active).toBeUndefined();
  });

  it("refuses conflicting records even if the execution owner catches the error", async () => {
    const h = fixture(), launch = protectedLaunch();
    h.owner.execute.mockImplementation(async (request) => {
      await request.retainNativeWorkspace!(launch);
      await expect(request.retainNativeWorkspace!({ ...launch, commandLine: launch.commandLine + " changed" })).rejects.toThrow();
      return { disposition: "succeeded", output: { value: "local result" } };
    });
    await expect(h.run().runNext(h.input)).resolves.toMatchObject({ receipt: { disposition: "unknown" } });
    expect(JSON.parse((await h.state.read(h.journalKey))!).receipts[0].nativeWorkspace.launchSha256).toBe(workerMeshHash(launch));
  });

  it("reads legacy journals without writing and refuses cross-invocation or corrupted workspace records", async () => {
    const h = fixture();
    const legacy = JSON.stringify({ schemaVersion: "goatcitadel.worker-mesh-capability-journal.v1", receipts: [] });
    await h.state.write(h.journalKey, legacy);
    expect((await readWorkerMeshJournal(h.state, h.journalKey)).schemaVersion).toBe("goatcitadel.worker-mesh-capability-journal.v2");
    expect(await h.state.read(h.journalKey)).toBe(legacy);
    const record = createWorkerNativeWorkspaceRecord(protectedLaunch(), { invocationId: h.envelope.invocationId, envelopeSha256: workerMeshHash(h.envelope) });
    for (const changed of [{ ...record, invocationId: "other" }, { ...record, launchSha256: "b".repeat(64) },
      { ...record, environment: { SECRET: "not-allowed" } }]) {
      await h.state.write(h.journalKey, JSON.stringify({ schemaVersion: "goatcitadel.worker-mesh-capability-journal.v2", receipts: [],
        active: { phase: "executing", envelope: h.envelope, nativeWorkspace: changed } }));
      await expect(h.run().runNext(h.input)).rejects.toThrow();
    }
    expect(h.owner.execute).not.toHaveBeenCalled();
  });
  it("rejects arguments outside the exact published schema before local policy or an execution marker", async () => {
    const h = fixture(undefined, 30_000, { inputSchema: {
      type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false,
    } });
    await expect(h.run().runNext(h.input)).rejects.toThrow();
    expect(h.owner.assertCurrent).not.toHaveBeenCalled();
    expect(h.owner.execute).not.toHaveBeenCalled();
    expect(await h.state.read(h.journalKey)).toBeUndefined();
  });

  it("retains an unknown outcome when an executed tool violates its published output schema", async () => {
    const h = fixture(undefined, 30_000, { outputSchema: {
      type: "object", properties: { proof: { type: "string" } }, required: ["proof"], additionalProperties: false,
    } });
    const result = await h.run().runNext(h.input);
    expect(result).toMatchObject({ status: "settled", manualReconciliationRequired: true,
      receipt: { disposition: "unknown" } });
    expect(h.exchange.mock.calls.find(([request]) => request.payload.action === "settle")?.[0].payload)
      .toMatchObject({ submission: { errorCode: "mesh_execution_outcome_uncertain" } });
    const journal = (await h.state.read(h.journalKey))!;
    expect(journal).not.toContain("local result");
    await expect(h.run().runNext(h.input)).rejects.toThrow();
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("does not add schema defaults or coerce the approved arguments", async () => {
    const h = fixture(undefined, 30_000, { inputSchema: {
      type: "object", properties: { value: { type: "string" }, extra: { type: "string", default: "not approved" } },
      required: ["value"], additionalProperties: false,
    } });
    await expect(h.run().runNext(h.input)).resolves.toMatchObject({ receipt: { disposition: "succeeded" } });
    expect(h.owner.execute.mock.calls[0]![0].input).toEqual({ value: "private input" });
    expect(h.args).toEqual({ value: "private input" });
  });

  it("includes schema validation in the invocation deadline before recording execution", async () => {
    const h = fixture(undefined, 200, { inputSchema: {
      type: "object", properties: { value: { type: "string", pattern: "^(p+)+$" } }, required: ["value"],
    } });
    h.args.value = "p".repeat(50) + "!";
    h.envelope.inputSha256 = workerMeshHash(h.args);
    await expect(h.run().runNext(h.input)).rejects.toThrow();
    expect(h.owner.execute).not.toHaveBeenCalled();
    expect(await h.state.read(h.journalKey)).toBeUndefined();
  });

  it("checks retained recovery before claiming assignment work without polling fresh mesh deliveries", async () => {
    const h = fixture();
    const runtime = h.run();
    await expect(runtime.recover(h.input)).resolves.toEqual({ status: "idle" });
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.owner.execute).not.toHaveBeenCalled();
    await expect(runtime.runNext(h.input)).resolves.toMatchObject({ status: "settled" });
    h.exchange.mockClear();
    await expect(h.run().recover(h.input)).resolves.toEqual({ status: "idle" });
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("rejects an active journal with no remaining receipt capacity without changing evidence", async () => {
    const h = fixture();
    await h.run().runNext(h.input);
    const journal = JSON.parse((await h.state.read(h.journalKey))!);
    journal.receipts = Array.from({ length: 4096 }, (_, index) => ({ ...journal.receipts[0], invocationId: `retained-${index}` }));
    journal.active = { phase: "executing", envelope: h.envelope };
    const raw = canonicalJsonString(journal);
    await h.state.write(h.journalKey, raw);
    h.exchange.mockClear();
    await expect(h.run().recover(h.input)).rejects.toThrow();
    expect(h.exchange).not.toHaveBeenCalled();
    expect(await h.state.read(h.journalKey)).toBe(raw);
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("rejects executable array prototypes, cycles and sparse payloads before serialization", () => {
    const get = vi.fn(() => Array.prototype.map);
    const values: unknown[] = [1];
    Object.setPrototypeOf(values, Object.defineProperty(Object.create(Array.prototype), "map", { get }));
    expect(() => snapshotWorkerMeshValue(values, 1024)).toThrow();
    expect(get).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => snapshotWorkerMeshValue(cyclic, 1024)).toThrow();
    expect(() => snapshotWorkerMeshValue(new Array(2), 1024)).toThrow();
  });

  it("starts no effect for an expired, cancelled or oversized input", async () => {
    const expired = fixture();
    expired.envelope.deadlineAt = new Date(Date.now() - 1000).toISOString();
    await expect(expired.run().runNext(expired.input)).rejects.toThrow();
    expect(expired.owner.execute).not.toHaveBeenCalled();
    const cancelled = fixture();
    await expect(cancelled.run().runNext({ ...cancelled.input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(cancelled.exchange).not.toHaveBeenCalled();
    const oversized = fixture();
    oversized.args.value = "x".repeat(1024);
    oversized.envelope.inputSha256 = workerMeshHash(oversized.args);
    await expect(oversized.run().runNext(oversized.input)).rejects.toThrow();
    expect(oversized.owner.execute).not.toHaveBeenCalled();
    expect(await oversized.state.read(oversized.journalKey)).toBeUndefined();
  });

  it("rejects corrupt and duplicate retained receipts without discarding them", async () => {
    const h = fixture();
    await h.run().runNext(h.input);
    const journal = JSON.parse((await h.state.read(h.journalKey))!);
    journal.receipts.push(journal.receipts[0]);
    const raw = canonicalJsonString(journal);
    await h.state.write(h.journalKey, raw);
    await expect(h.run().runNext(h.input)).rejects.toThrow();
    expect(await h.state.read(h.journalKey)).toBe(raw);
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("crosses one local owner only after durable intent and discards output only after exact acknowledgement", async () => {
    const h = fixture();
    const result = await h.run().runNext(h.input);
    expect(result).toMatchObject({ status: "settled", recovered: false, manualReconciliationRequired: false,
      receipt: { disposition: "succeeded", invocationId: h.envelope.invocationId } });
    expect(h.calls).toEqual(["pending", "input", "progress", "input", "local-policy", "effect", "settle"]);
    const raw = (await h.state.read(h.journalKey))!;
    expect(raw).not.toContain("private input");
    expect(raw).not.toContain("local result");
    expect(JSON.parse(raw).receipts).toHaveLength(1);
    expect(JSON.parse(raw).active).toBeUndefined();
    await expect(h.run().runNext(h.input)).resolves.toEqual({ status: "idle" });
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("does not poll with no configured tools and cannot hide an unknown outcome by removing them", async () => {
    const h = fixture();
    await expect(new WorkerMeshCapabilityRuntime([], h.exchange).runNext(h.input)).resolves.toEqual({ status: "idle" });
    expect(h.exchange).not.toHaveBeenCalled();
    h.owner.execute.mockRejectedValue(new Error("unknown effect"));
    await expect(h.run().runNext(h.input)).resolves.toMatchObject({ manualReconciliationRequired: true });
    h.exchange.mockClear();
    await expect(new WorkerMeshCapabilityRuntime([], h.exchange).recover(h.input)).rejects.toThrow(/reconciliation/u);
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("replays only retained settlement after an uncertain response, even with no local executable on restart", async () => {
    const h = fixture();
    const send = h.exchange.getMockImplementation()!;
    let lose = true;
    h.exchange.mockImplementation(async (request) => {
      const response = await send(request);
      if (request.payload.action === "settle" && lose) { lose = false; throw new Error("lost response"); }
      return response;
    });
    await expect(h.run().runNext(h.input)).rejects.toThrow("lost response");
    const pending = JSON.parse((await h.state.read(h.journalKey))!).active;
    expect(pending.phase).toBe("settlement_pending");
    h.calls.length = 0;
    const recovered = await new WorkerMeshCapabilityRuntime([], h.exchange).runNext(h.input);
    expect(recovered).toMatchObject({ status: "settled", recovered: true, receipt: { disposition: "succeeded" } });
    expect(h.calls).toEqual(["settle"]);
    expect(h.owner.execute).toHaveBeenCalledOnce();
    const submissions = h.exchange.mock.calls.filter(([request]) => request.payload.action === "settle").map(([request]) => request.payload);
    expect(submissions[1]).toEqual(submissions[0]);
  });

  it.each([1, 2, 3])("preserves the right recovery boundary when durable write %s fails", async (failureWrite) => {
    const memory = createInMemoryWorkerDurableState();
    let writes = 0;
    const h = fixture({ ...memory, write: async (key, value) => {
      if (++writes === failureWrite) throw new Error("disk unavailable");
      await memory.write(key, value);
    } });
    await expect(h.run().runNext(h.input)).rejects.toThrow("disk unavailable");
    expect(h.owner.execute).toHaveBeenCalledTimes(failureWrite === 1 ? 0 : 1);
    const recovered = await h.run().runNext(h.input);
    expect(recovered).toMatchObject({ status: "settled", receipt: { disposition: failureWrite === 2 ? "unknown" : "succeeded" } });
    expect(h.owner.execute).toHaveBeenCalledOnce();
    if (failureWrite === 2) expect(recovered).toMatchObject({ manualReconciliationRequired: true });
  });

  it.each(["workspaceId", "nodeId", "inputSha256", "extra"])("rejects %s corruption without executing", async (field) => {
    const h = fixture();
    if (field === "extra") Object.assign(h.envelope, { executeAgain: true });
    else Object.assign(h.envelope, { [field]: field === "inputSha256" ? workerMeshHash("wrong") : "foreign" });
    await expect(h.run().runNext(h.input)).rejects.toThrow();
    expect(h.owner.execute).not.toHaveBeenCalled();
    expect(await h.state.read(h.journalKey)).toBeUndefined();
  });

  it("does not execute unregistered or drifted manifests and refuses changed replay after acknowledgement", async () => {
    const h = fixture();
    await expect(new WorkerMeshCapabilityRuntime([], h.exchange).runNext(h.input)).resolves.toEqual({ status: "idle" });
    const original = h.envelope.descriptorSha256;
    h.envelope.descriptorSha256 = workerMeshHash("changed");
    await expect(h.run().runNext(h.input)).resolves.toEqual({ status: "idle" });
    h.envelope.descriptorSha256 = original;
    await h.run().runNext(h.input);
    h.envelope.turnId = "different-turn";
    await expect(h.run().runNext(h.input)).rejects.toThrow(/reconciliation/);
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("records content-free failure if local policy or the post-write remote authority check fails", async () => {
    const h = fixture();
    h.owner.assertCurrent.mockRejectedValue(new Error("private credential details"));
    const result = await h.run().runNext(h.input);
    expect(result).toMatchObject({ receipt: { disposition: "failed" } });
    expect(h.owner.execute).not.toHaveBeenCalled();
    expect(canonicalJsonString(result)).not.toContain("private credential");
    const g = fixture();
    const send = g.exchange.getMockImplementation()!;
    g.exchange.mockImplementation(async (request) => {
      if (request.payload.action === "progress") g.args.value = "revoked or changed";
      return send(request);
    });
    await expect(g.run().runNext(g.input)).resolves.toMatchObject({ receipt: { disposition: "failed" } });
    expect(g.owner.execute).not.toHaveBeenCalled();
  });

  it.each(["current", "changed_input", "revoked"] as const)("rechecks remote authority inside an asynchronous owner: %s", async (authority) => {
    const h = fixture();
    const send = h.exchange.getMockImplementation()!;
    let inputReads = 0;
    h.exchange.mockImplementation(async (request) => {
      if (request.payload.action === "input" && ++inputReads === 3 && authority === "revoked")
        throw new Error("private authority was revoked");
      return send(request);
    });
    const effect = vi.fn();
    h.owner.execute.mockImplementation(async (request) => {
      expect(Object.isFrozen(request)).toBe(true);
      expect(request.assertRemoteCurrent).toBeTypeOf("function");
      if (authority === "changed_input") h.args.value = "changed after owner preflight";
      await request.assertRemoteCurrent!();
      effect();
      return { disposition: "succeeded", output: { value: "local result" } };
    });
    const result = await h.run().runNext(h.input);
    expect(inputReads).toBe(3);
    expect(effect).toHaveBeenCalledTimes(authority === "current" ? 1 : 0);
    expect(result).toMatchObject({ status: "settled", manualReconciliationRequired: authority !== "current",
      receipt: { disposition: authority === "current" ? "succeeded" : "unknown" } });
    if (authority !== "current") {
      await expect(h.run().runNext(h.input)).rejects.toThrow(/reconciliation/);
      expect(h.owner.execute).toHaveBeenCalledOnce();
      expect(await h.state.read(h.journalKey)).not.toContain("private authority");
    }
  });

  it("retains the original outcome if the acknowledgement is corrupt and never executes on the retry", async () => {
    const h = fixture();
    const send = h.exchange.getMockImplementation()!;
    let corrupt = true;
    h.exchange.mockImplementation(async (request) => {
      const response = await send(request);
      if (response.action === "settle" && corrupt) { corrupt = false; response.result.settlement.outputSha256 = workerMeshHash("wrong"); }
      return response;
    });
    await expect(h.run().runNext(h.input)).rejects.toThrow(/reconciliation/);
    await expect(h.run().runNext(h.input)).resolves.toMatchObject({ recovered: true, receipt: { disposition: "succeeded" } });
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("serializes concurrent polls and freezes caller input and local publication bytes", async () => {
    const h = fixture();
    const runtime = h.run();
    h.manifest.entries[0]!.descriptor.title = "changed caller metadata";
    h.owner.execute.mockImplementation(async (request) => {
      expect(Object.isFrozen(request.input)).toBe(true);
      expect(request.entry.descriptor.title).toBe("Controlled local tool");
      h.args.value = "changed after snapshot";
      expect(request.input.value).toBe("private input");
      return { disposition: "succeeded", output: {} };
    });
    const outcomes = await Promise.all([runtime.runNext(h.input), runtime.runNext(h.input)]);
    expect(outcomes.map((result) => result.status)).toEqual(["settled", "idle"]);
    expect(h.owner.execute).toHaveBeenCalledOnce();
  });

  it("refuses accessors and mismatched nested hashes before execution", async () => {
    const h = fixture();
    const get = vi.fn(() => h.args);
    Object.defineProperty(h.manifest, "entries", { get, enumerable: true });
    expect(() => h.run()).toThrow();
    expect(get).not.toHaveBeenCalled();
    const g = fixture();
    g.manifest.entries[0]!.descriptor.title = "altered bytes";
    const { manifestSha256: _digest, ...unsigned } = g.manifest;
    g.manifest.manifestSha256 = workerMeshHash(unsigned);
    expect(() => g.run()).toThrow(/digest/);
  });

  it.each(["envelope", "descriptor"] as const)("bounds the first input read by the %s deadline without recording execution", async (limit) => {
    const h = fixture(undefined, limit === "descriptor" ? 50 : 30_000);
    h.envelope.deadlineAt = new Date(Date.now() + (limit === "envelope" ? 50 : 30_000)).toISOString();
    const send = h.exchange.getMockImplementation()!;
    let release: (() => void) | undefined;
    let readSignal: AbortSignal | undefined;
    let reads = 0;
    h.exchange.mockImplementation(async (request) => {
      if (request.payload.action === "input" && ++reads === 1) {
        readSignal = request.signal;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return send(request);
    });
    const pending = h.run().runNext(h.input).then(() => "completed", () => "rejected");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([pending, new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still_waiting"), 500);
      })]);
      expect(observed).toBe("rejected");
      expect(readSignal?.aborted).toBe(true);
      expect(await h.state.read(h.journalKey)).toBeUndefined();
      expect(h.owner.assertCurrent).not.toHaveBeenCalled();
      expect(h.owner.execute).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      release?.();
      await pending;
    }
  });

  it.each(["progress", "input"] as const)("settles a stalled %s recheck as timed out without entering the local owner", async (stage) => {
    const h = fixture(undefined, 1_000);
    const send = h.exchange.getMockImplementation()!;
    let reads = 0;
    let release: (() => void) | undefined;
    let readSignal: AbortSignal | undefined;
    h.exchange.mockImplementation(async (request) => {
      if (request.payload.action === "input") reads += 1;
      if (request.payload.action === stage && (stage !== "input" || reads === 2)) {
        readSignal = request.signal;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return send(request);
    });
    const runtime = h.run();
    const pending = runtime.runNext(h.input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([pending, new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still_waiting"), 2_500);
      })]);
      expect(observed).toMatchObject({ manualReconciliationRequired: false, receipt: { disposition: "timed_out" } });
      expect(readSignal?.aborted).toBe(true);
      expect(h.owner.assertCurrent).not.toHaveBeenCalled();
      expect(h.owner.execute).not.toHaveBeenCalled();
      expect(h.exchange.mock.calls.find(([request]) => request.payload.action === "settle")?.[0].signal?.aborted).not.toBe(true);
      release?.();
      await pending;
      await expect(runtime.runNext(h.input)).resolves.toEqual({ status: "idle" });
      expect(h.owner.execute).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      release?.();
      await pending.catch(() => undefined);
    }
  });

  it.each(["initial_input", "progress", "current_input", "local_policy"] as const)("rechecks elapsed time after %s even before its timer callback runs", async (stage) => {
    const h = fixture(undefined, 30_000);
    const started = Date.now();
    let now = started;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const send = h.exchange.getMockImplementation()!;
    let reads = 0;
    h.exchange.mockImplementation(async (request) => {
      const response = await send(request);
      if (request.payload.action === "input") reads += 1;
      if ((stage === "initial_input" && reads === 1) ||
        (stage === "progress" && request.payload.action === "progress") ||
        (stage === "current_input" && reads === 2)) now = started + 30_001;
      return response;
    });
    if (stage === "local_policy") h.owner.assertCurrent.mockImplementation(async () => { now = started + 30_001; });
    try {
      if (stage === "initial_input") {
        await expect(h.run().runNext(h.input)).rejects.toThrow();
        expect(await h.state.read(h.journalKey)).toBeUndefined();
      } else {
        await expect(h.run().runNext(h.input)).resolves.toMatchObject({ receipt: { disposition: "timed_out" } });
      }
      expect(h.owner.execute).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("counts input-read time against the descriptor limit without restarting its budget", async () => {
    const h = fixture(undefined, 100);
    h.envelope.deadlineAt = new Date(Date.now() + 30_000).toISOString();
    const send = h.exchange.getMockImplementation()!;
    const started = Date.now();
    let now = started;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    h.exchange.mockImplementation(async (request) => {
      const response = await send(request);
      if (request.payload.action === "input") now = started + 101;
      return response;
    });
    try {
      await expect(h.run().runNext(h.input)).rejects.toThrow();
      expect(h.owner.execute).not.toHaveBeenCalled();
      expect(await h.state.read(h.journalKey)).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it("includes durable marker writes in the deadline and retains a known non-execution result", async () => {
    const memory = createInMemoryWorkerDurableState();
    const started = Date.now();
    let now = started;
    let writes = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = fixture({ ...memory, write: async (key, value) => {
      await memory.write(key, value);
      if (++writes === 1) now = started + 30_001;
    } });
    try {
      await expect(h.run().runNext(h.input)).resolves.toMatchObject({ manualReconciliationRequired: false,
        receipt: { disposition: "timed_out" } });
      expect(h.exchange.mock.calls.map(([request]) => request.payload.action)).toEqual(["pending", "input", "settle"]);
      expect(h.owner.execute).not.toHaveBeenCalled();
      expect(JSON.parse((await memory.read(h.journalKey))!).active).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it("retains caller cancellation during preflight and reports it on recovery without executing", async () => {
    const h = fixture();
    const stop = new AbortController();
    const send = h.exchange.getMockImplementation()!;
    h.exchange.mockImplementation(async (request) => {
      const response = await send(request);
      if (request.payload.action === "progress") stop.abort();
      return response;
    });
    await expect(h.run().runNext({ ...h.input, signal: stop.signal })).rejects.toThrow();
    expect(JSON.parse((await h.state.read(h.journalKey))!).active).toMatchObject({ phase: "settlement_pending",
      submission: { disposition: "cancelled", errorCode: "mesh_execution_cancelled" } });
    expect(h.owner.assertCurrent).not.toHaveBeenCalled();
    expect(h.owner.execute).not.toHaveBeenCalled();
    h.calls.length = 0;
    await expect(h.run().recover(h.input)).resolves.toMatchObject({ recovered: true, manualReconciliationRequired: false,
      receipt: { disposition: "cancelled" } });
    expect(h.calls).toEqual(["settle"]);
    expect(h.owner.execute).not.toHaveBeenCalled();
  });

  it("quarantines late success when event-loop delay and a backwards wall clock mask the timer", async () => {
    const h = fixture(undefined, 1_000);
    const clock = vi.spyOn(Date, "now");
    h.owner.execute.mockImplementation(async (request) => {
      clock.mockReturnValue(Date.now() - 60_000);
      // Keep the timer callback from running while the monotonic deadline passes.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
      expect(request.signal.aborted).toBe(false);
      return { disposition: "succeeded", output: { value: "late success" } };
    });
    try {
      const runtime = h.run();
      await expect(runtime.runNext(h.input)).resolves.toMatchObject({ manualReconciliationRequired: true,
        receipt: { disposition: "unknown" } });
      await expect(runtime.runNext(h.input)).rejects.toThrow(/reconciliation/);
      h.exchange.mockClear();
      await expect(h.run().recover(h.input)).rejects.toThrow(/reconciliation/);
      expect(h.exchange).not.toHaveBeenCalled();
      expect(h.owner.execute).toHaveBeenCalledOnce();
      expect(await h.state.read(h.journalKey)).not.toContain("late success");
    } finally { clock.mockRestore(); }
  });

  it("bounds a stalled local policy check before entering its effect owner", async () => {
    const h = fixture(undefined, 1_000);
    h.owner.assertCurrent.mockImplementation(async () => new Promise(() => undefined));
    await expect(h.run().runNext(h.input)).resolves.toMatchObject({ manualReconciliationRequired: false,
      receipt: { disposition: "timed_out" } });
    expect(h.owner.assertCurrent).toHaveBeenCalledOnce();
    expect(h.owner.execute).not.toHaveBeenCalled();
  });

  it("retains unknown on output violations or execution timeout and stops the live runtime", async () => {
    const h = fixture();
    h.owner.execute.mockResolvedValue({ disposition: "succeeded", output: { text: "x".repeat(1024) } });
    const runtime = h.run();
    await expect(runtime.runNext(h.input)).resolves.toMatchObject({ manualReconciliationRequired: true, receipt: { disposition: "unknown" } });
    await expect(runtime.runNext(h.input)).rejects.toThrow(/reconciliation/);
    // A new host cannot treat its empty in-memory uncertainty flag as resolution.
    h.exchange.mockClear();
    await expect(h.run().recover(h.input)).rejects.toThrow(/reconciliation/);
    await expect(h.run().runNext(h.input)).rejects.toThrow(/reconciliation/);
    expect(h.exchange).not.toHaveBeenCalled();
    const g = fixture(undefined, 1_000);
    g.owner.execute.mockImplementation(async () => new Promise(() => undefined));
    await expect(g.run().runNext(g.input)).resolves.toMatchObject({ manualReconciliationRequired: true, receipt: { disposition: "unknown" } });
    expect(g.owner.execute).toHaveBeenCalledOnce();
  });

  it("recovers from actual file-backed state without repeating the local effect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gc-mesh-execution-journal-"));
    try {
      const h = fixture(createFileWorkerDurableState(root));
      await h.run().runNext(h.input);
      const names = await readdir(root);
      expect(names).toEqual([`${h.journalKey}.json`]);
      const persisted = JSON.parse(await readFile(path.join(root, names[0]!), "utf8"));
      expect(persisted.active).toBeUndefined();
      await expect(h.run().runNext({ ...h.input, state: createFileWorkerDurableState(root) })).resolves.toEqual({ status: "idle" });
      expect(h.owner.execute).toHaveBeenCalledOnce();
    } finally {
      expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
      expect(path.basename(root)).toMatch(/^gc-mesh-execution-journal-/u);
      await rm(root, { recursive: true, force: true });
    }
  });
});
