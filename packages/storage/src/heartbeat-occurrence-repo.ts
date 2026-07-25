/* eslint-disable max-lines -- Heartbeat occurrence authority and cross-dialect fencing stay co-located for this checkpoint. */
import { createHash } from "node:crypto";
import { canonicalJsonString, ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { assertSynchronousTransactionResult, type DatabaseClient } from "./db.js";
import {
  SessionMutationAdmissionRepository,
  type AdmitSessionMutationInput,
  type SessionMutationAdmissionRecord,
  type VerifiedTerminalTurnWriteHandoff,
  type VerifyTerminalTurnWriteHandoffInput,
} from "./session-mutation-admission-repo.js";
import { SessionAutonomyPrefsRepository, type SessionAutonomyPrefsRecord } from "./session-autonomy-prefs-repo.js";

export const HEARTBEAT_SYSTEM_ACTOR_ID = "system-heartbeat" as const;
export const HEARTBEAT_ADMISSION_OPERATION = "chat_system_heartbeat" as const;

export type HeartbeatOccurrenceState = "admitted" | "durable_bound" | "terminal" | "abandoned";

export interface HeartbeatPriorCadence {
  lastProactiveAt?: string;
  lastProactiveRunId?: string;
}

export interface HeartbeatOccurrenceChildIdentity {
  userMessageId: string;
  assistantMessageId: string;
  turnId: string;
  durableRunId: string;
}

export interface HeartbeatOccurrenceRecord extends HeartbeatOccurrenceChildIdentity {
  occurrenceId: string;
  workspaceId: string;
  sessionId: string;
  sessionIncarnationId: string;
  admissionId: string;
  admissionRequestSha256: string;
  admissionIdempotencyKey: string;
  admissionCorrelationId: string;
  runtimeOwnerId: string;
  systemActorId: typeof HEARTBEAT_SYSTEM_ACTOR_ID;
  admissionMaterialSha256: string;
  evaluatedPolicySha256: string;
  frozenRequestSha256: string;
  frozenObjectiveSha256: string;
  claimSha256: string;
  aggregateRevision: number;
  controllerGeneration: number;
  priorCadence: HeartbeatPriorCadence;
  heartbeatIntervalSeconds: number;
  cooldownSeconds: number;
  idleFloorSeconds: number;
  observedSessionActivityAt: string;
  state: HeartbeatOccurrenceState;
  revision: number;
  claimedAt: string;
  updatedAt: string;
  boundDurableRunId?: string;
  durableBoundAt?: string;
  terminalAt?: string;
  abandonedAt?: string;
  terminalStatus?: "completed" | "failed" | "cancelled";
  terminalHandoffSha256?: string;
  abandonmentReason?: HeartbeatOccurrenceAbandonReason;
  capabilityProfileId?: string;
  capabilityProfileHash?: string;
}

export interface HeartbeatOccurrenceRecoveryCursor {
  updatedAt: string;
  occurrenceId: string;
}

export interface ListHeartbeatOccurrenceRecoveryPageInput {
  limit?: number;
  after?: HeartbeatOccurrenceRecoveryCursor;
}

export interface HeartbeatOccurrenceRecoveryPage {
  items: HeartbeatOccurrenceRecord[];
  nextCursor?: HeartbeatOccurrenceRecoveryCursor;
}

export interface ClaimHeartbeatOccurrenceInput {
  workspaceId: string;
  sessionId: string;
  expectedPriorCadence: HeartbeatPriorCadence;
  evaluatedPolicySha256: string;
  frozenRequestSha256: string;
  frozenObjectiveSha256: string;
  idleFloorSeconds: number;
}

export interface HeartbeatOccurrenceAdmissionRequest {
  occurrenceId: string;
  claimSha256: string;
  claimedAt: string;
  child: HeartbeatOccurrenceChildIdentity;
  admissionInput: AdmitSessionMutationInput & {
    actorKind: "system";
    actorId: typeof HEARTBEAT_SYSTEM_ACTOR_ID;
    operation: typeof HEARTBEAT_ADMISSION_OPERATION;
  };
}

export interface HeartbeatOccurrenceAdmissionCallbackResult {
  admission: SessionMutationAdmissionRecord;
  child: HeartbeatOccurrenceChildIdentity;
}

export type HeartbeatOccurrenceAdmissionCallback = (
  request: HeartbeatOccurrenceAdmissionRequest,
) => HeartbeatOccurrenceAdmissionCallbackResult;

export type HeartbeatOccurrenceNotDueReason =
  | "heartbeat_disabled"
  | "outside_active_hours"
  | "session_not_idle"
  | "cooldown"
  | "interval"
  | "active_turn"
  | "cadence_changed";

export type ClaimHeartbeatOccurrenceOutcome =
  | { disposition: "created" | "replayed"; occurrence: HeartbeatOccurrenceRecord }
  | { disposition: "unresolved_busy"; occurrence: HeartbeatOccurrenceRecord }
  | { disposition: "not_due"; reason: HeartbeatOccurrenceNotDueReason; databaseNow: string };

export interface HeartbeatOccurrenceExactIdentity {
  occurrenceId: string;
  workspaceId: string;
  sessionId: string;
  sessionIncarnationId: string;
  admissionId: string;
  turnId: string;
  durableRunId: string;
}

export interface HeartbeatOccurrenceBoundIdentity extends HeartbeatOccurrenceExactIdentity {
  capabilityProfileId: string;
  capabilityProfileHash: string;
}

export interface MarkHeartbeatOccurrenceDurableBoundOutcome {
  disposition: "created" | "replayed";
  occurrence: HeartbeatOccurrenceRecord;
}

export interface MarkHeartbeatOccurrenceTerminalOutcome {
  disposition: "terminal" | "still_bound" | "replayed";
  occurrence: HeartbeatOccurrenceRecord;
}

export type HeartbeatOccurrenceAbandonReason = "admission_closed" | "authority_drift" | "lifecycle_drift";

export interface AbandonHeartbeatOccurrenceInput extends HeartbeatOccurrenceExactIdentity {
  reason: HeartbeatOccurrenceAbandonReason;
}

export interface AbandonHeartbeatOccurrenceOutcome {
  disposition: "abandoned" | "replayed";
  occurrence: HeartbeatOccurrenceRecord;
}

/**
 * Owns the content-free, append/transition-only authority for one durable
 * heartbeat child. The implementation deliberately exposes a synchronous
 * callback so admission creation and cadence consumption cannot escape the
 * claim transaction.
 */
export class HeartbeatOccurrenceRepository {
  private readonly autonomyPrefs: SessionAutonomyPrefsRepository;
  private readonly mutationAdmissions: SessionMutationAdmissionRepository;

  public constructor(private readonly db: DatabaseClient) {
    this.autonomyPrefs = new SessionAutonomyPrefsRepository(db);
    this.mutationAdmissions = new SessionMutationAdmissionRepository(db);
  }

  public claim(
    input: ClaimHeartbeatOccurrenceInput,
    admit: HeartbeatOccurrenceAdmissionCallback,
  ): ClaimHeartbeatOccurrenceOutcome {
    const normalized = normalizeClaimInput(input);
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(normalized.sessionId);
      const authority = this.requireOperatorSessionAuthority(normalized.workspaceId, normalized.sessionId);
      const claimMaterial = {
        version: 1,
        workspaceId: normalized.workspaceId,
        sessionId: normalized.sessionId,
        sessionIncarnationId: authority.sessionIncarnationId,
        priorLastProactiveAt: normalized.expectedPriorCadence.lastProactiveAt ?? null,
        priorLastProactiveRunId: normalized.expectedPriorCadence.lastProactiveRunId ?? null,
        evaluatedPolicySha256: normalized.evaluatedPolicySha256,
        frozenRequestSha256: normalized.frozenRequestSha256,
        frozenObjectiveSha256: normalized.frozenObjectiveSha256,
        idleFloorSeconds: normalized.idleFloorSeconds,
      };
      const claimSha256 = sha256(
        canonicalJsonString({ operation: "heartbeat_occurrence_claim", value: claimMaterial }),
      );
      const occurrenceId = derivedId("hbo", claimSha256);
      const child: HeartbeatOccurrenceChildIdentity = {
        userMessageId: derivedId("hbu", claimSha256),
        assistantMessageId: derivedId("hba", claimSha256),
        turnId: derivedId("hbt", claimSha256),
        durableRunId: derivedId("hbr", claimSha256),
      };
      const replay = this.findRowByOccurrenceId(occurrenceId, true);
      if (replay) {
        this.assertClaimReplay(replay, normalized, authority.sessionIncarnationId, claimSha256, child);
        return { disposition: "replayed", occurrence: mapRow(replay) };
      }
      const unresolved = this.findUnresolvedRow(normalized.workspaceId, normalized.sessionId, true);
      if (unresolved) return { disposition: "unresolved_busy", occurrence: mapRow(unresolved) };

      const databaseNow = this.readDatabaseTime();
      const prefs = this.requireLockedPrefs(normalized.sessionId);
      if (
        prefs.lastProactiveAt !== normalized.expectedPriorCadence.lastProactiveAt ||
        prefs.lastProactiveRunId !== normalized.expectedPriorCadence.lastProactiveRunId
      ) {
        return { disposition: "not_due", reason: "cadence_changed", databaseNow };
      }
      if (!prefs.heartbeatEnabled) return { disposition: "not_due", reason: "heartbeat_disabled", databaseNow };
      if (!isWithinActiveHours(databaseNow, prefs)) {
        return { disposition: "not_due", reason: "outside_active_hours", databaseNow };
      }
      const observedSessionActivityAt = this.requireLockedSessionActivity(normalized.sessionId);
      if (elapsedSeconds(observedSessionActivityAt, databaseNow) < normalized.idleFloorSeconds) {
        return { disposition: "not_due", reason: "session_not_idle", databaseNow };
      }
      if (prefs.lastProactiveAt) {
        const elapsed = elapsedSeconds(prefs.lastProactiveAt, databaseNow);
        if (elapsed < prefs.cooldownSeconds) return { disposition: "not_due", reason: "cooldown", databaseNow };
        if (elapsed < prefs.heartbeatIntervalSeconds) {
          return { disposition: "not_due", reason: "interval", databaseNow };
        }
      }
      if (this.hasActiveTurn(normalized.sessionId)) {
        return { disposition: "not_due", reason: "active_turn", databaseNow };
      }

      const runtimeOwnerId = derivedId("hbro", claimSha256);
      const admissionMaterialSha256 = normalized.frozenRequestSha256;
      const admissionIdempotencyKey = `heartbeat-admission:${occurrenceId}`;
      const admissionInput: HeartbeatOccurrenceAdmissionRequest["admissionInput"] = {
        workspaceId: normalized.workspaceId,
        sessionId: normalized.sessionId,
        expectedSessionIncarnationId: authority.sessionIncarnationId,
        turnId: child.turnId,
        runtimeOwnerId,
        admissionKind: "turn_write",
        aggregateRevision: authority.aggregateRevision,
        controllerGeneration: authority.controllerGeneration,
        actorKind: "system",
        actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
        operation: HEARTBEAT_ADMISSION_OPERATION,
        materialSha256: admissionMaterialSha256,
        idempotencyKey: admissionIdempotencyKey,
        correlationId: occurrenceId,
      };

      this.autonomyPrefs.consumeHeartbeatCadenceWithinSessionLock({
        sessionId: normalized.sessionId,
        occurrenceId,
        claimedAt: databaseNow,
        expectedLastProactiveAt: normalized.expectedPriorCadence.lastProactiveAt,
        expectedLastProactiveRunId: normalized.expectedPriorCadence.lastProactiveRunId,
      });
      const callbackResult = admit({ occurrenceId, claimSha256, claimedAt: databaseNow, child, admissionInput });
      assertSynchronousTransactionResult(callbackResult);
      this.assertAdmissionCallback(callbackResult, child, admissionInput);
      const admission = callbackResult.admission;
      this.db
        .prepare(
          `INSERT INTO chat_heartbeat_occurrences (
             occurrence_id, workspace_id, session_id, session_incarnation_id,
             admission_id, admission_request_sha256, admission_idempotency_key, admission_correlation_id,
             runtime_owner_id, system_actor_id, admission_material_sha256,
             evaluated_policy_sha256, frozen_request_sha256, frozen_objective_sha256, claim_sha256,
             aggregate_revision, controller_generation,
             prior_last_proactive_at, prior_last_proactive_run_id,
             heartbeat_interval_seconds, cooldown_seconds, idle_floor_seconds, observed_session_activity_at,
             user_message_id, assistant_message_id, turn_id, expected_durable_run_id, durable_run_id,
             capability_profile_id, capability_profile_hash, state, revision, claimed_at,
             durable_bound_at, terminal_at, abandoned_at, terminal_status, terminal_handoff_sha256,
             abandonment_reason, updated_at
           ) VALUES (
             @occurrenceId, @workspaceId, @sessionId, @sessionIncarnationId,
             @admissionId, @admissionRequestSha256, @admissionIdempotencyKey, @admissionCorrelationId,
             @runtimeOwnerId, @systemActorId, @admissionMaterialSha256,
             @evaluatedPolicySha256, @frozenRequestSha256, @frozenObjectiveSha256, @claimSha256,
             @aggregateRevision, @controllerGeneration,
             @priorLastProactiveAt, @priorLastProactiveRunId,
             @heartbeatIntervalSeconds, @cooldownSeconds, @idleFloorSeconds, @observedSessionActivityAt,
             @userMessageId, @assistantMessageId, @turnId, @expectedDurableRunId, NULL,
             NULL, NULL, 'admitted', 1, @claimedAt,
             NULL, NULL, NULL, NULL, NULL, NULL, @updatedAt
           )`,
        )
        .run({
          occurrenceId,
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          sessionIncarnationId: authority.sessionIncarnationId,
          admissionId: admission.admissionId,
          admissionRequestSha256: admission.requestSha256,
          admissionIdempotencyKey,
          admissionCorrelationId: occurrenceId,
          runtimeOwnerId,
          systemActorId: HEARTBEAT_SYSTEM_ACTOR_ID,
          admissionMaterialSha256,
          evaluatedPolicySha256: normalized.evaluatedPolicySha256,
          frozenRequestSha256: normalized.frozenRequestSha256,
          frozenObjectiveSha256: normalized.frozenObjectiveSha256,
          claimSha256,
          aggregateRevision: authority.aggregateRevision,
          controllerGeneration: authority.controllerGeneration,
          priorLastProactiveAt: normalized.expectedPriorCadence.lastProactiveAt ?? null,
          priorLastProactiveRunId: normalized.expectedPriorCadence.lastProactiveRunId ?? null,
          heartbeatIntervalSeconds: prefs.heartbeatIntervalSeconds,
          cooldownSeconds: prefs.cooldownSeconds,
          idleFloorSeconds: normalized.idleFloorSeconds,
          observedSessionActivityAt,
          userMessageId: child.userMessageId,
          assistantMessageId: child.assistantMessageId,
          turnId: child.turnId,
          expectedDurableRunId: child.durableRunId,
          claimedAt: databaseNow,
          updatedAt: databaseNow,
        });
      return { disposition: "created", occurrence: this.require(occurrenceId) };
    });
  }

  public findUnresolved(workspaceId: string, sessionId: string): HeartbeatOccurrenceRecord | undefined {
    const row = this.findUnresolvedRow(
      identifier(workspaceId, "workspaceId"),
      identifier(sessionId, "sessionId"),
      false,
    );
    return row ? mapRow(row) : undefined;
  }

  public find(occurrenceId: string): HeartbeatOccurrenceRecord | undefined {
    const row = this.findRowByOccurrenceId(identifier(occurrenceId, "occurrenceId"), false);
    return row ? mapRow(row) : undefined;
  }

  public listRecoverable(limit = 100): HeartbeatOccurrenceRecord[] {
    return this.listRecoverablePage({ limit }).items;
  }

  /**
   * Deterministic keyset page for complete recovery sweeps. Callers must
   * continue until nextCursor is absent; busy rows therefore cannot pin a
   * later expired or terminal occurrence behind a fixed oldest-first cap.
   */
  public listRecoverablePage(input: ListHeartbeatOccurrenceRecoveryPageInput = {}): HeartbeatOccurrenceRecoveryPage {
    const bounded = integer(input.limit ?? 100, "limit", 1, 500);
    const after = input.after
      ? {
          updatedAt: timestamp(input.after.updatedAt, "after.updatedAt"),
          occurrenceId: identifier(input.after.occurrenceId, "after.occurrenceId"),
        }
      : undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_heartbeat_occurrences
         WHERE state IN ('admitted', 'durable_bound')
           AND (
             CAST(@afterUpdatedAt AS TEXT) IS NULL OR updated_at > CAST(@afterUpdatedAt AS TEXT)
             OR (updated_at = CAST(@afterUpdatedAt AS TEXT)
               AND occurrence_id > CAST(@afterOccurrenceId AS TEXT))
           )
         ORDER BY updated_at ASC, occurrence_id ASC LIMIT @limit`,
      )
      .all<HeartbeatOccurrenceRow>({
        afterUpdatedAt: after?.updatedAt ?? null,
        afterOccurrenceId: after?.occurrenceId ?? null,
        limit: bounded + 1,
      });
    const hasMore = rows.length > bounded;
    const pageRows = hasMore ? rows.slice(0, bounded) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(mapRow),
      ...(hasMore && last ? { nextCursor: { updatedAt: last.updated_at, occurrenceId: last.occurrence_id } } : {}),
    };
  }

  public markDurableBound(input: HeartbeatOccurrenceBoundIdentity): MarkHeartbeatOccurrenceDurableBoundOutcome {
    const normalized = normalizeBoundIdentity(input);
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(normalized.sessionId);
      const row = this.requireRow(normalized.occurrenceId, true);
      assertExactIdentity(row, normalized);
      if (row.state === "durable_bound" || row.state === "terminal") {
        assertBoundIdentity(row, normalized);
        this.requireDurableBindingEvidence(row, normalized, false);
        return { disposition: "replayed", occurrence: mapRow(row) };
      }
      if (row.state !== "admitted") throw occurrenceConflict("An abandoned heartbeat cannot bind a durable run.");
      this.requireDurableBindingEvidence(row, normalized, true);
      const databaseNow = this.readDatabaseTime();
      const updated = this.db
        .prepare(
          `UPDATE chat_heartbeat_occurrences
           SET state = 'durable_bound', durable_run_id = @durableRunId,
               capability_profile_id = @capabilityProfileId,
               capability_profile_hash = @capabilityProfileHash,
               durable_bound_at = @updatedAt, updated_at = @updatedAt, revision = revision + 1
           WHERE occurrence_id = @occurrenceId AND state = 'admitted' AND revision = @revision`,
        )
        .run({
          occurrenceId: normalized.occurrenceId,
          durableRunId: normalized.durableRunId,
          capabilityProfileId: normalized.capabilityProfileId,
          capabilityProfileHash: normalized.capabilityProfileHash,
          updatedAt: databaseNow,
          revision: asPositiveInteger(row.revision),
        });
      if (updated.changes !== 1) throw occurrenceConflict("Heartbeat occurrence changed during durable binding.");
      return { disposition: "created", occurrence: this.require(normalized.occurrenceId) };
    });
  }

  public markTerminal(input: HeartbeatOccurrenceBoundIdentity): MarkHeartbeatOccurrenceTerminalOutcome {
    const normalized = normalizeBoundIdentity(input);
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(normalized.sessionId);
      const row = this.requireRow(normalized.occurrenceId, true);
      assertExactIdentity(row, normalized);
      if (row.state === "terminal") {
        assertBoundIdentity(row, normalized);
        const replayEvidence = this.readTerminalEvidence(row);
        if (
          !replayEvidence ||
          replayEvidence.status !== row.terminal_status ||
          replayEvidence.handoffSha256 !== row.terminal_handoff_sha256
        ) {
          throw occurrenceConflict("Terminal heartbeat replay lacks exact current finalizer evidence.");
        }
        return { disposition: "replayed", occurrence: mapRow(row) };
      }
      if (row.state !== "durable_bound") {
        throw occurrenceConflict("Only a durable-bound heartbeat can settle terminal.");
      }
      assertBoundIdentity(row, normalized);
      const evidence = this.readTerminalEvidence(row);
      if (!evidence) return { disposition: "still_bound", occurrence: mapRow(row) };
      const databaseNow = this.readDatabaseTime();
      const updated = this.db
        .prepare(
          `UPDATE chat_heartbeat_occurrences
           SET state = 'terminal', terminal_at = @updatedAt, terminal_status = @terminalStatus,
               terminal_handoff_sha256 = @terminalHandoffSha256,
               updated_at = @updatedAt, revision = revision + 1
           WHERE occurrence_id = @occurrenceId AND state = 'durable_bound' AND revision = @revision`,
        )
        .run({
          occurrenceId: normalized.occurrenceId,
          terminalStatus: evidence.status,
          terminalHandoffSha256: evidence.handoffSha256,
          updatedAt: databaseNow,
          revision: asPositiveInteger(row.revision),
        });
      if (updated.changes !== 1) throw occurrenceConflict("Heartbeat occurrence changed during terminal settlement.");
      return { disposition: "terminal", occurrence: this.require(normalized.occurrenceId) };
    });
  }

  public abandon(input: AbandonHeartbeatOccurrenceInput): AbandonHeartbeatOccurrenceOutcome {
    const normalized = normalizeAbandonInput(input);
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(normalized.sessionId);
      const row = this.requireRow(normalized.occurrenceId, true);
      assertExactIdentity(row, normalized);
      if (row.state === "abandoned") {
        if (row.abandonment_reason !== normalized.reason)
          throw occurrenceConflict("Heartbeat abandon replay conflicts.");
        return { disposition: "replayed", occurrence: mapRow(row) };
      }
      if (row.state !== "admitted") throw occurrenceConflict("A durable-bound heartbeat cannot be abandoned.");
      this.requireAbandonEvidence(row, normalized.reason);
      const databaseNow = this.readDatabaseTime();
      const updated = this.db
        .prepare(
          `UPDATE chat_heartbeat_occurrences
           SET state = 'abandoned', abandoned_at = @updatedAt, abandonment_reason = @reason,
               updated_at = @updatedAt, revision = revision + 1
           WHERE occurrence_id = @occurrenceId AND state = 'admitted' AND revision = @revision`,
        )
        .run({
          occurrenceId: normalized.occurrenceId,
          reason: normalized.reason,
          updatedAt: databaseNow,
          revision: asPositiveInteger(row.revision),
        });
      if (updated.changes !== 1) throw occurrenceConflict("Heartbeat occurrence changed during abandonment.");
      return { disposition: "abandoned", occurrence: this.require(normalized.occurrenceId) };
    });
  }

  private require(occurrenceId: string): HeartbeatOccurrenceRecord {
    return mapRow(this.requireRow(occurrenceId, false));
  }

  private requireRow(occurrenceId: string, forUpdate: boolean): HeartbeatOccurrenceRow {
    const row = this.findRowByOccurrenceId(occurrenceId, forUpdate);
    if (!row) throw new NotFoundError({ entity: "heartbeat occurrence", id: occurrenceId });
    return row;
  }

  private findRowByOccurrenceId(occurrenceId: string, forUpdate: boolean): HeartbeatOccurrenceRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_heartbeat_occurrences WHERE occurrence_id = @occurrenceId${
          forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""
        }`,
      )
      .get<HeartbeatOccurrenceRow>({ occurrenceId });
  }

  private findUnresolvedRow(
    workspaceId: string,
    sessionId: string,
    forUpdate: boolean,
  ): HeartbeatOccurrenceRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_heartbeat_occurrences
         WHERE workspace_id = @workspaceId AND session_id = @sessionId
           AND state IN ('admitted', 'durable_bound')
         ORDER BY updated_at ASC, occurrence_id ASC LIMIT 1${
           forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<HeartbeatOccurrenceRow>({ workspaceId, sessionId });
  }

  private requireOperatorSessionAuthority(workspaceId: string, sessionId: string): SessionAuthority {
    const row = this.db
      .prepare(
        `SELECT meta.workspace_id, meta.lifecycle_status, meta.lifecycle_intent_id, meta.deletion_intent_id, meta.revision,
                control.generation, control.owner_kind, control.lease_state
         FROM chat_session_meta meta
         JOIN chat_session_control_grants control
           ON control.session_id = meta.session_id AND control.is_current = 1
         WHERE meta.session_id = @sessionId${this.db.dialect === "postgres" ? " FOR UPDATE OF meta, control" : ""}`,
      )
      .get<{
        workspace_id: string;
        lifecycle_status: string;
        lifecycle_intent_id: string | null;
        deletion_intent_id: string | null;
        revision: number | bigint | string;
        generation: number | bigint | string;
        owner_kind: string;
        lease_state: string;
      }>({ sessionId });
    if (
      !row ||
      row.workspace_id !== workspaceId ||
      row.lifecycle_status !== "active" ||
      row.lifecycle_intent_id === null ||
      row.deletion_intent_id !== null ||
      row.owner_kind !== "operator" ||
      row.lease_state !== "operator_active"
    ) {
      throw occurrenceConflict("Heartbeat claim has no exact live operator session authority.");
    }
    return {
      sessionIncarnationId: row.lifecycle_intent_id,
      aggregateRevision: asPositiveInteger(row.revision),
      controllerGeneration: asPositiveInteger(row.generation),
    };
  }

  private requireLockedPrefs(sessionId: string): SessionAutonomyPrefsRecord {
    if (this.db.dialect === "postgres") {
      this.db
        .prepare("SELECT session_id FROM session_autonomy_prefs WHERE session_id = @sessionId FOR UPDATE")
        .get({ sessionId });
    }
    const prefs = this.autonomyPrefs.get(sessionId);
    if (!prefs) throw new NotFoundError({ entity: "session autonomy prefs", id: sessionId });
    return prefs;
  }

  private requireLockedSessionActivity(sessionId: string): string {
    const row = this.db
      .prepare(
        `SELECT last_activity_at FROM sessions WHERE session_id = @sessionId${
          this.db.dialect === "postgres" ? " FOR UPDATE" : ""
        }`,
      )
      .get<{ last_activity_at: string }>({ sessionId });
    if (!row?.last_activity_at || !Number.isFinite(Date.parse(row.last_activity_at))) {
      throw occurrenceConflict("Heartbeat claim has no exact session activity timestamp.");
    }
    return new Date(Date.parse(row.last_activity_at)).toISOString();
  }

  private hasActiveTurn(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT admission_id FROM chat_session_mutation_admissions
           WHERE session_id = @sessionId AND admission_kind = 'turn_write' AND status = 'active'
           ORDER BY admission_id LIMIT 1${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get({ sessionId }),
    );
  }

  private assertClaimReplay(
    row: HeartbeatOccurrenceRow,
    input: ReturnType<typeof normalizeClaimInput>,
    sessionIncarnationId: string,
    claimSha256: string,
    child: HeartbeatOccurrenceChildIdentity,
  ): void {
    if (
      row.workspace_id !== input.workspaceId ||
      row.session_id !== input.sessionId ||
      row.session_incarnation_id !== sessionIncarnationId ||
      row.claim_sha256 !== claimSha256 ||
      row.evaluated_policy_sha256 !== input.evaluatedPolicySha256 ||
      row.frozen_request_sha256 !== input.frozenRequestSha256 ||
      row.frozen_objective_sha256 !== input.frozenObjectiveSha256 ||
      asNonNegativeInteger(row.idle_floor_seconds) !== input.idleFloorSeconds ||
      row.prior_last_proactive_at !== (input.expectedPriorCadence.lastProactiveAt ?? null) ||
      row.prior_last_proactive_run_id !== (input.expectedPriorCadence.lastProactiveRunId ?? null) ||
      row.user_message_id !== child.userMessageId ||
      row.assistant_message_id !== child.assistantMessageId ||
      row.turn_id !== child.turnId ||
      row.expected_durable_run_id !== child.durableRunId
    ) {
      throw occurrenceConflict("Heartbeat claim replay conflicts with frozen occurrence identity.");
    }
  }

  private assertAdmissionCallback(
    result: HeartbeatOccurrenceAdmissionCallbackResult,
    child: HeartbeatOccurrenceChildIdentity,
    input: HeartbeatOccurrenceAdmissionRequest["admissionInput"],
  ): void {
    if (!result || canonicalJsonString(result.child) !== canonicalJsonString(child)) {
      throw occurrenceConflict("Heartbeat admission callback changed deterministic child identity.");
    }
    const admission = result.admission;
    if (
      admission.workspaceId !== input.workspaceId ||
      admission.sessionId !== input.sessionId ||
      admission.sessionIncarnationId !== input.expectedSessionIncarnationId ||
      admission.turnId !== input.turnId ||
      admission.runtimeOwnerId !== input.runtimeOwnerId ||
      admission.admissionKind !== "turn_write" ||
      admission.aggregateRevision !== input.aggregateRevision ||
      admission.controllerGeneration !== input.controllerGeneration ||
      admission.actorKind !== "system" ||
      admission.actorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
      admission.operation !== HEARTBEAT_ADMISSION_OPERATION ||
      admission.materialSha256 !== input.materialSha256 ||
      admission.idempotencyKey !== input.idempotencyKey ||
      admission.correlationId !== input.correlationId ||
      admission.status !== "active" ||
      !HASH_PATTERN.test(admission.requestSha256)
    ) {
      throw occurrenceConflict("Heartbeat admission callback returned non-exact admission authority.");
    }
  }

  private requireDurableBindingEvidence(
    row: HeartbeatOccurrenceRow,
    input: HeartbeatOccurrenceBoundIdentity,
    requireActive: boolean,
  ): void {
    this.mutationAdmissions.requireExactDurableTurnPayloadIdentity({
      admissionId: row.admission_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      sessionIncarnationId: row.session_incarnation_id,
      turnId: row.turn_id,
      durableRunId: input.durableRunId,
    });
    const evidence = this.db
      .prepare(
        `SELECT binding.durable_run_id, profile_binding.profile_id, profile_binding.profile_hash,
                admission.status AS admission_status, admission.material_sha256,
                admission.request_sha256 AS admission_request_sha256,
                run.status AS run_status, run.workflow_key, run.payload_json,
                trace.user_message_id, trace.assistant_message_id, trace.session_id AS trace_session_id
         FROM chat_turn_mutation_admission_durable_bindings binding
         JOIN chat_turn_capability_profile_incarnation_bindings profile_binding
           ON profile_binding.turn_id = binding.turn_id
         JOIN chat_session_mutation_admissions admission ON admission.admission_id = binding.admission_id
         JOIN durable_runs run ON run.run_id = binding.durable_run_id
         JOIN chat_turn_traces trace ON trace.turn_id = binding.turn_id
         WHERE binding.admission_id = @admissionId AND binding.turn_id = @turnId
           AND binding.workspace_id = @workspaceId AND binding.session_id = @sessionId
           AND binding.session_incarnation_id = @sessionIncarnationId
           AND binding.durable_run_id = @durableRunId
           AND profile_binding.profile_id = @capabilityProfileId
           AND profile_binding.profile_hash = @capabilityProfileHash${this.db.dialect === "postgres" ? " FOR UPDATE OF binding, profile_binding, admission, run, trace" : ""}`,
      )
      .get<{
        durable_run_id: string;
        profile_id: string;
        profile_hash: string;
        admission_status: string;
        material_sha256: string;
        admission_request_sha256: string;
        run_status: string;
        workflow_key: string;
        payload_json: string;
        user_message_id: string;
        assistant_message_id: string | null;
        trace_session_id: string;
      }>({
        admissionId: input.admissionId,
        turnId: input.turnId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sessionIncarnationId: input.sessionIncarnationId,
        durableRunId: input.durableRunId,
        capabilityProfileId: input.capabilityProfileId,
        capabilityProfileHash: input.capabilityProfileHash,
      });
    const payload = evidence ? parseObject(evidence.payload_json) : undefined;
    const requestActor = payload ? parseUnknownObject(payload.requestActor) : undefined;
    const persistedTranscriptMessage = this.db
      .prepare(
        `SELECT message_id FROM chat_messages
         WHERE message_id IN (@userMessageId, @assistantMessageId) LIMIT 1${
           this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<{ message_id: string }>({
        userMessageId: row.user_message_id,
        assistantMessageId: row.assistant_message_id,
      });
    if (
      !evidence ||
      Boolean(persistedTranscriptMessage) ||
      (requireActive && evidence.admission_status !== "active") ||
      (requireActive && !["queued", "running", "waiting", "paused"].includes(evidence.run_status)) ||
      evidence.material_sha256 !== row.admission_material_sha256 ||
      evidence.admission_request_sha256 !== row.admission_request_sha256 ||
      evidence.workflow_key !== "chat.turn.execute" ||
      !payload ||
      payload.version !== "chat.turn.execute.v2" ||
      payload.heartbeatOccurrenceId !== row.occurrence_id ||
      payload.heartbeatClaimSha256 !== row.claim_sha256 ||
      payload.heartbeatEvaluatedPolicySha256 !== row.evaluated_policy_sha256 ||
      payload.heartbeatFrozenObjectiveSha256 !== row.frozen_objective_sha256 ||
      payload.admissionId !== row.admission_id ||
      payload.admissionMaterialSha256 !== row.admission_material_sha256 ||
      payload.workspaceId !== row.workspace_id ||
      payload.admissionAggregateRevision !== asPositiveInteger(row.aggregate_revision) ||
      payload.admissionControllerGeneration !== asPositiveInteger(row.controller_generation) ||
      payload.sessionId !== row.session_id ||
      payload.sessionIncarnationId !== row.session_incarnation_id ||
      payload.turnId !== row.turn_id ||
      payload.userMessageId !== row.user_message_id ||
      payload.assistantMessageId !== row.assistant_message_id ||
      payload.capabilityProfileId !== input.capabilityProfileId ||
      payload.capabilityProfileHash !== input.capabilityProfileHash ||
      !requestActor ||
      canonicalJsonString(Object.keys(requestActor).sort()) !== canonicalJsonString(["actorId", "actorKind"]) ||
      requestActor.actorKind !== "system" ||
      requestActor.actorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
      evidence.user_message_id !== row.user_message_id ||
      evidence.assistant_message_id !== row.assistant_message_id ||
      evidence.trace_session_id !== row.session_id
    ) {
      throw occurrenceConflict("Heartbeat durable binding lacks exact admission, profile, run, or trace evidence.");
    }
  }

  private readTerminalEvidence(
    row: HeartbeatOccurrenceRow,
  ): { status: "completed" | "failed" | "cancelled" | "dead_lettered"; handoffSha256: string } | undefined {
    if (!row.durable_run_id) return undefined;
    const verificationInput: VerifyTerminalTurnWriteHandoffInput = {
      admissionId: row.admission_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      sessionIncarnationId: row.session_incarnation_id,
      turnId: row.turn_id,
      durableRunId: row.durable_run_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
    };
    const evidence: VerifiedTerminalTurnWriteHandoff | undefined =
      this.mutationAdmissions.findVerifiedTerminalTurnWriteHandoff(verificationInput);
    return evidence ? { status: evidence.durableRunStatus, handoffSha256: evidence.handoffSha256 } : undefined;
  }

  private requireAbandonEvidence(row: HeartbeatOccurrenceRow, reason: HeartbeatOccurrenceAbandonReason): void {
    const evidence = this.db
      .prepare(
        `SELECT status, terminal_authority_kind
         FROM chat_session_mutation_admissions WHERE admission_id = @admissionId${
           this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<{ status: string; terminal_authority_kind: string | null }>({ admissionId: row.admission_id });
    const binding = this.db
      .prepare("SELECT 1 FROM chat_turn_mutation_admission_durable_bindings WHERE admission_id = @admissionId")
      .get({ admissionId: row.admission_id });
    const reasonMatches =
      reason === "authority_drift"
        ? evidence?.terminal_authority_kind === "authority_superseded"
        : reason === "lifecycle_drift"
          ? evidence?.terminal_authority_kind === "lifecycle_delete"
          : evidence?.terminal_authority_kind === "expired_recovery" ||
            evidence?.terminal_authority_kind === "request_runtime";
    if (!evidence || evidence.status === "active" || binding || !reasonMatches) {
      throw occurrenceConflict("Heartbeat abandonment lacks exact closed pre-bind admission evidence.");
    }
  }

  private readDatabaseTime(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get<{ now: string }>();
    if (!row?.now) throw new TypeError("database clock did not return a timestamp");
    return row.now;
  }

  private acquireSessionLock(sessionId: string): void {
    if (this.db.dialect === "postgres") {
      this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@sessionId, 411))").get({ sessionId });
    }
  }
}

interface HeartbeatOccurrenceRow {
  occurrence_id: string;
  workspace_id: string;
  session_id: string;
  session_incarnation_id: string;
  admission_id: string;
  admission_request_sha256: string;
  admission_idempotency_key: string;
  admission_correlation_id: string;
  runtime_owner_id: string;
  system_actor_id: typeof HEARTBEAT_SYSTEM_ACTOR_ID;
  admission_material_sha256: string;
  evaluated_policy_sha256: string;
  frozen_request_sha256: string;
  frozen_objective_sha256: string;
  claim_sha256: string;
  aggregate_revision: number | bigint | string;
  controller_generation: number | bigint | string;
  prior_last_proactive_at: string | null;
  prior_last_proactive_run_id: string | null;
  heartbeat_interval_seconds: number | bigint | string;
  cooldown_seconds: number | bigint | string;
  idle_floor_seconds: number | bigint | string;
  observed_session_activity_at: string;
  user_message_id: string;
  assistant_message_id: string;
  turn_id: string;
  expected_durable_run_id: string;
  durable_run_id: string | null;
  capability_profile_id: string | null;
  capability_profile_hash: string | null;
  state: HeartbeatOccurrenceState;
  revision: number | bigint | string;
  claimed_at: string;
  durable_bound_at: string | null;
  terminal_at: string | null;
  abandoned_at: string | null;
  terminal_status: "completed" | "failed" | "cancelled" | null;
  terminal_handoff_sha256: string | null;
  abandonment_reason: HeartbeatOccurrenceAbandonReason | null;
  updated_at: string;
}

interface SessionAuthority {
  sessionIncarnationId: string;
  aggregateRevision: number;
  controllerGeneration: number;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function normalizeClaimInput(input: ClaimHeartbeatOccurrenceInput) {
  if (
    !input.expectedPriorCadence ||
    typeof input.expectedPriorCadence !== "object" ||
    Array.isArray(input.expectedPriorCadence)
  ) {
    throw new ValidationError({ field: "expectedPriorCadence" });
  }
  const rawExpectedAt = (input.expectedPriorCadence as { lastProactiveAt?: unknown }).lastProactiveAt;
  const rawExpectedRunId = (input.expectedPriorCadence as { lastProactiveRunId?: unknown }).lastProactiveRunId;
  if (rawExpectedAt !== undefined && typeof rawExpectedAt !== "string") {
    throw new ValidationError({ field: "expectedPriorCadence.lastProactiveAt" });
  }
  if (rawExpectedRunId !== undefined && typeof rawExpectedRunId !== "string") {
    throw new ValidationError({ field: "expectedPriorCadence.lastProactiveRunId" });
  }
  const expectedAt =
    rawExpectedAt === undefined ? undefined : timestamp(rawExpectedAt, "expectedPriorCadence.lastProactiveAt");
  const expectedRunId =
    rawExpectedRunId === undefined
      ? undefined
      : identifier(rawExpectedRunId, "expectedPriorCadence.lastProactiveRunId");
  if (Boolean(expectedAt) !== Boolean(expectedRunId)) {
    throw new ValidationError({ field: "expectedPriorCadence" });
  }
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    expectedPriorCadence: { lastProactiveAt: expectedAt, lastProactiveRunId: expectedRunId },
    evaluatedPolicySha256: digest(input.evaluatedPolicySha256, "evaluatedPolicySha256"),
    frozenRequestSha256: digest(input.frozenRequestSha256, "frozenRequestSha256"),
    frozenObjectiveSha256: digest(input.frozenObjectiveSha256, "frozenObjectiveSha256"),
    idleFloorSeconds: integer(input.idleFloorSeconds, "idleFloorSeconds", 0, 86_400),
  };
}

function normalizeExactIdentity(input: HeartbeatOccurrenceExactIdentity): HeartbeatOccurrenceExactIdentity {
  return {
    occurrenceId: identifier(input.occurrenceId, "occurrenceId"),
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    sessionIncarnationId: identifier(input.sessionIncarnationId, "sessionIncarnationId", 320),
    admissionId: identifier(input.admissionId, "admissionId"),
    turnId: identifier(input.turnId, "turnId"),
    durableRunId: identifier(input.durableRunId, "durableRunId"),
  };
}

function normalizeBoundIdentity(input: HeartbeatOccurrenceBoundIdentity): HeartbeatOccurrenceBoundIdentity {
  return {
    ...normalizeExactIdentity(input),
    capabilityProfileId: identifier(input.capabilityProfileId, "capabilityProfileId"),
    capabilityProfileHash: digest(input.capabilityProfileHash, "capabilityProfileHash"),
  };
}

function normalizeAbandonInput(input: AbandonHeartbeatOccurrenceInput): AbandonHeartbeatOccurrenceInput {
  if (!(["admission_closed", "authority_drift", "lifecycle_drift"] as const).includes(input.reason)) {
    throw new ValidationError({ field: "reason" });
  }
  return { ...normalizeExactIdentity(input), reason: input.reason };
}

function assertExactIdentity(row: HeartbeatOccurrenceRow, input: HeartbeatOccurrenceExactIdentity): void {
  if (
    row.occurrence_id !== input.occurrenceId ||
    row.workspace_id !== input.workspaceId ||
    row.session_id !== input.sessionId ||
    row.session_incarnation_id !== input.sessionIncarnationId ||
    row.admission_id !== input.admissionId ||
    row.turn_id !== input.turnId ||
    row.expected_durable_run_id !== input.durableRunId
  ) {
    throw occurrenceConflict("Heartbeat occurrence identity conflicts with frozen authority.");
  }
}

function assertBoundIdentity(row: HeartbeatOccurrenceRow, input: HeartbeatOccurrenceBoundIdentity): void {
  if (
    row.durable_run_id !== input.durableRunId ||
    row.capability_profile_id !== input.capabilityProfileId ||
    row.capability_profile_hash !== input.capabilityProfileHash
  ) {
    throw occurrenceConflict("Heartbeat durable binding identity conflicts.");
  }
}

function mapRow(row: HeartbeatOccurrenceRow): HeartbeatOccurrenceRecord {
  return {
    occurrenceId: row.occurrence_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    sessionIncarnationId: row.session_incarnation_id,
    admissionId: row.admission_id,
    admissionRequestSha256: row.admission_request_sha256,
    admissionIdempotencyKey: row.admission_idempotency_key,
    admissionCorrelationId: row.admission_correlation_id,
    runtimeOwnerId: row.runtime_owner_id,
    systemActorId: row.system_actor_id,
    admissionMaterialSha256: row.admission_material_sha256,
    evaluatedPolicySha256: row.evaluated_policy_sha256,
    frozenRequestSha256: row.frozen_request_sha256,
    frozenObjectiveSha256: row.frozen_objective_sha256,
    claimSha256: row.claim_sha256,
    aggregateRevision: asPositiveInteger(row.aggregate_revision),
    controllerGeneration: asPositiveInteger(row.controller_generation),
    priorCadence: {
      ...(row.prior_last_proactive_at ? { lastProactiveAt: row.prior_last_proactive_at } : {}),
      ...(row.prior_last_proactive_run_id ? { lastProactiveRunId: row.prior_last_proactive_run_id } : {}),
    },
    heartbeatIntervalSeconds: asNonNegativeInteger(row.heartbeat_interval_seconds),
    cooldownSeconds: asNonNegativeInteger(row.cooldown_seconds),
    idleFloorSeconds: asNonNegativeInteger(row.idle_floor_seconds),
    observedSessionActivityAt: row.observed_session_activity_at,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    turnId: row.turn_id,
    durableRunId: row.expected_durable_run_id,
    ...(row.durable_run_id ? { boundDurableRunId: row.durable_run_id } : {}),
    ...(row.capability_profile_id ? { capabilityProfileId: row.capability_profile_id } : {}),
    ...(row.capability_profile_hash ? { capabilityProfileHash: row.capability_profile_hash } : {}),
    state: row.state,
    revision: asPositiveInteger(row.revision),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
    ...(row.durable_bound_at ? { durableBoundAt: row.durable_bound_at } : {}),
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    ...(row.abandoned_at ? { abandonedAt: row.abandoned_at } : {}),
    ...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
    ...(row.terminal_handoff_sha256 ? { terminalHandoffSha256: row.terminal_handoff_sha256 } : {}),
    ...(row.abandonment_reason ? { abandonmentReason: row.abandonment_reason } : {}),
  };
}

function parseObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseUnknownObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isWithinActiveHours(databaseNow: string, prefs: SessionAutonomyPrefsRecord): boolean {
  const hour = new Date(databaseNow).getHours();
  const { start, end } = prefs.activeHours;
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function elapsedSeconds(from: string, to: string): number {
  const elapsed = Math.floor((Date.parse(to) - Date.parse(from)) / 1000);
  return Number.isFinite(elapsed) ? elapsed : -1;
}

function identifier(value: string, field: string, maxLength = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ValidationError({ field });
  return normalized;
}

function digest(value: string, field: string): string {
  if (!HASH_PATTERN.test(value)) throw new ValidationError({ field });
  return value;
}

function timestamp(value: string, field: string): string {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new ValidationError({ field });
  return value;
}

function integer(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidationError({ field });
  return value;
}

function asPositiveInteger(value: number | bigint | string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError("Expected a positive integer.");
  return normalized;
}

function asNonNegativeInteger(value: number | bigint | string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new TypeError("Expected a non-negative integer.");
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function derivedId(prefix: string, digestValue: string): string {
  return `${prefix}_${digestValue}`;
}

function occurrenceConflict(message: string): ConflictError {
  return new ConflictError({ code: "STATE_CONFLICT", message });
}
