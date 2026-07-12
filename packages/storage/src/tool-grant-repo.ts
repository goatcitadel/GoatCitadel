import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { ToolGrantCreateInput, ToolGrantRecord, ToolGrantScope, ToolGrantType } from "@goatcitadel/contracts";
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
  revoked_by: string | null;
  uses_remaining: number | null;
}

export class ToolGrantRepository {
  private readonly createStmt;
  private readonly getStmt;
  private readonly findActiveStmt;
  private readonly revokeStmt;
  private readonly consumeStmt;
  private readonly databaseTtlWindowStmt;
  private readonly isFutureExpiryStmt;

  public constructor(private readonly db: DatabaseClient) {
    const expiryIsActive =
      db.dialect === "postgres"
        ? "gc_try_parse_timestamptz(expires_at) > clock_timestamp()"
        : "julianday(expires_at) > julianday('now')";
    const databaseNow = db.dialect === "postgres" ? "statement_timestamp()" : "julianday('now')";
    const requestedExpiry =
      db.dialect === "postgres" ? "gc_try_parse_timestamptz(@expiresAt)" : "julianday(@expiresAt)";
    const databaseNowText =
      db.dialect === "postgres"
        ? `to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    const databaseExpiryText =
      db.dialect === "postgres"
        ? `to_char(
            (statement_timestamp() + (CAST(@ttlMs AS DOUBLE PRECISION) * INTERVAL '1 millisecond'))
              AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )`
        : "strftime('%Y-%m-%dT%H:%M:%fZ', julianday('now') + (CAST(@ttlMs AS REAL) / 86400000.0))";
    this.createStmt = db.prepare(`
      INSERT INTO tool_grants (
        grant_id, tool_pattern, decision, scope, scope_ref, grant_type, constraints_json,
        created_by, created_at, expires_at, revoked_at, revoked_by, uses_remaining
      ) VALUES (
        @grantId, @toolPattern, @decision, @scope, @scopeRef, @grantType, @constraintsJson,
        @createdBy, @createdAt, @expiresAt, NULL, NULL, @usesRemaining
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM tool_grants WHERE grant_id = ?");
    this.findActiveStmt = db.prepare(`
      SELECT *
      FROM tool_grants
      WHERE grant_id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR ${expiryIsActive})
        AND (uses_remaining IS NULL OR uses_remaining > 0)
      LIMIT 1
    `);
    this.revokeStmt = db.prepare(`
      UPDATE tool_grants
      SET revoked_at = @revokedAt,
          revoked_by = @revokedBy
      WHERE grant_id = @grantId AND revoked_at IS NULL
    `);
    this.consumeStmt = db.prepare(`
      UPDATE tool_grants
      SET uses_remaining = CASE
        WHEN grant_type = 'one_time' THEN uses_remaining - 1
        ELSE uses_remaining
      END
      WHERE grant_id = @grantId
        AND decision = 'allow'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR ${expiryIsActive})
        AND (
          grant_type <> 'one_time'
          OR (uses_remaining IS NOT NULL AND uses_remaining > 0)
        )
    `);
    this.databaseTtlWindowStmt = db.prepare(`
      SELECT ${databaseNowText} AS created_at, ${databaseExpiryText} AS expires_at
    `);
    this.isFutureExpiryStmt = db.prepare(`
      SELECT 1 AS valid
      WHERE ${requestedExpiry} IS NOT NULL
        AND ${requestedExpiry} > ${databaseNow}
    `);
  }

  public create(input: ToolGrantCreateInput, now = new Date().toISOString()): ToolGrantRecord {
    const grantId = randomUUID();
    const scopeRef = normalizeScopeRef(input.scope, input.scopeRef);
    const grantType = input.grantType ?? "persistent";
    if (input.decision === "deny" && grantType === "one_time") {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "grantType",
        message: "one_time grants can only be allow grants.",
      });
    }
    const lifetime = normalizeGrantLifetime(input, grantType, now);
    return this.db.transaction("immediate", () => {
      if (grantType === "ttl" && !this.isFutureExpiryStmt.get({ expiresAt: lifetime.expiresAt })) {
        throw new ValidationError({
          code: "FIELD_INVALID",
          field: "expiresAt",
          message: "ttl grants require a future expiresAt according to the database clock.",
        });
      }
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
        expiresAt: lifetime.expiresAt,
        usesRemaining: lifetime.usesRemaining,
      });
      return this.get(grantId);
    });
  }

  public createTtlForDuration(
    input: Omit<ToolGrantCreateInput, "grantType" | "expiresAt" | "usesRemaining">,
    ttlMs: number,
  ): ToolGrantRecord {
    const normalizedTtlMs = Math.floor(ttlMs);
    if (!Number.isFinite(normalizedTtlMs) || normalizedTtlMs <= 0) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "ttlMs",
        message: "ttlMs must be a positive duration.",
      });
    }
    return this.db.transaction("immediate", () => {
      const window = this.databaseTtlWindowStmt.get({ ttlMs: normalizedTtlMs }) as
        | { created_at: string; expires_at: string }
        | undefined;
      if (!window?.created_at || !window.expires_at) {
        throw new Error("Database did not return a tool-grant TTL window.");
      }
      return this.create(
        {
          ...input,
          grantType: "ttl",
          expiresAt: window.expires_at,
        },
        window.created_at,
      );
    });
  }

  public get(grantId: string): ToolGrantRecord {
    const row = this.getStmt.get(grantId);
    assertToolGrantRow(row);
    if (!row) {
      throw new NotFoundError({ entity: "Tool grant", id: grantId });
    }
    return mapRow(row);
  }

  public findActive(grantId: string): ToolGrantRecord | undefined {
    const row = this.findActiveStmt.get(grantId);
    assertToolGrantRow(row);
    return row ? mapRow(row) : undefined;
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
    const rows = this.db
      .prepare(
        `
      SELECT * FROM tool_grants
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT @limit
    `,
      )
      .all(params);
    assertToolGrantRows(rows);
    return rows.map(mapRow);
  }

  public listActive(scope?: ToolGrantScope, scopeRef?: string, now = new Date().toISOString()): ToolGrantRecord[] {
    void now;
    const expiryIsActive =
      this.db.dialect === "postgres"
        ? "gc_try_parse_timestamptz(expires_at) > statement_timestamp()"
        : "julianday(expires_at) > julianday('now')";
    const params: Record<string, unknown> = {};
    const clauses: string[] = [
      "revoked_at IS NULL",
      `(expires_at IS NULL OR ${expiryIsActive})`,
      "(uses_remaining IS NULL OR uses_remaining > 0)",
    ];
    if (scope) {
      params.scope = scope;
      clauses.push("scope = @scope");
    }
    if (scopeRef) {
      params.scopeRef = scopeRef;
      clauses.push("scope_ref = @scopeRef");
    }
    const rows = this.db
      .prepare(
        `
      SELECT * FROM tool_grants
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
    `,
      )
      .all(params);
    assertToolGrantRows(rows);
    return rows.map(mapRow);
  }

  public revoke(grantId: string, revokedAt = new Date().toISOString(), revokedBy?: string): boolean {
    const normalizedRevokedBy = revokedBy?.trim();
    if (!normalizedRevokedBy) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "revokedBy" });
    }
    const result = this.revokeStmt.run({
      grantId,
      revokedAt,
      revokedBy: normalizedRevokedBy,
    });
    return Number(result.changes ?? 0) > 0;
  }

  public consumeOne(grantId: string): boolean {
    // Preserve the repository's NotFound contract, then let one conditional
    // UPDATE decide revocation, expiry, grant type, and one-time decrement at
    // the database serialization point. A revoke committed after this read is
    // therefore re-checked before consumption succeeds.
    this.get(grantId);
    const result = this.consumeStmt.run({ grantId });
    return Number(result.changes ?? 0) > 0;
  }
}

function normalizeGrantLifetime(
  input: ToolGrantCreateInput,
  grantType: ToolGrantType,
  now: string,
): { expiresAt: string | null; usesRemaining: number | null } {
  void now;
  if (grantType === "one_time") {
    if (input.expiresAt) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "expiresAt",
        message: "one_time grants cannot set expiresAt.",
      });
    }
    if (input.usesRemaining !== undefined && input.usesRemaining !== 1) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "usesRemaining",
        message: "one_time grants must use exactly one remaining use.",
      });
    }
    return { expiresAt: null, usesRemaining: 1 };
  }
  if (grantType === "ttl") {
    if (!input.expiresAt) {
      throw new ValidationError({
        code: "FIELD_REQUIRED",
        field: "expiresAt",
        message: "ttl grants require expiresAt.",
      });
    }
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "expiresAt",
        message: "ttl grants require a valid expiresAt.",
      });
    }
    if (input.usesRemaining !== undefined) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "usesRemaining",
        message: "ttl grants cannot set usesRemaining.",
      });
    }
    return { expiresAt: input.expiresAt, usesRemaining: null };
  }
  if (input.expiresAt) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "expiresAt",
      message: "persistent grants cannot set expiresAt.",
    });
  }
  if (input.usesRemaining !== undefined) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "usesRemaining",
      message: "persistent grants cannot set usesRemaining.",
    });
  }
  return { expiresAt: null, usesRemaining: null };
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

  return (
    typeof value.grant_id === "string" &&
    typeof value.tool_pattern === "string" &&
    (value.decision === "allow" || value.decision === "deny") &&
    typeof value.scope === "string" &&
    typeof value.scope_ref === "string" &&
    (value.grant_type === "one_time" || value.grant_type === "ttl" || value.grant_type === "persistent") &&
    (typeof value.constraints_json === "string" || value.constraints_json === null) &&
    typeof value.created_by === "string" &&
    typeof value.created_at === "string" &&
    (typeof value.expires_at === "string" || value.expires_at === null) &&
    (typeof value.revoked_at === "string" || value.revoked_at === null) &&
    (typeof value.revoked_by === "string" || value.revoked_by === null) &&
    (typeof value.uses_remaining === "number" || value.uses_remaining === null)
  );
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
    revokedBy: row.revoked_by ?? undefined,
    usesRemaining: row.uses_remaining ?? undefined,
  };
}

function normalizeScopeRef(scope: ToolGrantScope, scopeRef?: string): string {
  if (scope === "global") {
    return "global";
  }
  const value = scopeRef?.trim();
  if (!value) {
    throw new ValidationError({
      code: "FIELD_REQUIRED",
      field: "scopeRef",
      message: `scopeRef is required for ${scope} grants`,
    });
  }
  return value;
}
