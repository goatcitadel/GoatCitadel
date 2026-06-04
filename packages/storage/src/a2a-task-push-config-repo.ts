import type {
  A2ATaskPushDeliveryStatus,
  A2ATaskPushEventKind,
  A2ATaskPushNotificationConfig,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export interface StoredA2ATaskPushNotificationConfig extends A2ATaskPushNotificationConfig {
  authToken?: string;
}

interface A2ATaskPushConfigRow {
  a2a_task_id: string;
  peer_id: string;
  url: string;
  events_json: string;
  enabled: number;
  auth_token: string | null;
  max_attempts: number;
  attempt_count: number;
  last_delivery_status: A2ATaskPushDeliveryStatus;
  last_delivery_error: string | null;
  last_delivered_at: string | null;
  next_retry_at: string | null;
  last_event_sequence: number;
  created_at: string;
  updated_at: string;
}

const VALID_EVENT_KINDS = new Set<A2ATaskPushEventKind>(["task.status", "task.message", "task.artifact"]);

export class A2ATaskPushConfigRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listByPeerStmt;
  private readonly deleteStmt;
  private readonly recordDeliveryStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO a2a_task_push_configs (
        a2a_task_id, peer_id, url, events_json, enabled, auth_token, max_attempts,
        attempt_count, last_delivery_status, last_delivery_error, last_delivered_at,
        next_retry_at, last_event_sequence, created_at, updated_at
      ) VALUES (
        @taskId, @peerId, @url, @eventsJson, @enabled, @authToken, @maxAttempts,
        @attemptCount, @lastDeliveryStatus, @lastDeliveryError, @lastDeliveredAt,
        @nextRetryAt, @lastEventSequence, @createdAt, @updatedAt
      )
      ON CONFLICT(a2a_task_id, peer_id) DO UPDATE SET
        url = excluded.url,
        events_json = excluded.events_json,
        enabled = excluded.enabled,
        auth_token = excluded.auth_token,
        max_attempts = excluded.max_attempts,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare(`
      SELECT *
      FROM a2a_task_push_configs
      WHERE a2a_task_id = @taskId
        AND peer_id = @peerId
      LIMIT 1
    `);
    this.listByPeerStmt = db.prepare(`
      SELECT *
      FROM a2a_task_push_configs
      WHERE peer_id = @peerId
      ORDER BY updated_at DESC, a2a_task_id DESC
      LIMIT @limit
    `);
    this.deleteStmt = db.prepare(`
      DELETE FROM a2a_task_push_configs
      WHERE a2a_task_id = @taskId
        AND peer_id = @peerId
    `);
    this.recordDeliveryStmt = db.prepare(`
      UPDATE a2a_task_push_configs
      SET attempt_count = @attemptCount,
          last_delivery_status = @status,
          last_delivery_error = @error,
          last_delivered_at = @deliveredAt,
          next_retry_at = @nextRetryAt,
          last_event_sequence = @lastEventSequence,
          updated_at = @updatedAt
      WHERE a2a_task_id = @taskId
        AND peer_id = @peerId
    `);
  }

  public upsert(
    input: {
      taskId: string;
      peerId: string;
      url: string;
      events?: A2ATaskPushEventKind[];
      enabled?: boolean;
      authToken?: string;
      maxAttempts?: number;
    },
    now = new Date().toISOString(),
  ): StoredA2ATaskPushNotificationConfig {
    const current = this.find(input.taskId, input.peerId);
    this.upsertStmt.run({
      taskId: input.taskId,
      peerId: input.peerId,
      url: input.url,
      eventsJson: JSON.stringify(normalizeEvents(input.events)),
      enabled: input.enabled === false ? 0 : 1,
      authToken: input.authToken?.trim() || null,
      maxAttempts: clampAttempts(input.maxAttempts),
      attemptCount: current?.attemptCount ?? 0,
      lastDeliveryStatus: current?.lastDeliveryStatus ?? "pending",
      lastDeliveryError: current?.lastDeliveryError ?? null,
      lastDeliveredAt: current?.lastDeliveredAt ?? null,
      nextRetryAt: current?.nextRetryAt ?? null,
      lastEventSequence: current?.lastEventSequence ?? 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    return this.get(input.taskId, input.peerId);
  }

  public get(taskId: string, peerId: string): StoredA2ATaskPushNotificationConfig {
    const record = this.find(taskId, peerId);
    if (!record) {
      throw new Error(`Unknown A2A push config ${taskId} for peer ${peerId}`);
    }
    return record;
  }

  public find(taskId: string, peerId: string): StoredA2ATaskPushNotificationConfig | undefined {
    const row = toA2ATaskPushConfigRow(this.getStmt.get({ taskId, peerId }));
    return row ? mapA2ATaskPushConfigRow(row) : undefined;
  }

  public listByPeer(peerId: string, limit = 100): StoredA2ATaskPushNotificationConfig[] {
    return this.listByPeerStmt
      .all({ peerId, limit: clampLimit(limit) })
      .map(toA2ATaskPushConfigRow)
      .filter((row): row is A2ATaskPushConfigRow => Boolean(row))
      .map(mapA2ATaskPushConfigRow);
  }

  public delete(taskId: string, peerId: string): boolean {
    return this.deleteStmt.run({ taskId, peerId }).changes > 0;
  }

  public recordDelivery(
    taskId: string,
    peerId: string,
    input: {
      status: A2ATaskPushDeliveryStatus;
      attemptCount: number;
      error?: string;
      deliveredAt?: string;
      nextRetryAt?: string;
      lastEventSequence: number;
    },
    now = new Date().toISOString(),
  ): StoredA2ATaskPushNotificationConfig {
    this.recordDeliveryStmt.run({
      taskId,
      peerId,
      attemptCount: Math.max(0, Math.floor(input.attemptCount)),
      status: input.status,
      error: input.error?.slice(0, 1000) ?? null,
      deliveredAt: input.deliveredAt ?? null,
      nextRetryAt: input.nextRetryAt ?? null,
      lastEventSequence: Math.max(0, Math.floor(input.lastEventSequence)),
      updatedAt: now,
    });
    return this.get(taskId, peerId);
  }
}

function mapA2ATaskPushConfigRow(row: A2ATaskPushConfigRow): StoredA2ATaskPushNotificationConfig {
  const authToken = row.auth_token?.trim() || undefined;
  return {
    taskId: row.a2a_task_id,
    peerId: row.peer_id,
    url: row.url,
    events: normalizeEvents(parseEventArray(row.events_json)),
    enabled: Boolean(row.enabled),
    maxAttempts: clampAttempts(row.max_attempts),
    attemptCount: Number(row.attempt_count) || 0,
    lastDeliveryStatus: normalizeDeliveryStatus(row.last_delivery_status),
    lastDeliveryError: row.last_delivery_error ?? undefined,
    lastDeliveredAt: row.last_delivered_at ?? undefined,
    nextRetryAt: row.next_retry_at ?? undefined,
    lastEventSequence: Number(row.last_event_sequence) || 0,
    ...(authToken ? { authToken, auth: { scheme: "bearer", tokenPreview: maskToken(authToken) } } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toA2ATaskPushConfigRow(value: unknown): A2ATaskPushConfigRow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as A2ATaskPushConfigRow;
}

function parseEventArray(raw: string): unknown[] {
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeEvents(value: unknown): A2ATaskPushEventKind[] {
  const events = Array.isArray(value)
    ? value.filter((item): item is A2ATaskPushEventKind => {
        if (typeof item !== "string") {
          return false;
        }
        return VALID_EVENT_KINDS.has(item as A2ATaskPushEventKind);
      })
    : [];
  return events.length ? [...new Set(events)] : ["task.status"];
}

function normalizeDeliveryStatus(value: unknown): A2ATaskPushDeliveryStatus {
  return value === "delivered" || value === "retry_scheduled" || value === "dead_lettered" || value === "blocked"
    ? value
    : "pending";
}

function clampAttempts(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(5, Math.floor(parsed))) : 3;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(500, Math.floor(limit)));
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return "***";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
