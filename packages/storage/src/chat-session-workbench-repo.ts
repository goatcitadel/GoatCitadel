import type { DatabaseClient } from "./db.js";
import {
  ValidationError,
  type ChatSessionWorkbenchPackageManager,
  type ChatSessionWorkbenchRecord,
  type ChatSessionWorkbenchValidationStatus,
  type ChatSessionWorkbenchWorktreeStatus,
} from "@goatcitadel/contracts";

interface ChatSessionWorkbenchRow {
  session_id: string;
  project_id: string | null;
  base_ref: string | null;
  worktree_path: string | null;
  worktree_status: string;
  active_file_path: string | null;
  diff_artifact_id: string | null;
  output_artifact_id: string | null;
  validation_status: string;
  package_manager: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionWorkbenchPatchInput {
  projectId?: string;
  baseRef?: string;
  worktreePath?: string;
  worktreeStatus?: ChatSessionWorkbenchWorktreeStatus;
  activeFilePath?: string;
  diffArtifactId?: string;
  outputArtifactId?: string;
  validationStatus?: ChatSessionWorkbenchValidationStatus;
  packageManager?: ChatSessionWorkbenchPackageManager | null;
}

export class ChatSessionWorkbenchRepository {
  private readonly getStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_session_workbench WHERE session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_workbench (
        session_id, project_id, base_ref, worktree_path, worktree_status, active_file_path, diff_artifact_id,
        output_artifact_id, validation_status, package_manager, created_at, updated_at
      ) VALUES (
        @sessionId, @projectId, @baseRef, @worktreePath, @worktreeStatus, @activeFilePath, @diffArtifactId,
        @outputArtifactId, @validationStatus, @packageManager, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        project_id = excluded.project_id,
        base_ref = excluded.base_ref,
        worktree_path = excluded.worktree_path,
        worktree_status = excluded.worktree_status,
        active_file_path = excluded.active_file_path,
        diff_artifact_id = excluded.diff_artifact_id,
        output_artifact_id = excluded.output_artifact_id,
        validation_status = excluded.validation_status,
        package_manager = excluded.package_manager,
        updated_at = excluded.updated_at
    `);
  }

  public get(sessionId: string): ChatSessionWorkbenchRecord | undefined {
    const row = toChatSessionWorkbenchRow(this.getStmt.get(sessionId));
    return row ? mapRow(row) : undefined;
  }

  public ensure(sessionId: string, now = new Date().toISOString()): ChatSessionWorkbenchRecord {
    const existing = this.get(sessionId);
    if (existing) {
      return existing;
    }
    this.upsertStmt.run({
      sessionId,
      projectId: null,
      baseRef: null,
      worktreePath: null,
      worktreeStatus: "uninitialized",
      activeFilePath: null,
      diffArtifactId: null,
      outputArtifactId: null,
      validationStatus: "idle",
      packageManager: null,
      createdAt: now,
      updatedAt: now,
    });
    const row = toChatSessionWorkbenchRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new TypeError("chat_session_workbench ensure did not return a row");
    }
    return mapRow(row);
  }

  public patch(
    sessionId: string,
    input: ChatSessionWorkbenchPatchInput,
    now = new Date().toISOString(),
  ): ChatSessionWorkbenchRecord {
    const current = this.ensure(sessionId, now);
    this.upsertStmt.run({
      sessionId,
      projectId: input.projectId !== undefined ? sanitizeOptional(input.projectId) : (current.projectId ?? null),
      baseRef: input.baseRef !== undefined ? sanitizeOptional(input.baseRef) : (current.baseRef ?? null),
      worktreePath:
        input.worktreePath !== undefined ? sanitizeOptional(input.worktreePath) : (current.worktreePath ?? null),
      worktreeStatus: input.worktreeStatus ?? current.worktreeStatus,
      activeFilePath:
        input.activeFilePath !== undefined ? sanitizeOptional(input.activeFilePath) : (current.activeFilePath ?? null),
      diffArtifactId:
        input.diffArtifactId !== undefined ? sanitizeOptional(input.diffArtifactId) : (current.diffArtifactId ?? null),
      outputArtifactId:
        input.outputArtifactId !== undefined
          ? sanitizeOptional(input.outputArtifactId)
          : (current.outputArtifactId ?? null),
      validationStatus: input.validationStatus ?? current.validationStatus,
      packageManager: input.packageManager !== undefined ? input.packageManager : (current.packageManager ?? null),
      createdAt: current.createdAt,
      updatedAt: now,
    });
    const row = toChatSessionWorkbenchRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new TypeError("chat_session_workbench patch did not return a row");
    }
    return mapRow(row);
  }
}

function mapRow(row: ChatSessionWorkbenchRow): ChatSessionWorkbenchRecord {
  return {
    sessionId: row.session_id,
    projectId: row.project_id ?? undefined,
    baseRef: row.base_ref ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    worktreeStatus: normalizeWorktreeStatus(row.worktree_status),
    activeFilePath: row.active_file_path ?? undefined,
    diffArtifactId: row.diff_artifact_id ?? undefined,
    outputArtifactId: row.output_artifact_id ?? undefined,
    validationStatus: normalizeValidationStatus(row.validation_status),
    packageManager: normalizePackageManager(row.package_manager),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeWorktreeStatus(value: string): ChatSessionWorkbenchWorktreeStatus {
  switch (value) {
    case "ready":
    case "missing":
    case "blocked":
    case "uninitialized":
      return value;
    default:
      return "uninitialized";
  }
}

function normalizeValidationStatus(value: string): ChatSessionWorkbenchValidationStatus {
  switch (value) {
    case "pending":
    case "passed":
    case "failed":
    case "idle":
      return value;
    default:
      return "idle";
  }
}

function normalizePackageManager(value: string | null): ChatSessionWorkbenchPackageManager | undefined {
  switch (value) {
    case "pnpm":
    case "npm":
    case "yarn":
    case "bun":
      return value;
    default:
      return undefined;
  }
}

function sanitizeOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function toChatSessionWorkbenchRow(value: unknown): ChatSessionWorkbenchRow | undefined {
  return isChatSessionWorkbenchRow(value) ? value : undefined;
}

function isChatSessionWorkbenchRow(value: unknown): value is ChatSessionWorkbenchRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.session_id === "string" &&
    (typeof value.project_id === "string" || value.project_id === null) &&
    (typeof value.base_ref === "string" || value.base_ref === null) &&
    (typeof value.worktree_path === "string" || value.worktree_path === null) &&
    typeof value.worktree_status === "string" &&
    (typeof value.active_file_path === "string" || value.active_file_path === null) &&
    (typeof value.diff_artifact_id === "string" || value.diff_artifact_id === null) &&
    (typeof value.output_artifact_id === "string" || value.output_artifact_id === null) &&
    typeof value.validation_status === "string" &&
    (typeof value.package_manager === "string" || value.package_manager === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sanitizeWorkbenchRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..") ||
    normalized.includes("/../")
  ) {
    throw new ValidationError({ message: `Invalid workbench path: ${value}` });
  }
  return normalized;
}
