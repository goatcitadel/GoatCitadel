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
  normalizeRemoteWorkerMeshNodeAuthorityFence,
  normalizeRecordRemoteWorkerAssignmentMaterializationCommand,
  normalizeRecoverRemoteWorkerAssignmentCommand,
  readDurableChatTurnExecutionPayloadAuthority,
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
  type RemoteWorkerMeshNodeAuthorityFence,
  type RenewRemoteWorkerAssignmentLeaseCommand,
  type ResolvedRemoteWorkerAssignmentAuthority,
  type SettleRemoteWorkerAssignmentCommand,
  type StartRemoteWorkerAssignmentGenerationCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ChatTurnCapabilityProfileRepository } from "./chat-turn-capability-profile-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerMeshNodeAdmissionRepository } from "./remote-worker-mesh-node-admission-repo.js";
import { buildRemoteWorkerTaskBoundDispatchLockPlan } from "./remote-worker-dispatch-lock-order.js";
import { safeJsonParse } from "./safe-json.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";

export const REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-workload.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_WORKLOAD_MAX_BYTES = 512 * 1024;

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

export interface ResolveRemoteWorkerAssignmentControlReadInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly leaseTokenSha256: string;
}

export type ResolvedRemoteWorkerAssignmentControlReadAuthority =
  | Readonly<{
      disposition: "active";
      assignment: RemoteWorkerAssignmentRecord;
      generation: RemoteWorkerAssignmentGenerationRecord;
      lease: RemoteWorkerAssignmentLeaseRecord;
    }>
  | Readonly<{
      disposition: "cancel_requested";
      assignment: RemoteWorkerAssignmentRecord;
      generation: RemoteWorkerAssignmentGenerationRecord;
      lease: RemoteWorkerAssignmentLeaseRecord;
      control: RemoteWorkerAssignmentControlRecord;
    }>;

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

/**
 * HX-507B operator read projection. Aggregates one assignment's current
 * generation, lease, latest control, settlement, and a bounded materialization
 * summary. All fields are canonical storage truth; the Gateway service layer is
 * responsible for redacting secrets and attaching truth descriptors. Optional
 * sections are absent (never guessed) when the underlying owner has no row.
 */
export interface RemoteWorkerAssignmentMaterializationSummary {
  count: number;
  chatTranscriptCount: number;
  durableRunResultCount: number;
  latestMaterializedAt?: string;
}

export interface RemoteWorkerAssignmentAggregate {
  assignment: RemoteWorkerAssignmentRecord;
  generation?: RemoteWorkerAssignmentGenerationRecord;
  lease?: RemoteWorkerAssignmentLeaseRecord;
  control?: RemoteWorkerAssignmentControlRecord;
  settlement?: RemoteWorkerAssignmentSettlementRecord;
  materialization: RemoteWorkerAssignmentMaterializationSummary;
}

export interface RemoteWorkerAssignmentAggregateCursor {
  lastCreatedAt: string;
  lastAssignmentId: string;
}

export interface ListRemoteWorkerAssignmentAggregatesOptions {
  workerId?: string;
  sessionId?: string;
  turnId?: string;
  limit?: number;
  cursor?: RemoteWorkerAssignmentAggregateCursor;
}

export interface ListRemoteWorkerAssignmentAggregatesResult {
  items: readonly RemoteWorkerAssignmentAggregate[];
  nextCursor?: RemoteWorkerAssignmentAggregateCursor;
}

/** Exact protected M2 identity that the assignment owner rechecks at commit. */
export interface RemoteWorkerAssignmentClaimAuthority {
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly authorizationCredentialSha256: string;
  readonly nodeId: string;
  readonly clientCertificateSha256: string;
  readonly runtimeManifestSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly protectedAdmissionEnvelopeSha256: string;
  readonly protectedAdmissionContextSha256: string;
  readonly claimsSha256: string;
}

/**
 * Exact M2 credential/protected-admission authority joined to the one current
 * M3 execution-workspace admission. Protected assignment RPC owners pass this
 * advisory snapshot back to storage so the assignment transaction can compare
 * it under the canonical worker/node/assignment locks before any replay, read,
 * or mutation is observed.
 */
export interface RemoteWorkerAssignmentProtectedCommitFence {
  readonly credentialAuthority: RemoteWorkerAssignmentClaimAuthority;
  readonly meshAdmission: RemoteWorkerMeshNodeAuthorityFence;
}

export interface RemoteWorkerAssignmentOfferCursor {
  readonly createdAt: string;
  readonly assignmentId: string;
}

export interface RemoteWorkerAssignmentWorkloadIdentity {
  readonly schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentManifestSha256: string;
  readonly durableRunId: string;
  readonly durableRunVersion: number;
  readonly durableRunPayloadSha256: string;
  readonly capabilityProfileId: string;
  readonly capabilityProfileSha256: string;
  readonly contextSnapshotSha256: string;
  readonly workloadSha256: string;
}

export interface RemoteWorkerAssignmentWorkloadProjection extends RemoteWorkerAssignmentWorkloadIdentity {
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RemoteWorkerAssignmentOffer {
  readonly assignment: RemoteWorkerAssignmentRecord;
  readonly workload: RemoteWorkerAssignmentWorkloadIdentity;
}

export type RemoteWorkerAssignmentOfferResolutionPurpose =
  | Readonly<{ readonly kind: "poll" }>
  | Readonly<{ readonly kind: "claim" }>
  | Readonly<{
      readonly kind: "workload";
      readonly expectedAssignmentGeneration: number;
      readonly expectedLeaseRevision: number;
    }>;

export interface ResolveRemoteWorkerAssignmentOfferInput {
  readonly authority: RemoteWorkerAssignmentClaimAuthority;
  readonly meshAdmission: RemoteWorkerMeshNodeAuthorityFence;
  readonly assignmentId: string;
  readonly purpose: RemoteWorkerAssignmentOfferResolutionPurpose;
}

export interface ListRemoteWorkerAssignmentOffersInput {
  readonly authority: RemoteWorkerAssignmentClaimAuthority;
  readonly limit?: number;
  readonly cursor?: RemoteWorkerAssignmentOfferCursor;
}

export interface ListRemoteWorkerAssignmentOffersResult {
  readonly items: readonly RemoteWorkerAssignmentOffer[];
  readonly nextCursor?: RemoteWorkerAssignmentOfferCursor;
}

export interface ClaimRemoteWorkerAssignmentOfferInput {
  readonly authority: RemoteWorkerAssignmentClaimAuthority;
  readonly meshAdmission: RemoteWorkerMeshNodeAuthorityFence;
  readonly assignmentId: string;
  readonly leaseTokenSha256: string;
  readonly idempotencyKey: string;
}

export interface ClaimRemoteWorkerAssignmentOfferOutcome {
  readonly disposition: StartRemoteWorkerAssignmentGenerationOutcome["disposition"];
  readonly assignment: RemoteWorkerAssignmentRecord;
  readonly generation: RemoteWorkerAssignmentGenerationRecord;
  readonly lease: RemoteWorkerAssignmentLeaseRecord;
  readonly workload: RemoteWorkerAssignmentWorkloadProjection;
}

export interface ResolveRemoteWorkerAssignmentWorkloadInput {
  readonly authority: RemoteWorkerAssignmentClaimAuthority;
  readonly meshAdmission: RemoteWorkerMeshNodeAuthorityFence;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  readonly leaseTokenSha256: string;
}

interface AssignmentListRow extends AssignmentRow {
  current_assignment_generation: number | bigint | string | null;
  current_worker_id: string | null;
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
  workflow_key: string;
  status: string;
  attempt_count: number | bigint | string;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  version: number | bigint | string;
  payload_json: string;
  metadata_json: string | null;
}

interface TaskBoundDispatchLockContext {
  readonly assignmentManifestSha256: string;
  readonly sessionId: string;
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

  /**
   * Advisory, cursor-bounded offer polling. Only immutable task-bound durable
   * Chat assignments without a generation are returned. M3 admission is
   * intentionally resolved by the Gateway service because it is
   * workspace-specific; claim compares that exact fence atomically.
   */
  public listTaskBoundChatOffers(input: ListRemoteWorkerAssignmentOffersInput): ListRemoteWorkerAssignmentOffersResult {
    const authority = normalizeClaimAuthority(input.authority);
    const limit = input.limit === undefined ? 25 : positiveInteger(input.limit, "limit", 100);
    const cursor = input.cursor
      ? {
          createdAt: canonicalTimestamp(input.cursor.createdAt, "cursor.createdAt"),
          assignmentId: identifier(input.cursor.assignmentId, "cursor.assignmentId"),
        }
      : undefined;
    return this.db.transaction("immediate", () => {
      const worker = this.assertClaimAuthorityCurrent(authority);
      const rows = this.db
        .prepare(
          `SELECT assignment.* FROM remote_worker_assignments assignment
           WHERE assignment.registry_workspace_id = @registryWorkspaceId
             AND NOT EXISTS (
               SELECT 1 FROM remote_worker_assignment_generations generation
               WHERE generation.registry_workspace_id = assignment.registry_workspace_id
                 AND generation.assignment_id = assignment.assignment_id
             )
             AND (
               @cursorCreatedAt IS NULL OR assignment.created_at > @cursorCreatedAt
               OR (assignment.created_at = @cursorCreatedAt AND assignment.assignment_id > @cursorAssignmentId)
             )
           ORDER BY assignment.created_at ASC, assignment.assignment_id ASC
           LIMIT @limit`,
        )
        .all<AssignmentRow>({
          registryWorkspaceId: authority.registryWorkspaceId,
          cursorCreatedAt: cursor?.createdAt ?? null,
          cursorAssignmentId: cursor?.assignmentId ?? "",
          limit,
        });
      const items: RemoteWorkerAssignmentOffer[] = [];
      for (const row of rows) {
        try {
          const assignment = this.mapAssignment(row);
          this.assertTaskBoundOfferAuthority(assignment, worker);
          const workload = this.buildTaskBoundChatWorkload(assignment);
          items.push(Object.freeze({ assignment, workload: workloadIdentity(workload) }));
        } catch (error) {
          if (!(error instanceof ConflictError) && !(error instanceof NotFoundError)) throw error;
        }
      }
      const last = rows.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rows.length === limit && last
          ? {
              nextCursor: Object.freeze({
                createdAt: last.created_at,
                assignmentId: last.assignment_id,
              }),
            }
          : {}),
      });
    });
  }

  /** Resolve the immutable claim context, including exact replay attempts. */
  public findTaskBoundChatClaimContext(
    authorityInput: RemoteWorkerAssignmentClaimAuthority,
    assignmentIdInput: string,
  ): RemoteWorkerAssignmentOffer | undefined {
    const authority = normalizeClaimAuthority(authorityInput);
    const assignmentId = identifier(assignmentIdInput, "assignmentId");
    return this.db.transaction("immediate", () => {
      const worker = this.assertClaimAuthorityCurrent(authority);
      let assignment: RemoteWorkerAssignmentRecord;
      try {
        assignment = this.getAssignment(authority.registryWorkspaceId, assignmentId);
        this.assertTaskBoundOfferAuthority(assignment, worker);
      } catch (error) {
        if (error instanceof ConflictError || error instanceof NotFoundError) return undefined;
        throw error;
      }
      const generation = this.findCurrentGenerationRow(authority.registryWorkspaceId, assignmentId);
      if (
        generation &&
        (generation.worker_id !== authority.workerId ||
          asPositiveInteger(generation.worker_generation) !== authority.workerGeneration)
      ) {
        return undefined;
      }
      const workload = this.buildTaskBoundChatWorkload(assignment);
      return Object.freeze({ assignment, workload: workloadIdentity(workload) });
    });
  }

  /**
   * Resolve one advisory offer under the complete M2 credential/protected and
   * workspace-specific M3 mesh fence. Polls require an unclaimed assignment;
   * claim replay may observe only this exact worker generation; workload reads
   * additionally bind the current generation and lease revision. The complete
   * authority is re-read after the canonical dispatch lock plan and before the
   * offer identity is returned.
   */
  public resolveTaskBoundChatOffer(
    input: ResolveRemoteWorkerAssignmentOfferInput,
  ): RemoteWorkerAssignmentOffer | undefined {
    const authority = normalizeClaimAuthority(input.authority);
    const meshAdmission = normalizeRemoteWorkerMeshNodeAuthorityFence(input.meshAdmission);
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const purpose = normalizeOfferResolutionPurpose(input.purpose);
    return this.db.transaction("immediate", () => {
      let assignmentHint: RemoteWorkerAssignmentRecord;
      try {
        assignmentHint = this.getAssignment(authority.registryWorkspaceId, assignmentId);
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
      const lockContext = this.readTaskBoundDispatchLockContext(assignmentHint);
      const lockGeneration = purpose.kind === "workload" ? purpose.expectedAssignmentGeneration : 1;
      this.acquirePostgresTaskBoundDispatchLocks(authority, assignmentHint, lockGeneration, lockContext.sessionId);
      const assignment = this.getAssignment(authority.registryWorkspaceId, assignmentId);
      this.assertTaskBoundDispatchLockContext(assignment, lockContext);
      const worker = this.assertClaimAuthorityCurrent(authority);
      this.assertTaskBoundOfferAuthority(assignment, worker);
      this.assertMeshAdmissionAuthority(authority, assignment, meshAdmission);
      const run = this.getDurableAuthorityRow(assignment.manifest.durableRunId, true);
      if (
        run.status !== "running" ||
        !run.lease_owner_id ||
        !run.lease_expires_at ||
        !this.isTimestampFresh(run.lease_expires_at)
      ) {
        return undefined;
      }
      const workload = this.buildTaskBoundChatWorkload(assignment, run, lockContext.sessionId);
      const generation = this.findCurrentGenerationRow(authority.registryWorkspaceId, assignmentId);
      if (purpose.kind === "poll") {
        if (generation !== undefined) return undefined;
      } else if (generation !== undefined) {
        if (
          generation.worker_id !== authority.workerId ||
          asPositiveInteger(generation.worker_generation) !== authority.workerGeneration ||
          (purpose.kind === "claim" && asPositiveInteger(generation.assignment_generation) !== 1)
        ) {
          return undefined;
        }
        this.assertProtectedCommitFenceCurrent(
          Object.freeze({ credentialAuthority: authority, meshAdmission }),
          assignment,
          generation,
        );
        if (purpose.kind === "workload") {
          if (asPositiveInteger(generation.assignment_generation) !== purpose.expectedAssignmentGeneration) {
            return undefined;
          }
          const lease = this.findCurrentLeaseRow(
            authority.registryWorkspaceId,
            assignmentId,
            purpose.expectedAssignmentGeneration,
          );
          if (lease === undefined || asPositiveInteger(lease.lease_revision) !== purpose.expectedLeaseRevision) {
            return undefined;
          }
        }
      } else if (purpose.kind === "workload") {
        return undefined;
      }
      return Object.freeze({ assignment, workload: workloadIdentity(workload) });
    });
  }

  /**
   * Atomically claims one offer. Every worker, node, M2/M3, task, capability,
   * and durable-dispatch field is server-derived; the caller contributes only
   * the retained lease digest and an idempotency key.
   */
  public claimTaskBoundChatOffer(
    input: ClaimRemoteWorkerAssignmentOfferInput,
  ): ClaimRemoteWorkerAssignmentOfferOutcome {
    const authority = normalizeClaimAuthority(input.authority);
    const meshAdmission = normalizeRemoteWorkerMeshNodeAuthorityFence(input.meshAdmission);
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const leaseTokenSha256 = digest(input.leaseTokenSha256, "leaseTokenSha256");
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    return this.db.transaction("immediate", () => {
      const assignmentHint = this.getAssignment(authority.registryWorkspaceId, assignmentId);
      const lockContext = this.readTaskBoundDispatchLockContext(assignmentHint);
      this.acquirePostgresTaskBoundDispatchLocks(authority, assignmentHint, 1, lockContext.sessionId);
      const assignment = this.getAssignment(authority.registryWorkspaceId, assignmentId);
      this.assertTaskBoundDispatchLockContext(assignment, lockContext);
      const worker = this.assertClaimAuthorityCurrent(authority);
      this.assertTaskBoundOfferAuthority(assignment, worker);
      this.assertMeshAdmissionAuthority(authority, assignment, meshAdmission);
      const run = this.getDurableAuthorityRow(assignment.manifest.durableRunId, true);
      const workload = this.buildTaskBoundChatWorkload(assignment, run, lockContext.sessionId);
      if (
        run.status !== "running" ||
        !run.lease_owner_id ||
        !run.lease_expires_at ||
        !this.isTimestampFresh(run.lease_expires_at)
      ) {
        throw conflict("remote worker assignment claim durable dispatch authority");
      }
      const started = this.startGeneration({
        registryWorkspaceId: assignment.registryWorkspaceId,
        assignmentId: assignment.assignmentId,
        workerId: authority.workerId,
        workerGeneration: authority.workerGeneration,
        nodeId: authority.nodeId,
        nodeAdmissionGeneration: meshAdmission.admissionGeneration,
        dispatchOwnerId: run.lease_owner_id,
        durableRunAttempt: asPositiveInteger(run.attempt_count),
        leaseTokenSha256,
        idempotencyKey,
      });
      const resolved = this.resolveActiveAuthorityByLeaseTokenHash(leaseTokenSha256);
      if (
        !resolved ||
        resolved.assignment.assignmentId !== assignment.assignmentId ||
        resolved.generation.workerId !== authority.workerId ||
        resolved.generation.workerGeneration !== authority.workerGeneration ||
        resolved.lease.leaseRevision !== started.lease.leaseRevision
      ) {
        throw conflict("remote worker assignment claimed authority");
      }
      this.assertMeshAdmissionAuthority(authority, assignment, meshAdmission);
      return Object.freeze({
        disposition: started.disposition,
        assignment: resolved.assignment,
        generation: resolved.generation,
        lease: resolved.lease,
        workload,
      });
    });
  }

  /** Resolve a workload only while the exact authenticated lease remains live. */
  public resolveTaskBoundChatWorkload(
    input: ResolveRemoteWorkerAssignmentWorkloadInput,
  ): RemoteWorkerAssignmentWorkloadProjection | undefined {
    const authority = normalizeClaimAuthority(input.authority);
    const meshAdmission = normalizeRemoteWorkerMeshNodeAuthorityFence(input.meshAdmission);
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const expectedAssignmentGeneration = positiveInteger(
      input.expectedAssignmentGeneration,
      "expectedAssignmentGeneration",
    );
    const expectedLeaseRevision = positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const leaseTokenSha256 = digest(input.leaseTokenSha256, "leaseTokenSha256");
    if (registryWorkspaceId !== authority.registryWorkspaceId) return undefined;
    return this.db.transaction("immediate", () => {
      let assignmentHint: RemoteWorkerAssignmentRecord;
      try {
        assignmentHint = this.getAssignment(registryWorkspaceId, assignmentId);
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
      const lockContext = this.readTaskBoundDispatchLockContext(assignmentHint);
      this.acquirePostgresTaskBoundDispatchLocks(
        authority,
        assignmentHint,
        expectedAssignmentGeneration,
        lockContext.sessionId,
      );
      const assignment = this.getAssignment(registryWorkspaceId, assignmentId);
      this.assertTaskBoundDispatchLockContext(assignment, lockContext);
      this.assertClaimAuthorityCurrent(authority);
      this.assertMeshAdmissionAuthority(authority, assignment, meshAdmission);
      const resolved = this.resolveActiveAuthorityByLeaseTokenHash(leaseTokenSha256);
      if (
        !resolved ||
        resolved.assignment.registryWorkspaceId !== registryWorkspaceId ||
        resolved.assignment.assignmentId !== assignmentId ||
        resolved.generation.assignmentGeneration !== expectedAssignmentGeneration ||
        resolved.lease.leaseRevision !== expectedLeaseRevision ||
        resolved.generation.workerId !== authority.workerId ||
        resolved.generation.workerGeneration !== authority.workerGeneration
      ) {
        return undefined;
      }
      const run = this.getDurableAuthorityRow(resolved.assignment.manifest.durableRunId, true);
      return this.buildTaskBoundChatWorkload(resolved.assignment, run, lockContext.sessionId);
    });
  }

  public renewLease(
    input: RenewRemoteWorkerAssignmentLeaseCommand,
    expectedProtectedAuthority?: RemoteWorkerAssignmentProtectedCommitFence,
  ): RenewRemoteWorkerAssignmentLeaseOutcome {
    const command = normalizeRenewRemoteWorkerAssignmentLeaseCommand(input);
    const protectedAuthority =
      expectedProtectedAuthority === undefined ? undefined : normalizeProtectedCommitFence(expectedProtectedAuthority);
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
      if (protectedAuthority !== undefined) {
        this.assertProtectedCommitFenceCurrent(protectedAuthority, assignment, generation);
      }
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
    expectedProtectedAuthority?: RemoteWorkerAssignmentProtectedCommitFence,
  ): ResolvedRemoteWorkerAssignmentAuthority | undefined {
    const token = digest(leaseTokenSha256, "leaseTokenSha256");
    const protectedAuthority =
      expectedProtectedAuthority === undefined ? undefined : normalizeProtectedCommitFence(expectedProtectedAuthority);
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
      const assignment = this.getAssignment(generation.registry_workspace_id, generation.assignment_id);
      if (protectedAuthority !== undefined) {
        this.assertProtectedCommitFenceCurrent(protectedAuthority, assignment, generation);
      }
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
        assignment,
        generation: this.mapGeneration(generation),
        lease: this.mapLease(current),
      };
    });
  }

  /**
   * Resolve the exact current lease for a worker control read. Unlike the
   * mutation-only active resolver, this read remains available after a
   * `cancel_requested` control so a correctly fenced worker can observe the
   * cancellation and settle it. Recovery/abandonment controls and settlements
   * remain terminal, and no lease digest leaves this repository boundary.
   */
  public resolveControlReadAuthorityByLeaseTokenHash(
    input: ResolveRemoteWorkerAssignmentControlReadInput,
    expectedProtectedAuthority?: RemoteWorkerAssignmentProtectedCommitFence,
  ): ResolvedRemoteWorkerAssignmentControlReadAuthority | undefined {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const expectedAssignmentGeneration = positiveInteger(
      input.expectedAssignmentGeneration,
      "expectedAssignmentGeneration",
    );
    const expectedLeaseRevision = positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision");
    const leaseTokenSha256 = digest(input.leaseTokenSha256, "leaseTokenSha256");
    const protectedAuthority =
      expectedProtectedAuthority === undefined ? undefined : normalizeProtectedCommitFence(expectedProtectedAuthority);
    const hint = this.findLeaseByTokenHash(leaseTokenSha256);
    if (
      !hint ||
      hint.registry_workspace_id !== registryWorkspaceId ||
      hint.assignment_id !== assignmentId ||
      asPositiveInteger(hint.assignment_generation) !== expectedAssignmentGeneration ||
      asPositiveInteger(hint.lease_revision) !== expectedLeaseRevision
    ) {
      return undefined;
    }
    return this.db.transaction("immediate", () => {
      const generation = this.getGenerationRow(registryWorkspaceId, assignmentId, expectedAssignmentGeneration);
      this.acquirePostgresGenerationLocks(
        generation.execution_workspace_id,
        generation.node_id,
        generation.registry_workspace_id,
        generation.worker_id,
        generation.assignment_id,
        asPositiveInteger(generation.assignment_generation),
      );
      const assignment = this.getAssignment(registryWorkspaceId, assignmentId);
      if (protectedAuthority !== undefined) {
        this.assertProtectedCommitFenceCurrent(protectedAuthority, assignment, generation);
      }
      const current = this.getCurrentLeaseRow(registryWorkspaceId, assignmentId, expectedAssignmentGeneration);
      if (
        asPositiveInteger(current.lease_revision) !== expectedLeaseRevision ||
        current.lease_token_sha256 !== leaseTokenSha256 ||
        !this.isTimestampFresh(current.expires_at)
      ) {
        return undefined;
      }
      this.assertLeaseDispatchAuthorityLive(generation, current);
      if (this.findSettlement(registryWorkspaceId, assignmentId)) return undefined;
      const control = this.findLatestControlRow(registryWorkspaceId, assignmentId, expectedAssignmentGeneration);
      if (control !== undefined && control.action !== "cancel_requested") return undefined;
      const authority = {
        assignment,
        generation: this.mapGeneration(generation),
        lease: this.mapLease(current),
      };
      return control === undefined
        ? { disposition: "active", ...authority }
        : { disposition: "cancel_requested", ...authority, control: this.mapControl(control) };
    });
  }

  public requestCancellation(input: ControlRemoteWorkerAssignmentCommand): RemoteWorkerAssignmentControlRecord {
    return this.insertControl("cancel_requested", input, false);
  }

  public markRecoveryExhausted(input: ControlRemoteWorkerAssignmentCommand): RemoteWorkerAssignmentControlRecord {
    return this.insertControl("recovery_exhausted", input, true);
  }

  public appendEvents(
    input: AppendRemoteWorkerAssignmentEventsCommand,
    expectedProtectedAuthority?: RemoteWorkerAssignmentProtectedCommitFence,
  ): RemoteWorkerAssignmentAppendOutcome {
    const command = normalizeAppendRemoteWorkerAssignmentEventsCommand(input);
    const protectedAuthority =
      expectedProtectedAuthority === undefined ? undefined : normalizeProtectedCommitFence(expectedProtectedAuthority);
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
      if (protectedAuthority !== undefined) {
        this.assertProtectedCommitFenceCurrent(protectedAuthority, assignment, generation);
      }
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

  public settleAssignment(
    input: SettleRemoteWorkerAssignmentCommand,
    expectedProtectedAuthority?: RemoteWorkerAssignmentProtectedCommitFence,
  ): SettleRemoteWorkerAssignmentOutcome {
    const command = normalizeSettleRemoteWorkerAssignmentCommand(input);
    const protectedAuthority =
      expectedProtectedAuthority === undefined ? undefined : normalizeProtectedCommitFence(expectedProtectedAuthority);
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
      if (protectedAuthority !== undefined) {
        this.assertProtectedCommitFenceCurrent(protectedAuthority, assignment, generation);
      }
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
      if (command.outputManifestSha256) {
        this.assertOutputManifestSettleable(
          command.registryWorkspaceId,
          command.assignmentId,
          command.expectedAssignmentGeneration,
          command.outputManifestSha256,
        );
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

  /**
   * HX-507B workspace-scoped assignment projection list. Order is
   * `(created_at DESC, assignment_id DESC)` with an opaque forward cursor bound
   * to the last (createdAt, assignmentId). Optional exact `workerId` (via the
   * current generation), `sessionId`, and `turnId` filters bind one stable set.
   * Storage lineage — never a caller assertion — decides session/turn/worker
   * membership. This is read-only; it never writes and never returns secrets.
   */
  public listAssignmentAggregates(
    registryWorkspaceId: string,
    options: ListRemoteWorkerAssignmentAggregatesOptions = {},
  ): ListRemoteWorkerAssignmentAggregatesResult {
    const workspace = identifier(registryWorkspaceId, "registryWorkspaceId");
    const limit = options.limit === undefined ? 20 : positiveInteger(options.limit, "limit", 100);
    const workerId = options.workerId === undefined ? undefined : identifier(options.workerId, "workerId");
    const sessionId = options.sessionId === undefined ? undefined : identifier(options.sessionId, "sessionId");
    const turnId = options.turnId === undefined ? undefined : identifier(options.turnId, "turnId");
    const conditions = ["a.registry_workspace_id = @registryWorkspaceId"];
    const params: Record<string, unknown> = { registryWorkspaceId: workspace, fetchLimit: limit + 1 };
    if (sessionId !== undefined) {
      conditions.push("a.session_id = @sessionId");
      params.sessionId = sessionId;
    }
    if (turnId !== undefined) {
      conditions.push("a.turn_id = @turnId");
      params.turnId = turnId;
    }
    if (workerId !== undefined) {
      conditions.push("g.worker_id = @workerId");
      params.workerId = workerId;
    }
    if (options.cursor !== undefined) {
      conditions.push(
        "(a.created_at < @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.assignment_id < @cursorAssignmentId))",
      );
      params.cursorCreatedAt = identifier(options.cursor.lastCreatedAt, "cursorCreatedAt");
      params.cursorAssignmentId = identifier(options.cursor.lastAssignmentId, "cursorAssignmentId");
    }
    const rows = this.db
      .prepare(
        `SELECT a.*,
                g.assignment_generation AS current_assignment_generation,
                g.worker_id AS current_worker_id
         FROM remote_worker_assignments a
         LEFT JOIN remote_worker_assignment_generations g
           ON g.registry_workspace_id = a.registry_workspace_id
          AND g.assignment_id = a.assignment_id
          AND g.assignment_generation = (
            SELECT MAX(cg.assignment_generation) FROM remote_worker_assignment_generations cg
            WHERE cg.registry_workspace_id = a.registry_workspace_id AND cg.assignment_id = a.assignment_id
          )
         WHERE ${conditions.join(" AND ")}
         ORDER BY a.created_at DESC, a.assignment_id DESC
         LIMIT @fetchLimit`,
      )
      .all(params) as AssignmentListRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const items = selected.map((row) => this.mapAssignmentAggregate(row));
    const last = selected.at(-1);
    return {
      items,
      ...(hasMore && last
        ? { nextCursor: { lastCreatedAt: last.created_at, lastAssignmentId: last.assignment_id } }
        : {}),
    };
  }

  /**
   * HX-507B single-assignment aggregate for the events route generation
   * resolution and reconciliation projection. Returns undefined when the
   * assignment does not exist in the workspace (no cross-workspace disclosure).
   */
  public findAssignmentAggregate(
    registryWorkspaceId: string,
    assignmentId: string,
  ): RemoteWorkerAssignmentAggregate | undefined {
    const row = this.db
      .prepare(
        `SELECT a.*,
                g.assignment_generation AS current_assignment_generation,
                g.worker_id AS current_worker_id
         FROM remote_worker_assignments a
         LEFT JOIN remote_worker_assignment_generations g
           ON g.registry_workspace_id = a.registry_workspace_id
          AND g.assignment_id = a.assignment_id
          AND g.assignment_generation = (
            SELECT MAX(cg.assignment_generation) FROM remote_worker_assignment_generations cg
            WHERE cg.registry_workspace_id = a.registry_workspace_id AND cg.assignment_id = a.assignment_id
          )
         WHERE a.registry_workspace_id = @registryWorkspaceId AND a.assignment_id = @assignmentId`,
      )
      .get({
        registryWorkspaceId: identifier(registryWorkspaceId, "registryWorkspaceId"),
        assignmentId: identifier(assignmentId, "assignmentId"),
      }) as AssignmentListRow | undefined;
    return row ? this.mapAssignmentAggregate(row) : undefined;
  }

  private mapAssignmentAggregate(row: AssignmentListRow): RemoteWorkerAssignmentAggregate {
    const assignment = this.mapAssignment(row);
    const currentGeneration =
      row.current_assignment_generation === null ? undefined : asPositiveInteger(row.current_assignment_generation);
    const generation =
      currentGeneration === undefined
        ? undefined
        : this.mapGeneration(this.getGenerationRow(row.registry_workspace_id, row.assignment_id, currentGeneration));
    const leaseRow =
      currentGeneration === undefined
        ? undefined
        : this.findCurrentLeaseRow(row.registry_workspace_id, row.assignment_id, currentGeneration);
    const controlRow =
      currentGeneration === undefined
        ? undefined
        : this.findLatestControlRow(row.registry_workspace_id, row.assignment_id, currentGeneration);
    const settlementRow = this.findSettlement(row.registry_workspace_id, row.assignment_id);
    return {
      assignment,
      ...(generation ? { generation } : {}),
      ...(leaseRow ? { lease: this.mapLease(leaseRow) } : {}),
      ...(controlRow ? { control: this.mapControl(controlRow) } : {}),
      ...(settlementRow ? { settlement: this.mapSettlement(settlementRow) } : {}),
      materialization: this.summarizeMaterializations(row.registry_workspace_id, row.assignment_id),
    };
  }

  private findCurrentLeaseRow(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): LeaseRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_assignment_leases
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration
         ORDER BY lease_revision DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration }) as LeaseRow | undefined;
  }

  private summarizeMaterializations(
    registryWorkspaceId: string,
    assignmentId: string,
  ): RemoteWorkerAssignmentMaterializationSummary {
    const rows = this.db
      .prepare(
        `SELECT target_kind, materialized_at FROM remote_worker_assignment_materializations
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
         ORDER BY materialized_at ASC`,
      )
      .all({ registryWorkspaceId, assignmentId }) as { target_kind: string; materialized_at: string }[];
    const summary: RemoteWorkerAssignmentMaterializationSummary = {
      count: rows.length,
      chatTranscriptCount: rows.filter((r) => r.target_kind === "chat_transcript").length,
      durableRunResultCount: rows.filter((r) => r.target_kind === "durable_run_result").length,
    };
    const latest = rows.at(-1)?.materialized_at;
    return latest === undefined ? summary : { ...summary, latestMaterializedAt: latest };
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

  private assertProtectedCommitFenceCurrent(
    fence: RemoteWorkerAssignmentProtectedCommitFence,
    assignment: RemoteWorkerAssignmentRecord,
    generation: GenerationRow,
  ): void {
    const authority = fence.credentialAuthority;
    const meshAdmission = fence.meshAdmission;
    if (
      assignment.registryWorkspaceId !== authority.registryWorkspaceId ||
      assignment.registryWorkspaceId !== generation.registry_workspace_id ||
      assignment.assignmentId !== generation.assignment_id ||
      assignment.manifest.executionWorkspaceId !== generation.execution_workspace_id ||
      generation.worker_id !== authority.workerId ||
      asPositiveInteger(generation.worker_generation) !== authority.workerGeneration ||
      generation.node_id !== authority.nodeId ||
      generation.runtime_manifest_sha256 !== authority.runtimeManifestSha256 ||
      generation.workspace_ceiling_sha256 !== authority.workspaceCeilingSha256 ||
      generation.capability_ceiling_sha256 !== authority.capabilityCeilingSha256 ||
      meshAdmission.workspaceId !== assignment.manifest.executionWorkspaceId ||
      meshAdmission.admissionGeneration !== asPositiveInteger(generation.node_admission_generation)
    ) {
      throw conflict("remote worker assignment protected commit authority");
    }
    try {
      const worker = this.assertClaimAuthorityCurrent(authority);
      this.assertWorkerIsCurrentAndAllowed(worker, assignment.manifest);
      this.assertMeshAdmissionAuthority(authority, assignment, meshAdmission);
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) {
        throw conflict("remote worker assignment protected commit authority");
      }
      throw error;
    }
  }

  private assertClaimAuthorityCurrent(authority: RemoteWorkerAssignmentClaimAuthority): WorkerAuthorityRow {
    const resolved = new RemoteWorkerAdmissionRepository(this.db).resolveRuntimeCredentialByHash(
      authority.authorizationCredentialSha256,
    );
    if (!resolved) throw conflict("remote worker assignment current claim credential");
    const generation = resolved.generation;
    const credential = resolved.credential;
    if (
      generation.registryWorkspaceId !== authority.registryWorkspaceId ||
      generation.bootstrapId !== authority.bootstrapId ||
      generation.workerId !== authority.workerId ||
      generation.workerGeneration !== authority.workerGeneration ||
      generation.nodeId !== authority.nodeId ||
      generation.clientCertificateSha256 !== authority.clientCertificateSha256 ||
      generation.runtimeManifestSha256 !== authority.runtimeManifestSha256 ||
      generation.workspaceCeilingSha256 !== authority.workspaceCeilingSha256 ||
      generation.capabilityCeilingSha256 !== authority.capabilityCeilingSha256 ||
      credential.registryWorkspaceId !== authority.registryWorkspaceId ||
      credential.workerId !== authority.workerId ||
      credential.workerGeneration !== authority.workerGeneration ||
      credential.credentialId !== authority.credentialId ||
      credential.credentialGeneration !== authority.credentialGeneration ||
      credential.claimsSha256 !== authority.claimsSha256
    ) {
      throw conflict("remote worker assignment current claim credential");
    }
    const worker = this.getWorkerAuthorityRow(
      authority.registryWorkspaceId,
      authority.workerId,
      authority.workerGeneration,
    );
    if (
      worker.node_id !== authority.nodeId ||
      worker.runtime_manifest_sha256 !== authority.runtimeManifestSha256 ||
      worker.workspace_ceiling_sha256 !== authority.workspaceCeilingSha256 ||
      worker.capability_ceiling_sha256 !== authority.capabilityCeilingSha256
    ) {
      throw conflict("remote worker assignment claim worker authority");
    }
    return worker;
  }

  private assertTaskBoundOfferAuthority(assignment: RemoteWorkerAssignmentRecord, worker: WorkerAuthorityRow): void {
    if (
      assignment.manifest.sessionId === undefined ||
      assignment.manifest.turnId === undefined ||
      !this.isTimestampFuture(assignment.manifest.deadlineAt)
    ) {
      throw conflict("remote worker assignment task-bound Chat offer");
    }
    this.assertWorkerIsCurrentAndAllowed(worker, assignment.manifest);
  }

  private assertMeshAdmissionAuthority(
    authority: RemoteWorkerAssignmentClaimAuthority,
    assignment: RemoteWorkerAssignmentRecord,
    meshAdmission: RemoteWorkerMeshNodeAuthorityFence,
  ): void {
    const expected = {
      registryWorkspaceId: authority.registryWorkspaceId,
      bootstrapId: authority.bootstrapId,
      workerId: authority.workerId,
      workerGeneration: authority.workerGeneration,
      credentialId: authority.credentialId,
      credentialGeneration: authority.credentialGeneration,
      workspaceId: assignment.manifest.executionWorkspaceId,
      nodeId: authority.nodeId,
      protectedAdmissionEnvelopeSha256: authority.protectedAdmissionEnvelopeSha256,
      protectedAdmissionContextSha256: authority.protectedAdmissionContextSha256,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (meshAdmission[field as keyof RemoteWorkerMeshNodeAuthorityFence] !== value) {
        throw conflict("remote worker assignment mesh admission authority");
      }
    }
    new RemoteWorkerMeshNodeAdmissionRepository(this.db).compareCurrentAuthorityFence({
      workspaceId: meshAdmission.workspaceId,
      nodeId: meshAdmission.nodeId,
      admissionGeneration: meshAdmission.admissionGeneration,
      expected: meshAdmission,
    });
  }

  private buildTaskBoundChatWorkload(
    assignment: RemoteWorkerAssignmentRecord,
    lockedRun?: DurableAuthorityRow,
    preacquiredSessionId?: string,
  ): RemoteWorkerAssignmentWorkloadProjection {
    const run = lockedRun ?? this.getDurableAuthorityRow(assignment.manifest.durableRunId, false);
    this.assertCanonicalParentContext(assignment.manifest, run);
    const payload = parseJsonRecord(run.payload_json, "remote worker assignment durable Chat payload");
    const durablePayloadAuthority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflow_key,
      durableRunId: run.run_id,
      payload,
    });
    if (!durablePayloadAuthority) throw conflict("remote worker assignment durable Chat payload authority");
    const request = plainRecord(payload.request);
    const metadata = parseJsonRecord(run.metadata_json ?? "{}", "remote worker assignment durable Chat metadata");
    const capabilityProfileId = identifier(String(payload.capabilityProfileId ?? ""), "capabilityProfileId");
    const capabilityProfileSha256 = digest(String(payload.capabilityProfileHash ?? ""), "capabilityProfileSha256");
    if (
      run.workflow_key !== "chat.turn.execute" ||
      payload.version !== "chat.turn.execute.v2" ||
      payload.workspaceId !== assignment.manifest.executionWorkspaceId ||
      payload.sessionId !== assignment.manifest.sessionId ||
      payload.turnId !== assignment.manifest.turnId ||
      request.policyTaskId !== assignment.manifest.taskId ||
      capabilityProfileSha256 !== assignment.manifest.capabilityProfileSha256 ||
      metadata.capabilityProfileId !== capabilityProfileId ||
      metadata.capabilityProfileHash !== capabilityProfileSha256
    ) {
      throw conflict("remote worker assignment durable Chat workload binding");
    }
    if (preacquiredSessionId !== undefined) {
      if (durablePayloadAuthority.sessionId !== preacquiredSessionId || !run.lease_owner_id) {
        throw conflict("remote worker assignment durable Chat execution claim");
      }
      new SessionMutationAdmissionRepository(this.db).assertActiveTurnWrite({
        admissionId: durablePayloadAuthority.admissionId,
        sessionIncarnationId: durablePayloadAuthority.sessionIncarnationId,
        workspaceId: durablePayloadAuthority.workspaceId,
        sessionId: durablePayloadAuthority.sessionId,
        turnId: durablePayloadAuthority.turnId,
        durableClaim: {
          durableRunId: run.run_id,
          leaseOwnerId: run.lease_owner_id,
          attemptCount: asPositiveInteger(run.attempt_count),
        },
        requireExactDurablePayloadIdentity: true,
      });
    }
    const profile = new ChatTurnCapabilityProfileRepository(this.db).findByRun(run.run_id);
    if (
      !profile ||
      profile.profileId !== capabilityProfileId ||
      profile.hashes.profileHash !== capabilityProfileSha256 ||
      profile.identity.durableRunId !== run.run_id ||
      profile.identity.workspaceId !== assignment.manifest.executionWorkspaceId ||
      profile.identity.sessionId !== assignment.manifest.sessionId ||
      profile.identity.turnId !== assignment.manifest.turnId
    ) {
      throw conflict("remote worker assignment capability profile authority");
    }
    const routedContextSnapshotId = payload.routedContextSnapshotId;
    const routedContextSnapshotHash = payload.routedContextSnapshotHash;
    if (
      (routedContextSnapshotId === undefined) !== (routedContextSnapshotHash === undefined) ||
      (routedContextSnapshotHash !== undefined &&
        digest(String(routedContextSnapshotHash), "routedContextSnapshotHash") !==
          assignment.manifest.contextSnapshotSha256)
    ) {
      throw conflict("remote worker assignment routed context authority");
    }
    const durableRunVersion = asPositiveInteger(run.version);
    const durableRunPayloadSha256 = sha256Bytes(run.payload_json);
    const identityMaterial = Object.freeze({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
      registryWorkspaceId: assignment.registryWorkspaceId,
      assignmentId: assignment.assignmentId,
      assignmentManifestSha256: assignment.manifestSha256,
      durableRunId: run.run_id,
      durableRunVersion,
      durableRunPayloadSha256,
      capabilityProfileId,
      capabilityProfileSha256,
      contextSnapshotSha256: assignment.manifest.contextSnapshotSha256,
    });
    const projection: RemoteWorkerAssignmentWorkloadProjection = Object.freeze({
      ...identityMaterial,
      workloadSha256: sha256(identityMaterial),
      payload: freezeJson(payload) as Readonly<Record<string, unknown>>,
    });
    if (Buffer.byteLength(canonicalJsonString(projection), "utf8") > REMOTE_WORKER_ASSIGNMENT_WORKLOAD_MAX_BYTES) {
      throw conflict("remote worker assignment workload byte bound");
    }
    return projection;
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
        `SELECT run_id, workflow_key, status, attempt_count, lease_owner_id, lease_expires_at,
                version, payload_json, metadata_json
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

  /**
   * HX-506 settlement gate. An output-manifest settlement is only durable once
   * the exact assignment-generation manifest exists and is committed, the
   * verification gate is not_required or satisfied, every recorded effect intent
   * has a current receipt, and no receipt remains in manual reconciliation. This
   * is the one HX-506-facing extension the assignment owner may carry; it reads
   * the settlement owner's tables and never recreates its authority.
   */
  private assertOutputManifestSettleable(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    outputManifestSha256: string,
  ): void {
    const manifest = this.db
      .prepare(
        `SELECT manifest_sha256, upload_id FROM remote_worker_artifact_manifests
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration }) as
      | { manifest_sha256?: unknown; upload_id?: unknown }
      | undefined;
    if (typeof manifest?.manifest_sha256 !== "string" || manifest.manifest_sha256 !== outputManifestSha256) {
      throw conflict("remote worker assignment output manifest");
    }
    const upload = this.db
      .prepare(
        `SELECT upload_state, verification_gate_state FROM remote_worker_artifact_uploads
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND upload_id = @uploadId`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration, uploadId: manifest.upload_id }) as
      | { upload_state?: unknown; verification_gate_state?: unknown }
      | undefined;
    if (upload?.upload_state !== "committed") {
      throw conflict("remote worker assignment output manifest upload");
    }
    if (upload.verification_gate_state !== "not_required" && upload.verification_gate_state !== "satisfied") {
      throw conflict("remote worker assignment output manifest verification");
    }
    const effects = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM remote_worker_effect_intents i
              WHERE i.registry_workspace_id = @registryWorkspaceId AND i.assignment_id = @assignmentId
                AND i.assignment_generation = @assignmentGeneration) AS intents,
           (SELECT COUNT(*) FROM remote_worker_effect_receipts r
              WHERE r.registry_workspace_id = @registryWorkspaceId AND r.assignment_id = @assignmentId
                AND r.assignment_generation = @assignmentGeneration) AS receipts,
           (SELECT COUNT(*) FROM remote_worker_effect_receipts r
              WHERE r.registry_workspace_id = @registryWorkspaceId AND r.assignment_id = @assignmentId
                AND r.assignment_generation = @assignmentGeneration AND r.receipt_state = 'manual_reconciliation') AS manual`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration }) as
      | { intents?: unknown; receipts?: unknown; manual?: unknown }
      | undefined;
    if (Number(effects?.intents ?? 0) !== Number(effects?.receipts ?? 0)) {
      throw conflict("remote worker assignment effect receipts");
    }
    if (Number(effects?.manual ?? 0) > 0) {
      throw conflict("remote worker assignment effect reconciliation");
    }
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

  private readTaskBoundDispatchLockContext(assignment: RemoteWorkerAssignmentRecord): TaskBoundDispatchLockContext {
    const run = this.getDurableAuthorityRow(assignment.manifest.durableRunId, false);
    this.assertCanonicalParentContext(assignment.manifest, run);
    const payload = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflow_key,
      durableRunId: run.run_id,
      payload: parseJsonRecord(run.payload_json, "remote worker assignment durable Chat payload"),
    });
    if (
      !payload ||
      payload.workspaceId !== assignment.manifest.executionWorkspaceId ||
      payload.sessionId !== assignment.manifest.sessionId ||
      payload.turnId !== assignment.manifest.turnId
    ) {
      throw conflict("remote worker assignment task-bound dispatch lock authority");
    }
    return Object.freeze({
      assignmentManifestSha256: assignment.manifestSha256,
      sessionId: payload.sessionId,
    });
  }

  private assertTaskBoundDispatchLockContext(
    assignment: RemoteWorkerAssignmentRecord,
    context: TaskBoundDispatchLockContext,
  ): void {
    if (
      assignment.manifestSha256 !== context.assignmentManifestSha256 ||
      assignment.manifest.sessionId !== context.sessionId
    ) {
      throw conflict("remote worker assignment task-bound dispatch lock authority");
    }
  }

  private acquirePostgresTaskBoundDispatchLocks(
    authority: RemoteWorkerAssignmentClaimAuthority,
    assignment: RemoteWorkerAssignmentRecord,
    assignmentGeneration: number,
    sessionId: string,
  ): void {
    if (this.db.dialect !== "postgres") return;
    const plan = buildRemoteWorkerTaskBoundDispatchLockPlan({
      sessionId,
      executionWorkspaceId: assignment.manifest.executionWorkspaceId,
      nodeId: authority.nodeId,
      registryWorkspaceId: authority.registryWorkspaceId,
      workerId: authority.workerId,
      assignmentId: assignment.assignmentId,
      assignmentGeneration,
    });
    for (const lock of plan) {
      this.db
        .prepare(`SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, ${lock.namespace})) AS locked`)
        .get({ lockKey: lock.key });
    }
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

function normalizeClaimAuthority(input: RemoteWorkerAssignmentClaimAuthority): RemoteWorkerAssignmentClaimAuthority {
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "authority.registryWorkspaceId"),
    bootstrapId: identifier(input.bootstrapId, "authority.bootstrapId"),
    workerId: identifier(input.workerId, "authority.workerId"),
    workerGeneration: positiveInteger(input.workerGeneration, "authority.workerGeneration"),
    credentialId: identifier(input.credentialId, "authority.credentialId"),
    credentialGeneration: positiveInteger(input.credentialGeneration, "authority.credentialGeneration"),
    authorizationCredentialSha256: digest(
      input.authorizationCredentialSha256,
      "authority.authorizationCredentialSha256",
    ),
    nodeId: identifier(input.nodeId, "authority.nodeId"),
    clientCertificateSha256: digest(input.clientCertificateSha256, "authority.clientCertificateSha256"),
    runtimeManifestSha256: digest(input.runtimeManifestSha256, "authority.runtimeManifestSha256"),
    workspaceCeilingSha256: digest(input.workspaceCeilingSha256, "authority.workspaceCeilingSha256"),
    capabilityCeilingSha256: digest(input.capabilityCeilingSha256, "authority.capabilityCeilingSha256"),
    protectedAdmissionEnvelopeSha256: digest(
      input.protectedAdmissionEnvelopeSha256,
      "authority.protectedAdmissionEnvelopeSha256",
    ),
    protectedAdmissionContextSha256: digest(
      input.protectedAdmissionContextSha256,
      "authority.protectedAdmissionContextSha256",
    ),
    claimsSha256: digest(input.claimsSha256, "authority.claimsSha256"),
  });
}

function normalizeProtectedCommitFence(
  input: RemoteWorkerAssignmentProtectedCommitFence,
): RemoteWorkerAssignmentProtectedCommitFence {
  return Object.freeze({
    credentialAuthority: normalizeClaimAuthority(input.credentialAuthority),
    meshAdmission: normalizeRemoteWorkerMeshNodeAuthorityFence(input.meshAdmission),
  });
}

function normalizeOfferResolutionPurpose(
  input: RemoteWorkerAssignmentOfferResolutionPurpose,
): RemoteWorkerAssignmentOfferResolutionPurpose {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError({ field: "purpose", message: "Remote worker assignment purpose is invalid." });
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors).sort();
  if (
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw new ValidationError({ field: "purpose", message: "Remote worker assignment purpose is invalid." });
  }
  if (input.kind === "poll" || input.kind === "claim") {
    if (keys.length !== 1 || keys[0] !== "kind") {
      throw new ValidationError({ field: "purpose", message: "Remote worker assignment purpose is invalid." });
    }
    return Object.freeze({ kind: input.kind });
  }
  if (
    input.kind !== "workload" ||
    keys.length !== 3 ||
    keys[0] !== "expectedAssignmentGeneration" ||
    keys[1] !== "expectedLeaseRevision" ||
    keys[2] !== "kind"
  ) {
    throw new ValidationError({ field: "purpose", message: "Remote worker assignment purpose is invalid." });
  }
  return Object.freeze({
    kind: "workload",
    expectedAssignmentGeneration: positiveInteger(
      input.expectedAssignmentGeneration,
      "purpose.expectedAssignmentGeneration",
    ),
    expectedLeaseRevision: positiveInteger(input.expectedLeaseRevision, "purpose.expectedLeaseRevision"),
  });
}

function workloadIdentity(workload: RemoteWorkerAssignmentWorkloadProjection): RemoteWorkerAssignmentWorkloadIdentity {
  const { payload: _payload, ...identity } = workload;
  return Object.freeze(identity);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw conflict("remote worker assignment durable Chat request");
  }
  return value as Record<string, unknown>;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item)));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = freezeJson(item);
    return Object.freeze(result);
  }
  return value;
}

function canonicalTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new ValidationError({ field, message: `Remote worker assignment ${field} is invalid.` });
  }
  return value;
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

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed as Record<string, unknown>;
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
