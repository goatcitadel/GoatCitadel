import { randomUUID } from "node:crypto";
import type {
  LocalOperatorOverrideCreateInput,
  LocalOperatorOverrideRecord,
  LocalOperatorOverrideScope,
  PermissionProfileActivationInput,
  PermissionProfileActivationRecord,
  PermissionProfileBuiltinId,
  PermissionProfileCreateInput,
  PermissionProfileRecord,
  PermissionProfileScope,
  PermissionProfileUpdateInput,
  PermissionSurface,
} from "@goatcitadel/contracts";
import {
  ConflictError,
  HEARTBEAT_RESTRICTED_PROFILE,
  NotFoundError,
  SCHEDULED_RESTRICTED_PROFILE,
  ValidationError,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface PermissionProfileRow {
  profile_id: string;
  label: string;
  description: string | null;
  builtin: number;
  status: "active" | "archived";
  scope: PermissionProfileScope;
  scope_ref: string | null;
  approval_mode: PermissionProfileRecord["approvalMode"];
  legacy_tool_profile: string | null;
  tool_patterns_json: string;
  allow_json: string;
  deny_json: string;
  read_access_mode: PermissionProfileRecord["readAccessMode"] | null;
  default_for_surfaces_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface PermissionProfileActivationRow {
  activation_id: string;
  profile_id: string;
  operator_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
  surface: PermissionSurface | null;
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface LocalOperatorOverrideRow {
  override_id: string;
  operator_id: string;
  scope: LocalOperatorOverrideScope;
  scope_ref: string | null;
  reason: string;
  status: LocalOperatorOverrideRecord["status"];
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface PermissionProfileContextQuery {
  operatorId?: string;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  surface?: PermissionSurface;
  profileId?: string;
  overrideId?: string;
  disableLocalOperatorOverrides?: boolean;
  /**
   * Builtin profile to fall back to when no explicit profileId and no matching
   * activation resolve. Defaults to "safe" (approve-all). The gateway passes
   * "trusted_local_power" for a local-first operator who configured
   * `approvalMode: "bypass"`, so their default sessions aren't silently forced
   * onto approve-all (which gates every tool and degrades cowork). Constrained to
   * builtin ids so an unknown fallback can't slip through to a runtime not-found.
   */
  defaultProfileId?: PermissionProfileBuiltinId;
}

export interface ResolvedPermissionProfileContext {
  permissionProfile: PermissionProfileRecord;
  localOperatorOverride?: LocalOperatorOverrideRecord;
}

const BUILTIN_CREATED_AT = "2026-05-17T00:00:00.000Z";
const NON_OVERRIDABLE_BOUNDARIES = [
  "auth",
  "deny_wins_policy",
  "path_jails",
  "disabled_capabilities",
  "network_allowlist",
  "ssrf_private_host_blocks",
  "code_mode_sandbox_fail_closed",
] as const;

export const BUILTIN_PERMISSION_PROFILES: PermissionProfileRecord[] = [
  {
    profileId: "safe",
    label: "Safe",
    description: "Ask before every otherwise-allowed tool action. Hard policy boundaries still apply.",
    builtin: true,
    status: "active",
    scope: "global",
    approvalMode: "approve_all",
    legacyToolProfile: "danger",
    toolPatterns: ["*"],
    allow: [],
    deny: [],
    readAccessMode: "approval_required",
    defaultForSurfaces: ["chat", "cowork", "code", "tools", "mcp"],
    createdBy: "system",
    createdAt: BUILTIN_CREATED_AT,
    updatedAt: BUILTIN_CREATED_AT,
  },
  {
    profileId: "trusted_local_power",
    label: "Trusted Local Power",
    description:
      "Run allowed local tools without normal prompts. Nuclear-risk, risky-shell, outside-root read approvals, deny rules, auth, path, and network boundaries still apply.",
    builtin: true,
    status: "active",
    scope: "global",
    approvalMode: "bypass",
    legacyToolProfile: "danger",
    toolPatterns: ["*"],
    allow: ["*"],
    deny: [],
    readAccessMode: "approval_required",
    defaultForSurfaces: [],
    createdBy: "system",
    createdAt: BUILTIN_CREATED_AT,
    updatedAt: BUILTIN_CREATED_AT,
  },
  // Phase 1 (proactive/autonomous): restricted profiles for cron/scheduled and
  // heartbeat turns. Canonical records live in @goatcitadel/contracts so the
  // gateway policy builder and this seed share one source of truth.
  SCHEDULED_RESTRICTED_PROFILE,
  HEARTBEAT_RESTRICTED_PROFILE,
];

export class PermissionProfileRepository {
  private readonly createProfileStmt;
  private readonly updateProfileStmt;
  private readonly archiveProfileStmt;
  private readonly getProfileStmt;
  private readonly listProfilesStmt;
  private readonly deactivateActivationStmt;
  private readonly deactivateProfileActivationStmt;
  private readonly createActivationStmt;
  private readonly listActiveActivationsStmt;
  private readonly createOverrideStmt;
  private readonly getOverrideStmt;
  private readonly revokeOverrideStmt;
  private readonly expireOverridesStmt;
  private readonly listActiveOverridesStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.createProfileStmt = db.prepare(`
      INSERT INTO permission_profiles (
        profile_id, label, description, builtin, status, scope, scope_ref, approval_mode, legacy_tool_profile,
        tool_patterns_json, allow_json, deny_json, read_access_mode, default_for_surfaces_json,
        created_by, created_at, updated_at, archived_at
      ) VALUES (
        @profileId, @label, @description, @builtin, @status, @scope, @scopeRef, @approvalMode, @legacyToolProfile,
        @toolPatternsJson, @allowJson, @denyJson, @readAccessMode, @defaultForSurfacesJson,
        @createdBy, @createdAt, @updatedAt, NULL
      )
    `);
    this.updateProfileStmt = db.prepare(`
      UPDATE permission_profiles
      SET label = @label,
          description = @description,
          approval_mode = @approvalMode,
          legacy_tool_profile = @legacyToolProfile,
          tool_patterns_json = @toolPatternsJson,
          allow_json = @allowJson,
          deny_json = @denyJson,
          read_access_mode = @readAccessMode,
          default_for_surfaces_json = @defaultForSurfacesJson,
          updated_at = @updatedAt
      WHERE profile_id = @profileId AND builtin = 0 AND status = 'active'
    `);
    this.archiveProfileStmt = db.prepare(`
      UPDATE permission_profiles
      SET status = 'archived',
          archived_at = @archivedAt,
          updated_at = @archivedAt
      WHERE profile_id = @profileId AND builtin = 0 AND status = 'active'
    `);
    this.getProfileStmt = db.prepare("SELECT * FROM permission_profiles WHERE profile_id = ?");
    this.listProfilesStmt = db.prepare(`
      SELECT * FROM permission_profiles
      ORDER BY builtin DESC, updated_at DESC, label ASC
    `);
    this.deactivateActivationStmt = db.prepare(`
      UPDATE permission_profile_activations
      SET active = 0, updated_at = @updatedAt
      WHERE active = 1
        AND COALESCE(operator_id, '') = COALESCE(@operatorId, '')
        AND COALESCE(workspace_id, '') = COALESCE(@workspaceId, '')
        AND COALESCE(session_id, '') = COALESCE(@sessionId, '')
        AND (
          @surface = 'all'
          OR COALESCE(surface, 'all') = COALESCE(@surface, 'all')
        )
    `);
    this.deactivateProfileActivationStmt = db.prepare(`
      UPDATE permission_profile_activations
      SET active = 0, updated_at = @updatedAt
      WHERE active = 1
        AND profile_id = @profileId
        AND COALESCE(operator_id, '') = COALESCE(@operatorId, '')
        AND COALESCE(workspace_id, '') = COALESCE(@workspaceId, '')
        AND COALESCE(session_id, '') = COALESCE(@sessionId, '')
        AND (@surface IS NULL OR COALESCE(surface, 'all') = COALESCE(@surface, 'all'))
    `);
    this.createActivationStmt = db.prepare(`
      INSERT INTO permission_profile_activations (
        activation_id, profile_id, operator_id, workspace_id, session_id, surface,
        active, created_by, created_at, updated_at
      ) VALUES (
        @activationId, @profileId, @operatorId, @workspaceId, @sessionId, @surface,
        1, @createdBy, @createdAt, @updatedAt
      )
    `);
    this.listActiveActivationsStmt = db.prepare(`
      SELECT * FROM permission_profile_activations
      WHERE active = 1
      ORDER BY updated_at DESC
      LIMIT 1000
    `);
    this.createOverrideStmt = db.prepare(`
      INSERT INTO local_operator_overrides (
        override_id, operator_id, scope, scope_ref, reason, status, created_by, created_at, expires_at, revoked_at, revoked_by
      ) VALUES (
        @overrideId, @operatorId, @scope, @scopeRef, @reason, 'active', @createdBy, @createdAt, @expiresAt, NULL, NULL
      )
    `);
    this.getOverrideStmt = db.prepare("SELECT * FROM local_operator_overrides WHERE override_id = ?");
    this.revokeOverrideStmt = db.prepare(`
      UPDATE local_operator_overrides
      SET status = 'revoked',
          revoked_at = @revokedAt,
          revoked_by = @revokedBy
      WHERE override_id = @overrideId AND status = 'active'
    `);
    this.expireOverridesStmt = db.prepare(`
      UPDATE local_operator_overrides
      SET status = 'expired'
      WHERE status = 'active' AND expires_at <= @now
    `);
    this.listActiveOverridesStmt = db.prepare(`
      SELECT * FROM local_operator_overrides
      WHERE status = 'active' AND expires_at > @now
      ORDER BY expires_at DESC, created_at DESC
      LIMIT 1000
    `);
  }

  public listProfiles(includeArchived = false): PermissionProfileRecord[] {
    const rows = this.listProfilesStmt.all() as PermissionProfileRow[];
    const custom = rows.map(mapProfileRow);
    const profiles = [...BUILTIN_PERMISSION_PROFILES, ...custom];
    return includeArchived ? profiles : profiles.filter((profile) => profile.status === "active");
  }

  public getProfile(profileId: string): PermissionProfileRecord {
    const builtin = BUILTIN_PERMISSION_PROFILES.find((profile) => profile.profileId === profileId);
    if (builtin) {
      return builtin;
    }
    const row = this.getProfileStmt.get(profileId) as PermissionProfileRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "permission profile", id: profileId });
    }
    return mapProfileRow(row);
  }

  public createProfile(input: PermissionProfileCreateInput, now = new Date().toISOString()): PermissionProfileRecord {
    const label = input.label.trim();
    if (!label) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "label" });
    }
    const profileId = `perm-${randomUUID()}`;
    const profile = normalizeProfileInput({
      profileId,
      input,
      now,
    });
    this.createProfileStmt.run(toProfileParams(profile));
    return this.getProfile(profileId);
  }

  public updateProfile(profileId: string, input: PermissionProfileUpdateInput): PermissionProfileRecord {
    const existing = this.getProfile(profileId);
    if (existing.builtin) {
      throw new ConflictError({ message: "Built-in permission profiles cannot be edited." });
    }
    const updatedAt = new Date().toISOString();
    const next: PermissionProfileRecord = {
      ...existing,
      label: input.label?.trim() || existing.label,
      description: input.description ?? existing.description,
      approvalMode: input.approvalMode ?? existing.approvalMode,
      legacyToolProfile: input.legacyToolProfile ?? existing.legacyToolProfile,
      toolPatterns: normalizeStringList(input.toolPatterns ?? existing.toolPatterns),
      allow: normalizeStringList(input.allow ?? existing.allow),
      deny: normalizeStringList(input.deny ?? existing.deny),
      readAccessMode: input.readAccessMode ?? existing.readAccessMode,
      defaultForSurfaces: normalizeSurfaces(input.defaultForSurfaces ?? existing.defaultForSurfaces),
      updatedAt,
    };
    const result = this.updateProfileStmt.run(toProfileParams(next));
    if (Number(result.changes ?? 0) === 0) {
      throw new NotFoundError({ entity: "permission profile", id: profileId });
    }
    return this.getProfile(profileId);
  }

  public archiveProfile(profileId: string, archivedAt = new Date().toISOString()): boolean {
    if (BUILTIN_PERMISSION_PROFILES.some((profile) => profile.profileId === profileId)) {
      throw new ConflictError({ message: "Built-in permission profiles cannot be archived." });
    }
    return Number(this.archiveProfileStmt.run({ profileId, archivedAt }).changes ?? 0) > 0;
  }

  public activateProfile(
    input: PermissionProfileActivationInput,
    now = new Date().toISOString(),
  ): PermissionProfileActivationRecord {
    const profile = this.getProfile(input.profileId);
    if (profile.status !== "active") {
      throw new ConflictError({ message: `Permission profile ${input.profileId} is not active.` });
    }
    if (
      !profileMatchesContext(profile, {
        operatorId: input.operatorId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        surface: input.surface,
      })
    ) {
      throw new ConflictError({
        message: `Permission profile ${profile.profileId} cannot be activated outside its ${profile.scope} scope.`,
      });
    }
    const surface = normalizeSurface(input.surface);
    this.deactivateActivationStmt.run({
      operatorId: normalizeNullable(input.operatorId),
      workspaceId: normalizeNullable(input.workspaceId),
      sessionId: normalizeNullable(input.sessionId),
      surface: surface ?? null,
      updatedAt: now,
    });
    const activationId = `perm-act-${randomUUID()}`;
    this.createActivationStmt.run({
      activationId,
      profileId: input.profileId,
      operatorId: normalizeNullable(input.operatorId),
      workspaceId: normalizeNullable(input.workspaceId),
      sessionId: normalizeNullable(input.sessionId),
      surface: surface ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });
    return {
      activationId,
      profileId: input.profileId,
      operatorId: normalizeNullable(input.operatorId) ?? undefined,
      workspaceId: normalizeNullable(input.workspaceId) ?? undefined,
      sessionId: normalizeNullable(input.sessionId) ?? undefined,
      surface,
      active: true,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
  }

  public deactivateProfileActivations(
    input: {
      profileId: string;
      operatorId?: string;
      workspaceId?: string;
      sessionId?: string;
      surface?: PermissionSurface;
    },
    now = new Date().toISOString(),
  ): number {
    return Number(
      this.deactivateProfileActivationStmt.run({
        profileId: input.profileId,
        operatorId: normalizeNullable(input.operatorId),
        workspaceId: normalizeNullable(input.workspaceId),
        sessionId: normalizeNullable(input.sessionId),
        surface: normalizeSurface(input.surface) ?? null,
        updatedAt: now,
      }).changes ?? 0,
    );
  }

  public resolveContext(input: PermissionProfileContextQuery): ResolvedPermissionProfileContext {
    const permissionProfile = this.resolveProfile(input);
    const localOperatorOverride = input.disableLocalOperatorOverrides ? undefined : this.resolveOverride(input);
    return {
      permissionProfile,
      localOperatorOverride,
    };
  }

  public createLocalOperatorOverride(
    input: LocalOperatorOverrideCreateInput,
    now = new Date().toISOString(),
  ): LocalOperatorOverrideRecord {
    const operatorId = input.operatorId.trim();
    const reason = input.reason.trim();
    if (!operatorId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "operatorId" });
    }
    if (!reason) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "reason" });
    }
    if (input.scope !== "operator" && !input.scopeRef?.trim()) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "scopeRef" });
    }
    const ttlSeconds = Math.max(60, Math.min(60 * 60, Math.floor(input.ttlSeconds)));
    const overrideId = `local-override-${randomUUID()}`;
    const createdAtMs = Date.parse(now);
    const expiresAt = new Date(
      (Number.isFinite(createdAtMs) ? createdAtMs : Date.now()) + ttlSeconds * 1000,
    ).toISOString();
    this.createOverrideStmt.run({
      overrideId,
      operatorId,
      scope: input.scope,
      scopeRef: normalizeNullable(input.scopeRef?.trim()),
      reason,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt,
    });
    return this.getLocalOperatorOverride(overrideId);
  }

  public getLocalOperatorOverride(overrideId: string): LocalOperatorOverrideRecord {
    this.expireOverrides();
    const row = this.getOverrideStmt.get(overrideId) as LocalOperatorOverrideRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "local operator override", id: overrideId });
    }
    return mapOverrideRow(row);
  }

  public revokeLocalOperatorOverride(
    overrideId: string,
    revokedAt = new Date().toISOString(),
    revokedBy?: string,
  ): boolean {
    const normalizedRevokedBy = revokedBy?.trim();
    if (!normalizedRevokedBy) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "revokedBy" });
    }
    return (
      Number(this.revokeOverrideStmt.run({ overrideId, revokedAt, revokedBy: normalizedRevokedBy }).changes ?? 0) > 0
    );
  }

  public listActiveLocalOperatorOverrides(now = new Date().toISOString()): LocalOperatorOverrideRecord[] {
    this.expireOverrides(now);
    return (this.listActiveOverridesStmt.all({ now }) as LocalOperatorOverrideRow[]).map(mapOverrideRow);
  }

  private resolveProfile(input: PermissionProfileContextQuery): PermissionProfileRecord {
    if (input.profileId) {
      const profile = this.getProfile(input.profileId);
      if (!profileMatchesContext(profile, input)) {
        throw new ConflictError({
          message: `Permission profile ${profile.profileId} is not active for the requested operator/workspace/session scope.`,
        });
      }
      return profile;
    }
    const surface = normalizeSurface(input.surface);
    const activations = (this.listActiveActivationsStmt.all() as PermissionProfileActivationRow[]).map(
      mapActivationRow,
    );
    const candidates = activations
      .filter((activation) => activationMatches(activation, input, surface))
      .sort((left, right) => activationRank(right, input, surface) - activationRank(left, input, surface));
    for (const candidate of candidates) {
      const profile = this.getProfile(candidate.profileId);
      if (profileMatchesContext(profile, input)) {
        return profile;
      }
    }
    return this.getProfile(input.defaultProfileId ?? "safe");
  }

  private resolveOverride(input: PermissionProfileContextQuery): LocalOperatorOverrideRecord | undefined {
    this.expireOverrides();
    if (input.overrideId) {
      const record = this.getLocalOperatorOverride(input.overrideId);
      if (!overrideMatches(record, input)) {
        throw new ConflictError({
          message: `Local Operator Override ${record.overrideId} is not active for the requested operator/workspace/session/run scope.`,
        });
      }
      return record;
    }
    const active = this.listActiveLocalOperatorOverrides();
    return active
      .filter((override) => overrideMatches(override, input))
      .sort((left, right) => overrideSpecificity(right) - overrideSpecificity(left))[0];
  }

  private expireOverrides(now = new Date().toISOString()): void {
    this.expireOverridesStmt.run({ now });
  }
}

function normalizeProfileInput(input: {
  profileId: string;
  input: PermissionProfileCreateInput;
  now: string;
}): PermissionProfileRecord {
  if ((input.input.scope as string | undefined) === "global") {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "scope",
      message: "Custom permission profiles cannot use global scope.",
    });
  }
  const scope = input.input.scope ?? "operator";
  const scopeRef = normalizeNullable(input.input.scopeRef);
  if (!scopeRef) {
    throw new ValidationError({
      code: "FIELD_REQUIRED",
      field: "scopeRef",
      message: `scopeRef is required for ${scope} profiles`,
    });
  }
  return {
    profileId: input.profileId,
    label: input.input.label.trim(),
    description: input.input.description,
    builtin: false,
    status: "active",
    scope,
    scopeRef: scopeRef ?? undefined,
    approvalMode: input.input.approvalMode,
    legacyToolProfile: input.input.legacyToolProfile,
    toolPatterns: normalizeStringList(input.input.toolPatterns ?? ["*"]),
    allow: normalizeStringList(input.input.allow ?? []),
    deny: normalizeStringList(input.input.deny ?? []),
    readAccessMode: input.input.readAccessMode,
    defaultForSurfaces: normalizeSurfaces(input.input.defaultForSurfaces),
    createdBy: input.input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function toProfileParams(profile: PermissionProfileRecord): Record<string, unknown> {
  return {
    profileId: profile.profileId,
    label: profile.label,
    description: profile.description ?? null,
    builtin: profile.builtin ? 1 : 0,
    status: profile.status,
    scope: profile.scope,
    scopeRef: profile.scopeRef ?? null,
    approvalMode: profile.approvalMode,
    legacyToolProfile: profile.legacyToolProfile ?? null,
    toolPatternsJson: JSON.stringify(profile.toolPatterns),
    allowJson: JSON.stringify(profile.allow),
    denyJson: JSON.stringify(profile.deny),
    readAccessMode: profile.readAccessMode ?? null,
    defaultForSurfacesJson: JSON.stringify(profile.defaultForSurfaces ?? []),
    createdBy: profile.createdBy,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function mapProfileRow(row: PermissionProfileRow): PermissionProfileRecord {
  return {
    profileId: row.profile_id,
    label: row.label,
    description: row.description ?? undefined,
    builtin: row.builtin === 1,
    status: row.status,
    scope: row.scope,
    scopeRef: row.scope_ref ?? undefined,
    approvalMode: row.approval_mode,
    legacyToolProfile: row.legacy_tool_profile ?? undefined,
    toolPatterns: safeJsonParse<string[]>(row.tool_patterns_json, []),
    allow: safeJsonParse<string[]>(row.allow_json, []),
    deny: safeJsonParse<string[]>(row.deny_json, []),
    readAccessMode: row.read_access_mode ?? undefined,
    defaultForSurfaces: normalizeSurfaces(safeJsonParse<PermissionSurface[]>(row.default_for_surfaces_json, [])),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function mapActivationRow(row: PermissionProfileActivationRow): PermissionProfileActivationRecord {
  return {
    activationId: row.activation_id,
    profileId: row.profile_id,
    operatorId: row.operator_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    surface: row.surface ?? undefined,
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOverrideRow(row: LocalOperatorOverrideRow): LocalOperatorOverrideRecord {
  return {
    overrideId: row.override_id,
    operatorId: row.operator_id,
    scope: row.scope,
    scopeRef: row.scope_ref ?? undefined,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
    revokedBy: row.revoked_by ?? undefined,
  };
}

function activationMatches(
  activation: PermissionProfileActivationRecord,
  input: PermissionProfileContextQuery,
  surface?: PermissionSurface,
): boolean {
  if (activation.surface && activation.surface !== "all") {
    if (!surface || activation.surface !== surface) {
      return false;
    }
  }
  if (activation.sessionId && activation.sessionId !== input.sessionId) return false;
  if (activation.workspaceId && activation.workspaceId !== input.workspaceId) return false;
  if (activation.operatorId && activation.operatorId !== input.operatorId) return false;
  return Boolean(activation.operatorId || activation.workspaceId || activation.sessionId || activation.surface);
}

function activationRank(
  activation: PermissionProfileActivationRecord,
  input: PermissionProfileContextQuery,
  surface?: PermissionSurface,
): number {
  let rank = 0;
  if (activation.operatorId && activation.operatorId === input.operatorId) rank += 1;
  if (activation.workspaceId && activation.workspaceId === input.workspaceId) rank += 4;
  if (activation.sessionId && activation.sessionId === input.sessionId) rank += 8;
  if (activation.surface && activation.surface !== "all" && activation.surface === surface) rank += 2;
  return rank;
}

function overrideMatches(override: LocalOperatorOverrideRecord, input: PermissionProfileContextQuery): boolean {
  if (override.status !== "active" || Date.parse(override.expiresAt) <= Date.now()) {
    return false;
  }
  if (!input.operatorId || override.operatorId !== input.operatorId) {
    return false;
  }
  switch (override.scope) {
    case "operator":
      return true;
    case "workspace":
      return Boolean(override.scopeRef && override.scopeRef === input.workspaceId);
    case "session":
      return Boolean(override.scopeRef && override.scopeRef === input.sessionId);
    case "run":
      return Boolean(override.scopeRef && override.scopeRef === input.runId);
    default:
      return false;
  }
}

function overrideSpecificity(override: LocalOperatorOverrideRecord): number {
  switch (override.scope) {
    case "run":
      return 16;
    case "session":
      return 8;
    case "workspace":
      return 4;
    case "operator":
      return 1;
    default:
      return 0;
  }
}

function profileMatchesContext(profile: PermissionProfileRecord, input: PermissionProfileContextQuery): boolean {
  if (profile.status !== "active") {
    return false;
  }
  switch (profile.scope) {
    case "global":
      return true;
    case "operator":
      return Boolean(profile.scopeRef && profile.scopeRef === input.operatorId);
    case "workspace":
      return Boolean(profile.scopeRef && profile.scopeRef === input.workspaceId);
    default:
      return false;
  }
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeSurfaces(values: PermissionSurface[] | undefined): PermissionSurface[] | undefined {
  const normalized = normalizeStringList(values ?? []).filter(
    (value): value is PermissionSurface =>
      value === "chat" ||
      value === "cowork" ||
      value === "code" ||
      value === "tools" ||
      value === "mcp" ||
      value === "all",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSurface(value: PermissionSurface | undefined): PermissionSurface | undefined {
  return value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "tools" ||
    value === "mcp" ||
    value === "all"
    ? value
    : undefined;
}

function normalizeNullable(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function listLocalOperatorOverrideBoundaries(): readonly string[] {
  return NON_OVERRIDABLE_BOUNDARIES;
}
