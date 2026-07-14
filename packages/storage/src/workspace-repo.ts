import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  WorkspaceCreateInput,
  WorkspacePrefs,
  WorkspaceRecord,
  WorkspaceUpdateInput,
} from "@goatcitadel/contracts";
import { ConflictError, DEFAULT_CITADEL_ID, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface WorkspaceRow {
  workspace_id: string;
  revision: number | null | undefined;
  citadel_id: string | null;
  name: string;
  description: string | null;
  slug: string;
  lifecycle_status: "active" | "archived";
  archived_at: string | null;
  workspace_prefs_json: string | null;
  created_at: string;
  updated_at: string;
}

export class WorkspaceRepository {
  private readonly listStmt;
  private readonly listByCitadelStmt;
  private readonly getStmt;
  private readonly getBySlugStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly archiveStmt;
  private readonly restoreStmt;
  private readonly assertRevisionStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.listStmt = db.prepare(`
      SELECT * FROM workspaces
      WHERE (
        @view = 'all'
        OR (@view = 'active' AND lifecycle_status = 'active')
        OR (@view = 'archived' AND lifecycle_status = 'archived')
      )
      ORDER BY updated_at DESC, workspace_id ASC
      LIMIT @limit
    `);
    this.listByCitadelStmt = db.prepare(`
      SELECT * FROM workspaces
      WHERE citadel_id = @citadelId
        AND (
          @view = 'all'
          OR (@view = 'active' AND lifecycle_status = 'active')
          OR (@view = 'archived' AND lifecycle_status = 'archived')
        )
      ORDER BY updated_at DESC, workspace_id ASC
      LIMIT @limit
    `);
    this.getStmt = db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?");
    this.getBySlugStmt = db.prepare("SELECT * FROM workspaces WHERE slug = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO workspaces (
        workspace_id, citadel_id, name, description, slug, lifecycle_status, archived_at,
        workspace_prefs_json, created_at, updated_at
      ) VALUES (
        @workspaceId, @citadelId, @name, @description, @slug, 'active', NULL,
        @workspacePrefsJson, @createdAt, @updatedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE workspaces
      SET
        name = @name,
        citadel_id = @citadelId,
        description = @description,
        slug = @slug,
        workspace_prefs_json = @workspacePrefsJson,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE workspace_id = @workspaceId
        AND revision = @expectedRevision
    `);
    this.archiveStmt = db.prepare(`
      UPDATE workspaces
      SET
        lifecycle_status = 'archived',
        archived_at = @archivedAt,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE workspace_id = @workspaceId
        AND revision = @expectedRevision
    `);
    this.restoreStmt = db.prepare(`
      UPDATE workspaces
      SET
        lifecycle_status = 'active',
        archived_at = NULL,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE workspace_id = @workspaceId
        AND revision = @expectedRevision
    `);
    this.assertRevisionStmt = db.prepare(`
      UPDATE workspaces
      SET revision = revision
      WHERE workspace_id = @workspaceId
        AND revision = @expectedRevision
    `);
  }

  public list(view: "active" | "archived" | "all" = "active", limit = 200): WorkspaceRecord[] {
    const rows = toWorkspaceRows(
      this.listStmt.all({
        view,
        limit: Math.max(1, Math.min(2000, Math.floor(limit))),
      }),
    );
    return rows.map(mapRow);
  }

  public listByCitadel(
    citadelId: string,
    view: "active" | "archived" | "all" = "active",
    limit = 200,
  ): WorkspaceRecord[] {
    const rows = toWorkspaceRows(
      this.listByCitadelStmt.all({
        citadelId: normalizeCitadelId(citadelId),
        view,
        limit: Math.max(1, Math.min(2000, Math.floor(limit))),
      }),
    );
    return rows.map(mapRow);
  }

  public get(workspaceId: string): WorkspaceRecord {
    const row = toWorkspaceRow(this.getStmt.get(workspaceId));
    if (!row) {
      throw new NotFoundError({ entity: "Workspace", id: workspaceId });
    }
    return mapRow(row);
  }

  public find(workspaceId: string): WorkspaceRecord | undefined {
    const row = toWorkspaceRow(this.getStmt.get(workspaceId));
    return row ? mapRow(row) : undefined;
  }

  public findBySlug(slug: string): WorkspaceRecord | undefined {
    const row = toWorkspaceRow(this.getBySlugStmt.get(normalizeSlug(slug)));
    return row ? mapRow(row) : undefined;
  }

  public create(input: WorkspaceCreateInput, now = new Date().toISOString()): WorkspaceRecord {
    const workspaceId = `ws_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const name = sanitizeRequired(input.name, "name");
    const slug = normalizeSlug(input.slug ?? input.name);
    this.assertSlugAvailable(slug);
    this.insertStmt.run({
      workspaceId,
      citadelId: normalizeCitadelId(input.citadelId),
      name,
      description: sanitizeOptional(input.description),
      slug,
      workspacePrefsJson: serializeWorkspacePrefs(input.workspacePrefs),
      createdAt: now,
      updatedAt: now,
    });
    return this.get(workspaceId);
  }

  public update(workspaceId: string, input: WorkspaceUpdateInput, now = new Date().toISOString()): WorkspaceRecord {
    const current = this.get(workspaceId);
    return this.updateWithRevision(workspaceId, input, current.revision, now);
  }

  public updateWithRevision(
    workspaceId: string,
    input: WorkspaceUpdateInput,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): WorkspaceRecord {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.get(workspaceId);
      assertExpectedRevision("workspace", workspaceId, expectedRevision, current.revision);
      const nextName = input.name !== undefined ? sanitizeRequired(input.name, "name") : current.name;
      const nextSlug =
        input.slug !== undefined
          ? normalizeSlug(input.slug)
          : input.name !== undefined
            ? normalizeSlug(input.name)
            : current.slug;
      const nextCitadelId =
        input.citadelId !== undefined ? normalizeCitadelId(input.citadelId) : normalizeCitadelId(current.citadelId);
      const nextDescription =
        input.description !== undefined ? sanitizeOptional(input.description) : (current.description ?? null);
      const nextWorkspacePrefsJson =
        input.workspacePrefs !== undefined
          ? serializeWorkspacePrefs(input.workspacePrefs)
          : serializeWorkspacePrefs(current.workspacePrefs);

      if (
        nextName === current.name &&
        nextSlug === current.slug &&
        nextCitadelId === normalizeCitadelId(current.citadelId) &&
        nextDescription === (current.description ?? null) &&
        nextWorkspacePrefsJson === serializeWorkspacePrefs(current.workspacePrefs)
      ) {
        return this.assertNoopRevision(workspaceId, expectedRevision);
      }

      this.assertSlugAvailable(nextSlug, workspaceId);
      const result = this.updateStmt.run({
        workspaceId,
        expectedRevision,
        citadelId: nextCitadelId,
        name: nextName,
        description: nextDescription,
        slug: nextSlug,
        workspacePrefsJson: nextWorkspacePrefsJson,
        updatedAt: now,
      });
      if (result.changes === 0) {
        this.throwCasMiss(workspaceId, expectedRevision);
      }
      return this.get(workspaceId);
    });
  }

  public archive(workspaceId: string, now = new Date().toISOString()): WorkspaceRecord {
    const current = this.get(workspaceId);
    return this.archiveWithRevision(workspaceId, current.revision, now);
  }

  public archiveWithRevision(
    workspaceId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): WorkspaceRecord {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.get(workspaceId);
      assertExpectedRevision("workspace", workspaceId, expectedRevision, current.revision);
      if (current.workspaceId === "default") {
        throw new ConflictError({ code: "STATE_CONFLICT", message: "default workspace cannot be archived" });
      }
      if (current.lifecycleStatus === "archived") {
        return this.assertNoopRevision(workspaceId, expectedRevision);
      }
      const result = this.archiveStmt.run({
        workspaceId,
        expectedRevision,
        archivedAt: now,
        updatedAt: now,
      });
      if (result.changes === 0) {
        this.throwCasMiss(workspaceId, expectedRevision);
      }
      return this.get(workspaceId);
    });
  }

  public restore(workspaceId: string, now = new Date().toISOString()): WorkspaceRecord {
    const current = this.get(workspaceId);
    return this.restoreWithRevision(workspaceId, current.revision, now);
  }

  public restoreWithRevision(
    workspaceId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): WorkspaceRecord {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.get(workspaceId);
      assertExpectedRevision("workspace", workspaceId, expectedRevision, current.revision);
      if (current.lifecycleStatus === "active") {
        return this.assertNoopRevision(workspaceId, expectedRevision);
      }
      const result = this.restoreStmt.run({
        workspaceId,
        expectedRevision,
        updatedAt: now,
      });
      if (result.changes === 0) {
        this.throwCasMiss(workspaceId, expectedRevision);
      }
      return this.get(workspaceId);
    });
  }

  private assertNoopRevision(workspaceId: string, expectedRevision: number): WorkspaceRecord {
    const result = this.assertRevisionStmt.run({ workspaceId, expectedRevision });
    if (result.changes === 0) {
      this.throwCasMiss(workspaceId, expectedRevision);
    }
    return this.get(workspaceId);
  }

  private throwCasMiss(workspaceId: string, expectedRevision: number): never {
    const current = this.find(workspaceId);
    if (!current) {
      throw new NotFoundError({ entity: "Workspace", id: workspaceId });
    }
    throwRevisionConflict("workspace", workspaceId, expectedRevision, current.revision);
  }

  private assertSlugAvailable(slug: string, excludingWorkspaceId?: string): void {
    const existing = this.findBySlug(slug);
    if (existing && existing.workspaceId !== excludingWorkspaceId) {
      throw new ConflictError({ code: "ALREADY_EXISTS", message: `Workspace slug "${slug}" is already in use` });
    }
  }
}

function mapRow(row: WorkspaceRow): WorkspaceRecord {
  const prefs = safeJsonParse<WorkspacePrefs | undefined>(row.workspace_prefs_json ?? "{}", {});
  return {
    workspaceId: row.workspace_id,
    revision: normalizeRevision(row.revision),
    citadelId: normalizeCitadelId(row.citadel_id ?? undefined),
    name: row.name,
    description: row.description ?? undefined,
    slug: row.slug,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
    workspacePrefs: prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : undefined,
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

function normalizeSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "slug" });
  }
  if (normalized.length > 64) {
    return normalized.slice(0, 64).replace(/-+$/g, "");
  }
  return normalized;
}

function serializeWorkspacePrefs(value: WorkspacePrefs | undefined): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "{}";
  }
  return JSON.stringify(value);
}

function normalizeCitadelId(value?: string): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_CITADEL_ID;
}

function toWorkspaceRow(value: unknown): WorkspaceRow | undefined {
  return isWorkspaceRow(value) ? value : undefined;
}

function toWorkspaceRows(value: unknown): WorkspaceRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isWorkspaceRow);
}

function isWorkspaceRow(value: unknown): value is WorkspaceRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.workspace_id === "string" &&
    (typeof value.revision === "number" || value.revision === null || value.revision === undefined) &&
    (typeof value.citadel_id === "string" || value.citadel_id === null || value.citadel_id === undefined) &&
    typeof value.name === "string" &&
    (typeof value.description === "string" || value.description === null) &&
    typeof value.slug === "string" &&
    typeof value.lifecycle_status === "string" &&
    (typeof value.archived_at === "string" || value.archived_at === null) &&
    (typeof value.workspace_prefs_json === "string" || value.workspace_prefs_json === null) &&
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
