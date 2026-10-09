import { randomUUID } from "node:crypto";
import {
  ConflictError,
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
import {
  findBrowserSessionEventPayload,
  findSessionCreatedByRequestId,
  runBrowserSessionTransaction,
} from "./browser-session-request-replay.js";

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
  private readonly rotating = new Map<string, Promise<BrowserSessionGrantRecord>>();
  private readonly granting = new Map<string, { fingerprint: string; grant: Promise<BrowserSessionGrantRecord> }>();
  private readonly creatingSessions = new Map<string, Promise<BrowserSessionRecord>>();

  public constructor(private readonly deps: BrowserSessionRuntimeDependencies) {}

  public async createSession(input: BrowserSessionCreateInput = {}): Promise<BrowserSessionRecord> {
    const requestId = input.requestId?.trim();
    if (!requestId) {
      return await this.insertSession(input);
    }
    const inFlight = this.creatingSessions.get(requestId);
    if (inFlight) {
      const session = await inFlight;
      assertSameSessionRequest(session, input);
      return session;
    }
    const pending = this.createRequestedSession(requestId, input).finally(() =>
      this.creatingSessions.delete(requestId),
    );
    this.creatingSessions.set(requestId, pending);
    return await pending;
  }

  private async createRequestedSession(
    requestId: string,
    input: BrowserSessionCreateInput,
  ): Promise<BrowserSessionRecord> {
    await this.waitForSchema();
    const priorSessionId = await findSessionCreatedByRequestId(this.deps, requestId);
    if (priorSessionId) {
      const session = await this.requireSession(priorSessionId);
      assertSameSessionRequest(session, input);
      return session;
    }
    return await this.insertSession(input, requestId);
  }

  private async insertSession(input: BrowserSessionCreateInput, requestId?: string): Promise<BrowserSessionRecord> {
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
    // The row and its request-ID event commit together, so a replay can always find what it created.
    await this.transaction(async () => {
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
      await this.recordEvent(session.sessionId, "session_created", session.createdBy, {
        label: session.label,
        ...(requestId ? { requestId } : {}),
      });
    });
    await this.publish("browser_session_created", { sessionId: session.sessionId, workspaceId: session.workspaceId });
    return session;
  }

  private async transaction<T>(callback: () => Promise<T>): Promise<T> {
    return await runBrowserSessionTransaction(this.deps, callback);
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
    await this.requireSession(sessionId);
    const now = new Date().toISOString();
    // Grants are revoked and the session closed in one transaction. A replay on an
    // already-closed session still finishes any revocation an earlier close left behind.
    const changed = await this.transaction(async () => {
      const revoked = await this.deps.gatewaySql
        .prepare(
          `
          UPDATE browser_session_grants
          SET revoked_at = @revokedAt
          WHERE session_id = @sessionId AND revoked_at IS NULL
        `,
        )
        .run({ sessionId, revokedAt: now });
      const closed = await this.deps.gatewaySql
        .prepare(
          `
          UPDATE browser_sessions
          SET status = 'closed', updated_at = @updatedAt, closed_at = @closedAt
          WHERE session_id = @sessionId AND status = 'active'
        `,
        )
        .run({ sessionId, updatedAt: now, closedAt: now });
      if (closed.changes === 0 && revoked.changes === 0) {
        return false;
      }
      await this.recordEvent(sessionId, "session_closed", actorId, {
        revokedGrantCount: revoked.changes,
        ...(closed.changes === 0 ? { completedEarlierClose: true } : {}),
      });
      return true;
    });
    if (changed) {
      await this.publish("browser_session_closed", { sessionId });
    }
    return await this.requireSession(sessionId);
  }

  public async createGrant(
    sessionId: string,
    input: BrowserSessionGrantInput,
    actorId = "operator",
  ): Promise<BrowserSessionGrantRecord> {
    const requestId = input.requestId?.trim();
    if (!requestId) {
      return await this.insertGrant(sessionId, input, actorId);
    }
    // A request ID makes a lost response replayable: the same request returns the same grant.
    const key = JSON.stringify([sessionId, requestId]);
    const fingerprint = grantRequestFingerprint(input);
    const inFlight = this.granting.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw grantRequestConflict();
      return await inFlight.grant;
    }
    const grant = this.createRequestedGrant(sessionId, requestId, fingerprint, input, actorId).finally(() =>
      this.granting.delete(key),
    );
    this.granting.set(key, { fingerprint, grant });
    return await grant;
  }

  private async createRequestedGrant(
    sessionId: string,
    requestId: string,
    fingerprint: string,
    input: BrowserSessionGrantInput,
    actorId: string,
  ): Promise<BrowserSessionGrantRecord> {
    await this.waitForSchema();
    await this.requireSession(sessionId);
    const prior = await this.findEventPayload(sessionId, "grant_created", "requestId", requestId);
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw grantRequestConflict();
      return await this.requireGrant(sessionId, String(prior.grantId));
    }
    return await this.insertGrant(sessionId, input, actorId, { requestId, requestFingerprint: fingerprint });
  }

  private async insertGrant(
    sessionId: string,
    input: BrowserSessionGrantInput,
    actorId: string,
    request: { requestId?: string; requestFingerprint?: string } = {},
  ): Promise<BrowserSessionGrantRecord> {
    await this.waitForSchema();
    const session = await this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new ValidationError({ message: "Cannot create a grant for a closed browser session." });
    }
    const grant = buildGrant(sessionId, input, input.ttlSeconds ? ttlExpiry(input.ttlSeconds) : undefined);
    // The row and its request-ID event commit together, so a replay can always find what it created.
    await this.transaction(async () => {
      // Re-checked inside the transaction: a close that committed after the check above wins.
      if ((await this.requireSession(sessionId)).status !== "active") {
        throw new ValidationError({ message: "Cannot create a grant for a closed browser session." });
      }
      await this.writeGrant(grant, actorId, request);
    });
    await this.publish("browser_session_grant_created", { sessionId, grantId: grant.grantId });
    return grant;
  }

  /** Inserts a grant row and its creation event. Callers own the surrounding transaction. */
  private async writeGrant(
    grant: BrowserSessionGrantRecord,
    actorId: string,
    request: { requestId?: string; requestFingerprint?: string } = {},
  ): Promise<void> {
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
    await this.recordEvent(grant.sessionId, "grant_created", actorId, {
      grantId: grant.grantId,
      grantActorId: grant.actorId,
      scopes: grant.scopes,
      allowedHosts: grant.allowedHosts,
      ...(request.requestId ? { requestId: request.requestId, requestFingerprint: request.requestFingerprint } : {}),
    });
  }

  public async revokeGrant(
    sessionId: string,
    grantId: string,
    actorId = "operator",
  ): Promise<BrowserSessionGrantRecord> {
    await this.waitForSchema();
    await this.requireSession(sessionId);
    await this.requireGrant(sessionId, grantId);
    const now = new Date().toISOString();
    // Conditional: only the request that actually revokes records the event.
    const changed = await this.transaction(async () => {
      if (!(await this.revokeIfActive(sessionId, grantId, now))) return false;
      await this.recordEvent(sessionId, "grant_revoked", actorId, { grantId });
      return true;
    });
    if (changed) {
      await this.publish("browser_session_grant_revoked", { sessionId, grantId });
    }
    return await this.requireGrant(sessionId, grantId);
  }

  private async revokeIfActive(sessionId: string, grantId: string, revokedAt: string): Promise<boolean> {
    const result = await this.deps.gatewaySql
      .prepare(
        `
        UPDATE browser_session_grants
        SET revoked_at = @revokedAt
        WHERE session_id = @sessionId AND grant_id = @grantId AND revoked_at IS NULL
      `,
      )
      .run({ sessionId, grantId, revokedAt });
    return result.changes === 1;
  }

  public async rotateGrant(
    sessionId: string,
    grantId: string,
    actorId = "operator",
  ): Promise<BrowserSessionGrantRecord> {
    const key = JSON.stringify([sessionId, grantId]);
    const inFlight = this.rotating.get(key);
    if (inFlight) {
      return await inFlight;
    }
    const pending = this.rotateGrantOnce(sessionId, grantId, actorId).finally(() => this.rotating.delete(key));
    this.rotating.set(key, pending);
    return await pending;
  }

  private async rotateGrantOnce(
    sessionId: string,
    grantId: string,
    actorId: string,
  ): Promise<BrowserSessionGrantRecord> {
    await this.waitForSchema();
    const session = await this.requireSession(sessionId);
    const current = await this.requireGrant(sessionId, grantId);
    if (current.revokedAt) {
      // A replayed rotation returns its recorded successor; any other revoked grant stays withdrawn.
      const prior = await this.findEventPayload(sessionId, "grant_rotated", "previousGrantId", grantId);
      if (prior) {
        return await this.requireGrant(sessionId, String(prior.grantId));
      }
      throw new ConflictError({ message: "This grant is revoked. Rotation cannot restore withdrawn access." });
    }
    if (session.status !== "active") {
      throw new ConflictError({ message: "Cannot rotate a grant on a closed browser session." });
    }
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) {
      throw new ConflictError({ message: "This grant has expired. Rotation cannot extend it." });
    }
    // The successor keeps the exact original expiry, or none when the original had none.
    const successor = buildGrant(
      sessionId,
      { actorId: current.actorId, scopes: current.scopes, allowedHosts: current.allowedHosts },
      current.expiresAt,
    );
    const now = new Date().toISOString();
    await this.transaction(async () => {
      // Re-checked inside the transaction: a concurrent close or revoke wins, and no successor is created.
      if ((await this.requireSession(sessionId)).status !== "active") {
        throw new ConflictError({ message: "Cannot rotate a grant on a closed browser session." });
      }
      if (!(await this.revokeIfActive(sessionId, grantId, now))) {
        throw new ConflictError({
          message: "This grant was revoked while rotating. Rotation cannot restore withdrawn access.",
        });
      }
      await this.recordEvent(sessionId, "grant_revoked", actorId, { grantId });
      await this.writeGrant(successor, actorId);
      await this.recordEvent(sessionId, "grant_rotated", actorId, {
        previousGrantId: grantId,
        grantId: successor.grantId,
      });
    });
    await this.publish("browser_session_grant_revoked", { sessionId, grantId });
    await this.publish("browser_session_grant_created", { sessionId, grantId: successor.grantId });
    return successor;
  }

  /** The newest event of this type whose payload field equals the value, with a string grant ID. */
  private async findEventPayload(
    sessionId: string,
    eventType: BrowserSessionEventType,
    field: "requestId" | "previousGrantId",
    value: string,
  ): Promise<Record<string, unknown> | undefined> {
    return await findBrowserSessionEventPayload(this.deps, sessionId, eventType, field, value);
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

/** A replayed session request must name the same workspace and label. */
function assertSameSessionRequest(session: BrowserSessionRecord, input: BrowserSessionCreateInput): void {
  const label = input.label?.trim() || "Shared browser session";
  if (session.workspaceId !== (input.workspaceId?.trim() || undefined) || session.label !== label) {
    throw new ConflictError({
      code: "ALREADY_EXISTS",
      message: "This request ID already created a different browser session. Refresh sessions before creating another.",
    });
  }
}

/** The exact normalized grant request: actor, scopes, hosts and expiry duration. */
function grantRequestFingerprint(input: BrowserSessionGrantInput): string {
  return JSON.stringify([
    requireTrimmed(input.actorId, "actorId"),
    [...normalizeScopes(input.scopes)].sort(),
    [...normalizeHosts(input.allowedHosts)].sort(),
    input.ttlSeconds ? normalizeTtl(input.ttlSeconds) : null,
  ]);
}

function grantRequestConflict(): ConflictError {
  return new ConflictError({
    code: "ALREADY_EXISTS",
    message: "This request ID already created a different grant. Refresh grants before requesting again.",
  });
}

function ttlExpiry(ttlSeconds: number): string {
  return new Date(Date.now() + normalizeTtl(ttlSeconds) * 1000).toISOString();
}

function buildGrant(
  sessionId: string,
  input: Pick<BrowserSessionGrantInput, "actorId" | "scopes" | "allowedHosts">,
  expiresAt: string | undefined,
): BrowserSessionGrantRecord {
  return {
    grantId: randomUUID(),
    sessionId,
    actorId: requireTrimmed(input.actorId, "actorId"),
    scopes: normalizeScopes(input.scopes),
    allowedHosts: normalizeHosts(input.allowedHosts),
    createdAt: new Date().toISOString(),
    expiresAt,
  };
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
