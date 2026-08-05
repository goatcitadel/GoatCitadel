import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  canonicalJsonString,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
  type MeshReplicationRecord,
  type ChatTurnCapabilityToolMeshPublicationBinding,
} from "@goatcitadel/contracts";
import { Storage, computeMeshCapabilityDescriptorSha256, createLocalAsyncStorage } from "@goatcitadel/storage";
import { MeshCapabilityActivationService } from "./mesh-capability-activation-service.js";
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

afterEach(() => {
  vi.useRealTimers();
  for (const storage of storages.splice(0)) storage.close();
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
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
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
  options: { timeoutMs?: number; publicationKey?: string; localId?: string } = {},
): Promise<{
  activation: MeshCapabilityActivationRecord;
  manifest: MeshCapabilityManifest;
  entry: MeshCapabilityManifestEntry;
}> {
  const descriptor = toolDescriptor(options.timeoutMs ?? 30_000);
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
  it("dispatches one intent with the exact credential-free envelope and settles on the node receipt", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const fence = vi.fn();
    const input = dispatchInputFor(activation);

    const dispatchPromise = service.dispatch(input, { executionFence: fence });
    await new Promise((resolve) => setTimeout(resolve, 30));

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
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  it("rejects settlement, progress, and input reads from a node other than the dispatched node", async () => {
    const harness = await createHarness();
    admitNode(harness.storage, { nodeId: "node-b", token: "join-node-b" });
    const intruder = await authenticate(harness.publication, "node-b", "join-node-b");
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const dispatchPromise = service.dispatch(dispatchInputFor(activation), {});
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondEvents = listDispatchEvents(harness.storage);
    expect(secondEvents).toHaveLength(2);
    const secondInvocationId = secondEvents
      .map((event) => event.payload.invocationId as string)
      .find((candidate) => candidate !== invocationId)!;

    // A concurrent duplicate dispatch of the SAME attempt converges on the
    // same intent and the same envelope row (append is per-source idempotent).
    const duplicate = recoveredService.dispatch(dispatchInputFor(second.activation, { toolRunId: "tool-run-2" }), {});
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  it("serves the transient input only to the dispatched node while the invocation is open", async () => {
    const harness = await createHarness();
    const { activation } = await activateTool(harness);
    const service = harness.createService();
    const input = dispatchInputFor(activation);
    const dispatchPromise = service.dispatch(input, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    const invocationId = listDispatchEvents(harness.storage)[0]!.payload.invocationId as string;

    const output = { status: "ok" };
    const good = nodeSettlement(invocationId, activation, output);
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
