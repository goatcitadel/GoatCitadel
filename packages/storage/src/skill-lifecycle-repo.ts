import type { SkillLifecycleRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface SkillLifecycleRow {
  skill_id: string;
  capability_category: SkillLifecycleRecord["category"];
  lifecycle_state: SkillLifecycleRecord["lifecycleState"];
  trust_label: string;
  review_warning: string | null;
  provenance_json: string | null;
  created_at: string;
  updated_at: string;
}

export class SkillLifecycleRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO skill_lifecycle (
        skill_id, capability_category, lifecycle_state, trust_label, review_warning, provenance_json, created_at, updated_at
      ) VALUES (
        @skillId, @category, @lifecycleState, @trustLabel, @reviewWarning, @provenanceJson, @createdAt, @updatedAt
      )
      ON CONFLICT(skill_id) DO UPDATE SET
        capability_category = excluded.capability_category,
        lifecycle_state = excluded.lifecycle_state,
        trust_label = excluded.trust_label,
        review_warning = excluded.review_warning,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare("SELECT * FROM skill_lifecycle WHERE skill_id = ?");
    this.listStmt = db.prepare("SELECT * FROM skill_lifecycle ORDER BY updated_at DESC, skill_id ASC");
  }

  public upsert(input: SkillLifecycleRecord): SkillLifecycleRecord {
    this.upsertStmt.run({
      skillId: input.skillId,
      category: input.category,
      lifecycleState: input.lifecycleState,
      trustLabel: input.trustLabel,
      reviewWarning: input.reviewWarning ?? null,
      provenanceJson: input.provenance ? JSON.stringify(input.provenance) : null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return this.get(input.skillId);
  }

  public get(skillId: string): SkillLifecycleRecord {
    const row = this.getStmt.get(skillId) as SkillLifecycleRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "skill lifecycle", id: skillId });
    }
    return mapSkillLifecycleRow(row);
  }

  public find(skillId: string): SkillLifecycleRecord | undefined {
    const row = this.getStmt.get(skillId) as SkillLifecycleRow | undefined;
    return row ? mapSkillLifecycleRow(row) : undefined;
  }

  public list(): SkillLifecycleRecord[] {
    return (this.listStmt.all() as unknown as SkillLifecycleRow[]).map(mapSkillLifecycleRow);
  }
}

function mapSkillLifecycleRow(row: SkillLifecycleRow): SkillLifecycleRecord {
  return {
    skillId: row.skill_id,
    category: row.capability_category,
    lifecycleState: row.lifecycle_state,
    trustLabel: row.trust_label,
    reviewWarning: row.review_warning ?? undefined,
    provenance: row.provenance_json ? safeJsonParse(row.provenance_json, undefined) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


