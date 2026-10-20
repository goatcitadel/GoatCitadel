import type {
  Citadel,
  CitadelAccessMutation,
  CitadelAccessSnapshot,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCreateInput,
  CitadelCouncilAssignment,
  CitadelCouncilAssignmentInput,
  CitadelIntegrationGrant,
  CitadelIntegrationGrantInput,
  CitadelLifecycleStatus,
  CitadelMember,
  CitadelMemberInput,
  CitadelPassage,
  CitadelPassageInput,
  CitadelRecord,
  CitadelStructureMutation,
  CitadelStructureSnapshot,
  CitadelUpdateInput,
  CitadelVaultMutation,
  CitadelVaultSnapshot,
  CitadelVaultSecretInput,
  CitadelVaultSecretRecord,
  CitadelWardInput,
  CitadelWardRecord,
  MasonAnswers,
  MasonSession,
  MasonSessionStatus,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { CitadelVaultRepository } from "./citadel-vault-repo.js";
import { CitadelVaultKeyRepository } from "./citadel-vault-key-repo.js";
import { applyCitadelAccessChange } from "./citadel-access-change.js";
import {
  mapCitadelRecord,
  mapCharter,
  mapChamber,
  mapCouncilAssignment,
  mapWard,
  mapPassage,
  mapMember,
  mapMasonSession,
  mapIntegrationGrant,
  type CharterRow,
  type CitadelRecordRow,
  type ChamberRow,
  type CouncilAssignmentRow,
  type WardRow,
  type PassageRow,
  type MemberRow,
  type MasonSessionRow,
  type IntegrationGrantRow,
} from "./citadel-repo-rows.js";

/**
 * Persistence for Citadel identity: a Charter (1:1 with a workspace/citadel) and
 * its Chambers. A Citadel is a workspace that has a Charter.
 */
export class CitadelRepository {
  private readonly listRecordsStmt;
  private readonly getRecordStmt;
  private readonly getRecordForUpdateStmt;
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
  private readonly vault: CitadelVaultRepository;
  /** Ciphertext-only Vault key hierarchy: wrapped data keys, key state and the rotation ledger. */
  public readonly vaultKeys: CitadelVaultKeyRepository;
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
      SELECT
        citadel_records.*,
        EXISTS (
          SELECT 1
          FROM citadel_charters
          WHERE citadel_charters.citadel_id = citadel_records.citadel_id
        ) AS has_charter
      FROM citadel_records
      WHERE (
        @view = 'all'
        OR (@view = 'active' AND lifecycle_status = 'active')
        OR (@view = 'archived' AND lifecycle_status = 'archived')
      )
      ORDER BY updated_at DESC, citadel_id ASC
      LIMIT @limit
    `);
    this.getRecordStmt = db.prepare("SELECT * FROM citadel_records WHERE citadel_id = ?");
    this.getRecordForUpdateStmt = db.prepare(
      `SELECT * FROM citadel_records WHERE citadel_id = ?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    );
    this.getRecordBySlugStmt = db.prepare("SELECT * FROM citadel_records WHERE slug = ?");
    this.insertRecordStmt = db.prepare(`
      INSERT INTO citadel_records (
        citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
        default_workspace_id, created_at, updated_at
      ) VALUES (
        @citadelId, @name, @description, @slug, @kind, 'active', NULL,
        @defaultWorkspaceId, @createdAt, @updatedAt
      )
      ON CONFLICT DO NOTHING
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
    this.vaultKeys = new CitadelVaultKeyRepository(db, {
      withLock: (citadelId, action) => this.withStructureLock(citadelId, action),
    });
    this.vault = new CitadelVaultRepository(db, {
      withLock: (citadelId, action) => this.withStructureLock(citadelId, action),
      listChambers: (citadelId) => this.listChambers(citadelId),
      keys: () => this.vaultKeys,
      readRecord: (citadelId) => {
        const row = this.getRecordForUpdateStmt.get(citadelId) as CitadelRecordRow | undefined;
        return row ? mapCitadelRecord(row) : undefined;
      },
    });
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
    return this.withStructureLock(citadelId, () => {
      this.assertRecordSlugAvailable(slug);
      const inserted = this.insertRecordStmt.run({
        citadelId,
        name,
        description: sanitizeOptional(input.description),
        slug,
        kind: input.kind ?? "custom",
        defaultWorkspaceId: sanitizeOptional(input.defaultWorkspaceId),
        createdAt: now,
        updatedAt: now,
      });
      if (inserted.changes !== 1) {
        throw new ConflictError({ code: "ALREADY_EXISTS", message: `Citadel id or slug "${slug}" is already in use` });
      }
      return this.getRecord(citadelId);
    });
  }

  public updateRecord(citadelId: string, input: CitadelUpdateInput, now = new Date().toISOString()): CitadelRecord {
    try {
      return this.withReviewedRecord(citadelId, input.expectedRevision, now, (current, updatedAt) => {
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
          updatedAt,
        });
        return this.getRecord(citadelId);
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE")
      ) {
        throw new ConflictError({ code: "ALREADY_EXISTS", message: "That Citadel slug is already in use." });
      }
      throw error;
    }
  }

  public archiveRecord(citadelId: string, expectedRevision: string, now = new Date().toISOString()): CitadelRecord {
    return this.withReviewedRecord(citadelId, expectedRevision, now, (current, updatedAt) => {
      if (current.lifecycleStatus === "archived") return current;
      this.archiveRecordStmt.run({ citadelId, archivedAt: updatedAt, updatedAt });
      return this.getRecord(citadelId);
    });
  }

  public restoreRecord(citadelId: string, expectedRevision: string, now = new Date().toISOString()): CitadelRecord {
    return this.withReviewedRecord(citadelId, expectedRevision, now, (current, updatedAt) => {
      if (current.lifecycleStatus === "active") return current;
      this.restoreRecordStmt.run({ citadelId, updatedAt });
      return this.getRecord(citadelId);
    });
  }

  private withReviewedRecord<T>(
    citadelId: string,
    expectedRevision: string,
    now: string,
    write: (current: CitadelRecord, updatedAt: string) => T,
  ): T {
    if (!/^[a-f0-9]{64}$/.test(expectedRevision ?? "")) {
      throw new ValidationError({
        message: "Review the Citadel before changing it. An expected revision is required.",
      });
    }
    return this.withStructureLock(citadelId, () => {
      const row = this.getRecordForUpdateStmt.get(citadelId) as CitadelRecordRow | undefined;
      if (!row) throw new NotFoundError({ entity: "Citadel", id: citadelId });
      const current = mapCitadelRecord(row);
      if (current.revision !== expectedRevision) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "The Citadel changed. Review its current profile before applying your change.",
          details: { reason: "CITADEL_RECORD_REVISION_CONFLICT" },
        });
      }
      const previous = Date.parse(current.updatedAt);
      const updatedAt = new Date(Math.max(Date.parse(now), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
      return write(current, updatedAt);
    });
  }

  public upsertCharter(input: CitadelCharterInput): CitadelCharter {
    return this.withStructureLock(input.citadelId, () => this.writeCharter(input));
  }

  private writeCharter(input: CitadelCharterInput): CitadelCharter {
    const previous = Date.parse(this.getCharter(input.citadelId)?.updatedAt ?? "");
    const now = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
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
    return this.withStructureLock(input.citadelId, () => this.insertChamber(input));
  }

  private insertChamber(input: CitadelChamberInput): CitadelChamber {
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
    const snapshot = this.getStructureSnapshot(citadelId);
    if (!snapshot.charter) return undefined;
    return {
      citadelId,
      record: snapshot.record,
      charter: snapshot.charter,
      chambers: snapshot.chambers,
    };
  }

  public getStructureSnapshot(citadelId: string): CitadelStructureSnapshot {
    return this.withStructureLock(citadelId, () => this.readStructureSnapshot(citadelId));
  }

  public mutateStructure(input: CitadelStructureMutation): CitadelStructureSnapshot {
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "")) {
      throw new ValidationError({
        message: "Review the current Charter and Chambers before changing them. An expected revision is required.",
      });
    }
    return this.withStructureLock(input.citadelId, () => {
      const current = this.readStructureSnapshot(input.citadelId);
      if (current.revision !== input.expectedRevision) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "The Citadel changed. Review its current Charter and Chambers before applying your change.",
          details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" },
        });
      }
      if (current.record?.lifecycleStatus === "archived") {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Restore this Citadel before changing its Charter or Chambers.",
          details: { reason: "CITADEL_ARCHIVED" },
        });
      }
      const change = input.change;
      if (change.type === "charter" || change.type === "setup") {
        if (
          change.charter.defaultChamberId &&
          this.getChamber(change.charter.defaultChamberId)?.citadelId !== input.citadelId
        ) {
          throw new ValidationError({ message: "The default Chamber must belong to this Citadel." });
        }
        this.writeCharter({ ...change.charter, citadelId: input.citadelId });
        if (change.type === "setup") {
          for (const chamber of change.chambers) this.insertChamber({ ...chamber, citadelId: input.citadelId });
        }
      } else if (change.type === "chamber") {
        this.insertChamber({ ...change.chamber, citadelId: input.citadelId });
      } else {
        throw new ValidationError({ message: "Unsupported Citadel structure change." });
      }
      // Capture the acknowledgement while this transaction still owns the lock.
      return this.readStructureSnapshot(input.citadelId);
    });
  }

  private readStructureSnapshot(citadelId: string): CitadelStructureSnapshot {
    const row = this.getRecordForUpdateStmt.get(citadelId) as CitadelRecordRow | undefined;
    const record = row ? mapCitadelRecord(row) : undefined;
    const charter = this.getCharter(citadelId) ?? null;
    const chambers = this.listChambers(citadelId);
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: "citadel.structure.v1",
          citadelId,
          recordRevision: record?.revision ?? null,
          charter,
          chambers,
        }),
      )
      .digest("hex");
    return { citadelId, revision, record, charter, chambers };
  }

  private withStructureLock<T>(citadelId: string, action: () => T): T {
    return this.db.transaction("immediate", () => {
      if (this.db.dialect === "postgres") {
        // The advisory lock also protects empty/legacy Citadels with no profile row.
        this.db
          .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 541)) AS locked")
          .get({ lockKey: `citadel-structure:${citadelId}` });
      }
      return action();
    });
  }

  public getAccessSnapshot(citadelId: string): CitadelAccessSnapshot {
    return this.withStructureLock(citadelId, () => this.readAccessSnapshot(citadelId));
  }

  public mutateAccess(input: CitadelAccessMutation): CitadelAccessSnapshot {
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "")) {
      throw new ValidationError({
        message: "Review the Citadel access rules before changing them. An expected revision is required.",
      });
    }
    return this.withStructureLock(input.citadelId, () => {
      const current = this.readAccessSnapshot(input.citadelId);
      if (current.revision !== input.expectedRevision) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "The Citadel access rules changed. Review the current rules before applying your change.",
          details: { reason: "CITADEL_ACCESS_REVISION_CONFLICT" },
        });
      }
      if (current.structure.record?.lifecycleStatus === "archived") {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Restore this Citadel before changing its access rules.",
          details: { reason: "CITADEL_ARCHIVED" },
        });
      }
      const { citadelId, change } = input;
      applyCitadelAccessChange(this, citadelId, change);
      return this.readAccessSnapshot(citadelId);
    });
  }

  private readAccessSnapshot(citadelId: string): CitadelAccessSnapshot {
    const generation =
      this.db
        .prepare(
          "SELECT CAST(generation AS TEXT) AS generation FROM citadel_access_revisions WHERE citadel_id = @citadelId",
        )
        .get<{ generation: string }>({ citadelId })?.generation ?? "0";
    const content = {
      citadelId,
      structure: this.readStructureSnapshot(citadelId),
      council: this.listCouncilAssignments(citadelId),
      wards: this.listWards(citadelId),
      passages: this.listPassages(citadelId),
      members: this.listMembers(citadelId),
      integrations: this.listIntegrationGrants(citadelId),
    };
    const revision = createHash("sha256")
      .update(JSON.stringify({ schemaVersion: "citadel.access.v1", generation, ...content }))
      .digest("hex");
    return { ...content, revision };
  }

  /** Trusted primitive writers also consume a revision, including same-value writes. */
  private withAccessWrite<T>(citadelId: string, write: () => T): T {
    return this.withStructureLock(citadelId, () => {
      const result = write();
      if (result !== false) {
        this.db
          .prepare(
            `INSERT INTO citadel_access_revisions (citadel_id, generation) VALUES (@citadelId, 1)
          ON CONFLICT (citadel_id) DO UPDATE SET generation = citadel_access_revisions.generation + 1`,
          )
          .run({ citadelId });
      }
      return result;
    });
  }

  /** Assign an existing agent; repeated assignments preserve the row but consume a review. */
  public assignAgent(input: CitadelCouncilAssignmentInput): CitadelCouncilAssignment {
    return this.withAccessWrite(input.citadelId, () => this.writeAssignment(input));
  }

  private writeAssignment(input: CitadelCouncilAssignmentInput): CitadelCouncilAssignment {
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
    return this.withAccessWrite(citadelId, () => this.deleteAssignment(citadelId, agentId));
  }

  private deleteAssignment(citadelId: string, agentId: string): boolean {
    const result = this.unassignAgentStmt.run({ citadelId, agentId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  public addWard(input: CitadelWardInput): CitadelWardRecord {
    return this.withAccessWrite(input.citadelId, () => this.insertWard(input));
  }

  private insertWard(input: CitadelWardInput): CitadelWardRecord {
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
    return this.withAccessWrite(citadelId, () => this.deleteWard(citadelId, wardId));
  }

  private deleteWard(citadelId: string, wardId: string): boolean {
    const result = this.deleteWardStmt.run({ citadelId, wardId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  public getVaultSnapshot(citadelId: string): CitadelVaultSnapshot {
    return this.vault.getSnapshot(citadelId);
  }

  public mutateVault(input: CitadelVaultMutation): CitadelVaultSnapshot {
    return this.vault.mutate(input);
  }

  public storeVaultSecret(input: CitadelVaultSecretInput): CitadelVaultSecretRecord {
    return this.vault.store(input);
  }

  public getVaultSecret(citadelId: string, secretId: string): CitadelVaultSecretRecord | undefined {
    return this.vault.get(citadelId, secretId);
  }

  public listVaultSecrets(citadelId: string): CitadelVaultSecretRecord[] {
    return this.vault.list(citadelId);
  }

  public deleteVaultSecret(citadelId: string, secretId: string): boolean {
    return this.vault.delete(citadelId, secretId);
  }

  public createPassage(input: CitadelPassageInput): CitadelPassage {
    return this.withAccessWrite(input.sourceCitadelId, () => this.insertPassage(input));
  }

  private insertPassage(input: CitadelPassageInput): CitadelPassage {
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
    return this.withAccessWrite(sourceCitadelId, () => this.deletePassage(sourceCitadelId, passageId));
  }

  private deletePassage(sourceCitadelId: string, passageId: string): boolean {
    const result = this.deletePassageStmt.run({ sourceCitadelId, passageId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  /** Add a member to a Citadel, or update their role if already a member. */
  public upsertMember(input: CitadelMemberInput): CitadelMember {
    return this.withAccessWrite(input.citadelId, () => this.writeMember(input));
  }

  private writeMember(input: CitadelMemberInput): CitadelMember {
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
    return this.withAccessWrite(citadelId, () => this.deleteMember(citadelId, subjectId));
  }

  private deleteMember(citadelId: string, subjectId: string): boolean {
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
    return this.withAccessWrite(input.citadelId, () => this.insertIntegrationGrant(input));
  }

  private insertIntegrationGrant(input: CitadelIntegrationGrantInput): CitadelIntegrationGrant {
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
    return this.withAccessWrite(citadelId, () => this.deleteIntegrationGrant(citadelId, grantId));
  }

  private deleteIntegrationGrant(citadelId: string, grantId: string): boolean {
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
