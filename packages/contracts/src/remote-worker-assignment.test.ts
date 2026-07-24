import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import { REMOTE_WORKER_PROTOCOL_VERSION } from "./remote-worker-admission.js";
import {
  REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_EVENT_TYPES,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  assertRemoteWorkerAssignmentLeaseRecord,
  buildRemoteWorkerAssignmentFlowControl,
  buildRemoteWorkerAssignmentParentContext,
  normalizeAppendRemoteWorkerAssignmentEventsCommand,
  normalizeRecordRemoteWorkerAssignmentMaterializationCommand,
  normalizeRemoteWorkerAssignmentEventInput,
  normalizeRemoteWorkerAssignmentManifest,
  normalizeSettleRemoteWorkerAssignmentCommand,
  remoteWorkerAssignmentCanonicalSha256,
  remoteWorkerAssignmentParentContextSha256,
  remoteWorkerAssignmentRecoveryReplayMaterial,
  type RecoverRemoteWorkerAssignmentCommand,
  type RemoteWorkerAssignmentDispatchAuthority,
  type RemoteWorkerAssignmentEventInput,
  type RemoteWorkerAssignmentManifest,
} from "./remote-worker-assignment.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function parentInput() {
  return {
    executionWorkspaceId: "workspace-a",
    durableRunId: "run-a",
    taskId: "task-a",
    sessionId: "session-a",
    turnId: "turn-a",
  } as const;
}

function manifest(overrides: Partial<RemoteWorkerAssignmentManifest> = {}): RemoteWorkerAssignmentManifest {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    registryWorkspaceId: "registry-a",
    ...parentInput(),
    capabilityProfileSha256: D("capability-profile"),
    contextSnapshotSha256: D("context-snapshot"),
    toolEffectPostureSha256: D("tool-effect-posture"),
    pathJailSha256: D("path-jail"),
    parentContextSha256: remoteWorkerAssignmentParentContextSha256(parentInput()),
    requiredCapabilityClasses: ["artifact_stage", "durable_compute", "gateway_inference"],
    deadlineAt: "2030-01-01T00:00:00.000Z",
    leaseTtlSeconds: 60,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes: 65_536,
    maxArtifactBytes: 1_048_576,
    ...overrides,
  };
}

function statusEvent(sequence: number, workerSentThrough = sequence): RemoteWorkerAssignmentEventInput {
  return {
    sequence,
    eventId: `event-${sequence}`,
    eventType: "status",
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      phase: "running",
      statusSha256: D(`status-${sequence}`),
    },
    previousEventSha256: sequence === 1 ? REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256 : D(`event-${sequence - 1}`),
    workerSentThrough,
  };
}

function authority(
  overrides: Partial<RemoteWorkerAssignmentDispatchAuthority> = {},
): RemoteWorkerAssignmentDispatchAuthority {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION,
    durableRunId: "run-a",
    durableRunAttempt: 1,
    dispatchOwnerId: "gateway-a",
    durableRunVersion: 7,
    durableRunLeaseExpiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("remote worker assignment contracts", () => {
  it("binds the manifest to strict canonical parent context and bounded sorted ceilings", () => {
    const normalized = normalizeRemoteWorkerAssignmentManifest(manifest());
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized.requiredCapabilityClasses).toEqual(["artifact_stage", "durable_compute", "gateway_inference"]);
    expect(buildRemoteWorkerAssignmentParentContext(parentInput())).toEqual({
      schemaVersion: "goatcitadel.remote-worker-assignment-parent-context.v1",
      ...parentInput(),
    });
    expect(() =>
      normalizeRemoteWorkerAssignmentManifest(
        manifest({ requiredCapabilityClasses: ["durable_compute", "artifact_stage"] }),
      ),
    ).toThrow(/sorted and unique/u);
    expect(() => normalizeRemoteWorkerAssignmentManifest(manifest({ parentContextSha256: D("wrong") }))).toThrow(
      /parent context digest/u,
    );
    expect(() => normalizeRemoteWorkerAssignmentManifest(manifest({ eventLowWatermark: 5 }))).toThrow(/low watermark/u);
    expect(() => normalizeRemoteWorkerAssignmentManifest({ ...manifest(), turnId: undefined } as never)).toThrow(
      /present together/u,
    );
  });

  it("does not echo attacker-controlled unknown manifest fields", () => {
    const secretField = "apiKey_SUPER_SECRET_value";
    let message = "";
    try {
      normalizeRemoteWorkerAssignmentManifest({ ...manifest(), [secretField]: "private" } as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/unknown fields/u);
    expect(message).not.toContain(secretField);
    expect(message).not.toContain("private");
  });

  it("uses browser-safe canonical SHA-256 parity", () => {
    const value = { b: [2, 1], a: "goat" };
    expect(remoteWorkerAssignmentCanonicalSha256(value)).toBe(D(canonicalJsonString(value)));
  });

  it("keeps the event vocabulary fixed and model progress free of provider or usage truth", () => {
    expect(REMOTE_WORKER_ASSIGNMENT_EVENT_TYPES).toEqual([
      "status",
      "tool_progress",
      "model_progress",
      "approval_wait",
      "diagnostic",
      "transcript_delta",
      "terminal_output",
    ]);
    const modelEvent = normalizeRemoteWorkerAssignmentEventInput({
      sequence: 1,
      eventId: "model-1",
      eventType: "model_progress",
      payload: {
        schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
        inferenceRequestId: "inference-a",
        inferenceAttempt: 1,
        phase: "streaming",
        modelIntentSha256: D("intent"),
      },
      previousEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
      workerSentThrough: 1,
    });
    expect(modelEvent.payload).not.toHaveProperty("provider");
    expect(modelEvent.payload).not.toHaveProperty("usage");
    expect(() =>
      normalizeRemoteWorkerAssignmentEventInput({
        ...modelEvent,
        payload: { ...modelEvent.payload, provider: "secret-provider", usage: { tokens: 2 } },
      } as never),
    ).toThrow(/unknown fields/u);
    expect(() =>
      normalizeRemoteWorkerAssignmentEventInput({ ...statusEvent(1), eventType: "artifact" } as never),
    ).toThrow(/unsupported/u);
  });

  it("requires contiguous batches with monotonic sent-through watermarks", () => {
    const base = {
      registryWorkspaceId: "registry-a",
      assignmentId: "assignment-a",
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      leaseTokenSha256: D("lease"),
    } as const;
    expect(
      normalizeAppendRemoteWorkerAssignmentEventsCommand({
        ...base,
        events: [statusEvent(1, 10), statusEvent(2, 10)],
      }).events,
    ).toHaveLength(2);
    expect(() =>
      normalizeAppendRemoteWorkerAssignmentEventsCommand({
        ...base,
        events: [statusEvent(1, 10), statusEvent(2, 2)],
      }),
    ).toThrow(/monotonic/u);
    expect(() =>
      normalizeAppendRemoteWorkerAssignmentEventsCommand({
        ...base,
        events: [statusEvent(1), statusEvent(3)],
      }),
    ).toThrow(/contiguous/u);
  });

  it("emits deterministic pause and disconnect replay cursors", () => {
    expect(buildRemoteWorkerAssignmentFlowControl(manifest(), 10, 12)).toEqual({
      action: "continue",
      acknowledgedThrough: 10,
      replayCursor: 10,
      resumeWhenPendingAtOrBelow: 2,
    });
    expect(buildRemoteWorkerAssignmentFlowControl(manifest(), 10, 13).action).toBe("pause");
    expect(buildRemoteWorkerAssignmentFlowControl(manifest(), 10, 15)).toMatchObject({
      action: "disconnect_with_replay_cursor",
      replayCursor: 10,
    });
  });

  it("separates worker and gateway recovery settlement evidence", () => {
    const common = {
      registryWorkspaceId: "registry-a",
      assignmentId: "assignment-a",
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 2,
      outcome: "cancelled" as const,
      finalEventSequence: 0,
      finalEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
      idempotencyKey: "settle-a",
    };
    expect(
      normalizeSettleRemoteWorkerAssignmentCommand({
        ...common,
        origin: "gateway_recovery",
        gatewayActorId: "gateway-a",
        recoveryEvidenceSha256: D("cancel-control"),
      }),
    ).not.toHaveProperty("leaseTokenSha256");
    expect(() =>
      normalizeSettleRemoteWorkerAssignmentCommand({
        ...common,
        origin: "gateway_recovery",
        gatewayActorId: "gateway-a",
        recoveryEvidenceSha256: D("cancel-control"),
        leaseTokenSha256: D("lease"),
      } as never),
    ).toThrow(/origin evidence/u);
    expect(() =>
      normalizeSettleRemoteWorkerAssignmentCommand({
        ...common,
        outcome: "completed",
        origin: "worker",
        leaseTokenSha256: D("lease"),
        resultSha256: D("result"),
      } as never),
    ).toThrow(/result and output/u);
  });

  it("requires explicit canonical materialization owners and never accepts a caller receipt", () => {
    const common = {
      registryWorkspaceId: "registry-a",
      assignmentId: "assignment-a",
      sourceGeneration: 1,
      sourceSha256: D("source"),
      targetId: "target-a",
      targetSha256: D("target"),
      gatewayActorId: "gateway-a",
      idempotencyKey: "materialize-a",
    } as const;
    expect(
      normalizeRecordRemoteWorkerAssignmentMaterializationCommand({
        ...common,
        sourceKind: "event",
        sourceSequence: 1,
        targetKind: "chat_transcript",
        targetOwnerSessionId: "session-a",
        targetOwnerTurnId: "turn-a",
      }),
    ).toMatchObject({ sourceKind: "event", targetKind: "chat_transcript" });
    expect(
      normalizeRecordRemoteWorkerAssignmentMaterializationCommand({
        ...common,
        sourceKind: "settlement",
        targetKind: "durable_run_result",
        targetOwnerDurableRunId: "run-a",
      }),
    ).toMatchObject({ sourceKind: "settlement", targetKind: "durable_run_result" });
    expect(() =>
      normalizeRecordRemoteWorkerAssignmentMaterializationCommand({
        ...common,
        sourceKind: "event",
        sourceSequence: 1,
        targetKind: "durable_run_result",
        targetOwnerSessionId: "session-a",
        targetOwnerTurnId: "turn-a",
      } as never),
    ).toThrow(/incompatible/u);
    expect(() =>
      normalizeRecordRemoteWorkerAssignmentMaterializationCommand({
        ...common,
        sourceKind: "settlement",
        targetKind: "durable_run_result",
        targetOwnerDurableRunId: "run-a",
        receiptSha256: D("caller-receipt"),
      } as never),
    ).toThrow(/unknown fields/u);
  });

  it("binds recovery replay to the full old-generation fence and new lease token hash", () => {
    const command: RecoverRemoteWorkerAssignmentCommand = {
      registryWorkspaceId: "registry-a",
      assignmentId: "assignment-a",
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 2,
      workerId: "worker-b",
      workerGeneration: 3,
      nodeId: "node-b",
      nodeAdmissionGeneration: 4,
      dispatchOwnerId: "gateway-a",
      durableRunAttempt: 1,
      leaseTokenSha256: D("new-lease"),
      reasonCode: "lease.expired",
      reasonSha256: D("reason"),
      actorId: "gateway-a",
      idempotencyKey: "recover-a",
    };
    const material = remoteWorkerAssignmentRecoveryReplayMaterial(command, 2, authority());
    expect(material).toMatchObject({
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 2,
      assignmentGeneration: 2,
      leaseTokenSha256: D("new-lease"),
      reasonSha256: D("reason"),
    });
  });

  it("makes every lease record prove its exact parent authority snapshot", () => {
    const parentDispatchAuthority = authority();
    const record = {
      registryWorkspaceId: "registry-a",
      assignmentId: "assignment-a",
      assignmentGeneration: 1,
      leaseRevision: 1,
      workerSentThrough: 0,
      serverAcknowledgedThrough: 0,
      parentDispatchAuthority,
      parentDispatchAuthoritySha256: remoteWorkerAssignmentCanonicalSha256(parentDispatchAuthority),
      heartbeatAt: "2029-01-01T00:00:00.000Z",
      expiresAt: "2029-01-01T00:01:00.000Z",
      idempotencyKey: "lease-a",
      requestSha256: D("request"),
    };
    expect(() => assertRemoteWorkerAssignmentLeaseRecord(record)).not.toThrow();
    expect(() =>
      assertRemoteWorkerAssignmentLeaseRecord({ ...record, parentDispatchAuthoritySha256: D("changed") }),
    ).toThrow(/digest does not match/u);
  });
});
