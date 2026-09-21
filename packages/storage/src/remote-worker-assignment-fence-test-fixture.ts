import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerAssignmentManifest,
} from "@goatcitadel/contracts";
import type { seedProtectedFenceHarness } from "./remote-worker-protected-fence-fixture.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";

export function seedFencedAssignment(
  h: ReturnType<typeof seedProtectedFenceHarness>,
  suffix: string,
  label: string,
  nodeAdmissionGeneration: number,
  leaseTokenSha256: string,
  leaseTtlSeconds = 60,
  nativeArtifacts = false,
): { assignmentId: string; taskId: string; durableRunId: string } {
  const now = h.durableRuns.readDatabaseNow();
  const taskId = `task-${suffix}-${label}`;
  const durableRunId = `run-${suffix}-${label}`;
  h.tasks.create({ title: `PG fence contention ${label}`, workspaceId: "default" }, now, { taskId });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  h.durableRuns.createRun({
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
  const manifest: RemoteWorkerAssignmentManifest = {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    registryWorkspaceId: "default",
    ...parentInput,
    capabilityProfileSha256: D(`${suffix}:${label}:capability-profile`),
    contextSnapshotSha256: D(`${suffix}:${label}:context`),
    toolEffectPostureSha256: D(`${suffix}:${label}:posture`),
    pathJailSha256: D(`${suffix}:${label}:jail`),
    parentContextSha256,
    requiredCapabilityClasses: nativeArtifacts
      ? ["artifact_stage", "durable_compute", "gateway_inference"]
      : ["durable_compute", "gateway_inference"],
    deadlineAt: FUTURE,
    leaseTtlSeconds,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes: 131_072,
    maxArtifactBytes: 1_048_576,
  };
  const assignment = h.assignments.createAssignment({
    manifest,
    createdByActorId: "gateway-a",
    idempotencyKey: `${suffix}:${label}:assignment`,
  }).assignment;
  const started = h.assignments.startGeneration({
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: h.finalized.generation.workerId,
    workerGeneration: h.finalized.generation.workerGeneration,
    nodeId: h.finalized.generation.nodeId,
    nodeAdmissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256,
    idempotencyKey: `${suffix}:${label}:generation:1`,
  });
  assert.equal(started.disposition, "started");
  return { assignmentId: assignment.assignmentId, taskId, durableRunId };
}
