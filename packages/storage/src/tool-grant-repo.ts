import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
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
  private readonly revokeStmt;
  private readonly consumeStmt;

  public constructor(private readonly db: DatabaseClient) {
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
    const row = this.getStmt.get(grantId);
    assertToolGrantRow(row);
    if (!row) {
      throw new NotFoundError({ entity: "Tool grant", id: grantId });
    }
    return mapRow(row);
  }

  public list(scope?: ToolGrantScope, scopeRef?: string, limit = 200): ToolGrantRecord[] {
    const params: Record<string, unknown> = { limit };
    const clauses: string[] = [];
    if (scope) {
      params.scope = scope;
      clauses.push("scope = @scope");
    }
    if (scopeRef) {
      params.scopeRef = scopeRef;
      clauses.push("scope_ref = @scopeRef");
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT * FROM tool_grants
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT @limit
    `).all(params);
    assertToolGrantRows(rows);
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

function assertToolGrantRow(row: unknown): asserts row is ToolGrantRow | undefined {
  if (row !== undefined && !isToolGrantRow(row)) {
    throw new TypeError("Unexpected tool_grants row shape");
  }
}

function assertToolGrantRows(rows: unknown): asserts rows is ToolGrantRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isToolGrantRow(row))) {
    throw new TypeError("Unexpected tool_grants row shape");
  }
}

function isToolGrantRow(value: unknown): value is ToolGrantRow {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.grant_id === "string"
    && typeof value.tool_pattern === "string"
    && (value.decision === "allow" || value.decision === "deny")
    && typeof value.scope === "string"
    && typeof value.scope_ref === "string"
    && (value.grant_type === "one_time" || value.grant_type === "ttl" || value.grant_type === "persistent")
    && (typeof value.constraints_json === "string" || value.constraints_json === null)
    && typeof value.created_by === "string"
    && typeof value.created_at === "string"
    && (typeof value.expires_at === "string" || value.expires_at === null)
    && (typeof value.revoked_at === "string" || value.revoked_at === null)
    && (typeof value.uses_remaining === "number" || value.uses_remaining === null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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


