import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { CommsSendResult } from "@goatcitadel/contracts";

interface CommsDeliveryRow {
  delivery_id: string;
  connection_id: string;
  channel_key: string;
  target: string;
  payload_hash: string;
  status: "queued" | "sent" | "failed";
  provider_msg_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class CommsDeliveryRepository {
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly listStmt;
  private readonly listByConnectionStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO comms_deliveries (
        delivery_id, connection_id, channel_key, target, payload_hash, status,
        provider_msg_id, error, created_at, updated_at
      ) VALUES (
        @deliveryId, @connectionId, @channelKey, @target, @payloadHash, @status,
        @providerMsgId, @error, @createdAt, @updatedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE comms_deliveries
      SET status = @status, provider_msg_id = @providerMsgId, error = @error, updated_at = @updatedAt
      WHERE delivery_id = @deliveryId
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM comms_deliveries
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByConnectionStmt = db.prepare(`
      SELECT * FROM comms_deliveries
      WHERE connection_id = @connectionId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
  }

  public createQueued(input: {
    connectionId: string;
    channelKey: string;
    target: string;
    payload: Record<string, unknown>;
  }, now = new Date().toISOString()): CommsSendResult {
    const deliveryId = randomUUID();
    const payloadHash = createHash("sha256").update(JSON.stringify(input.payload)).digest("hex");
    this.insertStmt.run({
      deliveryId,
      connectionId: input.connectionId,
      channelKey: input.channelKey,
      target: input.target,
      payloadHash,
      status: "queued",
      providerMsgId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      deliveryId,
      status: "queued",
      channelKey: input.channelKey,
      target: input.target,
      createdAt: now,
      updatedAt: now,
    };
  }

  public markSent(deliveryId: string, providerMessageId?: string, updatedAt = new Date().toISOString()): void {
    this.updateStmt.run({
      deliveryId,
      status: "sent",
      providerMsgId: providerMessageId ?? null,
      error: null,
      updatedAt,
    });
  }

  public markFailed(deliveryId: string, error: string, updatedAt = new Date().toISOString()): void {
    this.updateStmt.run({
      deliveryId,
      status: "failed",
      providerMsgId: null,
      error,
      updatedAt,
    });
  }

  public list(connectionId?: string, limit = 200): CommsSendResult[] {
    const rows = toCommsDeliveryRows((connectionId ? this.listByConnectionStmt : this.listStmt).all({
      connectionId,
      limit,
    }));
    return rows.map((row) => ({
      deliveryId: row.delivery_id,
      status: row.status,
      providerMessageId: row.provider_msg_id ?? undefined,
      channelKey: row.channel_key,
      target: row.target,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}

function toCommsDeliveryRows(value: unknown): CommsDeliveryRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isCommsDeliveryRow);
}

function isCommsDeliveryRow(value: unknown): value is CommsDeliveryRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.delivery_id === "string"
    && typeof value.connection_id === "string"
    && typeof value.channel_key === "string"
    && typeof value.target === "string"
    && typeof value.payload_hash === "string"
    && typeof value.status === "string"
    && (typeof value.provider_msg_id === "string" || value.provider_msg_id === null)
    && (typeof value.error === "string" || value.error === null)
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


