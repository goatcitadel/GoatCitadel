import type {
  Citadel,
  CitadelArchiveItem,
  CitadelArchiveItemInput,
  CitadelArchiveItemKind,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCouncilMember,
  CitadelCouncilMemberInput,
  CitadelMission,
  CitadelMissionInput,
  CitadelMissionState,
  ChamberSensitivity,
  CouncilArchetype,
  CitadelKind,
  CitadelModelPolicy,
  CitadelRiskPosture,
  WorkMode,
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

interface CouncilMemberRow {
  member_id: string;
  citadel_id: string;
  name: string;
  archetype: string;
  role: string;
  created_at: string;
  updated_at: string;
}

interface MissionRow {
  mission_id: string;
  citadel_id: string;
  title: string;
  objective: string;
  mode: string;
  state: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ArchiveItemRow {
  item_id: string;
  citadel_id: string;
  chamber_id: string | null;
  kind: string;
  title: string;
  body: string;
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
  private readonly addCouncilMemberStmt;
  private readonly getCouncilMemberStmt;
  private readonly listCouncilMembersStmt;
  private readonly deleteCouncilMemberStmt;
  private readonly createMissionStmt;
  private readonly getMissionStmt;
  private readonly listMissionsStmt;
  private readonly updateMissionStateStmt;
  private readonly addArchiveItemStmt;
  private readonly getArchiveItemStmt;
  private readonly listArchiveItemsStmt;
  private readonly listArchiveItemsByChamberStmt;
  private readonly deleteArchiveItemStmt;

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
    this.addCouncilMemberStmt = db.prepare(`
      INSERT INTO citadel_council_members (
        member_id, citadel_id, name, archetype, role, created_at, updated_at
      ) VALUES (
        @memberId, @citadelId, @name, @archetype, @role, @now, @now
      )
    `);
    this.getCouncilMemberStmt = db.prepare("SELECT * FROM citadel_council_members WHERE member_id = @memberId");
    this.listCouncilMembersStmt = db.prepare(
      "SELECT * FROM citadel_council_members WHERE citadel_id = @citadelId ORDER BY name ASC, member_id ASC",
    );
    this.deleteCouncilMemberStmt = db.prepare("DELETE FROM citadel_council_members WHERE member_id = @memberId");
    this.createMissionStmt = db.prepare(`
      INSERT INTO citadel_missions (
        mission_id, citadel_id, title, objective, mode, state, created_at, updated_at, completed_at
      ) VALUES (
        @missionId, @citadelId, @title, @objective, @mode, 'draft', @now, @now, NULL
      )
    `);
    this.getMissionStmt = db.prepare("SELECT * FROM citadel_missions WHERE mission_id = @missionId");
    this.listMissionsStmt = db.prepare(
      "SELECT * FROM citadel_missions WHERE citadel_id = @citadelId ORDER BY updated_at DESC, mission_id ASC",
    );
    this.updateMissionStateStmt = db.prepare(`
      UPDATE citadel_missions SET
        state = @state,
        updated_at = @now,
        completed_at = @completedAt
      WHERE mission_id = @missionId
    `);
    this.addArchiveItemStmt = db.prepare(`
      INSERT INTO citadel_archive_items (
        item_id, citadel_id, chamber_id, kind, title, body, created_at, updated_at
      ) VALUES (
        @itemId, @citadelId, @chamberId, @kind, @title, @body, @now, @now
      )
    `);
    this.getArchiveItemStmt = db.prepare("SELECT * FROM citadel_archive_items WHERE item_id = @itemId");
    this.listArchiveItemsStmt = db.prepare(
      "SELECT * FROM citadel_archive_items WHERE citadel_id = @citadelId ORDER BY updated_at DESC, item_id ASC",
    );
    this.listArchiveItemsByChamberStmt = db.prepare(
      "SELECT * FROM citadel_archive_items WHERE citadel_id = @citadelId AND chamber_id = @chamberId ORDER BY updated_at DESC, item_id ASC",
    );
    this.deleteArchiveItemStmt = db.prepare("DELETE FROM citadel_archive_items WHERE item_id = @itemId");
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

  public addCouncilMember(input: CitadelCouncilMemberInput): CitadelCouncilMember {
    const memberId = randomUUID();
    const now = new Date().toISOString();
    this.addCouncilMemberStmt.run({
      memberId,
      citadelId: input.citadelId,
      name: input.name,
      archetype: input.archetype,
      role: input.role,
      now,
    });
    const member = this.getCouncilMember(memberId);
    if (!member) {
      throw new Error(`Failed to persist council member ${memberId} for citadel ${input.citadelId}`);
    }
    return member;
  }

  public getCouncilMember(memberId: string): CitadelCouncilMember | undefined {
    const row = this.getCouncilMemberStmt.get({ memberId }) as CouncilMemberRow | undefined;
    return row ? mapCouncilMember(row) : undefined;
  }

  public listCouncilMembers(citadelId: string): CitadelCouncilMember[] {
    const rows = this.listCouncilMembersStmt.all({ citadelId }) as CouncilMemberRow[];
    return rows.map(mapCouncilMember);
  }

  public removeCouncilMember(memberId: string): boolean {
    const result = this.deleteCouncilMemberStmt.run({ memberId });
    return Number((result as { changes?: number }).changes ?? 0) > 0;
  }

  public createMission(input: CitadelMissionInput): CitadelMission {
    const missionId = randomUUID();
    const now = new Date().toISOString();
    this.createMissionStmt.run({
      missionId,
      citadelId: input.citadelId,
      title: input.title,
      objective: input.objective,
      mode: input.mode ?? "ask",
      now,
    });
    const mission = this.getMission(missionId);
    if (!mission) {
      throw new Error(`Failed to persist mission ${missionId} for citadel ${input.citadelId}`);
    }
    return mission;
  }

  public getMission(missionId: string): CitadelMission | undefined {
    const row = this.getMissionStmt.get({ missionId }) as MissionRow | undefined;
    return row ? mapMission(row) : undefined;
  }

  public listMissions(citadelId: string): CitadelMission[] {
    const rows = this.listMissionsStmt.all({ citadelId }) as MissionRow[];
    return rows.map(mapMission);
  }

  public updateMissionState(missionId: string, state: CitadelMissionState): CitadelMission | undefined {
    const existing = this.getMission(missionId);
    if (!existing) {
      return undefined;
    }
    const now = new Date().toISOString();
    const completedAt = state === "completed" ? now : (existing.completedAt ?? null);
    this.updateMissionStateStmt.run({ missionId, state, now, completedAt });
    return this.getMission(missionId);
  }

  public addArchiveItem(input: CitadelArchiveItemInput): CitadelArchiveItem {
    const itemId = randomUUID();
    const now = new Date().toISOString();
    this.addArchiveItemStmt.run({
      itemId,
      citadelId: input.citadelId,
      chamberId: input.chamberId ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body,
      now,
    });
    const item = this.getArchiveItem(itemId);
    if (!item) {
      throw new Error(`Failed to persist archive item ${itemId} for citadel ${input.citadelId}`);
    }
    return item;
  }

  public getArchiveItem(itemId: string): CitadelArchiveItem | undefined {
    const row = this.getArchiveItemStmt.get({ itemId }) as ArchiveItemRow | undefined;
    return row ? mapArchiveItem(row) : undefined;
  }

  public listArchiveItems(citadelId: string, chamberId?: string): CitadelArchiveItem[] {
    const rows = (
      chamberId
        ? this.listArchiveItemsByChamberStmt.all({ citadelId, chamberId })
        : this.listArchiveItemsStmt.all({ citadelId })
    ) as ArchiveItemRow[];
    return rows.map(mapArchiveItem);
  }

  public removeArchiveItem(itemId: string): boolean {
    const result = this.deleteArchiveItemStmt.run({ itemId });
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

function mapCouncilMember(row: CouncilMemberRow): CitadelCouncilMember {
  return {
    memberId: row.member_id,
    citadelId: row.citadel_id,
    name: row.name,
    archetype: row.archetype as CouncilArchetype,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMission(row: MissionRow): CitadelMission {
  return {
    missionId: row.mission_id,
    citadelId: row.citadel_id,
    title: row.title,
    objective: row.objective,
    mode: row.mode as WorkMode,
    state: row.state as CitadelMissionState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function mapArchiveItem(row: ArchiveItemRow): CitadelArchiveItem {
  return {
    itemId: row.item_id,
    citadelId: row.citadel_id,
    chamberId: row.chamber_id ?? undefined,
    kind: row.kind as CitadelArchiveItemKind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
