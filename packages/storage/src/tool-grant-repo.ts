import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolGrantScope,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ToolGrantRow {
  grant_id: string;
  tool_pattern: string;
  decision: "allow" | "deny";
  scope: ToolGrantScope;
  scope_ref: string;
  grant_type: "one_time" | "ttl" | "persistent";
  constraints_json: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  uses_remaining: number | null;
}

export class ToolGrantRepository {
  private readonly createStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly revokeStmt;
  private readonly consumeStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.createStmt = db.prepare(`
      INSERT INTO tool_grants (
        grant_id, tool_pattern, decision, scope, scope_ref, grant_type, constraints_json,
        created_by, created_at, expires_at, revoked_at, uses_remaining
      ) VALUES (
        @grantId, @toolPattern, @decision, @scope, @scopeRef, @grantType, @constraintsJson,
        @createdBy, @createdAt, @expiresAt, NULL, @usesRemaining
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM tool_grants WHERE grant_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM tool_grants
      WHERE (@scope IS NULL OR scope = @scope)
        AND (@scopeRef IS NULL OR scope_ref = @scopeRef)
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.revokeStmt = db.prepare(`
      UPDATE tool_grants
      SET revoked_at = @revokedAt
      WHERE grant_id = @grantId AND revoked_at IS NULL
    `);
    this.consumeStmt = db.prepare(`
      UPDATE tool_grants
      SET uses_remaining = uses_remaining - 1
      WHERE grant_id = @grantId
        AND uses_remaining IS NOT NULL
        AND uses_remaining > 0
    `);
  }

  public create(input: ToolGrantCreateInput, now = new Date().toISOString()): ToolGrantRecord {
    const grantId = randomUUID();
    const scopeRef = normalizeScopeRef(input.scope, input.scopeRef);
    const grantType = input.grantType ?? "persistent";
    const usesRemaining = input.usesRemaining ?? (grantType === "one_time" ? 1 : null);
    this.createStmt.run({
      grantId,
      toolPattern: input.toolPattern.trim(),
      decision: input.decision,
      scope: input.scope,
      scopeRef,
      grantType,
      constraintsJson: input.constraints ? JSON.stringify(input.constraints) : null,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      usesRemaining,
    });
    return this.get(grantId);
  }

  public get(grantId: string): ToolGrantRecord {
    const row = this.getStmt.get(grantId) as ToolGrantRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Tool grant", id: grantId });
    }
    return mapRow(row);
  }

  public list(scope?: ToolGrantScope, scopeRef?: string, limit = 200): ToolGrantRecord[] {
    const rows = this.listStmt.all({
      scope: scope ?? null,
      scopeRef: scopeRef ?? null,
      limit,
    }) as unknown as ToolGrantRow[];
    return rows.map(mapRow);
  }

  public revoke(grantId: string, revokedAt = new Date().toISOString()): boolean {
    const result = this.revokeStmt.run({
      grantId,
      revokedAt,
    });
    return Number(result.changes ?? 0) > 0;
  }

  public consumeOne(grantId: string): void {
    this.consumeStmt.run({ grantId });
  }
}

function mapRow(row: ToolGrantRow): ToolGrantRecord {
  return {
    grantId: row.grant_id,
    toolPattern: row.tool_pattern,
    decision: row.decision,
    scope: row.scope,
    scopeRef: row.scope_ref,
    grantType: row.grant_type,
    constraints: row.constraints_json
      ? safeJsonParse<ToolGrantRecord["constraints"]>(row.constraints_json, undefined)
      : undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    usesRemaining: row.uses_remaining ?? undefined,
  };
}

function normalizeScopeRef(scope: ToolGrantScope, scopeRef?: string): string {
  if (scope === "global") {
    return "global";
  }
  const value = scopeRef?.trim();
  if (!value) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "scopeRef", message: `scopeRef is required for ${scope} grants` });
  }
  return value;
}
