import type { DatabaseClient } from "./db.js";
import type {
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactRecord,
  ChatGeneratedArtifactSourceSurface,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface ChatGeneratedArtifactRow {
  artifact_id: string;
  session_id: string;
  workspace_id: string | null;
  turn_id: string;
  title: string;
  kind: ChatGeneratedArtifactKind;
  content: string;
  language: string | null;
  source_surface: ChatGeneratedArtifactSourceSurface;
  version: number;
  supersedes_artifact_id: string | null;
  provider_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export class ChatGeneratedArtifactRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listBySessionStmt;
  private readonly listByTurnStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO chat_generated_artifacts (
        artifact_id,
        session_id,
        workspace_id,
        turn_id,
        title,
        kind,
        content,
        language,
        source_surface,
        version,
        supersedes_artifact_id,
        provider_id,
        model,
        created_at,
        updated_at
      ) VALUES (
        @artifactId,
        @sessionId,
        @workspaceId,
        @turnId,
        @title,
        @kind,
        @content,
        @language,
        @sourceSurface,
        @version,
        @supersedesArtifactId,
        @providerId,
        @model,
        @createdAt,
        @updatedAt
      )
    `);
    this.getStmt = db.prepare(`
      SELECT *
      FROM chat_generated_artifacts
      WHERE artifact_id = ?
      LIMIT 1
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT *
      FROM chat_generated_artifacts
      WHERE session_id = @sessionId
      ORDER BY created_at DESC, version DESC, artifact_id DESC
      LIMIT @limit
    `);
    this.listByTurnStmt = db.prepare(`
      SELECT *
      FROM chat_generated_artifacts
      WHERE turn_id = @turnId
      ORDER BY version DESC, created_at DESC, artifact_id DESC
      LIMIT @limit
    `);
  }

  public create(input: ChatGeneratedArtifactRecord): ChatGeneratedArtifactRecord {
    this.insertStmt.run({
      artifactId: sanitizeRequired(input.artifactId, "artifactId"),
      sessionId: sanitizeRequired(input.sessionId, "sessionId"),
      workspaceId: sanitizeOptional(input.workspaceId),
      turnId: sanitizeRequired(input.turnId, "turnId"),
      title: sanitizeRequired(input.title, "title"),
      kind: input.kind,
      content: input.content,
      language: sanitizeOptional(input.language),
      sourceSurface: input.sourceSurface,
      version: Math.max(1, Math.floor(input.version)),
      supersedesArtifactId: sanitizeOptional(input.supersedesArtifactId),
      providerId: sanitizeOptional(input.providerId),
      model: sanitizeOptional(input.model),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return this.get(input.artifactId);
  }

  public get(artifactId: string): ChatGeneratedArtifactRecord {
    const row = toChatGeneratedArtifactRow(this.getStmt.get(artifactId));
    if (!row) {
      throw new NotFoundError({ entity: "Generated artifact", id: artifactId });
    }
    return mapRow(row);
  }

  public listBySession(sessionId: string, limit = 200): ChatGeneratedArtifactRecord[] {
    const rows = toChatGeneratedArtifactRows(
      this.listBySessionStmt.all({
        sessionId: sanitizeRequired(sessionId, "sessionId"),
        limit: clampLimit(limit),
      }),
    );
    return rows.map(mapRow);
  }

  public listByTurn(turnId: string, limit = 100): ChatGeneratedArtifactRecord[] {
    const rows = toChatGeneratedArtifactRows(
      this.listByTurnStmt.all({
        turnId: sanitizeRequired(turnId, "turnId"),
        limit: clampLimit(limit),
      }),
    );
    return rows.map(mapRow);
  }

  public listBySessionIds(sessionIds: string[]): Map<string, ChatGeneratedArtifactRecord[]> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = toChatGeneratedArtifactRows(
      this.db
        .prepare(
          `
        SELECT *
        FROM chat_generated_artifacts
        WHERE session_id IN (${placeholders})
        ORDER BY created_at DESC, version DESC, artifact_id DESC
      `,
        )
        .all(...sessionIds),
    );
    const bySession = new Map<string, ChatGeneratedArtifactRecord[]>();
    for (const row of rows.map(mapRow)) {
      const items = bySession.get(row.sessionId) ?? [];
      items.push(row);
      bySession.set(row.sessionId, items);
    }
    return bySession;
  }

  public listByTurnIds(turnIds: string[]): Map<string, ChatGeneratedArtifactRecord[]> {
    if (turnIds.length === 0) {
      return new Map();
    }
    const placeholders = turnIds.map(() => "?").join(", ");
    const rows = toChatGeneratedArtifactRows(
      this.db
        .prepare(
          `
        SELECT *
        FROM chat_generated_artifacts
        WHERE turn_id IN (${placeholders})
        ORDER BY version DESC, created_at DESC, artifact_id DESC
      `,
        )
        .all(...turnIds),
    );
    const byTurn = new Map<string, ChatGeneratedArtifactRecord[]>();
    for (const row of rows.map(mapRow)) {
      const items = byTurn.get(row.turnId) ?? [];
      items.push(row);
      byTurn.set(row.turnId, items);
    }
    return byTurn;
  }

  public listVisible(
    input: {
      workspaceId?: string;
      sourceSurface?: ChatGeneratedArtifactSourceSurface;
      kind?: ChatGeneratedArtifactKind;
      limit?: number;
    } = {},
  ): ChatGeneratedArtifactRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.workspaceId?.trim()) {
      clauses.push("workspace_id = ?");
      params.push(input.workspaceId.trim());
    }
    if (input.sourceSurface) {
      clauses.push("source_surface = ?");
      params.push(input.sourceSurface);
    }
    if (input.kind) {
      clauses.push("kind = ?");
      params.push(input.kind);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = toChatGeneratedArtifactRows(
      this.db
        .prepare(
          `
        SELECT *
        FROM chat_generated_artifacts
        ${whereClause}
        ORDER BY created_at DESC, version DESC, artifact_id DESC
        LIMIT ?
      `,
        )
        .all(...params, clampLimit(input.limit ?? 500)),
    );
    return rows.map(mapRow);
  }
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(5_000, Math.floor(value)));
}

function sanitizeRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function sanitizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatGeneratedArtifactRow(value: unknown): value is ChatGeneratedArtifactRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.artifact_id === "string" &&
    typeof value.session_id === "string" &&
    (typeof value.workspace_id === "string" || value.workspace_id === null) &&
    typeof value.turn_id === "string" &&
    typeof value.title === "string" &&
    typeof value.kind === "string" &&
    typeof value.content === "string" &&
    (typeof value.language === "string" || value.language === null) &&
    typeof value.source_surface === "string" &&
    typeof value.version === "number" &&
    (typeof value.supersedes_artifact_id === "string" || value.supersedes_artifact_id === null) &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function toChatGeneratedArtifactRow(value: unknown): ChatGeneratedArtifactRow | undefined {
  return isChatGeneratedArtifactRow(value) ? value : undefined;
}

function toChatGeneratedArtifactRows(value: unknown): ChatGeneratedArtifactRow[] {
  return Array.isArray(value) ? value.filter(isChatGeneratedArtifactRow) : [];
}

function mapRow(row: ChatGeneratedArtifactRow): ChatGeneratedArtifactRecord {
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id ?? undefined,
    turnId: row.turn_id,
    title: row.title,
    kind: row.kind,
    content: row.content,
    language: row.language ?? undefined,
    sourceSurface: row.source_surface,
    version: row.version,
    supersedesArtifactId: row.supersedes_artifact_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
