import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";
import { getRequestAttribution } from "./request-attribution.js";

interface RealtimeEventRow {
  event_id: string;
  sequence: number;
  event_type: string;
  source: string;
  payload_json: string;
  created_at: string;
}

export class RealtimeEventRepository {
  private readonly insertStmt;
  private readonly nextSequenceStmt;
  private readonly listLatestStmt;
  private readonly listBySequenceStmt;
  private readonly listAfterSequenceStmt;
  private readonly boundsStmt;
  private readonly listStmt;
  private readonly pruneStmt;
  private readonly pruneOlderThanStmt;
  private appendCount = 0;

  public constructor(private readonly db: DatabaseSync) {
    this.nextSequenceStmt = db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM realtime_events
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO realtime_events (
        event_id, sequence, event_type, source, payload_json, created_at
      ) VALUES (
        @eventId, @sequence, @eventType, @source, @payloadJson, @createdAt
      )
    `);

    this.listLatestStmt = db.prepare(`
      SELECT * FROM realtime_events
      ORDER BY sequence DESC
      LIMIT @limit
    `);

    this.listBySequenceStmt = db.prepare(`
      SELECT * FROM realtime_events
      WHERE sequence < @cursorSequence
      ORDER BY sequence DESC
      LIMIT @limit
    `);

    this.listAfterSequenceStmt = db.prepare(`
      SELECT * FROM realtime_events
      WHERE sequence > @afterSequence
      ORDER BY sequence ASC
      LIMIT @limit
    `);

    this.boundsStmt = db.prepare(`
      SELECT
        MIN(sequence) AS oldest_sequence,
        MAX(sequence) AS newest_sequence
      FROM realtime_events
    `);

    this.listStmt = db.prepare(`
      SELECT * FROM realtime_events
      WHERE (
        @cursorCreatedAt IS NULL
        OR created_at < @cursorCreatedAt
        OR (created_at = @cursorCreatedAt AND event_id < @cursorEventId)
      )
      ORDER BY created_at DESC, event_id DESC
      LIMIT @limit
    `);

    this.pruneStmt = db.prepare(`
      DELETE FROM realtime_events
      WHERE event_id IN (
        SELECT event_id FROM realtime_events
        ORDER BY created_at DESC, event_id DESC
        LIMIT -1 OFFSET @maxRows
      )
    `);
    this.pruneOlderThanStmt = db.prepare(`
      DELETE FROM realtime_events
      WHERE created_at < @cutoff
    `);
  }

  public append(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    createdAt = new Date().toISOString(),
  ): RealtimeEvent {
    const attribution = getRequestAttribution();
    const attributedPayload = {
      ...payload,
      correlationId: payload.correlationId ?? attribution?.correlationId,
      traceId: payload.traceId ?? attribution?.traceId,
      originSurface: payload.originSurface ?? attribution?.originSurface,
      actorId: payload.actorId ?? attribution?.actorId,
      deviceId: payload.deviceId ?? attribution?.deviceId,
      grantId: payload.grantId ?? attribution?.grantId,
    };
    const eventId = randomUUID();
    const nextSequenceRow = this.nextSequenceStmt.get() as { next_sequence?: number } | undefined;
    const sequence = Number(nextSequenceRow?.next_sequence ?? 1);
    this.insertStmt.run({
      eventId,
      sequence,
      eventType,
      source,
      payloadJson: JSON.stringify(attributedPayload),
      createdAt,
    });
    this.appendCount += 1;
    if (this.appendCount % 100 === 0) {
      this.pruneStmt.run({ maxRows: 10000 });
    }

    return {
      eventId,
      sequence,
      eventType,
      source,
      timestamp: createdAt,
      ...extractRealtimeMetadata(attributedPayload),
      payload: attributedPayload,
    };
  }

  public list(limit: number, cursor?: string): RealtimeEvent[] {
    const sequenceCursor = parseSequenceCursor(cursor);
    if (sequenceCursor !== undefined) {
      const rows = (
        sequenceCursor > 0
          ? this.listBySequenceStmt.all({
            limit,
            cursorSequence: sequenceCursor,
          })
          : this.listLatestStmt.all({ limit })
      ) as unknown as RealtimeEventRow[];
      return rows.map(mapRealtimeEventRow);
    }

    const parsedCursor = parseCompositeCursor(cursor);
    const rows = parsedCursor
      ? this.listStmt.all({
        limit,
        cursorCreatedAt: parsedCursor.timestamp,
        cursorEventId: parsedCursor.key,
      })
      : this.listLatestStmt.all({ limit });

    return (rows as unknown as RealtimeEventRow[]).map(mapRealtimeEventRow);
  }

  public listAfterSequence(afterSequence: number, limit: number): RealtimeEvent[] {
    const rows = this.listAfterSequenceStmt.all({
      afterSequence,
      limit,
    }) as unknown as RealtimeEventRow[];
    return rows.map(mapRealtimeEventRow);
  }

  public getSequenceBounds(): { oldestSequence?: number; newestSequence?: number } {
    const row = this.boundsStmt.get() as
      | {
        oldest_sequence?: number | null;
        newest_sequence?: number | null;
      }
      | undefined;
    return {
      oldestSequence: typeof row?.oldest_sequence === "number" ? row.oldest_sequence : undefined,
      newestSequence: typeof row?.newest_sequence === "number" ? row.newest_sequence : undefined,
    };
  }

  public pruneOlderThan(cutoffIso: string): number {
    const before = this.db.prepare("SELECT COUNT(*) AS count FROM realtime_events WHERE created_at < ?")
      .get(cutoffIso) as { count: number } | undefined;
    const count = Number(before?.count ?? 0);
    if (count <= 0) {
      return 0;
    }
    this.pruneOlderThanStmt.run({ cutoff: cutoffIso });
    return count;
  }
}

interface CompositeCursor {
  timestamp: string;
  key: string;
}

function parseCompositeCursor(cursor?: string): CompositeCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) {
    return {
      timestamp: cursor,
      key: "",
    };
  }

  const timestamp = cursor.slice(0, separator);
  const key = cursor.slice(separator + 1);
  if (!timestamp || !key) {
    return undefined;
  }

  return { timestamp, key };
}

function parseSequenceCursor(cursor?: string): number | undefined {
  if (!cursor || !/^\d+$/.test(cursor.trim())) {
    return undefined;
  }
  const value = Number.parseInt(cursor.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function mapRealtimeEventRow(row: RealtimeEventRow): RealtimeEvent {
  const payload = safeJsonParse<Record<string, unknown>>(row.payload_json, {});
  return {
    eventId: row.event_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    source: row.source,
    timestamp: row.created_at,
    ...extractRealtimeMetadata(payload),
    payload,
  };
}

function extractRealtimeMetadata(payload: Record<string, unknown>): Pick<
  RealtimeEvent,
  "correlationId" | "traceId" | "originSurface"
> {
  return {
    correlationId: typeof payload.correlationId === "string" ? payload.correlationId : undefined,
    traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    originSurface: typeof payload.originSurface === "string" ? payload.originSurface : undefined,
  };
}
