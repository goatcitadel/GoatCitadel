import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  AgentPresetDefaults,
  AgentLifecycleStatus,
  AgentProfileArchiveInput,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
  BuiltinAgentProfileSeed,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface AgentProfileRow {
  agent_id: string;
  role_id: string;
  name: string;
  title: string;
  summary: string;
  specialties_json: string;
  default_tools_json: string;
  aliases_json: string;
  preset_defaults_json: string | null;
  is_builtin: number;
  lifecycle_status: AgentLifecycleStatus;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  created_at: string;
  updated_at: string;
}

export class AgentProfileRepository {
  private readonly listStmt;
  private readonly getStmt;
  private readonly getByRoleIdStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly archiveStmt;
  private readonly restoreStmt;
  private readonly deleteStmt;
  private readonly seedStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.listStmt = db.prepare(`
      SELECT * FROM agent_profiles
      WHERE (
        @view = 'all'
        OR (@view = 'active' AND lifecycle_status = 'active')
        OR (@view = 'archived' AND lifecycle_status = 'archived')
      )
      ORDER BY is_builtin DESC, updated_at DESC, role_id ASC
      LIMIT @limit
    `);

    this.getStmt = db.prepare("SELECT * FROM agent_profiles WHERE agent_id = ?");
    this.getByRoleIdStmt = db.prepare("SELECT * FROM agent_profiles WHERE role_id = ?");

    this.insertStmt = db.prepare(`
      INSERT INTO agent_profiles (
        agent_id, role_id, name, title, summary,
        specialties_json, default_tools_json, aliases_json, preset_defaults_json,
        is_builtin, lifecycle_status,
        archived_at, archived_by, archive_reason,
        created_at, updated_at
      ) VALUES (
        @agentId, @roleId, @name, @title, @summary,
        @specialtiesJson, @defaultToolsJson, @aliasesJson, @presetDefaultsJson,
        @isBuiltin, @lifecycleStatus,
        @archivedAt, @archivedBy, @archiveReason,
        @createdAt, @updatedAt
      )
    `);

    this.updateStmt = db.prepare(`
      UPDATE agent_profiles
      SET
        name = @name,
        title = @title,
        summary = @summary,
        specialties_json = @specialtiesJson,
        default_tools_json = @defaultToolsJson,
        aliases_json = @aliasesJson,
        preset_defaults_json = @presetDefaultsJson,
        updated_at = @updatedAt
      WHERE agent_id = @agentId
    `);

    this.archiveStmt = db.prepare(`
      UPDATE agent_profiles
      SET
        lifecycle_status = 'archived',
        archived_at = @archivedAt,
        archived_by = @archivedBy,
        archive_reason = @archiveReason,
        updated_at = @updatedAt
      WHERE agent_id = @agentId
    `);

    this.restoreStmt = db.prepare(`
      UPDATE agent_profiles
      SET
        lifecycle_status = 'active',
        archived_at = NULL,
        archived_by = NULL,
        archive_reason = NULL,
        updated_at = @updatedAt
      WHERE agent_id = @agentId
    `);

    this.deleteStmt = db.prepare("DELETE FROM agent_profiles WHERE agent_id = ?");

    this.seedStmt = db.prepare(`
      INSERT INTO agent_profiles (
        agent_id, role_id, name, title, summary,
        specialties_json, default_tools_json, aliases_json, preset_defaults_json,
        is_builtin, lifecycle_status,
        created_at, updated_at
      ) VALUES (
        @agentId, @roleId, @name, @title, @summary,
        @specialtiesJson, @defaultToolsJson, @aliasesJson, @presetDefaultsJson,
        1, 'active',
        @createdAt, @updatedAt
      )
      ON CONFLICT DO NOTHING
    `);
  }

  public seedBuiltins(seeds: BuiltinAgentProfileSeed[], now = new Date().toISOString()): void {
    for (const seed of seeds) {
      this.seedStmt.run({
        agentId: seed.agentId,
        roleId: seed.roleId,
        name: seed.name,
        title: seed.title,
        summary: seed.summary,
        specialtiesJson: serializeArray(seed.specialties),
        defaultToolsJson: serializeArray(seed.defaultTools),
        aliasesJson: serializeArray(seed.aliases),
        presetDefaultsJson: serializePresetDefaults(seed.presetDefaults),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  public list(view: AgentLifecycleStatus | "all" = "active", limit = 500): AgentProfileRecord[] {
    const rows = toAgentProfileRows(
      this.listStmt.all({
        view,
        limit: Math.max(1, Math.min(2000, Math.floor(limit))),
      }),
    );
    return rows.map(mapRow);
  }

  public get(agentId: string): AgentProfileRecord {
    const row = toAgentProfileRow(this.getStmt.get(agentId));
    if (!row) {
      throw new NotFoundError({ entity: "Agent profile", id: agentId });
    }
    return mapRow(row);
  }

  public find(agentId: string): AgentProfileRecord | undefined {
    const row = toAgentProfileRow(this.getStmt.get(agentId));
    return row ? mapRow(row) : undefined;
  }

  public getByRoleId(roleId: string): AgentProfileRecord | undefined {
    const row = toAgentProfileRow(this.getByRoleIdStmt.get(roleId));
    return row ? mapRow(row) : undefined;
  }

  public create(input: AgentProfileCreateInput, now = new Date().toISOString()): AgentProfileRecord {
    const roleId = normalizeRoleId(input.roleId);
    if (this.getByRoleId(roleId)) {
      throw new ConflictError({ code: "ALREADY_EXISTS", message: `Agent role ${roleId} already exists` });
    }

    const agentId = randomUUID();
    this.insertStmt.run({
      agentId,
      roleId,
      name: sanitizeRequired(input.name, "name"),
      title: sanitizeRequired(input.title, "title"),
      summary: sanitizeRequired(input.summary, "summary"),
      specialtiesJson: serializeArray(input.specialties ?? []),
      defaultToolsJson: serializeArray(input.defaultTools ?? []),
      aliasesJson: serializeArray(input.aliases ?? []),
      presetDefaultsJson: serializePresetDefaults(input.presetDefaults),
      isBuiltin: 0,
      lifecycleStatus: "active",
      archivedAt: null,
      archivedBy: null,
      archiveReason: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.get(agentId);
  }

  public update(agentId: string, input: AgentProfileUpdateInput, now = new Date().toISOString()): AgentProfileRecord {
    const current = this.get(agentId);
    this.updateStmt.run({
      agentId,
      name: input.name !== undefined ? sanitizeRequired(input.name, "name") : current.name,
      title: input.title !== undefined ? sanitizeRequired(input.title, "title") : current.title,
      summary: input.summary !== undefined ? sanitizeRequired(input.summary, "summary") : current.summary,
      specialtiesJson:
        input.specialties !== undefined ? serializeArray(input.specialties) : serializeArray(current.specialties),
      defaultToolsJson:
        input.defaultTools !== undefined ? serializeArray(input.defaultTools) : serializeArray(current.defaultTools),
      aliasesJson: input.aliases !== undefined ? serializeArray(input.aliases) : serializeArray(current.aliases),
      presetDefaultsJson: serializePresetDefaults(
        input.presetDefaults !== undefined ? input.presetDefaults : current.presetDefaults,
      ),
      updatedAt: now,
    });
    return this.get(agentId);
  }

  public archive(agentId: string, input: AgentProfileArchiveInput, now = new Date().toISOString()): AgentProfileRecord {
    const current = this.get(agentId);
    if (current.lifecycleStatus === "archived") {
      return current;
    }
    this.archiveStmt.run({
      agentId,
      archivedAt: now,
      archivedBy: sanitizeOptional(input.archivedBy),
      archiveReason: sanitizeOptional(input.archiveReason),
      updatedAt: now,
    });
    return this.get(agentId);
  }

  public restore(agentId: string, now = new Date().toISOString()): AgentProfileRecord {
    const current = this.get(agentId);
    if (current.lifecycleStatus === "active") {
      return current;
    }
    this.restoreStmt.run({
      agentId,
      updatedAt: now,
    });
    return this.get(agentId);
  }

  public hardDelete(agentId: string): boolean {
    const current = this.find(agentId);
    if (!current) {
      return false;
    }
    if (current.isBuiltin) {
      throw new ConflictError({ code: "STATE_CONFLICT", message: "Built-in agents cannot be hard deleted" });
    }
    this.deleteStmt.run(agentId);
    return true;
  }
}

function mapRow(row: AgentProfileRow): AgentProfileRecord {
  return {
    agentId: row.agent_id,
    roleId: row.role_id,
    name: row.name,
    title: row.title,
    summary: row.summary,
    specialties: parseStringArray(row.specialties_json),
    defaultTools: parseStringArray(row.default_tools_json),
    aliases: parseStringArray(row.aliases_json),
    presetDefaults: parsePresetDefaults(row.preset_defaults_json),
    isBuiltin: row.is_builtin === 1,
    editable: true,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
    archivedBy: row.archived_by ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
    status: "idle",
    sessionCount: 0,
    activeSessions: 0,
    lastUpdatedAt: undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRoleId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "roleId" });
  }
  return normalized.slice(0, 80);
}

function sanitizeRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function sanitizeOptional(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function serializeArray(values: string[]): string {
  const deduped = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return JSON.stringify(deduped);
}

function parseStringArray(value: string): string[] {
  const parsed = safeJsonParse<unknown>(value, []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) {
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

function serializePresetDefaults(value?: AgentPresetDefaults): string | null {
  if (!value) {
    return null;
  }
  const normalized: AgentPresetDefaults = {
    presetLabel: sanitizeOptional(value.presetLabel) ?? undefined,
    presetSummary: sanitizeOptional(value.presetSummary) ?? undefined,
    routeHint: value.routeHint,
    preferredProviderId: sanitizeOptional(value.preferredProviderId) ?? undefined,
    preferredModel: sanitizeOptional(value.preferredModel) ?? undefined,
    toolsPosture: value.toolsPosture,
    knowledgeAttachmentIds: value.knowledgeAttachmentIds?.map((item) => item.trim()).filter(Boolean),
    promptFraming: sanitizeOptional(value.promptFraming) ?? undefined,
  };
  if (Object.values(normalized).every((item) => item === undefined || (Array.isArray(item) && item.length === 0))) {
    return null;
  }
  return JSON.stringify(normalized);
}

function parsePresetDefaults(value: string | null): AgentPresetDefaults | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = safeJsonParse<AgentPresetDefaults | null>(value, null);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  return {
    presetLabel: sanitizeOptional(parsed.presetLabel) ?? undefined,
    presetSummary: sanitizeOptional(parsed.presetSummary) ?? undefined,
    routeHint: parsed.routeHint,
    preferredProviderId: sanitizeOptional(parsed.preferredProviderId) ?? undefined,
    preferredModel: sanitizeOptional(parsed.preferredModel) ?? undefined,
    toolsPosture: parsed.toolsPosture,
    knowledgeAttachmentIds: parsed.knowledgeAttachmentIds?.map((item) => item.trim()).filter(Boolean) ?? [],
    promptFraming: sanitizeOptional(parsed.promptFraming) ?? undefined,
  };
}

function toAgentProfileRow(value: unknown): AgentProfileRow | undefined {
  return isAgentProfileRow(value) ? value : undefined;
}

function toAgentProfileRows(value: unknown): AgentProfileRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isAgentProfileRow);
}

function isAgentProfileRow(value: unknown): value is AgentProfileRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.agent_id === "string" &&
    typeof value.role_id === "string" &&
    typeof value.name === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.specialties_json === "string" &&
    typeof value.default_tools_json === "string" &&
    typeof value.aliases_json === "string" &&
    (typeof value.preset_defaults_json === "string" || value.preset_defaults_json === null) &&
    typeof value.is_builtin === "number" &&
    typeof value.lifecycle_status === "string" &&
    (typeof value.archived_at === "string" || value.archived_at === null) &&
    (typeof value.archived_by === "string" || value.archived_by === null) &&
    (typeof value.archive_reason === "string" || value.archive_reason === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
