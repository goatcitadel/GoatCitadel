import type { DatabaseClient } from "./db.js";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface TranscriptOutboxRow {
  event_id: string;
  session_id: string;
  event_json: string;
  enqueued_at: string;
  delivered_at: string | null;
  transcript_offset: number | null;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
}

export interface TranscriptOutboxRecord {
  eventId: string;
  sessionId: string;
  event: TranscriptEvent;
  enqueuedAt: string;
  deliveredAt?: string;
  transcriptOffset?: number;
  attemptCount: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export class TranscriptOutboxRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listPendingStmt;
  private readonly listPendingBySessionStmt;
  private readonly markFailedStmt;
  private readonly markDeliveredStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO transcript_outbox (
        event_id,
        session_id,
        event_json,
        enqueued_at,
        delivered_at,
        transcript_offset,
        attempt_count,
        last_attempt_at,
        last_error
      ) VALUES (
        @eventId,
        @sessionId,
        @eventJson,
        @enqueuedAt,
        NULL,
        NULL,
        0,
        NULL,
        NULL
      )
      ON CONFLICT(event_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM transcript_outbox WHERE event_id = ?");
    this.listPendingStmt = db.prepare(`
      SELECT * FROM transcript_outbox
      WHERE delivered_at IS NULL
      ORDER BY enqueued_at ASC, event_id ASC
      LIMIT @limit
    `);
    this.listPendingBySessionStmt = db.prepare(`
      SELECT * FROM transcript_outbox
      WHERE delivered_at IS NULL
        AND session_id = @sessionId
      ORDER BY enqueued_at ASC, event_id ASC
      LIMIT @limit
    `);
    this.markFailedStmt = db.prepare(`
      UPDATE transcript_outbox
      SET attempt_count = attempt_count + 1,
          last_attempt_at = @lastAttemptAt,
          last_error = @lastError
      WHERE event_id = @eventId
        AND delivered_at IS NULL
    `);
    this.markDeliveredStmt = db.prepare(`
      UPDATE transcript_outbox
      SET delivered_at = @deliveredAt,
          transcript_offset = @transcriptOffset,
          last_attempt_at = @deliveredAt,
          last_error = NULL
      WHERE event_id = @eventId
    `);
  }

  public enqueue(event: TranscriptEvent, enqueuedAt = event.timestamp): TranscriptOutboxRecord {
    this.insertStmt.run({
      eventId: event.eventId,
      sessionId: event.sessionId,
      eventJson: JSON.stringify(event),
      enqueuedAt,
    });
    return this.get(event.eventId) ?? {
      eventId: event.eventId,
      sessionId: event.sessionId,
      event,
      enqueuedAt,
      attemptCount: 0,
    };
  }

  public get(eventId: string): TranscriptOutboxRecord | undefined {
    const row = toTranscriptOutboxRow(this.getStmt.get(eventId));
    return row ? mapRow(row) : undefined;
  }

  public listPending(limit = 100, sessionId?: string): TranscriptOutboxRecord[] {
    const rows = toTranscriptOutboxRows(sessionId
      ? this.listPendingBySessionStmt.all({ limit, sessionId })
      : this.listPendingStmt.all({ limit }));
    return rows.map(mapRow);
  }

  public markFailed(
    eventId: string,
    input: {
      lastAttemptAt?: string;
      lastError: string;
    },
  ): TranscriptOutboxRecord | undefined {
    const lastAttemptAt = input.lastAttemptAt ?? new Date().toISOString();
    this.markFailedStmt.run({
      eventId,
      lastAttemptAt,
      lastError: input.lastError,
    });
    return this.get(eventId);
  }

  public markDelivered(
    eventId: string,
    input: {
      deliveredAt?: string;
      transcriptOffset: number;
    },
  ): TranscriptOutboxRecord | undefined {
    const deliveredAt = input.deliveredAt ?? new Date().toISOString();
    this.markDeliveredStmt.run({
      eventId,
      deliveredAt,
      transcriptOffset: input.transcriptOffset,
    });
    return this.get(eventId);
  }
}

function mapRow(row: TranscriptOutboxRow): TranscriptOutboxRecord {
  const event = parseTranscriptEvent(row.event_json);
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    event,
    enqueuedAt: row.enqueued_at,
    deliveredAt: row.delivered_at ?? undefined,
    transcriptOffset: typeof row.transcript_offset === "number" ? row.transcript_offset : undefined,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function parseTranscriptEvent(raw: string): TranscriptEvent {
  const parsed = safeJsonParse<unknown>(raw, undefined);
  if (isTranscriptEvent(parsed)) {
    return parsed;
  }
  return {
    eventId: "invalid",
    actionId: "invalid",
    idempotencyKey: "invalid",
    sessionId: "invalid",
    sessionKey: "invalid",
    timestamp: new Date(0).toISOString(),
    type: "orchestration.phase",
    actorType: "system",
    actorId: "system",
    payload: {
      reason: "invalid_transcript_event",
    },
  } satisfies TranscriptEvent;
}

function toTranscriptOutboxRow(value: unknown): TranscriptOutboxRow | undefined {
  return isTranscriptOutboxRow(value) ? value : undefined;
}

function toTranscriptOutboxRows(value: unknown): TranscriptOutboxRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTranscriptOutboxRow);
}

function isTranscriptOutboxRow(value: unknown): value is TranscriptOutboxRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.event_id === "string"
    && typeof value.session_id === "string"
    && typeof value.event_json === "string"
    && typeof value.enqueued_at === "string"
    && (typeof value.delivered_at === "string" || value.delivered_at === null)
    && (typeof value.transcript_offset === "number" || value.transcript_offset === null)
    && typeof value.attempt_count === "number"
    && (typeof value.last_attempt_at === "string" || value.last_attempt_at === null)
    && (typeof value.last_error === "string" || value.last_error === null);
}

function isTranscriptEvent(value: unknown): value is TranscriptEvent {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.eventId === "string"
    && typeof value.actionId === "string"
    && typeof value.idempotencyKey === "string"
    && typeof value.sessionId === "string"
    && typeof value.sessionKey === "string"
    && typeof value.timestamp === "string"
    && typeof value.type === "string"
    && typeof value.actorType === "string"
    && typeof value.actorId === "string"
    && isRecord(value.payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


