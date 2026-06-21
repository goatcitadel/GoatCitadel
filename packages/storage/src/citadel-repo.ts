import type {
  Citadel,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCreateInput,
  CitadelCouncilAssignment,
  CitadelCouncilAssignmentInput,
  CitadelIntegrationGrant,
  CitadelIntegrationGrantInput,
  CitadelIntegrationMode,
  CitadelLifecycleStatus,
  CitadelMember,
  CitadelMemberInput,
  CitadelPassage,
  CitadelPassageInput,
  CitadelRecord,
  CitadelRole,
  CitadelUpdateInput,
  CitadelVaultSecretInput,
  CitadelVaultSecretRecord,
  CitadelWardInput,
  CitadelWardRecord,
  ChamberSensitivity,
  SealedValue,
  CitadelKind,
  CitadelModelPolicy,
  CitadelRiskPosture,
  MasonAnswers,
  MasonSession,
  MasonSessionStatus,
  WardEffect,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface CharterRow {
  citadel_id: string;
  purpose: string;
  kind: string;
  goals_json: string;
  boundaries_json: string;
  success_definition_json: string;
  default_chamber_id: string | null;
  risk_posture: string;
  model_policy_default: string;
  created_at: string;
  updated_at: string;
}

interface CitadelRecordRow {
  citadel_id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: string;
  lifecycle_status: "active" | "archived";
  archived_at: string | null;
  default_workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ChamberRow {
  chamber_id: string;
  citadel_id: string;
  name: string;
  sensitivity: string;
  sealed: number;
  created_at: string;
  updated_at: string;
}

interface CouncilAssignmentRow {
  assignment_id: string;
  citadel_id: string;
  agent_id: string;
  created_at: string;
}

interface WardRow {
  ward_id: string;
  citadel_id: string;
  name: string;
  action_pattern: string;
  effect: string;
  created_at: string;
}

interface VaultSecretRow {
  secret_id: string;
  citadel_id: string;
  secret_name: string;
  sealed_value_json: string;
  created_at: string;
  updated_at: string;
}

interface PassageRow {
  passage_id: string;
  source_citadel_id: string;
  source_chamber_id: string | null;
  destination_citadel_id: string;
  allowed_fields_json: string;
  expires_at: string | null;
  created_at: string;
}

interface MemberRow {
  member_id: string;
  citadel_id: string;
  subject_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}

interface MasonSessionRow {
  session_id: string;
  answers_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface IntegrationGrantRow {
  grant_id: string;
  citadel_id: string;
  provider: string;
  account: string | null;
  capabilities_json: string;
  mode: string;
  expires_at: string | null;
  created_at: string;
}

/**
 * Persistence for Citadel identity: a Charter (1:1 with a workspace/citadel) and
 * its Chambers. A Citadel is a workspace that has a Charter.
 */
export class CitadelRepository {
  private readonly listRecordsStmt;
  private readonly getRecordStmt;
  private readonly getRecordBySlugStmt;
  private readonly insertRecordStmt;
  private readonly updateRecordStmt;
  private readonly archiveRecordStmt;
  private readonly restoreRecordStmt;
  private readonly upsertCharterStmt;
  private readonly getCharterStmt;
  private readonly createChamberStmt;
  private readonly getChamberStmt;
  private readonly listChambersStmt;
  private readonly assignAgentStmt;
  private readonly getAssignmentByPairStmt;
  private readonly listAssignmentsStmt;
  private readonly unassignAgentStmt;
  private readonly addWardStmt;
  private readonly getWardStmt;
  private readonly listWardsStmt;
  private readonly deleteWardStmt;
  private readonly storeVaultSecretStmt;
  private readonly getVaultSecretStmt;
  private readonly getVaultSecretByNameStmt;
  private readonly listVaultSecretsStmt;
  private readonly deleteVaultSecretStmt;
  private readonly createPassageStmt;
  private readonly getPassageStmt;
  private readonly listPassagesStmt;
  private readonly deletePassageStmt;
  private readonly upsertMemberStmt;
  private readonly getMemberByPairStmt;
  private readonly listMembersStmt;
  private readonly deleteMemberStmt;
  private readonly createMasonSessionStmt;
  private readonly getMasonSessionStmt;
  private readonly updateMasonSessionStmt;
  private readonly addIntegrationGrantStmt;
  private readonly getIntegrationGrantStmt;
  private readonly listIntegrationGrantsStmt;
  private readonly deleteIntegrationGrantStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.listRecordsStmt = db.prepare(`
      SELECT * FROM citadel_records
      WHERE (
        @view = 'all'
        OR (@view = 'active' AND lifecycle_status = 'active')
        OR (@view = 'archived' AND lifecycle_status = 'archived')
      )
      ORDER BY updated_at DESC, citadel_id ASC
      LIMIT @limit
    `);
    this.getRecordStmt = db.prepare("SELECT * FROM citadel_records WHERE citadel_id = ?");
    this.getRecordBySlugStmt = db.prepare("SELECT * FROM citadel_records WHERE slug = ?");
    this.insertRecordStmt = db.prepare(`
      INSERT INTO citadel_records (
        citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
        default_workspace_id, created_at, updated_at
      ) VALUES (
        @citadelId, @name, @description, @slug, @kind, 'active', NULL,
        @defaultWorkspaceId, @createdAt, @updatedAt
      )
    `);
    this.updateRecordStmt = db.prepare(`
      UPDATE citadel_records
      SET
        name = @name,
        description = @description,
        slug = @slug,
        kind = @kind,
        default_workspace_id = @defaultWorkspaceId,
        updated_at = @updatedAt
      WHERE citadel_id = @citadelId
    `);
    this.archiveRecordStmt = db.prepare(`
      UPDATE citadel_records
      SET lifecycle_status = 'archived', archived_at = @archivedAt, updated_at = @updatedAt
      WHERE citadel_id = @citadelId
    `);
    this.restoreRecordStmt = db.prepare(`
      UPDATE citadel_records
      SET lifecycle_status = 'active', archived_at = NULL, updated_at = @updatedAt
      WHERE citadel_id = @citadelId
    `);
    this.upsertCharterStmt = db.prepare(`
      INSERT INTO citadel_charters (
        citadel_id, purpose, kind, goals_json, boundaries_json, success_definition_json,
        default_chamber_id, risk_posture, model_policy_default, created_at, updated_at
      ) VALUES (
        @citadelId, @purpose, @kind, @goalsJson, @boundariesJson, @successDefinitionJson,
        @defaultChamberId, @riskPosture, @modelPolicyDefault, @now, @now
      )
      ON CONFLICT(citadel_id) DO UPDATE SET
        purpose = @purpose,
        kind = @kind,
        goals_json = @goalsJson,
        boundaries_json = @boundariesJson,
        success_definition_json = @successDefinitionJson,
        default_chamber_id = @defaultChamberId,
        risk_posture = @riskPosture,
        model_policy_default = @modelPolicyDefault,
        updated_at = @now
    `);
    this.getCharterStmt = db.prepare("SELECT * FROM citadel_charters WHERE citadel_id = @citadelId");
    this.createChamberStmt = db.prepare(`
      INSERT INTO citadel_chambers (
        chamber_id, citadel_id, name, sensitivity, sealed, created_at, updated_at
      ) VALUES (
        @chamberId, @citadelId, @name, @sensitivity, @sealed, @now, @now
      )
    `);
    this.getChamberStmt = db.prepare("SELECT * FROM citadel_chambers WHERE chamber_id = @chamberId");
    this.listChambersStmt = db.prepare(
      "SELECT * FROM citadel_chambers WHERE citadel_id = @citadelId ORDER BY name ASC, chamber_id ASC",
    );
    this.assignAgentStmt = db.prepare(`
      INSERT INTO citadel_agent_assignments (assignment_id, citadel_id, agent_id, created_at)
      VALUES (@assignmentId, @citadelId, @agentId, @now)
      ON CONFLICT(citadel_id, agent_id) DO NOTHING
    `);
    this.getAssignmentByPairStmt = db.prepare(
      "SELECT * FROM citadel_agent_assignments WHERE citadel_id = @citadelId AND agent_id = @agentId",
    );
    this.listAssignmentsStmt = db.prepare(
      "SELECT * FROM citadel_agent_assignments WHERE citadel_id = @citadelId ORDER BY created_at ASC, assignment_id ASC",
    );
    this.unassignAgentStmt = db.prepare(
      "DELETE FROM citadel_agent_assignments WHERE citadel_id = @citadelId AND agent_id = @agentId",
    );
    this.addWardStmt = db.prepare(`
      INSERT INTO citadel_wards (ward_id, citadel_id, name, action_pattern, effect, created_at)
      VALUES (@wardId, @citadelId, @name, @actionPattern, @effect, @now)
    `);
    this.getWardStmt = db.prepare("SELECT * FROM citadel_wards WHERE ward_id = @wardId");
    this.listWardsStmt = db.prepare(
      "SELECT * FROM citadel_wards WHERE citadel_id = @citadelId ORDER BY created_at ASC, ward_id ASC",
    );
    this.deleteWardStmt = db.prepare("DELETE FROM citadel_wards WHERE ward_id = @wardId AND citadel_id = @citadelId");
    this.storeVaultSecretStmt = db.prepare(`
      INSERT INTO citadel_vault_secrets (secret_id, citadel_id, secret_name, sealed_value_json, created_at, updated_at)
      VALUES (@secretId, @citadelId, @secretName, @sealedValueJson, @now, @now)
      ON CONFLICT(citadel_id, secret_name) DO UPDATE SET
        sealed_value_json = excluded.sealed_value_json,
        updated_at = excluded.updated_at
    `);
    this.getVaultSecretStmt = db.prepare(
      "SELECT * FROM citadel_vault_secrets WHERE secret_id = @secretId AND citadel_id = @citadelId",
    );
    this.getVaultSecretByNameStmt = db.prepare(
      "SELECT * FROM citadel_vault_secrets WHERE citadel_id = @citadelId AND secret_name = @secretName",
    );
    this.listVaultSecretsStmt = db.prepare(
      "SELECT * FROM citadel_vault_secrets WHERE citadel_id = @citadelId ORDER BY secret_name ASC, secret_id ASC",
    );
    this.deleteVaultSecretStmt = db.prepare(
      "DELETE FROM citadel_vault_secrets WHERE secret_id = @secretId AND citadel_id = @citadelId",
    );
    this.createPassageStmt = db.prepare(`
      INSERT INTO citadel_passages (
        passage_id, source_citadel_id, source_chamber_id, destination_citadel_id,
        allowed_fields_json, expires_at, created_at
      ) VALUES (
        @passageId, @sourceCitadelId, @sourceChamberId, @destinationCitadelId,
        @allowedFieldsJson, @expiresAt, @now
      )
    `);
    this.getPassageStmt = db.prepare("SELECT * FROM citadel_passages WHERE passage_id = @passageId");
    this.listPassagesStmt = db.prepare(
      "SELECT * FROM citadel_passages WHERE source_citadel_id = @sourceCitadelId ORDER BY created_at ASC, passage_id ASC",
    );
    this.deletePassageStmt = db.prepare(
      "DELETE FROM citadel_passages WHERE passage_id = @passageId AND source_citadel_id = @sourceCitadelId",
    );
    this.upsertMemberStmt = db.prepare(`
      INSERT INTO citadel_members (member_id, citadel_id, subject_id, role, created_at, updated_at)
      VALUES (@memberId, @citadelId, @subjectId, @role, @now, @now)
      ON CONFLICT(citadel_id, subject_id) DO UPDATE SET
        role = @role,
        updated_at = @now
    `);
    this.getMemberByPairStmt = db.prepare(
      "SELECT * FROM citadel_members WHERE citadel_id = @citadelId AND subject_id = @subjectId",
    );
    this.listMembersStmt = db.prepare(
      "SELECT * FROM citadel_members WHERE citadel_id = @citadelId ORDER BY created_at ASC, member_id ASC",
    );
    this.deleteMemberStmt = db.prepare(
      "DELETE FROM citadel_members WHERE citadel_id = @citadelId AND subject_id = @subjectId",
    );
    this.createMasonSessionStmt = db.prepare(`
      INSERT INTO mason_sessions (session_id, answers_json, status, created_at, updated_at)
      VALUES (@sessionId, '{}', 'collecting', @now, @now)
    `);
    this.getMasonSessionStmt = db.prepare("SELECT * FROM mason_sessions WHERE session_id = @sessionId");
    this.updateMasonSessionStmt = db.prepare(`
      UPDATE mason_sessions SET answers_json = @answersJson, status = @status, updated_at = @now
      WHERE session_id = @sessionId
    `);
    this.addIntegrationGrantStmt = db.prepare(`
      INSERT INTO citadel_integration_grants (
        grant_id, citadel_id, provider, account, capabilities_json, mode, expires_at, created_at
      ) VALUES (
        @grantId, @citadelId, @provider, @account, @capabilitiesJson, @mode, @expiresAt, @now
      )
    `);
    this.getIntegrationGrantStmt = db.prepare("SELECT * FROM citadel_integration_grants WHERE grant_id = @grantId");
    this.listIntegrationGrantsStmt = db.prepare(
      "SELECT * FROM citadel_integration_grants WHERE citadel_id = @citadelId ORDER BY created_at ASC, grant_id ASC",
    );
    this.deleteIntegrationGrantStmt = db.prepare(
      "DELETE FROM citadel_integration_grants WHERE grant_id = @grantId AND citadel_id = @citadelId",
    );
  }

  public listRecords(view: CitadelLifecycleStatus | "all" = "active", limit = 200): CitadelRecord[] {
    const rows = this.listRecordsStmt.all({
      view,
      limit: Math.max(1, Math.min(2000, Math.floor(limit))),
    }) as CitadelRecordRow[];
    return rows.map(mapCitadelRecord);
  }

  public getRecord(citadelId: string): CitadelRecord {
    const row = this.getRecordStmt.get(citadelId) as CitadelRecordRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Citadel", id: citadelId });
    }
    return mapCitadelRecord(row);
  }

  public findRecord(citadelId: string): CitadelRecord | undefined {
    const row = this.getRecordStmt.get(citadelId) as CitadelRecordRow | undefined;
    return row ? mapCitadelRecord(row) : undefined;
  }

  public findRecordBySlug(slug: string): CitadelRecord | undefined {
    const row = this.getRecordBySlugStmt.get(normalizeSlug(slug)) as CitadelRecordRow | undefined;
    return row ? mapCitadelRecord(row) : undefined;
  }

  public createRecord(input: CitadelCreateInput, now = new Date().toISOString()): CitadelRecord {
    const name = sanitizeRequired(input.name, "name");
    const slug = normalizeSlug(input.slug ?? input.name);
    const citadelId = slug;
    this.assertRecordSlugAvailable(slug);
    if (this.findRecord(citadelId)) {
      throw new ConflictError({ code: "ALREADY_EXISTS", message: `Citadel id "${citadelId}" is already in use` });
    }
    this.insertRecordStmt.run({
      citadelId,
      name,
      description: sanitizeOptional(input.description),
      slug,
      kind: input.kind ?? "custom",
      defaultWorkspaceId: sanitizeOptional(input.defaultWorkspaceId),
      createdAt: now,
      updatedAt: now,
    });
    return this.getRecord(citadelId);
  }

  public updateRecord(citadelId: string, input: CitadelUpdateInput, now = new Date().toISOString()): CitadelRecord {
    const current = this.getRecord(citadelId);
    const nextName = input.name !== undefined ? sanitizeRequired(input.name, "name") : current.name;
    const nextSlug =
      input.slug !== undefined
        ? normalizeSlug(input.slug)
        : input.name !== undefined
          ? normalizeSlug(input.name)
          : current.slug;
    this.assertRecordSlugAvailable(nextSlug, citadelId);
    this.updateRecordStmt.run({
      citadelId,
      name: nextName,
      description:
        input.description !== undefined ? sanitizeOptional(input.description) : (current.description ?? null),
      slug: nextSlug,
      kind: input.kind ?? current.kind,
      defaultWorkspaceId:
        input.defaultWorkspaceId !== undefined
          ? sanitizeOptional(input.defaultWorkspaceId)
          : (current.defaultWorkspaceId ?? null),
      updatedAt: now,
    });
    return this.getRecord(citadelId);
  }

  public archiveRecord(citadelId: string, now = new Date().toISOString()): CitadelRecord {
    const current = this.getRecord(citadelId);
    if (current.lifecycleStatus === "archived") {
      return current;
    }
    this.archiveRecordStmt.run({ citadelId, archivedAt: now, updatedAt: now });
    return this.getRecord(citadelId);
  }

  public restoreRecord(citadelId: string, now = new Date().toISOString()): CitadelRecord {
    const current = this.getRecord(citadelId);
    if (current.lifecycleStatus === "active") {
      return current;
    }
    this.restoreRecordStmt.run({ citadelId, updatedAt: now });
    return this.getRecord(citadelId);
  }

  public upsertCharter(input: CitadelCharterInput): CitadelCharter {
    const now = new Date().toISOString();
    this.upsertCharterStmt.run({
      citadelId: input.citadelId,
      purpose: input.purpose,
      kind: input.kind,
      goalsJson: JSON.stringify(input.goals ?? []),
      boundariesJson: JSON.stringify(input.boundaries ?? []),
      successDefinitionJson: JSON.stringify(input.successDefinition ?? []),
      defaultChamberId: input.defaultChamberId ?? null,
      riskPosture: input.riskPosture ?? "balanced",
      modelPolicyDefault: input.modelPolicyDefault ?? "hybrid_guarded",
      now,
    });
    const charter = this.getCharter(input.citadelId);
    if (!charter) {
      throw new Error(`Failed to persist charter for citadel ${input.citadelId}`);
    }
    return charter;
  }

  public getCharter(citadelId: string): CitadelCharter | undefined {
    const row = this.getCharterStmt.get({ citadelId }) as CharterRow | undefined;
    return row ? mapCharter(row) : undefined;
  }

  public createChamber(input: CitadelChamberInput): CitadelChamber {
    const chamberId = randomUUID();
    const now = new Date().toISOString();
    this.createChamberStmt.run({
      chamberId,
      citadelId: input.citadelId,
      name: input.name,
      sensitivity: input.sensitivity ?? "private",
      sealed: input.sealed ? 1 : 0,
      now,
    });
    const chamber = this.getChamber(chamberId);
    if (!chamber) {
      throw new Error(`Failed to persist chamber ${chamberId} for citadel ${input.citadelId}`);
    }
    return chamber;
  }

  public getChamber(chamberId: string): CitadelChamber | undefined {
    const row = this.getChamberStmt.get({ chamberId }) as ChamberRow | undefined;
    return row ? mapChamber(row) : undefined;
  }

  public listChambers(citadelId: string): CitadelChamber[] {
    const rows = this.listChambersStmt.all({ citadelId }) as ChamberRow[];
    return rows.map(mapChamber);
  }

  public getCitadel(citadelId: string): Citadel | undefined {
    const charter = this.getCharter(citadelId);
    if (!charter) {
      return undefined;
    }
    return {
      citadelId,
      record: this.findRecord(citadelId),
      charter,
      chambers: this.listChambers(citadelId),
    };
  }

  /** Assign an existing agent (by id) to this Citadel's Council. Idempotent. */
  public assignAgent(input: CitadelCouncilAssignmentInput): CitadelCouncilAssignment {
    const now = new Date().toISOString();
    this.assignAgentStmt.run({
      assignmentId: randomUUID(),
      citadelId: input.citadelId,
      agentId: input.agentId,
      now,
    });
    const row = this.getAssignmentByPairStmt.get({
      citadelId: input.citadelId,
      agentId: input.agentId,
    }) as CouncilAssignmentRow | undefined;
    if (!row) {
      throw new Error(`Failed to assign agent ${input.agentId} to citadel ${input.citadelId}`);
    }
    return mapCouncilAssignment(row);
  }

  public listCouncilAssignments(citadelId: string): CitadelCouncilAssignment[] {
    const rows = this.listAssignmentsStmt.all({ citadelId }) as CouncilAssignmentRow[];
    return rows.map(mapCouncilAssignment);
  }

  public unassignAgent(citadelId: string, agentId: string): boolean {
    const result = this.unassignAgentStmt.run({ citadelId, agentId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  public addWard(input: CitadelWardInput): CitadelWardRecord {
    const wardId = randomUUID();
    const now = new Date().toISOString();
    this.addWardStmt.run({
      wardId,
      citadelId: input.citadelId,
      name: input.name,
      actionPattern: input.actionPattern,
      effect: input.effect,
      now,
    });
    const row = this.getWardStmt.get({ wardId }) as WardRow | undefined;
    if (!row) {
      throw new Error(`Failed to persist ward ${wardId} for citadel ${input.citadelId}`);
    }
    return mapWard(row);
  }

  public listWards(citadelId: string): CitadelWardRecord[] {
    const rows = this.listWardsStmt.all({ citadelId }) as WardRow[];
    return rows.map(mapWard);
  }

  public removeWard(citadelId: string, wardId: string): boolean {
    const result = this.deleteWardStmt.run({ citadelId, wardId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  public storeVaultSecret(input: CitadelVaultSecretInput): CitadelVaultSecretRecord {
    const secretId = randomUUID();
    const now = new Date().toISOString();
    this.storeVaultSecretStmt.run({
      secretId,
      citadelId: input.citadelId,
      secretName: input.secretName,
      sealedValueJson: JSON.stringify(input.sealedValue),
      now,
    });
    const row = this.getVaultSecretByNameStmt.get({
      citadelId: input.citadelId,
      secretName: input.secretName,
    }) as VaultSecretRow | undefined;
    if (!row) {
      throw new Error(`Failed to persist vault secret ${input.secretName} for citadel ${input.citadelId}`);
    }
    return mapVaultSecret(row);
  }

  public getVaultSecret(citadelId: string, secretId: string): CitadelVaultSecretRecord | undefined {
    const row = this.getVaultSecretStmt.get({ citadelId, secretId }) as VaultSecretRow | undefined;
    return row ? mapVaultSecret(row) : undefined;
  }

  public listVaultSecrets(citadelId: string): CitadelVaultSecretRecord[] {
    const rows = this.listVaultSecretsStmt.all({ citadelId }) as VaultSecretRow[];
    return rows.map(mapVaultSecret);
  }

  public deleteVaultSecret(citadelId: string, secretId: string): boolean {
    const result = this.deleteVaultSecretStmt.run({ citadelId, secretId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  public createPassage(input: CitadelPassageInput): CitadelPassage {
    const passageId = randomUUID();
    const now = new Date().toISOString();
    this.createPassageStmt.run({
      passageId,
      sourceCitadelId: input.sourceCitadelId,
      sourceChamberId: input.sourceChamberId ?? null,
      destinationCitadelId: input.destinationCitadelId,
      allowedFieldsJson: JSON.stringify(input.allowedFields ?? []),
      expiresAt: input.expiresAt ?? null,
      now,
    });
    const row = this.getPassageStmt.get({ passageId }) as PassageRow | undefined;
    if (!row) {
      throw new Error(`Failed to persist passage ${passageId} from citadel ${input.sourceCitadelId}`);
    }
    return mapPassage(row);
  }

  /** List Passages originating FROM this Citadel. */
  public listPassages(sourceCitadelId: string): CitadelPassage[] {
    const rows = this.listPassagesStmt.all({ sourceCitadelId }) as PassageRow[];
    return rows.map(mapPassage);
  }

  public removePassage(sourceCitadelId: string, passageId: string): boolean {
    const result = this.deletePassageStmt.run({ sourceCitadelId, passageId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  /** Add a member to a Citadel, or update their role if already a member. */
  public upsertMember(input: CitadelMemberInput): CitadelMember {
    const now = new Date().toISOString();
    this.upsertMemberStmt.run({
      memberId: randomUUID(),
      citadelId: input.citadelId,
      subjectId: input.subjectId,
      role: input.role,
      now,
    });
    const row = this.getMemberByPairStmt.get({
      citadelId: input.citadelId,
      subjectId: input.subjectId,
    }) as MemberRow | undefined;
    if (!row) {
      throw new Error(`Failed to persist member ${input.subjectId} for citadel ${input.citadelId}`);
    }
    return mapMember(row);
  }

  public listMembers(citadelId: string): CitadelMember[] {
    const rows = this.listMembersStmt.all({ citadelId }) as MemberRow[];
    return rows.map(mapMember);
  }

  public removeMember(citadelId: string, subjectId: string): boolean {
    const result = this.deleteMemberStmt.run({ citadelId, subjectId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  public createMasonSession(): MasonSession {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    this.createMasonSessionStmt.run({ sessionId, now });
    const session = this.getMasonSession(sessionId);
    if (!session) {
      throw new Error(`Failed to create mason session ${sessionId}`);
    }
    return session;
  }

  public getMasonSession(sessionId: string): MasonSession | undefined {
    const row = this.getMasonSessionStmt.get({ sessionId }) as MasonSessionRow | undefined;
    return row ? mapMasonSession(row) : undefined;
  }

  /** Merge a partial answer patch into the session's accumulated answers. */
  public updateMasonSessionAnswers(sessionId: string, patch: Partial<MasonAnswers>): MasonSession | undefined {
    const existing = this.getMasonSession(sessionId);
    if (!existing) {
      return undefined;
    }
    const merged = { ...existing.answers, ...patch };
    const now = new Date().toISOString();
    this.updateMasonSessionStmt.run({ sessionId, answersJson: JSON.stringify(merged), status: existing.status, now });
    return this.getMasonSession(sessionId);
  }

  public setMasonSessionStatus(sessionId: string, status: MasonSessionStatus): MasonSession | undefined {
    const existing = this.getMasonSession(sessionId);
    if (!existing) {
      return undefined;
    }
    const now = new Date().toISOString();
    this.updateMasonSessionStmt.run({ sessionId, answersJson: JSON.stringify(existing.answers), status, now });
    return this.getMasonSession(sessionId);
  }

  /** Record a Gatehouse integration grant (capabilities only — no secrets). */
  public addIntegrationGrant(input: CitadelIntegrationGrantInput): CitadelIntegrationGrant {
    const grantId = randomUUID();
    const now = new Date().toISOString();
    this.addIntegrationGrantStmt.run({
      grantId,
      citadelId: input.citadelId,
      provider: input.provider,
      account: input.account ?? null,
      capabilitiesJson: JSON.stringify(input.capabilities ?? []),
      mode: input.mode,
      expiresAt: input.expiresAt ?? null,
      now,
    });
    const row = this.getIntegrationGrantStmt.get({ grantId }) as IntegrationGrantRow | undefined;
    if (!row) {
      throw new Error(`Failed to persist integration grant ${grantId} for citadel ${input.citadelId}`);
    }
    return mapIntegrationGrant(row);
  }

  public listIntegrationGrants(citadelId: string): CitadelIntegrationGrant[] {
    const rows = this.listIntegrationGrantsStmt.all({ citadelId }) as IntegrationGrantRow[];
    return rows.map(mapIntegrationGrant);
  }

  public removeIntegrationGrant(citadelId: string, grantId: string): boolean {
    const result = this.deleteIntegrationGrantStmt.run({ citadelId, grantId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  private assertRecordSlugAvailable(slug: string, excludingCitadelId?: string): void {
    const existing = this.findRecordBySlug(slug);
    if (existing && existing.citadelId !== excludingCitadelId) {
      throw new ConflictError({ code: "ALREADY_EXISTS", message: `Citadel slug "${slug}" is already in use` });
    }
  }
}

function mapCitadelRecord(row: CitadelRecordRow): CitadelRecord {
  return {
    citadelId: row.citadel_id,
    name: row.name,
    description: row.description ?? undefined,
    slug: row.slug,
    kind: row.kind as CitadelKind,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
    defaultWorkspaceId: row.default_workspace_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCharter(row: CharterRow): CitadelCharter {
  return {
    citadelId: row.citadel_id,
    purpose: row.purpose,
    kind: row.kind as CitadelKind,
    goals: safeJsonParse<string[]>(row.goals_json, []),
    boundaries: safeJsonParse<string[]>(row.boundaries_json, []),
    successDefinition: safeJsonParse<string[]>(row.success_definition_json, []),
    defaultChamberId: row.default_chamber_id ?? undefined,
    riskPosture: row.risk_posture as CitadelRiskPosture,
    modelPolicyDefault: row.model_policy_default as CitadelModelPolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChamber(row: ChamberRow): CitadelChamber {
  return {
    chamberId: row.chamber_id,
    citadelId: row.citadel_id,
    name: row.name,
    sensitivity: row.sensitivity as ChamberSensitivity,
    sealed: row.sealed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCouncilAssignment(row: CouncilAssignmentRow): CitadelCouncilAssignment {
  return {
    assignmentId: row.assignment_id,
    citadelId: row.citadel_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

function mapWard(row: WardRow): CitadelWardRecord {
  return {
    wardId: row.ward_id,
    citadelId: row.citadel_id,
    name: row.name,
    actionPattern: row.action_pattern,
    effect: row.effect as WardEffect,
    createdAt: row.created_at,
  };
}

function mapVaultSecret(row: VaultSecretRow): CitadelVaultSecretRecord {
  return {
    secretId: row.secret_id,
    citadelId: row.citadel_id,
    secretName: row.secret_name,
    sealedValue: safeJsonParse<SealedValue>(row.sealed_value_json, { iv: "", ciphertext: "", tag: "" }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPassage(row: PassageRow): CitadelPassage {
  return {
    passageId: row.passage_id,
    sourceCitadelId: row.source_citadel_id,
    sourceChamberId: row.source_chamber_id ?? undefined,
    destinationCitadelId: row.destination_citadel_id,
    allowedFields: safeJsonParse<string[]>(row.allowed_fields_json, []),
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
  };
}

function mapMember(row: MemberRow): CitadelMember {
  return {
    memberId: row.member_id,
    citadelId: row.citadel_id,
    subjectId: row.subject_id,
    role: row.role as CitadelRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMasonSession(row: MasonSessionRow): MasonSession {
  return {
    sessionId: row.session_id,
    answers: safeJsonParse<Partial<MasonAnswers>>(row.answers_json, {}),
    status: row.status as MasonSessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIntegrationGrant(row: IntegrationGrantRow): CitadelIntegrationGrant {
  return {
    grantId: row.grant_id,
    citadelId: row.citadel_id,
    provider: row.provider,
    account: row.account ?? undefined,
    capabilities: safeJsonParse<string[]>(row.capabilities_json, []),
    mode: row.mode as CitadelIntegrationMode,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
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
