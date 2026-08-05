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
  type BrowserSessionStateProjection,
  type BrowserSessionStateSummary,
} from "@goatcitadel/contracts";
import type { AsyncGatewaySqlRepository } from "@goatcitadel/storage";

export interface BrowserSessionRuntimeDependencies {
  gatewaySql: AsyncGatewaySqlRepository;
  publishRealtime?(eventType: string, source: string, payload: Record<string, unknown>): Promise<unknown>;
  describeState?(sessionId: string): BrowserSessionStateSummary;
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
  private schemaReady?: Promise<void>;

  public constructor(private readonly deps: BrowserSessionRuntimeDependencies) {}

  public async createSession(input: BrowserSessionCreateInput = {}): Promise<BrowserSessionRecord> {
    await this.waitForSchema();
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
    await this.deps.gatewaySql
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
    await this.recordEvent(session.sessionId, "session_created", session.createdBy, { label: session.label });
    await this.publish("browser_session_created", { sessionId: session.sessionId, workspaceId: session.workspaceId });
    return session;
  }

  public async listSessions(
    input: { workspaceId?: string; status?: "active" | "closed" | "all"; limit?: number } = {},
  ): Promise<BrowserSessionRecord[]> {
    await this.waitForSchema();
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
    const rows = (await this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_sessions
        ${where}
        ORDER BY updated_at DESC
        LIMIT @limit
      `,
      )
      .all(params)) as BrowserSessionRow[];
    return rows.map(mapSessionRow);
  }

  public async getSession(sessionId: string): Promise<BrowserSessionRecord> {
    await this.waitForSchema();
    return await this.requireSession(sessionId);
  }

  public async getStateProjection(sessionId: string): Promise<BrowserSessionStateProjection> {
    await this.waitForSchema();
    const session = await this.requireSession(sessionId);
    const recentEvents = await this.listEvents(sessionId, 100);
    return {
      session,
      state: this.deps.describeState?.(sessionId) ?? createUnavailableBrowserSessionStateSummary(),
      eventSummary: summarizeBrowserSessionEvents(recentEvents),
    };
  }

  public async closeSession(sessionId: string, actorId = "operator"): Promise<BrowserSessionRecord> {
    await this.waitForSchema();
    const current = await this.requireSession(sessionId);
    if (current.status === "closed") {
      return current;
    }
    const now = new Date().toISOString();
    await this.deps.gatewaySql
      .prepare(
        `
        UPDATE browser_sessions
        SET status = 'closed', updated_at = @updatedAt, closed_at = @closedAt
        WHERE session_id = @sessionId
      `,
      )
      .run({ sessionId, updatedAt: now, closedAt: now });
    await this.deps.gatewaySql
      .prepare(
        `
        UPDATE browser_session_grants
        SET revoked_at = @revokedAt
        WHERE session_id = @sessionId AND revoked_at IS NULL
      `,
      )
      .run({ sessionId, revokedAt: now });
    await this.recordEvent(sessionId, "session_closed", actorId, {});
    await this.publish("browser_session_closed", { sessionId });
    return await this.requireSession(sessionId);
  }

  public async createGrant(
    sessionId: string,
    input: BrowserSessionGrantInput,
    actorId = "operator",
  ): Promise<BrowserSessionGrantRecord> {
    await this.waitForSchema();
    const session = await this.requireSession(sessionId);
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
    await this.deps.gatewaySql
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
    await this.recordEvent(sessionId, "grant_created", actorId, {
      grantId: grant.grantId,
      grantActorId: grant.actorId,
      scopes: grant.scopes,
      allowedHosts: grant.allowedHosts,
    });
    await this.publish("browser_session_grant_created", { sessionId, grantId: grant.grantId });
    return grant;
  }

  public async revokeGrant(
    sessionId: string,
    grantId: string,
    actorId = "operator",
  ): Promise<BrowserSessionGrantRecord> {
    await this.waitForSchema();
    await this.requireSession(sessionId);
    const current = await this.requireGrant(sessionId, grantId);
    if (current.revokedAt) {
      return current;
    }
    const now = new Date().toISOString();
    await this.deps.gatewaySql
      .prepare(
        `
        UPDATE browser_session_grants
        SET revoked_at = @revokedAt
        WHERE session_id = @sessionId AND grant_id = @grantId
      `,
      )
      .run({ sessionId, grantId, revokedAt: now });
    await this.recordEvent(sessionId, "grant_revoked", actorId, { grantId });
    await this.publish("browser_session_grant_revoked", { sessionId, grantId });
    return await this.requireGrant(sessionId, grantId);
  }

  public async rotateGrant(
    sessionId: string,
    grantId: string,
    actorId = "operator",
  ): Promise<BrowserSessionGrantRecord> {
    await this.waitForSchema();
    const current = await this.revokeGrant(sessionId, grantId, actorId);
    const remainingTtlSeconds = current.expiresAt
      ? Math.floor((new Date(current.expiresAt).getTime() - Date.now()) / 1000)
      : undefined;
    const rotated = await this.createGrant(
      sessionId,
      {
        actorId: current.actorId,
        scopes: current.scopes,
        allowedHosts: current.allowedHosts,
        ttlSeconds: remainingTtlSeconds && remainingTtlSeconds > 0 ? remainingTtlSeconds : undefined,
      },
      actorId,
    );
    await this.recordEvent(sessionId, "grant_rotated", actorId, {
      previousGrantId: grantId,
      grantId: rotated.grantId,
    });
    return rotated;
  }

  public async listEvents(sessionId: string, limit = 100): Promise<BrowserSessionEventRecord[]> {
    await this.waitForSchema();
    await this.requireSession(sessionId);
    const rows = (await this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_session_events
        WHERE session_id = @sessionId
        ORDER BY created_at DESC
        LIMIT @limit
      `,
      )
      .all({ sessionId, limit: normalizeLimit(limit) })) as BrowserSessionEventRow[];
    return rows.map(mapEventRow);
  }

  public async listGrants(
    sessionId: string,
    input: { status?: "active" | "revoked" | "all"; limit?: number } = {},
  ): Promise<BrowserSessionGrantRecord[]> {
    await this.waitForSchema();
    await this.requireSession(sessionId);
    const clauses = ["session_id = @sessionId"];
    const params: Record<string, unknown> = { sessionId, limit: normalizeLimit(input.limit) };
    if (input.status === "active") {
      clauses.push("revoked_at IS NULL");
      clauses.push("(expires_at IS NULL OR expires_at > @now)");
      params.now = new Date().toISOString();
    } else if (input.status === "revoked") {
      clauses.push("revoked_at IS NOT NULL");
    }
    const rows = (await this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_session_grants
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT @limit
      `,
      )
      .all(params)) as BrowserSessionGrantRow[];
    return rows.map(mapGrantRow);
  }

  public async assertAccess(check: BrowserSessionAccessCheck): Promise<void> {
    await this.waitForSchema();
    const session = await this.requireSession(check.sessionId);
    const host = check.host ? normalizeHost(check.host) : undefined;
    if (session.status !== "active") {
      await this.recordEvent(check.sessionId, "tool_guard_blocked", check.actorId, {
        requiredScope: check.requiredScope,
        host,
        toolName: check.toolName,
        runId: check.runId,
        reason: "closed_session",
      });
      throw new PolicyViolationError({ message: "Browser session is closed." });
    }
    const activeGrants = await this.listActiveGrants(check.sessionId, check.actorId);
    const allowed = activeGrants.some((grant) => {
      const hasScope = grant.scopes.some((scope) => SCOPE_RANK[scope] >= SCOPE_RANK[check.requiredScope]);
      const hasHost = !host || grant.allowedHosts.length === 0 || grant.allowedHosts.includes(host);
      return hasScope && hasHost;
    });
    if (!allowed) {
      await this.recordEvent(check.sessionId, "tool_guard_blocked", check.actorId, {
        requiredScope: check.requiredScope,
        host,
        toolName: check.toolName,
        runId: check.runId,
      });
      throw new PolicyViolationError({
        message: `Browser session ${check.sessionId} does not grant ${check.requiredScope} access to ${check.actorId}.`,
      });
    }
    await this.recordEvent(check.sessionId, "tool_access_granted", check.actorId, {
      requiredScope: check.requiredScope,
      host,
      toolName: check.toolName,
      runId: check.runId,
    });
  }

  private async listActiveGrants(sessionId: string, actorId: string): Promise<BrowserSessionGrantRecord[]> {
    const now = new Date().toISOString();
    const rows = (await this.deps.gatewaySql
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
      .all({ sessionId, actorId, now })) as BrowserSessionGrantRow[];
    return rows.map(mapGrantRow);
  }

  private async requireSession(sessionId: string): Promise<BrowserSessionRecord> {
    const row = (await this.deps.gatewaySql
      .prepare("SELECT * FROM browser_sessions WHERE session_id = @sessionId")
      .get({ sessionId })) as BrowserSessionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "browser session", id: sessionId });
    }
    return mapSessionRow(row);
  }

  private async requireGrant(sessionId: string, grantId: string): Promise<BrowserSessionGrantRecord> {
    const row = (await this.deps.gatewaySql
      .prepare(
        `
        SELECT *
        FROM browser_session_grants
        WHERE session_id = @sessionId AND grant_id = @grantId
      `,
      )
      .get({ sessionId, grantId })) as BrowserSessionGrantRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "browser session grant", id: grantId });
    }
    return mapGrantRow(row);
  }

  private async recordEvent(
    sessionId: string,
    eventType: BrowserSessionEventType,
    actorId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: BrowserSessionEventRecord = {
      eventId: randomUUID(),
      sessionId,
      eventType,
      actorId,
      payload,
      createdAt: new Date().toISOString(),
    };
    await this.deps.gatewaySql
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

  private async publish(eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.publishRealtime?.(eventType, "browser-sessions", payload);
  }

  private waitForSchema(): Promise<void> {
    this.schemaReady ??= this.ensureSchema();
    return this.schemaReady;
  }

  private async ensureSchema(): Promise<void> {
    await this.deps.gatewaySql
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
    await this.deps.gatewaySql
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
    await this.deps.gatewaySql
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
    await this.deps.gatewaySql
      .prepare("CREATE INDEX IF NOT EXISTS idx_browser_sessions_workspace ON browser_sessions(workspace_id, status)")
      .run();
    await this.deps.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_browser_session_grants_lookup ON browser_session_grants(session_id, actor_id, revoked_at)",
      )
      .run();
    await this.deps.gatewaySql
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

function mapGrantRow(row: BrowserSessionGrantRow): BrowserSessionGrantRecord {
  return {
    grantId: row.grant_id,
    sessionId: row.session_id,
    actorId: row.actor_id,
    scopes: parseJson(row.scopes_json, []).filter(isScope),
    allowedHosts: parseJson(row.allowed_hosts_json, []),
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function mapEventRow(row: BrowserSessionEventRow): BrowserSessionEventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    actorId: row.actor_id ?? undefined,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function createUnavailableBrowserSessionStateSummary(): BrowserSessionStateSummary {
  return {
    availability: "not_available",
    source: "policy_engine_memory",
    retention: "volatile",
    valuesHidden: true,
    cookies: { count: 0, domains: [] },
    localStorage: { originCount: 0, keyCount: 0, origins: [] },
    sessionStorage: { originCount: 0, keyCount: 0, origins: [] },
    context: {
      geolocationConfigured: false,
      extraHTTPHeadersCount: 0,
      httpCredentialsConfigured: false,
    },
  };
}

function summarizeBrowserSessionEvents(
  events: BrowserSessionEventRecord[],
): BrowserSessionStateProjection["eventSummary"] {
  const lastAccessAt = events.find((event) => event.eventType === "tool_access_granted")?.createdAt;
  const lastStateMutationAt = events.find(isBrowserSessionStateMutationEvidence)?.createdAt;
  return {
    recentEventCount: events.length,
    guardBlockCount: events.filter((event) => event.eventType === "tool_guard_blocked").length,
    grantedAccessCount: events.filter((event) => event.eventType === "tool_access_granted").length,
    lastAccessAt,
    lastStateMutationAt,
  };
}

function isBrowserSessionStateMutationEvidence(event: BrowserSessionEventRecord): boolean {
  if (event.eventType === "session_created" || event.eventType === "session_closed") {
    return true;
  }
  if (event.eventType !== "tool_access_granted") {
    return false;
  }
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : undefined;
  return Boolean(
    toolName &&
    [
      "browser.interact",
      "browser.cookies.set",
      "browser.cookies.clear",
      "browser.storage.set",
      "browser.storage.clear",
      "browser.context.configure",
    ].includes(toolName),
  );
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

function parseJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
