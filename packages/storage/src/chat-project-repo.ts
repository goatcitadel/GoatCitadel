import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface ChatProjectRow {
  project_id: string;
  revision: number | null | undefined;
  workspace_id: string;
  name: string;
  description: string | null;
  workspace_path: string;
  color: string | null;
  lifecycle_status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatProjectCreateInput {
  workspaceId?: string;
  name: string;
  description?: string;
  workspacePath: string;
  color?: string;
}

export interface ChatProjectUpdateInput {
  workspaceId?: string;
  name?: string;
  description?: string;
  workspacePath?: string;
  color?: string;
}

export class ChatProjectRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly archiveStmt;
  private readonly restoreStmt;
  private readonly deleteStmt;
  private readonly assertRevisionStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_projects WHERE project_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_projects (
        project_id, workspace_id, name, description, workspace_path, color,
        lifecycle_status, archived_at, created_at, updated_at
      ) VALUES (
        @projectId, @workspaceId, @name, @description, @workspacePath, @color,
        'active', NULL, @createdAt, @updatedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE chat_projects
      SET
        workspace_id = @workspaceId,
        name = @name,
        description = @description,
        workspace_path = @workspacePath,
        color = @color,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE project_id = @projectId
        AND revision = @expectedRevision
    `);
    this.archiveStmt = db.prepare(`
      UPDATE chat_projects
      SET lifecycle_status = 'archived', archived_at = @archivedAt,
          revision = revision + 1, updated_at = @updatedAt
      WHERE project_id = @projectId
        AND revision = @expectedRevision
    `);
    this.restoreStmt = db.prepare(`
      UPDATE chat_projects
      SET lifecycle_status = 'active', archived_at = NULL,
          revision = revision + 1, updated_at = @updatedAt
      WHERE project_id = @projectId
        AND revision = @expectedRevision
    `);
    this.deleteStmt = db.prepare(`
      DELETE FROM chat_projects
      WHERE project_id = @projectId
        AND revision = @expectedRevision
    `);
    this.assertRevisionStmt = db.prepare(`
      UPDATE chat_projects
      SET revision = revision
      WHERE project_id = @projectId
        AND revision = @expectedRevision
    `);
  }

  public list(view: "active" | "archived" | "all" = "active", limit = 300, workspaceId?: string): ChatProjectRecord[] {
    const params: Record<string, unknown> = {
      view,
      limit: Math.max(1, Math.min(2000, Math.floor(limit))),
    };
    const clauses = [
      `(
        @view = 'all'
        OR (@view = 'active' AND lifecycle_status = 'active')
        OR (@view = 'archived' AND lifecycle_status = 'archived')
      )`,
    ];
    if (workspaceId) {
      params.workspaceId = sanitizeWorkspaceId(workspaceId);
      clauses.push("workspace_id = @workspaceId");
    }
    const sql = `
      SELECT * FROM chat_projects
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY updated_at DESC, project_id ASC
      LIMIT @limit
    `;
    const rows = toChatProjectRows(this.db.prepare(sql).all(params));
    return rows.map(mapRow);
  }

  public get(projectId: string): ChatProjectRecord {
    const row = toChatProjectRow(this.getStmt.get(projectId));
    if (!row) {
      throw new NotFoundError({ entity: "Chat project", id: projectId });
    }
    return mapRow(row);
  }

  public find(projectId: string): ChatProjectRecord | undefined {
    const row = toChatProjectRow(this.getStmt.get(projectId));
    return row ? mapRow(row) : undefined;
  }

  public create(input: ChatProjectCreateInput, now = new Date().toISOString()): ChatProjectRecord {
    const projectId = randomUUID();
    this.insertStmt.run({
      projectId,
      workspaceId: sanitizeWorkspaceId(input.workspaceId ?? "default"),
      name: sanitizeRequired(input.name, "name"),
      description: sanitizeOptional(input.description),
      workspacePath: sanitizeWorkspacePath(input.workspacePath),
      color: sanitizeOptional(input.color),
      createdAt: now,
      updatedAt: now,
    });
    return this.get(projectId);
  }

  public update(projectId: string, input: ChatProjectUpdateInput, now = new Date().toISOString()): ChatProjectRecord {
    const current = this.get(projectId);
    return this.updateWithRevision(projectId, input, current.revision, now);
  }

  public updateWithRevision(
    projectId: string,
    input: ChatProjectUpdateInput,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): ChatProjectRecord {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.get(projectId);
      assertExpectedRevision("chat_project", projectId, expectedRevision, current.revision);
      const next = {
        workspaceId:
          input.workspaceId !== undefined
            ? sanitizeWorkspaceId(input.workspaceId)
            : sanitizeWorkspaceId(current.workspaceId ?? "default"),
        name: input.name !== undefined ? sanitizeRequired(input.name, "name") : current.name,
        description:
          input.description !== undefined ? sanitizeOptional(input.description) : (current.description ?? null),
        workspacePath:
          input.workspacePath !== undefined ? sanitizeWorkspacePath(input.workspacePath) : current.workspacePath,
        color: input.color !== undefined ? sanitizeOptional(input.color) : (current.color ?? null),
      };
      if (
        next.workspaceId === (current.workspaceId ?? "default") &&
        next.name === current.name &&
        next.description === (current.description ?? null) &&
        next.workspacePath === current.workspacePath &&
        next.color === (current.color ?? null)
      ) {
        return this.assertNoopRevision(projectId, expectedRevision);
      }
      const result = this.updateStmt.run({
        projectId,
        expectedRevision,
        ...next,
        updatedAt: now,
      });
      if (result.changes === 0) {
        this.throwCasMiss(projectId, expectedRevision);
      }
      return this.get(projectId);
    });
  }

  public archive(projectId: string, now = new Date().toISOString()): ChatProjectRecord {
    const current = this.get(projectId);
    return this.archiveWithRevision(projectId, current.revision, now);
  }

  public archiveWithRevision(
    projectId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): ChatProjectRecord {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.get(projectId);
      assertExpectedRevision("chat_project", projectId, expectedRevision, current.revision);
      if (current.lifecycleStatus === "archived") {
        return this.assertNoopRevision(projectId, expectedRevision);
      }
      const result = this.archiveStmt.run({
        projectId,
        expectedRevision,
        archivedAt: now,
        updatedAt: now,
      });
      if (result.changes === 0) {
        this.throwCasMiss(projectId, expectedRevision);
      }
      return this.get(projectId);
    });
  }

  public restore(projectId: string, now = new Date().toISOString()): ChatProjectRecord {
    const current = this.get(projectId);
    return this.restoreWithRevision(projectId, current.revision, now);
  }

  public restoreWithRevision(
    projectId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): ChatProjectRecord {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.get(projectId);
      assertExpectedRevision("chat_project", projectId, expectedRevision, current.revision);
      if (current.lifecycleStatus === "active") {
        return this.assertNoopRevision(projectId, expectedRevision);
      }
      const result = this.restoreStmt.run({
        projectId,
        expectedRevision,
        updatedAt: now,
      });
      if (result.changes === 0) {
        this.throwCasMiss(projectId, expectedRevision);
      }
      return this.get(projectId);
    });
  }

  public hardDelete(projectId: string): boolean {
    const existing = this.find(projectId);
    if (!existing) {
      return false;
    }
    return this.hardDeleteWithRevision(projectId, existing.revision);
  }

  public hardDeleteWithRevision(projectId: string, expectedRevision: number): boolean {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.get(projectId);
      assertExpectedRevision("chat_project", projectId, expectedRevision, current.revision);
      const result = this.deleteStmt.run({ projectId, expectedRevision });
      if (result.changes === 0) {
        this.throwCasMiss(projectId, expectedRevision);
      }
      return true;
    });
  }

  private assertNoopRevision(projectId: string, expectedRevision: number): ChatProjectRecord {
    const result = this.assertRevisionStmt.run({ projectId, expectedRevision });
    if (result.changes === 0) {
      this.throwCasMiss(projectId, expectedRevision);
    }
    return this.get(projectId);
  }

  private throwCasMiss(projectId: string, expectedRevision: number): never {
    const current = this.find(projectId);
    if (!current) {
      throw new NotFoundError({ entity: "Chat project", id: projectId });
    }
    throwRevisionConflict("chat_project", projectId, expectedRevision, current.revision);
  }
}

function mapRow(row: ChatProjectRow): ChatProjectRecord {
  return {
    projectId: row.project_id,
    revision: normalizeRevision(row.revision),
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description ?? undefined,
    workspacePath: row.workspace_path,
    color: row.color ?? undefined,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function sanitizeOptional(value?: string): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizeWorkspacePath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "workspacePath" });
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("../") || trimmed === ".." || trimmed.includes("/../")) {
    throw new ValidationError({ message: "workspacePath must be relative and jailed" });
  }
  return trimmed;
}

function sanitizeWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "workspaceId" });
  }
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(trimmed)) {
    throw new ValidationError({ message: "workspaceId contains unsupported characters" });
  }
  return trimmed;
}

function toChatProjectRow(value: unknown): ChatProjectRow | undefined {
  return isChatProjectRow(value) ? value : undefined;
}

function toChatProjectRows(value: unknown): ChatProjectRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isChatProjectRow);
}

function isChatProjectRow(value: unknown): value is ChatProjectRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.project_id === "string" &&
    (typeof value.revision === "number" || value.revision === null || value.revision === undefined) &&
    typeof value.workspace_id === "string" &&
    typeof value.name === "string" &&
    (typeof value.description === "string" || value.description === null) &&
    typeof value.workspace_path === "string" &&
    (typeof value.color === "string" || value.color === null) &&
    typeof value.lifecycle_status === "string" &&
    (typeof value.archived_at === "string" || value.archived_at === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({ field: "expectedRevision" });
  }
}

function normalizeRevision(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

function assertExpectedRevision(
  resourceKind: string,
  resourceId: string,
  expectedRevision: number,
  currentRevision: number,
): void {
  if (expectedRevision !== currentRevision) {
    throwRevisionConflict(resourceKind, resourceId, expectedRevision, currentRevision);
  }
}

function throwRevisionConflict(
  resourceKind: string,
  resourceId: string,
  expectedRevision: number,
  currentRevision: number,
): never {
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: `${resourceKind} ${resourceId} changed since revision ${expectedRevision}`,
    details: { resourceKind, resourceId, expectedRevision, currentRevision },
  });
}
