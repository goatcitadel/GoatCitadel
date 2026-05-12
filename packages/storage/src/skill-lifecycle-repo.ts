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

type SkillLifecycleProvenance = NonNullable<SkillLifecycleRecord["provenance"]>;

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
    const row = toSkillLifecycleRow(this.getStmt.get(skillId));
    if (!row) {
      throw new NotFoundError({ entity: "skill lifecycle", id: skillId });
    }
    return mapSkillLifecycleRow(row);
  }

  public find(skillId: string): SkillLifecycleRecord | undefined {
    const row = toSkillLifecycleRow(this.getStmt.get(skillId));
    return row ? mapSkillLifecycleRow(row) : undefined;
  }

  public list(): SkillLifecycleRecord[] {
    return toSkillLifecycleRows(this.listStmt.all()).map(mapSkillLifecycleRow);
  }
}

function mapSkillLifecycleRow(row: SkillLifecycleRow): SkillLifecycleRecord {
  return {
    skillId: row.skill_id,
    category: row.capability_category,
    lifecycleState: row.lifecycle_state,
    trustLabel: row.trust_label,
    reviewWarning: row.review_warning ?? undefined,
    provenance: parseProvenance(row.provenance_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseProvenance(raw: string | null): SkillLifecycleProvenance | undefined {
  const parsed = raw ? safeJsonParse<unknown>(raw, undefined) : undefined;
  if (!isRecord(parsed) || typeof parsed.source !== "string") {
    return undefined;
  }
  const provenance: SkillLifecycleProvenance = {
    source: parsed.source,
  };
  if (typeof parsed.sourceRef === "string") {
    provenance.sourceRef = parsed.sourceRef;
  }
  if (typeof parsed.sourceProvider === "string") {
    provenance.sourceProvider = parsed.sourceProvider;
  }
  return provenance;
}

function toSkillLifecycleRow(value: unknown): SkillLifecycleRow | undefined {
  return isSkillLifecycleRow(value) ? value : undefined;
}

function toSkillLifecycleRows(value: unknown): SkillLifecycleRow[] {
  return Array.isArray(value) ? value.filter(isSkillLifecycleRow) : [];
}

function isSkillLifecycleRow(value: unknown): value is SkillLifecycleRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.skill_id === "string" &&
    isCapabilityCategory(value.capability_category) &&
    isSkillLifecycleState(value.lifecycle_state) &&
    typeof value.trust_label === "string" &&
    (typeof value.review_warning === "string" || value.review_warning === null) &&
    (typeof value.provenance_json === "string" || value.provenance_json === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isCapabilityCategory(value: unknown): value is SkillLifecycleRow["capability_category"] {
  return (
    value === "built_in" ||
    value === "optional" ||
    value === "project_local" ||
    value === "self_generated" ||
    value === "community_imported"
  );
}

function isSkillLifecycleState(value: unknown): value is SkillLifecycleRow["lifecycle_state"] {
  return (
    value === "draft" ||
    value === "candidate" ||
    value === "approved" ||
    value === "trusted" ||
    value === "deprecated" ||
    value === "revoked"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
