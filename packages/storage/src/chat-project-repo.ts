import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface ChatProjectRow {
  project_id: string;
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
  private readonly listStmt;
  private readonly getStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly archiveStmt;
  private readonly restoreStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.listStmt = db.prepare(`
      SELECT * FROM chat_projects
      WHERE (
        @view = 'all'
        OR (@view = 'active' AND lifecycle_status = 'active')
        OR (@view = 'archived' AND lifecycle_status = 'archived')
      )
      AND (@workspaceId IS NULL OR workspace_id = @workspaceId)
      ORDER BY updated_at DESC, project_id ASC
      LIMIT @limit
    `);
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
        updated_at = @updatedAt
      WHERE project_id = @projectId
    `);
    this.archiveStmt = db.prepare(`
      UPDATE chat_projects
      SET lifecycle_status = 'archived', archived_at = @archivedAt, updated_at = @updatedAt
      WHERE project_id = @projectId
    `);
    this.restoreStmt = db.prepare(`
      UPDATE chat_projects
      SET lifecycle_status = 'active', archived_at = NULL, updated_at = @updatedAt
      WHERE project_id = @projectId
    `);
    this.deleteStmt = db.prepare("DELETE FROM chat_projects WHERE project_id = ?");
  }

  public list(view: "active" | "archived" | "all" = "active", limit = 300, workspaceId?: string): ChatProjectRecord[] {
    const rows = this.listStmt.all({
      view,
      workspaceId: workspaceId ? sanitizeWorkspaceId(workspaceId) : null,
      limit: Math.max(1, Math.min(2000, Math.floor(limit))),
    }) as unknown as ChatProjectRow[];
    return rows.map(mapRow);
  }

  public get(projectId: string): ChatProjectRecord {
    const row = this.getStmt.get(projectId) as ChatProjectRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Chat project", id: projectId });
    }
    return mapRow(row);
  }

  public find(projectId: string): ChatProjectRecord | undefined {
    const row = this.getStmt.get(projectId) as ChatProjectRow | undefined;
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
    this.updateStmt.run({
      projectId,
      workspaceId: input.workspaceId !== undefined ? sanitizeWorkspaceId(input.workspaceId) : sanitizeWorkspaceId(current.workspaceId ?? "default"),
      name: input.name !== undefined ? sanitizeRequired(input.name, "name") : current.name,
      description: input.description !== undefined ? sanitizeOptional(input.description) : current.description ?? null,
      workspacePath: input.workspacePath !== undefined ? sanitizeWorkspacePath(input.workspacePath) : current.workspacePath,
      color: input.color !== undefined ? sanitizeOptional(input.color) : current.color ?? null,
      updatedAt: now,
    });
    return this.get(projectId);
  }

  public archive(projectId: string, now = new Date().toISOString()): ChatProjectRecord {
    const current = this.get(projectId);
    if (current.lifecycleStatus === "archived") {
      return current;
    }
    this.archiveStmt.run({
      projectId,
      archivedAt: now,
      updatedAt: now,
    });
    return this.get(projectId);
  }

  public restore(projectId: string, now = new Date().toISOString()): ChatProjectRecord {
    const current = this.get(projectId);
    if (current.lifecycleStatus === "active") {
      return current;
    }
    this.restoreStmt.run({
      projectId,
      updatedAt: now,
    });
    return this.get(projectId);
  }

  public hardDelete(projectId: string): boolean {
    const existing = this.find(projectId);
    if (!existing) {
      return false;
    }
    this.deleteStmt.run(projectId);
    return true;
  }
}

function mapRow(row: ChatProjectRow): ChatProjectRecord {
  return {
    projectId: row.project_id,
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
  if (
    trimmed.startsWith("/")
    || trimmed.startsWith("../")
    || trimmed === ".."
    || trimmed.includes("/../")
  ) {
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
