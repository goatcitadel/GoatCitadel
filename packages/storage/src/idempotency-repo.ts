import type { InboundEventIndexRow } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface InboundEventRow {
  endpoint: string;
  idempotency_key: string;
  event_id: string;
  session_key: string;
  payload_hash: string;
  received_at: string;
  processed_at: string | null;
  status: InboundEventIndexRow["status"];
}

export class IdempotencyRepository {
  private readonly findStmt;
  private readonly insertStmt;
  private readonly insertIgnoreStmt;
  private readonly markProcessedStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.findStmt = db.prepare(
      "SELECT * FROM inbound_events WHERE endpoint = ? AND idempotency_key = ?",
    );
    this.insertStmt = db.prepare(`
      INSERT INTO inbound_events (
        endpoint, idempotency_key, event_id, session_key, payload_hash, received_at, status
      ) VALUES (@endpoint, @idempotencyKey, @eventId, @sessionKey, @payloadHash, @receivedAt, @status)
    `);
    this.insertIgnoreStmt = db.prepare(`
      INSERT INTO inbound_events (
        endpoint, idempotency_key, event_id, session_key, payload_hash, received_at, status
      ) VALUES (@endpoint, @idempotencyKey, @eventId, @sessionKey, @payloadHash, @receivedAt, @status)
      ON CONFLICT DO NOTHING
    `);
    this.markProcessedStmt = db.prepare(`
      UPDATE inbound_events
      SET processed_at = @processedAt, status = @status
      WHERE endpoint = @endpoint AND idempotency_key = @idempotencyKey
    `);
  }

  public find(endpoint: string, idempotencyKey: string): InboundEventIndexRow | undefined {
    const row = this.findStmt.get(endpoint, idempotencyKey) as InboundEventRow | undefined;
    if (!row) {
      return undefined;
    }

    return {
      endpoint: row.endpoint,
      idempotencyKey: row.idempotency_key,
      eventId: row.event_id,
      sessionKey: row.session_key,
      payloadHash: row.payload_hash,
      receivedAt: row.received_at,
      processedAt: row.processed_at ?? undefined,
      status: row.status,
    };
  }

  public insertPending(row: InboundEventIndexRow): void {
    this.insertStmt.run({
      endpoint: row.endpoint,
      idempotencyKey: row.idempotencyKey,
      eventId: row.eventId,
      sessionKey: row.sessionKey,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      status: row.status,
    });
  }

  public insertPendingIfAbsent(row: InboundEventIndexRow): boolean {
    const changes = this.insertIgnoreStmt.run({
      endpoint: row.endpoint,
      idempotencyKey: row.idempotencyKey,
      eventId: row.eventId,
      sessionKey: row.sessionKey,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      status: row.status,
    }).changes;
    return changes > 0;
  }

  public markProcessed(endpoint: string, idempotencyKey: string, status: InboundEventIndexRow["status"], processedAt: string): void {
    this.markProcessedStmt.run({
      endpoint,
      idempotencyKey,
      status,
      processedAt,
    });
  }
}


