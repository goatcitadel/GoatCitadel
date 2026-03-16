import type { DatabaseSync } from "node:sqlite";
import { safeJsonParse } from "./safe-json.js";

export interface ChatStreamEventRecord {
  eventId: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  runId?: string;
  chunkType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ChatStreamEventRow {
  event_id: string;
  session_id: string;
  turn_id: string;
  sequence: number;
  run_id: string | null;
  chunk_type: string;
  payload_json: string;
  created_at: string;
}

export class ChatStreamEventRepository {
  private readonly insertStmt;
  private readonly listByTurnStmt;
  private readonly getStmt;
  private readonly getByEventIdStmt;
  private readonly getLatestSequenceStmt;
  private readonly purgeBeforeStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO chat_stream_events (
        event_id, session_id, turn_id, sequence, run_id, chunk_type, payload_json, created_at
      ) VALUES (
        @eventId, @sessionId, @turnId, @sequence, @runId, @chunkType, @payloadJson, @createdAt
      )
    `);
    this.listByTurnStmt = db.prepare(`
      SELECT *
      FROM chat_stream_events
      WHERE turn_id = @turnId
        AND sequence > @afterSequence
      ORDER BY sequence ASC
      LIMIT @limit
    `);
    this.getStmt = db.prepare(`
      SELECT *
      FROM chat_stream_events
      WHERE turn_id = @turnId
        AND sequence = @sequence
      LIMIT 1
    `);
    this.getByEventIdStmt = db.prepare(`
      SELECT *
      FROM chat_stream_events
      WHERE event_id = ?
      LIMIT 1
    `);
    this.getLatestSequenceStmt = db.prepare(`
      SELECT MAX(sequence) AS sequence
      FROM chat_stream_events
      WHERE turn_id = ?
    `);
    this.purgeBeforeStmt = db.prepare(`
      DELETE FROM chat_stream_events
      WHERE created_at < ?
    `);
  }

  public append(input: ChatStreamEventRecord): ChatStreamEventRecord {
    this.insertStmt.run({
      eventId: input.eventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sequence: input.sequence,
      runId: input.runId ?? null,
      chunkType: input.chunkType,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt,
    });
    return this.getByEventId(input.eventId) ?? input;
  }

  public listByTurn(turnId: string, afterSequence = 0, limit = 500): ChatStreamEventRecord[] {
    const rows = this.listByTurnStmt.all({
      turnId,
      afterSequence,
      limit: Math.max(1, Math.min(limit, 5_000)),
    }) as unknown as ChatStreamEventRow[];
    return rows.map(mapRow);
  }

  public get(turnId: string, sequence: number): ChatStreamEventRecord | undefined {
    const row = this.getStmt.get({
      turnId,
      sequence,
    }) as ChatStreamEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public getByEventId(eventId: string): ChatStreamEventRecord | undefined {
    const row = this.getByEventIdStmt.get(eventId) as ChatStreamEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public getLatestSequence(turnId: string): number {
    const row = this.getLatestSequenceStmt.get(turnId) as { sequence?: number | null } | undefined;
    return Number(row?.sequence ?? 0);
  }

  public purgeBefore(createdAtExclusive: string): number {
    return Number(this.purgeBeforeStmt.run(createdAtExclusive).changes ?? 0);
  }
}

function mapRow(row: ChatStreamEventRow): ChatStreamEventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    sequence: row.sequence,
    runId: row.run_id ?? undefined,
    chunkType: row.chunk_type,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: row.created_at,
  };
}
