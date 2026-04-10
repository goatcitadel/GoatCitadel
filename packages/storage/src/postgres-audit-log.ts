import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { sanitizeForAudit, type AuditStream } from "./audit-log.js";
import { getRequestAttribution } from "./request-attribution.js";

export class PostgresAuditLog {
  private readonly nextSequenceStmt;
  private readonly insertStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.nextSequenceStmt = db.prepare(`
      SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence
      FROM audit_events
      WHERE stream_name = ?
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO audit_events (
        stream_name,
        event_id,
        event_sequence,
        legacy_offset,
        occurred_at,
        actor_id,
        payload
      ) VALUES (
        @streamName,
        @eventId,
        @eventSequence,
        NULL,
        @occurredAt,
        @actorId,
        @payload
      )
    `);
    this.listStmt = db.prepare(`
      SELECT payload
      FROM audit_events
      WHERE stream_name = ?
      ORDER BY event_sequence ASC, occurred_at ASC
    `);
  }

  public async append(stream: AuditStream, payload: Record<string, unknown>): Promise<void> {
    const attribution = getRequestAttribution();
    const baseRecord = {
      timestamp: new Date().toISOString(),
      ...payload,
      correlationId: payload.correlationId ?? attribution?.correlationId,
      traceId: payload.traceId ?? attribution?.traceId,
      originSurface: payload.originSurface ?? attribution?.originSurface,
      actorId: payload.actorId ?? attribution?.actorId,
      deviceId: payload.deviceId ?? attribution?.deviceId,
      grantId: payload.grantId ?? attribution?.grantId,
      companionSessionId: payload.companionSessionId ?? attribution?.companionSessionId,
    };
    const sanitizedRecord = sanitizeForAudit(baseRecord);
    this.db.transaction("immediate", () => {
      const nextSequenceRow = this.nextSequenceStmt.get(stream) as { next_sequence?: number } | undefined;
      const nextSequence = Number(nextSequenceRow?.next_sequence ?? 1);
      this.insertStmt.run({
        streamName: stream,
        eventId: String(payload.eventId ?? randomUUID()),
        eventSequence: nextSequence,
        occurredAt: String(baseRecord.timestamp),
        actorId: typeof baseRecord.actorId === "string" ? baseRecord.actorId : null,
        payload: JSON.stringify(sanitizedRecord),
      });
    });
  }

  public async list(stream: AuditStream): Promise<Record<string, unknown>[]> {
    const rows = this.listStmt.all(stream) as Array<{ payload?: string | Record<string, unknown> }>;
    return rows.flatMap((row) => {
      if (!row.payload) {
        return [];
      }
      if (typeof row.payload === "string") {
        try {
          const parsed = JSON.parse(row.payload);
          return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      }
      return [row.payload];
    });
  }
}
