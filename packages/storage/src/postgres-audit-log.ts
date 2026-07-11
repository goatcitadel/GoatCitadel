import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { sanitizeForAudit, type AuditAppendOptions, type AuditStream } from "./audit-log.js";
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
      ON CONFLICT (stream_name, event_id) DO NOTHING
    `);
    this.listStmt = db.prepare(`
      SELECT payload
      FROM audit_events
      WHERE stream_name = ?
      ORDER BY event_sequence ASC, occurred_at ASC
    `);
  }

  public async append(
    stream: AuditStream,
    payload: Record<string, unknown>,
    options?: AuditAppendOptions,
  ): Promise<void> {
    const attribution = options?.attribution ?? getRequestAttribution();
    const baseRecord = {
      ...payload,
      timestamp:
        options?.occurredAt ?? (typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString()),
      correlationId: payload.correlationId ?? attribution?.correlationId,
      traceId: payload.traceId ?? attribution?.traceId,
      originSurface: payload.originSurface ?? attribution?.originSurface,
      actorId: payload.actorId ?? attribution?.actorId,
      deviceId: payload.deviceId ?? attribution?.deviceId,
      grantId: payload.grantId ?? attribution?.grantId,
      companionSessionId: payload.companionSessionId ?? attribution?.companionSessionId,
      ...(options?.deliveryId ? { eventId: options.deliveryId, deliveryId: options.deliveryId } : {}),
    };
    const sanitizedRecord = sanitizeForAudit(baseRecord);
    this.db.transaction("immediate", () => {
      const nextSequenceRow = this.nextSequenceStmt.get(stream) as { next_sequence?: number } | undefined;
      const nextSequence = Number(nextSequenceRow?.next_sequence ?? 1);
      const payloadJson = sanitizeJsonbPayloadText(JSON.stringify(sanitizeJsonValueForJsonb(sanitizedRecord)));
      this.insertStmt.run({
        streamName: stream,
        eventId: options?.deliveryId ?? String(payload.eventId ?? randomUUID()),
        eventSequence: nextSequence,
        occurredAt: String(baseRecord.timestamp),
        actorId: typeof baseRecord.actorId === "string" ? baseRecord.actorId : null,
        payload: payloadJson,
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

function sanitizeJsonValueForJsonb(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeJsonbString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValueForJsonb(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        sanitizeJsonbString(key),
        sanitizeJsonValueForJsonb(entry),
      ]),
    );
  }
  return value;
}

function sanitizeJsonbString(value: string): string {
  let sanitized = "";
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint === 0x0000) {
      continue;
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const nextCodePoint = value.charCodeAt(index + 1);
      if (nextCodePoint >= 0xdc00 && nextCodePoint <= 0xdfff) {
        sanitized += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      }
      continue;
    }
    if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      continue;
    }
    sanitized += value.charAt(index);
  }
  return sanitized;
}

function sanitizeJsonbPayloadText(value: string): string {
  return value
    .replace(/\\u0000/gi, "")
    .replace(/\\u(d[89ab][0-9a-f]{2})(?!\\u(d[cdef][0-9a-f]{2}))/gi, "")
    .replace(/(?<!\\u(d[89ab][0-9a-f]{2}))\\u(d[cdef][0-9a-f]{2})/gi, "");
}
