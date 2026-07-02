import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { OperatorProfileFact, OperatorProfileFactKind, OperatorProfileRecord } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface OperatorProfileRow {
  operator_profile_id: string;
  workspace_id: string;
  summary: string;
  facts_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** Full record fields for an upsert (revision/createdAt are managed by the repo). */
export interface OperatorProfileUpsertInput {
  operatorProfileId: string;
  workspaceId: string;
  summary: string;
  facts: OperatorProfileFact[];
}

/**
 * Result of a snapshot-capturing write. `priorSnapshot` is the record as it
 * existed *before* this write (undefined on first creation) — persist it
 * elsewhere (e.g. as a reversible autonomy snapshot) to enable rollback.
 */
export interface OperatorProfileWriteResult {
  record: OperatorProfileRecord;
  priorSnapshot?: OperatorProfileRecord;
}

const VALID_FACT_KINDS: ReadonlySet<OperatorProfileFactKind> = new Set(["preference", "goal", "constraint", "fact"]);

/**
 * Persistence for the cross-session operator profile (P2-S4b).
 *
 * One row per workspace (unique index on `workspace_id`); `operatorProfileId` is
 * the stable primary key populated onto `WorkspacePrefs.operatorProfileId`.
 *
 * `upsert` bumps `revision` on every successful write — the service uses the
 * revision as the digest cache key, so the frozen snapshot is byte-stable within
 * a session and only changes when the profile actually changes.
 *
 * `upsertCapturingPrior` mirrors `upsert` but returns the pre-write snapshot for
 * reversibility; `restore` writes a captured snapshot back (re-bumping revision).
 */
export class OperatorProfileRepository {
  private readonly getStmt;
  private readonly getByWorkspaceStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM operator_profiles WHERE operator_profile_id = ?");
    this.getByWorkspaceStmt = db.prepare("SELECT * FROM operator_profiles WHERE workspace_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO operator_profiles (
        operator_profile_id, workspace_id, summary, facts_json, revision, created_at, updated_at
      ) VALUES (
        @operatorProfileId, @workspaceId, @summary, @factsJson, @revision, @createdAt, @updatedAt
      )
      ON CONFLICT(operator_profile_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        summary = excluded.summary,
        facts_json = excluded.facts_json,
        revision = operator_profiles.revision + 1,
        updated_at = excluded.updated_at
    `);
  }

  public get(operatorProfileId: string): OperatorProfileRecord | undefined {
    const row = toRow(this.getStmt.get(operatorProfileId));
    return row ? mapRow(row) : undefined;
  }

  public getByWorkspace(workspaceId: string): OperatorProfileRecord | undefined {
    const row = toRow(this.getByWorkspaceStmt.get(workspaceId));
    return row ? mapRow(row) : undefined;
  }

  /**
   * Insert or replace the profile, bumping `revision`. Returns the stored record.
   * Creation starts at revision 1; subsequent writes increment from the current
   * stored revision (regardless of the input's revision field).
   */
  public upsert(input: OperatorProfileUpsertInput, now = new Date().toISOString()): OperatorProfileRecord {
    return this.writeCapturingPrior(input, now).record;
  }

  /** Like {@link upsert}, but also returns the pre-write snapshot for rollback. */
  public upsertCapturingPrior(
    input: OperatorProfileUpsertInput,
    now = new Date().toISOString(),
  ): OperatorProfileWriteResult {
    return this.writeCapturingPrior(input, now);
  }

  /**
   * Restore a previously-captured snapshot. Re-applies summary + facts under the
   * snapshot's identity, bumping revision again (a restore is itself a write).
   * Returns the resulting record.
   */
  public restore(snapshot: OperatorProfileRecord, now = new Date().toISOString()): OperatorProfileRecord {
    return this.writeCapturingPrior(
      {
        operatorProfileId: snapshot.operatorProfileId,
        workspaceId: snapshot.workspaceId,
        summary: snapshot.summary,
        facts: snapshot.facts,
      },
      now,
    ).record;
  }

  private writeCapturingPrior(input: OperatorProfileUpsertInput, now: string): OperatorProfileWriteResult {
    return this.db.transaction("immediate", () => {
      const prior = this.get(input.operatorProfileId);
      const createdAt = prior?.createdAt ?? now;
      this.upsertStmt.run({
        operatorProfileId: input.operatorProfileId,
        workspaceId: input.workspaceId,
        summary: input.summary,
        factsJson: JSON.stringify(sanitizeFacts(input.facts)),
        revision: 1,
        createdAt,
        updatedAt: now,
      });
      const stored = this.get(input.operatorProfileId);
      if (!stored) {
        // Unreachable: the upsert above guarantees a row exists.
        throw new Error(`operator profile upsert did not persist (id=${input.operatorProfileId})`);
      }
      return prior ? { record: stored, priorSnapshot: prior } : { record: stored };
    });
  }
}

function mapRow(row: OperatorProfileRow): OperatorProfileRecord {
  const facts = sanitizeFacts(safeJsonParse<unknown>(row.facts_json ?? "[]", []));
  return {
    operatorProfileId: row.operator_profile_id,
    workspaceId: row.workspace_id,
    summary: typeof row.summary === "string" ? row.summary : "",
    facts,
    revision: Number.isFinite(row.revision) ? Number(row.revision) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeFacts(value: unknown): OperatorProfileFact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: OperatorProfileFact[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const kind = entry.kind;
    const content = entry.content;
    if (typeof content !== "string" || !content.trim() || !isFactKind(kind)) {
      continue;
    }
    const fact: OperatorProfileFact = {
      kind,
      content,
      confidence: clamp01(entry.confidence),
    };
    if (typeof entry.sourceRef === "string" && entry.sourceRef.trim()) {
      fact.sourceRef = entry.sourceRef;
    }
    out.push(fact);
  }
  return out;
}

function isFactKind(value: unknown): value is OperatorProfileFactKind {
  return typeof value === "string" && VALID_FACT_KINDS.has(value as OperatorProfileFactKind);
}

function clamp01(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (num < 0) {
    return 0;
  }
  if (num > 1) {
    return 1;
  }
  return num;
}

function toRow(value: unknown): OperatorProfileRow | undefined {
  return isOperatorProfileRow(value) ? value : undefined;
}

function isOperatorProfileRow(value: unknown): value is OperatorProfileRow {
  return (
    isRecord(value) &&
    typeof value.operator_profile_id === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.summary === "string" &&
    typeof value.facts_json === "string" &&
    typeof value.revision === "number" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Stable id factory for a new operator profile. */
export function createOperatorProfileId(): string {
  return `op_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
