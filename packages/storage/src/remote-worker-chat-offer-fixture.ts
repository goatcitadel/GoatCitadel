import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  sealRemoteWorkerChatContextForTurn,
  type ChatTurnCapabilityProfileDraft,
  type ChatSubagentPolicy,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityToolDefinition,
  type RemoteWorkerAssignmentManifest,
  type CreateRemoteWorkerAssignmentCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import {
  ChatTurnCapabilityProfileRepository,
  sealChatTurnCapabilityProfile,
} from "./chat-turn-capability-profile-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import { CapabilityCatalogSnapshotRepository } from "./capability-catalog-snapshot-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { TaskRepository } from "./task-repo.js";
import { RemoteWorkerChatContextRepository } from "./remote-worker-chat-context-repo.js";
import type { ChatCompletionMessage } from "@goatcitadel/contracts";
import {
  RemoteWorkerAssignmentRepository,
  type ScheduleRemoteWorkerChatOfferInput,
} from "./remote-worker-assignment-repo.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const databaseClock = (db: DatabaseClient): string => new DurableRunRepository(db).readDatabaseNow();

export const CONNECTED_WORKER_CONTEXT_MESSAGES: ChatCompletionMessage[] = [
  { role: "system", content: "Frozen workspace guidance: the project name is Orion." },
  { role: "developer", content: "Frozen learned context: the project version is 7." },
  { role: "user", content: "What is the project name?" },
  { role: "assistant", content: "The project is Orion." },
  { role: "user", content: "Execute the connected-worker assignment." },
];

function capabilityProfileDraft(input: {
  profileId: string;
  catalogSnapshotId?: string;
  turnId: string;
  sessionId: string;
  durableRunId: string;
  createdAt: string;
  execution?: boolean;
  subagentPolicy?: ChatSubagentPolicy;
  tools?: ChatTurnCapabilityToolDefinition[];
  callableEntries?: CapabilityCatalogEntry[];
}): ChatTurnCapabilityProfileDraft {
  const catalogEntries = input.callableEntries ?? [];
  const catalogHash = sha256(canonicalJsonString(catalogEntries));
  const tools = input.tools ?? [];
  return {
    profileId: input.profileId,
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: "default",
      citadelId: "default",
      durableRunId: input.durableRunId,
      operatorId: "operator-a",
      authActorId: "operator-a",
      authActorSource: "token",
    },
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: input.catalogSnapshotId ?? "connected-worker-snapshot",
      inspectableHash: catalogHash,
      callableHash: catalogHash,
      inspectableCount: catalogEntries.length,
      callableCount: catalogEntries.length,
    },
    selection: {
      contentHash: input.execution
        ? sha256(canonicalJsonString("Execute the connected-worker assignment."))
        : sha256("connected-worker-content"),
      effectiveProviderId: input.execution ? "openai" : "provider-a",
      effectiveModel: input.execution ? "gpt-5.4" : "model-a",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "default",
        sessionId: input.sessionId,
        contextManifestRef: `chat-memory-scope:${sha256("connected-worker-memory-scope")}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: input.subagentPolicy ?? "auto_when_useful",
      toolAutonomy: "manual",
      tools,
      modelNameAllowMap: tools.map(({ modelName, canonicalName }) => ({ modelName, canonicalName })),
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: {
        profileId: "safe",
        approvalMode: "approve_all",
        profileHash: input.execution
          ? sha256(canonicalJsonString({ profileId: "safe", approvalMode: "approve_all" }))
          : sha256("connected-worker-permission"),
      },
      policyDecisions: tools.map((tool) => ({
        toolName: tool.canonicalName, allowed: true, requiresApproval: true, reasonCodes: [],
      })),
      authReadiness: [
        { kind: "provider", ref: "provider-a", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "chat", status: "ready", reasonCodes: [] },
        ...tools.map((tool) => ({ kind: "tool" as const, ref: tool.canonicalName,
          status: "ready" as const, reasonCodes: [],
        })),
      ],
      approval: {
        mode: "approve_all",
        selectedToolCount: tools.length,
        toolsRequiringApproval: tools.map((tool) => tool.canonicalName),
        approvalGranted: false,
      },
    },
    preflightFingerprint: sha256("connected-worker-preflight"),
    createdAt: input.createdAt,
  };
}

/**
 * Create the task-bound Chat assignment a scheduler would eventually dispatch,
 * through canonical storage. Executable fixtures use the production offer owner;
 * the protocol-only fixture retains its narrower transport manifest. Normal Chat
 * routing is not exercised here. The worker starts its generation by claiming.
 */
interface ChatOfferFixtureOptions {
  catalogSnapshotId?: string;
  freezeContextPhase?: "request" | "durable";
  skipContext?: boolean;
  genericChat?: boolean;
  subagentPolicy?: ChatSubagentPolicy;
  tools?: ChatTurnCapabilityToolDefinition[];
  callableEntries?: CapabilityCatalogEntry[];
}

export function prepareChatOfferFixture(
  db: DatabaseClient,
  execution = false,
  suffix = "",
  options: ChatOfferFixtureOptions = {},
): {
  readonly durableRunId: string;
  readonly offerInput: ScheduleRemoteWorkerChatOfferInput;
  readonly legacyCommand: CreateRemoteWorkerAssignmentCommand;
} {
  const now = databaseClock(db);
  const taskId = `task-connected-worker${suffix}`;
  const sessionId = `session-connected-worker${suffix}`;
  const turnId = `turn-connected-worker${suffix}`;
  const durableRunId = `run-connected-worker${suffix}`;
  if (!options.genericChat)
    new TaskRepository(db).create({ title: "Connected worker assignment", workspaceId: "default" }, now, { taskId });
  new ChatSessionLifecycleRepository(db).initialize({
    workspaceId: "default",
    sessionId,
    actorId: "operator-a",
    idempotencyKey: `lifecycle:connected-worker${suffix}`,
    correlationId: `correlation:connected-worker${suffix}`,
    metadataTimestamp: now,
  });
  new ChatTurnTraceRepository(db).create({
    turnId,
    sessionId,
    userMessageId: `message-connected-worker${suffix}`,
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const profile = sealChatTurnCapabilityProfile(
    capabilityProfileDraft({
      profileId: `profile-connected-worker${suffix}`,
      catalogSnapshotId: options.catalogSnapshotId,
      turnId,
      sessionId,
      durableRunId,
      createdAt: now,
      execution,
      subagentPolicy: options.subagentPolicy,
      tools: options.tools,
      callableEntries: options.callableEntries,
    }),
  );
  new CapabilityCatalogSnapshotRepository(db).create({
    snapshotId: options.catalogSnapshotId ?? "connected-worker-snapshot",
    inspectableEntries: options.callableEntries ?? [],
    callableEntries: options.callableEntries ?? [],
    createdAt: now,
  });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId, sessionId, turnId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  const durableRequest = { ...(options.genericChat ? {} : { policyTaskId: taskId }),
    content: "Execute the connected-worker assignment." } as const;
  const admissionMaterialSha256 = sha256(canonicalJsonString({ version: 2, request: durableRequest }));
  const mutationAdmissions = new SessionMutationAdmissionRepository(db);
  const profileAdmission = mutationAdmissions.admit({
    workspaceId: "default",
    sessionId,
    turnId,
    runtimeOwnerId: "runtime-connected-worker",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator-a",
    operation: "chat.turn.execute",
    materialSha256: admissionMaterialSha256,
    idempotencyKey: `admission:connected-worker${suffix}`,
    correlationId: `correlation:connected-worker${suffix}`,
  }).admission;
  db.transaction("immediate", () => {
    mutationAdmissions.bindCapabilityProfile({
      admissionId: profileAdmission.admissionId,
      workspaceId: profileAdmission.workspaceId,
      sessionId: profileAdmission.sessionId,
      sessionIncarnationId: profileAdmission.sessionIncarnationId,
      turnId: profileAdmission.turnId!,
      profileId: profile.profileId,
      profileHash: profile.hashes.profileHash,
      createdAt: profile.createdAt,
      requestRuntimeClaim: {
        runtimeOwnerId: profileAdmission.runtimeOwnerId!,
        leaseRevision: profileAdmission.runtimeLeaseRevision!,
      },
    });
    new ChatTurnCapabilityProfileRepository(db).create(profile);
  });
  const durablePayload = {
    version: "chat.turn.execute.v2",
    admissionId: profileAdmission.admissionId,
    sessionIncarnationId: profileAdmission.sessionIncarnationId,
    admissionMaterialSha256,
    workspaceId: "default",
    admissionAggregateRevision: profileAdmission.aggregateRevision,
    admissionControllerGeneration: profileAdmission.controllerGeneration,
    effectiveRequestMaterialSha256: sha256(
      canonicalJsonString({ version: 1, admissionMaterialSha256, request: durableRequest }),
    ),
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: durableRunId },
    requestActor: { actorKind: "operator", actorId: "operator-a" },
    sessionId,
    turnId,
    userMessageId: `message-connected-worker${suffix}`,
    assistantMessageId: `assistant-connected-worker${suffix}`,
    capabilityProfileId: profile.profileId,
    capabilityProfileHash: profile.hashes.profileHash,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: durableRequest,
  } as const;
  new DurableRunRepository(db).createRun({
    runId: durableRunId,
    workflowKey: "chat.turn.execute",
    status: "running",
    attemptCount: 0,
    maxAttempts: 3,
    leaseOwnerId: "gateway-connected-worker",
    leaseHeartbeatAt: now,
    leaseExpiresAt: execution ? new Date(Date.now() + 120_000).toISOString() : "2099-01-01T00:00:00.000Z",
    version: 3,
    startedAt: now,
    now,
    payload: durablePayload,
    metadata: {
      ...(options.genericChat ? {} : {
        remoteWorkerAssignmentParentContext: parentContext,
        remoteWorkerAssignmentParentContextSha256: parentContextSha256,
      }),
      ...(execution
        ? {
            remoteWorkerChatContextSha256: sealRemoteWorkerChatContextForTurn(
              durableRunId,
              durablePayload,
              CONNECTED_WORKER_CONTEXT_MESSAGES,
            ).contextSha256,
          }
        : {}),
      capabilityProfileId: profile.profileId,
      capabilityProfileHash: profile.hashes.profileHash,
    },
  });
  const freezeContext = () =>
    new RemoteWorkerChatContextRepository(db).freezeForAdmission({
      durableRunId,
      messages: CONNECTED_WORKER_CONTEXT_MESSAGES,
      ...(options.freezeContextPhase === "request"
        ? {
            requestRuntimeClaim: {
              runtimeOwnerId: profileAdmission.runtimeOwnerId!,
              leaseRevision: profileAdmission.runtimeLeaseRevision!,
            },
          }
        : { durableClaim: { durableRunId, leaseOwnerId: "gateway-connected-worker", attemptCount: 0 } }),
    });
  if (execution && !options.skipContext && options.freezeContextPhase === "request") freezeContext();
  mutationAdmissions.bindDurableRun({
    admissionId: profileAdmission.admissionId,
    workspaceId: profileAdmission.workspaceId,
    sessionId: profileAdmission.sessionId,
    sessionIncarnationId: profileAdmission.sessionIncarnationId,
    turnId: profileAdmission.turnId!,
    durableRunId,
    requestRuntimeClaim: {
      runtimeOwnerId: profileAdmission.runtimeOwnerId!,
      leaseRevision: profileAdmission.runtimeLeaseRevision!,
    },
  });
  if (execution && !options.skipContext && options.freezeContextPhase !== "request") freezeContext();
  const manifest: RemoteWorkerAssignmentManifest = {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    registryWorkspaceId: "default",
    ...parentInput,
    capabilityProfileSha256: profile.hashes.profileHash,
    contextSnapshotSha256: sha256("connected-worker-context-snapshot"),
    toolEffectPostureSha256: sha256("connected-worker-tool-posture"),
    pathJailSha256: sha256("connected-worker-path-jail"),
    parentContextSha256,
    requiredCapabilityClasses: execution
      ? ["artifact_stage", "durable_compute", "gateway_inference"]
      : ["durable_compute"],
    deadlineAt: "2099-01-01T00:00:00.000Z",
    leaseTtlSeconds: 300,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes: 65_536,
    maxArtifactBytes: 1_048_576,
  };
  const offerInput: ScheduleRemoteWorkerChatOfferInput = {
    registryWorkspaceId: "default",
    executionWorkspaceId: "default",
    sessionId,
    turnId,
    durableRunId,
    dispatchOwnerId: "gateway-connected-worker",
    durableRunAttempt: 0,
    durableRunVersion: 3,
    payloadMaterialSha256: sha256(canonicalJsonString(durablePayload)),
    pathJailSha256: manifest.pathJailSha256,
    deadlineAt: manifest.deadlineAt,
    limits: {
      leaseTtlSeconds: manifest.leaseTtlSeconds,
      maxEventCount: manifest.maxEventCount,
      maxEventBytes: manifest.maxEventBytes,
      eventLowWatermark: manifest.eventLowWatermark,
      eventHighWatermark: manifest.eventHighWatermark,
      maxOutputBytes: manifest.maxOutputBytes,
      maxArtifactBytes: manifest.maxArtifactBytes,
    },
  };
  return {
    durableRunId,
    offerInput,
    legacyCommand: {
      manifest,
      createdByActorId: "gateway-connected-worker",
      idempotencyKey: `assignment:connected-worker${suffix}`,
    },
  };
}

export function seedAssignmentOffer(
  db: DatabaseClient,
  execution = false,
  suffix = "",
  beforeSchedule?: (input: ScheduleRemoteWorkerChatOfferInput) => void,
  options: ChatOfferFixtureOptions = {},
) {
  const prepared = prepareChatOfferFixture(db, execution, suffix, options);
  beforeSchedule?.(prepared.offerInput);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const assignment = execution
    ? assignments.scheduleTaskBoundChatOffer(prepared.offerInput).assignment
    : assignments.createAssignment(prepared.legacyCommand).assignment;
  return {
    assignmentId: assignment.assignmentId,
    durableRunId: prepared.durableRunId,
    offerInput: prepared.offerInput,
  };
}

/** Run the same scheduler invariants against SQLite and real PostgreSQL. */
export function verifyChatOfferScheduling(db: DatabaseClient): void {
  const { assignmentId, durableRunId, offerInput } = seedAssignmentOffer(db, true);
  const handoffAssignments = new RemoteWorkerAssignmentRepository(db);
  const handoffScope = { executionWorkspaceId: offerInput.executionWorkspaceId, sessionId: offerInput.sessionId,
    turnId: offerInput.turnId, durableRunId };
  assert.equal(handoffAssignments.findTaskBoundChatAssignment(handoffScope)?.assignment.assignmentId, assignmentId);
  for (const key of Object.keys(handoffScope) as (keyof typeof handoffScope)[])
    assert.equal(handoffAssignments.findTaskBoundChatAssignment({ ...handoffScope, [key]: "another-owner" }), undefined);
  const contexts = new RemoteWorkerChatContextRepository(db);
  const context = contexts.findForRun(durableRunId)!;
  assert.deepEqual(context.messages, CONNECTED_WORKER_CONTEXT_MESSAGES);
  const freezeInput = {
    durableRunId,
    messages: CONNECTED_WORKER_CONTEXT_MESSAGES,
    durableClaim: { durableRunId, leaseOwnerId: offerInput.dispatchOwnerId, attemptCount: 0 },
  };
  assert.deepEqual(contexts.freezeForAdmission(freezeInput), context);
  assert.throws(
    () =>
      contexts.freezeForAdmission({
        ...freezeInput,
        messages: [{ role: "system", content: "changed guidance" }, ...CONNECTED_WORKER_CONTEXT_MESSAGES.slice(1)],
      }),
    /frozen admission digest/,
  );
  assert.throws(() =>
    contexts.freezeForAdmission({
      ...freezeInput,
      durableClaim: { ...freezeInput.durableClaim, leaseOwnerId: "stale-owner" },
    }),
  );
  assert.throws(
    () =>
      db
        .prepare("UPDATE remote_worker_chat_contexts SET context_json = ? WHERE durable_run_id = ?")
        .run("{}", durableRunId),
    /immutable/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM remote_worker_chat_contexts WHERE durable_run_id = ?").run(durableRunId),
    /immutable/,
  );
  const offers = new RemoteWorkerAssignmentRepository(db);
  const original = offers.getAssignment("default", assignmentId);
  assert.equal(original.manifest.contextSnapshotSha256, context.contextSha256);
  assert.deepEqual(offers.scheduleTaskBoundChatOffer(offerInput), { disposition: "replayed", assignment: original });
  const renewed = new DurableRunRepository(db).renewLeaseWithDatabaseClock({
    runId: durableRunId,
    workerId: offerInput.dispatchOwnerId,
    leaseDurationMs: 300_000,
  });
  assert.equal(renewed?.version, 4);
  assert.throws(() => offers.scheduleTaskBoundChatOffer(offerInput), /execution claim/);
  const fresh = { ...offerInput, durableRunVersion: 4 };
  assert.deepEqual(offers.scheduleTaskBoundChatOffer(fresh).assignment, original);
  for (const change of [
    { dispatchOwnerId: "different-owner" },
    { durableRunAttempt: 2 },
    { payloadMaterialSha256: "0".repeat(64) },
    { executionWorkspaceId: "foreign-workspace" },
    { sessionId: "foreign-session" },
    { turnId: "foreign-turn" },
    { deadlineAt: "2099-01-02T00:00:00.000Z" },
    { limits: { ...fresh.limits, maxOutputBytes: fresh.limits.maxOutputBytes + 1 } },
  ])
    assert.throws(() => offers.scheduleTaskBoundChatOffer({ ...fresh, ...change }));
  // Extra caller properties cannot overwrite server-derived identity through
  // the execution-limits object.
  assert.deepEqual(
    offers.scheduleTaskBoundChatOffer({
      ...fresh,
      limits: Object.assign({}, fresh.limits, { executionWorkspaceId: "foreign-workspace" }),
    }).assignment,
    original,
  );
  const count = () =>
    Number(db.prepare("SELECT COUNT(*) AS count FROM remote_worker_assignments").get<{ count: number }>()!.count);
  assert.equal(count(), 1);
  const requestPhase = prepareChatOfferFixture(db, true, "-request-phase", { freezeContextPhase: "request" });
  assert.deepEqual(contexts.findForRun(requestPhase.durableRunId)?.messages, CONNECTED_WORKER_CONTEXT_MESSAGES);
  assert.throws(
    () =>
      contexts.freezeForAdmission({
        durableRunId: requestPhase.durableRunId,
        messages: CONNECTED_WORKER_CONTEXT_MESSAGES,
        requestRuntimeClaim: { runtimeOwnerId: "runtime-connected-worker", leaseRevision: 1 },
      }),
    /Durable turn mutation requires/,
  );
  const missingContext = prepareChatOfferFixture(db, true, "-missing-context", { skipContext: true });
  assert.throws(() => offers.scheduleTaskBoundChatOffer(missingContext.offerInput), /frozen context is missing/);
  assert.equal(count(), 1, "A missing executable conversation cannot produce an offer.");
  // Recovery changes the executing Gateway process, not the admitted actor or
  // the already-created offer. Use the durable owner's expired-lease fence and
  // queue/claim transitions so an old process cannot replay with stale authority.
  const expiredAt = "2000-01-01T00:00:00.000Z";
  db.prepare("UPDATE durable_runs SET lease_expires_at = ? WHERE run_id = ?").run(expiredAt, durableRunId);
  const runs = new DurableRunRepository(db);
  db.transaction("immediate", () => {
    const expired = runs.lockExpiredLeaseForUpdate({
      runId: durableRunId,
      expectedLeaseOwnerId: fresh.dispatchOwnerId,
      expectedLeaseExpiresAt: expiredAt,
    });
    assert.ok(expired);
    runs.updateRun({
      runId: durableRunId,
      status: "queued",
      attemptCount: expired.attemptCount + 1,
      clearLease: true,
      expectedVersion: expired.version,
    });
  });
  const recoveredRun = runs.tryClaimQueuedRunWithDatabaseClock({
    runId: durableRunId,
    workerId: "gateway-replacement-process",
    leaseDurationMs: 300_000,
  });
  assert.ok(recoveredRun?.leaseOwnerId);
  const recovered = {
    ...fresh,
    dispatchOwnerId: recoveredRun.leaseOwnerId,
    durableRunAttempt: recoveredRun.attemptCount,
    durableRunVersion: recoveredRun.version,
  };
  assert.throws(() => offers.scheduleTaskBoundChatOffer(fresh), /execution claim/);
  assert.deepEqual(offers.scheduleTaskBoundChatOffer(recovered), { disposition: "replayed", assignment: original });
  assert.equal(original.createdByActorId, "operator-a");
  assert.equal(count(), 1, "Gateway replacement must preserve the original offer, manifest and deadline.");
  assert.deepEqual(contexts.findForRun(durableRunId), context, "Recovery cannot rewrite the admitted conversation.");
  assert.throws(
    () =>
      seedAssignmentOffer(db, true, "-rollback", (input) => {
        const row = db
          .prepare("SELECT metadata_json FROM durable_runs WHERE run_id = ?")
          .get<{ metadata_json: string }>(input.durableRunId)!;
        const metadata = JSON.parse(row.metadata_json);
        metadata.capabilityProfileHash = "0".repeat(64);
        db.prepare("UPDATE durable_runs SET metadata_json = ? WHERE run_id = ?").run(
          JSON.stringify(metadata),
          input.durableRunId,
        );
      }),
    /workload binding/,
  );
  assert.equal(count(), 1, "An invalid post-insert admission must roll back its offer.");
  db.prepare("UPDATE durable_runs SET lease_expires_at = ? WHERE run_id = ?").run(
    "2000-01-01T00:00:00.000Z",
    durableRunId,
  );
  assert.throws(() => offers.scheduleTaskBoundChatOffer(recovered), /execution claim/);
  assert.equal(count(), 1);
}
