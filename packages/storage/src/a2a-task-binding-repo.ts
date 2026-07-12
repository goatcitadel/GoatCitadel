import type { A2ABridgeTaskState, A2ATaskBindingRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface A2ATaskBindingRow {
  a2a_task_id: string;
  context_id: string;
  peer_id: string;
  workspace_id: string;
  session_id: string | null;
  local_task_id: string | null;
  durable_run_id: string | null;
  state: A2ABridgeTaskState;
  last_event_sequence: number;
  idempotency_key: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export class A2ATaskBindingRepository {
  private readonly databaseNowStmt;
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getForUpdateStmt;
  private readonly findByIdempotencyStmt;
  private readonly updateStmt;
  private readonly listByPeerStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.databaseNowStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          SELECT to_char(
            clock_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS now_iso
        `
        : `
          SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso
        `,
    );
    this.insertStmt = db.prepare(`
      INSERT INTO a2a_task_bindings (
        a2a_task_id, context_id, peer_id, workspace_id, session_id, local_task_id,
        durable_run_id, state, last_event_sequence, idempotency_key, metadata_json, created_at, updated_at
      ) VALUES (
        @a2aTaskId, @contextId, @peerId, @workspaceId, @sessionId, @localTaskId,
        @durableRunId, @state, @lastEventSequence, @idempotencyKey, @metadataJson, @createdAt, @updatedAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM a2a_task_bindings WHERE a2a_task_id = ?");
    this.getForUpdateStmt = db.prepare(
      db.dialect === "postgres"
        ? "SELECT * FROM a2a_task_bindings WHERE a2a_task_id = ? FOR UPDATE"
        : "SELECT * FROM a2a_task_bindings WHERE a2a_task_id = ?",
    );
    this.findByIdempotencyStmt = db.prepare(`
      SELECT *
      FROM a2a_task_bindings
      WHERE peer_id = @peerId
        AND idempotency_key = @idempotencyKey
      LIMIT 1
    `);
    this.updateStmt = db.prepare(`
      UPDATE a2a_task_bindings
      SET context_id = @contextId,
          workspace_id = @workspaceId,
          session_id = @sessionId,
          local_task_id = @localTaskId,
          durable_run_id = @durableRunId,
          state = @state,
          last_event_sequence = @lastEventSequence,
          metadata_json = @metadataJson,
          updated_at = @updatedAt
      WHERE a2a_task_id = @a2aTaskId
    `);
    this.listByPeerStmt = db.prepare(`
      SELECT *
      FROM a2a_task_bindings
      WHERE peer_id = @peerId
      ORDER BY updated_at DESC, a2a_task_id DESC
      LIMIT @limit
    `);
  }

  public createOrGet(
    input: {
      a2aTaskId: string;
      contextId: string;
      peerId: string;
      workspaceId?: string;
      sessionId?: string;
      localTaskId?: string;
      durableRunId?: string;
      state?: A2ABridgeTaskState;
      lastEventSequence?: number;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
    },
    now = new Date().toISOString(),
  ): A2ATaskBindingRecord {
    return this.db.transaction("immediate", () => {
      const existingByIdempotency = this.findByIdempotency(input.peerId, input.idempotencyKey);
      if (existingByIdempotency) {
        assertCompatibleReplay(existingByIdempotency, input);
        return existingByIdempotency;
      }
      const existingByTaskId = this.find(input.a2aTaskId);
      if (existingByTaskId) {
        assertCompatibleReplay(existingByTaskId, input);
        return existingByTaskId;
      }
      this.insertStmt.run({
        a2aTaskId: input.a2aTaskId,
        contextId: input.contextId,
        peerId: input.peerId,
        workspaceId: input.workspaceId ?? "default",
        sessionId: input.sessionId ?? null,
        localTaskId: input.localTaskId ?? null,
        durableRunId: input.durableRunId ?? null,
        state: input.state ?? "submitted",
        lastEventSequence: input.lastEventSequence ?? 0,
        idempotencyKey: input.idempotencyKey,
        metadataJson: stringifyJson(input.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      });
      const canonical = this.findByIdempotency(input.peerId, input.idempotencyKey) ?? this.find(input.a2aTaskId);
      if (!canonical) {
        throw new Error(`A2A task binding ${input.a2aTaskId} was not persisted.`);
      }
      assertCompatibleReplay(canonical, input);
      return canonical;
    });
  }

  public get(a2aTaskId: string): A2ATaskBindingRecord {
    const record = this.find(a2aTaskId);
    if (!record) {
      throw new Error(`Unknown A2A task binding ${a2aTaskId}`);
    }
    return record;
  }

  public getForUpdate(a2aTaskId: string): A2ATaskBindingRecord {
    const row = toA2ATaskBindingRow(this.getForUpdateStmt.get(a2aTaskId));
    if (!row) {
      throw new Error(`Unknown A2A task binding ${a2aTaskId}`);
    }
    return mapA2ATaskBindingRow(row);
  }

  public find(a2aTaskId: string): A2ATaskBindingRecord | undefined {
    const row = toA2ATaskBindingRow(this.getStmt.get(a2aTaskId));
    return row ? mapA2ATaskBindingRow(row) : undefined;
  }

  public findByIdempotency(peerId: string, idempotencyKey: string): A2ATaskBindingRecord | undefined {
    const row = toA2ATaskBindingRow(
      this.findByIdempotencyStmt.get({
        peerId,
        idempotencyKey,
      }),
    );
    return row ? mapA2ATaskBindingRow(row) : undefined;
  }

  public readDatabaseNow(): string {
    const row = this.databaseNowStmt.get<{ now_iso?: unknown }>();
    if (typeof row?.now_iso !== "string" || !Number.isFinite(Date.parse(row.now_iso))) {
      throw new Error("Database did not return a valid A2A dispatch clock.");
    }
    return row.now_iso;
  }

  public update(
    a2aTaskId: string,
    patch: Partial<
      Pick<
        A2ATaskBindingRecord,
        | "contextId"
        | "workspaceId"
        | "sessionId"
        | "localTaskId"
        | "durableRunId"
        | "state"
        | "lastEventSequence"
        | "metadata"
      >
    >,
    now = new Date().toISOString(),
  ): A2ATaskBindingRecord {
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(a2aTaskId);
      const next: A2ATaskBindingRecord = {
        ...current,
        ...patch,
        metadata: patch.metadata ?? current.metadata,
        updatedAt: now,
      };
      this.updateStmt.run({
        a2aTaskId: next.a2aTaskId,
        contextId: next.contextId,
        workspaceId: next.workspaceId,
        sessionId: next.sessionId ?? null,
        localTaskId: next.localTaskId ?? null,
        durableRunId: next.durableRunId ?? null,
        state: next.state,
        lastEventSequence: next.lastEventSequence,
        metadataJson: stringifyJson(next.metadata),
        updatedAt: next.updatedAt,
      });
      return this.get(a2aTaskId);
    });
  }

  public listByPeer(peerId: string, limit = 100): A2ATaskBindingRecord[] {
    const rows = this.listByPeerStmt
      .all({ peerId, limit: clampLimit(limit) })
      .map(toA2ATaskBindingRow)
      .filter((row): row is A2ATaskBindingRow => Boolean(row));
    return rows.map((row) => mapA2ATaskBindingRow(row));
  }
}

function assertCompatibleReplay(
  existing: A2ATaskBindingRecord,
  input: {
    a2aTaskId: string;
    contextId: string;
    peerId: string;
    workspaceId?: string;
    idempotencyKey: string;
  },
): void {
  const workspaceId = input.workspaceId ?? "default";
  const conflicts =
    existing.a2aTaskId !== input.a2aTaskId ||
    existing.peerId !== input.peerId ||
    existing.idempotencyKey !== input.idempotencyKey ||
    existing.contextId !== input.contextId ||
    existing.workspaceId !== workspaceId;
  if (conflicts) {
    throw new Error(`A2A task ${input.a2aTaskId} conflicts with the persisted A2A binding owner or request identity.`);
  }
}

function mapA2ATaskBindingRow(row: A2ATaskBindingRow): A2ATaskBindingRecord {
  return {
    a2aTaskId: row.a2a_task_id,
    contextId: row.context_id,
    peerId: row.peer_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id ?? undefined,
    localTaskId: row.local_task_id ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
    state: row.state,
    lastEventSequence: Number(row.last_event_sequence) || 0,
    idempotencyKey: row.idempotency_key,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toA2ATaskBindingRow(value: unknown): A2ATaskBindingRow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as A2ATaskBindingRow;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  const parsed = safeJsonParse(raw, {});
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function stringifyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(500, Math.floor(limit)));
}
