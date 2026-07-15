/* eslint-disable max-lines -- Assignment, lease, replay, and event-chain invariants intentionally share one audited contract boundary. */
import { canonicalJsonString } from "./canonical-json.js";
import {
  REMOTE_WORKER_CAPABILITY_CLASSES,
  REMOTE_WORKER_PROTOCOL_VERSION,
  type RemoteWorkerCapabilityClass,
} from "./remote-worker-admission.js";

export const REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-manifest.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION = "goatcitadel.remote-worker-assignment-event.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-dispatch-authority.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_PARENT_CONTEXT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-parent-context.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-settlement.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_MATERIALIZATION_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-materialization.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256 = "0".repeat(64);
export const REMOTE_WORKER_ASSIGNMENT_MAX_LEASE_TTL_SECONDS = 900;
export const REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT = 10_000;
export const REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_BYTES = 65_536;
export const REMOTE_WORKER_ASSIGNMENT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const REMOTE_WORKER_ASSIGNMENT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_BATCH = 64;

export const REMOTE_WORKER_ASSIGNMENT_EVENT_TYPES = [
  "status",
  "tool_progress",
  "model_progress",
  "approval_wait",
  "diagnostic",
  "transcript_delta",
  "terminal_output",
] as const;

export type RemoteWorkerAssignmentEventType = (typeof REMOTE_WORKER_ASSIGNMENT_EVENT_TYPES)[number];
export type RemoteWorkerAssignmentControlAction = "cancel_requested" | "generation_abandoned" | "recovery_exhausted";
export type RemoteWorkerAssignmentSettlementOutcome = "completed" | "failed" | "cancelled";
export type RemoteWorkerAssignmentSettlementOrigin = "worker" | "gateway_recovery";
export type RemoteWorkerAssignmentMaterializationSource = "event" | "settlement";
export type RemoteWorkerAssignmentMaterializationTarget = "chat_transcript" | "durable_run_result";

export interface RemoteWorkerAssignmentParentContext {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_PARENT_CONTEXT_SCHEMA_VERSION;
  readonly executionWorkspaceId: string;
  readonly durableRunId: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface RemoteWorkerAssignmentManifest {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION;
  readonly protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  readonly registryWorkspaceId: string;
  readonly executionWorkspaceId: string;
  readonly durableRunId: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly capabilityProfileSha256: string;
  readonly contextSnapshotSha256: string;
  readonly toolEffectPostureSha256: string;
  readonly pathJailSha256: string;
  readonly parentContextSha256: string;
  readonly requiredCapabilityClasses: readonly RemoteWorkerCapabilityClass[];
  readonly deadlineAt: string;
  readonly leaseTtlSeconds: number;
  readonly maxEventCount: number;
  readonly maxEventBytes: number;
  readonly eventLowWatermark: number;
  readonly eventHighWatermark: number;
  readonly maxOutputBytes: number;
  readonly maxArtifactBytes: number;
}

export interface CreateRemoteWorkerAssignmentCommand {
  readonly manifest: RemoteWorkerAssignmentManifest;
  readonly createdByActorId: string;
  readonly idempotencyKey: string;
}

export interface RemoteWorkerAssignmentRecord {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly manifest: RemoteWorkerAssignmentManifest;
  readonly manifestSha256: string;
  readonly createdByActorId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly createdAt: string;
}

export interface RemoteWorkerAssignmentDispatchAuthority {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION;
  readonly durableRunId: string;
  readonly durableRunAttempt: number;
  readonly dispatchOwnerId: string;
  readonly durableRunVersion: number;
  readonly durableRunLeaseExpiresAt: string;
}

export interface StartRemoteWorkerAssignmentGenerationCommand {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly nodeId: string;
  readonly nodeAdmissionGeneration: number;
  readonly dispatchOwnerId: string;
  readonly durableRunAttempt: number;
  readonly leaseTokenSha256: string;
  readonly idempotencyKey: string;
}

export interface RecoverRemoteWorkerAssignmentCommand extends StartRemoteWorkerAssignmentGenerationCommand {
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly reasonCode: string;
  readonly reasonSha256: string;
  readonly actorId: string;
}

export interface RemoteWorkerAssignmentGenerationRecord {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly executionWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly nodeId: string;
  readonly nodeAdmissionGeneration: number;
  readonly runtimeManifestSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly dispatchAuthority: RemoteWorkerAssignmentDispatchAuthority;
  readonly dispatchAuthoritySha256: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly startedAt: string;
}

export interface RenewRemoteWorkerAssignmentLeaseCommand {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly expectedLeaseTokenSha256: string;
  readonly leaseTokenSha256: string;
  readonly workerSentThrough: number;
  readonly idempotencyKey: string;
}

export interface RemoteWorkerAssignmentLeaseRecord {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly workerSentThrough: number;
  readonly serverAcknowledgedThrough: number;
  readonly parentDispatchAuthority: RemoteWorkerAssignmentDispatchAuthority;
  readonly parentDispatchAuthoritySha256: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
}

export interface ResolvedRemoteWorkerAssignmentAuthority {
  readonly assignment: RemoteWorkerAssignmentRecord;
  readonly generation: RemoteWorkerAssignmentGenerationRecord;
  readonly lease: RemoteWorkerAssignmentLeaseRecord;
}

export interface ControlRemoteWorkerAssignmentCommand {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly reasonCode: string;
  readonly reasonSha256: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface RemoteWorkerAssignmentControlRecord extends ControlRemoteWorkerAssignmentCommand {
  readonly controlRevision: number;
  readonly action: RemoteWorkerAssignmentControlAction;
  readonly requestSha256: string;
  readonly createdAt: string;
}

interface RemoteWorkerAssignmentEventPayloadBase {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION;
}

export interface RemoteWorkerAssignmentStatusPayload extends RemoteWorkerAssignmentEventPayloadBase {
  readonly phase: "accepted" | "running" | "waiting" | "finishing";
  readonly statusSha256: string;
}

export interface RemoteWorkerAssignmentToolProgressPayload extends RemoteWorkerAssignmentEventPayloadBase {
  readonly toolRunId: string;
  readonly phase: "requested" | "running" | "waiting_approval" | "completed" | "failed";
  readonly toolNameSha256: string;
  readonly argsSha256?: string;
  readonly resultSha256?: string;
}

export interface RemoteWorkerAssignmentModelProgressPayload extends RemoteWorkerAssignmentEventPayloadBase {
  readonly inferenceRequestId: string;
  readonly inferenceAttempt: number;
  readonly phase: "requested" | "streaming" | "completed" | "failed";
  readonly modelIntentSha256: string;
}

export interface RemoteWorkerAssignmentApprovalWaitPayload extends RemoteWorkerAssignmentEventPayloadBase {
  readonly approvalId: string;
  readonly approvalKind: string;
  readonly riskLevelSha256: string;
}

export interface RemoteWorkerAssignmentDiagnosticPayload extends RemoteWorkerAssignmentEventPayloadBase {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly detailSha256: string;
}

export interface RemoteWorkerAssignmentTranscriptDeltaPayload extends RemoteWorkerAssignmentEventPayloadBase {
  readonly role: "assistant";
  readonly text: string;
}

export interface RemoteWorkerAssignmentTerminalOutputPayload extends RemoteWorkerAssignmentEventPayloadBase {
  readonly stream: "stdout" | "stderr";
  readonly chunkSha256: string;
  readonly byteLength: number;
}

export type RemoteWorkerAssignmentEventPayload =
  | RemoteWorkerAssignmentStatusPayload
  | RemoteWorkerAssignmentToolProgressPayload
  | RemoteWorkerAssignmentModelProgressPayload
  | RemoteWorkerAssignmentApprovalWaitPayload
  | RemoteWorkerAssignmentDiagnosticPayload
  | RemoteWorkerAssignmentTranscriptDeltaPayload
  | RemoteWorkerAssignmentTerminalOutputPayload;

export interface RemoteWorkerAssignmentEventInput {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: RemoteWorkerAssignmentEventType;
  readonly payload: RemoteWorkerAssignmentEventPayload;
  readonly previousEventSha256: string;
  readonly workerSentThrough: number;
}

export interface AppendRemoteWorkerAssignmentEventsCommand {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly leaseTokenSha256: string;
  readonly events: readonly RemoteWorkerAssignmentEventInput[];
}

export interface RemoteWorkerAssignmentEventRecord extends RemoteWorkerAssignmentEventInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly payloadSha256: string;
  readonly eventSha256: string;
  readonly receivedAt: string;
}

export interface RemoteWorkerAssignmentAppendOutcome {
  readonly disposition: "appended" | "replayed" | "partially_replayed";
  readonly acknowledgedThrough: number;
  readonly workerSentThrough: number;
  readonly pendingCount: number;
  readonly flowControl: RemoteWorkerAssignmentFlowControl;
  readonly events: readonly RemoteWorkerAssignmentEventRecord[];
}

export interface RemoteWorkerAssignmentFlowControl {
  readonly action: "continue" | "pause" | "disconnect_with_replay_cursor";
  readonly acknowledgedThrough: number;
  readonly replayCursor: number;
  readonly resumeWhenPendingAtOrBelow: number;
}

interface SettleRemoteWorkerAssignmentCommandBase {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly outcome: RemoteWorkerAssignmentSettlementOutcome;
  readonly finalEventSequence: number;
  readonly finalEventSha256: string;
  readonly resultSha256?: string;
  readonly outputManifestSha256?: string;
  readonly failureSha256?: string;
  readonly idempotencyKey: string;
}

export interface SettleRemoteWorkerAssignmentWorkerCommand extends SettleRemoteWorkerAssignmentCommandBase {
  readonly origin: "worker";
  readonly leaseTokenSha256: string;
}

export interface SettleRemoteWorkerAssignmentRecoveryCommand extends SettleRemoteWorkerAssignmentCommandBase {
  readonly origin: "gateway_recovery";
  readonly gatewayActorId: string;
  readonly recoveryEvidenceSha256: string;
}

export type SettleRemoteWorkerAssignmentCommand =
  | SettleRemoteWorkerAssignmentWorkerCommand
  | SettleRemoteWorkerAssignmentRecoveryCommand;

export interface RemoteWorkerAssignmentSettlementRecord {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly outcome: RemoteWorkerAssignmentSettlementOutcome;
  readonly origin: RemoteWorkerAssignmentSettlementOrigin;
  readonly gatewayActorId?: string;
  readonly recoveryEvidenceSha256?: string;
  readonly finalEventSequence: number;
  readonly finalEventSha256: string;
  readonly resultSha256?: string;
  readonly outputManifestSha256?: string;
  readonly failureSha256?: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly settledAt: string;
}

interface RecordRemoteWorkerAssignmentMaterializationCommandBase {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly sourceGeneration: number;
  readonly sourceSha256: string;
  readonly targetId: string;
  readonly targetSha256: string;
  readonly gatewayActorId: string;
  readonly idempotencyKey: string;
}

export interface RecordRemoteWorkerAssignmentEventMaterializationCommand extends RecordRemoteWorkerAssignmentMaterializationCommandBase {
  readonly sourceKind: "event";
  readonly sourceSequence: number;
  readonly targetKind: "chat_transcript";
  readonly targetOwnerSessionId: string;
  readonly targetOwnerTurnId: string;
}

export interface RecordRemoteWorkerAssignmentSettlementMaterializationCommand extends RecordRemoteWorkerAssignmentMaterializationCommandBase {
  readonly sourceKind: "settlement";
  readonly targetKind: "durable_run_result";
  readonly targetOwnerDurableRunId: string;
}

export type RecordRemoteWorkerAssignmentMaterializationCommand =
  | RecordRemoteWorkerAssignmentEventMaterializationCommand
  | RecordRemoteWorkerAssignmentSettlementMaterializationCommand;

export type RemoteWorkerAssignmentMaterializationRecord = RecordRemoteWorkerAssignmentMaterializationCommand & {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_MATERIALIZATION_SCHEMA_VERSION;
  readonly materializationId: string;
  readonly receiptSha256: string;
  readonly requestSha256: string;
  readonly materializedAt: string;
};

export function normalizeRemoteWorkerAssignmentManifest(
  input: RemoteWorkerAssignmentManifest,
): RemoteWorkerAssignmentManifest {
  assertRecord(input, "assignment manifest");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "protocolVersion",
      "registryWorkspaceId",
      "executionWorkspaceId",
      "durableRunId",
      "taskId",
      "sessionId",
      "turnId",
      "capabilityProfileSha256",
      "contextSnapshotSha256",
      "toolEffectPostureSha256",
      "pathJailSha256",
      "parentContextSha256",
      "requiredCapabilityClasses",
      "deadlineAt",
      "leaseTtlSeconds",
      "maxEventCount",
      "maxEventBytes",
      "eventLowWatermark",
      "eventHighWatermark",
      "maxOutputBytes",
      "maxArtifactBytes",
    ],
    "assignment manifest",
    ["sessionId", "turnId"],
  );
  if (input.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError("Remote worker assignment manifest schema version is unsupported.");
  }
  if (input.protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
    throw new TypeError("Remote worker assignment protocol version is unsupported.");
  }
  if ((input.sessionId === undefined) !== (input.turnId === undefined)) {
    throw new TypeError("Remote worker assignment sessionId and turnId must be present together.");
  }
  const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
  const executionWorkspaceId = identifier(input.executionWorkspaceId, "executionWorkspaceId");
  const requiredCapabilityClasses = normalizeCapabilities(input.requiredCapabilityClasses);
  if (!requiredCapabilityClasses.includes("durable_compute")) {
    throw new TypeError("Remote worker assignment requiredCapabilityClasses must include durable_compute.");
  }
  const maxEventCount = positiveInteger(input.maxEventCount, "maxEventCount", REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT);
  const eventLowWatermark = nonNegativeInteger(input.eventLowWatermark, "eventLowWatermark", maxEventCount - 1);
  const eventHighWatermark = positiveInteger(input.eventHighWatermark, "eventHighWatermark", maxEventCount);
  if (eventLowWatermark >= eventHighWatermark) {
    throw new TypeError("Remote worker assignment low watermark must be below its high watermark.");
  }
  const parentContext = buildRemoteWorkerAssignmentParentContext({
    executionWorkspaceId,
    durableRunId: input.durableRunId,
    taskId: input.taskId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId, turnId: input.turnId }),
  });
  if (
    digest(input.parentContextSha256, "parentContextSha256") !== remoteWorkerAssignmentCanonicalSha256(parentContext)
  ) {
    throw new TypeError("Remote worker assignment parent context digest does not match canonical identifiers.");
  }
  const manifest: RemoteWorkerAssignmentManifest = {
    schemaVersion: input.schemaVersion,
    protocolVersion: input.protocolVersion,
    registryWorkspaceId,
    executionWorkspaceId,
    durableRunId: identifier(input.durableRunId, "durableRunId"),
    taskId: identifier(input.taskId, "taskId"),
    ...(input.sessionId === undefined
      ? {}
      : {
          sessionId: identifier(input.sessionId, "sessionId"),
          turnId: identifier(input.turnId!, "turnId"),
        }),
    capabilityProfileSha256: digest(input.capabilityProfileSha256, "capabilityProfileSha256"),
    contextSnapshotSha256: digest(input.contextSnapshotSha256, "contextSnapshotSha256"),
    toolEffectPostureSha256: digest(input.toolEffectPostureSha256, "toolEffectPostureSha256"),
    pathJailSha256: digest(input.pathJailSha256, "pathJailSha256"),
    parentContextSha256: input.parentContextSha256,
    requiredCapabilityClasses: Object.freeze(requiredCapabilityClasses),
    deadlineAt: isoTimestamp(input.deadlineAt, "deadlineAt"),
    leaseTtlSeconds: positiveInteger(
      input.leaseTtlSeconds,
      "leaseTtlSeconds",
      REMOTE_WORKER_ASSIGNMENT_MAX_LEASE_TTL_SECONDS,
    ),
    maxEventCount,
    maxEventBytes: positiveInteger(input.maxEventBytes, "maxEventBytes", REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_BYTES),
    eventLowWatermark,
    eventHighWatermark,
    maxOutputBytes: positiveInteger(input.maxOutputBytes, "maxOutputBytes", REMOTE_WORKER_ASSIGNMENT_MAX_OUTPUT_BYTES),
    maxArtifactBytes: positiveInteger(
      input.maxArtifactBytes,
      "maxArtifactBytes",
      REMOTE_WORKER_ASSIGNMENT_MAX_ARTIFACT_BYTES,
    ),
  };
  return Object.freeze(manifest);
}

export function normalizeCreateRemoteWorkerAssignmentCommand(
  input: CreateRemoteWorkerAssignmentCommand,
): CreateRemoteWorkerAssignmentCommand {
  assertRecord(input, "assignment create command");
  assertExactKeys(input, ["manifest", "createdByActorId", "idempotencyKey"], "assignment create command");
  return Object.freeze({
    manifest: normalizeRemoteWorkerAssignmentManifest(input.manifest),
    createdByActorId: identifier(input.createdByActorId, "createdByActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  });
}

export function normalizeStartRemoteWorkerAssignmentGenerationCommand(
  input: StartRemoteWorkerAssignmentGenerationCommand,
): StartRemoteWorkerAssignmentGenerationCommand {
  assertRecord(input, "assignment generation command");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "assignmentId",
      "workerId",
      "workerGeneration",
      "nodeId",
      "nodeAdmissionGeneration",
      "dispatchOwnerId",
      "durableRunAttempt",
      "leaseTokenSha256",
      "idempotencyKey",
    ],
    "assignment generation command",
  );
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    workerId: identifier(input.workerId, "workerId"),
    workerGeneration: positiveInteger(input.workerGeneration, "workerGeneration"),
    nodeId: identifier(input.nodeId, "nodeId"),
    nodeAdmissionGeneration: positiveInteger(input.nodeAdmissionGeneration, "nodeAdmissionGeneration"),
    dispatchOwnerId: identifier(input.dispatchOwnerId, "dispatchOwnerId"),
    durableRunAttempt: positiveInteger(input.durableRunAttempt, "durableRunAttempt"),
    leaseTokenSha256: digest(input.leaseTokenSha256, "leaseTokenSha256"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  });
}

export function normalizeRecoverRemoteWorkerAssignmentCommand(
  input: RecoverRemoteWorkerAssignmentCommand,
): RecoverRemoteWorkerAssignmentCommand {
  assertRecord(input, "assignment recovery command");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "assignmentId",
      "workerId",
      "workerGeneration",
      "nodeId",
      "nodeAdmissionGeneration",
      "dispatchOwnerId",
      "durableRunAttempt",
      "leaseTokenSha256",
      "idempotencyKey",
      "expectedAssignmentGeneration",
      "expectedLeaseRevision",
      "reasonCode",
      "reasonSha256",
      "actorId",
    ],
    "assignment recovery command",
  );
  const start = normalizeStartRemoteWorkerAssignmentGenerationCommand({
    registryWorkspaceId: input.registryWorkspaceId,
    assignmentId: input.assignmentId,
    workerId: input.workerId,
    workerGeneration: input.workerGeneration,
    nodeId: input.nodeId,
    nodeAdmissionGeneration: input.nodeAdmissionGeneration,
    dispatchOwnerId: input.dispatchOwnerId,
    durableRunAttempt: input.durableRunAttempt,
    leaseTokenSha256: input.leaseTokenSha256,
    idempotencyKey: input.idempotencyKey,
  });
  return Object.freeze({
    ...start,
    expectedAssignmentGeneration: positiveInteger(input.expectedAssignmentGeneration, "expectedAssignmentGeneration"),
    expectedLeaseRevision: positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision"),
    reasonCode: reasonCode(input.reasonCode),
    reasonSha256: digest(input.reasonSha256, "reasonSha256"),
    actorId: identifier(input.actorId, "actorId"),
  });
}

export function normalizeRenewRemoteWorkerAssignmentLeaseCommand(
  input: RenewRemoteWorkerAssignmentLeaseCommand,
): RenewRemoteWorkerAssignmentLeaseCommand {
  assertRecord(input, "assignment lease renewal command");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "assignmentId",
      "expectedAssignmentGeneration",
      "expectedLeaseRevision",
      "expectedLeaseTokenSha256",
      "leaseTokenSha256",
      "workerSentThrough",
      "idempotencyKey",
    ],
    "assignment lease renewal command",
  );
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(input.expectedAssignmentGeneration, "expectedAssignmentGeneration"),
    expectedLeaseRevision: positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision"),
    expectedLeaseTokenSha256: digest(input.expectedLeaseTokenSha256, "expectedLeaseTokenSha256"),
    leaseTokenSha256: digest(input.leaseTokenSha256, "leaseTokenSha256"),
    workerSentThrough: nonNegativeInteger(
      input.workerSentThrough,
      "workerSentThrough",
      REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT,
    ),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  });
}

export function normalizeControlRemoteWorkerAssignmentCommand(
  input: ControlRemoteWorkerAssignmentCommand,
): ControlRemoteWorkerAssignmentCommand {
  assertRecord(input, "assignment control command");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "assignmentId",
      "expectedAssignmentGeneration",
      "expectedLeaseRevision",
      "reasonCode",
      "reasonSha256",
      "actorId",
      "idempotencyKey",
    ],
    "assignment control command",
  );
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(input.expectedAssignmentGeneration, "expectedAssignmentGeneration"),
    expectedLeaseRevision: positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision"),
    reasonCode: reasonCode(input.reasonCode),
    reasonSha256: digest(input.reasonSha256, "reasonSha256"),
    actorId: identifier(input.actorId, "actorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  });
}

export function normalizeAppendRemoteWorkerAssignmentEventsCommand(
  input: AppendRemoteWorkerAssignmentEventsCommand,
): AppendRemoteWorkerAssignmentEventsCommand {
  assertRecord(input, "assignment event append command");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "assignmentId",
      "expectedAssignmentGeneration",
      "expectedLeaseRevision",
      "leaseTokenSha256",
      "events",
    ],
    "assignment event append command",
  );
  if (
    !Array.isArray(input.events) ||
    input.events.length < 1 ||
    input.events.length > REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_BATCH
  ) {
    throw new TypeError(
      `Remote worker assignment event batch must contain 1-${REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_BATCH} events.`,
    );
  }
  const events = input.events.map((event) => normalizeRemoteWorkerAssignmentEventInput(event));
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence !== events[index - 1]!.sequence + 1) {
      throw new TypeError("Remote worker assignment event batch sequences must be contiguous.");
    }
    if (events[index]!.workerSentThrough < events[index - 1]!.workerSentThrough) {
      throw new TypeError("Remote worker assignment event batch sent-through watermarks must be monotonic.");
    }
  }
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(input.expectedAssignmentGeneration, "expectedAssignmentGeneration"),
    expectedLeaseRevision: positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision"),
    leaseTokenSha256: digest(input.leaseTokenSha256, "leaseTokenSha256"),
    events: Object.freeze(events),
  });
}

export function normalizeRemoteWorkerAssignmentEventInput(
  input: RemoteWorkerAssignmentEventInput,
): RemoteWorkerAssignmentEventInput {
  assertRecord(input, "assignment event");
  assertExactKeys(
    input,
    ["sequence", "eventId", "eventType", "payload", "previousEventSha256", "workerSentThrough"],
    "assignment event",
  );
  if (!REMOTE_WORKER_ASSIGNMENT_EVENT_TYPES.includes(input.eventType)) {
    throw new TypeError("Remote worker assignment event type is unsupported.");
  }
  const sequence = positiveInteger(input.sequence, "sequence", REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT);
  const workerSentThrough = positiveInteger(
    input.workerSentThrough,
    "workerSentThrough",
    REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT,
  );
  if (workerSentThrough < sequence) {
    throw new TypeError("Remote worker assignment workerSentThrough cannot trail its event sequence.");
  }
  const payload = normalizeEventPayload(input.eventType, input.payload);
  return Object.freeze({
    sequence,
    eventId: identifier(input.eventId, "eventId"),
    eventType: input.eventType,
    payload,
    previousEventSha256: digest(input.previousEventSha256, "previousEventSha256"),
    workerSentThrough,
  });
}

export function normalizeSettleRemoteWorkerAssignmentCommand(
  input: SettleRemoteWorkerAssignmentCommand,
): SettleRemoteWorkerAssignmentCommand {
  assertRecord(input, "assignment settlement command");
  enumValue(input.origin, ["worker", "gateway_recovery"], "origin");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "assignmentId",
      "expectedAssignmentGeneration",
      "expectedLeaseRevision",
      "leaseTokenSha256",
      "outcome",
      "origin",
      "finalEventSequence",
      "finalEventSha256",
      "resultSha256",
      "outputManifestSha256",
      "failureSha256",
      "gatewayActorId",
      "recoveryEvidenceSha256",
      "idempotencyKey",
    ],
    "assignment settlement command",
    [
      "leaseTokenSha256",
      "resultSha256",
      "outputManifestSha256",
      "failureSha256",
      "gatewayActorId",
      "recoveryEvidenceSha256",
    ],
  );
  enumValue(input.outcome, ["completed", "failed", "cancelled"], "outcome");
  if (
    (input.origin === "worker" &&
      (!("leaseTokenSha256" in input) || "gatewayActorId" in input || "recoveryEvidenceSha256" in input)) ||
    (input.origin === "gateway_recovery" &&
      ("leaseTokenSha256" in input || !("gatewayActorId" in input) || !("recoveryEvidenceSha256" in input)))
  ) {
    throw new TypeError("Remote worker assignment settlement origin evidence is invalid.");
  }
  if (input.outcome === "completed" && (!input.resultSha256 || !input.outputManifestSha256 || input.failureSha256)) {
    throw new TypeError("Completed remote worker assignment settlement requires only result and output digests.");
  }
  if (input.outcome === "failed" && (!input.failureSha256 || input.resultSha256 || input.outputManifestSha256)) {
    throw new TypeError("Failed remote worker assignment settlement requires only a failure digest.");
  }
  if (input.outcome === "cancelled" && (input.resultSha256 || input.outputManifestSha256 || input.failureSha256)) {
    throw new TypeError(
      "Cancelled remote worker assignment settlement cannot carry result, output, or failure digests.",
    );
  }
  const common = {
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    expectedAssignmentGeneration: positiveInteger(input.expectedAssignmentGeneration, "expectedAssignmentGeneration"),
    expectedLeaseRevision: positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision"),
    outcome: input.outcome,
    finalEventSequence: nonNegativeInteger(
      input.finalEventSequence,
      "finalEventSequence",
      REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT,
    ),
    finalEventSha256: digest(input.finalEventSha256, "finalEventSha256"),
    ...(input.resultSha256 ? { resultSha256: digest(input.resultSha256, "resultSha256") } : {}),
    ...(input.outputManifestSha256
      ? { outputManifestSha256: digest(input.outputManifestSha256, "outputManifestSha256") }
      : {}),
    ...(input.failureSha256 ? { failureSha256: digest(input.failureSha256, "failureSha256") } : {}),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
  return input.origin === "worker"
    ? Object.freeze({
        ...common,
        origin: "worker" as const,
        leaseTokenSha256: digest(input.leaseTokenSha256, "leaseTokenSha256"),
      })
    : Object.freeze({
        ...common,
        origin: "gateway_recovery" as const,
        gatewayActorId: identifier(input.gatewayActorId, "gatewayActorId"),
        recoveryEvidenceSha256: digest(input.recoveryEvidenceSha256, "recoveryEvidenceSha256"),
      });
}

export function normalizeRecordRemoteWorkerAssignmentMaterializationCommand(
  input: RecordRemoteWorkerAssignmentMaterializationCommand,
): RecordRemoteWorkerAssignmentMaterializationCommand {
  assertRecord(input, "assignment materialization command");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "assignmentId",
      "sourceKind",
      "sourceGeneration",
      "sourceSequence",
      "sourceSha256",
      "targetKind",
      "targetId",
      "targetSha256",
      "targetOwnerSessionId",
      "targetOwnerTurnId",
      "targetOwnerDurableRunId",
      "gatewayActorId",
      "idempotencyKey",
    ],
    "assignment materialization command",
    ["sourceSequence", "targetOwnerSessionId", "targetOwnerTurnId", "targetOwnerDurableRunId"],
  );
  enumValue(input.sourceKind, ["event", "settlement"], "sourceKind");
  enumValue(input.targetKind, ["chat_transcript", "durable_run_result"], "targetKind");
  if ((input.sourceKind === "event") !== (input.sourceSequence !== undefined)) {
    throw new TypeError(
      "Remote worker assignment event materialization requires sourceSequence and settlement omits it.",
    );
  }
  if (
    (input.sourceKind === "event" && input.targetKind !== "chat_transcript") ||
    (input.sourceKind === "settlement" && input.targetKind !== "durable_run_result")
  ) {
    throw new TypeError("Remote worker assignment materialization source and target kinds are incompatible.");
  }
  const common = {
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    sourceGeneration: positiveInteger(input.sourceGeneration, "sourceGeneration"),
    sourceSha256: digest(input.sourceSha256, "sourceSha256"),
    targetId: identifier(input.targetId, "targetId"),
    targetSha256: digest(input.targetSha256, "targetSha256"),
    gatewayActorId: identifier(input.gatewayActorId, "gatewayActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
  return input.sourceKind === "event"
    ? Object.freeze({
        ...common,
        sourceKind: "event" as const,
        sourceSequence: positiveInteger(
          input.sourceSequence,
          "sourceSequence",
          REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT,
        ),
        targetKind: "chat_transcript" as const,
        targetOwnerSessionId: identifier(input.targetOwnerSessionId, "targetOwnerSessionId"),
        targetOwnerTurnId: identifier(input.targetOwnerTurnId, "targetOwnerTurnId"),
      })
    : Object.freeze({
        ...common,
        sourceKind: "settlement" as const,
        targetKind: "durable_run_result" as const,
        targetOwnerDurableRunId: identifier(input.targetOwnerDurableRunId, "targetOwnerDurableRunId"),
      });
}

export function remoteWorkerAssignmentManifestSha256(manifest: RemoteWorkerAssignmentManifest): string {
  return remoteWorkerAssignmentCanonicalSha256(normalizeRemoteWorkerAssignmentManifest(manifest));
}

export function buildRemoteWorkerAssignmentParentContext(
  input: Omit<RemoteWorkerAssignmentParentContext, "schemaVersion">,
): RemoteWorkerAssignmentParentContext {
  assertRecord(input, "assignment parent context input");
  assertExactKeys(
    input,
    ["executionWorkspaceId", "durableRunId", "taskId", "sessionId", "turnId"],
    "assignment parent context input",
    ["sessionId", "turnId"],
  );
  if ((input.sessionId === undefined) !== (input.turnId === undefined)) {
    throw new TypeError("Remote worker assignment parent context sessionId and turnId must be present together.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_PARENT_CONTEXT_SCHEMA_VERSION,
    executionWorkspaceId: identifier(input.executionWorkspaceId, "executionWorkspaceId"),
    durableRunId: identifier(input.durableRunId, "durableRunId"),
    taskId: identifier(input.taskId, "taskId"),
    ...(input.sessionId === undefined
      ? {}
      : {
          sessionId: identifier(input.sessionId, "sessionId"),
          turnId: identifier(input.turnId!, "turnId"),
        }),
  });
}

export function remoteWorkerAssignmentParentContextSha256(
  input: Omit<RemoteWorkerAssignmentParentContext, "schemaVersion">,
): string {
  return remoteWorkerAssignmentCanonicalSha256(buildRemoteWorkerAssignmentParentContext(input));
}

export function buildRemoteWorkerAssignmentFlowControl(
  manifest: RemoteWorkerAssignmentManifest,
  acknowledgedThrough: number,
  workerSentThrough: number,
): RemoteWorkerAssignmentFlowControl {
  const normalized = normalizeRemoteWorkerAssignmentManifest(manifest);
  const acknowledged = nonNegativeInteger(acknowledgedThrough, "acknowledgedThrough", normalized.maxEventCount);
  const sent = nonNegativeInteger(workerSentThrough, "workerSentThrough", normalized.maxEventCount);
  if (acknowledged > sent) throw new TypeError("Remote worker assignment acknowledged-through exceeds sent-through.");
  const pending = sent - acknowledged;
  return Object.freeze({
    action:
      pending >= normalized.eventHighWatermark
        ? "disconnect_with_replay_cursor"
        : pending > normalized.eventLowWatermark
          ? "pause"
          : "continue",
    acknowledgedThrough: acknowledged,
    replayCursor: acknowledged,
    resumeWhenPendingAtOrBelow: normalized.eventLowWatermark,
  });
}

export function remoteWorkerAssignmentCanonicalSha256(value: unknown): string {
  return sha256Utf8(canonicalJsonString(value));
}

export function remoteWorkerAssignmentEventHashMaterial(input: {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  event: RemoteWorkerAssignmentEventInput;
  payloadSha256: string;
}): object {
  const event = normalizeRemoteWorkerAssignmentEventInput(input.event);
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(input.assignmentGeneration, "assignmentGeneration"),
    sequence: event.sequence,
    eventId: event.eventId,
    eventType: event.eventType,
    payloadSha256: digest(input.payloadSha256, "payloadSha256"),
    previousEventSha256: event.previousEventSha256,
    workerSentThrough: event.workerSentThrough,
  });
}

export function remoteWorkerAssignmentCreateReplayMaterial(command: CreateRemoteWorkerAssignmentCommand): object {
  const normalized = normalizeCreateRemoteWorkerAssignmentCommand(command);
  return Object.freeze({ ...normalized });
}

export function remoteWorkerAssignmentGenerationReplayMaterial(
  command: StartRemoteWorkerAssignmentGenerationCommand,
  assignmentGeneration: number,
  dispatchAuthority: RemoteWorkerAssignmentDispatchAuthority,
): object {
  const normalized = normalizeStartRemoteWorkerAssignmentGenerationCommand(command);
  assertRemoteWorkerAssignmentDispatchAuthority(dispatchAuthority);
  return Object.freeze({
    ...normalized,
    assignmentGeneration: positiveInteger(assignmentGeneration, "assignmentGeneration"),
    dispatchAuthority,
  });
}

export function remoteWorkerAssignmentRecoveryReplayMaterial(
  command: RecoverRemoteWorkerAssignmentCommand,
  assignmentGeneration: number,
  dispatchAuthority: RemoteWorkerAssignmentDispatchAuthority,
): object {
  const normalized = normalizeRecoverRemoteWorkerAssignmentCommand(command);
  assertRemoteWorkerAssignmentDispatchAuthority(dispatchAuthority);
  return Object.freeze({
    ...normalized,
    assignmentGeneration: positiveInteger(assignmentGeneration, "assignmentGeneration"),
    dispatchAuthority,
  });
}

export function remoteWorkerAssignmentLeaseReplayMaterial(command: RenewRemoteWorkerAssignmentLeaseCommand): object {
  return Object.freeze({ ...normalizeRenewRemoteWorkerAssignmentLeaseCommand(command) });
}

export function remoteWorkerAssignmentControlReplayMaterial(
  action: RemoteWorkerAssignmentControlAction,
  command: ControlRemoteWorkerAssignmentCommand,
): object {
  enumValue(action, ["cancel_requested", "generation_abandoned", "recovery_exhausted"], "action");
  return Object.freeze({ action, ...normalizeControlRemoteWorkerAssignmentCommand(command) });
}

export function remoteWorkerAssignmentSettlementReplayMaterial(command: SettleRemoteWorkerAssignmentCommand): object {
  return Object.freeze({ ...normalizeSettleRemoteWorkerAssignmentCommand(command) });
}

export function remoteWorkerAssignmentMaterializationReplayMaterial(
  command: RecordRemoteWorkerAssignmentMaterializationCommand,
): object {
  return Object.freeze({ ...normalizeRecordRemoteWorkerAssignmentMaterializationCommand(command) });
}

export function assertRemoteWorkerAssignmentDispatchAuthority(
  value: unknown,
): asserts value is RemoteWorkerAssignmentDispatchAuthority {
  assertRecord(value, "assignment dispatch authority");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "durableRunId",
      "durableRunAttempt",
      "dispatchOwnerId",
      "durableRunVersion",
      "durableRunLeaseExpiresAt",
    ],
    "assignment dispatch authority",
  );
  if (value.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION) {
    throw new TypeError("Remote worker assignment dispatch authority schema version is unsupported.");
  }
  identifier(value.durableRunId, "durableRunId");
  positiveInteger(value.durableRunAttempt, "durableRunAttempt");
  identifier(value.dispatchOwnerId, "dispatchOwnerId");
  positiveInteger(value.durableRunVersion, "durableRunVersion");
  isoTimestamp(value.durableRunLeaseExpiresAt, "durableRunLeaseExpiresAt");
}

export function assertRemoteWorkerAssignmentRecord(value: unknown): asserts value is RemoteWorkerAssignmentRecord {
  assertRecord(value, "assignment record");
  assertExactKeys(
    value,
    [
      "registryWorkspaceId",
      "assignmentId",
      "manifest",
      "manifestSha256",
      "createdByActorId",
      "idempotencyKey",
      "requestSha256",
      "createdAt",
    ],
    "assignment record",
  );
  const manifest = normalizeRemoteWorkerAssignmentManifest(value.manifest as RemoteWorkerAssignmentManifest);
  if (value.registryWorkspaceId !== manifest.registryWorkspaceId)
    throw new TypeError("Assignment workspace binding is invalid.");
  identifier(value.assignmentId, "assignmentId");
  if (digest(value.manifestSha256, "manifestSha256") !== remoteWorkerAssignmentManifestSha256(manifest)) {
    throw new TypeError("Assignment manifest digest does not match canonical bytes.");
  }
  identifier(value.createdByActorId, "createdByActorId");
  identifier(value.idempotencyKey, "idempotencyKey", 512);
  digest(value.requestSha256, "requestSha256");
  isoTimestamp(value.createdAt, "createdAt");
}

export function assertRemoteWorkerAssignmentGenerationRecord(
  value: unknown,
): asserts value is RemoteWorkerAssignmentGenerationRecord {
  assertRecord(value, "assignment generation record");
  assertExactKeys(
    value,
    [
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "executionWorkspaceId",
      "workerId",
      "workerGeneration",
      "nodeId",
      "nodeAdmissionGeneration",
      "runtimeManifestSha256",
      "workspaceCeilingSha256",
      "capabilityCeilingSha256",
      "dispatchAuthority",
      "dispatchAuthoritySha256",
      "idempotencyKey",
      "requestSha256",
      "startedAt",
    ],
    "assignment generation record",
  );
  for (const [field, max] of [
    ["registryWorkspaceId", 256],
    ["assignmentId", 256],
    ["executionWorkspaceId", 256],
    ["workerId", 256],
    ["nodeId", 256],
    ["idempotencyKey", 512],
  ] as const)
    identifier(value[field], field, max);
  for (const field of ["assignmentGeneration", "workerGeneration", "nodeAdmissionGeneration"] as const) {
    positiveInteger(value[field], field);
  }
  for (const field of [
    "runtimeManifestSha256",
    "workspaceCeilingSha256",
    "capabilityCeilingSha256",
    "dispatchAuthoritySha256",
    "requestSha256",
  ] as const)
    digest(value[field], field);
  assertRemoteWorkerAssignmentDispatchAuthority(value.dispatchAuthority);
  if (remoteWorkerAssignmentCanonicalSha256(value.dispatchAuthority) !== value.dispatchAuthoritySha256) {
    throw new TypeError("Assignment dispatch authority digest does not match canonical bytes.");
  }
  isoTimestamp(value.startedAt, "startedAt");
}

export function assertRemoteWorkerAssignmentLeaseRecord(
  value: unknown,
): asserts value is RemoteWorkerAssignmentLeaseRecord {
  assertRecord(value, "assignment lease record");
  assertExactKeys(
    value,
    [
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "leaseRevision",
      "workerSentThrough",
      "serverAcknowledgedThrough",
      "parentDispatchAuthority",
      "parentDispatchAuthoritySha256",
      "heartbeatAt",
      "expiresAt",
      "idempotencyKey",
      "requestSha256",
    ],
    "assignment lease record",
  );
  identifier(value.registryWorkspaceId, "registryWorkspaceId");
  identifier(value.assignmentId, "assignmentId");
  positiveInteger(value.assignmentGeneration, "assignmentGeneration");
  positiveInteger(value.leaseRevision, "leaseRevision");
  const workerSentThrough = nonNegativeInteger(
    value.workerSentThrough,
    "workerSentThrough",
    REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT,
  );
  const serverAcknowledgedThrough = nonNegativeInteger(
    value.serverAcknowledgedThrough,
    "serverAcknowledgedThrough",
    REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_COUNT,
  );
  if (serverAcknowledgedThrough > workerSentThrough) {
    throw new TypeError("Assignment acknowledgement cannot exceed worker sent-through watermark.");
  }
  assertRemoteWorkerAssignmentDispatchAuthority(value.parentDispatchAuthority);
  const parentDispatchAuthoritySha256 = digest(value.parentDispatchAuthoritySha256, "parentDispatchAuthoritySha256");
  if (remoteWorkerAssignmentCanonicalSha256(value.parentDispatchAuthority) !== parentDispatchAuthoritySha256) {
    throw new TypeError("Assignment lease parent dispatch authority digest does not match canonical bytes.");
  }
  isoTimestamp(value.heartbeatAt, "heartbeatAt");
  isoTimestamp(value.expiresAt, "expiresAt");
  identifier(value.idempotencyKey, "idempotencyKey", 512);
  digest(value.requestSha256, "requestSha256");
}

export function assertRemoteWorkerAssignmentControlRecord(
  value: unknown,
): asserts value is RemoteWorkerAssignmentControlRecord {
  assertRecord(value, "assignment control record");
  assertExactKeys(
    value,
    [
      "registryWorkspaceId",
      "assignmentId",
      "expectedAssignmentGeneration",
      "expectedLeaseRevision",
      "reasonCode",
      "reasonSha256",
      "actorId",
      "idempotencyKey",
      "controlRevision",
      "action",
      "requestSha256",
      "createdAt",
    ],
    "assignment control record",
  );
  normalizeControlRemoteWorkerAssignmentCommand({
    registryWorkspaceId: value.registryWorkspaceId as string,
    assignmentId: value.assignmentId as string,
    expectedAssignmentGeneration: value.expectedAssignmentGeneration as number,
    expectedLeaseRevision: value.expectedLeaseRevision as number,
    reasonCode: value.reasonCode as string,
    reasonSha256: value.reasonSha256 as string,
    actorId: value.actorId as string,
    idempotencyKey: value.idempotencyKey as string,
  });
  positiveInteger(value.controlRevision, "controlRevision");
  enumValue(value.action, ["cancel_requested", "generation_abandoned", "recovery_exhausted"], "action");
  digest(value.requestSha256, "requestSha256");
  isoTimestamp(value.createdAt, "createdAt");
}

export function assertRemoteWorkerAssignmentEventRecord(
  value: unknown,
): asserts value is RemoteWorkerAssignmentEventRecord {
  assertRecord(value, "assignment event record");
  assertExactKeys(
    value,
    [
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "sequence",
      "eventId",
      "eventType",
      "payload",
      "previousEventSha256",
      "workerSentThrough",
      "payloadSha256",
      "eventSha256",
      "receivedAt",
    ],
    "assignment event record",
  );
  const event = normalizeRemoteWorkerAssignmentEventInput({
    sequence: value.sequence as number,
    eventId: value.eventId as string,
    eventType: value.eventType as RemoteWorkerAssignmentEventType,
    payload: value.payload as RemoteWorkerAssignmentEventPayload,
    previousEventSha256: value.previousEventSha256 as string,
    workerSentThrough: value.workerSentThrough as number,
  });
  const registryWorkspaceId = identifier(value.registryWorkspaceId, "registryWorkspaceId");
  const assignmentId = identifier(value.assignmentId, "assignmentId");
  const generation = positiveInteger(value.assignmentGeneration, "assignmentGeneration");
  const payloadSha256 = digest(value.payloadSha256, "payloadSha256");
  if (remoteWorkerAssignmentCanonicalSha256(event.payload) !== payloadSha256) {
    throw new TypeError("Assignment event payload digest does not match canonical bytes.");
  }
  const expectedEventSha256 = remoteWorkerAssignmentCanonicalSha256(
    remoteWorkerAssignmentEventHashMaterial({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration: generation,
      event,
      payloadSha256,
    }),
  );
  if (digest(value.eventSha256, "eventSha256") !== expectedEventSha256) {
    throw new TypeError("Assignment event digest does not match canonical chain material.");
  }
  isoTimestamp(value.receivedAt, "receivedAt");
}

export function assertRemoteWorkerAssignmentSettlementRecord(
  value: unknown,
): asserts value is RemoteWorkerAssignmentSettlementRecord {
  assertRecord(value, "assignment settlement record");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "outcome",
      "origin",
      "gatewayActorId",
      "recoveryEvidenceSha256",
      "finalEventSequence",
      "finalEventSha256",
      "resultSha256",
      "outputManifestSha256",
      "failureSha256",
      "idempotencyKey",
      "requestSha256",
      "settledAt",
    ],
    "assignment settlement record",
    ["gatewayActorId", "recoveryEvidenceSha256", "resultSha256", "outputManifestSha256", "failureSha256"],
  );
  if (value.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION) {
    throw new TypeError("Remote worker assignment settlement schema version is unsupported.");
  }
  enumValue(value.outcome, ["completed", "failed", "cancelled"], "outcome");
  enumValue(value.origin, ["worker", "gateway_recovery"], "origin");
  const settlementCommand = {
    registryWorkspaceId: value.registryWorkspaceId as string,
    assignmentId: value.assignmentId as string,
    expectedAssignmentGeneration: value.assignmentGeneration as number,
    expectedLeaseRevision: 1,
    outcome: value.outcome,
    origin: value.origin,
    finalEventSequence: value.finalEventSequence as number,
    finalEventSha256: value.finalEventSha256 as string,
    ...(value.resultSha256 === undefined ? {} : { resultSha256: value.resultSha256 as string }),
    ...(value.outputManifestSha256 === undefined ? {} : { outputManifestSha256: value.outputManifestSha256 as string }),
    ...(value.failureSha256 === undefined ? {} : { failureSha256: value.failureSha256 as string }),
    idempotencyKey: value.idempotencyKey as string,
  };
  normalizeSettleRemoteWorkerAssignmentCommand(
    value.origin === "worker"
      ? { ...settlementCommand, origin: "worker", leaseTokenSha256: "0".repeat(64) }
      : {
          ...settlementCommand,
          origin: "gateway_recovery",
          gatewayActorId: value.gatewayActorId as string,
          recoveryEvidenceSha256: value.recoveryEvidenceSha256 as string,
        },
  );
  digest(value.requestSha256, "requestSha256");
  isoTimestamp(value.settledAt, "settledAt");
}

export function assertRemoteWorkerAssignmentMaterializationRecord(
  value: unknown,
): asserts value is RemoteWorkerAssignmentMaterializationRecord {
  assertRecord(value, "assignment materialization record");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "materializationId",
      "registryWorkspaceId",
      "assignmentId",
      "sourceKind",
      "sourceGeneration",
      "sourceSequence",
      "sourceSha256",
      "targetKind",
      "targetId",
      "targetSha256",
      "targetOwnerSessionId",
      "targetOwnerTurnId",
      "targetOwnerDurableRunId",
      "receiptSha256",
      "gatewayActorId",
      "idempotencyKey",
      "requestSha256",
      "materializedAt",
    ],
    "assignment materialization record",
    ["sourceSequence", "targetOwnerSessionId", "targetOwnerTurnId", "targetOwnerDurableRunId"],
  );
  if (value.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_MATERIALIZATION_SCHEMA_VERSION) {
    throw new TypeError("Remote worker assignment materialization schema version is unsupported.");
  }
  identifier(value.materializationId, "materializationId");
  enumValue(value.sourceKind, ["event", "settlement"], "sourceKind");
  enumValue(value.targetKind, ["chat_transcript", "durable_run_result"], "targetKind");
  const common = {
    registryWorkspaceId: value.registryWorkspaceId as string,
    assignmentId: value.assignmentId as string,
    sourceGeneration: value.sourceGeneration as number,
    sourceSha256: value.sourceSha256 as string,
    targetId: value.targetId as string,
    targetSha256: value.targetSha256 as string,
    gatewayActorId: value.gatewayActorId as string,
    idempotencyKey: value.idempotencyKey as string,
  };
  normalizeRecordRemoteWorkerAssignmentMaterializationCommand(
    value.sourceKind === "event"
      ? {
          ...common,
          sourceKind: "event",
          sourceSequence: value.sourceSequence as number,
          targetKind: "chat_transcript",
          targetOwnerSessionId: value.targetOwnerSessionId as string,
          targetOwnerTurnId: value.targetOwnerTurnId as string,
        }
      : {
          ...common,
          sourceKind: "settlement",
          targetKind: "durable_run_result",
          targetOwnerDurableRunId: value.targetOwnerDurableRunId as string,
        },
  );
  digest(value.receiptSha256, "receiptSha256");
  digest(value.requestSha256, "requestSha256");
  isoTimestamp(value.materializedAt, "materializedAt");
}

function normalizeEventPayload(
  eventType: RemoteWorkerAssignmentEventType,
  input: RemoteWorkerAssignmentEventPayload,
): RemoteWorkerAssignmentEventPayload {
  assertRecord(input, "assignment event payload");
  if (input.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION) {
    throw new TypeError("Remote worker assignment event payload schema version is unsupported.");
  }
  let normalized: RemoteWorkerAssignmentEventPayload;
  switch (eventType) {
    case "status": {
      assertExactKeys(input, ["schemaVersion", "phase", "statusSha256"], "status event payload");
      const value = input as unknown as RemoteWorkerAssignmentStatusPayload;
      enumValue(value.phase, ["accepted", "running", "waiting", "finishing"], "phase");
      normalized = {
        schemaVersion: input.schemaVersion,
        phase: value.phase,
        statusSha256: digest(value.statusSha256, "statusSha256"),
      };
      break;
    }
    case "tool_progress": {
      assertExactKeys(
        input,
        ["schemaVersion", "toolRunId", "phase", "toolNameSha256", "argsSha256", "resultSha256"],
        "tool progress event payload",
        ["argsSha256", "resultSha256"],
      );
      const value = input as unknown as RemoteWorkerAssignmentToolProgressPayload;
      enumValue(value.phase, ["requested", "running", "waiting_approval", "completed", "failed"], "phase");
      normalized = {
        schemaVersion: input.schemaVersion,
        toolRunId: identifier(value.toolRunId, "toolRunId"),
        phase: value.phase,
        toolNameSha256: digest(value.toolNameSha256, "toolNameSha256"),
        ...(value.argsSha256 ? { argsSha256: digest(value.argsSha256, "argsSha256") } : {}),
        ...(value.resultSha256 ? { resultSha256: digest(value.resultSha256, "resultSha256") } : {}),
      };
      break;
    }
    case "model_progress": {
      assertExactKeys(
        input,
        ["schemaVersion", "inferenceRequestId", "inferenceAttempt", "phase", "modelIntentSha256"],
        "model progress event payload",
      );
      const value = input as unknown as RemoteWorkerAssignmentModelProgressPayload;
      enumValue(value.phase, ["requested", "streaming", "completed", "failed"], "phase");
      normalized = {
        schemaVersion: input.schemaVersion,
        inferenceRequestId: identifier(value.inferenceRequestId, "inferenceRequestId"),
        inferenceAttempt: positiveInteger(value.inferenceAttempt, "inferenceAttempt"),
        phase: value.phase,
        modelIntentSha256: digest(value.modelIntentSha256, "modelIntentSha256"),
      };
      break;
    }
    case "approval_wait": {
      assertExactKeys(
        input,
        ["schemaVersion", "approvalId", "approvalKind", "riskLevelSha256"],
        "approval wait event payload",
      );
      const value = input as unknown as RemoteWorkerAssignmentApprovalWaitPayload;
      normalized = {
        schemaVersion: input.schemaVersion,
        approvalId: identifier(value.approvalId, "approvalId"),
        approvalKind: reasonCode(value.approvalKind),
        riskLevelSha256: digest(value.riskLevelSha256, "riskLevelSha256"),
      };
      break;
    }
    case "diagnostic": {
      assertExactKeys(input, ["schemaVersion", "severity", "code", "detailSha256"], "diagnostic event payload");
      const value = input as unknown as RemoteWorkerAssignmentDiagnosticPayload;
      enumValue(value.severity, ["info", "warning", "error"], "severity");
      normalized = {
        schemaVersion: input.schemaVersion,
        severity: value.severity,
        code: reasonCode(value.code),
        detailSha256: digest(value.detailSha256, "detailSha256"),
      };
      break;
    }
    case "transcript_delta": {
      assertExactKeys(input, ["schemaVersion", "role", "text"], "transcript delta event payload");
      const value = input as unknown as RemoteWorkerAssignmentTranscriptDeltaPayload;
      if (value.role !== "assistant") throw new TypeError("Remote worker transcript delta role must be assistant.");
      normalized = {
        schemaVersion: input.schemaVersion,
        role: "assistant",
        text: boundedText(value.text, "text", 16_384),
      };
      break;
    }
    case "terminal_output": {
      assertExactKeys(input, ["schemaVersion", "stream", "chunkSha256", "byteLength"], "terminal output event payload");
      const value = input as unknown as RemoteWorkerAssignmentTerminalOutputPayload;
      enumValue(value.stream, ["stdout", "stderr"], "stream");
      normalized = {
        schemaVersion: input.schemaVersion,
        stream: value.stream,
        chunkSha256: digest(value.chunkSha256, "chunkSha256"),
        byteLength: positiveInteger(value.byteLength, "byteLength", REMOTE_WORKER_ASSIGNMENT_MAX_EVENT_BYTES),
      };
      break;
    }
  }
  return Object.freeze(normalized);
}

function normalizeCapabilities(value: readonly RemoteWorkerCapabilityClass[]): RemoteWorkerCapabilityClass[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REMOTE_WORKER_CAPABILITY_CLASSES.length) {
    throw new TypeError("Remote worker assignment requiredCapabilityClasses count is invalid.");
  }
  const result = value.map((item) => {
    if (!REMOTE_WORKER_CAPABILITY_CLASSES.includes(item)) {
      throw new TypeError("Remote worker assignment capability class is unsupported.");
    }
    return item;
  });
  if (new Set(result).size !== result.length || result.some((item, index) => index > 0 && result[index - 1]! >= item)) {
    throw new TypeError("Remote worker assignment requiredCapabilityClasses must be sorted and unique.");
  }
  return result;
}

function identifier(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Remote worker assignment ${field} is invalid.`);
  }
  return value;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.length < 1 || value.length > max) {
    throw new TypeError(`Remote worker assignment ${field} is invalid.`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker assignment ${field} must be a lower-case SHA-256 digest.`);
  }
  return value;
}

function reasonCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(value)) {
    throw new TypeError("Remote worker assignment reason code is invalid.");
  }
  return value;
}

function positiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new TypeError(`Remote worker assignment ${field} must be a bounded positive integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new TypeError(`Remote worker assignment ${field} must be a bounded non-negative integer.`);
  }
  return value as number;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Remote worker assignment ${field} must be a canonical UTC timestamp.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`Remote worker assignment ${field} is unsupported.`);
  }
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Remote worker ${field} must be an object.`);
  }
}

function assertExactKeys(value: object, allowed: string[], field: string, optional: string[] = []): void {
  const keys = Object.keys(value);
  const required = allowed.filter((key) => !optional.includes(key));
  if (keys.some((key) => !allowed.includes(key))) {
    throw new TypeError(`Remote worker ${field} contains unknown fields.`);
  }
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`Remote worker ${field} is missing required fields.`);
  }
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] as const;

function sha256Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = schedule[index - 15]!;
      const y = schedule[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const upper = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const first = (h! + upper + choice + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const lower = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}
