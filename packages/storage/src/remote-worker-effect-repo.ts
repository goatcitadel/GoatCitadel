import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION,
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  REMOTE_WORKER_SETTLEMENT_GENESIS_SHA256,
  ValidationError,
  canonicalJsonString,
  normalizeRemoteWorkerEffectCorrelation,
  normalizeRemoteWorkerEffectIntent,
  normalizeRemoteWorkerSettlementIdentity,
  remoteWorkerEffectCanTransition,
  remoteWorkerEffectCorrelationSha256,
  remoteWorkerEffectIntentSha256,
  remoteWorkerEffectReceiptIsManual,
  remoteWorkerEffectTransitionSha256,
  type RemoteWorkerEffectCorrelation,
  type RemoteWorkerEffectReceiptState,
  type RemoteWorkerEffectTransitionState,
  type RemoteWorkerSettlementIdentity,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface RemoteWorkerEffectIntentRecord {
  identity: RemoteWorkerSettlementIdentity;
  intentId: string;
  intentIndex: number;
  effectSelector: string;
  canonicalArgsSha256: string;
  intentSha256: string;
  workerIdempotencyKey: string;
  recordedAt: string;
}

export interface RemoteWorkerEffectTransitionRecord {
  intentId: string;
  transitionSequence: number;
  transitionState: RemoteWorkerEffectTransitionState;
  correlationSha256: string;
  transitionSha256: string;
  recordedAt: string;
}

export interface RemoteWorkerEffectReceiptRecord {
  intentId: string;
  receiptState: RemoteWorkerEffectReceiptState;
  receiptRevision: number;
  finalTransitionSequence: number;
  finalTransitionSha256: string;
  hx305OutcomeSha256: string | null;
  reconciliationRecordSha256: string | null;
}

export interface RecordRemoteWorkerEffectIntentCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  intentIndex: number;
  effectSelector: string;
  canonicalArgs: unknown;
  workerIdempotencyKey: string;
  idempotencyKey: string;
}

export interface AppendRemoteWorkerEffectTransitionCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  intentId: string;
  correlation: RemoteWorkerEffectCorrelation;
  idempotencyKey: string;
}

export interface RecordRemoteWorkerEffectReceiptCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  intentId: string;
  receiptState: RemoteWorkerEffectReceiptState;
  finalTransitionSequence: number;
  finalTransitionSha256: string;
  hx305OutcomeSha256: string | null;
  idempotencyKey: string;
}

export interface AdvanceRemoteWorkerEffectReceiptCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  intentId: string;
  expectedReceiptRevision: number;
  nextState: Exclude<RemoteWorkerEffectReceiptState, "manual_reconciliation">;
  reconciliationRecordSha256: string;
  finalTransitionSequence: number;
  finalTransitionSha256: string;
  hx305OutcomeSha256: string | null;
}

interface GenerationIdentityRow {
  registry_workspace_id: string;
  execution_workspace_id: string;
  assignment_id: string;
  assignment_generation: number;
  worker_id: string;
  worker_generation: number;
  runtime_manifest_sha256: string;
  workspace_ceiling_sha256: string;
  capability_ceiling_sha256: string;
  assignment_manifest_sha256: string;
}

interface IntentRow extends GenerationIdentityRow {
  intent_id: string;
  intent_index: number;
  effect_selector: string;
  canonical_args_sha256: string;
  intent_sha256: string;
  worker_idempotency_key: string;
  recorded_at: string;
}

interface TransitionRow {
  intent_id: string;
  transition_sequence: number;
  transition_state: RemoteWorkerEffectTransitionState;
  correlation_sha256: string;
  transition_sha256: string;
  recorded_at: string;
}

interface ReceiptRow {
  intent_id: string;
  receipt_state: RemoteWorkerEffectReceiptState;
  receipt_revision: number;
  final_transition_sequence: number;
  final_transition_sha256: string;
  hx305_outcome_sha256: string | null;
  reconciliation_record_sha256: string | null;
}

export class RemoteWorkerEffectRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public recordIntent(input: RecordRemoteWorkerEffectIntentCommand): RemoteWorkerEffectIntentRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    const canonicalArgsJson = canonicalJsonString(input.canonicalArgs ?? {});
    if (canonicalArgsJson.length > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectArgsBytes) {
      throw new ValidationError({ field: "canonicalArgs", message: "Remote worker effect args exceed the bound." });
    }
    const canonicalArgsSha256 = sha256Utf8(canonicalArgsJson);
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const identity = this.resolveIdentity(registryWorkspaceId, assignmentId, assignmentGeneration);
      const intent = normalizeRemoteWorkerEffectIntent({
        schemaVersion: REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION,
        identity,
        intentIndex: input.intentIndex,
        effectSelector: input.effectSelector,
        canonicalArgsSha256,
        workerIdempotencyKey: input.workerIdempotencyKey,
      });
      const intentSha256 = remoteWorkerEffectIntentSha256(intent);
      const replay = this.findIntentByIdempotency(registryWorkspaceId, idempotencyKey);
      if (replay) {
        assertExactReplay(replay.intent_sha256, intentSha256, "remote worker effect intent");
        return this.mapIntent(replay);
      }
      const intentId = deriveServerId(
        "rw-effect-intent",
        registryWorkspaceId,
        assignmentId,
        String(assignmentGeneration),
        String(intent.intentIndex),
      );
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_effect_intents (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, intent_id, intent_index, effect_selector, canonical_args_json,
              canonical_args_sha256, intent_sha256, worker_idempotency_key, idempotency_key, request_sha256, recorded_at
            ) VALUES (
              @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
              @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @assignmentManifestSha256, @intentId, @intentIndex, @effectSelector, @canonicalArgsJson,
              @canonicalArgsSha256, @intentSha256, @workerIdempotencyKey, @idempotencyKey, @requestSha256, @now
            )`,
          )
          .run({
            ...identityParams(identity),
            intentId,
            intentIndex: intent.intentIndex,
            effectSelector: intent.effectSelector,
            canonicalArgsJson,
            canonicalArgsSha256,
            intentSha256,
            workerIdempotencyKey: intent.workerIdempotencyKey,
            idempotencyKey,
            requestSha256: intentSha256,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker effect intent");
      }
      return this.mapIntent(this.getIntentRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId));
    });
  }

  public appendTransition(input: AppendRemoteWorkerEffectTransitionCommand): RemoteWorkerEffectTransitionRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const intentId = identifier(input.intentId, "intentId");
    const correlation = normalizeRemoteWorkerEffectCorrelation(input.correlation);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const intent = this.getIntentRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId);
      const identity = this.identityFromRow(intent);
      const replay = this.findTransitionByIdempotency(registryWorkspaceId, idempotencyKey);
      const correlationSha256 = remoteWorkerEffectCorrelationSha256(correlation);
      if (replay) {
        assertExactReplay(replay.correlation_sha256, correlationSha256, "remote worker effect transition");
        return this.mapTransition(replay);
      }
      const previous = this.getLastTransition(registryWorkspaceId, assignmentId, assignmentGeneration, intentId);
      const nextSequence = (previous?.transition_sequence ?? 0) + 1;
      if (nextSequence > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectTransitions) {
        throw conflict("remote worker effect transition bound");
      }
      const previousTransitionSha256 = previous?.transition_sha256 ?? REMOTE_WORKER_SETTLEMENT_GENESIS_SHA256;
      const fromState: RemoteWorkerEffectTransitionState = previous ? previous.transition_state : "recorded";
      if (previous && !remoteWorkerEffectCanTransition(fromState, correlation.transitionState)) {
        throw conflict("remote worker effect transition state");
      }
      if (!previous && correlation.transitionState !== "recorded") {
        throw conflict("remote worker effect transition genesis");
      }
      const intentSha256 = intent.intent_sha256;
      const transitionSha256 = remoteWorkerEffectTransitionSha256({
        intentSha256,
        transitionSequence: nextSequence,
        correlationSha256,
        previousTransitionSha256,
      });
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_effect_transitions (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, intent_id, transition_sequence, transition_state, correlation_json,
              correlation_sha256, external_side_effect_run_id, hx305_outcome_sha256, previous_transition_sha256,
              transition_sha256, idempotency_key, request_sha256, recorded_at
            ) VALUES (
              @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
              @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @assignmentManifestSha256, @intentId, @transitionSequence, @transitionState, @correlationJson,
              @correlationSha256, @externalSideEffectRunId, @hx305OutcomeSha256, @previousTransitionSha256,
              @transitionSha256, @idempotencyKey, @requestSha256, @now
            )`,
          )
          .run({
            ...identityParams(identity),
            intentId,
            transitionSequence: nextSequence,
            transitionState: correlation.transitionState,
            correlationJson: canonicalJsonString(correlation),
            correlationSha256,
            externalSideEffectRunId: correlation.externalSideEffectRunId,
            hx305OutcomeSha256: correlation.hx305OutcomeSha256,
            previousTransitionSha256,
            transitionSha256,
            idempotencyKey,
            requestSha256: transitionSha256,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker effect transition");
      }
      return this.mapTransition(
        this.getTransitionRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId, nextSequence),
      );
    });
  }

  public recordReceipt(input: RecordRemoteWorkerEffectReceiptCommand): RemoteWorkerEffectReceiptRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const intentId = identifier(input.intentId, "intentId");
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    const finalTransitionSha256 = digest(input.finalTransitionSha256, "finalTransitionSha256");
    const finalTransitionSequence = boundedInteger(
      input.finalTransitionSequence,
      "finalTransitionSequence",
      1,
      REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectTransitions,
    );
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const intent = this.getIntentRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId);
      const identity = this.identityFromRow(intent);
      const existing = this.findReceipt(registryWorkspaceId, assignmentId, assignmentGeneration, intentId);
      if (existing) {
        assertExactReplay(existing.final_transition_sha256, finalTransitionSha256, "remote worker effect receipt");
        return this.mapReceipt(existing);
      }
      // The receipt must bind an existing terminal transition for this intent.
      const transition = this.getTransitionRow(
        registryWorkspaceId,
        assignmentId,
        assignmentGeneration,
        intentId,
        finalTransitionSequence,
      );
      if (
        transition.transition_sha256 !== finalTransitionSha256 ||
        transition.transition_state !== input.receiptState
      ) {
        throw conflict("remote worker effect receipt transition");
      }
      if (input.receiptState === "completed_with_effect" && input.hx305OutcomeSha256 === null) {
        throw conflict("remote worker effect receipt hx305");
      }
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_effect_receipts (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, intent_id, receipt_state, receipt_revision, final_transition_sequence,
              final_transition_sha256, hx305_outcome_sha256, reconciliation_record_sha256, idempotency_key,
              request_sha256, created_at, updated_at
            ) VALUES (
              @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
              @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @assignmentManifestSha256, @intentId, @receiptState, 1, @finalTransitionSequence,
              @finalTransitionSha256, @hx305OutcomeSha256, NULL, @idempotencyKey, @requestSha256, @now, @now
            )`,
          )
          .run({
            ...identityParams(identity),
            intentId,
            receiptState: input.receiptState,
            finalTransitionSequence,
            finalTransitionSha256,
            hx305OutcomeSha256:
              input.hx305OutcomeSha256 === null ? null : digest(input.hx305OutcomeSha256, "hx305OutcomeSha256"),
            idempotencyKey,
            requestSha256: finalTransitionSha256,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker effect receipt");
      }
      return this.mapReceipt(this.getReceiptRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId));
    });
  }

  public advanceReceipt(input: AdvanceRemoteWorkerEffectReceiptCommand): RemoteWorkerEffectReceiptRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const intentId = identifier(input.intentId, "intentId");
    const expectedReceiptRevision = positiveInteger(input.expectedReceiptRevision, "expectedReceiptRevision");
    const reconciliationRecordSha256 = digest(input.reconciliationRecordSha256, "reconciliationRecordSha256");
    const finalTransitionSha256 = digest(input.finalTransitionSha256, "finalTransitionSha256");
    const finalTransitionSequence = boundedInteger(
      input.finalTransitionSequence,
      "finalTransitionSequence",
      1,
      REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectTransitions,
    );
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const receipt = this.getReceiptRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId);
      if (receipt.receipt_revision !== expectedReceiptRevision) throw conflict("remote worker effect receipt revision");
      if (!remoteWorkerEffectReceiptIsManual(receipt.receipt_state))
        throw conflict("remote worker effect receipt manual");
      const transition = this.getTransitionRow(
        registryWorkspaceId,
        assignmentId,
        assignmentGeneration,
        intentId,
        finalTransitionSequence,
      );
      if (transition.transition_sha256 !== finalTransitionSha256 || transition.transition_state !== input.nextState) {
        throw conflict("remote worker effect receipt resolution transition");
      }
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `UPDATE remote_worker_effect_receipts
             SET receipt_state = @nextState, receipt_revision = receipt_revision + 1,
                 final_transition_sequence = @finalTransitionSequence, final_transition_sha256 = @finalTransitionSha256,
                 hx305_outcome_sha256 = @hx305OutcomeSha256, reconciliation_record_sha256 = @reconciliationRecordSha256,
                 updated_at = @now
             WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
               AND assignment_generation = @assignmentGeneration AND intent_id = @intentId`,
          )
          .run({
            registryWorkspaceId,
            assignmentId,
            assignmentGeneration,
            intentId,
            nextState: input.nextState,
            finalTransitionSequence,
            finalTransitionSha256,
            hx305OutcomeSha256:
              input.hx305OutcomeSha256 === null ? null : digest(input.hx305OutcomeSha256, "hx305OutcomeSha256"),
            reconciliationRecordSha256,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker effect receipt");
      }
      return this.mapReceipt(this.getReceiptRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId));
    });
  }

  public getReceipt(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    intentId: string,
  ): RemoteWorkerEffectReceiptRecord {
    return this.mapReceipt(this.getReceiptRow(registryWorkspaceId, assignmentId, assignmentGeneration, intentId));
  }

  public listIntents(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): RemoteWorkerEffectIntentRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM remote_worker_effect_intents
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration ORDER BY intent_index ASC`,
        )
        .all({ registryWorkspaceId, assignmentId, assignmentGeneration }) as IntentRow[]
    ).map((row) => this.mapIntent(row));
  }

  // --- internals ------------------------------------------------------------

  private resolveIdentity(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): RemoteWorkerSettlementIdentity {
    const row = this.db
      .prepare(
        `SELECT g.registry_workspace_id, g.execution_workspace_id, g.assignment_id, g.assignment_generation,
                g.worker_id, g.worker_generation, g.runtime_manifest_sha256, g.workspace_ceiling_sha256,
                g.capability_ceiling_sha256, a.manifest_sha256 AS assignment_manifest_sha256
         FROM remote_worker_assignment_generations g
         JOIN remote_worker_assignments a
           ON a.registry_workspace_id = g.registry_workspace_id AND a.assignment_id = g.assignment_id
         WHERE g.registry_workspace_id = @registryWorkspaceId AND g.assignment_id = @assignmentId
           AND g.assignment_generation = @assignmentGeneration`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration }) as GenerationIdentityRow | undefined;
    if (!row) throw unavailable("remote worker assignment generation");
    return this.identityFromRow(row);
  }

  private identityFromRow(row: GenerationIdentityRow): RemoteWorkerSettlementIdentity {
    return normalizeRemoteWorkerSettlementIdentity({
      registryWorkspaceId: row.registry_workspace_id,
      executionWorkspaceId: row.execution_workspace_id,
      assignmentId: row.assignment_id,
      assignmentGeneration: asPositiveInteger(row.assignment_generation),
      workerId: row.worker_id,
      workerGeneration: asPositiveInteger(row.worker_generation),
      runtimeManifestSha256: row.runtime_manifest_sha256,
      workspaceCeilingSha256: row.workspace_ceiling_sha256,
      capabilityCeilingSha256: row.capability_ceiling_sha256,
      assignmentManifestSha256: row.assignment_manifest_sha256,
    });
  }

  private getIntentRow(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    intentId: string,
  ): IntentRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_effect_intents
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND intent_id = @intentId`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration, intentId }) as IntentRow | undefined;
    if (!row) throw unavailable("remote worker effect intent");
    return row;
  }

  private getLastTransition(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    intentId: string,
  ): TransitionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_effect_transitions
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND intent_id = @intentId
         ORDER BY transition_sequence DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration, intentId }) as TransitionRow | undefined;
  }

  private getTransitionRow(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    intentId: string,
    transitionSequence: number,
  ): TransitionRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_effect_transitions
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND intent_id = @intentId AND transition_sequence = @transitionSequence`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration, intentId, transitionSequence }) as
      | TransitionRow
      | undefined;
    if (!row) throw unavailable("remote worker effect transition");
    return row;
  }

  private getReceiptRow(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    intentId: string,
  ): ReceiptRow {
    const row = this.findReceipt(registryWorkspaceId, assignmentId, assignmentGeneration, intentId);
    if (!row) throw unavailable("remote worker effect receipt");
    return row;
  }

  private findReceipt(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    intentId: string,
  ): ReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_effect_receipts
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND intent_id = @intentId`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration, intentId }) as ReceiptRow | undefined;
  }

  private findIntentByIdempotency(registryWorkspaceId: string, idempotencyKey: string): IntentRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_effect_intents WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as IntentRow | undefined;
  }

  private findTransitionByIdempotency(registryWorkspaceId: string, idempotencyKey: string): TransitionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_effect_transitions WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as TransitionRow | undefined;
  }

  private mapIntent(row: IntentRow): RemoteWorkerEffectIntentRecord {
    return {
      identity: this.identityFromRow(row),
      intentId: row.intent_id,
      intentIndex: asNonNegativeInteger(row.intent_index),
      effectSelector: row.effect_selector,
      canonicalArgsSha256: row.canonical_args_sha256,
      intentSha256: row.intent_sha256,
      workerIdempotencyKey: row.worker_idempotency_key,
      recordedAt: row.recorded_at,
    };
  }

  private mapTransition(row: TransitionRow): RemoteWorkerEffectTransitionRecord {
    return {
      intentId: row.intent_id,
      transitionSequence: asPositiveInteger(row.transition_sequence),
      transitionState: row.transition_state,
      correlationSha256: row.correlation_sha256,
      transitionSha256: row.transition_sha256,
      recordedAt: row.recorded_at,
    };
  }

  private mapReceipt(row: ReceiptRow): RemoteWorkerEffectReceiptRecord {
    return {
      intentId: row.intent_id,
      receiptState: row.receipt_state,
      receiptRevision: asPositiveInteger(row.receipt_revision),
      finalTransitionSequence: asPositiveInteger(row.final_transition_sequence),
      finalTransitionSha256: row.final_transition_sha256,
      hx305OutcomeSha256: row.hx305_outcome_sha256,
      reconciliationRecordSha256: row.reconciliation_record_sha256,
    };
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

  private acquireGenerationLocks(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId, 501)) AS locked")
      .get({ registryWorkspaceId });
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
}

function identityParams(identity: RemoteWorkerSettlementIdentity): Record<string, unknown> {
  return {
    registryWorkspaceId: identity.registryWorkspaceId,
    executionWorkspaceId: identity.executionWorkspaceId,
    assignmentId: identity.assignmentId,
    assignmentGeneration: identity.assignmentGeneration,
    workerId: identity.workerId,
    workerGeneration: identity.workerGeneration,
    runtimeManifestSha256: identity.runtimeManifestSha256,
    workspaceCeilingSha256: identity.workspaceCeilingSha256,
    capabilityCeilingSha256: identity.capabilityCeilingSha256,
    assignmentManifestSha256: identity.assignmentManifestSha256,
  };
}

function deriveServerId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${sha256Utf8(canonicalJsonString(parts)).slice(0, 48)}`;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
    throw new ValidationError({ field, message: `Remote worker settlement ${field} is invalid.` });
  }
  return value;
}

function digest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ValidationError({
      field,
      message: `Remote worker settlement ${field} must be a lower-case SHA-256 digest.`,
    });
  }
  return value;
}

function positiveInteger(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ValidationError({ field, message: `Remote worker settlement ${field} is invalid.` });
  }
  return value;
}

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError({ field, message: `Remote worker settlement ${field} is invalid.` });
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
    message: `${label} conflicts with durable settlement authority.`,
    details: { reason: "remote_worker_settlement_conflict" },
  });
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ConflictError)
    return error;
  return conflict(label);
}

function invalidState(): Error {
  return new Error("Remote worker settlement state is invalid.");
}
