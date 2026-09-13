import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  NotFoundError,
  canonicalJsonString,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
  type MeshReplicationRecord,
  type ChatTurnCapabilityToolMeshPublicationBinding,
  type ToolInvokeRequest,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { Storage, computeMeshCapabilityDescriptorSha256, createLocalAsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { MeshCapabilityActivationService } from "./mesh-capability-activation-service.js";
import { resolveMeshChatToolSchemas } from "./gateway/mesh-chat-catalog.js";
import { dispatchMeshChatTool } from "./gateway/mesh-chat-dispatch.js";
import { executeApprovedExternalRuntimePendingAction, type ApprovedExternalRuntimePendingActionPort } from "./gateway/external-runtime-approval-adapter.js";
import {
  MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE,
  MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
  MeshCapabilityInvocationService,
  MeshCapabilityInvocationServiceError,
  deriveMeshCapabilityInvocationId,
  isMeshCapabilityNodeInvocationPath,
} from "./mesh-capability-invocation-service.js";
import {
  MeshCapabilityPublicationService,
  type MeshCapabilityAuthenticatedNodeIdentity,
} from "./mesh-capability-publication-service.js";

const storages: Storage[] = [];
const fixtureRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const storage of storages.splice(0)) storage.close();
  for (const root of fixtureRoots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^gc-mesh-invocation-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

const EXECUTION_PROFILE_SHA256 = "9".repeat(64);
const LOCAL_GATEWAY_NODE_ID = "gateway-node";

/** Shape of the service's private in-memory input-vault entries (capacity regression). */
interface InputVaultTestEntry {
  inputCanonicalJson: string;
  inputSha256: string;
  expiresAtMs: number;
}

interface Harness {
  storage: Storage;
  publication: MeshCapabilityPublicationService;
  activationService: MeshCapabilityActivationService;
  identity: MeshCapabilityAuthenticatedNodeIdentity;
  clock: { value: number };
  realtimeEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
  createService(options?: { settlementPollIntervalMs?: number }): MeshCapabilityInvocationService;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-mesh-invocation-"));
  fixtureRoots.push(root);
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
  storages.push(storage);
  admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
  const runtimeStorage = createLocalAsyncStorage(storage);
  const publication = new MeshCapabilityPublicationService({ storage: runtimeStorage });
  const activationService = new MeshCapabilityActivationService({ storage: runtimeStorage, publication });
  const identity = await authenticate(publication, "node-a", "join-node-a");
  const clock = { value: Date.now() };
  const realtimeEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const createService = (options: { settlementPollIntervalMs?: number } = {}): MeshCapabilityInvocationService =>
    new MeshCapabilityInvocationService({
      storage: runtimeStorage,
      transport: {
        localNodeId: () => LOCAL_GATEWAY_NODE_ID,
        appendEvent: (input) => runtimeStorage.mesh.appendReplicationEvent(input),
      },
      publishRealtime: (eventType, _source, payload) => {
        realtimeEvents.push({ eventType, payload });
      },
      now: () => new Date(clock.value),
      settlementPollIntervalMs: options.settlementPollIntervalMs ?? 15,
    });
  return { storage, publication, activationService, identity, clock, realtimeEvents, createService };
}

function admitNode(storage: Storage, input: { nodeId: string; token: string }): void {
  const now = new Date().toISOString();
  storage.mesh.upsertNode({
    nodeId: input.nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint: `sha256:${input.nodeId}`,
    joinedAt: now,
    lastSeenAt: now,
  });
  storage.mesh.issueJoinToken(input.token, "2099-01-01T00:00:00.000Z");
  expect(storage.mesh.consumeJoinToken(input.token, input.nodeId, now)).toBe(true);
  storage.meshCapabilityNodeAdmissions.admit({
    workspaceId: "default",
    nodeId: input.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: createHash("sha256").update(input.token).digest("hex"),
    mtlsRequired: true,
    tlsFingerprint: `sha256:${input.nodeId}`,
    admittedByActorId: "operator-a",
    idempotencyKey: `admit:${input.nodeId}:${input.token}`,
  });
}

async function authenticate(
  publication: MeshCapabilityPublicationService,
  nodeId: string,
  token: string,
): Promise<MeshCapabilityAuthenticatedNodeIdentity> {
  const auth = await publication.authenticateNodeRequest({
    headers: {
      authorization: `Bearer ${token}`,
      "x-goatcitadel-mesh-tls-fingerprint": `sha256:${nodeId}`,
    },
  });
  expect(auth).toHaveProperty("identity");
  return (auth as { identity: MeshCapabilityAuthenticatedNodeIdentity }).identity;
}

function toolDescriptor(timeoutMs: number): Record<string, unknown> {
  return {
    kind: "tool",
    title: "Project status",
    semanticVersion: "1.0.0",
    effectPosture: "read_only",
    permissions: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
      filesystemRead: ["workspace://project"],
      filesystemWrite: [],
      networkOrigins: [],
      environmentNames: [],
      deviceCapabilities: [],
    },
    resourceLimits: { timeoutMs, maxRequestBytes: 16_384, maxResponseBytes: 4_096 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    idempotency: "none",
  };
}

async function activateTool(
  harness: Harness,
  options: { timeoutMs?: number; publicationKey?: string; localId?: string;
    inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> } = {},
): Promise<{
  activation: MeshCapabilityActivationRecord;
  manifest: MeshCapabilityManifest;
  entry: MeshCapabilityManifestEntry;
}> {
  const descriptor = toolDescriptor(options.timeoutMs ?? 30_000);
  if (options.inputSchema) descriptor.inputSchema = options.inputSchema;
  if (options.outputSchema) descriptor.outputSchema = options.outputSchema;
  const receipt = await harness.publication.publishCapabilityManifest(harness.identity, {
    publicationKey: options.publicationKey ?? "publication-1",
    entries: [
      {
        localId: options.localId ?? "project.status",
        kind: "tool",
        descriptor,
        descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor),
      },
    ],
  });
  const manifest = receipt.manifest;
  const entry = manifest.entries[0]!;
  const requested = await harness.activationService.requestActivation({
    workspaceId: "default",
    capabilityId: entry.capabilityId,
    manifestSha256: manifest.manifestSha256,
    entrySha256: entry.entrySha256,
    actorId: "operator-a",
    sessionId: "session-a",
    turnId: "turn-a",
  });
  harness.storage.approvals.resolve(requested.approval.approvalId, {
    decision: "approve",
    resolvedBy: "operator-approver",
  });
  const applied = await harness.activationService.executeApprovedActivation({
    workspaceId: "default",
    approvalId: requested.approval.approvalId,
  });
  return { activation: applied.activation, manifest, entry };
}

function bindingOf(activation: MeshCapabilityActivationRecord): ChatTurnCapabilityToolMeshPublicationBinding {
  return {
    nodeId: activation.nodeId,
    publisherGeneration: activation.publisherGeneration,
    manifestSha256: activation.manifestSha256,
    entrySha256: activation.entrySha256,
    activationId: activation.activationId,
    activationRevision: activation.activationRevision,
    publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
    permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
    effectPosture: activation.effectPosture,
    healthGeneration: activation.healthGeneration,
  };
}

function dispatchInputFor(
  activation: MeshCapabilityActivationRecord,
  overrides: Partial<Parameters<MeshCapabilityInvocationService["dispatch"]>[0]> = {},
): Parameters<MeshCapabilityInvocationService["dispatch"]>[0] {
  return {
    workspaceId: "default",
    binding: bindingOf(activation),
    capabilityId: activation.capabilityId,
    args: { query: "release notes", token: "secret-credential-value" },
    toolRunId: "tool-run-1",
    sessionId: "session-a",
    turnId: "turn-a",
    runId: "run-a",
    executionProfileSha256: EXECUTION_PROFILE_SHA256,
    ...overrides,
  };
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function listDispatchEvents(storage: Storage): MeshReplicationRecord[] {
  return storage.mesh
    .listReplicationEvents(100)
    .filter((event) => event.eventType === MESH_CAPABILITY_INVOCATION_DISPATCH_EVENT_TYPE);
}

async function waitForDispatch(storage: Storage, count = 1): Promise<void> {
  await vi.waitFor(() => expect(listDispatchEvents(storage)).toHaveLength(count), { timeout: 7_000 });
}

function nodeSettlement(
  invocationId: string,
  activation: MeshCapabilityActivationRecord,
  output: Record<string, unknown>,
): Parameters<MeshCapabilityInvocationService["settleFromNode"]>[1] {
  const outputSha256 = sha256Utf8(canonicalJsonString(output));
  return {
    invocationId,
    disposition: "succeeded",
    settlementSha256: sha256Utf8(canonicalJsonString({ invocationId, outputSha256 })),
    outputSha256,
    output,
    publisherGeneration: activation.publisherGeneration,
    publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
  };
}

describe("MeshCapabilityInvocationService dispatch + settlement", () => {
  it("rejects schema-invalid input before retaining an intent or entering the execution fence", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness, { inputSchema: {
      type: "object", properties: { query: { type: "integer" } }, required: ["query"], additionalProperties: false,
    } });
    const createIntent = vi.spyOn(harness.storage.meshCapabilityPublications, "createInvocationIntent");
    const fence = vi.fn(async () => { throw new Error("schema validation was bypassed"); });
    await expect(harness.createService().dispatch(dispatchInputFor(activation), { executionFence: fence }))
      .rejects.toMatchObject({ code: "mesh_capability_invocation_input_invalid" });
    expect(createIntent).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
    expect(listDispatchEvents(harness.storage)).toEqual([]);
  });

  it("rejects schema-invalid output without committing success", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness, { outputSchema: {
      type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false,
    } });
    const service = harness.createService();
    const stop = new AbortController();
    const dispatch = service.dispatch(dispatchInputFor(activation), { signal: stop.signal });
    try {
      await vi.waitFor(() => expect(listDispatchEvents(harness.storage)).toHaveLength(1), { timeout: 7_000 });
      const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
      await expect(service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { count: "1" })))
        .rejects.toMatchObject({ code: "mesh_capability_settlement_invalid" });
      expect(harness.storage.meshCapabilityPublications.findInvocationSettlement("default", invocationId)).toBeUndefined();
      const valid = nodeSettlement(invocationId, activation, { count: 1 });
      const settling = service.settleFromNode(harness.identity, valid);
      // The public caller retains its object while the real validator awaits.
      // Neither content nor its claimed hash may change the admitted submission.
      valid.output!.count = "changed during validation";
      valid.outputSha256 = sha256Utf8(canonicalJsonString(valid.output));
      await settling;
      await expect(dispatch).resolves.toMatchObject({ disposition: "succeeded", output: { count: 1 } });
    } finally { stop.abort(); await dispatch; }
  });

  it("does not widen the declared response limit when the immutable manifest cannot be read", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const stop = new AbortController();
    const dispatch = service.dispatch(dispatchInputFor(activation), { signal: stop.signal });
    let manifestRead: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await vi.waitFor(() => expect(listDispatchEvents(harness.storage)).toHaveLength(1), { timeout: 7_000 });
      const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
      manifestRead = vi.spyOn(harness.storage.meshCapabilityPublications, "getManifest")
        .mockImplementation(() => { throw new Error("private manifest read failure"); });
      await expect(service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { blob: "x".repeat(8_192) })))
        .rejects.toMatchObject({ code: "mesh_capability_settlement_invalid" });
      expect(harness.storage.meshCapabilityPublications.findInvocationSettlement("default", invocationId)).toBeUndefined();
    } finally { manifestRead?.mockRestore(); stop.abort(); await dispatch; }
  });

  it.each(["allowed", "current-deny"] as const)(
    "joins real policy approval, dispatch, node settlement and durable effect replay (%s)", async (scenario) => {
      const harness = await createHarness();
      const { activation } = await activateTool(harness);
      const runtimeStorage = createLocalAsyncStorage(harness.storage);
      const entries = await harness.publication.listCatalogEntries("default");
      const resolveBinding = async () => {
        const [schema] = await resolveMeshChatToolSchemas({ storage: runtimeStorage, activations: harness.activationService }, {
          workspaceId: "default", entries,
        });
        return schema ? { schema, executionProfileSha256: EXECUTION_PROFILE_SHA256 } : undefined;
      };
      const binding = (await resolveBinding())!;
      const config: ToolPolicyConfig = { profiles: { danger: ["mesh.invoke"] },
        tools: { profile: "danger", approvalMode: "approve_all", allow: [], deny: [] }, agents: {},
        sandbox: { writeJailRoots: [], readOnlyRoots: [], networkAllowlist: [], riskyShellPatterns: [], requireApprovalForRiskyShell: true } };
      const policy = new ToolPolicyEngine(config, runtimeStorage);
      const request: ToolInvokeRequest = { toolName: activation.capabilityId, agentId: "assistant", sessionId: "session-a",
        turnId: "turn-a", toolRunId: "tool-run-a", runId: "run-a", workspaceId: "default", externalRuntime: true,
        args: { query: "reviewed request" } };
      const decision = await policy.invoke(request, { meshToolBinding: binding.schema.policyBinding });
      expect(decision.outcome).toBe("approval_required");
      const approvalId = decision.approvalId!;
      expect(listDispatchEvents(harness.storage)).toEqual([]);
      harness.storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator-approver" });
      const pending = harness.storage.pendingApprovalActions.find(approvalId)!;
      expect(pending.request).toMatchObject(request);
      const currentPolicy = new ToolPolicyEngine({ ...config, tools: { ...config.tools,
        deny: scenario === "current-deny" ? [activation.capabilityId] : [] } }, runtimeStorage);
      const service = harness.createService();
      const dispatch = vi.spyOn(service, "dispatch");
      const executeApprovedAction = vi.fn<ApprovedExternalRuntimePendingActionPort["executeApprovedAction"]>(
        (id, signal, options) => currentPolicy.executeApprovedAction(id, signal, options),
      );
      const port: ApprovedExternalRuntimePendingActionPort = {
        storage: runtimeStorage, resolveMeshChatToolBinding: resolveBinding, executeApprovedAction,
        invokeApprovedMeshRuntime: (input, admittedPolicy, id, markStarted) => dispatchMeshChatTool({
          resolveBinding, dispatch: (input, options) => service.dispatch(input, options),
        }, input, admittedPolicy, { approvalId: id, markExternalCallStarted: markStarted }),
        enrichMcpInvokePolicyContext: vi.fn(async () => { throw new Error("unexpected MCP route"); }),
        invokeApprovedMcpRuntime: vi.fn(async () => { throw new Error("unexpected MCP runtime"); }),
        invokeApprovedExternalRuntimeTool: vi.fn(async () => { throw new Error("unexpected plugin runtime"); }),
      };
      const call = executeApprovedExternalRuntimePendingAction(port, approvalId, pending);
      if (scenario === "current-deny") {
        expect(await call).toMatchObject({ outcome: "blocked" });
        expect(dispatch).not.toHaveBeenCalled();
        expect(listDispatchEvents(harness.storage)).toEqual([]);
        return;
      }
      await vi.waitFor(() => expect(listDispatchEvents(harness.storage)).toHaveLength(1));
      const envelope = listDispatchEvents(harness.storage)[0]!.payload;
      expect(envelope).toMatchObject({ approvalId, sessionId: "session-a", turnId: "turn-a", runId: "run-a",
        executionProfileSha256: EXECUTION_PROFILE_SHA256, capabilityId: activation.capabilityId });
      expect(harness.storage.externalSideEffectRuns.listByWorkspace("default")[0]?.externalCallStartedAt).toBeDefined();
      await service.settleFromNode(harness.identity, nodeSettlement(envelope.invocationId as string, activation, { status: "ok" }));
      const result = await call;
      expect(result).toMatchObject({ outcome: "executed", result: { ok: true, output: { status: "ok" } } });
      expect(harness.storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "executed" });
      expect(result.audit?.approvalId).toBe(approvalId);
      expect(await executeApprovedExternalRuntimePendingAction(port, approvalId, pending)).toEqual({
        outcome: result.outcome, policyReason: result.policyReason, auditEventId: result.auditEventId, result: result.result,
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(executeApprovedAction).toHaveBeenCalledOnce();
      expect(listDispatchEvents(harness.storage)).toHaveLength(1);
      expect(harness.storage.modelUsageEvents.list({}).items).toEqual([]);
    },
  );

  it("loads a Chat schema from the committed publication and governed activation owners", async () => {
    const harness = await createHarness();
    const { activation, entry } = await activateTool(harness);
    const entries = await harness.publication.listCatalogEntries("default");
    const readCurrent = vi.spyOn(harness.storage.meshCapabilityPublications, "listCallableActivations");
    const result = await resolveMeshChatToolSchemas({
      storage: createLocalAsyncStorage(harness.storage), activations: harness.activationService,
    }, { workspaceId: "default", entries });
    expect(readCurrent).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]!.canonicalName).toBe(activation.capabilityId);
    expect(result[0]!.publication).toEqual(bindingOf(activation));
    expect(result[0]!.providerDefinition).toMatchObject({ function: {
      parameters: (entry.descriptor as { inputSchema: unknown }).inputSchema,
    } });
    expect(listDispatchEvents(harness.storage)).toEqual([]);
  });

  it("rejects a Chat schema when its activation is revoked while the manifest read is pending", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const entries = await harness.publication.listCatalogEntries("default");
    const storage = createLocalAsyncStorage(harness.storage);
    await expect(resolveMeshChatToolSchemas({
      storage: { meshCapabilityPublications: { getManifest: async (...args) => {
        const manifest = await storage.meshCapabilityPublications.getManifest(...args);
        await harness.activationService.revokeActivation({ workspaceId: "default", activationId: activation.activationId,
          reason: "Operator withdrew publication during schema admission.", actorId: "operator-a" });
        return manifest;
      } } },
      activations: harness.activationService,
    }, { workspaceId: "default", entries })).rejects.toThrow("mesh_capability_freeze_drift");
    expect(listDispatchEvents(harness.storage)).toEqual([]);
  });

  it("dispatches one intent with the exact credential-free envelope and settles on the node receipt", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const fence = vi.fn();
    const input = dispatchInputFor(activation);

    const dispatchPromise = service.dispatch(input, { executionFence: fence });
    await waitForDispatch(harness.storage);

    // Exactly one durable intent and one transport envelope exist.
    const events = listDispatchEvents(harness.storage);
    expect(events).toHaveLength(1);
    expect(events[0]!.sourceNodeId).toBe(LOCAL_GATEWAY_NODE_ID);
    const envelope = events[0]!.payload;
    const expectedInputSha256 = sha256Utf8(canonicalJsonString(input.args));
    const expectedInvocationId = deriveMeshCapabilityInvocationId({
      workspaceId: "default",
      toolRunId: "tool-run-1",
      capabilityId: activation.capabilityId,
      binding: bindingOf(activation),
      inputSha256: expectedInputSha256,
    });
    // The envelope binds EXACTLY the packet's field list — nothing else.
    expect(Object.keys(envelope).sort()).toEqual([
      "activationId",
      "activationRevision",
      "capabilityId",
      "deadlineAt",
      "descriptorSha256",
      "entrySha256",
      "executionProfileSha256",
      "idempotencyKey",
      "inputSha256",
      "invocationId",
      "manifestSha256",
      "nodeId",
      "permissionEnvelopeSha256",
      "publicationLeaseFencingToken",
      "publisherGeneration",
      "runId",
      "schemaVersion",
      "sessionId",
      "turnId",
      "workspaceId",
    ]);
    expect(envelope).toMatchObject({
      schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
      invocationId: expectedInvocationId,
      idempotencyKey: "mesh-capability-invocation:tool-run-1",
      workspaceId: "default",
      sessionId: "session-a",
      turnId: "turn-a",
      runId: "run-a",
      capabilityId: activation.capabilityId,
      nodeId: activation.nodeId,
      publisherGeneration: activation.publisherGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      inputSha256: expectedInputSha256,
    });
    // Credential-absence canary: no raw input echo, no credential material,
    // no credential-shaped field anywhere in the envelope.
    const serialized = canonicalJsonString(envelope);
    expect(serialized).not.toContain("secret-credential-value");
    expect(serialized).not.toContain("release notes");
    for (const key of Object.keys(envelope)) {
      expect(/token$|secret|credential|password|authorization|apikey/iu.test(key)).toBe(
        key === "publicationLeaseFencingToken",
      );
    }
    // The HX-305 execution fence fired exactly once at the dispatch write.
    expect(fence).toHaveBeenCalledTimes(1);

    const output = { status: "ok", summary: "All projects green." };
    const settled = await service.settleFromNode(
      harness.identity,
      nodeSettlement(expectedInvocationId, activation, output),
    );
    expect(settled.replayed).toBe(false);

    const outcome = await dispatchPromise;
    expect(outcome).toMatchObject({
      invocationId: expectedInvocationId,
      disposition: "succeeded",
      settled: true,
      deliveryUncertain: false,
      manualReconciliationRequired: false,
      output,
    });
    expect(outcome.receipt.outputSha256).toBe(sha256Utf8(canonicalJsonString(output)));
    expect(fence).toHaveBeenCalledTimes(1);
    // Dispatch + settlement fabricate NO model-usage record (HX-306).
    expect(harness.storage.modelUsageEvents.list({}).items).toHaveLength(0);
    expect(harness.realtimeEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["mesh_capability_invocation_dispatched", "mesh_capability_invocation_settled"]),
    );
  });

  it("replays duplicate identical node settlements idempotently and conflicts changed bytes", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;

    const output = { status: "ok" };
    const submission = nodeSettlement(invocationId, activation, output);
    const first = await service.settleFromNode(harness.identity, submission);
    expect(first.replayed).toBe(false);
    await dispatchPromise;

    // Duplicate identical settlement bytes converge idempotently.
    const replay = await service.settleFromNode(harness.identity, submission);
    expect(replay.replayed).toBe(true);
    expect(replay.settlement).toEqual(first.settlement);

    // Changed bytes conflict against the ONE immutable settlement.
    await expect(
      service.settleFromNode(harness.identity, { ...submission, disposition: "failed" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "mesh_capability_settlement_conflict" }) as Error);
  });

  it("uses the fenced native settlement owner for first submission and replay without a legacy fallback", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    const submission = nodeSettlement(invocationId, activation, { status: "ok" });
    const identity: MeshCapabilityAuthenticatedNodeIdentity = {
      ...harness.identity,
      provenance: "remote_worker",
      remoteWorkerAuthorityFence: {
        schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
        registryWorkspaceId: "default", workspaceId: "default", nodeId: "node-a", admissionGeneration: 1,
        bootstrapId: "bootstrap-a", workerId: "worker-a", workerGeneration: 2,
        credentialId: "credential-a", credentialGeneration: 3, joinAuthorityGeneration: 1,
        joinCredentialSha256: "1".repeat(64), protectedAdmissionEnvelopeSha256: "2".repeat(64),
        protectedAdmissionContextSha256: "3".repeat(64),
      },
    };
    const repo = harness.storage.meshCapabilityPublications;
    const write = repo.settleInvocation.bind(repo);
    const legacy = vi.spyOn(repo, "settleInvocation");
    const native = vi.spyOn(repo, "settleRemoteWorkerInvocation");
    await expect(service.settleFromNode({ ...identity, provenance: "legacy" }, submission)).rejects.toThrow();
    await expect(service.settleFromNode({ ...identity, remoteWorkerAuthorityFence: undefined }, submission)).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();

    // The real storage owner rejects a fabricated native fence on this legacy-only fixture.
    await expect(service.settleFromNode(identity, submission)).rejects.toMatchObject({
      code: "mesh_capability_settlement_stale_generation",
    });
    expect(legacy).not.toHaveBeenCalled();
    expect(repo.findInvocationSettlement("default", invocationId)).toBeUndefined();
    expect(harness.realtimeEvents.some((event) => event.eventType === "mesh_capability_invocation_settled")).toBe(false);

    // Storage's real protected-authority acceptance is exercised in its SQLite/PostgreSQL fixture.
    native.mockImplementation(({ settlement }) => write(settlement));
    const first = await service.settleFromNode(identity, submission);
    expect(first.replayed).toBe(false);
    expect(native).toHaveBeenLastCalledWith({
      authorityFence: identity.remoteWorkerAuthorityFence,
      settlement: expect.objectContaining({ workspaceId: "default", invocationId,
        idempotencyKey: `mesh-capability-settlement:node:node-a:${invocationId}` }),
    });
    expect(await dispatchPromise).toMatchObject({ disposition: "succeeded", output: { status: "ok" } });
    await expect(service.settleFromNode(identity, submission)).resolves.toEqual({ ...first, replayed: true });
    const eventsBeforeRevocation = harness.realtimeEvents.length;
    native.mockImplementation(() => { throw new NotFoundError({ entity: "native authority", id: "revoked" }); });
    await expect(service.settleFromNode(identity, submission)).rejects.toMatchObject({
      code: "mesh_capability_settlement_stale_generation",
    });
    expect(harness.realtimeEvents).toHaveLength(eventsBeforeRevocation);
    expect(repo.findInvocationSettlement("default", invocationId)).toEqual(first.settlement);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects settlement, progress, and input reads from a node other than the dispatched node", async () => {
    const harness = await createHarness();
    admitNode(harness.storage, { nodeId: "node-b", token: "join-node-b" });
    const intruder = await authenticate(harness.publication, "node-b", "join-node-b");
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;

    const submission = nodeSettlement(invocationId, activation, { status: "ok" });
    await expect(service.settleFromNode(intruder, submission)).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_settlement_node_mismatch" }) as Error,
    );
    await expect(
      service.recordProgress(intruder, {
        invocationId,
        sequence: 1,
        stage: "executing",
        publisherGeneration: activation.publisherGeneration,
        publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "mesh_capability_settlement_node_mismatch" }) as Error);
    await expect(service.readInvocationInput(intruder, invocationId)).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_settlement_node_mismatch" }) as Error,
    );
    expect(
      harness.storage.meshCapabilityPublications.findInvocationSettlement("default", invocationId),
    ).toBeUndefined();

    // The dispatched node settles normally afterwards.
    await service.settleFromNode(harness.identity, submission);
    await dispatchPromise;
  });

  it("rejects stale publisher generations at settlement and leaves storage-stale invocations for reconciliation", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;

    // A settlement presenting a mismatched generation or fencing token can
    // never settle (surfaced pre-check; the 168/110 trigger backstops it).
    const submission = nodeSettlement(invocationId, activation, { status: "ok" });
    await expect(
      service.settleFromNode(harness.identity, {
        ...submission,
        publisherGeneration: activation.publisherGeneration + 1,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "mesh_capability_settlement_stale_generation" }) as Error);
    await expect(
      service.settleFromNode(harness.identity, {
        ...submission,
        publicationLeaseFencingToken: activation.publicationLeaseFencingToken + 1,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "mesh_capability_settlement_stale_generation" }) as Error);

    // A NEW publisher generation makes the intent's generation stale in
    // storage: even the exact-binding settlement is refused by the trigger,
    // and the gateway's own terminal write converges to "unsettled + manual".
    const lease = harness.storage.mesh.listLeases(10).find((row) => row.holderNodeId === "node-a")!;
    harness.storage.meshCapabilityPublications.registerPublisher({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: activation.publisherGeneration + 1,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
      publicationLeaseKey: lease.leaseKey,
      publicationLeaseFencingToken: lease.fencingToken,
      publicationLeaseExpiresAt: lease.expiresAt,
      idempotencyKey: "publisher-generation-2",
    });
    await expect(service.settleFromNode(harness.identity, submission)).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_settlement_stale_generation" }) as Error,
    );

    // Deadline expiry now cannot write ANY settlement either: the outcome is
    // an unsettled unknown flagged for manual reconciliation.
    harness.clock.value += 60_000;
    const outcome = await dispatchPromise;
    expect(outcome).toMatchObject({
      disposition: "unknown",
      settled: false,
      deliveryUncertain: true,
      manualReconciliationRequired: true,
    });
    expect(
      harness.storage.meshCapabilityPublications.findInvocationSettlement("default", invocationId),
    ).toBeUndefined();
  });

  it("settles unknown at deadline expiry, flags manual reconciliation, and conflicts the late node settlement", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const fence = vi.fn();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), { executionFence: fence });
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    await service.recordProgress(harness.identity, {
      invocationId,
      sequence: 1,
      stage: "executing",
      publisherGeneration: activation.publisherGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
    });
    const progressSequences = (
      service as unknown as { progressSequences: Map<string, { lastSequence: number; count: number }> }
    ).progressSequences;
    expect(progressSequences.size).toBe(1);

    harness.clock.value += 60_000;
    const outcome = await dispatchPromise;
    expect(outcome).toMatchObject({
      invocationId,
      disposition: "unknown",
      settled: true,
      deliveryUncertain: true,
      manualReconciliationRequired: true,
      errorCode: "mesh_capability_dispatch_deadline_expired",
    });
    expect(progressSequences.size).toBe(0);
    expect(fence).toHaveBeenCalledTimes(1);
    const settlement = harness.storage.meshCapabilityPublications.findInvocationSettlement("default", invocationId);
    expect(settlement).toMatchObject({
      disposition: "unknown",
      errorCode: "mesh_capability_dispatch_deadline_expired",
    });

    // A late node settlement after the terminal state is a conflict, and the
    // terminal unknown state never auto-replays the invocation: the transport
    // still carries exactly one dispatch envelope.
    await expect(
      service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "late" })),
    ).rejects.toThrowError(expect.objectContaining({ code: "mesh_capability_settlement_conflict" }) as Error);
    expect(listDispatchEvents(harness.storage)).toHaveLength(1);
  });

  it("settles cancelled on mid-flight abort and stays fully inert on a pre-dispatch abort", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();

    // Pre-dispatch abort: no intent, no envelope, no fence, no uncertainty.
    const preAborted = new AbortController();
    preAborted.abort();
    const preFence = vi.fn();
    const preOutcome = await service.dispatch(dispatchInputFor(activation), {
      signal: preAborted.signal,
      executionFence: preFence,
    });
    expect(preOutcome).toMatchObject({
      disposition: "cancelled",
      settled: false,
      deliveryUncertain: false,
      manualReconciliationRequired: false,
    });
    expect(preFence).not.toHaveBeenCalled();
    expect(listDispatchEvents(harness.storage)).toHaveLength(0);

    // Mid-flight abort: bounded cancelled terminal settlement, uncertain
    // delivery (the envelope is already exposed), flagged for reconciliation.
    const controller = new AbortController();
    const fence = vi.fn();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {
      signal: controller.signal,
      executionFence: fence,
    });
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    await service.recordProgress(harness.identity, {
      invocationId,
      sequence: 1,
      stage: "executing",
      publisherGeneration: activation.publisherGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
    });
    const progressSequences = (
      service as unknown as { progressSequences: Map<string, { lastSequence: number; count: number }> }
    ).progressSequences;
    expect(progressSequences.size).toBe(1);
    controller.abort();
    const outcome = await dispatchPromise;
    expect(outcome).toMatchObject({
      disposition: "cancelled",
      settled: true,
      deliveryUncertain: true,
      errorCode: "mesh_capability_dispatch_cancelled",
    });
    expect(progressSequences.size).toBe(0);
    expect(fence).toHaveBeenCalledTimes(1);
    const settlement = harness.storage.meshCapabilityPublications.findInvocationSettlement(
      "default",
      outcome.invocationId,
    );
    expect(settlement?.disposition).toBe("cancelled");
  });

  it("never fires the execution fence or writes any intent for a no-longer-callable binding", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    await harness.activationService.revokeActivation({
      workspaceId: "default",
      activationId: activation.activationId,
      reason: "Operator withdrew the remote grant.",
      actorId: "operator-a",
    });
    const service = harness.createService();
    const fence = vi.fn();
    await expect(service.dispatch(dispatchInputFor(activation), { executionFence: fence })).rejects.toMatchObject({
      code: "mesh_capability_invocation_not_callable",
    });
    expect(fence).not.toHaveBeenCalled();
    expect(listDispatchEvents(harness.storage)).toHaveLength(0);
    expect(harness.storage.mesh.listReplicationEvents(100)).toHaveLength(0);
  });

  it.each(["pending", "settled"] as const)("rejects changed execution lineage before reusing a %s intent", async (state) => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const approval = harness.storage.approvals.create({ kind: "tool.invoke", riskLevel: "caution",
      payload: { toolName: activation.capabilityId }, preview: { title: "Review mesh invocation" } });
    harness.storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator-approver" });
    const input = dispatchInputFor(activation, { approvalId: approval.approvalId });
    const invocationId = deriveMeshCapabilityInvocationId({ ...input, inputSha256: sha256Utf8(canonicalJsonString(input.args)) });
    if (state === "pending") {
      await expect(service.dispatch(input, { executionFence: async () => { throw new Error("claim withdrawn"); } }))
        .rejects.toThrow("claim withdrawn");
    } else {
      const dispatch = service.dispatch(input);
      await vi.waitFor(() => expect(listDispatchEvents(harness.storage)).toHaveLength(1));
      await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
      await dispatch;
    }
    const stored = harness.storage.meshCapabilityPublications.findInvocationIntent("default", invocationId);
    const recovered = harness.createService();
    const fence = vi.fn();
    const changed: Array<Partial<typeof input>> = [
      { sessionId: "other-session" }, { turnId: "other-turn" }, { runId: "other-run" }, { runId: undefined },
      { approvalId: "another-approval" }, { approvalId: undefined }, { executionProfileSha256: "a".repeat(64) },
      ...(["nodeId", "manifestSha256", "entrySha256", "permissionEnvelopeSha256"] as const)
        .map((key) => ({ binding: { ...input.binding, [key]: key === "nodeId" ? "another-node" : "a".repeat(64) } })),
      { binding: { ...input.binding, healthGeneration: input.binding.healthGeneration + 1 } },
    ];
    for (const override of changed) {
      await expect(recovered.dispatch({ ...input, ...override }, { executionFence: fence }))
        .rejects.toMatchObject({ code: "mesh_capability_invocation_conflict" });
    }
    expect(fence).not.toHaveBeenCalled();
    expect(listDispatchEvents(harness.storage)).toHaveLength(state === "settled" ? 1 : 0);
    expect(harness.storage.meshCapabilityPublications.findInvocationIntent("default", invocationId)).toEqual(stored);
  });

  it("freezes caller arguments and publication identity before asynchronous dispatch work", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const input = dispatchInputFor(activation);
    const originalArgs = structuredClone(input.args);
    const dispatch = service.dispatch(input, { executionFence: async () => {
      input.args.query = "changed after admission";
      input.binding.healthGeneration += 1;
    } });
    await vi.waitFor(() => expect(listDispatchEvents(harness.storage)).toHaveLength(1));
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    expect(await service.readInvocationInput(harness.identity, invocationId)).toMatchObject({ input: originalArgs });
    await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
    expect(await dispatch).toMatchObject({ disposition: "succeeded" });
  });

  it("keeps staged input private and rejects activation withdrawal during the execution fence", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const input = dispatchInputFor(activation);
    const invocationId = deriveMeshCapabilityInvocationId({ ...input, inputSha256: sha256Utf8(canonicalJsonString(input.args)) });
    await expect(service.dispatch(input, { executionFence: async () => {
      await expect(service.readInvocationInput(harness.identity, invocationId)).rejects.toMatchObject({
        code: "mesh_capability_invocation_not_found",
      });
      await harness.activationService.revokeActivation({ workspaceId: "default", activationId: activation.activationId,
        actorId: "operator-a", reason: "Operator withdrew the capability before dispatch." });
    } })).rejects.toMatchObject({ code: "mesh_capability_invocation_not_callable" });
    expect(listDispatchEvents(harness.storage)).toEqual([]);
    await expect(service.readInvocationInput(harness.identity, invocationId)).rejects.toMatchObject({
      code: "mesh_capability_invocation_not_found",
    });
    const recovered = harness.createService();
    await expect(recovered.dispatch(input)).rejects.toMatchObject({ code: "mesh_capability_invocation_not_callable" });
    expect(listDispatchEvents(harness.storage)).toEqual([]);
  });

  it("does not expose staged input when cancellation arrives during the execution fence", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const controller = new AbortController();
    await expect(service.dispatch(dispatchInputFor(activation), {
      signal: controller.signal, executionFence: async () => controller.abort(),
    })).rejects.toThrow();
    expect(listDispatchEvents(harness.storage)).toEqual([]);
  });

  it("settles vault-capacity exhaustion as a clean pre-dispatch block before the fence and any envelope", async () => {
    // M4 fold of the M3 review Minor: `storeVaultInput` runs BEFORE the
    // execution fence, so an exhausted in-memory input vault rejects with no
    // fence mark and no external exposure — the runner maps the thrown
    // pre-fence rejection to `pre_dispatch_blocked`, never `dispatch_failed`.
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const vault = (service as unknown as { inputVault: Map<string, InputVaultTestEntry> }).inputVault;
    const farFuture = harness.clock.value + 3_600_000;
    for (let index = 0; index < 256; index += 1) {
      vault.set(`default::occupied-${index}`, {
        inputCanonicalJson: "{}",
        inputSha256: "0".repeat(64),
        expiresAtMs: farFuture,
      });
    }
    const fence = vi.fn();
    await expect(service.dispatch(dispatchInputFor(activation), { executionFence: fence })).rejects.toMatchObject({
      code: "mesh_capability_invocation_capacity_exhausted",
    });
    expect(fence).not.toHaveBeenCalled();
    expect(listDispatchEvents(harness.storage)).toHaveLength(0);
    expect(harness.storage.mesh.listReplicationEvents(100)).toHaveLength(0);

    // Once capacity frees up, the SAME attempt converges on its already-created
    // intent and dispatches normally with exactly one fence mark.
    vault.clear();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), { executionFence: fence });
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
    const outcome = await dispatchPromise;
    expect(outcome.disposition).toBe("succeeded");
    expect(fence).toHaveBeenCalledTimes(1);
  });

  it("converges restart recovery on the same intent and envelope without a duplicate dispatch", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const first = harness.createService();
    const dispatchPromise = first.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    const output = { status: "ok" };
    await first.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, output));
    await dispatchPromise;

    // "Restart": a fresh service instance over the same durable storage
    // re-executes the same attempt and converges on the settled outcome.
    const recovered = harness.createService();
    const fence = vi.fn();
    const outcome = await recovered.dispatch(dispatchInputFor(activation), { executionFence: fence });
    expect(outcome).toMatchObject({
      invocationId,
      disposition: "succeeded",
      settled: true,
      deliveryUncertain: false,
    });
    // The transient output did not survive the restart; the durable receipt did.
    expect(outcome.output).toBeUndefined();
    expect(outcome.receipt.outputSha256).toBe(sha256Utf8(canonicalJsonString(output)));
    expect(fence).toHaveBeenCalledTimes(1);
    expect(listDispatchEvents(harness.storage)).toHaveLength(1);

    // A same-tool-run re-dispatch with CHANGED args can never mint a second
    // intent: the idempotency key is already bound to different bytes.
    await expect(
      recovered.dispatch(dispatchInputFor(activation, { args: { query: "changed" } }), {}),
    ).rejects.toMatchObject({ code: "mesh_capability_invocation_conflict" });
  });

  it("re-appends the idempotent envelope when recovering an unsettled intent", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const first = harness.createService();
    const controller = new AbortController();
    const firstDispatch = first.dispatch(dispatchInputFor(activation), { signal: controller.signal });
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    // Simulate a crash of the awaiting turn: abandon the first waiter but keep
    // the intent unsettled by settling nothing. (The abort settles cancelled,
    // so instead simply stop observing the promise after cancelling its poll.)
    controller.abort();
    await firstDispatch;
    // The gateway settled cancelled; recovery below therefore uses a FRESH
    // tool run against a FRESH activation entry to model the unsettled case.
    const second = await activateTool(harness, { publicationKey: "publication-2", localId: "project.report" });
    const recoveredService = harness.createService();
    const recoveryPromise = recoveredService.dispatch(
      dispatchInputFor(second.activation, { toolRunId: "tool-run-2" }),
      {},
    );
    await waitForDispatch(harness.storage, 2);
    const secondEvents = listDispatchEvents(harness.storage);
    expect(secondEvents).toHaveLength(2);
    const secondInvocationId = secondEvents
      .map((event) => event.payload.invocationId as string)
      .find((candidate) => candidate !== invocationId)!;

    // A concurrent duplicate dispatch of the SAME attempt converges on the
    // same intent and the same envelope row (append is per-source idempotent).
    const duplicate = recoveredService.dispatch(dispatchInputFor(second.activation, { toolRunId: "tool-run-2" }), {});
    await vi.waitFor(() => expect(harness.realtimeEvents.filter((event) =>
      event.eventType === "mesh_capability_invocation_dispatched")).toHaveLength(3), { timeout: 7_000 });
    expect(listDispatchEvents(harness.storage)).toHaveLength(2);

    await recoveredService.settleFromNode(
      harness.identity,
      nodeSettlement(secondInvocationId, second.activation, { status: "ok" }),
    );
    const [recoveredOutcome, duplicateOutcome] = await Promise.all([recoveryPromise, duplicate]);
    expect(recoveredOutcome.disposition).toBe("succeeded");
    expect(duplicateOutcome.disposition).toBe("succeeded");
    expect(listDispatchEvents(harness.storage)).toHaveLength(2);
  });

  it("bounds generation-fenced progress and stops it after settlement", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
    const progress = async (sequence: number, overrides: Partial<MeshCapabilityNodeProgress> = {}) =>
      service.recordProgress(harness.identity, {
        invocationId,
        sequence,
        stage: "executing",
        publisherGeneration: activation.publisherGeneration,
        publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
        ...overrides,
      });

    expect(await progress(1)).toEqual({ accepted: true, sequence: 1 });
    expect(await progress(2)).toEqual({ accepted: true, sequence: 2 });
    // Non-increasing sequences are rejected (bounded, replay-safe).
    await expect(progress(2)).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_progress_rejected" }) as Error,
    );
    // Stale generation cannot report progress either.
    await expect(progress(3, { publisherGeneration: activation.publisherGeneration + 1 })).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_settlement_stale_generation" }) as Error,
    );
    // Free-text stages are rejected; only bounded identifiers pass.
    await expect(progress(3, { stage: "Running $(rm -rf /)" })).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_progress_rejected" }) as Error,
    );

    await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
    await dispatchPromise;
    await expect(progress(4)).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_progress_rejected" }) as Error,
    );
    const progressEvents = harness.realtimeEvents.filter(
      (event) => event.eventType === "mesh_capability_invocation_progress",
    );
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]!.payload).toMatchObject({ invocationId, sequence: 1, stage: "executing" });
  });

  it("discovers only its admitted node's confirmed deliveries without arguments or foreign replication data", async () => {
    const harness = await createHarness();
    admitNode(harness.storage, { nodeId: "node-b", token: "join-node-b" });
    const other = await authenticate(harness.publication, "node-b", "join-node-b");
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const input = dispatchInputFor(activation);
    const dispatch = service.dispatch(input);
    await vi.waitFor(() => expect(listDispatchEvents(harness.storage)).toHaveLength(1));
    const event = listDispatchEvents(harness.storage)[0]!;
    const invocationId = event.payload.invocationId as string;
    harness.storage.mesh.appendReplicationEvent({ sourceNodeId: "other-gateway", eventType: event.eventType,
      idempotencyKey: "unrelated-operator-event", payload: { ...event.payload, invocationId: "invented", input: "private" } });
    expect(await service.listPendingInvocations(other)).toEqual({ items: [] });
    expect(await service.listPendingInvocations({ ...harness.identity, workspaceId: "other-workspace" })).toEqual({ items: [] });
    const listed = await service.listPendingInvocations(harness.identity);
    expect(listed).toEqual({ items: [event.payload] });
    expect(JSON.stringify(listed)).not.toContain("secret-credential-value");
    expect(JSON.stringify(listed)).not.toContain("release notes");
    listed.items[0]!.nodeId = "caller-mutated";
    expect(await service.listPendingInvocations(harness.identity)).toEqual({ items: [event.payload] });
    expect(await harness.createService().listPendingInvocations(harness.identity)).toEqual({ items: [] });
    await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
    await dispatch;
    expect(await service.listPendingInvocations(harness.identity)).toEqual({ items: [] });
    expect(listDispatchEvents(harness.storage)).toHaveLength(2);
  });

  it("keeps arguments and pending delivery private until exact transport confirmation", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const storage = createLocalAsyncStorage(harness.storage);
    let confirm!: () => void;
    const confirmation = new Promise<void>((resolve) => { confirm = resolve; });
    const service = new MeshCapabilityInvocationService({ storage, settlementPollIntervalMs: 10, transport: {
      localNodeId: () => LOCAL_GATEWAY_NODE_ID,
      appendEvent: async (input) => {
        const event = await storage.mesh.appendReplicationEvent(input);
        await confirmation;
        return event;
      },
    } });
    const input = dispatchInputFor(activation);
    const invocationId = deriveMeshCapabilityInvocationId({ ...input, inputSha256: sha256Utf8(canonicalJsonString(input.args)) });
    const dispatch = service.dispatch(input, { executionFence: async () => {
      expect(await service.listPendingInvocations(harness.identity)).toEqual({ items: [] });
    } });
    await vi.waitFor(() => expect(listDispatchEvents(harness.storage)).toHaveLength(1));
    expect(await service.listPendingInvocations(harness.identity)).toEqual({ items: [] });
    await expect(service.readInvocationInput(harness.identity, invocationId)).rejects.toMatchObject({
      code: "mesh_capability_invocation_not_found",
    });
    confirm();
    await vi.waitFor(async () => expect((await service.listPendingInvocations(harness.identity)).items).toHaveLength(1));
    expect(await service.readInvocationInput(harness.identity, invocationId)).toMatchObject({ input: input.args });
    await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
    expect(await dispatch).toMatchObject({ disposition: "succeeded" });
  });

  it.each(["revoked", "offline", "lease", "admission", "certificate", "deadline"] as const)(
    "withdraws pending delivery and argument access when %s authority changes", async (change) => {
      const harness = await createHarness();
      const { activation } = await activateTool(harness);
      const service = harness.createService();
      const dispatch = service.dispatch(dispatchInputFor(activation));
      await vi.waitFor(async () => expect((await service.listPendingInvocations(harness.identity)).items).toHaveLength(1));
      const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;
      let identity = harness.identity;
      if (change === "revoked") {
        await harness.activationService.revokeActivation({ workspaceId: "default", activationId: activation.activationId,
          actorId: "operator-a", reason: "Withdraw before input delivery." });
      } else if (change === "offline") {
        const node = harness.storage.mesh.listNodes(10).find((row) => row.nodeId === "node-a")!;
        harness.storage.mesh.upsertNode({ ...node, status: "offline" });
      } else if (change === "lease") {
        const lease = harness.storage.mesh.listLeases(10).find((row) => row.holderNodeId === "node-a")!;
        harness.storage.mesh.releaseLease(lease.leaseKey, lease.holderNodeId, lease.fencingToken);
      } else if (change === "admission") identity = { ...identity, admissionGeneration: identity.admissionGeneration + 1 };
      else if (change === "certificate") identity = { ...identity, tlsFingerprint: "changed-certificate" };
      else harness.clock.value += 60_000;
      expect(await service.listPendingInvocations(identity)).toEqual({ items: [] });
      await expect(service.readInvocationInput(identity, invocationId)).rejects.toMatchObject({
        code: change === "deadline" ? "mesh_capability_invocation_not_found" : "mesh_capability_invocation_not_callable",
      });
      // No node execution occurred. Let the canonical deadline owner retain
      // uncertainty instead of inventing a successful settlement for cleanup.
      harness.clock.value += 60_000;
      expect(await dispatch).toMatchObject({ deliveryUncertain: true, manualReconciliationRequired: true });
      expect(listDispatchEvents(harness.storage)).toHaveLength(1);
    },
  );

  it("retains uncertainty and withholds input when transport replays different envelope bytes", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const storage = createLocalAsyncStorage(harness.storage);
    const service = new MeshCapabilityInvocationService({ storage, transport: {
      localNodeId: () => LOCAL_GATEWAY_NODE_ID,
      appendEvent: (input) => storage.mesh.appendReplicationEvent({ ...input,
        payload: { ...input.payload, executionProfileSha256: "1".repeat(64) } }),
    } });
    const outcome = await service.dispatch(dispatchInputFor(activation));
    expect(outcome).toMatchObject({ disposition: "unknown", deliveryUncertain: true, manualReconciliationRequired: true });
    expect(await service.listPendingInvocations(harness.identity)).toEqual({ items: [] });
    await expect(service.readInvocationInput(harness.identity, outcome.invocationId)).rejects.toMatchObject({
      code: "mesh_capability_invocation_not_found",
    });
  });

  it("serves the transient input only to the dispatched node while the invocation is open", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const input = dispatchInputFor(activation);
    const dispatchPromise = service.dispatch(input, {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;

    const served = await service.readInvocationInput(harness.identity, invocationId);
    expect(served.input).toEqual(input.args);
    expect(served.inputSha256).toBe(sha256Utf8(canonicalJsonString(input.args)));

    await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
    await dispatchPromise;
    // After the terminal settlement the input is no longer served.
    await expect(service.readInvocationInput(harness.identity, invocationId)).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_invocation_not_found" }) as Error,
    );
    // A restarted gateway no longer holds the transient bytes.
    const restarted = harness.createService();
    await expect(restarted.readInvocationInput(harness.identity, invocationId)).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_invocation_not_found" }) as Error,
    );
  });

  it("verifies settlement output bytes against the declared digest and response bound", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;

    const output = { status: "ok" };
    const good = nodeSettlement(invocationId, activation, output);
    await expect(service.settleFromNode(harness.identity, { ...good, output: undefined }))
      .rejects.toMatchObject({ code: "mesh_capability_settlement_invalid" });
    // Digest mismatch between output bytes and outputSha256 fails closed.
    await expect(
      service.settleFromNode(harness.identity, { ...good, outputSha256: "a".repeat(64) }),
    ).rejects.toThrowError(expect.objectContaining({ code: "mesh_capability_settlement_invalid" }) as Error);
    // Output beyond the declared maxResponseBytes (4096) fails closed.
    const oversized = { blob: "x".repeat(8_192) };
    await expect(
      service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, oversized)),
    ).rejects.toThrowError(expect.objectContaining({ code: "mesh_capability_settlement_invalid" }) as Error);
    expect(
      harness.storage.meshCapabilityPublications.findInvocationSettlement("default", invocationId),
    ).toBeUndefined();

    await service.settleFromNode(harness.identity, good);
    const outcome = await dispatchPromise;
    expect(outcome.output).toEqual(output);
  });

  it("binds HX-306 attribution to the immutable intent lineage", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await waitForDispatch(harness.storage);
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;

    const attribution = await service.resolveModelUsageAttribution("default", invocationId);
    expect(attribution).toEqual({
      operationId: `mesh-capability-invocation:${invocationId}`,
      callKind: "utility",
      utilityKind: "mesh_capability_invocation",
      workspaceId: "default",
      sessionId: "session-a",
      turnId: "turn-a",
      durableRunId: "run-a",
    });
    await expect(service.resolveModelUsageAttribution("default", "missing-invocation")).rejects.toThrowError(
      expect.objectContaining({ code: "mesh_capability_invocation_not_found" }) as Error,
    );

    await service.settleFromNode(harness.identity, nodeSettlement(invocationId, activation, { status: "ok" }));
    await dispatchPromise;
    expect(harness.storage.modelUsageEvents.list({}).items).toHaveLength(0);
  });

  it("reconciles expired unsettled intents to the bounded unknown terminal state", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    // Create an intent whose awaiting turn dies without settling: bypass the
    // await loop by dispatching with a node settlement race we never run and
    // aborting observation — instead create the orphan directly via storage.
    const inputSha256 = sha256Utf8(canonicalJsonString({ query: "orphan" }));
    const invocationId = deriveMeshCapabilityInvocationId({
      workspaceId: "default",
      toolRunId: "tool-run-orphan",
      capabilityId: activation.capabilityId,
      binding: bindingOf(activation),
      inputSha256,
    });
    harness.storage.meshCapabilityPublications.createInvocationIntent({
      workspaceId: "default",
      invocationId,
      activationId: activation.activationId,
      activationRevision: activation.activationRevision,
      capabilityId: activation.capabilityId,
      nodeId: activation.nodeId,
      publisherGeneration: activation.publisherGeneration,
      healthGeneration: activation.healthGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      manifestSha256: activation.manifestSha256,
      entrySha256: activation.entrySha256,
      descriptorSha256: activation.descriptorSha256,
      permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
      executionProfileSha256: EXECUTION_PROFILE_SHA256,
      inputSha256,
      sessionId: "session-a",
      turnId: "turn-orphan",
      deadlineAt: new Date(Date.now() + 1_200).toISOString(),
      idempotencyKey: "mesh-capability-invocation:tool-run-orphan",
    });
    await service.recordProgress(harness.identity, {
      invocationId,
      sequence: 1,
      stage: "executing",
      publisherGeneration: activation.publisherGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
    });
    const progressSequences = (
      service as unknown as { progressSequences: Map<string, { lastSequence: number; count: number }> }
    ).progressSequences;
    expect(progressSequences.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    harness.clock.value += 2_000;

    expect(await service.reconcileExpiredInvocationIntents("default")).toBe(1);
    const settlement = harness.storage.meshCapabilityPublications.findInvocationSettlement("default", invocationId);
    expect(settlement).toMatchObject({
      disposition: "unknown",
      errorCode: "mesh_capability_dispatch_deadline_expired",
    });
    expect(progressSequences.size).toBe(0);
    // Idempotent: a second sweep finds nothing left to reconcile.
    expect(await service.reconcileExpiredInvocationIntents("default")).toBe(0);
  });

  it("classifies only the exact node-facing invocation paths for admitted-node authentication", () => {
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations/pending")).toBe(true);
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations/pending?x=1")).toBe(true);
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations/pending/extra")).toBe(false);
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations/mesh-invocation-abc/input")).toBe(
      true,
    );
    expect(
      isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations/mesh-invocation-abc/progress?x=1"),
    ).toBe(true);
    expect(
      isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations/mesh-invocation-abc/settlement"),
    ).toBe(true);
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations")).toBe(false);
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations/abc/other")).toBe(false);
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/manifests")).toBe(false);
    expect(isMeshCapabilityNodeInvocationPath("/api/v1/mesh/capabilities/invocations//settlement")).toBe(false);
  });
});

type MeshCapabilityNodeProgress = Parameters<MeshCapabilityInvocationService["recordProgress"]>[1];

describe("MeshCapabilityInvocationService typed failures", () => {
  it("maps every content-free code to its HTTP status", () => {
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_callable").statusCode).toBe(409);
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_invocation_input_invalid").statusCode).toBe(400);
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_invocation_capacity_exhausted").statusCode).toBe(
      503,
    );
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_invocation_conflict").statusCode).toBe(409);
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_invocation_not_found").statusCode).toBe(404);
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_settlement_node_mismatch").statusCode).toBe(403);
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_settlement_stale_generation").statusCode).toBe(
      409,
    );
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_settlement_conflict").statusCode).toBe(409);
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_settlement_invalid").statusCode).toBe(400);
    expect(new MeshCapabilityInvocationServiceError("mesh_capability_progress_rejected").statusCode).toBe(409);
  });
});
