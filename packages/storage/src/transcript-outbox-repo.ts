import type { DatabaseSync } from "node:sqlite";
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

  public constructor(private readonly db: DatabaseSync) {
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
    const row = this.getStmt.get(eventId) as TranscriptOutboxRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public listPending(limit = 100, sessionId?: string): TranscriptOutboxRecord[] {
    const rows = (sessionId
      ? this.listPendingBySessionStmt.all({ limit, sessionId })
      : this.listPendingStmt.all({ limit })) as unknown as TranscriptOutboxRow[];
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
  const event = safeJsonParse<TranscriptEvent>(row.event_json, {} as TranscriptEvent);
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
