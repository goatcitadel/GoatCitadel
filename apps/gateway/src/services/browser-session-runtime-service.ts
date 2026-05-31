import { randomUUID } from "node:crypto";
import {
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  type BrowserSessionAccessCheck,
  type BrowserSessionCreateInput,
  type BrowserSessionEventRecord,
  type BrowserSessionEventType,
  type BrowserSessionGrantInput,
  type BrowserSessionGrantRecord,
  type BrowserSessionGrantScope,
  type BrowserSessionRecord,
} from "@goatcitadel/contracts";

type SqlStatement = {
  run(params?: Record<string, unknown>): unknown;
  get(params?: Record<string, unknown>): unknown;
  all(params?: Record<string, unknown>): unknown[];
};

interface BrowserSessionSql {
  prepare(sql: string): SqlStatement;
}

export interface BrowserSessionRuntimeDependencies {
  gatewaySql: BrowserSessionSql;
  publishRealtime?(eventType: string, source: string, payload: Record<string, unknown>): void;
}

interface BrowserSessionRow {
  session_id: string;
  workspace_id: string | null;
  label: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface BrowserSessionGrantRow {
  grant_id: string;
  session_id: string;
  actor_id: string;
  scopes_json: string;
  allowed_hosts_json: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface BrowserSessionEventRow {
  event_id: string;
  session_id: string;
  event_type: BrowserSessionEventType;
  actor_id: string | null;
  payload_json: string;
  created_at: string;
}

const VALID_SCOPES: readonly BrowserSessionGrantScope[] = ["read", "interact", "state", "admin"];
const SCOPE_RANK: Record<BrowserSessionGrantScope, number> = {
  read: 1,
  interact: 2,
  state: 3,
  admin: 4,
};

export class BrowserSessionRuntimeService {
  public constructor(private readonly deps: BrowserSessionRuntimeDependencies) {
    this.ensureSchema();
  }

  public createSession(input: BrowserSessionCreateInput = {}): BrowserSessionRecord {
    const now = new Date().toISOString();
    const session: BrowserSessionRecord = {
      sessionId: randomUUID(),
      workspaceId: input.workspaceId?.trim() || undefined,
      label: input.label?.trim() || "Shared browser session",
      status: "active",
      createdBy: input.actorId?.trim() || "operator",
      createdAt: now,
      updatedAt: now,
    };
    this.deps.gatewaySql
      .prepare(
        `
        INSERT INTO browser_sessions (
          session_id, workspace_id, label, status, created_by, created_at, updated_at, closed_at
        ) VALUES (
          @sessionId, @workspaceId, @label, @status, @createdBy, @createdAt, @updatedAt, NULL
        )
      `,
      )
      .run({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId ?? null,
        label: session.label,
        status: session.status,
        createdBy: session.createdBy,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    this.recordEvent(session.sessionId, "session_created", session.createdBy, { label: session.label });
    this.publish("browser_session_created", { sessionId: session.sessionId, workspaceId: session.workspaceId });
    return session;
  }

  public listSessions(input: { workspaceId?: string; status?: "active" | "closed" | "all"; limit?: number } = {}) {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: normalizeLimit(input.limit) };
    if (input.workspaceId?.trim()) {
      clauses.push("workspace_id = @workspaceId");
      params.workspaceId = input.workspaceId.trim();
    }
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_sessions
        ${where}
        ORDER BY updated_at DESC
        LIMIT @limit
      `,
      )
      .all(params) as BrowserSessionRow[];
    return rows.map(mapSessionRow);
  }

  public getSession(sessionId: string): BrowserSessionRecord {
    return this.requireSession(sessionId);
  }

  public closeSession(sessionId: string, actorId = "operator"): BrowserSessionRecord {
    const current = this.requireSession(sessionId);
    if (current.status === "closed") {
      return current;
    }
    const now = new Date().toISOString();
    this.deps.gatewaySql
      .prepare(
        `
        UPDATE browser_sessions
        SET status = 'closed', updated_at = @updatedAt, closed_at = @closedAt
        WHERE session_id = @sessionId
      `,
      )
      .run({ sessionId, updatedAt: now, closedAt: now });
    this.deps.gatewaySql
      .prepare(
        `
        UPDATE browser_session_grants
        SET revoked_at = @revokedAt
        WHERE session_id = @sessionId AND revoked_at IS NULL
      `,
      )
      .run({ sessionId, revokedAt: now });
    this.recordEvent(sessionId, "session_closed", actorId, {});
    this.publish("browser_session_closed", { sessionId });
    return this.requireSession(sessionId);
  }

  public createGrant(
    sessionId: string,
    input: BrowserSessionGrantInput,
    actorId = "operator",
  ): BrowserSessionGrantRecord {
    const session = this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new ValidationError({ message: "Cannot create a grant for a closed browser session." });
    }
    const now = new Date().toISOString();
    const grant: BrowserSessionGrantRecord = {
      grantId: randomUUID(),
      sessionId,
      actorId: requireTrimmed(input.actorId, "actorId"),
      scopes: normalizeScopes(input.scopes),
      allowedHosts: normalizeHosts(input.allowedHosts),
      createdAt: now,
      expiresAt: input.ttlSeconds
        ? new Date(Date.now() + normalizeTtl(input.ttlSeconds) * 1000).toISOString()
        : undefined,
    };
    this.deps.gatewaySql
      .prepare(
        `
        INSERT INTO browser_session_grants (
          grant_id, session_id, actor_id, scopes_json, allowed_hosts_json, created_at, expires_at, revoked_at
        ) VALUES (
          @grantId, @sessionId, @actorId, @scopesJson, @allowedHostsJson, @createdAt, @expiresAt, NULL
        )
      `,
      )
      .run({
        grantId: grant.grantId,
        sessionId: grant.sessionId,
        actorId: grant.actorId,
        scopesJson: JSON.stringify(grant.scopes),
        allowedHostsJson: JSON.stringify(grant.allowedHosts),
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt ?? null,
      });
    this.recordEvent(sessionId, "grant_created", actorId, {
      grantId: grant.grantId,
      grantActorId: grant.actorId,
      scopes: grant.scopes,
      allowedHosts: grant.allowedHosts,
    });
    this.publish("browser_session_grant_created", { sessionId, grantId: grant.grantId });
    return grant;
  }

  public revokeGrant(sessionId: string, grantId: string, actorId = "operator"): BrowserSessionGrantRecord {
    this.requireSession(sessionId);
    const current = this.requireGrant(sessionId, grantId);
    if (current.revokedAt) {
      return current;
    }
    const now = new Date().toISOString();
    this.deps.gatewaySql
      .prepare(
        `
        UPDATE browser_session_grants
        SET revoked_at = @revokedAt
        WHERE session_id = @sessionId AND grant_id = @grantId
      `,
      )
      .run({ sessionId, grantId, revokedAt: now });
    this.recordEvent(sessionId, "grant_revoked", actorId, { grantId });
    this.publish("browser_session_grant_revoked", { sessionId, grantId });
    return this.requireGrant(sessionId, grantId);
  }

  public rotateGrant(sessionId: string, grantId: string, actorId = "operator"): BrowserSessionGrantRecord {
    const current = this.revokeGrant(sessionId, grantId, actorId);
    const remainingTtlSeconds = current.expiresAt
      ? Math.floor((new Date(current.expiresAt).getTime() - Date.now()) / 1000)
      : undefined;
    const rotated = this.createGrant(
      sessionId,
      {
        actorId: current.actorId,
        scopes: current.scopes,
        allowedHosts: current.allowedHosts,
        ttlSeconds: remainingTtlSeconds && remainingTtlSeconds > 0 ? remainingTtlSeconds : undefined,
      },
      actorId,
    );
    this.recordEvent(sessionId, "grant_rotated", actorId, { previousGrantId: grantId, grantId: rotated.grantId });
    return rotated;
  }

  public listEvents(sessionId: string, limit = 100): BrowserSessionEventRecord[] {
    this.requireSession(sessionId);
    const rows = this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_session_events
        WHERE session_id = @sessionId
        ORDER BY created_at DESC
        LIMIT @limit
      `,
      )
      .all({ sessionId, limit: normalizeLimit(limit) }) as BrowserSessionEventRow[];
    return rows.map((row) => mapEventRow(this.deps.gatewaySql, row));
  }

  public listGrants(
    sessionId: string,
    input: { status?: "active" | "revoked" | "all"; limit?: number } = {},
  ): BrowserSessionGrantRecord[] {
    this.requireSession(sessionId);
    const clauses = ["session_id = @sessionId"];
    const params: Record<string, unknown> = { sessionId, limit: normalizeLimit(input.limit) };
    if (input.status === "active") {
      clauses.push("revoked_at IS NULL");
      clauses.push("(expires_at IS NULL OR expires_at > @now)");
      params.now = new Date().toISOString();
    } else if (input.status === "revoked") {
      clauses.push("revoked_at IS NOT NULL");
    }
    const rows = this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_session_grants
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT @limit
      `,
      )
      .all(params) as BrowserSessionGrantRow[];
    return rows.map((row) => mapGrantRow(this.deps.gatewaySql, row));
  }

  public assertAccess(check: BrowserSessionAccessCheck): void {
    const session = this.requireSession(check.sessionId);
    if (session.status !== "active") {
      throw new PolicyViolationError({ message: "Browser session is closed." });
    }
    const activeGrants = this.listActiveGrants(check.sessionId, check.actorId);
    const host = check.host ? normalizeHost(check.host) : undefined;
    const allowed = activeGrants.some((grant) => {
      const hasScope = grant.scopes.some((scope) => SCOPE_RANK[scope] >= SCOPE_RANK[check.requiredScope]);
      const hasHost = !host || grant.allowedHosts.length === 0 || grant.allowedHosts.includes(host);
      return hasScope && hasHost;
    });
    if (!allowed) {
      this.recordEvent(check.sessionId, "tool_guard_blocked", check.actorId, {
        requiredScope: check.requiredScope,
        host,
      });
      throw new PolicyViolationError({
        message: `Browser session ${check.sessionId} does not grant ${check.requiredScope} access to ${check.actorId}.`,
      });
    }
  }

  private listActiveGrants(sessionId: string, actorId: string): BrowserSessionGrantRecord[] {
    const now = new Date().toISOString();
    const rows = this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_session_grants
        WHERE session_id = @sessionId
          AND actor_id = @actorId
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > @now)
        ORDER BY created_at DESC
      `,
      )
      .all({ sessionId, actorId, now }) as BrowserSessionGrantRow[];
    return rows.map((row) => mapGrantRow(this.deps.gatewaySql, row));
  }

  private requireSession(sessionId: string): BrowserSessionRecord {
    const row = this.deps.gatewaySql
      .prepare("SELECT * FROM browser_sessions WHERE session_id = @sessionId")
      .get({ sessionId }) as BrowserSessionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "browser session", id: sessionId });
    }
    return mapSessionRow(row);
  }

  private requireGrant(sessionId: string, grantId: string): BrowserSessionGrantRecord {
    const row = this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_session_grants
        WHERE session_id = @sessionId AND grant_id = @grantId
      `,
      )
      .get({ sessionId, grantId }) as BrowserSessionGrantRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "browser session grant", id: grantId });
    }
    return mapGrantRow(this.deps.gatewaySql, row);
  }

  private recordEvent(
    sessionId: string,
    eventType: BrowserSessionEventType,
    actorId: string | undefined,
    payload: Record<string, unknown>,
  ): void {
    const event: BrowserSessionEventRecord = {
      eventId: randomUUID(),
      sessionId,
      eventType,
      actorId,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.deps.gatewaySql
      .prepare(
        `
        INSERT INTO browser_session_events (
          event_id, session_id, event_type, actor_id, payload_json, created_at
        ) VALUES (
          @eventId, @sessionId, @eventType, @actorId, @payloadJson, @createdAt
        )
      `,
      )
      .run({
        eventId: event.eventId,
        sessionId: event.sessionId,
        eventType: event.eventType,
        actorId: event.actorId ?? null,
        createdAt: event.createdAt,
        payloadJson: JSON.stringify(event.payload),
      });
  }

  private publish(eventType: string, payload: Record<string, unknown>): void {
    this.deps.publishRealtime?.(eventType, "browser-sessions", payload);
  }

  private ensureSchema(): void {
    this.deps.gatewaySql
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS browser_sessions (
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT,
          label TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT
        )
      `,
      )
      .run();
    this.deps.gatewaySql
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS browser_session_grants (
          grant_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          allowed_hosts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT
        )
      `,
      )
      .run();
    this.deps.gatewaySql
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS browser_session_events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `,
      )
      .run();
    this.deps.gatewaySql
      .prepare("CREATE INDEX IF NOT EXISTS idx_browser_sessions_workspace ON browser_sessions(workspace_id, status)")
      .run();
    this.deps.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_browser_session_grants_lookup ON browser_session_grants(session_id, actor_id, revoked_at)",
      )
      .run();
    this.deps.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_browser_session_events_session ON browser_session_events(session_id, created_at)",
      )
      .run();
  }
}

function mapSessionRow(row: BrowserSessionRow): BrowserSessionRecord {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id ?? undefined,
    label: row.label,
    status: row.status === "closed" ? "closed" : "active",
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  };
}

function mapGrantRow(sql: BrowserSessionSql, row: BrowserSessionGrantRow): BrowserSessionGrantRecord {
  return {
    grantId: row.grant_id,
    sessionId: row.session_id,
    actorId: row.actor_id,
    scopes: parseJson(sql, row.scopes_json, []).filter(isScope),
    allowedHosts: parseJson(sql, row.allowed_hosts_json, []),
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function mapEventRow(sql: BrowserSessionSql, row: BrowserSessionEventRow): BrowserSessionEventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    actorId: row.actor_id ?? undefined,
    payload: parseJson(sql, row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function normalizeScopes(scopes: BrowserSessionGrantScope[]): BrowserSessionGrantScope[] {
  const normalized = [...new Set(scopes.filter(isScope))];
  if (normalized.length === 0) {
    throw new ValidationError({ field: "scopes", message: "At least one browser session grant scope is required." });
  }
  return normalized;
}

function isScope(value: unknown): value is BrowserSessionGrantScope {
  return typeof value === "string" && VALID_SCOPES.includes(value as BrowserSessionGrantScope);
}

function normalizeHosts(hosts: string[] | undefined): string[] {
  return [...new Set((hosts ?? []).map(normalizeHost).filter(Boolean))];
}

function normalizeHost(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return "";
  }
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return value;
  }
}

function normalizeLimit(value: number | undefined): number {
  return Math.max(1, Math.min(500, Math.floor(value ?? 100)));
}

function normalizeTtl(value: number): number {
  return Math.max(1, Math.min(7 * 24 * 60 * 60, Math.floor(value)));
}

function requireTrimmed(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ValidationError({ field, code: "FIELD_REQUIRED" });
  }
  return trimmed;
}

function parseJson<T>(_sql: BrowserSessionSql, raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
