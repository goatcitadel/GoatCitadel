import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  ContextManifestDetail,
  ContextManifestEntryKind,
  ContextManifestEntryRecord,
  ContextManifestRecord,
  ContextManifestScope,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ContextManifestRow {
  manifest_id: string;
  scope: ContextManifestScope;
  turn_id: string;
  session_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  entry_count: number;
}

interface ContextManifestEntryRow {
  entry_id: string;
  manifest_id: string;
  kind: ContextManifestEntryKind;
  entry_index: number;
  title: string | null;
  source_ref: string | null;
  content_text: string | null;
  content_hash: string;
  metadata_json: string;
  created_at: string;
}

export interface ContextManifestEnsureInput {
  scope: ContextManifestScope;
  turnId: string;
  sessionId?: string;
  taskId?: string;
  createdAt?: string;
}

export interface ContextManifestAppendEntryInput {
  manifestId: string;
  kind: ContextManifestEntryKind;
  entryIndex: number;
  title?: string;
  sourceRef?: string;
  contentText?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export class ContextManifestRepository {
  private readonly ensureStmt;
  private readonly getByTurnStmt;
  private readonly listEntriesStmt;
  private readonly insertEntryStmt;
  private readonly touchStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.ensureStmt = db.prepare(`
      INSERT INTO context_manifests (
        manifest_id, scope, turn_id, session_id, task_id, created_at, updated_at
      ) VALUES (
        @manifestId, @scope, @turnId, @sessionId, @taskId, @createdAt, @updatedAt
      )
      ON CONFLICT(turn_id) DO UPDATE SET
        scope = excluded.scope,
        session_id = excluded.session_id,
        task_id = excluded.task_id,
        updated_at = excluded.updated_at
    `);
    this.getByTurnStmt = db.prepare(`
      SELECT
        manifest_id,
        scope,
        turn_id,
        session_id,
        task_id,
        created_at,
        updated_at,
        (
          SELECT COUNT(*)
          FROM context_manifest_entries entries
          WHERE entries.manifest_id = context_manifests.manifest_id
        ) AS entry_count
      FROM context_manifests
      WHERE turn_id = @turnId
      LIMIT 1
    `);
    this.listEntriesStmt = db.prepare(`
      SELECT *
      FROM context_manifest_entries
      WHERE manifest_id = @manifestId
      ORDER BY entry_index ASC, created_at ASC
    `);
    this.insertEntryStmt = db.prepare(`
      INSERT INTO context_manifest_entries (
        entry_id, manifest_id, kind, entry_index, title, source_ref,
        content_text, content_hash, metadata_json, created_at
      ) VALUES (
        @entryId, @manifestId, @kind, @entryIndex, @title, @sourceRef,
        @contentText, @contentHash, @metadataJson, @createdAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.touchStmt = db.prepare(`
      UPDATE context_manifests
      SET updated_at = @updatedAt
      WHERE manifest_id = @manifestId
    `);
  }

  public ensure(input: ContextManifestEnsureInput): ContextManifestRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.ensureStmt.run({
      manifestId: randomUUID(),
      scope: input.scope,
      turnId: input.turnId,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      createdAt,
      updatedAt: createdAt,
    });
    return this.getByTurn(input.turnId);
  }

  public getByTurn(turnId: string): ContextManifestRecord {
    const row = toContextManifestRow(this.getByTurnStmt.get({ turnId }));
    if (!row) {
      throw new NotFoundError({ entity: "Context manifest", id: turnId });
    }
    return mapManifestRow(row);
  }

  public getDetailByTurn(turnId: string): ContextManifestDetail {
    const manifest = this.getByTurn(turnId);
    const entries = this.listEntries(manifest.manifestId);
    return {
      manifest: {
        ...manifest,
        entryCount: entries.length,
      },
      entries,
    };
  }

  public maybeGetDetailByTurn(turnId: string): ContextManifestDetail | undefined {
    const row = toContextManifestRow(this.getByTurnStmt.get({ turnId }));
    if (!row) {
      return undefined;
    }
    const manifest = mapManifestRow(row);
    const entries = this.listEntries(manifest.manifestId);
    return {
      manifest: {
        ...manifest,
        entryCount: entries.length,
      },
      entries,
    };
  }

  public listEntries(manifestId: string): ContextManifestEntryRecord[] {
    const rows = toContextManifestEntryRows(this.listEntriesStmt.all({ manifestId }));
    return rows.map(mapEntryRow);
  }

  public appendEntry(input: ContextManifestAppendEntryInput): ContextManifestEntryRecord | undefined {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const contentHash = createContentHash(input);
    const result = this.insertEntryStmt.run({
      entryId: randomUUID(),
      manifestId: input.manifestId,
      kind: input.kind,
      entryIndex: input.entryIndex,
      title: input.title ?? null,
      sourceRef: input.sourceRef ?? null,
      contentText: input.contentText ?? null,
      contentHash,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt,
    }) as { changes?: number };
    if ((result.changes ?? 0) > 0) {
      this.touchStmt.run({
        manifestId: input.manifestId,
        updatedAt: createdAt,
      });
    }
    return this.listEntries(input.manifestId).find((entry) =>
      entry.kind === input.kind
      && entry.sourceRef === input.sourceRef
      && entry.contentHash === contentHash,
    );
  }
}

function mapManifestRow(row: ContextManifestRow): ContextManifestRecord {
  return {
    manifestId: row.manifest_id,
    scope: row.scope,
    turnId: row.turn_id,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entryCount: row.entry_count,
  };
}

function mapEntryRow(row: ContextManifestEntryRow): ContextManifestEntryRecord {
  return {
    entryId: row.entry_id,
    manifestId: row.manifest_id,
    kind: row.kind,
    entryIndex: row.entry_index,
    title: row.title ?? undefined,
    sourceRef: row.source_ref ?? undefined,
    contentText: row.content_text ?? undefined,
    contentHash: row.content_hash,
    metadata: parseContextManifestMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

function createContentHash(input: ContextManifestAppendEntryInput): string {
  return createHash("sha256").update(JSON.stringify({
    kind: input.kind,
    sourceRef: input.sourceRef ?? null,
    contentText: input.contentText ?? null,
    metadata: input.metadata ?? {},
  })).digest("hex");
}

function parseContextManifestMetadata(value: string): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value, {});
  return isRecord(parsed) ? parsed : {};
}

function toContextManifestRow(value: unknown): ContextManifestRow | undefined {
  return isContextManifestRow(value) ? value : undefined;
}

function toContextManifestEntryRows(value: unknown): ContextManifestEntryRow[] {
  return Array.isArray(value) ? value.filter(isContextManifestEntryRow) : [];
}

function isContextManifestRow(value: unknown): value is ContextManifestRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.manifest_id === "string"
    && typeof value.scope === "string"
    && typeof value.turn_id === "string"
    && (typeof value.session_id === "string" || value.session_id === null)
    && (typeof value.task_id === "string" || value.task_id === null)
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string"
    && typeof value.entry_count === "number";
}

function isContextManifestEntryRow(value: unknown): value is ContextManifestEntryRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.entry_id === "string"
    && typeof value.manifest_id === "string"
    && typeof value.kind === "string"
    && typeof value.entry_index === "number"
    && (typeof value.title === "string" || value.title === null)
    && (typeof value.source_ref === "string" || value.source_ref === null)
    && (typeof value.content_text === "string" || value.content_text === null)
    && typeof value.content_hash === "string"
    && typeof value.metadata_json === "string"
    && typeof value.created_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


