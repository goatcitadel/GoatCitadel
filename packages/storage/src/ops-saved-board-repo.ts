import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  OPS_SAVED_BOARD_SCHEMA_VERSION,
  assertOpsSavedBoardRecord,
  canonicalJsonString,
  normalizeOpsSavedBoardCreateInput,
  normalizeOpsSavedBoardStatusInput,
  normalizeOpsSavedBoardUpdateInput,
  type OpsSavedBoardCreateInput,
  type OpsSavedBoardPlacement,
  type OpsSavedBoardRecord,
  type OpsSavedBoardStatus,
  type OpsSavedBoardStatusInput,
  type OpsSavedBoardUpdateInput,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface OpsSavedBoardRow {
  workspace_id: string;
  board_id: string;
  schema_version: string;
  name: string;
  description: string | null;
  layout_json: string;
  status: string;
  revision: number | bigint | string;
  created_by_actor_id: string;
  created_at: string;
  updated_by_actor_id: string;
  updated_at: string;
  archived_by_actor_id: string | null;
  archived_at: string | null;
  idempotency_key: string;
  request_sha256: string;
}

export interface OpsSavedBoardCreateOutcome {
  record: OpsSavedBoardRecord;
  inserted: boolean;
}

export class OpsSavedBoardRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByIdempotencyStmt;
  private readonly listActiveStmt;
  private readonly listAllStmt;
  private readonly updateStmt;
  private readonly archiveStmt;
  private readonly restoreStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO ops_saved_boards (
        workspace_id, board_id, schema_version, name, description, layout_json, status, revision,
        created_by_actor_id, created_at, updated_by_actor_id, updated_at,
        archived_by_actor_id, archived_at, idempotency_key, request_sha256
      ) VALUES (
        @workspaceId, @boardId, @schemaVersion, @name, @description, @layoutJson, 'active', 1,
        @actorId, @now, @actorId, @now, NULL, NULL, @idempotencyKey, @requestSha256
      )
      ON CONFLICT(workspace_id, idempotency_key) DO NOTHING
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM ops_saved_boards
      WHERE workspace_id = @workspaceId AND board_id = @boardId
    `);
    this.getByIdempotencyStmt = db.prepare(`
      SELECT * FROM ops_saved_boards
      WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey
    `);
    this.listActiveStmt = db.prepare(`
      SELECT * FROM ops_saved_boards
      WHERE workspace_id = @workspaceId AND status = 'active'
      ORDER BY updated_at DESC, board_id DESC
      LIMIT 64
    `);
    this.listAllStmt = db.prepare(`
      SELECT * FROM ops_saved_boards
      WHERE workspace_id = @workspaceId
      ORDER BY updated_at DESC, board_id DESC
      LIMIT 64
    `);
    this.updateStmt = db.prepare(`
      UPDATE ops_saved_boards SET
        name = @name,
        description = @description,
        layout_json = @layoutJson,
        revision = revision + 1,
        updated_by_actor_id = @actorId,
        updated_at = @now
      WHERE workspace_id = @workspaceId
        AND board_id = @boardId
        AND status = 'active'
        AND revision = @expectedRevision
    `);
    this.archiveStmt = db.prepare(`
      UPDATE ops_saved_boards SET
        status = 'archived',
        revision = revision + 1,
        updated_by_actor_id = @actorId,
        updated_at = @now,
        archived_by_actor_id = @actorId,
        archived_at = @now
      WHERE workspace_id = @workspaceId
        AND board_id = @boardId
        AND status = 'active'
        AND revision = @expectedRevision
    `);
    this.restoreStmt = db.prepare(`
      UPDATE ops_saved_boards SET
        status = 'active',
        revision = revision + 1,
        updated_by_actor_id = @actorId,
        updated_at = @now,
        archived_by_actor_id = NULL,
        archived_at = NULL
      WHERE workspace_id = @workspaceId
        AND board_id = @boardId
        AND status = 'archived'
        AND revision = @expectedRevision
    `);
  }

  public create(
    input: OpsSavedBoardCreateInput,
    actorId: string,
    now = new Date().toISOString(),
    boardId: string = randomUUID(),
  ): OpsSavedBoardRecord {
    return this.createWithOutcome(input, actorId, now, boardId).record;
  }

  public createWithOutcome(
    input: OpsSavedBoardCreateInput,
    actorId: string,
    now = new Date().toISOString(),
    boardId: string = randomUUID(),
  ): OpsSavedBoardCreateOutcome {
    const normalized = normalizeOpsSavedBoardCreateInput(input);
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const requestSha256 = computeOpsSavedBoardCreateRequestSha256(normalized, normalizedActorId);
    const candidate: OpsSavedBoardRecord = {
      schemaVersion: OPS_SAVED_BOARD_SCHEMA_VERSION,
      boardId: normalizedBoardId,
      workspaceId: normalized.workspaceId,
      name: normalized.name,
      ...(normalized.description === undefined ? {} : { description: normalized.description }),
      status: "active",
      placements: normalized.placements,
      revision: 1,
      createdByActorId: normalizedActorId,
      createdAt: now,
      updatedByActorId: normalizedActorId,
      updatedAt: now,
      idempotencyKey: normalized.idempotencyKey,
      requestSha256,
    };
    assertOpsSavedBoardRecord(candidate);

    return this.db.transaction("immediate", () => {
      const replay = this.findByIdempotency(normalized.workspaceId, normalized.idempotencyKey);
      if (replay) return { record: assertCreateReplay(replay, requestSha256), inserted: false };
      let inserted: boolean;
      try {
        const result = this.insertStmt.run({
          workspaceId: normalized.workspaceId,
          boardId: normalizedBoardId,
          schemaVersion: OPS_SAVED_BOARD_SCHEMA_VERSION,
          name: normalized.name,
          description: normalized.description ?? null,
          layoutJson: canonicalJsonString(normalized.placements),
          actorId: normalizedActorId,
          now,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
        });
        inserted = result.changes === 1;
      } catch (error) {
        throw normalizeBoardWriteError(error, normalizedBoardId);
      }
      const stored = this.findByIdempotency(normalized.workspaceId, normalized.idempotencyKey);
      if (!stored) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Ops saved board ${normalizedBoardId} conflicts with an existing board identity.`,
        });
      }
      return { record: assertCreateReplay(stored, requestSha256), inserted };
    });
  }

  public get(workspaceId: string, boardId: string): OpsSavedBoardRecord {
    const record = this.find(workspaceId, boardId);
    if (!record) throw new NotFoundError({ entity: "ops saved board", id: boardId });
    return record;
  }

  public find(workspaceId: string, boardId: string): OpsSavedBoardRecord | undefined {
    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const row = this.getStmt.get({ workspaceId: normalizedWorkspaceId, boardId: normalizedBoardId });
    return row === undefined ? undefined : mapAndValidateRow(row);
  }

  public listByWorkspace(workspaceId: string, includeArchived = false): OpsSavedBoardRecord[] {
    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    const statement = includeArchived ? this.listAllStmt : this.listActiveStmt;
    return statement.all({ workspaceId: normalizedWorkspaceId }).map(mapAndValidateRow);
  }

  public update(boardId: string, input: OpsSavedBoardUpdateInput, actorId: string, now = new Date().toISOString()) {
    const normalized = normalizeOpsSavedBoardUpdateInput(input);
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    return this.db.transaction("immediate", () => {
      const current = this.get(normalized.workspaceId, normalizedBoardId);
      assertMutableAtRevision(current, normalized.expectedRevision, "active");
      const next: OpsSavedBoardRecord = {
        ...current,
        name: normalized.name ?? current.name,
        ...(normalized.description === undefined
          ? current.description === undefined
            ? { description: undefined }
            : { description: current.description }
          : normalized.description === null
            ? { description: undefined }
            : { description: normalized.description }),
        placements: normalized.placements ?? current.placements,
        revision: current.revision + 1,
        updatedByActorId: normalizedActorId,
        updatedAt: now,
      };
      if (next.description === undefined) delete next.description;
      assertOpsSavedBoardRecord(next);
      assertMutationTimestampDoesNotRegress(current, next.updatedAt);
      let result;
      try {
        result = this.updateStmt.run({
          workspaceId: normalized.workspaceId,
          boardId: normalizedBoardId,
          name: next.name,
          description: next.description ?? null,
          layoutJson: canonicalJsonString(next.placements),
          actorId: normalizedActorId,
          now,
          expectedRevision: normalized.expectedRevision,
        });
      } catch (error) {
        throw normalizeBoardWriteError(error, normalizedBoardId);
      }
      if (result.changes !== 1)
        this.throwCasMiss(normalized.workspaceId, normalizedBoardId, normalized.expectedRevision);
      return this.get(normalized.workspaceId, normalizedBoardId);
    });
  }

  public archive(boardId: string, input: OpsSavedBoardStatusInput, actorId: string, now = new Date().toISOString()) {
    return this.transition(boardId, input, actorId, "archived", now);
  }

  public restore(boardId: string, input: OpsSavedBoardStatusInput, actorId: string, now = new Date().toISOString()) {
    return this.transition(boardId, input, actorId, "active", now);
  }

  private transition(
    boardId: string,
    input: OpsSavedBoardStatusInput,
    actorId: string,
    targetStatus: OpsSavedBoardStatus,
    now: string,
  ): OpsSavedBoardRecord {
    const normalized = normalizeOpsSavedBoardStatusInput(input);
    const normalizedBoardId = normalizeIdentifier(boardId, "boardId");
    const normalizedActorId = normalizeIdentifier(actorId, "actorId");
    return this.db.transaction("immediate", () => {
      const current = this.get(normalized.workspaceId, normalizedBoardId);
      const requiredCurrentStatus: OpsSavedBoardStatus = targetStatus === "archived" ? "active" : "archived";
      assertMutableAtRevision(current, normalized.expectedRevision, requiredCurrentStatus);
      const next: OpsSavedBoardRecord = {
        ...current,
        status: targetStatus,
        revision: current.revision + 1,
        updatedByActorId: normalizedActorId,
        updatedAt: now,
        ...(targetStatus === "archived"
          ? { archivedByActorId: normalizedActorId, archivedAt: now }
          : { archivedByActorId: undefined, archivedAt: undefined }),
      };
      if (targetStatus === "active") {
        delete next.archivedByActorId;
        delete next.archivedAt;
      }
      assertOpsSavedBoardRecord(next);
      assertMutationTimestampDoesNotRegress(current, next.updatedAt);
      const statement = targetStatus === "archived" ? this.archiveStmt : this.restoreStmt;
      let result;
      try {
        result = statement.run({
          workspaceId: normalized.workspaceId,
          boardId: normalizedBoardId,
          actorId: normalizedActorId,
          now,
          expectedRevision: normalized.expectedRevision,
        });
      } catch (error) {
        throw normalizeBoardWriteError(error, normalizedBoardId);
      }
      if (result.changes !== 1)
        this.throwCasMiss(normalized.workspaceId, normalizedBoardId, normalized.expectedRevision);
      return this.get(normalized.workspaceId, normalizedBoardId);
    });
  }

  private findByIdempotency(workspaceId: string, idempotencyKey: string): OpsSavedBoardRecord | undefined {
    const row = this.getByIdempotencyStmt.get({ workspaceId, idempotencyKey });
    return row === undefined ? undefined : mapAndValidateRow(row);
  }

  private throwCasMiss(workspaceId: string, boardId: string, expectedRevision: number): never {
    const current = this.find(workspaceId, boardId);
    if (!current) throw new NotFoundError({ entity: "ops saved board", id: boardId });
    throw revisionConflict(boardId, expectedRevision, current.revision);
  }
}

export function computeOpsSavedBoardCreateRequestSha256(input: OpsSavedBoardCreateInput, actorId: string): string {
  const normalized = normalizeOpsSavedBoardCreateInput(input);
  const normalizedActorId = normalizeIdentifier(actorId, "actorId");
  return createHash("sha256")
    .update(
      canonicalJsonString({
        schemaVersion: OPS_SAVED_BOARD_SCHEMA_VERSION,
        workspaceId: normalized.workspaceId,
        name: normalized.name,
        description: normalized.description ?? null,
        placements: normalized.placements,
        idempotencyKey: normalized.idempotencyKey,
        actorId: normalizedActorId,
      }),
      "utf8",
    )
    .digest("hex");
}

function mapAndValidateRow(value: unknown): OpsSavedBoardRecord {
  const row = toRow(value);
  if (!row) throw new Error("Ops saved board storage row is malformed.");
  const placements = safeJsonParse<unknown>(row.layout_json, undefined);
  if (!Array.isArray(placements) || canonicalJsonString(placements) !== row.layout_json) {
    throw new Error(`Ops saved board ${row.board_id} contains non-canonical layout JSON.`);
  }
  const revision = Number(row.revision);
  const record: OpsSavedBoardRecord = {
    schemaVersion: row.schema_version as OpsSavedBoardRecord["schemaVersion"],
    boardId: row.board_id,
    workspaceId: row.workspace_id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status as OpsSavedBoardStatus,
    placements: placements as OpsSavedBoardPlacement[],
    revision,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    updatedByActorId: row.updated_by_actor_id,
    updatedAt: row.updated_at,
    ...(row.archived_by_actor_id === null ? {} : { archivedByActorId: row.archived_by_actor_id }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
  };
  assertOpsSavedBoardRecord(record);
  return record;
}

function assertCreateReplay(record: OpsSavedBoardRecord, requestSha256: string): OpsSavedBoardRecord {
  if (record.requestSha256 !== requestSha256) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Ops saved board idempotency key ${record.idempotencyKey} was already used for different request bytes.`,
      details: { workspaceId: record.workspaceId, idempotencyKey: record.idempotencyKey },
    });
  }
  return record;
}

function assertMutableAtRevision(
  current: OpsSavedBoardRecord,
  expectedRevision: number,
  requiredStatus: OpsSavedBoardStatus,
): void {
  if (current.revision !== expectedRevision)
    throw revisionConflict(current.boardId, expectedRevision, current.revision);
  if (current.status !== requiredStatus) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Ops saved board ${current.boardId} must be ${requiredStatus} for this mutation.`,
      details: { boardId: current.boardId, requiredStatus, currentStatus: current.status },
    });
  }
}

function revisionConflict(boardId: string, expectedRevision: number, currentRevision: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `Ops saved board ${boardId} changed since revision ${expectedRevision}.`,
    details: { resourceKind: "ops_saved_board", resourceId: boardId, expectedRevision, currentRevision },
  });
}

function assertMutationTimestampDoesNotRegress(current: OpsSavedBoardRecord, proposedUpdatedAt: string): void {
  if (Date.parse(proposedUpdatedAt) < Date.parse(current.updatedAt)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Ops saved board ${current.boardId} mutation timestamp precedes its current update timestamp.`,
      details: {
        resourceKind: "ops_saved_board",
        resourceId: current.boardId,
        currentUpdatedAt: current.updatedAt,
        proposedUpdatedAt,
      },
    });
  }
}

function normalizeBoardWriteError(error: unknown, boardId: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/workspace limit|unique|foreign key|constraint|CAS or transition invariant/i.test(message)) {
    return new ConflictError({
      code: "STATE_CONFLICT",
      message: `Ops saved board ${boardId} conflicts with a storage invariant.`,
    });
  }
  return error instanceof Error ? error : new Error(message);
}

function normalizeIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    [...value].length < 1 ||
    [...value].length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Ops saved board ${field} is not a canonical identifier.`);
  }
  return value;
}

function toRow(value: unknown): OpsSavedBoardRow | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.workspace_id !== "string" ||
    typeof value.board_id !== "string" ||
    typeof value.schema_version !== "string" ||
    typeof value.name !== "string" ||
    (typeof value.description !== "string" && value.description !== null) ||
    typeof value.layout_json !== "string" ||
    typeof value.status !== "string" ||
    !["number", "bigint", "string"].includes(typeof value.revision) ||
    typeof value.created_by_actor_id !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.updated_by_actor_id !== "string" ||
    typeof value.updated_at !== "string" ||
    (typeof value.archived_by_actor_id !== "string" && value.archived_by_actor_id !== null) ||
    (typeof value.archived_at !== "string" && value.archived_at !== null) ||
    typeof value.idempotency_key !== "string" ||
    typeof value.request_sha256 !== "string"
  ) {
    return undefined;
  }
  return value as unknown as OpsSavedBoardRow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
