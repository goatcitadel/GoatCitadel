import type {
  Citadel,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCouncilAssignment,
  CitadelCouncilAssignmentInput,
  ChamberSensitivity,
  CitadelKind,
  CitadelModelPolicy,
  CitadelRiskPosture,
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
