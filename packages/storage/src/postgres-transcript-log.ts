import type { TranscriptEvent } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface TranscriptEventRow {
  event_id: string;
  action_id: string | null;
  idempotency_key: string | null;
  session_id: string;
  session_key: string | null;
  occurred_at: string;
  event_type: TranscriptEvent["type"];
  actor_type: TranscriptEvent["actorType"];
  actor_id: string;
  payload: string | Record<string, unknown>;
  token_input: number | null;
  token_output: number | null;
  cost_usd: number | null;
}

export class PostgresTranscriptLog {
  private readonly nextSequenceStmt;
  private readonly insertStmt;
  private readonly readStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.nextSequenceStmt = db.prepare(`
      SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence
      FROM transcript_events
      WHERE session_id = ?
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO transcript_events (
        session_id,
        event_id,
        event_sequence,
        legacy_offset,
        action_id,
        idempotency_key,
        session_key,
        occurred_at,
        event_type,
        actor_type,
        actor_id,
        payload,
        token_input,
        token_output,
        cost_usd
      ) VALUES (
        @sessionId,
        @eventId,
        @eventSequence,
        NULL,
        @actionId,
        @idempotencyKey,
        @sessionKey,
        @occurredAt,
        @eventType,
        @actorType,
        @actorId,
        @payload,
        @tokenInput,
        @tokenOutput,
        @costUsd
      )
    `);
    this.readStmt = db.prepare(`
      SELECT
        event_id,
        action_id,
        idempotency_key,
        session_id,
        session_key,
        occurred_at,
        event_type,
        actor_type,
        actor_id,
        payload,
        token_input,
        token_output,
        cost_usd
      FROM transcript_events
      WHERE session_id = ?
      ORDER BY event_sequence ASC, occurred_at ASC
    `);
    this.deleteStmt = db.prepare("DELETE FROM transcript_events WHERE session_id = ?");
  }

  public async append(event: TranscriptEvent): Promise<number> {
    return this.db.transaction("immediate", () => {
      const nextSequenceRow = this.nextSequenceStmt.get(event.sessionId) as { next_sequence?: number } | undefined;
      const nextSequence = Number(nextSequenceRow?.next_sequence ?? 1);
      this.insertStmt.run({
        sessionId: event.sessionId,
        eventId: event.eventId,
        eventSequence: nextSequence,
        actionId: event.actionId,
        idempotencyKey: event.idempotencyKey,
        sessionKey: event.sessionKey,
        occurredAt: event.timestamp,
        eventType: event.type,
        actorType: event.actorType,
        actorId: event.actorId,
        payload: JSON.stringify(event.payload),
        tokenInput: event.tokenInput ?? null,
        tokenOutput: event.tokenOutput ?? null,
        costUsd: event.costUsd ?? null,
      });
      return nextSequence;
    });
  }

  public async read(sessionId: string): Promise<TranscriptEvent[]> {
    const rows = this.readStmt.all(sessionId) as TranscriptEventRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      actionId: row.action_id ?? "",
      idempotencyKey: row.idempotency_key ?? "",
      sessionId: row.session_id,
      sessionKey: row.session_key ?? "",
      timestamp: row.occurred_at,
      type: row.event_type,
      actorType: row.actor_type,
      actorId: row.actor_id,
      payload: typeof row.payload === "string"
        ? safeJsonParse<Record<string, unknown>>(row.payload, {})
        : row.payload,
      tokenInput: row.token_input ?? undefined,
      tokenOutput: row.token_output ?? undefined,
      costUsd: row.cost_usd ?? undefined,
    }));
  }

  public async delete(sessionId: string): Promise<void> {
    this.deleteStmt.run(sessionId);
  }
}
