/* eslint-disable max-lines -- Cross-dialect assignment fencing, replay, and mapping stay in one audited repository boundary. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_MATERIALIZATION_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION,
  ValidationError,
  assertRemoteWorkerAssignmentControlRecord,
  assertRemoteWorkerAssignmentEventRecord,
  assertRemoteWorkerAssignmentGenerationRecord,
  assertRemoteWorkerAssignmentLeaseRecord,
  assertRemoteWorkerAssignmentMaterializationRecord,
  assertRemoteWorkerAssignmentRecord,
  assertRemoteWorkerAssignmentSettlementRecord,
  canonicalJsonString,
  buildRemoteWorkerAssignmentFlowControl,
  normalizeAppendRemoteWorkerAssignmentEventsCommand,
  normalizeControlRemoteWorkerAssignmentCommand,
  normalizeCreateRemoteWorkerAssignmentCommand,
  normalizeRecordRemoteWorkerAssignmentMaterializationCommand,
  normalizeRecoverRemoteWorkerAssignmentCommand,
  normalizeRenewRemoteWorkerAssignmentLeaseCommand,
  normalizeSettleRemoteWorkerAssignmentCommand,
  normalizeStartRemoteWorkerAssignmentGenerationCommand,
  remoteWorkerAssignmentCanonicalSha256,
  remoteWorkerAssignmentControlReplayMaterial,
  remoteWorkerAssignmentCreateReplayMaterial,
  remoteWorkerAssignmentEventHashMaterial,
  remoteWorkerAssignmentGenerationReplayMaterial,
  remoteWorkerAssignmentLeaseReplayMaterial,
  remoteWorkerAssignmentManifestSha256,
  remoteWorkerAssignmentMaterializationReplayMaterial,
  remoteWorkerAssignmentRecoveryReplayMaterial,
  remoteWorkerAssignmentSettlementReplayMaterial,
  type AppendRemoteWorkerAssignmentEventsCommand,
  type ControlRemoteWorkerAssignmentCommand,
  type CreateRemoteWorkerAssignmentCommand,
  type RecordRemoteWorkerAssignmentMaterializationCommand,
  type RecoverRemoteWorkerAssignmentCommand,
  type RemoteWorkerAssignmentAppendOutcome,
  type RemoteWorkerAssignmentControlAction,
  type RemoteWorkerAssignmentControlRecord,
  type RemoteWorkerAssignmentDispatchAuthority,
  type RemoteWorkerAssignmentEventRecord,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentLeaseRecord,
  type RemoteWorkerAssignmentManifest,
  type RemoteWorkerAssignmentMaterializationRecord,
  type RemoteWorkerAssignmentRecord,
  type RemoteWorkerAssignmentSettlementRecord,
  type RenewRemoteWorkerAssignmentLeaseCommand,
  type ResolvedRemoteWorkerAssignmentAuthority,
  type SettleRemoteWorkerAssignmentCommand,
  type StartRemoteWorkerAssignmentGenerationCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export interface CreateRemoteWorkerAssignmentOutcome {
  disposition: "created" | "replayed";
  assignment: RemoteWorkerAssignmentRecord;
}

export interface StartRemoteWorkerAssignmentGenerationOutcome {
  disposition: "started" | "replayed_without_lease_secret";
  generation: RemoteWorkerAssignmentGenerationRecord;
  lease: RemoteWorkerAssignmentLeaseRecord;
}

export interface RenewRemoteWorkerAssignmentLeaseOutcome {
  disposition: "renewed" | "replayed_without_lease_secret";
  lease: RemoteWorkerAssignmentLeaseRecord;
}

export interface RecoverRemoteWorkerAssignmentOutcome {
  disposition: "recovered" | "replayed_without_lease_secret";
  abandoned: RemoteWorkerAssignmentControlRecord;
  generation: RemoteWorkerAssignmentGenerationRecord;
  lease: RemoteWorkerAssignmentLeaseRecord;
}

export interface SettleRemoteWorkerAssignmentOutcome {
  disposition: "settled" | "replayed";
  settlement: RemoteWorkerAssignmentSettlementRecord;
}

export interface MaterializeRemoteWorkerAssignmentOutcome {
  disposition: "recorded" | "replayed";
  materialization: RemoteWorkerAssignmentMaterializationRecord;
}

export interface ListRecoverableRemoteWorkerAssignment {
  assignment: RemoteWorkerAssignmentRecord;
  generation: RemoteWorkerAssignmentGenerationRecord;
  lease: RemoteWorkerAssignmentLeaseRecord;
}

interface AssignmentRow {
  registry_workspace_id: string;
  assignment_id: string;
  execution_workspace_id: string;
  durable_run_id: string;
  task_id: string;
  session_id: string | null;
  turn_id: string | null;
  manifest_json: string;
  manifest_sha256: string;
  created_by_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
}

interface GenerationRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  execution_workspace_id: string;
  worker_id: string;
  worker_generation: number | bigint | string;
  node_id: string;
  node_admission_generation: number | bigint | string;
  runtime_manifest_sha256: string;
  workspace_ceiling_sha256: string;
  capability_ceiling_sha256: string;
  dispatch_owner_id: string;
  durable_run_attempt: number | bigint | string;
  dispatch_authority_json: string;
  dispatch_authority_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  started_at: string;
}

interface LeaseRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  lease_revision: number | bigint | string;
  lease_token_sha256: string;
  worker_sent_through: number | bigint | string;
  server_acknowledged_through: number | bigint | string;
  parent_dispatch_authority_json: string;
  parent_dispatch_authority_sha256: string;
  heartbeat_at: string;
  expires_at: string;
  idempotency_key: string;
  request_sha256: string;
}

interface ControlRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  control_revision: number | bigint | string;
  action: string;
  expected_lease_revision: number | bigint | string;
  reason_code: string;
  reason_sha256: string;
  actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
}

interface EventRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  sequence: number | bigint | string;
  event_id: string;
  event_type: string;
  payload_json: string;
  payload_sha256: string;
  previous_event_sha256: string;
  event_sha256: string;
  worker_sent_through: number | bigint | string;
  received_at: string;
}

interface SettlementRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  schema_version: string;
  outcome: string;
  origin: string;
  gateway_actor_id: string | null;
  recovery_evidence_sha256: string | null;
  final_event_sequence: number | bigint | string;
  final_event_sha256: string;
  result_sha256: string | null;
  output_manifest_sha256: string | null;
  failure_sha256: string | null;
  idempotency_key: string;
  request_sha256: string;
  settled_at: string;
}

interface MaterializationRow {
  registry_workspace_id: string;
  assignment_id: string;
  materialization_id: string;
  schema_version: string;
  source_kind: string;
  source_generation: number | bigint | string;
  source_sequence: number | bigint | string | null;
  source_sha256: string;
  target_kind: string;
  target_id: string;
  target_sha256: string;
  target_owner_session_id: string | null;
  target_owner_turn_id: string | null;
  target_owner_durable_run_id: string | null;
  receipt_sha256: string;
  gateway_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  materialized_at: string;
}

interface DurableAuthorityRow {
  run_id: string;
  status: string;
  attempt_count: number | bigint | string;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  version: number | bigint | string;
  metadata_json: string | null;
}

interface WorkerAuthorityRow {
  worker_id: string;
  node_id: string;
  worker_generation: number | bigint | string;
  runtime_manifest_sha256: string;
  workspace_ceiling_sha256: string;
  capability_ceiling_sha256: string;
}

export class RemoteWorkerAssignmentRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public createAssignment(input: CreateRemoteWorkerAssignmentCommand): CreateRemoteWorkerAssignmentOutcome {
    const command = normalizeCreateRemoteWorkerAssignmentCommand(input);
    const assignmentId = deriveServerId(
      "remote-worker-assignment",
      command.manifest.registryWorkspaceId,
      command.idempotencyKey,
    );
    const requestSha256 = sha256(remoteWorkerAssignmentCreateReplayMaterial(command));
    const manifestJson = canonicalJsonString(command.manifest);
    const manifestSha256 = remoteWorkerAssignmentManifestSha256(command.manifest);
    return this.db.transaction("immediate", () => {
      this.acquirePostgresRootLocks(command.manifest.registryWorkspaceId, assignmentId);
      const replay = this.findAssignmentByIdempotency(command.manifest.registryWorkspaceId, command.idempotencyKey);
      if (replay) {
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker assignment");
        return { disposition: "replayed", assignment: this.mapAssignment(replay) };
      }
      const parentRun = this.getDurableAuthorityRow(command.manifest.durableRunId, true);
      this.assertCanonicalParentContext(command.manifest, parentRun);
      if (!this.isTimestampFuture(command.manifest.deadlineAt)) {
        throw conflict("remote worker assignment deadline");
      }
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_assignments (
              registry_workspace_id, assignment_id, execution_workspace_id, durable_run_id, task_id,
              session_id, turn_id, manifest_json, manifest_sha256, created_by_actor_id,
              idempotency_key, request_sha256, created_at
            ) VALUES (
              @registryWorkspaceId, @assignmentId, @executionWorkspaceId, @durableRunId, @taskId,
              @sessionId, @turnId, @manifestJson, @manifestSha256, @createdByActorId,
              @idempotencyKey, @requestSha256, @createdAt
            )`,
          )
          .run({
            registryWorkspaceId: command.manifest.registryWorkspaceId,
            assignmentId,
            executionWorkspaceId: command.manifest.executionWorkspaceId,
            durableRunId: command.manifest.durableRunId,
            taskId: command.manifest.taskId,
            sessionId: command.manifest.sessionId ?? null,
            turnId: command.manifest.turnId ?? null,
            manifestJson,
            manifestSha256,
            createdByActorId: command.createdByActorId,
            idempotencyKey: command.idempotencyKey,
            requestSha256,
            createdAt: now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker assignment");
      }
      return {
        disposition: "created",
        assignment: this.getAssignment(command.manifest.registryWorkspaceId, assignmentId),
      };
    });
  }

  public startGeneration(
    input: StartRemoteWorkerAssignmentGenerationCommand,
  ): StartRemoteWorkerAssignmentGenerationOutcome {
    const command = normalizeStartRemoteWorkerAssignmentGenerationCommand(input);
    return this.db.transaction("immediate", () => {
      const assignment = this.getAssignment(command.registryWorkspaceId, command.assignmentId);
      const replay = this.findGenerationByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
      if (replay) {
        this.acquirePostgresGenerationLocks(
          replay.execution_workspace_id,
          replay.node_id,
          replay.registry_workspace_id,
          replay.worker_id,
          replay.assignment_id,
          asPositiveInteger(replay.assignment_generation),
        );
        const authority = parseCanonicalJson<RemoteWorkerAssignmentDispatchAuthority>(
          replay.dispatch_authority_json,
          "remote worker assignment generation replay dispatch authority",
        );
        const requestSha256 = sha256(
          remoteWorkerAssignmentGenerationReplayMaterial(
            command,
            asPositiveInteger(replay.assignment_generation),
            authority,
          ),
        );
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker assignment generation");
        const replayLease = this.findLeaseByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
        if (!replayLease || replayLease.lease_token_sha256 !== command.leaseTokenSha256) {
          throw conflict("remote worker assignment generation lease");
        }
        return {
          disposition: "replayed_without_lease_secret",
          generation: this.mapGeneration(replay),
          lease: this.mapLease(replayLease),
        };
      }
      this.acquirePostgresGenerationLocks(
        assignment.manifest.executionWorkspaceId,
        command.nodeId,
        command.registryWorkspaceId,
        command.workerId,
        command.assignmentId,
        this.nextAssignmentGeneration(command.registryWorkspaceId, command.assignmentId),
      );
      const generationNumber = this.nextAssignmentGeneration(command.registryWorkspaceId, command.assignmentId);
      const authority = this.assertStartAuthority(assignment, command);
      const requestSha256 = sha256(
        remoteWorkerAssignmentGenerationReplayMaterial(command, generationNumber, authority),
      );
      if (generationNumber !== 1) throw conflict("remote worker assignment generation");
      return this.insertGenerationAndLease(assignment, command, generationNumber, authority, requestSha256, "started");
    });
  }

  public renewLease(input: RenewRemoteWorkerAssignmentLeaseCommand): RenewRemoteWorkerAssignmentLeaseOutcome {
    const command = normalizeRenewRemoteWorkerAssignmentLeaseCommand(input);
    return this.db.transaction("immediate", () => {
      const generation = this.getGenerationRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      this.acquirePostgresGenerationLocks(
        generation.execution_workspace_id,
        generation.node_id,
        generation.registry_workspace_id,
        generation.worker_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      const requestSha256 = sha256(remoteWorkerAssignmentLeaseReplayMaterial(command));
      const replay = this.findLeaseByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
      if (replay) {
        const prior = this.getLeaseRow(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
          command.expectedLeaseRevision,
        );
        this.assertLeaseToken(prior, command.expectedLeaseTokenSha256);
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker assignment lease renewal");
        if (replay.lease_token_sha256 !== command.leaseTokenSha256) {
          throw conflict("remote worker assignment lease renewal");
        }
        return { disposition: "replayed_without_lease_secret", lease: this.mapLease(replay) };
      }
      const current = this.getCurrentLeaseRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      if (
        asPositiveInteger(current.lease_revision) !== command.expectedLeaseRevision ||
        !this.isTimestampFresh(current.expires_at)
      ) {
        throw conflict("remote worker assignment lease renewal");
      }
      this.assertLeaseToken(current, command.expectedLeaseTokenSha256);
      this.assertNoTerminalState(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      const parentDispatchAuthority = this.buildCurrentGenerationDispatchAuthority(generation);
      const acknowledgedThrough = this.currentAcknowledgedThrough(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      const committedWorkerSentThrough = this.currentWorkerSentThrough(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      if (command.workerSentThrough < Math.max(acknowledgedThrough, committedWorkerSentThrough)) {
        throw conflict("remote worker assignment sent-through watermark");
      }
      const assignment = this.getAssignment(command.registryWorkspaceId, command.assignmentId);
      const clock = this.assignmentLeaseClock(assignment.manifest, parentDispatchAuthority);
      const revision = command.expectedLeaseRevision + 1;
      try {
        this.insertLease({
          registryWorkspaceId: command.registryWorkspaceId,
          assignmentId: command.assignmentId,
          assignmentGeneration: command.expectedAssignmentGeneration,
          leaseRevision: revision,
          leaseTokenSha256: command.leaseTokenSha256,
          workerSentThrough: command.workerSentThrough,
          serverAcknowledgedThrough: acknowledgedThrough,
          parentDispatchAuthority,
          heartbeatAt: clock.now,
          expiresAt: clock.expiresAt,
          idempotencyKey: command.idempotencyKey,
          requestSha256,
        });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker assignment lease renewal");
      }
      return {
        disposition: "renewed",
        lease: this.mapLease(
          this.getLeaseRow(
            command.registryWorkspaceId,
            command.assignmentId,
            command.expectedAssignmentGeneration,
            revision,
          ),
        ),
      };
    });
  }

  public resolveActiveAuthorityByLeaseTokenHash(
    leaseTokenSha256: string,
  ): ResolvedRemoteWorkerAssignmentAuthority | undefined {
    const token = digest(leaseTokenSha256, "leaseTokenSha256");
    const hint = this.findLeaseByTokenHash(token);
    if (!hint) return undefined;
    return this.db.transaction("immediate", () => {
      const generation = this.getGenerationRow(
        hint.registry_workspace_id,
        hint.assignment_id,
        asPositiveInteger(hint.assignment_generation),
      );
      this.acquirePostgresGenerationLocks(
        generation.execution_workspace_id,
        generation.node_id,
        generation.registry_workspace_id,
        generation.worker_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      const current = this.getCurrentLeaseRow(
        hint.registry_workspace_id,
        hint.assignment_id,
        asPositiveInteger(hint.assignment_generation),
      );
      if (
        current.lease_token_sha256 !== token ||
        asPositiveInteger(current.lease_revision) !== asPositiveInteger(hint.lease_revision) ||
        !this.isTimestampFresh(current.expires_at)
      ) {
        return undefined;
      }
      this.assertLeaseDispatchAuthorityLive(generation, current);
      this.assertNoTerminalState(
        generation.registry_workspace_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      return {
        assignment: this.getAssignment(generation.registry_workspace_id, generation.assignment_id),
        generation: this.mapGeneration(generation),
        lease: this.mapLease(current),
      };
    });
  }

  public requestCancellation(input: ControlRemoteWorkerAssignmentCommand): RemoteWorkerAssignmentControlRecord {
    return this.insertControl("cancel_requested", input, false);
  }

  public markRecoveryExhausted(input: ControlRemoteWorkerAssignmentCommand): RemoteWorkerAssignmentControlRecord {
    return this.insertControl("recovery_exhausted", input, true);
  }

  public appendEvents(input: AppendRemoteWorkerAssignmentEventsCommand): RemoteWorkerAssignmentAppendOutcome {
    const command = normalizeAppendRemoteWorkerAssignmentEventsCommand(input);
    return this.db.transaction("immediate", () => {
      const generation = this.getGenerationRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      this.acquirePostgresGenerationLocks(
        generation.execution_workspace_id,
        generation.node_id,
        generation.registry_workspace_id,
        generation.worker_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      const assignment = this.getAssignment(command.registryWorkspaceId, command.assignmentId);
      const replayRows = command.events.map((event) =>
        this.findEventRow(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
          event.sequence,
        ),
      );
      if (replayRows.every((row) => row !== undefined)) {
        const originalLease = this.getLeaseRow(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
          command.expectedLeaseRevision,
        );
        this.assertLeaseToken(originalLease, command.leaseTokenSha256);
        const events = command.events.map((event, index) => {
          const existing = replayRows[index]!;
          const payloadJson = canonicalJsonString(event.payload);
          const payloadSha256 = sha256Bytes(payloadJson);
          const eventSha256 = sha256(
            remoteWorkerAssignmentEventHashMaterial({
              registryWorkspaceId: command.registryWorkspaceId,
              assignmentId: command.assignmentId,
              assignmentGeneration: command.expectedAssignmentGeneration,
              event,
              payloadSha256,
            }),
          );
          if (
            existing.event_id !== event.eventId ||
            existing.event_type !== event.eventType ||
            existing.payload_json !== payloadJson ||
            existing.payload_sha256 !== payloadSha256 ||
            existing.previous_event_sha256 !== event.previousEventSha256 ||
            existing.event_sha256 !== eventSha256 ||
            asPositiveInteger(existing.worker_sent_through) !== event.workerSentThrough
          ) {
            throw conflict("remote worker assignment event replay");
          }
          return this.mapEvent(existing);
        });
        const acknowledgedThrough = this.currentAcknowledgedThrough(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
        );
        const workerSentThrough = this.currentWorkerSentThrough(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
        );
        return {
          disposition: "replayed",
          acknowledgedThrough,
          workerSentThrough,
          pendingCount: Math.max(0, workerSentThrough - acknowledgedThrough),
          flowControl: buildRemoteWorkerAssignmentFlowControl(
            assignment.manifest,
            acknowledgedThrough,
            workerSentThrough,
          ),
          events: Object.freeze(events),
        };
      }
      const lease = this.getCurrentLeaseRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      this.authenticateCurrentLease(command.expectedLeaseRevision, command.leaseTokenSha256, lease);
      this.assertLeaseDispatchAuthorityLive(generation, lease);
      this.assertNoTerminalState(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      let acknowledgedThrough = this.currentAcknowledgedThrough(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      let lastHash = this.currentEventHash(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      let workerSentThrough = this.currentWorkerSentThrough(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      let replayed = 0;
      let appended = 0;
      const returned: RemoteWorkerAssignmentEventRecord[] = [];
      const receivedAt = this.databaseNow();
      for (const event of command.events) {
        const payloadJson = canonicalJsonString(event.payload);
        const payloadSha256 = sha256Bytes(payloadJson);
        const eventSha256 = sha256(
          remoteWorkerAssignmentEventHashMaterial({
            registryWorkspaceId: command.registryWorkspaceId,
            assignmentId: command.assignmentId,
            assignmentGeneration: command.expectedAssignmentGeneration,
            event,
            payloadSha256,
          }),
        );
        const existing = this.findEventRow(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
          event.sequence,
        );
        if (existing) {
          if (
            existing.event_id !== event.eventId ||
            existing.event_type !== event.eventType ||
            existing.payload_json !== payloadJson ||
            existing.payload_sha256 !== payloadSha256 ||
            existing.previous_event_sha256 !== event.previousEventSha256 ||
            existing.event_sha256 !== eventSha256 ||
            asPositiveInteger(existing.worker_sent_through) !== event.workerSentThrough
          ) {
            throw conflict("remote worker assignment event replay");
          }
          replayed += 1;
          returned.push(this.mapEvent(existing));
          continue;
        }
        if (event.sequence !== acknowledgedThrough + 1 || event.previousEventSha256 !== lastHash) {
          throw conflict("remote worker assignment event gap or chain");
        }
        if (event.workerSentThrough < workerSentThrough) {
          throw conflict("remote worker assignment sent-through watermark");
        }
        if (new TextEncoder().encode(payloadJson).byteLength > assignment.manifest.maxEventBytes) {
          throw conflict("remote worker assignment cumulative event byte ceiling");
        }
        try {
          this.db
            .prepare(
              `INSERT INTO remote_worker_assignment_events (
                registry_workspace_id, assignment_id, assignment_generation, sequence, event_id,
                event_type, payload_json, payload_sha256, previous_event_sha256, event_sha256,
                worker_sent_through, received_at
              ) VALUES (
                @registryWorkspaceId, @assignmentId, @assignmentGeneration, @sequence, @eventId,
                @eventType, @payloadJson, @payloadSha256, @previousEventSha256, @eventSha256,
                @workerSentThrough, @receivedAt
              )`,
            )
            .run({
              registryWorkspaceId: command.registryWorkspaceId,
              assignmentId: command.assignmentId,
              assignmentGeneration: command.expectedAssignmentGeneration,
              sequence: event.sequence,
              eventId: event.eventId,
              eventType: event.eventType,
              payloadJson,
              payloadSha256,
              previousEventSha256: event.previousEventSha256,
              eventSha256,
              workerSentThrough: event.workerSentThrough,
              receivedAt,
            });
        } catch (error) {
          throw normalizeWriteError(error, "remote worker assignment event append");
        }
        acknowledgedThrough = event.sequence;
        workerSentThrough = Math.max(workerSentThrough, event.workerSentThrough);
        lastHash = eventSha256;
        appended += 1;
        returned.push(
          this.mapEvent(
            this.getEventRow(
              command.registryWorkspaceId,
              command.assignmentId,
              command.expectedAssignmentGeneration,
              event.sequence,
            ),
          ),
        );
      }
      return {
        disposition: appended === 0 ? "replayed" : replayed === 0 ? "appended" : "partially_replayed",
        acknowledgedThrough,
        workerSentThrough,
        pendingCount: Math.max(0, workerSentThrough - acknowledgedThrough),
        flowControl: buildRemoteWorkerAssignmentFlowControl(
          assignment.manifest,
          acknowledgedThrough,
          workerSentThrough,
        ),
        events: Object.freeze(returned),
      };
    });
  }

  public settleAssignment(input: SettleRemoteWorkerAssignmentCommand): SettleRemoteWorkerAssignmentOutcome {
    const command = normalizeSettleRemoteWorkerAssignmentCommand(input);
    return this.db.transaction("immediate", () => {
      const generation = this.getGenerationRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      this.acquirePostgresGenerationLocks(
        generation.execution_workspace_id,
        generation.node_id,
        generation.registry_workspace_id,
        generation.worker_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      const requestSha256 = sha256(remoteWorkerAssignmentSettlementReplayMaterial(command));
      const replay = this.findSettlementByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
      if (replay) {
        if (command.origin === "worker") {
          const originalLease = this.getLeaseRow(
            command.registryWorkspaceId,
            command.assignmentId,
            command.expectedAssignmentGeneration,
            command.expectedLeaseRevision,
          );
          this.assertLeaseToken(originalLease, command.leaseTokenSha256);
        }
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker assignment settlement");
        return { disposition: "replayed", settlement: this.mapSettlement(replay) };
      }
      if (command.origin === "worker") {
        const lease = this.getCurrentLeaseRow(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
        );
        this.authenticateCurrentLease(command.expectedLeaseRevision, command.leaseTokenSha256, lease);
        this.assertLeaseDispatchAuthorityLive(generation, lease);
      } else {
        const control = this.findControlByRequestHash(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
          command.recoveryEvidenceSha256,
        );
        const evidenceMatchesOutcome =
          command.outcome === "cancelled"
            ? control?.action === "cancel_requested"
            : control !== undefined && ["generation_abandoned", "recovery_exhausted"].includes(control.action);
        if (!evidenceMatchesOutcome) {
          throw conflict("remote worker assignment recovery settlement evidence");
        }
      }
      if (this.findSettlement(command.registryWorkspaceId, command.assignmentId)) {
        throw conflict("remote worker assignment settlement winner");
      }
      const currentSequence = this.currentAcknowledgedThrough(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      const currentHash = this.currentEventHash(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      if (command.finalEventSequence !== currentSequence || command.finalEventSha256 !== currentHash) {
        throw conflict("remote worker assignment settlement chain");
      }
      const cancel = this.findControlByAction(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
        "cancel_requested",
      );
      if ((command.outcome === "cancelled") !== Boolean(cancel)) {
        throw conflict("remote worker assignment cancellation settlement");
      }
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_assignment_settlements (
              registry_workspace_id, assignment_id, assignment_generation, schema_version, outcome, origin,
              gateway_actor_id, recovery_evidence_sha256, final_event_sequence, final_event_sha256,
              result_sha256, output_manifest_sha256, failure_sha256, idempotency_key, request_sha256, settled_at
            ) VALUES (
              @registryWorkspaceId, @assignmentId, @assignmentGeneration, @schemaVersion, @outcome, @origin,
              @gatewayActorId, @recoveryEvidenceSha256, @finalEventSequence, @finalEventSha256,
              @resultSha256, @outputManifestSha256, @failureSha256, @idempotencyKey, @requestSha256, @settledAt
            )`,
          )
          .run({
            registryWorkspaceId: command.registryWorkspaceId,
            assignmentId: command.assignmentId,
            assignmentGeneration: command.expectedAssignmentGeneration,
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION,
            outcome: command.outcome,
            origin: command.origin,
            gatewayActorId: command.origin === "gateway_recovery" ? command.gatewayActorId : null,
            recoveryEvidenceSha256: command.origin === "gateway_recovery" ? command.recoveryEvidenceSha256 : null,
            finalEventSequence: command.finalEventSequence,
            finalEventSha256: command.finalEventSha256,
            resultSha256: command.resultSha256 ?? null,
            outputManifestSha256: command.outputManifestSha256 ?? null,
            failureSha256: command.failureSha256 ?? null,
            idempotencyKey: command.idempotencyKey,
            requestSha256,
            settledAt: now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker assignment settlement");
      }
      return {
        disposition: "settled",
        settlement: this.mapSettlement(this.getSettlementRow(command.registryWorkspaceId, command.assignmentId)),
      };
    });
  }

  public recordMaterialization(
    input: RecordRemoteWorkerAssignmentMaterializationCommand,
  ): MaterializeRemoteWorkerAssignmentOutcome {
    const command = normalizeRecordRemoteWorkerAssignmentMaterializationCommand(input);
    return this.db.transaction("immediate", () => {
      const generation = this.getGenerationRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.sourceGeneration,
      );
      this.acquirePostgresGenerationLocks(
        generation.execution_workspace_id,
        generation.node_id,
        generation.registry_workspace_id,
        generation.worker_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      const requestSha256 = sha256(remoteWorkerAssignmentMaterializationReplayMaterial(command));
      const receiptSha256 = sha256({
        schemaVersion: REMOTE_WORKER_ASSIGNMENT_MATERIALIZATION_SCHEMA_VERSION,
        ...command,
      });
      const replay = this.findMaterializationByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
      if (replay) {
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker assignment materialization");
        if (replay.receipt_sha256 !== receiptSha256) throw conflict("remote worker assignment materialization");
        return { disposition: "replayed", materialization: this.mapMaterialization(replay) };
      }
      this.assertMaterializationSource(command);
      const materializationId = deriveServerId(
        "remote-worker-materialization",
        command.registryWorkspaceId,
        command.assignmentId,
        command.idempotencyKey,
      );
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_assignment_materializations (
              registry_workspace_id, assignment_id, materialization_id, schema_version,
              source_kind, source_generation, source_sequence, source_sha256,
              target_kind, target_id, target_sha256, receipt_sha256, gateway_actor_id,
              target_owner_session_id, target_owner_turn_id, target_owner_durable_run_id,
              idempotency_key, request_sha256, materialized_at
            ) VALUES (
              @registryWorkspaceId, @assignmentId, @materializationId, @schemaVersion,
              @sourceKind, @sourceGeneration, @sourceSequence, @sourceSha256,
              @targetKind, @targetId, @targetSha256, @receiptSha256, @gatewayActorId,
              @targetOwnerSessionId, @targetOwnerTurnId, @targetOwnerDurableRunId,
              @idempotencyKey, @requestSha256, @materializedAt
            )`,
          )
          .run({
            ...command,
            sourceSequence: command.sourceKind === "event" ? command.sourceSequence : null,
            targetOwnerSessionId: command.sourceKind === "event" ? command.targetOwnerSessionId : null,
            targetOwnerTurnId: command.sourceKind === "event" ? command.targetOwnerTurnId : null,
            targetOwnerDurableRunId: command.sourceKind === "settlement" ? command.targetOwnerDurableRunId : null,
            materializationId,
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_MATERIALIZATION_SCHEMA_VERSION,
            receiptSha256,
            requestSha256,
            materializedAt: now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker assignment materialization");
      }
      return {
        disposition: "recorded",
        materialization: this.mapMaterialization(
          this.getMaterializationRow(command.registryWorkspaceId, command.assignmentId, materializationId),
        ),
      };
    });
  }

  public recoverExpiredAssignment(input: RecoverRemoteWorkerAssignmentCommand): RecoverRemoteWorkerAssignmentOutcome {
    const command = normalizeRecoverRemoteWorkerAssignmentCommand(input);
    return this.db.transaction("immediate", () => {
      const assignment = this.getAssignment(command.registryWorkspaceId, command.assignmentId);
      const replay = this.findGenerationByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
      if (replay) {
        const priorGenerationNumber = asPositiveInteger(replay.assignment_generation) - 1;
        if (priorGenerationNumber < 1) throw conflict("remote worker assignment recovery replay");
        const priorGeneration = this.getGenerationRow(
          command.registryWorkspaceId,
          command.assignmentId,
          priorGenerationNumber,
        );
        this.acquirePostgresRecoveryLocks(assignment, priorGeneration, command);
        const authority = parseCanonicalJson<RemoteWorkerAssignmentDispatchAuthority>(
          replay.dispatch_authority_json,
          "remote worker assignment recovery dispatch authority",
        );
        const requestSha256 = sha256(
          remoteWorkerAssignmentRecoveryReplayMaterial(
            command,
            asPositiveInteger(replay.assignment_generation),
            authority,
          ),
        );
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker assignment recovery");
        const control = this.findControlByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
        const lease = this.findLeaseByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
        const controlCommand: ControlRemoteWorkerAssignmentCommand = {
          registryWorkspaceId: command.registryWorkspaceId,
          assignmentId: command.assignmentId,
          expectedAssignmentGeneration: command.expectedAssignmentGeneration,
          expectedLeaseRevision: command.expectedLeaseRevision,
          reasonCode: command.reasonCode,
          reasonSha256: command.reasonSha256,
          actorId: command.actorId,
          idempotencyKey: command.idempotencyKey,
        };
        const controlRequestSha256 = sha256(
          remoteWorkerAssignmentControlReplayMaterial("generation_abandoned", controlCommand),
        );
        if (
          !control ||
          control.action !== "generation_abandoned" ||
          control.request_sha256 !== controlRequestSha256 ||
          !lease ||
          lease.lease_token_sha256 !== command.leaseTokenSha256
        ) {
          throw conflict("remote worker assignment recovery replay");
        }
        return {
          disposition: "replayed_without_lease_secret",
          abandoned: this.mapControl(control),
          generation: this.mapGeneration(replay),
          lease: this.mapLease(lease),
        };
      }
      const oldGeneration = this.getGenerationRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      this.acquirePostgresRecoveryLocks(assignment, oldGeneration, command);
      const currentGeneration = this.getCurrentGenerationRow(command.registryWorkspaceId, command.assignmentId);
      if (asPositiveInteger(currentGeneration.assignment_generation) !== command.expectedAssignmentGeneration) {
        throw conflict("remote worker assignment recovery generation");
      }
      const oldLease = this.getCurrentLeaseRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      if (
        asPositiveInteger(oldLease.lease_revision) !== command.expectedLeaseRevision ||
        this.isTimestampFresh(oldLease.expires_at)
      ) {
        throw conflict("remote worker assignment recovery lease");
      }
      if (
        this.findControlByAction(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
          "cancel_requested",
        )
      ) {
        throw conflict("remote worker assignment recovery after cancellation");
      }
      if (this.findSettlement(command.registryWorkspaceId, command.assignmentId)) {
        throw conflict("remote worker assignment recovery after settlement");
      }
      const nextGeneration = command.expectedAssignmentGeneration + 1;
      const authority = this.assertStartAuthority(assignment, command);
      const requestSha256 = sha256(remoteWorkerAssignmentRecoveryReplayMaterial(command, nextGeneration, authority));
      const controlCommand: ControlRemoteWorkerAssignmentCommand = {
        registryWorkspaceId: command.registryWorkspaceId,
        assignmentId: command.assignmentId,
        expectedAssignmentGeneration: command.expectedAssignmentGeneration,
        expectedLeaseRevision: command.expectedLeaseRevision,
        reasonCode: command.reasonCode,
        reasonSha256: command.reasonSha256,
        actorId: command.actorId,
        idempotencyKey: command.idempotencyKey,
      };
      const controlRequestSha256 = sha256(
        remoteWorkerAssignmentControlReplayMaterial("generation_abandoned", controlCommand),
      );
      const now = this.databaseNow();
      try {
        this.insertControlRow("generation_abandoned", controlCommand, 1, controlRequestSha256, now);
        const inserted = this.insertGenerationAndLease(
          assignment,
          command,
          nextGeneration,
          authority,
          requestSha256,
          "recovered",
        );
        return {
          disposition: "recovered",
          abandoned: this.mapControl(
            this.getControlRow(
              command.registryWorkspaceId,
              command.assignmentId,
              command.expectedAssignmentGeneration,
              1,
            ),
          ),
          generation: inserted.generation,
          lease: inserted.lease,
        };
      } catch (error) {
        throw normalizeWriteError(error, "remote worker assignment recovery");
      }
    });
  }

  public getAssignment(registryWorkspaceId: string, assignmentId: string): RemoteWorkerAssignmentRecord {
    return this.mapAssignment(this.getAssignmentRow(registryWorkspaceId, assignmentId));
  }

  public findCurrentGeneration(
    registryWorkspaceId: string,
    assignmentId: string,
  ): RemoteWorkerAssignmentGenerationRecord | undefined {
    const row = this.findCurrentGenerationRow(
      identifier(registryWorkspaceId, "registryWorkspaceId"),
      identifier(assignmentId, "assignmentId"),
    );
    return row ? this.mapGeneration(row) : undefined;
  }

  public listEventsAfter(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    afterSequence = 0,
    limit = 100,
  ): RemoteWorkerAssignmentEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_events
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND sequence > @afterSequence
         ORDER BY sequence ASC LIMIT @limit`,
      )
      .all({
        registryWorkspaceId: identifier(registryWorkspaceId, "registryWorkspaceId"),
        assignmentId: identifier(assignmentId, "assignmentId"),
        assignmentGeneration: positiveInteger(assignmentGeneration, "assignmentGeneration"),
        afterSequence: nonNegativeInteger(afterSequence, "afterSequence"),
        limit: positiveInteger(limit, "limit", 500),
      }) as EventRow[];
    return rows.map((row) => this.mapEvent(row));
  }

  public listRecoverableExpiredAssignments(limit = 50): ListRecoverableRemoteWorkerAssignment[] {
    const rows = this.db
      .prepare(
        `SELECT lease.* FROM remote_worker_assignment_leases lease
         JOIN remote_worker_assignment_generations generation
           ON generation.registry_workspace_id = lease.registry_workspace_id
          AND generation.assignment_id = lease.assignment_id
          AND generation.assignment_generation = lease.assignment_generation
         WHERE generation.assignment_generation = (
           SELECT MAX(current.assignment_generation) FROM remote_worker_assignment_generations current
           WHERE current.registry_workspace_id = generation.registry_workspace_id
             AND current.assignment_id = generation.assignment_id
         )
           AND lease.lease_revision = (
             SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
             WHERE current.registry_workspace_id = lease.registry_workspace_id
               AND current.assignment_id = lease.assignment_id
               AND current.assignment_generation = lease.assignment_generation
           )
           AND ${this.expiredTimestampPredicate("lease.expires_at")}
           AND NOT EXISTS (
             SELECT 1 FROM remote_worker_assignment_controls control
             WHERE control.registry_workspace_id = lease.registry_workspace_id
               AND control.assignment_id = lease.assignment_id
               AND control.assignment_generation = lease.assignment_generation
           )
           AND NOT EXISTS (
             SELECT 1 FROM remote_worker_assignment_settlements settlement
             WHERE settlement.registry_workspace_id = lease.registry_workspace_id
               AND settlement.assignment_id = lease.assignment_id
           )
         ORDER BY lease.expires_at ASC, lease.assignment_id ASC LIMIT @limit`,
      )
      .all({ limit: positiveInteger(limit, "limit", 200) }) as LeaseRow[];
    return rows.map((lease) => ({
      assignment: this.getAssignment(lease.registry_workspace_id, lease.assignment_id),
      generation: this.mapGeneration(
        this.getGenerationRow(
          lease.registry_workspace_id,
          lease.assignment_id,
          asPositiveInteger(lease.assignment_generation),
        ),
      ),
      lease: this.mapLease(lease),
    }));
  }

  private insertControl(
    action: RemoteWorkerAssignmentControlAction,
    input: ControlRemoteWorkerAssignmentCommand,
    requireExpired: boolean,
  ): RemoteWorkerAssignmentControlRecord {
    const command = normalizeControlRemoteWorkerAssignmentCommand(input);
    const requestSha256 = sha256(remoteWorkerAssignmentControlReplayMaterial(action, command));
    return this.db.transaction("immediate", () => {
      const generation = this.getGenerationRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      this.acquirePostgresGenerationLocks(
        generation.execution_workspace_id,
        generation.node_id,
        generation.registry_workspace_id,
        generation.worker_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      const replay = this.findControlByIdempotency(command.registryWorkspaceId, command.idempotencyKey);
      if (replay) {
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker assignment control");
        if (replay.action !== action) throw conflict("remote worker assignment control");
        return this.mapControl(replay);
      }
      const currentGeneration = this.getCurrentGenerationRow(command.registryWorkspaceId, command.assignmentId);
      if (asPositiveInteger(currentGeneration.assignment_generation) !== command.expectedAssignmentGeneration) {
        throw conflict("remote worker assignment control generation");
      }
      const lease = this.getCurrentLeaseRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.expectedAssignmentGeneration,
      );
      if (asPositiveInteger(lease.lease_revision) !== command.expectedLeaseRevision) {
        throw conflict("remote worker assignment control lease");
      }
      if (requireExpired && this.isTimestampFresh(lease.expires_at)) {
        throw conflict("remote worker assignment control clock");
      }
      if (this.findSettlement(command.registryWorkspaceId, command.assignmentId)) {
        throw conflict("remote worker assignment control after settlement");
      }
      if (
        this.findLatestControlRow(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
        )
      ) {
        throw conflict("remote worker assignment control winner");
      }
      const now = this.databaseNow();
      try {
        this.insertControlRow(action, command, 1, requestSha256, now);
      } catch (error) {
        throw normalizeWriteError(error, "remote worker assignment control");
      }
      return this.mapControl(
        this.getControlRow(command.registryWorkspaceId, command.assignmentId, command.expectedAssignmentGeneration, 1),
      );
    });
  }

  private insertGenerationAndLease(
    assignment: RemoteWorkerAssignmentRecord,
    command: StartRemoteWorkerAssignmentGenerationCommand,
    generationNumber: number,
    authority: RemoteWorkerAssignmentDispatchAuthority,
    requestSha256: string,
    disposition: "started" | "recovered",
  ): StartRemoteWorkerAssignmentGenerationOutcome {
    const worker = this.getWorkerAuthorityRow(command.registryWorkspaceId, command.workerId, command.workerGeneration);
    const dispatchAuthorityJson = canonicalJsonString(authority);
    const dispatchAuthoritySha256 = sha256Bytes(dispatchAuthorityJson);
    const clock = this.assignmentLeaseClock(assignment.manifest, authority);
    try {
      this.db
        .prepare(
          `INSERT INTO remote_worker_assignment_generations (
            registry_workspace_id, assignment_id, assignment_generation, execution_workspace_id,
            worker_id, worker_generation, node_id, node_admission_generation,
            runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
            dispatch_owner_id, durable_run_attempt, dispatch_authority_json, dispatch_authority_sha256,
            idempotency_key, request_sha256, started_at
          ) VALUES (
            @registryWorkspaceId, @assignmentId, @assignmentGeneration, @executionWorkspaceId,
            @workerId, @workerGeneration, @nodeId, @nodeAdmissionGeneration,
            @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
            @dispatchOwnerId, @durableRunAttempt, @dispatchAuthorityJson, @dispatchAuthoritySha256,
            @idempotencyKey, @requestSha256, @startedAt
          )`,
        )
        .run({
          registryWorkspaceId: command.registryWorkspaceId,
          assignmentId: command.assignmentId,
          assignmentGeneration: generationNumber,
          executionWorkspaceId: assignment.manifest.executionWorkspaceId,
          workerId: command.workerId,
          workerGeneration: command.workerGeneration,
          nodeId: command.nodeId,
          nodeAdmissionGeneration: command.nodeAdmissionGeneration,
          runtimeManifestSha256: worker.runtime_manifest_sha256,
          workspaceCeilingSha256: worker.workspace_ceiling_sha256,
          capabilityCeilingSha256: worker.capability_ceiling_sha256,
          dispatchOwnerId: command.dispatchOwnerId,
          durableRunAttempt: command.durableRunAttempt,
          dispatchAuthorityJson,
          dispatchAuthoritySha256,
          idempotencyKey: command.idempotencyKey,
          requestSha256,
          startedAt: clock.now,
        });
      this.insertLease({
        registryWorkspaceId: command.registryWorkspaceId,
        assignmentId: command.assignmentId,
        assignmentGeneration: generationNumber,
        leaseRevision: 1,
        leaseTokenSha256: command.leaseTokenSha256,
        workerSentThrough: 0,
        serverAcknowledgedThrough: 0,
        parentDispatchAuthority: authority,
        heartbeatAt: clock.now,
        expiresAt: clock.expiresAt,
        idempotencyKey: command.idempotencyKey,
        requestSha256,
      });
    } catch (error) {
      throw normalizeWriteError(error, "remote worker assignment generation");
    }
    return {
      disposition: disposition === "started" ? "started" : "started",
      generation: this.mapGeneration(
        this.getGenerationRow(command.registryWorkspaceId, command.assignmentId, generationNumber),
      ),
      lease: this.mapLease(this.getLeaseRow(command.registryWorkspaceId, command.assignmentId, generationNumber, 1)),
    };
  }

  private assertStartAuthority(
    assignment: RemoteWorkerAssignmentRecord,
    command: StartRemoteWorkerAssignmentGenerationCommand,
  ): RemoteWorkerAssignmentDispatchAuthority {
    const run = this.getDurableAuthorityRow(assignment.manifest.durableRunId, true);
    this.assertCanonicalParentContext(assignment.manifest, run);
    if (
      assignment.registryWorkspaceId !== command.registryWorkspaceId ||
      !this.isTimestampFuture(assignment.manifest.deadlineAt)
    ) {
      throw conflict("remote worker assignment manifest authority");
    }
    const worker = this.getWorkerAuthorityRow(command.registryWorkspaceId, command.workerId, command.workerGeneration);
    if (worker.node_id !== command.nodeId) throw conflict("remote worker assignment worker node");
    this.assertWorkerIsCurrentAndAllowed(worker, assignment.manifest);
    this.assertNodeAdmissionCurrent(
      assignment.manifest.executionWorkspaceId,
      command.nodeId,
      command.nodeAdmissionGeneration,
    );
    if (
      run.status !== "running" ||
      asPositiveInteger(run.attempt_count) !== command.durableRunAttempt ||
      run.lease_owner_id !== command.dispatchOwnerId ||
      !run.lease_expires_at ||
      !this.isTimestampFresh(run.lease_expires_at)
    ) {
      throw conflict("remote worker assignment durable dispatch authority");
    }
    return Object.freeze({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION,
      durableRunId: run.run_id,
      durableRunAttempt: asPositiveInteger(run.attempt_count),
      dispatchOwnerId: run.lease_owner_id,
      durableRunVersion: asPositiveInteger(run.version),
      durableRunLeaseExpiresAt: run.lease_expires_at,
    });
  }

  private assertCanonicalParentContext(manifest: RemoteWorkerAssignmentManifest, run: DurableAuthorityRow): void {
    const parentLockSuffix = this.db.dialect === "postgres" ? " FOR SHARE" : "";
    const task = this.db
      .prepare(`SELECT workspace_id, deleted_at FROM tasks WHERE task_id = @taskId${parentLockSuffix}`)
      .get({ taskId: manifest.taskId }) as { workspace_id?: unknown; deleted_at?: unknown } | undefined;
    if (task?.workspace_id !== manifest.executionWorkspaceId || task.deleted_at !== null) {
      throw conflict("remote worker assignment canonical task context");
    }
    if (manifest.sessionId !== undefined) {
      const session = this.db
        .prepare(`SELECT workspace_id FROM chat_session_meta WHERE session_id = @sessionId${parentLockSuffix}`)
        .get({ sessionId: manifest.sessionId }) as { workspace_id?: unknown } | undefined;
      const turn = this.db
        .prepare(`SELECT session_id FROM chat_turn_traces WHERE turn_id = @turnId${parentLockSuffix}`)
        .get({ turnId: manifest.turnId }) as { session_id?: unknown } | undefined;
      if (session?.workspace_id !== manifest.executionWorkspaceId || turn?.session_id !== manifest.sessionId) {
        throw conflict("remote worker assignment canonical session-turn context");
      }
    }
    if (run.run_id !== manifest.durableRunId || typeof run.metadata_json !== "string") {
      throw conflict("remote worker assignment canonical durable parent context");
    }
    const metadata = safeJsonParse<Record<string, unknown>>(run.metadata_json, {});
    const parent = metadata.remoteWorkerAssignmentParentContext;
    if (
      typeof parent !== "object" ||
      parent === null ||
      Array.isArray(parent) ||
      metadata.remoteWorkerAssignmentParentContextSha256 !== manifest.parentContextSha256 ||
      remoteWorkerAssignmentCanonicalSha256(parent) !== manifest.parentContextSha256
    ) {
      throw conflict("remote worker assignment canonical durable parent context");
    }
    const expected = {
      schemaVersion: "goatcitadel.remote-worker-assignment-parent-context.v1",
      executionWorkspaceId: manifest.executionWorkspaceId,
      durableRunId: manifest.durableRunId,
      taskId: manifest.taskId,
      ...(manifest.sessionId === undefined ? {} : { sessionId: manifest.sessionId, turnId: manifest.turnId }),
    };
    if (canonicalJsonString(parent) !== canonicalJsonString(expected)) {
      throw conflict("remote worker assignment canonical durable parent context");
    }
  }

  private buildCurrentGenerationDispatchAuthority(generation: GenerationRow): RemoteWorkerAssignmentDispatchAuthority {
    const assignment = this.getAssignment(generation.registry_workspace_id, generation.assignment_id);
    const run = this.getDurableAuthorityRow(assignment.manifest.durableRunId, true);
    this.assertCanonicalParentContext(assignment.manifest, run);
    const worker = this.getWorkerAuthorityRow(
      generation.registry_workspace_id,
      generation.worker_id,
      asPositiveInteger(generation.worker_generation),
    );
    this.assertWorkerIsCurrentAndAllowed(worker, assignment.manifest);
    this.assertNodeAdmissionCurrent(
      generation.execution_workspace_id,
      generation.node_id,
      asPositiveInteger(generation.node_admission_generation),
    );
    if (
      run.status !== "running" ||
      run.lease_owner_id !== generation.dispatch_owner_id ||
      asPositiveInteger(run.attempt_count) !== asPositiveInteger(generation.durable_run_attempt) ||
      !run.lease_expires_at ||
      !this.isTimestampFresh(run.lease_expires_at)
    ) {
      throw conflict("remote worker assignment current parent dispatch authority");
    }
    return Object.freeze({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION,
      durableRunId: run.run_id,
      durableRunAttempt: asPositiveInteger(run.attempt_count),
      dispatchOwnerId: run.lease_owner_id,
      durableRunVersion: asPositiveInteger(run.version),
      durableRunLeaseExpiresAt: run.lease_expires_at,
    });
  }

  private assertLeaseDispatchAuthorityLive(generation: GenerationRow, lease: LeaseRow): void {
    const current = this.buildCurrentGenerationDispatchAuthority(generation);
    const committed = parseCanonicalJson<RemoteWorkerAssignmentDispatchAuthority>(
      lease.parent_dispatch_authority_json,
      "remote worker assignment lease parent dispatch authority",
    );
    if (
      sha256Bytes(lease.parent_dispatch_authority_json) !== lease.parent_dispatch_authority_sha256 ||
      canonicalJsonString(committed) !== canonicalJsonString(current)
    ) {
      throw conflict("remote worker assignment lease parent dispatch authority");
    }
  }

  private assertWorkerIsCurrentAndAllowed(worker: WorkerAuthorityRow, manifest: RemoteWorkerAssignmentManifest): void {
    const current = this.db
      .prepare(
        `SELECT MAX(worker_generation) AS generation FROM remote_worker_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId`,
      )
      .get({ registryWorkspaceId: manifest.registryWorkspaceId, workerId: worker.worker_id }) as
      | { generation?: unknown }
      | undefined;
    if (asPositiveInteger(current?.generation) !== asPositiveInteger(worker.worker_generation)) {
      throw conflict("remote worker assignment current worker generation");
    }
    if (
      this.db
        .prepare(
          `SELECT 1 AS found FROM remote_worker_generation_controls
           WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
             AND worker_generation = @workerGeneration LIMIT 1`,
        )
        .get({
          registryWorkspaceId: manifest.registryWorkspaceId,
          workerId: worker.worker_id,
          workerGeneration: asPositiveInteger(worker.worker_generation),
        })
    ) {
      throw conflict("remote worker assignment controlled worker generation");
    }
    const bootstrap = this.db
      .prepare(
        `SELECT bootstrap_id FROM remote_worker_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration`,
      )
      .get({
        registryWorkspaceId: manifest.registryWorkspaceId,
        workerId: worker.worker_id,
        workerGeneration: asPositiveInteger(worker.worker_generation),
      }) as { bootstrap_id?: unknown } | undefined;
    if (typeof bootstrap?.bootstrap_id !== "string") throw invalidState();
    const scope = this.db
      .prepare(
        `SELECT 1 AS found FROM remote_worker_bootstrap_allowed_workspaces
         WHERE registry_workspace_id = @registryWorkspaceId AND bootstrap_id = @bootstrapId
           AND allowed_workspace_id = @executionWorkspaceId`,
      )
      .get({
        registryWorkspaceId: manifest.registryWorkspaceId,
        bootstrapId: bootstrap.bootstrap_id,
        executionWorkspaceId: manifest.executionWorkspaceId,
      });
    if (!scope) throw conflict("remote worker assignment execution workspace ceiling");
    const granted = new Set(
      (
        this.db
          .prepare(
            `SELECT capability_class FROM remote_worker_bootstrap_capability_classes
             WHERE registry_workspace_id = @registryWorkspaceId AND bootstrap_id = @bootstrapId`,
          )
          .all({ registryWorkspaceId: manifest.registryWorkspaceId, bootstrapId: bootstrap.bootstrap_id }) as Array<{
          capability_class?: unknown;
        }>
      ).map((row) => {
        if (typeof row.capability_class !== "string") throw invalidState();
        return row.capability_class;
      }),
    );
    if (!manifest.requiredCapabilityClasses.every((capability) => granted.has(capability))) {
      throw conflict("remote worker assignment capability ceiling");
    }
  }

  private assertNodeAdmissionCurrent(workspaceId: string, nodeId: string, admissionGeneration: number): void {
    const current = this.db
      .prepare(
        `SELECT MAX(admission_generation) AS generation FROM mesh_capability_node_admissions
         WHERE workspace_id = @workspaceId AND node_id = @nodeId`,
      )
      .get({ workspaceId, nodeId }) as { generation?: unknown } | undefined;
    if (asPositiveInteger(current?.generation) !== admissionGeneration) {
      throw conflict("remote worker assignment current node admission");
    }
    if (
      this.db
        .prepare(
          `SELECT 1 AS found FROM mesh_capability_node_admission_revocations
           WHERE workspace_id = @workspaceId AND node_id = @nodeId
             AND admission_generation = @admissionGeneration`,
        )
        .get({ workspaceId, nodeId, admissionGeneration })
    ) {
      throw conflict("remote worker assignment revoked node admission");
    }
  }

  private assertNoTerminalState(registryWorkspaceId: string, assignmentId: string, generation: number): void {
    if (
      this.findSettlement(registryWorkspaceId, assignmentId) ||
      this.findLatestControlRow(registryWorkspaceId, assignmentId, generation)
    ) {
      throw conflict("remote worker assignment terminal state");
    }
  }

  private authenticateCurrentLease(expectedRevision: number, tokenSha256: string, lease: LeaseRow): void {
    if (asPositiveInteger(lease.lease_revision) !== expectedRevision || !this.isTimestampFresh(lease.expires_at)) {
      throw conflict("remote worker assignment lease authority");
    }
    this.assertLeaseToken(lease, tokenSha256);
  }

  private assertLeaseToken(lease: LeaseRow, tokenSha256: string): void {
    if (lease.lease_token_sha256 !== digest(tokenSha256, "leaseTokenSha256")) {
      throw conflict("remote worker assignment lease token");
    }
  }

  private assertMaterializationSource(command: RecordRemoteWorkerAssignmentMaterializationCommand): void {
    const assignment = this.getAssignment(command.registryWorkspaceId, command.assignmentId);
    const current = this.getCurrentGenerationRow(command.registryWorkspaceId, command.assignmentId);
    if (asPositiveInteger(current.assignment_generation) !== command.sourceGeneration) {
      throw conflict("remote worker assignment stale materialization source");
    }
    if (
      this.findControlByAction(
        command.registryWorkspaceId,
        command.assignmentId,
        command.sourceGeneration,
        "generation_abandoned",
      ) ||
      this.findControlByAction(
        command.registryWorkspaceId,
        command.assignmentId,
        command.sourceGeneration,
        "recovery_exhausted",
      )
    ) {
      throw conflict("remote worker assignment abandoned materialization source");
    }
    if (command.sourceKind === "event") {
      if (
        assignment.manifest.sessionId === undefined ||
        command.targetOwnerSessionId !== assignment.manifest.sessionId ||
        command.targetOwnerTurnId !== assignment.manifest.turnId
      ) {
        throw conflict("remote worker assignment transcript materialization owner");
      }
      const event = this.getEventRow(
        command.registryWorkspaceId,
        command.assignmentId,
        command.sourceGeneration,
        command.sourceSequence!,
      );
      if (event.event_type !== "transcript_delta" || event.event_sha256 !== command.sourceSha256) {
        throw conflict("remote worker assignment transcript materialization source");
      }
      return;
    }
    if (command.targetOwnerDurableRunId !== assignment.manifest.durableRunId) {
      throw conflict("remote worker assignment durable materialization owner");
    }
    const settlement = this.getSettlementRow(command.registryWorkspaceId, command.assignmentId);
    if (
      asPositiveInteger(settlement.assignment_generation) !== command.sourceGeneration ||
      settlement.request_sha256 !== command.sourceSha256
    ) {
      throw conflict("remote worker assignment settlement materialization source");
    }
  }

  private insertLease(input: {
    registryWorkspaceId: string;
    assignmentId: string;
    assignmentGeneration: number;
    leaseRevision: number;
    leaseTokenSha256: string;
    workerSentThrough: number;
    serverAcknowledgedThrough: number;
    parentDispatchAuthority: RemoteWorkerAssignmentDispatchAuthority;
    heartbeatAt: string;
    expiresAt: string;
    idempotencyKey: string;
    requestSha256: string;
  }): void {
    const parentDispatchAuthorityJson = canonicalJsonString(input.parentDispatchAuthority);
    const { parentDispatchAuthority: _parentDispatchAuthority, ...leaseRow } = input;
    this.db
      .prepare(
        `INSERT INTO remote_worker_assignment_leases (
          registry_workspace_id, assignment_id, assignment_generation, lease_revision,
          lease_token_sha256, worker_sent_through, server_acknowledged_through,
          parent_dispatch_authority_json, parent_dispatch_authority_sha256,
          heartbeat_at, expires_at, idempotency_key, request_sha256
        ) VALUES (
          @registryWorkspaceId, @assignmentId, @assignmentGeneration, @leaseRevision,
          @leaseTokenSha256, @workerSentThrough, @serverAcknowledgedThrough,
          @parentDispatchAuthorityJson, @parentDispatchAuthoritySha256,
          @heartbeatAt, @expiresAt, @idempotencyKey, @requestSha256
        )`,
      )
      .run({
        ...leaseRow,
        parentDispatchAuthorityJson,
        parentDispatchAuthoritySha256: sha256Bytes(parentDispatchAuthorityJson),
      });
  }

  private insertControlRow(
    action: RemoteWorkerAssignmentControlAction,
    command: ControlRemoteWorkerAssignmentCommand,
    revision: number,
    requestSha256: string,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO remote_worker_assignment_controls (
          registry_workspace_id, assignment_id, assignment_generation, control_revision,
          action, expected_lease_revision, reason_code, reason_sha256, actor_id,
          idempotency_key, request_sha256, created_at
        ) VALUES (
          @registryWorkspaceId, @assignmentId, @assignmentGeneration, @controlRevision,
          @action, @expectedLeaseRevision, @reasonCode, @reasonSha256, @actorId,
          @idempotencyKey, @requestSha256, @createdAt
        )`,
      )
      .run({
        registryWorkspaceId: command.registryWorkspaceId,
        assignmentId: command.assignmentId,
        assignmentGeneration: command.expectedAssignmentGeneration,
        controlRevision: revision,
        action,
        expectedLeaseRevision: command.expectedLeaseRevision,
        reasonCode: command.reasonCode,
        reasonSha256: command.reasonSha256,
        actorId: command.actorId,
        idempotencyKey: command.idempotencyKey,
        requestSha256,
        createdAt,
      });
  }

  private getAssignmentRow(registryWorkspaceId: string, assignmentId: string): AssignmentRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_assignments
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId`,
      )
      .get({
        registryWorkspaceId: identifier(registryWorkspaceId, "registryWorkspaceId"),
        assignmentId: identifier(assignmentId, "assignmentId"),
      }) as AssignmentRow | undefined;
    if (!row) throw unavailable("remote worker assignment");
    return row;
  }

  private findAssignmentByIdempotency(registryWorkspaceId: string, idempotencyKey: string): AssignmentRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignments
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as AssignmentRow | undefined;
  }

  private getGenerationRow(registryWorkspaceId: string, assignmentId: string, generation: number): GenerationRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation }) as GenerationRow | undefined;
    if (!row) throw unavailable("remote worker assignment generation");
    return row;
  }

  private getCurrentGenerationRow(registryWorkspaceId: string, assignmentId: string): GenerationRow {
    const row = this.findCurrentGenerationRow(registryWorkspaceId, assignmentId);
    if (!row) throw unavailable("remote worker assignment generation");
    return row;
  }

  private findCurrentGenerationRow(registryWorkspaceId: string, assignmentId: string): GenerationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
         ORDER BY assignment_generation DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, assignmentId }) as GenerationRow | undefined;
  }

  private findGenerationByIdempotency(registryWorkspaceId: string, idempotencyKey: string): GenerationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as GenerationRow | undefined;
  }

  private nextAssignmentGeneration(registryWorkspaceId: string, assignmentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(assignment_generation), 0) AS generation
         FROM remote_worker_assignment_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId`,
      )
      .get({ registryWorkspaceId, assignmentId }) as { generation?: unknown } | undefined;
    return asNonNegativeInteger(row?.generation) + 1;
  }

  private getLeaseRow(
    registryWorkspaceId: string,
    assignmentId: string,
    generation: number,
    revision: number,
  ): LeaseRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_leases
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND lease_revision = @leaseRevision`,
      )
      .get({
        registryWorkspaceId,
        assignmentId,
        assignmentGeneration: generation,
        leaseRevision: revision,
      }) as LeaseRow | undefined;
    if (!row) throw unavailable("remote worker assignment lease");
    return row;
  }

  private getCurrentLeaseRow(registryWorkspaceId: string, assignmentId: string, generation: number): LeaseRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_leases
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration
         ORDER BY lease_revision DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation }) as LeaseRow | undefined;
    if (!row) throw unavailable("remote worker assignment lease");
    return row;
  }

  private findLeaseByIdempotency(registryWorkspaceId: string, idempotencyKey: string): LeaseRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_leases
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as LeaseRow | undefined;
  }

  private findLeaseByTokenHash(tokenSha256: string): LeaseRow | undefined {
    return this.db
      .prepare(`SELECT * FROM remote_worker_assignment_leases WHERE lease_token_sha256 = @tokenSha256`)
      .get({ tokenSha256 }) as LeaseRow | undefined;
  }

  private getControlRow(
    registryWorkspaceId: string,
    assignmentId: string,
    generation: number,
    revision: number,
  ): ControlRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND control_revision = @controlRevision`,
      )
      .get({
        registryWorkspaceId,
        assignmentId,
        assignmentGeneration: generation,
        controlRevision: revision,
      }) as ControlRow | undefined;
    if (!row) throw invalidState();
    return row;
  }

  private findLatestControlRow(
    registryWorkspaceId: string,
    assignmentId: string,
    generation: number,
  ): ControlRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration
         ORDER BY control_revision DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation }) as ControlRow | undefined;
  }

  private findControlByIdempotency(registryWorkspaceId: string, idempotencyKey: string): ControlRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as ControlRow | undefined;
  }

  private findControlByAction(
    registryWorkspaceId: string,
    assignmentId: string,
    generation: number,
    action: RemoteWorkerAssignmentControlAction,
  ): ControlRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND action = @action`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation, action }) as ControlRow | undefined;
  }

  private findControlByRequestHash(
    registryWorkspaceId: string,
    assignmentId: string,
    generation: number,
    requestSha256: string,
  ): ControlRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND request_sha256 = @requestSha256`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation, requestSha256 }) as
      | ControlRow
      | undefined;
  }

  private findEventRow(
    registryWorkspaceId: string,
    assignmentId: string,
    generation: number,
    sequence: number,
  ): EventRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_events
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND sequence = @sequence`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation, sequence }) as EventRow | undefined;
  }

  private getEventRow(
    registryWorkspaceId: string,
    assignmentId: string,
    generation: number,
    sequence: number,
  ): EventRow {
    const row = this.findEventRow(registryWorkspaceId, assignmentId, generation, sequence);
    if (!row) throw unavailable("remote worker assignment event");
    return row;
  }

  private currentAcknowledgedThrough(registryWorkspaceId: string, assignmentId: string, generation: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence FROM remote_worker_assignment_events
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation }) as
      | { sequence?: unknown }
      | undefined;
    return asNonNegativeInteger(row?.sequence);
  }

  private currentWorkerSentThrough(registryWorkspaceId: string, assignmentId: string, generation: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(worker_sent_through), 0) AS worker_sent_through
         FROM (
           SELECT worker_sent_through FROM remote_worker_assignment_leases
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
           UNION ALL
           SELECT worker_sent_through FROM remote_worker_assignment_events
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
         ) sent_watermarks`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation }) as
      | { worker_sent_through?: unknown }
      | undefined;
    return asNonNegativeInteger(row?.worker_sent_through);
  }

  private currentEventHash(registryWorkspaceId: string, assignmentId: string, generation: number): string {
    const row = this.db
      .prepare(
        `SELECT event_sha256 FROM remote_worker_assignment_events
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration ORDER BY sequence DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration: generation }) as
      | { event_sha256?: unknown }
      | undefined;
    if (row === undefined) return REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256;
    if (typeof row.event_sha256 !== "string") throw invalidState();
    return digest(row.event_sha256, "eventSha256");
  }

  private findSettlement(registryWorkspaceId: string, assignmentId: string): SettlementRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_settlements
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId`,
      )
      .get({ registryWorkspaceId, assignmentId }) as SettlementRow | undefined;
  }

  private getSettlementRow(registryWorkspaceId: string, assignmentId: string): SettlementRow {
    const row = this.findSettlement(registryWorkspaceId, assignmentId);
    if (!row) throw unavailable("remote worker assignment settlement");
    return row;
  }

  private findSettlementByIdempotency(registryWorkspaceId: string, idempotencyKey: string): SettlementRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_settlements
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as SettlementRow | undefined;
  }

  private findMaterializationByIdempotency(
    registryWorkspaceId: string,
    idempotencyKey: string,
  ): MaterializationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_materializations
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as MaterializationRow | undefined;
  }

  private getMaterializationRow(
    registryWorkspaceId: string,
    assignmentId: string,
    materializationId: string,
  ): MaterializationRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_materializations
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND materialization_id = @materializationId`,
      )
      .get({ registryWorkspaceId, assignmentId, materializationId }) as MaterializationRow | undefined;
    if (!row) throw invalidState();
    return row;
  }

  private getWorkerAuthorityRow(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number,
  ): WorkerAuthorityRow {
    const row = this.db
      .prepare(
        `SELECT worker_id, node_id, worker_generation, runtime_manifest_sha256,
                workspace_ceiling_sha256, capability_ceiling_sha256
         FROM remote_worker_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration`,
      )
      .get({ registryWorkspaceId, workerId, workerGeneration }) as WorkerAuthorityRow | undefined;
    if (!row) throw unavailable("remote worker generation");
    return row;
  }

  private getDurableAuthorityRow(runId: string, forUpdate: boolean): DurableAuthorityRow {
    const suffix = forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : "";
    const row = this.db
      .prepare(
        `SELECT run_id, status, attempt_count, lease_owner_id, lease_expires_at, version, metadata_json
         FROM durable_runs WHERE run_id = @runId${suffix}`,
      )
      .get({ runId }) as DurableAuthorityRow | undefined;
    if (!row) throw unavailable("durable run");
    return row;
  }

  private mapAssignment(row: AssignmentRow): RemoteWorkerAssignmentRecord {
    try {
      const manifest = parseCanonicalJson<RemoteWorkerAssignmentManifest>(
        row.manifest_json,
        "remote worker assignment manifest",
      );
      if (
        remoteWorkerAssignmentManifestSha256(manifest) !== row.manifest_sha256 ||
        manifest.registryWorkspaceId !== row.registry_workspace_id ||
        manifest.executionWorkspaceId !== row.execution_workspace_id ||
        manifest.durableRunId !== row.durable_run_id ||
        manifest.taskId !== row.task_id ||
        (manifest.sessionId ?? null) !== row.session_id ||
        (manifest.turnId ?? null) !== row.turn_id
      ) {
        throw new Error();
      }
      const record: RemoteWorkerAssignmentRecord = {
        registryWorkspaceId: row.registry_workspace_id,
        assignmentId: row.assignment_id,
        manifest,
        manifestSha256: row.manifest_sha256,
        createdByActorId: row.created_by_actor_id,
        idempotencyKey: row.idempotency_key,
        requestSha256: row.request_sha256,
        createdAt: row.created_at,
      };
      assertRemoteWorkerAssignmentRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private mapGeneration(row: GenerationRow): RemoteWorkerAssignmentGenerationRecord {
    try {
      const dispatchAuthority = parseCanonicalJson<RemoteWorkerAssignmentDispatchAuthority>(
        row.dispatch_authority_json,
        "remote worker assignment dispatch authority",
      );
      const record: RemoteWorkerAssignmentGenerationRecord = {
        registryWorkspaceId: row.registry_workspace_id,
        assignmentId: row.assignment_id,
        assignmentGeneration: asPositiveInteger(row.assignment_generation),
        executionWorkspaceId: row.execution_workspace_id,
        workerId: row.worker_id,
        workerGeneration: asPositiveInteger(row.worker_generation),
        nodeId: row.node_id,
        nodeAdmissionGeneration: asPositiveInteger(row.node_admission_generation),
        runtimeManifestSha256: row.runtime_manifest_sha256,
        workspaceCeilingSha256: row.workspace_ceiling_sha256,
        capabilityCeilingSha256: row.capability_ceiling_sha256,
        dispatchAuthority,
        dispatchAuthoritySha256: row.dispatch_authority_sha256,
        idempotencyKey: row.idempotency_key,
        requestSha256: row.request_sha256,
        startedAt: row.started_at,
      };
      assertRemoteWorkerAssignmentGenerationRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private mapLease(row: LeaseRow): RemoteWorkerAssignmentLeaseRecord {
    try {
      digest(row.lease_token_sha256, "leaseTokenSha256");
      const parentDispatchAuthority = parseCanonicalJson<RemoteWorkerAssignmentDispatchAuthority>(
        row.parent_dispatch_authority_json,
        "remote worker assignment lease parent dispatch authority",
      );
      const record: RemoteWorkerAssignmentLeaseRecord = {
        registryWorkspaceId: row.registry_workspace_id,
        assignmentId: row.assignment_id,
        assignmentGeneration: asPositiveInteger(row.assignment_generation),
        leaseRevision: asPositiveInteger(row.lease_revision),
        workerSentThrough: asNonNegativeInteger(row.worker_sent_through),
        serverAcknowledgedThrough: asNonNegativeInteger(row.server_acknowledged_through),
        parentDispatchAuthority,
        parentDispatchAuthoritySha256: row.parent_dispatch_authority_sha256,
        heartbeatAt: row.heartbeat_at,
        expiresAt: row.expires_at,
        idempotencyKey: row.idempotency_key,
        requestSha256: row.request_sha256,
      };
      assertRemoteWorkerAssignmentLeaseRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private mapControl(row: ControlRow): RemoteWorkerAssignmentControlRecord {
    try {
      const record: RemoteWorkerAssignmentControlRecord = {
        registryWorkspaceId: row.registry_workspace_id,
        assignmentId: row.assignment_id,
        expectedAssignmentGeneration: asPositiveInteger(row.assignment_generation),
        expectedLeaseRevision: asPositiveInteger(row.expected_lease_revision),
        reasonCode: row.reason_code,
        reasonSha256: row.reason_sha256,
        actorId: row.actor_id,
        idempotencyKey: row.idempotency_key,
        controlRevision: asPositiveInteger(row.control_revision),
        action: row.action as RemoteWorkerAssignmentControlAction,
        requestSha256: row.request_sha256,
        createdAt: row.created_at,
      };
      assertRemoteWorkerAssignmentControlRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private mapEvent(row: EventRow): RemoteWorkerAssignmentEventRecord {
    try {
      const record: RemoteWorkerAssignmentEventRecord = {
        registryWorkspaceId: row.registry_workspace_id,
        assignmentId: row.assignment_id,
        assignmentGeneration: asPositiveInteger(row.assignment_generation),
        sequence: asPositiveInteger(row.sequence),
        eventId: row.event_id,
        eventType: row.event_type as RemoteWorkerAssignmentEventRecord["eventType"],
        payload: parseCanonicalJson<RemoteWorkerAssignmentEventRecord["payload"]>(
          row.payload_json,
          "remote worker assignment event payload",
        ),
        payloadSha256: row.payload_sha256,
        previousEventSha256: row.previous_event_sha256,
        eventSha256: row.event_sha256,
        workerSentThrough: asPositiveInteger(row.worker_sent_through),
        receivedAt: row.received_at,
      };
      assertRemoteWorkerAssignmentEventRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private mapSettlement(row: SettlementRow): RemoteWorkerAssignmentSettlementRecord {
    try {
      const record: RemoteWorkerAssignmentSettlementRecord = {
        schemaVersion: row.schema_version as typeof REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION,
        registryWorkspaceId: row.registry_workspace_id,
        assignmentId: row.assignment_id,
        assignmentGeneration: asPositiveInteger(row.assignment_generation),
        outcome: row.outcome as RemoteWorkerAssignmentSettlementRecord["outcome"],
        origin: row.origin as RemoteWorkerAssignmentSettlementRecord["origin"],
        ...(row.gateway_actor_id ? { gatewayActorId: row.gateway_actor_id } : {}),
        ...(row.recovery_evidence_sha256 ? { recoveryEvidenceSha256: row.recovery_evidence_sha256 } : {}),
        finalEventSequence: asNonNegativeInteger(row.final_event_sequence),
        finalEventSha256: row.final_event_sha256,
        ...(row.result_sha256 ? { resultSha256: row.result_sha256 } : {}),
        ...(row.output_manifest_sha256 ? { outputManifestSha256: row.output_manifest_sha256 } : {}),
        ...(row.failure_sha256 ? { failureSha256: row.failure_sha256 } : {}),
        idempotencyKey: row.idempotency_key,
        requestSha256: row.request_sha256,
        settledAt: row.settled_at,
      };
      assertRemoteWorkerAssignmentSettlementRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private mapMaterialization(row: MaterializationRow): RemoteWorkerAssignmentMaterializationRecord {
    try {
      const common = {
        schemaVersion: row.schema_version as typeof REMOTE_WORKER_ASSIGNMENT_MATERIALIZATION_SCHEMA_VERSION,
        materializationId: row.materialization_id,
        registryWorkspaceId: row.registry_workspace_id,
        assignmentId: row.assignment_id,
        sourceGeneration: asPositiveInteger(row.source_generation),
        sourceSha256: row.source_sha256,
        targetId: row.target_id,
        targetSha256: row.target_sha256,
        receiptSha256: row.receipt_sha256,
        gatewayActorId: row.gateway_actor_id,
        idempotencyKey: row.idempotency_key,
        requestSha256: row.request_sha256,
        materializedAt: row.materialized_at,
      };
      const record: RemoteWorkerAssignmentMaterializationRecord =
        row.source_kind === "event"
          ? {
              ...common,
              sourceKind: "event",
              sourceSequence: asPositiveInteger(row.source_sequence),
              targetKind: "chat_transcript",
              targetOwnerSessionId: row.target_owner_session_id ?? "",
              targetOwnerTurnId: row.target_owner_turn_id ?? "",
            }
          : row.source_kind === "settlement"
            ? {
                ...common,
                sourceKind: "settlement",
                targetKind: "durable_run_result",
                targetOwnerDurableRunId: row.target_owner_durable_run_id ?? "",
              }
            : (() => {
                throw invalidState();
              })();
      assertRemoteWorkerAssignmentMaterializationRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private assignmentLeaseClock(
    manifest: RemoteWorkerAssignmentManifest,
    parentDispatchAuthority: RemoteWorkerAssignmentDispatchAuthority,
  ): { now: string; expiresAt: string } {
    const clock = this.databaseClockWithTtl(manifest.leaseTtlSeconds);
    const expiresAt = [
      clock.expiresAt,
      manifest.deadlineAt,
      parentDispatchAuthority.durableRunLeaseExpiresAt,
    ].sort()[0]!;
    if (expiresAt <= clock.now) {
      throw conflict("remote worker assignment lease has no live parent-authorized interval");
    }
    return { now: clock.now, expiresAt };
  }

  private databaseNow(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get() as { now?: unknown } | undefined;
    if (typeof row?.now !== "string") throw invalidState();
    return row.now;
  }

  private databaseClockWithTtl(seconds: number): { now: string; expiresAt: string } {
    const sql =
      this.db.dialect === "postgres"
        ? `WITH captured AS (SELECT clock_timestamp() AS now)
           SELECT to_char(captured.now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
             to_char((captured.now + (@seconds * interval '1 second')) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at FROM captured`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', @seconds)) AS expires_at`;
    const row = this.db.prepare(sql).get({ seconds }) as { now?: unknown; expires_at?: unknown } | undefined;
    if (typeof row?.now !== "string" || typeof row.expires_at !== "string") throw invalidState();
    return { now: row.now, expiresAt: row.expires_at };
  }

  private isTimestampFuture(value: string): boolean {
    return this.isTimestampWithPredicate(value, this.freshTimestampPredicate("@value"));
  }

  private isTimestampFresh(value: string): boolean {
    return this.isTimestampWithPredicate(value, this.freshTimestampPredicate("@value"));
  }

  private isTimestampWithPredicate(value: string, predicate: string): boolean {
    const row = this.db.prepare(`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS valid`).get({ value }) as
      | { valid?: unknown }
      | undefined;
    return Number(row?.valid) === 1;
  }

  private freshTimestampPredicate(expression: string): string {
    return this.db.dialect === "postgres"
      ? `gc_try_parse_timestamptz(${expression}) IS NOT NULL
         AND to_char(gc_try_parse_timestamptz(${expression}) AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = ${expression}
         AND gc_try_parse_timestamptz(${expression}) > clock_timestamp()`
      : `strftime('%Y-%m-%dT%H:%M:%fZ', ${expression}, '+0 days') IS NOT NULL
         AND strftime('%Y-%m-%dT%H:%M:%fZ', ${expression}, '+0 days') = ${expression}
         AND ${expression} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  }

  private expiredTimestampPredicate(expression: string): string {
    return this.db.dialect === "postgres"
      ? `gc_try_parse_timestamptz(${expression}) IS NOT NULL
         AND gc_try_parse_timestamptz(${expression}) <= clock_timestamp()`
      : `strftime('%Y-%m-%dT%H:%M:%fZ', ${expression}, '+0 days') IS NOT NULL
         AND ${expression} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  }

  private acquirePostgresRootLocks(registryWorkspaceId: string, assignmentId: string): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId, 501)) AS locked")
      .get({ registryWorkspaceId });
    this.db
      .prepare(
        "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @assignmentId, 503)) AS locked",
      )
      .get({ registryWorkspaceId, assignmentId });
  }

  private acquirePostgresGenerationLocks(
    executionWorkspaceId: string,
    nodeId: string,
    registryWorkspaceId: string,
    workerId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@executionWorkspaceId, 411)) AS locked")
      .get({ executionWorkspaceId });
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@executionWorkspaceId || ':' || @nodeId, 412)) AS locked")
      .get({ executionWorkspaceId, nodeId });
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId, 501)) AS locked")
      .get({ registryWorkspaceId });
    this.db
      .prepare(
        "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @workerId, 502)) AS locked",
      )
      .get({ registryWorkspaceId, workerId });
    this.db
      .prepare(
        "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @assignmentId, 503)) AS locked",
      )
      .get({ registryWorkspaceId, assignmentId });
    this.db
      .prepare(
        `SELECT pg_advisory_xact_lock(hashtextextended(
          @registryWorkspaceId || ':' || @assignmentId || ':' || CAST(@assignmentGeneration AS TEXT), 504
        )) AS locked`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration });
  }

  private acquirePostgresRecoveryLocks(
    assignment: RemoteWorkerAssignmentRecord,
    oldGeneration: GenerationRow,
    command: RecoverRemoteWorkerAssignmentCommand,
  ): void {
    if (this.db.dialect !== "postgres") return;
    const nodes = [...new Set([oldGeneration.node_id, command.nodeId])].sort();
    const workers = [...new Set([oldGeneration.worker_id, command.workerId])].sort();
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@executionWorkspaceId, 411)) AS locked")
      .get({ executionWorkspaceId: assignment.manifest.executionWorkspaceId });
    for (const nodeId of nodes) {
      this.db
        .prepare(
          "SELECT pg_advisory_xact_lock(hashtextextended(@executionWorkspaceId || ':' || @nodeId, 412)) AS locked",
        )
        .get({ executionWorkspaceId: assignment.manifest.executionWorkspaceId, nodeId });
    }
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId, 501)) AS locked")
      .get({ registryWorkspaceId: command.registryWorkspaceId });
    for (const workerId of workers) {
      this.db
        .prepare(
          "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @workerId, 502)) AS locked",
        )
        .get({ registryWorkspaceId: command.registryWorkspaceId, workerId });
    }
    this.db
      .prepare(
        "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @assignmentId, 503)) AS locked",
      )
      .get({ registryWorkspaceId: command.registryWorkspaceId, assignmentId: command.assignmentId });
    for (const assignmentGeneration of [
      command.expectedAssignmentGeneration,
      command.expectedAssignmentGeneration + 1,
    ]) {
      this.db
        .prepare(
          `SELECT pg_advisory_xact_lock(hashtextextended(
            @registryWorkspaceId || ':' || @assignmentId || ':' || CAST(@assignmentGeneration AS TEXT), 504
          )) AS locked`,
        )
        .get({
          registryWorkspaceId: command.registryWorkspaceId,
          assignmentId: command.assignmentId,
          assignmentGeneration,
        });
    }
  }
}

function deriveServerId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${sha256(parts).slice(0, 48)}`;
}

function sha256(value: unknown): string {
  return sha256Bytes(canonicalJsonString(value));
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCanonicalJson<T>(value: string, label: string): T {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (parsed === undefined || canonicalJsonString(parsed) !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed as T;
}

function assertExactReplay(storedSha256: string, requestSha256: string, label: string): void {
  if (storedSha256 !== requestSha256) throw conflict(label);
}

function identifier(value: string, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ field, message: `Remote worker assignment ${field} is invalid.` });
  }
  return value;
}

function digest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ValidationError({
      field,
      message: `Remote worker assignment ${field} must be a lower-case SHA-256 digest.`,
    });
  }
  return value;
}

function positiveInteger(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ValidationError({ field, message: `Remote worker assignment ${field} is invalid.` });
  }
  return value;
}

function nonNegativeInteger(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ValidationError({ field, message: `Remote worker assignment ${field} is invalid.` });
  }
  return value;
}

function asPositiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalidState();
  return parsed;
}

function asNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidState();
  return parsed;
}

function unavailable(entity: string): NotFoundError {
  return new NotFoundError({ entity, id: "unavailable" });
}

function conflict(label: string): ConflictError {
  return new ConflictError({
    code: "STATE_CONFLICT",
    message: `${label} conflicts with durable assignment authority.`,
    details: { reason: "remote_worker_assignment_conflict" },
  });
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ConflictError)
    return error;
  return conflict(label);
}

function invalidState(): Error {
  return new Error("Remote worker assignment state is invalid.");
}
