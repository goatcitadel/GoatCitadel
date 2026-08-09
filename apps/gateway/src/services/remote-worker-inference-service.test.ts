import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_APPROVAL_RESOLUTION_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
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
  type RemoteWorkerInferenceApprovalPort,
  type RemoteWorkerInferenceBudgetPort,
  type RemoteWorkerInferenceDispatchAdapter,
  type RemoteWorkerInferenceGovernancePort,
  type RemoteWorkerInferenceRepositoryPort,
  type RemoteWorkerInferenceResolvedAuthority,
  type RemoteWorkerInferenceRoutingPort,
} from "./remote-worker-inference-service.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const AUTHORITY_SECRET_CANARY = "Bearer rw-authority-secret-canary";
const BUDGET_RESERVE_SECRET_CANARY = "Bearer rw-budget-reserve-secret-canary";
const BUDGET_SETTLE_SECRET_CANARY = "Bearer rw-budget-settle-secret-canary";
const BUDGET_RELEASE_SECRET_CANARY = "Bearer rw-budget-release-secret-canary";
const GOVERNANCE_SECRET_CANARY = "Bearer rw-governance-secret-canary";
const ROUTING_SECRET_CANARY = "Bearer rw-routing-secret-canary";
const APPROVAL_SECRET_CANARY = "Bearer rw-approval-secret-canary";
const REPOSITORY_SECRET_CANARY = "Bearer rw-repository-secret-canary";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const ROUTED_CONTEXT = D("routed-context");
const CAPABILITY_PROFILE = D("capability-profile");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

interface Harness {
  db: DatabaseClient;
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
    executionWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    sessionId,
    turnId,
    durableRunId,
    taskId,
    leaseRevision: 1,
    capabilityProfileSha256: CAPABILITY_PROFILE,
    routedContextSha256: ROUTED_CONTEXT,
    capabilityClaims: ["worker_runtime", "gateway_inference"],
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
  return { db, repo: new RemoteWorkerInferenceRepository(db), authority, submission, now };
}

function governanceReceipt(
  decision: RemoteWorkerInferenceGovernanceReceipt["decision"] = "allowed",
  effectiveRouteSha256 = remoteWorkerInferenceEffectiveRouteSha256(routeReceipt()),
): RemoteWorkerInferenceGovernanceReceipt {
  return {
    schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
    decision,
    effectiveRouteSha256,
    policyRevision: 4,
    policySha256: D("policy"),
    ...(decision === "approval_required" ? { approvalReceiptSha256: D("approval") } : {}),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    expiresAt: FUTURE,
  };
}

function routeReceipt(): RemoteWorkerInferenceEffectiveRouteReceipt {
  return {
    schemaVersion: REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
    providerId: "anthropic",
    modelId: "claude-opus-4",
    apiStyle: "messages",
    credentialType: "api_key",
    usagePool: "standard",
    credentialSource: "keychain",
  };
}

interface ServiceDoubles {
  authority: RemoteWorkerInferenceAuthorityPort;
  governance: RemoteWorkerInferenceGovernancePort;
  approval: RemoteWorkerInferenceApprovalPort;
  budget: RemoteWorkerInferenceBudgetPort;
  routing: RemoteWorkerInferenceRoutingPort;
  adapter: RemoteWorkerInferenceDispatchAdapter & { calls: RemoteWorkerInferenceDispatchRequest[] };
  settled: string[][];
  released: string[];
  governanceCalls: number;
  reserveCalls: number;
  observedInputs: string[];
}

function promiseBackedRepository(
  repository: RemoteWorkerInferenceRepository,
  observe?: (value: unknown) => void,
): RemoteWorkerInferenceRepositoryPort {
  return {
    inspectReplay: async (submission) => {
      observe?.(submission);
      return repository.inspectReplay(submission);
    },
    admitOrReplay: async (input) => {
      observe?.(input);
      return repository.admitOrReplay(input);
    },
    recordApprovalContinuation: async (input) => repository.recordApprovalContinuation(input),
    recordBudgetReservation: async (key, reservation, now) => repository.recordBudgetReservation(key, reservation, now),
    recordBudgetReleaseIntent: async (key, input) => repository.recordBudgetReleaseIntent(key, input),
    markBudgetReleased: async (key, reason, now) => repository.markBudgetReleased(key, reason, now),
    blockBeforeDispatch: async (key, input) => repository.blockBeforeDispatch(key, input),
    claimDispatch: async (input) => repository.claimDispatch(input),
    appendOutputFrame: async (input) => repository.appendOutputFrame(input),
    markDispatchUnknown: async (key, input) => repository.markDispatchUnknown(key, input),
    recoverExpiredDispatchUnknown: async (key, now) => repository.recoverExpiredDispatchUnknown(key, now),
    finalizeTerminal: async (input) => repository.finalizeTerminal(input),
    markBudgetSettled: async (key, now) => repository.markBudgetSettled(key, now),
    acknowledge: async (key, throughSequence, now) => repository.acknowledge(key, throughSequence, now),
    getRequest: async (key) => repository.getRequest(key),
    listFramesAfter: async (key, afterSequence) => repository.listFramesAfter(key, afterSequence),
  };
}

function repositoryWithFailure(
  repository: RemoteWorkerInferenceRepository,
  method: keyof RemoteWorkerInferenceRepositoryPort,
  implementation: (...args: never[]) => unknown = () => {
    throw new Error(REPOSITORY_SECRET_CANARY);
  },
): RemoteWorkerInferenceRepositoryPort {
  const base = promiseBackedRepository(repository);
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === method) return implementation;
      return Reflect.get(target, property, receiver);
    },
  });
}

function build(
  h: Harness,
  options: {
    decision?: RemoteWorkerInferenceGovernanceReceipt["decision"];
    decisions?: RemoteWorkerInferenceGovernanceReceipt["decision"][];
    reserve?: boolean;
    reserveThrows?: boolean;
    budgetOwnerId?: string;
    expectedBudgetOwnerId?: string;
    approvalDecision?: "approved" | "rejected";
    approvalPending?: boolean;
    approvalResolvedAt?: string;
    authorityOverride?: () => RemoteWorkerInferenceResolvedAuthority | undefined;
    outcome?: RemoteWorkerInferenceDispatchOutcome;
    adapterThrows?: boolean;
    settleFailsOnce?: boolean;
    releaseFailsOnce?: boolean;
    releaseResponseLostOnce?: boolean;
    routeDrift?: boolean;
    promiseBackedOwners?: boolean;
    governanceThrows?: boolean;
    routingThrows?: boolean;
    approvalThrows?: boolean;
    reservationExpiresAt?: string;
    repositoryPort?: RemoteWorkerInferenceRepositoryPort;
    observeInputs?: boolean;
  } = {},
): { service: RemoteWorkerInferenceService; doubles: ServiceDoubles } {
  const settled: string[][] = [];
  const released: string[] = [];
  let governanceCalls = 0;
  let reserveCalls = 0;
  let settlementShouldFail = options.settleFailsOnce === true;
  let releaseShouldFail = options.releaseFailsOnce === true;
  let releaseResponseShouldBeLost = options.releaseResponseLostOnce === true;
  const observedInputs: string[] = [];
  const observe = (value: unknown): void => {
    if (options.observeInputs) observedInputs.push(JSON.stringify(value));
  };
  const adapter: ServiceDoubles["adapter"] = {
    calls: [],
    async dispatch(request) {
      if (options.observeInputs) observedInputs.push(JSON.stringify(request));
      this.calls.push(request);
      if (options.adapterThrows) throw new Error("adapter accounting failure");
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
      resolveActiveAuthority: (input) => {
        observe(input);
        const authority = options.authorityOverride ? options.authorityOverride() : h.authority;
        return options.promiseBackedOwners ? Promise.resolve(authority) : authority;
      },
    },
    governance: {
      evaluate: (input) => {
        observe(input);
        if (options.governanceThrows) throw new Error(GOVERNANCE_SECRET_CANARY);
        const decision = options.decisions?.[governanceCalls] ?? options.decision ?? "allowed";
        governanceCalls += 1;
        const receipt = governanceReceipt(decision);
        return options.promiseBackedOwners ? Promise.resolve(receipt) : receipt;
      },
    },
    approval: {
      resolve: ({ pendingApprovalReceiptSha256 }) => {
        observe({ pendingApprovalReceiptSha256 });
        if (options.approvalThrows) throw new Error(APPROVAL_SECRET_CANARY);
        if (options.approvalPending) return undefined;
        return {
          schemaVersion: REMOTE_WORKER_INFERENCE_APPROVAL_RESOLUTION_SCHEMA_VERSION,
          decision: options.approvalDecision ?? "approved",
          pendingApprovalReceiptSha256,
          resolutionSha256: D("approval-resolution"),
          resolvedAt: options.approvalResolvedAt ?? h.now,
        };
      },
    },
    budget: {
      reserve: ({ operation, operationSha256 }) => {
        observe({ operation, operationSha256 });
        reserveCalls += 1;
        if (options.reserveThrows) throw new Error(BUDGET_RESERVE_SECRET_CANARY);
        const reservation =
          options.reserve === false
            ? undefined
            : {
                schemaVersion: REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
                budgetOwnerId: options.budgetOwnerId ?? "test-budget-owner",
                reservationId: "reservation-1",
                operationId: operation.operationId,
                operationSha256,
                requestSha256: operation.requestSha256,
                effectiveRouteSha256: operation.effectiveRouteSha256,
                reservedOutputTokens: operation.outputTokenCeiling,
                reservedReasoningTokens: operation.reasoningTokenCeiling,
                reservedCostMicrousd: 1000,
                expiresAt: options.reservationExpiresAt ?? FUTURE,
              };
        return options.promiseBackedOwners ? Promise.resolve(reservation) : reservation;
      },
      settle: ({ usageEventIds }) => {
        observe({ usageEventIds });
        if (settlementShouldFail) {
          settlementShouldFail = false;
          throw new Error(BUDGET_SETTLE_SECRET_CANARY);
        }
        settled.push([...usageEventIds]);
        return options.promiseBackedOwners ? Promise.resolve() : undefined;
      },
      release: ({ reason }) => {
        observe({ reason });
        if (releaseShouldFail) {
          releaseShouldFail = false;
          throw new Error(BUDGET_RELEASE_SECRET_CANARY);
        }
        released.push(reason);
        if (releaseResponseShouldBeLost) {
          releaseResponseShouldBeLost = false;
          throw new Error(BUDGET_RELEASE_SECRET_CANARY);
        }
        return options.promiseBackedOwners ? Promise.resolve() : undefined;
      },
    },
    routing: {
      resolve: (input) => {
        observe(input);
        if (options.routingThrows) throw new Error(ROUTING_SECRET_CANARY);
        const resolution = {
          providerId: "anthropic" as const,
          modelId: options.routeDrift ? "claude-sonnet-4" : "claude-opus-4",
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
    released,
    get governanceCalls() {
      return governanceCalls;
    },
    get reserveCalls() {
      return reserveCalls;
    },
    observedInputs,
  };
  const service = new RemoteWorkerInferenceService({
    repository:
      options.repositoryPort ??
      (options.promiseBackedOwners || options.observeInputs ? promiseBackedRepository(h.repo, observe) : h.repo),
    authority: doubles.authority,
    governance: doubles.governance,
    approval: doubles.approval,
    budget: doubles.budget,
    routing: doubles.routing,
    adapter: doubles.adapter,
    budgetOwnerId: options.expectedBudgetOwnerId ?? "test-budget-owner",
    dispatchOwnerId: "gateway-host-1",
    clock: () => h.now,
  });
  return { service, doubles };
}

describe("RemoteWorkerInferenceService", () => {
  it("awaits Promise-backed storage, authority, governance, budget, and routing owners", async () => {
    const h = seed("async-owners");
    const { service, doubles } = build(h, { promiseBackedOwners: true });
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome.disposition).toBe("delivered");
    expect(outcome.request.state).toBe("completed");
    expect(doubles.adapter.calls).toHaveLength(1);
    expect(doubles.settled).toEqual([["usage-event-terminal"]]);
  });

  it("performs inference end to end, filters output to text frames, and settles from HX-306 event ids", async () => {
    const h = seed("happy");
    const { service, doubles } = build(h);
    const outcome = await service.performInference({ submission: h.submission });
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
    expect(doubles.adapter.calls[0]?.attribution).toMatchObject({
      workspaceId: h.authority.executionWorkspaceId,
      sessionId: h.authority.sessionId,
      turnId: h.authority.turnId,
      durableRunId: h.authority.durableRunId,
      taskId: h.authority.taskId,
      workerId: h.authority.workerId,
      contextIntentHash: h.authority.routedContextSha256,
    });
  });

  it("hashes the raw lease and never persists it", async () => {
    const h = seed("lease");
    const { service } = build(h);
    const outcome = await service.performInference({ submission: h.submission });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(h.submission.leaseToken);
    expect(outcome.request.requestBodyJson).not.toContain(h.submission.leaseToken);
  });

  it("fails closed without the worker_runtime and gateway_inference claims", async () => {
    const h = seed("claims");
    const { service, doubles } = build(h, {
      authorityOverride: () => ({ ...h.authority, capabilityClaims: ["worker_runtime"] }),
    });
    await expect(service.performInference({ submission: h.submission })).rejects.toBeInstanceOf(
      RemoteWorkerInferenceAccessError,
    );
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("records a governance denial as blocked and never dispatches", async () => {
    const h = seed("denied");
    const { service, doubles } = build(h, { decision: "denied" });
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome.disposition).toBe("blocked");
    expect(outcome.request.state).toBe("blocked");
    expect(doubles.adapter.calls).toHaveLength(0);
    expect(doubles.reserveCalls).toBe(0);
  });

  it("holds an approval_required request in waiting_approval without dispatching", async () => {
    const h = seed("approval");
    const { service, doubles } = build(h, { decision: "approval_required" });
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome.disposition).toBe("waiting_approval");
    expect(outcome.request.state).toBe("waiting_approval");
    expect(doubles.adapter.calls).toHaveLength(0);
    expect(doubles.reserveCalls).toBe(0);
  });

  it("fails closed when the atomic budget port denies the reservation", async () => {
    const h = seed("budget");
    const { service, doubles } = build(h, { reserve: false });
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome.disposition).toBe("blocked");
    expect(outcome.request.budgetAuthorityState).toBe("not_required");
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("redacts an indeterminate budget reservation-owner failure and leaves exact retry authority", async () => {
    const h = seed("budget-reserve-error");
    const { service, doubles } = build(h, { reserveThrows: true });
    let failure: unknown;
    try {
      await service.performInference({ submission: h.submission });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RemoteWorkerInferenceAccessError);
    expect((failure as Error).message).toBe("Remote worker inference budget reservation outcome is unavailable.");
    expect((failure as Error).message).not.toContain(BUDGET_RESERVE_SECRET_CANARY);
    const stored = h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey);
    expect(stored?.budgetAuthorityState).toBe("reservation_pending");
    expect(JSON.stringify(stored)).not.toContain(BUDGET_RESERVE_SECRET_CANARY);
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("fails closed on routed-context drift", async () => {
    const h = seed("drift");
    const drifted = { ...h.authority, routedContextSha256: D("other-context") };
    const { service } = build(h, { authorityOverride: () => drifted });
    await expect(service.performInference({ submission: h.submission })).rejects.toThrow(
      /routed-context hash drifted/u,
    );
  });

  it("fails closed when the lease authority is cancelled or terminal", async () => {
    const h = seed("cancel");
    const { service } = build(h, {
      authorityOverride: () => {
        throw new Error(AUTHORITY_SECRET_CANARY);
      },
    });
    let failure: unknown;
    try {
      await service.performInference({ submission: h.submission });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RemoteWorkerInferenceAccessError);
    expect((failure as Error).message).toBe(
      "Remote worker inference authority is cancelled, terminal, or unavailable.",
    );
    expect((failure as Error).message).not.toContain(AUTHORITY_SECRET_CANARY);
    expect(h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey)).toBeUndefined();
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
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome.disposition).toBe("dispatch_unknown");
    expect(outcome.request.state).toBe("dispatch_unknown");
    expect(outcome.request.terminalFrameSequence).toBeUndefined();
    expect(outcome.request.budgetAuthorityState).toBe("reconciliation_required");
    expect(doubles.settled).toEqual([]);
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
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome.disposition).toBe("failed");
    expect(outcome.request.state).toBe("failed");
    expect(outcome.frames.map((frame) => frame.frameKind)).toEqual(["terminal"]);
    expect(JSON.stringify(outcome.frames)).not.toContain("provider_error");
  });

  it("replays a completed request idempotently without re-invoking the provider", async () => {
    const h = seed("replay");
    const { service, doubles } = build(h);
    await service.performInference({ submission: h.submission });
    const callsBeforeReplay = {
      governance: doubles.governanceCalls,
      reserve: doubles.reserveCalls,
    };
    const replay = await service.performInference({ submission: h.submission });
    expect(replay.disposition).toBe("replayed");
    expect(doubles.adapter.calls).toHaveLength(1);
    expect(doubles.governanceCalls).toBe(callsBeforeReplay.governance);
    expect(doubles.reserveCalls).toBe(callsBeforeReplay.reserve);
    expect(replay.frames.map((frame) => frame.frameKind)).toEqual(["output_text", "output_text", "terminal"]);
  });

  it("replays the durable outbox on reconnect and advances the acknowledgement watermark", async () => {
    const h = seed("reconnect");
    const { service } = build(h);
    await service.performInference({ submission: h.submission });
    const pending = await service.readPendingFrames({ submission: h.submission });
    expect(pending.map((frame) => frame.frameSequence)).toEqual([1, 2, 3]);
    const acked = await service.acknowledge({
      submission: h.submission,
      throughSequence: 2,
    });
    expect(acked.workerAcknowledgedThrough).toBe(2);
    const afterAck = await service.readPendingFrames({
      submission: h.submission,
    });
    expect(afterAck.map((frame) => frame.frameSequence)).toEqual([3]);
  });

  it("rejects a worker read once the lease authority is lost", async () => {
    const h = seed("stale-read");
    let live = true;
    const { service } = build(h, { authorityOverride: () => (live ? h.authority : undefined) });
    await service.performInference({ submission: h.submission });
    live = false;
    await expect(service.readPendingFrames({ submission: h.submission })).rejects.toThrow(
      /unknown, stale, or expired/u,
    );
  });

  it("continues approval only after an approval-owner receipt and fresh allowed governance", async () => {
    const h = seed("approval-continuation");
    const { service, doubles } = build(h, { decisions: ["approval_required", "allowed", "allowed"] });
    const waiting = await service.performInference({ submission: h.submission });
    expect(waiting.disposition).toBe("waiting_approval");
    expect(doubles.reserveCalls).toBe(0);

    const completed = await service.performInference({ submission: h.submission });
    expect(completed.disposition).toBe("delivered");
    expect(JSON.parse(completed.request.approvalResolutionJson!).resolutionSha256).toBe(D("approval-resolution"));
    expect(doubles.reserveCalls).toBe(1);
    expect(doubles.adapter.calls).toHaveLength(1);
  });

  it("rejects stale approval-owner resolution evidence before governance or budget continuation", async () => {
    const h = seed("approval-stale");
    const { service, doubles } = build(h, {
      decisions: ["approval_required"],
      approvalResolvedAt: "2000-01-01T00:00:00.000Z",
    });
    const waiting = await service.performInference({ submission: h.submission });
    expect(waiting.disposition).toBe("waiting_approval");
    await expect(service.performInference({ submission: h.submission })).rejects.toThrow(/not temporally valid/u);
    expect(doubles.governanceCalls).toBe(1);
    expect(doubles.reserveCalls).toBe(0);
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("rejects route drift before budget reservation", async () => {
    const h = seed("route-drift");
    const { service, doubles } = build(h, { routeDrift: true });
    await expect(service.performInference({ submission: h.submission })).rejects.toThrow(/route.*digest/u);
    expect(doubles.reserveCalls).toBe(0);
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("pins the expected budget owner across the reservation boundary", async () => {
    const h = seed("budget-owner-drift");
    const { service, doubles } = build(h, { budgetOwnerId: "other-budget-owner" });
    await expect(service.performInference({ submission: h.submission })).rejects.toThrow(/budget reservation.*bind/u);
    expect(doubles.adapter.calls).toHaveLength(0);
    expect(h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey)?.budgetAuthorityState).toBe(
      "reservation_pending",
    );
  });

  it("revalidates current full authority before returning an exact replay", async () => {
    const h = seed("replay-authority");
    await build(h).service.performInference({ submission: h.submission });
    const replay = build(h, { authorityOverride: () => ({ ...h.authority, taskId: "other-task" }) });
    await expect(replay.service.performInference({ submission: h.submission })).rejects.toThrow(
      /stored authority drifted/u,
    );
    expect(replay.doubles.governanceCalls).toBe(0);
    expect(replay.doubles.reserveCalls).toBe(0);
    expect(replay.doubles.adapter.calls).toHaveLength(0);
  });

  it("recovers settlement after restart without redispatching the provider", async () => {
    const h = seed("settlement-restart");
    const first = build(h, { settleFailsOnce: true });
    let failure: unknown;
    try {
      await first.service.performInference({ submission: h.submission });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RemoteWorkerInferenceAccessError);
    expect((failure as Error).message).toBe("Remote worker inference budget settlement requires reconciliation.");
    expect((failure as Error).message).not.toContain(BUDGET_SETTLE_SECRET_CANARY);
    expect(h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey)?.budgetAuthorityState).toBe(
      "settlement_pending",
    );

    const wrongOwner = build(h, { expectedBudgetOwnerId: "different-budget-owner" });
    await expect(wrongOwner.service.performInference({ submission: h.submission })).rejects.toThrow(
      /budget owner identity drifted/u,
    );
    expect(wrongOwner.doubles.settled).toEqual([]);

    const restarted = build(h);
    const replay = await restarted.service.performInference({ submission: h.submission });
    expect(replay.disposition).toBe("replayed");
    expect(replay.request.budgetAuthorityState).toBe("settled");
    expect(restarted.doubles.adapter.calls).toHaveLength(0);
    expect(restarted.doubles.settled).toEqual([["usage-event-terminal"]]);
  });

  it("recovers a failed pre-dispatch release after restart without provider dispatch", async () => {
    const h = seed("release-restart");
    let resolutions = 0;
    const first = build(h, {
      releaseFailsOnce: true,
      authorityOverride: () => {
        resolutions += 1;
        return resolutions === 1 ? h.authority : { ...h.authority, routedContextSha256: D("drift-after-reserve") };
      },
    });
    let failure: unknown;
    try {
      await first.service.performInference({ submission: h.submission });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RemoteWorkerInferenceAccessError);
    expect((failure as Error).message).toBe("Remote worker inference budget release requires reconciliation.");
    expect((failure as Error).message).not.toContain(BUDGET_RELEASE_SECRET_CANARY);
    const blocked = h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey);
    expect(blocked?.state).toBe("blocked");
    expect(blocked?.budgetAuthorityState).toBe("reserved");
    expect(JSON.stringify(blocked)).not.toContain(BUDGET_RELEASE_SECRET_CANARY);

    const restarted = build(h);
    const replay = await restarted.service.performInference({ submission: h.submission });
    expect(replay.disposition).toBe("blocked");
    expect(replay.request.budgetAuthorityState).toBe("released");
    expect(restarted.doubles.released).toEqual(["pre_dispatch_authority_lost"]);
    expect(restarted.doubles.adapter.calls).toHaveLength(0);
  });

  it("marks an adapter/accounting throw reconciliation_required without fabricating HX-306 ids", async () => {
    const h = seed("adapter-throw");
    const { service, doubles } = build(h, { adapterThrows: true });
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome.disposition).toBe("dispatch_unknown");
    expect(outcome.request.budgetAuthorityState).toBe("reconciliation_required");
    expect(outcome.request.usageIntentEventId).toBeUndefined();
    expect(outcome.request.usageTerminalEventId).toBeUndefined();
    expect(doubles.settled).toEqual([]);
  });

  it("fences reads and acknowledgements to the exact persisted assignment and worker authority", async () => {
    const h = seed("read-fence");
    const { service } = build(h);
    await service.performInference({ submission: h.submission });
    const wrongKey = { ...h.submission, assignmentId: "another-assignment" };
    await expect(service.readPendingFrames({ submission: wrongKey })).rejects.toThrow(/does not bind/u);

    const drifted = build(h, { authorityOverride: () => ({ ...h.authority, workerId: "another-worker" }) });
    await expect(drifted.service.acknowledge({ submission: h.submission, throughSequence: 1 })).rejects.toThrow(
      /stored authority drifted/u,
    );
  });

  it("removes the raw lease before every repository, governance, routing, budget, and dispatch owner", async () => {
    const h = seed("lease-boundary-spies");
    const { service, doubles } = build(h, { observeInputs: true });
    await service.performInference({ submission: h.submission });

    const observed = doubles.observedInputs.join("\n");
    expect(observed).not.toContain(h.submission.leaseToken);
    expect(observed).not.toContain('"leaseToken":');
    const persisted = JSON.stringify({
      requests: h.db.prepare("SELECT * FROM remote_worker_inference_requests").all(),
      frames: h.db.prepare("SELECT * FROM remote_worker_inference_outbox").all(),
    });
    expect(persisted).not.toContain(h.submission.leaseToken);
    expect(persisted).not.toContain("lease_token");
  });

  it("sanitizes governance, routing, and approval owner exceptions", async () => {
    const governanceHarness = seed("governance-owner-error");
    await expectSanitizedFailure(
      build(governanceHarness, { governanceThrows: true }).service.performInference({
        submission: governanceHarness.submission,
      }),
      GOVERNANCE_SECRET_CANARY,
      "Remote worker inference governance evaluation is unavailable.",
    );
    expect(
      JSON.stringify(governanceHarness.db.prepare("SELECT * FROM remote_worker_inference_requests").all()),
    ).not.toContain(GOVERNANCE_SECRET_CANARY);

    const routingHarness = seed("routing-owner-error");
    await expectSanitizedFailure(
      build(routingHarness, { routingThrows: true }).service.performInference({
        submission: routingHarness.submission,
      }),
      ROUTING_SECRET_CANARY,
      "Remote worker inference route resolution is unavailable.",
    );
    expect(
      JSON.stringify(routingHarness.db.prepare("SELECT * FROM remote_worker_inference_requests").all()),
    ).not.toContain(ROUTING_SECRET_CANARY);

    const approvalHarness = seed("approval-owner-error");
    await build(approvalHarness, { decision: "approval_required" }).service.performInference({
      submission: approvalHarness.submission,
    });
    await expectSanitizedFailure(
      build(approvalHarness, { approvalThrows: true }).service.performInference({
        submission: approvalHarness.submission,
      }),
      APPROVAL_SECRET_CANARY,
      "Remote worker inference approval resolution is unavailable.",
    );
    expect(
      JSON.stringify(approvalHarness.db.prepare("SELECT * FROM remote_worker_inference_requests").all()),
    ).not.toContain(APPROVAL_SECRET_CANARY);
  });

  it("sanitizes repository failures on initial replay and admission", async () => {
    for (const method of ["inspectReplay", "admitOrReplay"] as const) {
      const h = seed(`repository-${method}`);
      const { service } = build(h, { repositoryPort: repositoryWithFailure(h.repo, method) });
      await expectSanitizedFailure(
        service.performInference({ submission: h.submission }),
        REPOSITORY_SECRET_CANARY,
        "Remote worker inference request failed at an owner boundary.",
      );
      expect(JSON.stringify(h.db.prepare("SELECT * FROM remote_worker_inference_requests").all())).not.toContain(
        REPOSITORY_SECRET_CANARY,
      );
    }
  });

  it("marks append/finalize owner failures unknown and never rethrows their raw exceptions", async () => {
    for (const method of ["appendOutputFrame", "finalizeTerminal"] as const) {
      const h = seed(`repository-${method}`);
      const { service } = build(h, {
        repositoryPort: repositoryWithFailure(h.repo, method),
        ...(method === "finalizeTerminal"
          ? {
              outcome: {
                terminalState: "completed" as const,
                chunks: [],
                usageEventId: "usage-event-terminal",
                usageEventIds: ["usage-event-terminal"],
                transportAttempts: 1,
              },
            }
          : {}),
      });
      await expectSanitizedFailure(
        service.performInference({ submission: h.submission }),
        REPOSITORY_SECRET_CANARY,
        "Remote worker inference dispatch evidence requires reconciliation.",
      );
      expect(h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey)?.budgetAuthorityState).toBe(
        "reconciliation_required",
      );
      expect(JSON.stringify(h.db.prepare("SELECT * FROM remote_worker_inference_requests").all())).not.toContain(
        REPOSITORY_SECRET_CANARY,
      );
    }
  });

  it("sanitizes settlement/release commit and read/ack repository failures", async () => {
    const settlement = seed("repository-settlement-commit");
    await expectSanitizedFailure(
      build(settlement, {
        repositoryPort: repositoryWithFailure(settlement.repo, "markBudgetSettled"),
      }).service.performInference({ submission: settlement.submission }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference budget settlement owner is unavailable.",
    );
    expect(
      settlement.repo.getRequestByIdempotency("default", settlement.submission.idempotencyKey)?.budgetAuthorityState,
    ).toBe("settlement_pending");

    const release = seed("repository-release-commit");
    let releaseResolutions = 0;
    const releaseBuild = build(release, {
      repositoryPort: repositoryWithFailure(release.repo, "markBudgetReleased"),
      authorityOverride: () => {
        releaseResolutions += 1;
        return releaseResolutions === 1
          ? release.authority
          : { ...release.authority, routedContextSha256: D("release-owner-drift") };
      },
    });
    await expectSanitizedFailure(
      releaseBuild.service.performInference({ submission: release.submission }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference budget release requires reconciliation.",
    );
    expect(releaseBuild.doubles.released).toEqual(["pre_dispatch_authority_lost"]);
    expect(release.repo.getRequestByIdempotency("default", release.submission.idempotencyKey)).toMatchObject({
      state: "blocked",
      budgetAuthorityState: "reserved",
    });

    const readAck = seed("repository-read-ack");
    await build(readAck).service.performInference({ submission: readAck.submission });
    await expectSanitizedFailure(
      build(readAck, {
        repositoryPort: repositoryWithFailure(readAck.repo, "listFramesAfter"),
      }).service.readPendingFrames({ submission: readAck.submission }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference frame read owner is unavailable.",
    );
    await expectSanitizedFailure(
      build(readAck, { repositoryPort: repositoryWithFailure(readAck.repo, "acknowledge") }).service.acknowledge({
        submission: readAck.submission,
        throughSequence: 1,
      }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference acknowledgement owner is unavailable.",
    );
  });

  it("commits release intent before the external effect and survives response loss with the exact stored reason", async () => {
    const precommit = seed("release-intent-precommit");
    let precommitResolutions = 0;
    const precommitBuild = build(precommit, {
      repositoryPort: repositoryWithFailure(precommit.repo, "recordBudgetReleaseIntent"),
      authorityOverride: () => {
        precommitResolutions += 1;
        return precommitResolutions === 1
          ? precommit.authority
          : { ...precommit.authority, routedContextSha256: D("precommit-drift") };
      },
    });
    await expectSanitizedFailure(
      precommitBuild.service.performInference({ submission: precommit.submission }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference budget release intent could not be committed.",
    );
    expect(precommitBuild.doubles.released).toEqual([]);
    expect(precommit.repo.getRequestByIdempotency("default", precommit.submission.idempotencyKey)).toMatchObject({
      state: "admitted",
      budgetAuthorityState: "reserved",
    });

    const postcommit = seed("release-intent-postcommit");
    const postcommitBase = promiseBackedRepository(postcommit.repo);
    const postcommitPort: RemoteWorkerInferenceRepositoryPort = {
      ...postcommitBase,
      recordBudgetReleaseIntent: async (key, input) => {
        await postcommitBase.recordBudgetReleaseIntent(key, input);
        throw new Error(REPOSITORY_SECRET_CANARY);
      },
    };
    let postcommitResolutions = 0;
    const postcommitBuild = build(postcommit, {
      repositoryPort: postcommitPort,
      authorityOverride: () => {
        postcommitResolutions += 1;
        return postcommitResolutions === 1
          ? postcommit.authority
          : { ...postcommit.authority, routedContextSha256: D("postcommit-drift") };
      },
    });
    await expectSanitizedFailure(
      postcommitBuild.service.performInference({ submission: postcommit.submission }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference budget release intent could not be committed.",
    );
    expect(postcommitBuild.doubles.released).toEqual([]);
    expect(postcommit.repo.getRequestByIdempotency("default", postcommit.submission.idempotencyKey)).toMatchObject({
      state: "blocked",
      budgetAuthorityState: "reserved",
      budgetReleaseReason: "pre_dispatch_authority_lost",
    });
    const postcommitRestart = build(postcommit);
    const postcommitRecovered = await postcommitRestart.service.performInference({ submission: postcommit.submission });
    expect(postcommitRecovered.request.budgetAuthorityState).toBe("released");
    expect(postcommitRestart.doubles.released).toEqual(["pre_dispatch_authority_lost"]);

    const responseLoss = seed("release-response-loss");
    const first = build(responseLoss, {
      decisions: ["allowed", "denied"],
      releaseResponseLostOnce: true,
    });
    await expectSanitizedFailure(
      first.service.performInference({ submission: responseLoss.submission }),
      BUDGET_RELEASE_SECRET_CANARY,
      "Remote worker inference budget release requires reconciliation.",
    );
    const intent = responseLoss.repo.getRequestByIdempotency("default", responseLoss.submission.idempotencyKey);
    expect(intent).toMatchObject({
      state: "blocked",
      budgetAuthorityState: "reserved",
      budgetReleaseReason: "governance_denied",
      blockReason: "pre_dispatch_governance_denied",
    });
    const restarted = build(responseLoss);
    const recovered = await restarted.service.performInference({ submission: responseLoss.submission });
    expect(recovered.request.budgetAuthorityState).toBe("released");
    expect(restarted.doubles.released).toEqual(["governance_denied"]);
    expect(restarted.doubles.adapter.calls).toHaveLength(0);
  });

  it("releases an expired persisted reservation after restart without reserving or dispatching again", async () => {
    const h = seed("expired-reservation-restart");
    const base = promiseBackedRepository(h.repo);
    const postcommitLoss: RemoteWorkerInferenceRepositoryPort = {
      ...base,
      recordBudgetReservation: async (key, reservation, now) => {
        await base.recordBudgetReservation(key, reservation, now);
        throw new Error(REPOSITORY_SECRET_CANARY);
      },
    };
    await expectSanitizedFailure(
      build(h, {
        repositoryPort: postcommitLoss,
        reservationExpiresAt: "2000-01-01T00:00:00.000Z",
      }).service.performInference({ submission: h.submission }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference request failed at an owner boundary.",
    );
    expect(h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey)).toMatchObject({
      state: "admitted",
      budgetAuthorityState: "reserved",
      budgetReservationExpiresAt: "2000-01-01T00:00:00.000Z",
    });

    const restarted = build(h);
    const recovered = await restarted.service.performInference({ submission: h.submission });
    expect(recovered).toMatchObject({ disposition: "blocked", request: { budgetAuthorityState: "released" } });
    expect(recovered.request.budgetReleaseReason).toBe("budget_revalidation_failed");
    expect(restarted.doubles.reserveCalls).toBe(0);
    expect(restarted.doubles.adapter.calls).toHaveLength(0);
  });

  it("recovers exactly when the released DB commit succeeds but its response is lost", async () => {
    const h = seed("released-commit-response-loss");
    const base = promiseBackedRepository(h.repo);
    let loseCommitResponse = true;
    const responseLostPort: RemoteWorkerInferenceRepositoryPort = {
      ...base,
      markBudgetReleased: async (key, reason, now) => {
        const released = await base.markBudgetReleased(key, reason, now);
        if (loseCommitResponse) {
          loseCommitResponse = false;
          throw new Error(REPOSITORY_SECRET_CANARY);
        }
        return released;
      },
    };
    let resolutions = 0;
    const first = build(h, {
      repositoryPort: responseLostPort,
      authorityOverride: () => {
        resolutions += 1;
        return resolutions === 1 ? h.authority : { ...h.authority, routedContextSha256: D("released-commit-drift") };
      },
    });
    await expectSanitizedFailure(
      first.service.performInference({ submission: h.submission }),
      REPOSITORY_SECRET_CANARY,
      "Remote worker inference budget release requires reconciliation.",
    );
    expect(first.doubles.released).toEqual(["pre_dispatch_authority_lost"]);
    expect(h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey)).toMatchObject({
      state: "blocked",
      budgetAuthorityState: "released",
    });

    const restarted = build(h);
    const replay = await restarted.service.performInference({ submission: h.submission });
    expect(replay).toMatchObject({ disposition: "blocked", request: { budgetAuthorityState: "released" } });
    expect(restarted.doubles.released).toEqual([]);
    expect(restarted.doubles.adapter.calls).toHaveLength(0);
  });

  it("turns a DB-clock claim expiry into a durable release instead of a stranded admitted row", async () => {
    const h = seed("claim-db-clock-expiry");
    const base = promiseBackedRepository(h.repo);
    const missedClaim: RemoteWorkerInferenceRepositoryPort = {
      ...base,
      claimDispatch: async () => undefined,
    };
    const { service, doubles } = build(h, { repositoryPort: missedClaim });
    const outcome = await service.performInference({ submission: h.submission });
    expect(outcome).toMatchObject({ disposition: "blocked", request: { budgetAuthorityState: "released" } });
    expect(outcome.request.budgetReleaseReason).toBe("budget_revalidation_failed");
    expect(doubles.released).toEqual(["budget_revalidation_failed"]);
    expect(doubles.adapter.calls).toHaveLength(0);
  });

  it("lets a concurrent dispatch claim defeat release intent before any external release", async () => {
    const h = seed("release-claim-race");
    const base = promiseBackedRepository(h.repo);
    const racingRepository: RemoteWorkerInferenceRepositoryPort = {
      ...base,
      recordBudgetReleaseIntent: async (key, input) => {
        const current = h.repo.getRequest(key)!;
        h.repo.claimDispatch({
          ...key,
          dispatchClaimOwner: "concurrent-owner",
          effectiveProviderId: "anthropic",
          effectiveModelId: "claude-opus-4",
          effectiveRouteSha256: current.effectiveRouteSha256,
          dispatchLeaseExpiresAt: FUTURE,
          now: h.now,
        });
        return await base.recordBudgetReleaseIntent(key, input);
      },
    };
    let resolutions = 0;
    const { service, doubles } = build(h, {
      repositoryPort: racingRepository,
      authorityOverride: () => {
        resolutions += 1;
        return resolutions === 1 ? h.authority : { ...h.authority, routedContextSha256: D("claim-race-drift") };
      },
    });
    await expect(service.performInference({ submission: h.submission })).rejects.toThrow(
      "Remote worker inference budget release intent could not be committed.",
    );
    expect(doubles.released).toEqual([]);
    expect(doubles.adapter.calls).toHaveLength(0);
    expect(h.repo.getRequestByIdempotency("default", h.submission.idempotencyKey)).toMatchObject({
      state: "dispatch_claimed",
      budgetAuthorityState: "reserved",
      dispatchClaimOwner: "concurrent-owner",
    });
  });
});

async function expectSanitizedFailure(
  operation: Promise<unknown>,
  canary: string,
  expectedMessage: string,
): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RemoteWorkerInferenceAccessError);
  expect((failure as Error).message).toBe(expectedMessage);
  expect((failure as Error).message).not.toContain(canary);
}
