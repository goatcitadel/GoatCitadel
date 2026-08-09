import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceRequestSubmission,
} from "@goatcitadel/contracts";
import {
  ChatSessionMetaRepository,
  ChatTurnTraceRepository,
  type DatabaseClient,
  DurableRunRepository,
  MeshCapabilityNodeAdmissionRepository,
  MeshRepository,
  RemoteWorkerAdmissionRepository,
  RemoteWorkerAssignmentRepository,
  RemoteWorkerInferenceRepository,
  TaskRepository,
  createDatabase,
} from "@goatcitadel/storage";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RemoteWorkerInferenceDispatchOutcome,
  RemoteWorkerInferenceDispatchRequest,
} from "./remote-worker-inference-llm-adapter.js";
import {
  RemoteWorkerInferenceAccessError,
  RemoteWorkerInferenceService,
  type RemoteWorkerInferenceAuthorityPort,
  type RemoteWorkerInferenceBudgetPort,
  type RemoteWorkerInferenceDispatchAdapter,
  type RemoteWorkerInferenceGovernancePort,
  type RemoteWorkerInferenceRepositoryPort,
  type RemoteWorkerInferenceResolvedAuthority,
  type RemoteWorkerInferenceRoutingPort,
} from "./remote-worker-inference-service.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const ROUTED_CONTEXT = D("routed-context");
const CAPABILITY_PROFILE = D("capability-profile");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

interface Harness {
  repo: RemoteWorkerInferenceRepository;
  authority: RemoteWorkerInferenceResolvedAuthority;
  submission: RemoteWorkerInferenceRequestSubmission;
  now: string;
}

function seed(seedName: string): Harness {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  const durableRuns = new DurableRunRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${seedName}`;
  const sessionId = `session-${seedName}`;
  const turnId = `turn-${seedName}`;
  const durableRunId = `run-${seedName}`;
  new TaskRepository(db).create({ title: `Assignment ${seedName}`, workspaceId: "default" }, now, { taskId });
  new ChatSessionMetaRepository(db).ensure(sessionId, now, "default");
  new ChatTurnTraceRepository(db).create({
    turnId,
    sessionId,
    userMessageId: `message-${seedName}`,
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId, sessionId, turnId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  durableRuns.createRun({
    runId: durableRunId,
    workflowKey: "chat.turn.execute",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwnerId: "gateway-a",
    leaseHeartbeatAt: now,
    leaseExpiresAt: FUTURE,
    version: 1,
    startedAt: now,
    now,
    metadata: {
      remoteWorkerAssignmentParentContext: parentContext,
      remoteWorkerAssignmentParentContextSha256: parentContextSha256,
    },
  });
  const runtimePayload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seedName}:bundle`),
    dependencyLockSha256: D(`${seedName}:lock`),
    vendorTreeSha256: D(`${seedName}:vendor`),
    launcherSha256: D(`${seedName}:launcher`),
    installedTreeManifestSha256: D(`${seedName}:tree`),
    installedTreeFileCount: 12,
    platform: "windows" as const,
    architecture: "x64" as const,
  };
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seedName}`,
    platform: "windows",
    architecture: "x64",
    runtimeManifest: {
      payload: runtimePayload,
      payloadSha256: D(canonicalJsonString(runtimePayload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: `release-key-${seedName}`,
      signatureBase64Url: "A".repeat(86),
    },
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seedName}`,
    bootstrapSecretSha256: D(`${seedName}:bootstrap-secret`),
  }).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission({
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${seedName}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${seedName}:spki`),
    verifiedClientCertificateSha256: D(`${seedName}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${seedName}:trust-anchor`),
    verifiedTransportReceiptSha256: D(`${seedName}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${seedName}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${seedName}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${seedName}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seedName}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${seedName}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${seedName}:credential-token`),
    exchangeIdempotencyKey: `exchange:${seedName}`,
  });
  const mesh = new MeshRepository(db);
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  const joinToken = `join:${seedName}`;
  mesh.upsertNode({
    nodeId: bootstrap.nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint,
    joinedAt: now,
    lastSeenAt: now,
  });
  mesh.issueJoinToken(joinToken, FUTURE);
  mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  const nodeAdmission = new MeshCapabilityNodeAdmissionRepository(db).admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: joinTokenSha256!,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `node-admission:${seedName}`,
  });
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const assignment = assignments.createAssignment({
    manifest: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "default",
      ...parentInput,
      capabilityProfileSha256: CAPABILITY_PROFILE,
      contextSnapshotSha256: ROUTED_CONTEXT,
      toolEffectPostureSha256: D(`${seedName}:posture`),
      pathJailSha256: D(`${seedName}:jail`),
      parentContextSha256,
      requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
      deadlineAt: FUTURE,
      leaseTtlSeconds: 60,
      maxEventCount: 100,
      maxEventBytes: 4_096,
      eventLowWatermark: 2,
      eventHighWatermark: 5,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 1_048_576,
    },
    createdByActorId: "gateway-a",
    idempotencyKey: `assignment:${seedName}`,
  }).assignment;
  const generation = assignments.startGeneration({
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256: D(`${seedName}:lease:1`),
    idempotencyKey: `generation:${seedName}:1`,
  }).generation;

  const authority: RemoteWorkerInferenceResolvedAuthority = {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    sessionId,
    turnId,
    leaseRevision: 1,
    capabilityProfileSha256: CAPABILITY_PROFILE,
    routedContextSha256: ROUTED_CONTEXT,
  };
  const submission: RemoteWorkerInferenceRequestSubmission = {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    inferenceRequestId: "inference-1",
    attempt: 1,
    idempotencyKey: "inference:idem:1",
    leaseToken: `${seedName}:lease:1`,
    messages: [{ role: "user", text: "Hello." }],
    inputSha256: D("input"),
    contextSha256: ROUTED_CONTEXT,
    modelIntentSha256: D("intent"),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    temperatureMilli: 700,
  };
  return { repo: new RemoteWorkerInferenceRepository(db), authority, submission, now };
}

function governanceReceipt(
  decision: RemoteWorkerInferenceGovernanceReceipt["decision"] = "allowed",
): RemoteWorkerInferenceGovernanceReceipt {
  return {
    schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
    decision,
    effectiveRouteSha256: D("route"),
    policyRevision: 4,
    policySha256: D("policy"),
    ...(decision === "approval_required" ? { approvalReceiptSha256: D("approval") } : {}),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    expiresAt: FUTURE,
  };
}

interface ServiceDoubles {
  authority: RemoteWorkerInferenceAuthorityPort;
  governance: RemoteWorkerInferenceGovernancePort;
  budget: RemoteWorkerInferenceBudgetPort;
  routing: RemoteWorkerInferenceRoutingPort;
  adapter: RemoteWorkerInferenceDispatchAdapter & { calls: RemoteWorkerInferenceDispatchRequest[] };
  settled: string[][];
}

function promiseBackedRepository(repository: RemoteWorkerInferenceRepository): RemoteWorkerInferenceRepositoryPort {
  return {
    admitOrReplay: async (input) => repository.admitOrReplay(input),
    claimDispatch: async (input) => repository.claimDispatch(input),
    appendOutputFrame: async (input) => repository.appendOutputFrame(input),
    markDispatchUnknown: async (key, input) => repository.markDispatchUnknown(key, input),
    finalizeTerminal: async (input) => repository.finalizeTerminal(input),
    acknowledge: async (key, throughSequence, now) => repository.acknowledge(key, throughSequence, now),
    getRequest: async (key) => repository.getRequest(key),
    listFramesAfter: async (key, afterSequence) => repository.listFramesAfter(key, afterSequence),
  };
}

function build(
  h: Harness,
  options: {
    decision?: RemoteWorkerInferenceGovernanceReceipt["decision"];
    reserve?: boolean;
    authorityOverride?: () => RemoteWorkerInferenceResolvedAuthority | undefined;
    outcome?: RemoteWorkerInferenceDispatchOutcome;
    promiseBackedOwners?: boolean;
  } = {},
): { service: RemoteWorkerInferenceService; doubles: ServiceDoubles } {
  const settled: string[][] = [];
  const adapter: ServiceDoubles["adapter"] = {
    calls: [],
    async dispatch(request) {
      this.calls.push(request);
      return (
        options.outcome ?? {
          terminalState: "completed",
          chunks: ["Hello ", "world"],
          usageEventId: "usage-event-terminal",
          usageEventIds: ["usage-event-terminal"],
          transportAttempts: 1,
        }
      );
    },
  };
  const doubles: ServiceDoubles = {
    authority: {
      resolveActiveAuthority: () => {
        const authority = options.authorityOverride ? options.authorityOverride() : h.authority;
        return options.promiseBackedOwners ? Promise.resolve(authority) : authority;
      },
    },
    governance: {
      evaluate: () => {
        const receipt = governanceReceipt(options.decision ?? "allowed");
        return options.promiseBackedOwners ? Promise.resolve(receipt) : receipt;
      },
    },
    budget: {
      reserve: () => {
        const reservation =
          options.reserve === false
            ? undefined
            : {
                schemaVersion: "goatcitadel.remote-worker-inference-budget.v1",
                reservationId: "reservation-1",
                reservedOutputTokens: 4096,
                expiresAt: FUTURE,
              };
        return options.promiseBackedOwners ? Promise.resolve(reservation) : reservation;
      },
      settle: ({ usageEventIds }) => {
        settled.push([...usageEventIds]);
        return options.promiseBackedOwners ? Promise.resolve() : undefined;
      },
    },
    routing: {
      resolve: () => {
        const resolution = {
          providerId: "anthropic" as const,
          modelId: "claude-opus-4",
          apiStyle: "messages" as const,
          credential: {
            credentialType: "api_key" as const,
            usagePool: "standard",
            credentialSource: "keychain" as const,
          },
        };
        return options.promiseBackedOwners ? Promise.resolve(resolution) : resolution;
      },
    },
    adapter,
    settled,
  };
  const service = new RemoteWorkerInferenceService({
    repository: options.promiseBackedOwners ? promiseBackedRepository(h.repo) : h.repo,
    authority: doubles.authority,
    governance: doubles.governance,
    budget: doubles.budget,
    routing: doubles.routing,
    adapter: doubles.adapter,
    dispatchOwnerId: "gateway-host-1",
    clock: () => h.now,
  });
  return { service, doubles };
}

const CLAIMS = ["worker_runtime", "gateway_inference"];

describe("RemoteWorkerInferenceService", () => {
  it("awaits Promise-backed storage, authority, governance, budget, and routing owners", async () => {
    const h = seed("async-owners");
    const { service, doubles } = build(h, { promiseBackedOwners: true });
    const outcome = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(outcome.disposition).toBe("delivered");
    expect(outcome.request.state).toBe("completed");
    expect(doubles.adapter.calls).toHaveLength(1);
    expect(doubles.settled).toEqual([["usage-event-terminal"]]);
  });

  it("performs inference end to end, filters output to text frames, and settles from HX-306 event ids", async () => {
    const h = seed("happy");
    const { service, doubles } = build(h);
    const outcome = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(outcome.disposition).toBe("delivered");
    expect(outcome.request.state).toBe("completed");
    expect(outcome.frames.map((frame) => frame.frameKind)).toEqual(["output_text", "output_text", "terminal"]);
    expect(
      outcome.frames
        .filter((frame) => frame.frameKind === "output_text")
        .map((frame) => JSON.parse(frame.payloadJson).text),
    ).toEqual(["Hello ", "world"]);
    // HX-306 attribution consumed, not recomputed.
    expect(outcome.request.usageTerminalEventId).toBe("usage-event-terminal");
    expect(outcome.frames.at(-1)?.usageEventId).toBe("usage-event-terminal");
    expect(doubles.settled).toEqual([["usage-event-terminal"]]);
    // The dispatch carried delegation_worker attribution and the gateway-selected route.
    expect(doubles.adapter.calls[0]?.attribution.callKind).toBe("delegation_worker");
    expect(doubles.adapter.calls[0]?.resolution.providerId).toBe("anthropic");
  });

  it("hashes the raw lease and never persists it", async () => {
    const h = seed("lease");
    const { service } = build(h);
    const outcome = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(h.submission.leaseToken);
    expect(outcome.request.requestBodyJson).not.toContain(h.submission.leaseToken);
  });

  it("fails closed without the worker_runtime and gateway_inference claims", async () => {
    const h = seed("claims");
    const { service, doubles } = build(h);
    await expect(
      service.performInference({ submission: h.submission, workerCapabilityClaims: ["worker_runtime"] }),
    ).rejects.toBeInstanceOf(RemoteWorkerInferenceAccessError);
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("records a governance denial as blocked and never dispatches", async () => {
    const h = seed("denied");
    const { service, doubles } = build(h, { decision: "denied" });
    const outcome = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(outcome.disposition).toBe("blocked");
    expect(outcome.request.state).toBe("blocked");
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("holds an approval_required request in waiting_approval without dispatching", async () => {
    const h = seed("approval");
    const { service, doubles } = build(h, { decision: "approval_required" });
    const outcome = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(outcome.disposition).toBe("waiting_approval");
    expect(outcome.request.state).toBe("waiting_approval");
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("fails closed when the atomic budget port denies the reservation", async () => {
    const h = seed("budget");
    const { service, doubles } = build(h, { reserve: false });
    await expect(
      service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS }),
    ).rejects.toThrow(/budget reservation was denied/u);
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("fails closed on routed-context drift", async () => {
    const h = seed("drift");
    const drifted = { ...h.authority, routedContextSha256: D("other-context") };
    const { service } = build(h, { authorityOverride: () => drifted });
    await expect(
      service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS }),
    ).rejects.toThrow(/routed-context hash drifted/u);
  });

  it("fails closed when the lease authority is cancelled or terminal", async () => {
    const h = seed("cancel");
    const { service } = build(h, {
      authorityOverride: () => {
        throw new Error("assignment cancellation requested");
      },
    });
    await expect(
      service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS }),
    ).rejects.toThrow(/cancelled or terminal/u);
  });

  it("marks an uncertain dispatch as dispatch_unknown without a terminal frame", async () => {
    const h = seed("unknown");
    const { service, doubles } = build(h, {
      outcome: {
        terminalState: "dispatch_unknown",
        chunks: [],
        usageEventId: "usage-event-unknown",
        usageEventIds: ["usage-event-unknown"],
        transportAttempts: 1,
      },
    });
    const outcome = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(outcome.disposition).toBe("dispatch_unknown");
    expect(outcome.request.state).toBe("dispatch_unknown");
    expect(outcome.request.terminalFrameSequence).toBeUndefined();
    expect(doubles.settled).toEqual([["usage-event-unknown"]]);
  });

  it("redacts provider failures: a failed dispatch yields only a terminal frame", async () => {
    const h = seed("failed");
    const { service } = build(h, {
      outcome: {
        terminalState: "failed",
        chunks: [],
        usageEventId: "usage-event-failed",
        usageEventIds: ["usage-event-failed"],
        transportAttempts: 1,
        errorCode: "provider_error",
      },
    });
    const outcome = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(outcome.disposition).toBe("failed");
    expect(outcome.request.state).toBe("failed");
    expect(outcome.frames.map((frame) => frame.frameKind)).toEqual(["terminal"]);
    expect(JSON.stringify(outcome.frames)).not.toContain("provider_error");
  });

  it("replays a completed request idempotently without re-invoking the provider", async () => {
    const h = seed("replay");
    const { service, doubles } = build(h);
    await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    const replay = await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(replay.disposition).toBe("replayed");
    expect(doubles.adapter.calls).toHaveLength(1);
    expect(replay.frames.map((frame) => frame.frameKind)).toEqual(["output_text", "output_text", "terminal"]);
  });

  it("replays the durable outbox on reconnect and advances the acknowledgement watermark", async () => {
    const h = seed("reconnect");
    const { service } = build(h);
    await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    const pending = await service.readPendingFrames({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    expect(pending.map((frame) => frame.frameSequence)).toEqual([1, 2, 3]);
    const acked = await service.acknowledge({
      submission: h.submission,
      workerCapabilityClaims: CLAIMS,
      throughSequence: 2,
    });
    expect(acked.workerAcknowledgedThrough).toBe(2);
    const afterAck = await service.readPendingFrames({
      submission: h.submission,
      workerCapabilityClaims: CLAIMS,
    });
    expect(afterAck.map((frame) => frame.frameSequence)).toEqual([3]);
  });

  it("rejects a worker read once the lease authority is lost", async () => {
    const h = seed("stale-read");
    let live = true;
    const { service } = build(h, { authorityOverride: () => (live ? h.authority : undefined) });
    await service.performInference({ submission: h.submission, workerCapabilityClaims: CLAIMS });
    live = false;
    await expect(
      service.readPendingFrames({ submission: h.submission, workerCapabilityClaims: CLAIMS }),
    ).rejects.toThrow(/unknown, stale, or expired/u);
  });
});
