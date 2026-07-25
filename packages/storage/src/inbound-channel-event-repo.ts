import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError,
  INBOUND_CHANNEL_COMMAND_RESULT_MAX_BYTES,
  INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_BYTES,
  INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_DEPTH,
  INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_KEYS,
  PayloadTooLargeError,
  ValidationError,
  isInboundChannelEventTerminalStatus,
  type InboundChannelEventAcceptInput,
  type InboundChannelEventAcceptResult,
  type InboundChannelBotLoopDecision,
  type InboundChannelEventClaim,
  type InboundChannelEventClaimToken,
  type InboundChannelEventClaimedTransition,
  type InboundChannelEventLinkage,
  type InboundChannelEventRecord,
  type InboundChannelEventStatus,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface InboundChannelEventRow {
  sequence: number | string;
  event_id: string;
  channel_key: string;
  connection_id: string;
  transport: string;
  dispatch_kind: string;
  provider_source_id: string | null;
  idempotency_key: string;
  lane_key: string;
  payload_hash: string;
  payload_json: string;
  status: string;
  attempt_count: number | string;
  claim_generation: number | string;
  claim_token: string | null;
  claim_owner_id: string | null;
  claim_expires_at: string | null;
  claim_heartbeat_at: string | null;
  next_attempt_at: string | null;
  bot_loop_decision: string | null;
  bot_loop_reason: string | null;
  session_key: string | null;
  session_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  assistant_message_id: string | null;
  durable_run_id: string | null;
  delivery_id: string | null;
  provider_message_id: string | null;
  message_content_hash: string | null;
  delivery_payload_hash: string | null;
  command_operation_key: string | null;
  command_result_text: string | null;
  last_error: string | null;
  reconciliation_reason: string | null;
  received_at: string;
  accepted_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface NormalizedAcceptance {
  eventId: string;
  channelKey: string;
  connectionId: string;
  transport: string;
  dispatchKind: InboundChannelEventRecord["dispatchKind"];
  providerSourceId: string | null;
  idempotencyKey: string;
  laneKey: string;
  payloadJson: string;
  payloadHash: string;
  receivedAt: string;
}

const CLAIMED_STATUSES =
  "'processing', 'message_recorded', 'command_execution_started', 'turn_admitted', 'waiting', 'reply_enqueued'";
const TERMINAL_STATUSES = "'completed', 'suppressed', 'failed', 'manual_reconciliation_required'";

export class InboundChannelEventRepository {
  private readonly databaseNowStmt;
  private readonly getStmt;
  private readonly getByIdentityStmt;
  private readonly insertStmt;
  private readonly listDueStmt;
  private readonly claimStmt;
  private readonly renewStmt;
  private readonly releaseStmt;
  private readonly beginBotLoopEvaluationStmt;
  private readonly completeBotLoopEvaluationStmt;
  private readonly transitionStmt;
  private readonly attachStmt;
  private readonly listExpiredStmt;
  private readonly recoverExpiredStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.databaseNowStmt = db.prepare(
      db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso`,
    );
    this.getStmt = db.prepare("SELECT * FROM inbound_channel_events WHERE event_id = ? LIMIT 1");
    this.getByIdentityStmt = db.prepare(`
      SELECT * FROM inbound_channel_events
      WHERE channel_key = @channelKey
        AND connection_id = @connectionId
        AND idempotency_key = @idempotencyKey
      LIMIT 1
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO inbound_channel_events (
        event_id, channel_key, connection_id, transport, dispatch_kind, provider_source_id,
        idempotency_key, lane_key,
        payload_hash, payload_json, status, attempt_count, claim_generation,
        received_at, accepted_at, updated_at
      ) VALUES (
        @eventId, @channelKey, @connectionId, @transport, @dispatchKind, @providerSourceId,
        @idempotencyKey, @laneKey,
        @payloadHash, @payloadJson, 'accepted', 0, 0,
        @receivedAt, @acceptedAt, @acceptedAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.listDueStmt = db.prepare(`
      SELECT candidate.*
      FROM inbound_channel_events AS candidate
      WHERE (
          (candidate.status IN ('accepted', 'retry_wait')
            AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= @now))
          OR (candidate.status IN (${CLAIMED_STATUSES})
            AND candidate.claim_expires_at IS NOT NULL
            AND candidate.claim_expires_at <= @now)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM inbound_channel_events AS predecessor
          WHERE predecessor.channel_key = candidate.channel_key
            AND predecessor.connection_id = candidate.connection_id
            AND predecessor.lane_key = candidate.lane_key
            AND predecessor.sequence < candidate.sequence
            AND predecessor.status NOT IN (${TERMINAL_STATUSES})
        )
      ORDER BY candidate.sequence ASC
      LIMIT @limit
    `);
    const tokenMatches = nullableMatch(db, "claim_token", "expectedClaimToken");
    const ownerMatches = nullableMatch(db, "claim_owner_id", "expectedClaimOwnerId");
    const expiryMatches = nullableMatch(db, "claim_expires_at", "expectedClaimExpiresAt");
    this.claimStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          claim_generation = @claimGeneration,
          claim_token = @claimToken,
          claim_owner_id = @ownerId,
          claim_expires_at = @claimExpiresAt,
          claim_heartbeat_at = @now,
          next_attempt_at = NULL,
          last_error = NULL,
          updated_at = @now
      WHERE event_id = @eventId
        AND status = @expectedStatus
        AND claim_generation = @expectedGeneration
        AND ${tokenMatches}
        AND ${ownerMatches}
        AND ${expiryMatches}
        AND (
          (status IN ('accepted', 'retry_wait')
            AND (next_attempt_at IS NULL OR next_attempt_at <= @now))
          OR (status IN (${CLAIMED_STATUSES})
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= @now)
        )
    `);
    this.renewStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET claim_expires_at = @claimExpiresAt,
          claim_heartbeat_at = @now,
          updated_at = @now
      WHERE event_id = @eventId
        AND status IN (${CLAIMED_STATUSES})
        AND claim_owner_id = @ownerId
        AND claim_generation = @generation
        AND claim_token = @claimToken
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > @now
    `);
    this.releaseStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET status = @status,
          claim_token = NULL,
          claim_owner_id = NULL,
          claim_expires_at = NULL,
          claim_heartbeat_at = NULL,
          next_attempt_at = @nextAttemptAt,
          last_error = @lastError,
          updated_at = @now
      WHERE event_id = @eventId
        AND status IN (${CLAIMED_STATUSES})
        AND claim_owner_id = @ownerId
        AND claim_generation = @generation
        AND claim_token = @claimToken
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > @now
    `);
    this.beginBotLoopEvaluationStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET bot_loop_decision = 'evaluating',
          bot_loop_reason = NULL,
          updated_at = @now
      WHERE event_id = @eventId
        AND status IN (${CLAIMED_STATUSES})
        AND claim_owner_id = @ownerId
        AND claim_generation = @generation
        AND claim_token = @claimToken
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > @now
        AND bot_loop_decision IS NULL
    `);
    this.completeBotLoopEvaluationStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET bot_loop_decision = @decision,
          bot_loop_reason = @reason,
          updated_at = @now
      WHERE event_id = @eventId
        AND status IN (${CLAIMED_STATUSES})
        AND claim_owner_id = @ownerId
        AND claim_generation = @generation
        AND claim_token = @claimToken
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > @now
        AND bot_loop_decision = 'evaluating'
    `);
    this.transitionStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET status = @status,
          claim_token = CASE WHEN @releaseClaim = 1 THEN NULL ELSE claim_token END,
          claim_owner_id = CASE WHEN @releaseClaim = 1 THEN NULL ELSE claim_owner_id END,
          claim_expires_at = CASE WHEN @releaseClaim = 1 THEN NULL ELSE claim_expires_at END,
          claim_heartbeat_at = CASE WHEN @releaseClaim = 1 THEN NULL ELSE @now END,
          next_attempt_at = @nextAttemptAt,
          session_key = COALESCE(@sessionKey, session_key),
          session_id = COALESCE(@sessionId, session_id),
          message_id = COALESCE(@messageId, message_id),
          turn_id = COALESCE(@turnId, turn_id),
          assistant_message_id = COALESCE(@assistantMessageId, assistant_message_id),
          durable_run_id = COALESCE(@durableRunId, durable_run_id),
          delivery_id = COALESCE(@deliveryId, delivery_id),
          provider_message_id = COALESCE(@providerMessageId, provider_message_id),
          message_content_hash = COALESCE(@messageContentHash, message_content_hash),
          delivery_payload_hash = COALESCE(@deliveryPayloadHash, delivery_payload_hash),
          command_operation_key = COALESCE(@commandOperationKey, command_operation_key),
          command_result_text = COALESCE(@commandResultText, command_result_text),
          last_error = @lastError,
          reconciliation_reason = @reconciliationReason,
          updated_at = @now,
          terminal_at = @terminalAt
      WHERE event_id = @eventId
        AND status IN (${CLAIMED_STATUSES})
        AND claim_owner_id = @ownerId
        AND claim_generation = @generation
        AND claim_token = @claimToken
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > @now
    `);
    this.attachStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET session_key = COALESCE(@sessionKey, session_key),
          session_id = COALESCE(@sessionId, session_id),
          message_id = COALESCE(@messageId, message_id),
          turn_id = COALESCE(@turnId, turn_id),
          assistant_message_id = COALESCE(@assistantMessageId, assistant_message_id),
          durable_run_id = COALESCE(@durableRunId, durable_run_id),
          delivery_id = COALESCE(@deliveryId, delivery_id),
          provider_message_id = COALESCE(@providerMessageId, provider_message_id),
          message_content_hash = COALESCE(@messageContentHash, message_content_hash),
          delivery_payload_hash = COALESCE(@deliveryPayloadHash, delivery_payload_hash),
          command_operation_key = COALESCE(@commandOperationKey, command_operation_key),
          command_result_text = COALESCE(@commandResultText, command_result_text),
          updated_at = @now
      WHERE event_id = @eventId
        AND status IN (${CLAIMED_STATUSES})
        AND claim_owner_id = @ownerId
        AND claim_generation = @generation
        AND claim_token = @claimToken
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > @now
    `);
    this.listExpiredStmt = db.prepare(`
      SELECT * FROM inbound_channel_events
      WHERE status IN (${CLAIMED_STATUSES})
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at <= @now
      ORDER BY sequence ASC
      LIMIT @limit
    `);
    this.recoverExpiredStmt = db.prepare(`
      UPDATE inbound_channel_events
      SET status = CASE
            WHEN status = 'command_execution_started' THEN 'manual_reconciliation_required'
            ELSE 'retry_wait'
          END,
          claim_token = NULL,
          claim_owner_id = NULL,
          claim_expires_at = NULL,
          claim_heartbeat_at = NULL,
          next_attempt_at = CASE WHEN status = 'command_execution_started' THEN NULL ELSE @now END,
          last_error = COALESCE(
            last_error,
            CASE
              WHEN status = 'command_execution_started'
                THEN 'Command execution lease expired after crossing the local side-effect boundary.'
              ELSE 'Processing lease expired before admission completed.'
            END
          ),
          reconciliation_reason = CASE
            WHEN status = 'command_execution_started'
              THEN COALESCE(
                reconciliation_reason,
                'Command execution may have applied local side effects before settlement; automatic replay is unsafe.'
              )
            ELSE reconciliation_reason
          END,
          updated_at = @now,
          terminal_at = CASE WHEN status = 'command_execution_started' THEN @now ELSE terminal_at END
      WHERE event_id = @eventId
        AND status IN (${CLAIMED_STATUSES})
        AND claim_generation = @expectedGeneration
        AND claim_expires_at = @expectedClaimExpiresAt
        AND claim_expires_at <= @now
    `);
  }

  public get(eventId: string): InboundChannelEventRecord | undefined {
    const row = this.getStmt.get(normalizeRequired(eventId, "eventId")) as InboundChannelEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public getByIdentity(input: {
    channelKey: string;
    connectionId: string;
    idempotencyKey: string;
  }): InboundChannelEventRecord | undefined {
    const identity = normalizeIdentity(input);
    const row = this.getByIdentityStmt.get(identity) as InboundChannelEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public accept(input: InboundChannelEventAcceptInput, acceptedAt?: string): InboundChannelEventAcceptResult {
    const normalizedAcceptedAt = normalizeTimestamp(acceptedAt ?? this.readDatabaseNow(), "acceptedAt");
    const normalized = normalizeAcceptance(input, normalizedAcceptedAt);
    return this.db.transaction("immediate", () => this.acceptNormalized(normalized, normalizedAcceptedAt));
  }

  public acceptMany(
    inputs: readonly InboundChannelEventAcceptInput[],
    acceptedAt?: string,
  ): InboundChannelEventAcceptResult[] {
    const now = normalizeTimestamp(acceptedAt ?? this.readDatabaseNow(), "acceptedAt");
    const normalized = inputs.map((input) => normalizeAcceptance(input, now));
    return this.db.transaction("immediate", () => normalized.map((item) => this.acceptNormalized(item, now)));
  }

  public listDue(input: { now?: string; limit?: number } = {}): InboundChannelEventRecord[] {
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    const rows = this.listDueStmt.all({ now, limit: normalizeLimit(input.limit) }) as InboundChannelEventRow[];
    return rows.map(mapRow);
  }

  public claimDue(input: {
    ownerId: string;
    leaseDurationMs: number;
    now?: string;
    limit?: number;
  }): InboundChannelEventClaim[] {
    const ownerId = normalizeRequired(input.ownerId, "ownerId");
    const leaseDurationMs = normalizeLeaseDuration(input.leaseDurationMs);
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    const claimExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
    return this.db.transaction("immediate", () => {
      const candidates = this.listDue({ now, limit: input.limit });
      const claims: InboundChannelEventClaim[] = [];
      for (const candidate of candidates) {
        const claimToken = randomUUID();
        const generation = candidate.claimGeneration + 1;
        const claimed = this.claimStmt.run({
          eventId: candidate.eventId,
          expectedStatus: candidate.status,
          expectedGeneration: candidate.claimGeneration,
          expectedClaimToken: candidate.claimToken ?? null,
          expectedClaimOwnerId: candidate.claimOwnerId ?? null,
          expectedClaimExpiresAt: candidate.claimExpiresAt ?? null,
          claimGeneration: generation,
          claimToken,
          ownerId,
          claimExpiresAt,
          now,
        });
        if (claimed.changes === 0) {
          continue;
        }
        const event = this.get(candidate.eventId);
        if (!event) {
          throw new Error(`Claimed inbound channel event ${candidate.eventId} disappeared.`);
        }
        claims.push({ eventId: event.eventId, ownerId, generation, claimToken, event });
      }
      return claims;
    });
  }

  public renew(
    token: InboundChannelEventClaimToken,
    input: { leaseDurationMs: number; now?: string },
  ): InboundChannelEventRecord | undefined {
    const normalizedToken = normalizeClaimToken(token);
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    const claimExpiresAt = new Date(Date.parse(now) + normalizeLeaseDuration(input.leaseDurationMs)).toISOString();
    const renewed = this.renewStmt.run({ ...normalizedToken, claimExpiresAt, now });
    return renewed.changes > 0 ? this.get(normalizedToken.eventId) : undefined;
  }

  public release(
    token: InboundChannelEventClaimToken,
    input: { nextAttemptAt?: string; lastError?: string; now?: string } = {},
  ): InboundChannelEventRecord | undefined {
    const normalizedToken = normalizeClaimToken(token);
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    const nextAttemptAt = input.nextAttemptAt ? normalizeTimestamp(input.nextAttemptAt, "nextAttemptAt") : undefined;
    const released = this.releaseStmt.run({
      ...normalizedToken,
      status: nextAttemptAt ? "retry_wait" : "accepted",
      nextAttemptAt: nextAttemptAt ?? null,
      lastError: normalizeOptional(input.lastError, "lastError") ?? null,
      now,
    });
    return released.changes > 0 ? this.get(normalizedToken.eventId) : undefined;
  }

  public attachLinkage(
    token: InboundChannelEventClaimToken,
    linkage: InboundChannelEventLinkage,
    now?: string,
  ): InboundChannelEventRecord | undefined {
    const normalizedToken = normalizeClaimToken(token);
    const normalizedNow = normalizeTimestamp(now ?? this.readDatabaseNow(), "now");
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedToken.eventId);
      if (!current) {
        return undefined;
      }
      const normalizedLinkage = normalizeLinkage(linkage);
      assertLinkageCompatible(current, normalizedLinkage);
      const attached = this.attachStmt.run({
        ...normalizedToken,
        ...linkageParams(normalizedLinkage),
        now: normalizedNow,
      });
      return attached.changes > 0 ? this.get(normalizedToken.eventId) : undefined;
    });
  }

  public beginBotLoopEvaluation(
    token: InboundChannelEventClaimToken,
    now?: string,
  ): { outcome: "started" | "existing"; event: InboundChannelEventRecord } | undefined {
    const normalizedToken = normalizeClaimToken(token);
    const normalizedNow = normalizeTimestamp(now ?? this.readDatabaseNow(), "now");
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedToken.eventId);
      if (!current || !claimMatches(current, normalizedToken, normalizedNow)) {
        return undefined;
      }
      if (current.botLoopDecision !== undefined) {
        return { outcome: "existing", event: current };
      }
      const changed = this.beginBotLoopEvaluationStmt.run({ ...normalizedToken, now: normalizedNow });
      const event = changed.changes > 0 ? this.get(normalizedToken.eventId) : undefined;
      return event ? { outcome: "started", event } : undefined;
    });
  }

  public completeBotLoopEvaluation(
    token: InboundChannelEventClaimToken,
    input: { decision: Exclude<InboundChannelBotLoopDecision, "evaluating">; reason?: string },
    now?: string,
  ): InboundChannelEventRecord | undefined {
    const normalizedToken = normalizeClaimToken(token);
    const normalizedNow = normalizeTimestamp(now ?? this.readDatabaseNow(), "now");
    const decision = normalizeCompletedBotLoopDecision(input.decision);
    const reason = normalizeOptional(input.reason, "reason");
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedToken.eventId);
      if (!current || !claimMatches(current, normalizedToken, normalizedNow)) {
        return undefined;
      }
      if (current.botLoopDecision === decision) {
        if (reason !== undefined && current.botLoopReason !== reason) {
          throw new ConflictError({
            message: `Inbound channel event ${current.eventId} bot-loop decision was replayed with different evidence.`,
            details: { eventId: current.eventId, decision },
          });
        }
        return current;
      }
      if (current.botLoopDecision !== "evaluating") {
        throw new ConflictError({
          message: `Inbound channel event ${current.eventId} cannot complete bot-loop evaluation from ${current.botLoopDecision ?? "unset"}.`,
          details: { eventId: current.eventId, currentDecision: current.botLoopDecision, decision },
        });
      }
      const changed = this.completeBotLoopEvaluationStmt.run({
        ...normalizedToken,
        decision,
        reason: reason ?? null,
        now: normalizedNow,
      });
      return changed.changes > 0 ? this.get(normalizedToken.eventId) : undefined;
    });
  }

  public transitionClaimed(
    token: InboundChannelEventClaimToken,
    transition: InboundChannelEventClaimedTransition,
    now?: string,
  ): InboundChannelEventRecord | undefined {
    const normalizedToken = normalizeClaimToken(token);
    const normalizedNow = normalizeTimestamp(now ?? this.readDatabaseNow(), "now");
    const targetStatus = normalizeClaimedTransitionStatus(transition.status);
    if (targetStatus === "retry_wait" && !transition.nextAttemptAt) {
      throw new ValidationError({ field: "nextAttemptAt", message: "nextAttemptAt is required for a retry." });
    }
    if (targetStatus === "manual_reconciliation_required" && !transition.reconciliationReason?.trim()) {
      throw new ValidationError({
        field: "reconciliationReason",
        message: "reconciliationReason is required for manual reconciliation.",
      });
    }
    const nextAttemptAt = transition.nextAttemptAt
      ? normalizeTimestamp(transition.nextAttemptAt, "nextAttemptAt")
      : undefined;
    const linkage = normalizeLinkage(transition.linkage ?? {});
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedToken.eventId);
      if (!current) {
        return undefined;
      }
      assertLinkageCompatible(current, linkage);
      if (isInboundChannelEventTerminalStatus(current.status)) {
        if (current.status !== targetStatus || current.claimGeneration !== normalizedToken.generation) {
          return undefined;
        }
        assertInboundTerminalReplayCompatible(current, transition);
        return current;
      }
      if (!canTransitionClaimed(current.status, targetStatus)) {
        throw new ConflictError({
          message: `Inbound channel event ${current.eventId} cannot regress from ${current.status} to ${targetStatus}.`,
          details: { eventId: current.eventId, currentStatus: current.status, targetStatus },
        });
      }
      const releaseClaim = targetStatus === "retry_wait" || isInboundChannelEventTerminalStatus(targetStatus);
      const changed = this.transitionStmt.run({
        ...normalizedToken,
        status: targetStatus,
        releaseClaim: releaseClaim ? 1 : 0,
        nextAttemptAt: nextAttemptAt ?? null,
        lastError: normalizeOptional(transition.lastError, "lastError") ?? null,
        reconciliationReason: normalizeOptional(transition.reconciliationReason, "reconciliationReason") ?? null,
        terminalAt: isInboundChannelEventTerminalStatus(targetStatus) ? normalizedNow : null,
        ...linkageParams(linkage),
        now: normalizedNow,
      });
      return changed.changes > 0 ? this.get(normalizedToken.eventId) : undefined;
    });
  }

  public recoverExpiredClaims(input: { now?: string; limit?: number } = {}): number {
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    return this.db.transaction("immediate", () => {
      const rows = this.listExpiredStmt.all({ now, limit: normalizeLimit(input.limit) }) as InboundChannelEventRow[];
      let recovered = 0;
      for (const row of rows) {
        recovered += this.recoverExpiredStmt.run({
          eventId: row.event_id,
          expectedGeneration: Number(row.claim_generation),
          expectedClaimExpiresAt: row.claim_expires_at,
          now,
        }).changes;
      }
      return recovered;
    });
  }

  private acceptNormalized(input: NormalizedAcceptance, acceptedAt: string): InboundChannelEventAcceptResult {
    const identity = {
      channelKey: input.channelKey,
      connectionId: input.connectionId,
      idempotencyKey: input.idempotencyKey,
    };
    const existing = this.getByIdentity(identity);
    if (existing) {
      assertPayloadMatch(existing, input);
      return { outcome: "duplicate", event: existing };
    }
    const eventIdCollision = this.get(input.eventId);
    if (eventIdCollision) {
      throw eventIdConflict(eventIdCollision, input);
    }
    const inserted = this.insertStmt.run({ ...input, acceptedAt });
    const event = inserted.changes > 0 ? this.get(input.eventId) : this.getByIdentity(identity);
    if (!event) {
      const collided = this.get(input.eventId);
      if (collided) {
        throw eventIdConflict(collided, input);
      }
      throw new Error("Inbound channel event acceptance did not produce a durable record.");
    }
    assertPayloadMatch(event, input);
    return { outcome: inserted.changes > 0 ? "accepted" : "duplicate", event };
  }

  private readDatabaseNow(): string {
    const row = this.databaseNowStmt.get<{ now_iso?: unknown }>();
    if (!row || typeof row.now_iso !== "string") {
      throw new Error("Database did not return an inbound channel event timestamp.");
    }
    return row.now_iso;
  }
}

function normalizeAcceptance(input: InboundChannelEventAcceptInput, acceptedAt: string): NormalizedAcceptance {
  const normalizedAcceptedAt = normalizeTimestamp(acceptedAt, "acceptedAt");
  const payloadJson = normalizePayload(input.payload);
  return {
    eventId: normalizeOptional(input.eventId, "eventId") ?? randomUUID(),
    channelKey: normalizeRequired(input.channelKey, "channelKey"),
    connectionId: normalizeRequired(input.connectionId, "connectionId"),
    transport: normalizeRequired(input.transport, "transport"),
    dispatchKind: normalizeDispatchKind(input.dispatchKind),
    providerSourceId: normalizeOptional(input.providerSourceId, "providerSourceId") ?? null,
    idempotencyKey: normalizeRequired(input.idempotencyKey, "idempotencyKey"),
    laneKey: normalizeRequired(input.laneKey, "laneKey"),
    payloadJson,
    payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
    receivedAt: normalizeTimestamp(input.receivedAt ?? normalizedAcceptedAt, "receivedAt"),
  };
}

function normalizePayload(payload: Record<string, unknown>): string {
  if (!isPlainRecord(payload)) {
    throw new ValidationError({ field: "payload", message: "payload must be a plain object." });
  }
  const seen = new WeakSet<object>();
  let keyCount = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_DEPTH) {
      throw new PayloadTooLargeError("Inbound channel event payload exceeds the maximum nesting depth.");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new ValidationError({ field: "payload", message: "payload numbers must be finite." });
      }
      return value;
    }
    if (typeof value !== "object") {
      throw new ValidationError({ field: "payload", message: "payload must contain only JSON values." });
    }
    if (seen.has(value)) {
      throw new ValidationError({ field: "payload", message: "payload must not contain cycles." });
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => visit(item, depth + 1));
      }
      if (!isPlainRecord(value)) {
        throw new ValidationError({ field: "payload", message: "payload objects must be plain objects." });
      }
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        keyCount += 1;
        if (keyCount > INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_KEYS) {
          throw new PayloadTooLargeError("Inbound channel event payload contains too many object keys.");
        }
        normalized[key] = visit(value[key], depth + 1);
      }
      return normalized;
    } finally {
      seen.delete(value);
    }
  };
  const payloadJson = JSON.stringify(visit(payload, 0));
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  if (payloadBytes > INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `Inbound channel event payload is ${payloadBytes} bytes; maximum is ${INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_BYTES}.`,
      { payloadBytes, maxPayloadBytes: INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_BYTES },
    );
  }
  return payloadJson;
}

function mapRow(row: InboundChannelEventRow): InboundChannelEventRecord {
  const payload = JSON.parse(row.payload_json) as unknown;
  if (!isPlainRecord(payload)) {
    throw new TypeError(`inbound_channel_events ${row.event_id} has a non-object payload`);
  }
  return {
    sequence: normalizeSafeInteger(row.sequence, "sequence", 1),
    eventId: row.event_id,
    channelKey: row.channel_key,
    connectionId: row.connection_id,
    transport: row.transport,
    dispatchKind: normalizeDispatchKind(row.dispatch_kind),
    providerSourceId: row.provider_source_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    laneKey: row.lane_key,
    payloadHash: row.payload_hash,
    payload,
    status: normalizeInboundStatus(row.status),
    attemptCount: normalizeSafeInteger(row.attempt_count, "attempt_count", 0),
    claimGeneration: normalizeSafeInteger(row.claim_generation, "claim_generation", 0),
    claimToken: row.claim_token ?? undefined,
    claimOwnerId: row.claim_owner_id ?? undefined,
    claimExpiresAt: row.claim_expires_at ?? undefined,
    claimHeartbeatAt: row.claim_heartbeat_at ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    botLoopDecision: normalizeBotLoopDecision(row.bot_loop_decision),
    botLoopReason: row.bot_loop_reason ?? undefined,
    sessionKey: row.session_key ?? undefined,
    sessionId: row.session_id ?? undefined,
    messageId: row.message_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    assistantMessageId: row.assistant_message_id ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
    deliveryId: row.delivery_id ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    messageContentHash: row.message_content_hash ?? undefined,
    deliveryPayloadHash: row.delivery_payload_hash ?? undefined,
    commandOperationKey: row.command_operation_key ?? undefined,
    commandResultText: row.command_result_text ?? undefined,
    lastError: row.last_error ?? undefined,
    reconciliationReason: row.reconciliation_reason ?? undefined,
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at ?? undefined,
  };
}

function assertPayloadMatch(existing: InboundChannelEventRecord, input: NormalizedAcceptance): void {
  if (
    existing.laneKey !== input.laneKey ||
    existing.transport !== input.transport ||
    existing.dispatchKind !== input.dispatchKind ||
    (existing.providerSourceId ?? null) !== input.providerSourceId ||
    existing.payloadHash !== input.payloadHash ||
    JSON.stringify(existing.payload) !== input.payloadJson
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Inbound channel idempotency identity was reused with a different normalized payload.",
      details: {
        eventId: existing.eventId,
        channelKey: existing.channelKey,
        connectionId: existing.connectionId,
        idempotencyKey: existing.idempotencyKey,
        existingLaneKey: existing.laneKey,
        requestedLaneKey: input.laneKey,
        existingTransport: existing.transport,
        requestedTransport: input.transport,
        existingDispatchKind: existing.dispatchKind,
        requestedDispatchKind: input.dispatchKind,
      },
    });
  }
}

function eventIdConflict(existing: InboundChannelEventRecord, input: NormalizedAcceptance): ConflictError {
  return new ConflictError({
    code: "ALREADY_EXISTS",
    message: `Inbound channel event id ${input.eventId} is already owned by a different provider event.`,
    details: {
      eventId: input.eventId,
      existingChannelKey: existing.channelKey,
      existingConnectionId: existing.connectionId,
    },
  });
}

function normalizeIdentity(input: { channelKey: string; connectionId: string; idempotencyKey: string }) {
  return {
    channelKey: normalizeRequired(input.channelKey, "channelKey"),
    connectionId: normalizeRequired(input.connectionId, "connectionId"),
    idempotencyKey: normalizeRequired(input.idempotencyKey, "idempotencyKey"),
  };
}

function normalizeDispatchKind(value: unknown): InboundChannelEventRecord["dispatchKind"] {
  if (value === "agent_turn" || value === "voice_agent_turn" || value === "record_only" || value === "command") {
    return value;
  }
  throw new ValidationError({ field: "dispatchKind", message: "dispatchKind is not supported." });
}

function normalizeInboundStatus(value: string): InboundChannelEventStatus {
  if (
    value === "accepted" ||
    value === "processing" ||
    value === "message_recorded" ||
    value === "command_execution_started" ||
    value === "turn_admitted" ||
    value === "waiting" ||
    value === "reply_enqueued" ||
    value === "retry_wait" ||
    value === "completed" ||
    value === "suppressed" ||
    value === "failed" ||
    value === "manual_reconciliation_required"
  ) {
    return value;
  }
  throw new TypeError(`inbound_channel_events status is not supported: ${value}`);
}

function normalizeBotLoopDecision(value: string | null): InboundChannelBotLoopDecision | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "evaluating" || value === "allow" || value === "suppress") {
    return value;
  }
  throw new TypeError(`inbound_channel_events bot_loop_decision is not supported: ${value}`);
}

function normalizeCompletedBotLoopDecision(
  value: Exclude<InboundChannelBotLoopDecision, "evaluating">,
): Exclude<InboundChannelBotLoopDecision, "evaluating"> {
  if (value === "allow" || value === "suppress") {
    return value;
  }
  throw new ValidationError({ field: "decision", message: "Completed bot-loop decision is not supported." });
}

function normalizeClaimedTransitionStatus(value: unknown): InboundChannelEventClaimedTransition["status"] {
  const status = typeof value === "string" ? normalizeInboundStatus(value) : undefined;
  if (status && status !== "accepted" && status !== "processing") {
    return status;
  }
  throw new ValidationError({ field: "status", message: "Claimed transition status is not supported." });
}

function canTransitionClaimed(
  current: InboundChannelEventStatus,
  target: InboundChannelEventClaimedTransition["status"],
): boolean {
  if (target === "retry_wait" || isInboundChannelEventTerminalStatus(target)) {
    return true;
  }
  const stageOrder: Partial<Record<InboundChannelEventStatus, number>> = {
    processing: 0,
    message_recorded: 1,
    command_execution_started: 2,
    turn_admitted: 2,
    waiting: 3,
    reply_enqueued: 4,
  };
  const currentOrder = stageOrder[current];
  const targetOrder = stageOrder[target];
  return currentOrder !== undefined && targetOrder !== undefined && targetOrder >= currentOrder;
}

function normalizeClaimToken(token: InboundChannelEventClaimToken): InboundChannelEventClaimToken {
  return {
    eventId: normalizeRequired(token.eventId, "eventId"),
    ownerId: normalizeRequired(token.ownerId, "ownerId"),
    claimToken: normalizeRequired(token.claimToken, "claimToken"),
    generation: normalizeSafeInteger(token.generation, "generation", 1),
  };
}

function claimMatches(current: InboundChannelEventRecord, token: InboundChannelEventClaimToken, now: string): boolean {
  return (
    current.claimOwnerId === token.ownerId &&
    current.claimGeneration === token.generation &&
    current.claimToken === token.claimToken &&
    current.claimExpiresAt !== undefined &&
    current.claimExpiresAt > now &&
    current.status !== "accepted" &&
    current.status !== "retry_wait" &&
    !isInboundChannelEventTerminalStatus(current.status)
  );
}

function normalizeLinkage(linkage: InboundChannelEventLinkage): InboundChannelEventLinkage {
  return {
    sessionKey: normalizeOptional(linkage.sessionKey, "sessionKey"),
    sessionId: normalizeOptional(linkage.sessionId, "sessionId"),
    messageId: normalizeOptional(linkage.messageId, "messageId"),
    turnId: normalizeOptional(linkage.turnId, "turnId"),
    assistantMessageId: normalizeOptional(linkage.assistantMessageId, "assistantMessageId"),
    durableRunId: normalizeOptional(linkage.durableRunId, "durableRunId"),
    deliveryId: normalizeOptional(linkage.deliveryId, "deliveryId"),
    providerMessageId: normalizeOptional(linkage.providerMessageId, "providerMessageId"),
    messageContentHash: normalizeOptional(linkage.messageContentHash, "messageContentHash"),
    deliveryPayloadHash: normalizeOptional(linkage.deliveryPayloadHash, "deliveryPayloadHash"),
    commandOperationKey: normalizeOptional(linkage.commandOperationKey, "commandOperationKey"),
    commandResultText: normalizeCommandResultText(linkage.commandResultText),
  };
}

function linkageParams(linkage: InboundChannelEventLinkage): Record<string, string | null> {
  return {
    sessionKey: linkage.sessionKey ?? null,
    sessionId: linkage.sessionId ?? null,
    messageId: linkage.messageId ?? null,
    turnId: linkage.turnId ?? null,
    assistantMessageId: linkage.assistantMessageId ?? null,
    durableRunId: linkage.durableRunId ?? null,
    deliveryId: linkage.deliveryId ?? null,
    providerMessageId: linkage.providerMessageId ?? null,
    messageContentHash: linkage.messageContentHash ?? null,
    deliveryPayloadHash: linkage.deliveryPayloadHash ?? null,
    commandOperationKey: linkage.commandOperationKey ?? null,
    commandResultText: linkage.commandResultText ?? null,
  };
}

function assertLinkageCompatible(current: InboundChannelEventRecord, linkage: InboundChannelEventLinkage): void {
  for (const key of [
    "sessionKey",
    "sessionId",
    "messageId",
    "turnId",
    "assistantMessageId",
    "durableRunId",
    "deliveryId",
    "providerMessageId",
    "messageContentHash",
    "deliveryPayloadHash",
    "commandOperationKey",
    "commandResultText",
  ] as const) {
    if (current[key] && linkage[key] && current[key] !== linkage[key]) {
      throw new ConflictError({
        message: `Inbound channel event ${current.eventId} is already linked to a different ${key}.`,
        details: { eventId: current.eventId, field: key },
      });
    }
  }
}

function normalizeCommandResultText(value: string | undefined): string | undefined {
  const normalized = normalizeOptional(value, "commandResultText");
  if (normalized && Buffer.byteLength(normalized, "utf8") > INBOUND_CHANNEL_COMMAND_RESULT_MAX_BYTES) {
    throw new PayloadTooLargeError(
      `Inbound channel command result exceeds ${INBOUND_CHANNEL_COMMAND_RESULT_MAX_BYTES} bytes.`,
    );
  }
  return normalized;
}

function assertInboundTerminalReplayCompatible(
  current: InboundChannelEventRecord,
  transition: InboundChannelEventClaimedTransition,
): void {
  const lastError = normalizeOptional(transition.lastError, "lastError");
  const reconciliationReason = normalizeOptional(transition.reconciliationReason, "reconciliationReason");
  if (
    (lastError !== undefined && lastError !== current.lastError) ||
    (reconciliationReason !== undefined && reconciliationReason !== current.reconciliationReason)
  ) {
    throw new ConflictError({
      message: `Inbound channel event ${current.eventId} terminal transition was replayed with different evidence.`,
      details: { eventId: current.eventId, status: current.status },
    });
  }
}

function nullableMatch(db: DatabaseClient, column: string, parameter: string): string {
  return db.dialect === "postgres"
    ? `${column} IS NOT DISTINCT FROM CAST(@${parameter} AS TEXT)`
    : `${column} IS @${parameter}`;
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return normalized;
}

function normalizeOptional(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeRequired(value, field);
}

function normalizeTimestamp(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ValidationError({ field, message: `${field} must be a valid timestamp.` });
  }
  return new Date(time).toISOString();
}

function normalizeSafeInteger(value: number | string, field: string, minimum: number): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new TypeError(`${field} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return normalized;
}

function normalizeLeaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError({ field: "leaseDurationMs", message: "leaseDurationMs must be a positive integer." });
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new ValidationError({ field: "limit", message: "limit must be an integer from 1 through 1000." });
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
