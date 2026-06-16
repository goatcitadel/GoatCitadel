import type {
  Citadel,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCouncilAssignment,
  CitadelCouncilAssignmentInput,
  CitadelMember,
  CitadelMemberInput,
  CitadelPassage,
  CitadelPassageInput,
  CitadelRole,
  CitadelWardInput,
  CitadelWardRecord,
  ChamberSensitivity,
  CitadelKind,
  CitadelModelPolicy,
  CitadelRiskPosture,
  WardEffect,
} from "@goatcitadel/contracts";
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

/**
 * Persistence for Citadel identity: a Charter (1:1 with a workspace/citadel) and
 * its Chambers. A Citadel is a workspace that has a Charter.
 */
export class CitadelRepository {
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
  private readonly createPassageStmt;
  private readonly getPassageStmt;
  private readonly listPassagesStmt;
  private readonly deletePassageStmt;
  private readonly upsertMemberStmt;
  private readonly getMemberByPairStmt;
  private readonly listMembersStmt;
  private readonly deleteMemberStmt;

  public constructor(private readonly db: DatabaseClient) {
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
