import {
  ConflictError,
  NotFoundError,
  type ChatTimerDeliveryStatus,
  type ChatTimerRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ChatTimerRow {
  timer_id: string;
  workspace_id: string;
  session_id: string;
  revision: number | string;
  due_at: string;
  timezone: string;
  message: string;
  notification_rule_id: string | null;
  cancel_on_next_reply: number | string;
  status: ChatTimerRecord["status"];
  created_by: string;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  notice_message_id: string | null;
  notification_event_id: string | null;
  notification_delivery_status: ChatTimerDeliveryStatus | null;
  fired_at: string | null;
  cancelled_at: string | null;
  cancelled_by_message_id: string | null;
  failure: string | null;
}

export interface CreateChatTimerRecordInput {
  timerId: string;
  workspaceId: string;
  sessionId: string;
  dueAt: string;
  timezone: string;
  message: string;
  notificationRuleId?: string;
  cancelOnNextReply: boolean;
  createdBy: string;
}

export class ChatTimerRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public databaseNow(): string {
    const row = this.db
      .prepare(
        this.db.dialect === "postgres"
          ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso`
          : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso`,
      )
      .get() as { now_iso: string };
    return row.now_iso;
  }

  public create(input: CreateChatTimerRecordInput, now = this.databaseNow()): ChatTimerRecord {
    this.db
      .prepare(
        `
        INSERT INTO chat_timers (
          timer_id, workspace_id, session_id, revision, due_at, timezone, message,
          notification_rule_id, cancel_on_next_reply, status, created_by, created_at, updated_at
        ) VALUES (
          @timerId, @workspaceId, @sessionId, 1, @dueAt, @timezone, @message,
          @notificationRuleId, @cancelOnNextReply, 'active', @createdBy, @now, @now
        )
      `,
      )
      .run({
        ...input,
        notificationRuleId: input.notificationRuleId ?? null,
        cancelOnNextReply: input.cancelOnNextReply ? 1 : 0,
        now,
      });
    return this.get(input.timerId);
  }

  public get(timerId: string): ChatTimerRecord {
    const row = this.db.prepare("SELECT * FROM chat_timers WHERE timer_id = ? LIMIT 1").get(timerId) as
      | ChatTimerRow
      | undefined;
    if (!row) throw new NotFoundError({ entity: "Chat timer", id: timerId });
    return mapTimer(row);
  }

  public listBySession(sessionId: string, limit = 100): ChatTimerRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM chat_timers WHERE session_id = ? ORDER BY due_at ASC, timer_id ASC LIMIT ?")
        .all(sessionId, Math.max(1, Math.min(200, limit))) as ChatTimerRow[]
    ).map(mapTimer);
  }

  public listFiredBySession(sessionId: string, limit = 100): ChatTimerRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM chat_timers WHERE session_id = ? AND status = 'fired' AND notice_message_id IS NOT NULL ORDER BY fired_at ASC, timer_id ASC LIMIT ?",
        )
        .all(sessionId, Math.max(1, Math.min(200, limit))) as ChatTimerRow[]
    ).map(mapTimer);
  }

  public countActiveBySession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(1) AS count FROM chat_timers WHERE session_id = ? AND status IN ('active', 'claimed')")
      .get(sessionId) as { count: number | string };
    return Number(row.count);
  }

  public countActiveByWorkspace(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(1) AS count FROM chat_timers WHERE workspace_id = ? AND status IN ('active', 'claimed')")
      .get(workspaceId) as { count: number | string };
    return Number(row.count);
  }

  public cancel(timerId: string, expectedRevision: number, now = this.databaseNow()): ChatTimerRecord {
    const result = this.db
      .prepare(
        `
        UPDATE chat_timers
        SET revision = revision + 1, status = 'cancelled', cancelled_at = @now,
            claimed_by = NULL, claim_expires_at = NULL, updated_at = @now
        WHERE timer_id = @timerId AND revision = @expectedRevision AND status = 'active'
      `,
      )
      .run({ timerId, expectedRevision, now });
    if (Number(result.changes ?? 0) !== 1) {
      const current = this.get(timerId);
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "Chat timer changed or is no longer cancellable.",
        details: { timerId, expectedRevision, actualRevision: current.revision, status: current.status },
      });
    }
    return this.get(timerId);
  }

  public cancelOnNextReply(sessionId: string, messageId: string, now = this.databaseNow()): number {
    const result = this.db
      .prepare(
        `
        UPDATE chat_timers
        SET revision = revision + 1, status = 'cancelled', cancelled_at = @now,
            cancelled_by_message_id = @messageId, updated_at = @now
        WHERE session_id = @sessionId AND status = 'active' AND cancel_on_next_reply = 1
      `,
      )
      .run({ sessionId, messageId, now });
    return Number(result.changes ?? 0);
  }

  public claimDue(ownerId: string, limit = 25, leaseMs = 30_000): ChatTimerRecord[] {
    const now = this.databaseNow();
    const claimExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const candidates = this.db
      .prepare(
        `
        SELECT timer_id FROM chat_timers
        WHERE due_at <= @now
          AND (status = 'active' OR (status = 'claimed' AND claim_expires_at <= @now))
        ORDER BY due_at ASC, timer_id ASC
        LIMIT @limit
      `,
      )
      .all({ now, limit: Math.max(1, Math.min(100, limit)) }) as Array<{ timer_id: string }>;
    const claimed: ChatTimerRecord[] = [];
    for (const candidate of candidates) {
      const result = this.db
        .prepare(
          `
          UPDATE chat_timers
          SET revision = revision + 1, status = 'claimed', claimed_by = @ownerId,
              claim_expires_at = @claimExpiresAt, updated_at = @now
          WHERE timer_id = @timerId AND due_at <= @now
            AND (status = 'active' OR (status = 'claimed' AND claim_expires_at <= @now))
        `,
        )
        .run({ timerId: candidate.timer_id, ownerId, claimExpiresAt, now });
      if (Number(result.changes ?? 0) === 1) claimed.push(this.get(candidate.timer_id));
    }
    return claimed;
  }

  public markFired(
    timerId: string,
    ownerId: string,
    input: {
      noticeMessageId: string;
      notificationEventId: string;
      notificationDeliveryStatus: ChatTimerDeliveryStatus;
    },
    now = this.databaseNow(),
  ): ChatTimerRecord {
    const result = this.db
      .prepare(
        `
        UPDATE chat_timers
        SET revision = revision + 1, status = 'fired', notice_message_id = @noticeMessageId,
            notification_event_id = @notificationEventId,
            notification_delivery_status = @notificationDeliveryStatus, fired_at = COALESCE(fired_at, @now),
            claimed_by = NULL, claim_expires_at = NULL, failure = NULL, updated_at = @now
        WHERE timer_id = @timerId AND status = 'claimed' AND claimed_by = @ownerId
      `,
      )
      .run({ timerId, ownerId, ...input, now });
    if (Number(result.changes ?? 0) !== 1) throw lostClaim(timerId);
    return this.get(timerId);
  }

  public markFailed(timerId: string, ownerId: string, failure: string, now = this.databaseNow()): ChatTimerRecord {
    const result = this.db
      .prepare(
        `
        UPDATE chat_timers
        SET revision = revision + 1, status = 'failed', failure = @failure,
            claimed_by = NULL, claim_expires_at = NULL, updated_at = @now
        WHERE timer_id = @timerId AND status = 'claimed' AND claimed_by = @ownerId
      `,
      )
      .run({ timerId, ownerId, failure, now });
    if (Number(result.changes ?? 0) !== 1) throw lostClaim(timerId);
    return this.get(timerId);
  }
}

function lostClaim(timerId: string): ConflictError {
  return new ConflictError({
    code: "STATE_CONFLICT",
    message: "Chat timer lease was lost before settlement.",
    details: { timerId },
  });
}

function mapTimer(row: ChatTimerRow): ChatTimerRecord {
  return {
    timerId: row.timer_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    revision: Number(row.revision),
    dueAt: row.due_at,
    timezone: row.timezone,
    message: row.message,
    ...(row.notification_rule_id ? { notificationRuleId: row.notification_rule_id } : {}),
    cancelOnNextReply: Number(row.cancel_on_next_reply) === 1,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
    ...(row.notice_message_id ? { noticeMessageId: row.notice_message_id } : {}),
    ...(row.notification_event_id ? { notificationEventId: row.notification_event_id } : {}),
    ...(row.notification_delivery_status ? { notificationDeliveryStatus: row.notification_delivery_status } : {}),
    ...(row.fired_at ? { firedAt: row.fired_at } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    ...(row.cancelled_by_message_id ? { cancelledByMessageId: row.cancelled_by_message_id } : {}),
    ...(row.failure ? { failure: row.failure } : {}),
  };
}
