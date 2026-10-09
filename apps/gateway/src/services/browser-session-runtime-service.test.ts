import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BrowserSessionRuntimeService } from "./browser-session-runtime-service.js";

type SqlHook = (sql: string) => void;

/** node:sqlite with the Gateway's immediate-transaction contract; hooks inject failures and races. */
function transactionalSql(db: DatabaseSync, beforeRun?: SqlHook, afterGet?: SqlHook) {
  return {
    dialect: "sqlite" as const,
    exec: (sql: string) => db.exec(sql),
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        run: (...params: Parameters<typeof statement.run>) => {
          beforeRun?.(sql);
          return statement.run(...params);
        },
        get: (...params: Parameters<typeof statement.get>) => {
          const row = statement.get(...params);
          afterGet?.(sql);
          return row;
        },
        all: (...params: Parameters<typeof statement.all>) => statement.all(...params),
      };
    },
    async runImmediateTransaction<T>(callback: () => T | Promise<T>): Promise<Awaited<T>> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await callback();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as never;
}

describe("BrowserSessionRuntimeService", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates local sessions, enforces scoped grants, and records events", async () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
    const session = await service.createSession({ actorId: "operator", label: "Review browser" });

    await expect(
      service.assertAccess({ sessionId: session.sessionId, actorId: "agent", requiredScope: "read" }),
    ).rejects.toThrow(/does not grant read access/i);

    const grant = await service.createGrant(
      session.sessionId,
      {
        actorId: "agent",
        scopes: ["read"],
        allowedHosts: ["example.com"],
      },
      "operator",
    );

    expect(grant.allowedHosts).toEqual(["example.com"]);
    await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(1);
    await expect(service.listGrants(session.sessionId, { status: "revoked" })).resolves.toHaveLength(0);
    await expect(
      service.assertAccess({
        sessionId: session.sessionId,
        actorId: "agent",
        requiredScope: "read",
        host: "https://example.com/page",
        toolName: "browser.navigate",
        runId: "run-browser-1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertAccess({
        sessionId: session.sessionId,
        actorId: "agent",
        requiredScope: "interact",
        host: "example.com",
      }),
    ).rejects.toThrow(/does not grant interact access/i);
    await service.revokeGrant(session.sessionId, grant.grantId, "operator");
    await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(0);
    await expect(service.listGrants(session.sessionId, { status: "revoked" })).resolves.toHaveLength(1);
    const events = await service.listEvents(session.sessionId);
    const grantCreatedEvent = events.find(
      (event) => event.eventType === "grant_created" && event.payload.grantId === grant.grantId,
    );
    const toolAccessEvent = events.find((event) => event.eventType === "tool_access_granted");
    expect(grantCreatedEvent).toMatchObject({
      actorId: "operator",
      payload: {
        grantActorId: "agent",
      },
    });
    expect(toolAccessEvent).toMatchObject({
      actorId: "agent",
      payload: {
        requiredScope: "read",
        host: "example.com",
        toolName: "browser.navigate",
        runId: "run-browser-1",
      },
    });
  });

  it("revokes active grants when a session closes", async () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
    const session = await service.createSession({ actorId: "operator" });
    await service.createGrant(session.sessionId, { actorId: "agent", scopes: ["admin"] });

    await service.closeSession(session.sessionId, "operator");

    await expect(service.getSession(session.sessionId)).resolves.toMatchObject({ status: "closed" });
    await expect(
      service.assertAccess({
        sessionId: session.sessionId,
        actorId: "agent",
        requiredScope: "read",
        toolName: "browser.extract",
        runId: "run-closed-browser",
      }),
    ).rejects.toThrow(/closed/i);
    expect(await service.listEvents(session.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "tool_guard_blocked",
          actorId: "agent",
          payload: expect.objectContaining({
            reason: "closed_session",
            toolName: "browser.extract",
            runId: "run-closed-browser",
          }),
        }),
      ]),
    );
  });

  it("projects volatile browser state without exposing stored values", async () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({
      gatewaySql: transactionalSql(db),
      describeState: () => ({
        availability: "present",
        source: "policy_engine_memory",
        retention: "volatile",
        valuesHidden: true,
        updatedAt: "2026-05-30T18:06:00.000Z",
        cookies: { count: 2, domains: ["example.com"] },
        localStorage: { originCount: 1, keyCount: 3, origins: ["https://example.com"] },
        sessionStorage: { originCount: 1, keyCount: 1, origins: ["https://example.com"] },
        context: {
          locale: "en-US",
          timezoneId: "America/Los_Angeles",
          geolocationConfigured: true,
          extraHTTPHeadersCount: 1,
          httpCredentialsConfigured: true,
        },
      }),
    });
    const session = await service.createSession({ actorId: "operator", label: "State browser" });
    await service.createGrant(session.sessionId, {
      actorId: "agent",
      scopes: ["state"],
      allowedHosts: ["example.com"],
    });
    await service.assertAccess({
      sessionId: session.sessionId,
      actorId: "agent",
      requiredScope: "state",
      host: "example.com",
      toolName: "browser.storage.set",
      runId: "run-state",
    });

    const projection = await service.getStateProjection(session.sessionId);

    expect(projection.session).toMatchObject({ sessionId: session.sessionId, label: "State browser" });
    expect(projection.state).toMatchObject({
      availability: "present",
      valuesHidden: true,
      cookies: { count: 2, domains: ["example.com"] },
      localStorage: { originCount: 1, keyCount: 3, origins: ["https://example.com"] },
      context: {
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
        geolocationConfigured: true,
        extraHTTPHeadersCount: 1,
        httpCredentialsConfigured: true,
      },
    });
    expect(projection.eventSummary).toMatchObject({
      recentEventCount: 3,
      guardBlockCount: 0,
      grantedAccessCount: 1,
    });
    expect(JSON.stringify(projection)).not.toContain("secret");
  });

  describe("grant rotation and replay", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function setup(ttlSeconds?: number) {
      db = new DatabaseSync(":memory:");
      const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
      const session = await service.createSession({ actorId: "operator", label: "Rotation" });
      const grant = await service.createGrant(
        session.sessionId,
        { actorId: "agent", scopes: ["read", "interact"], allowedHosts: ["example.com"], ttlSeconds },
        "operator",
      );
      return { service, session, grant };
    }

    it("returns the recorded successor when a rotation is replayed instead of minting another grant", async () => {
      const { service, session, grant } = await setup(3600);
      const first = await service.rotateGrant(session.sessionId, grant.grantId, "operator");
      const replay = await service.rotateGrant(session.sessionId, grant.grantId, "operator");
      expect(replay).toEqual(first);
      const active = await service.listGrants(session.sessionId, { status: "active" });
      expect(active.map((row) => row.grantId)).toEqual([first.grantId]);
      expect(first).toMatchObject({ actorId: "agent", scopes: ["read", "interact"], allowedHosts: ["example.com"] });
    });

    it("shares one in-flight rotation so concurrent requests create one successor", async () => {
      const { service, session, grant } = await setup(3600);
      const [left, right] = await Promise.all([
        service.rotateGrant(session.sessionId, grant.grantId, "operator"),
        service.rotateGrant(session.sessionId, grant.grantId, "operator"),
      ]);
      expect(right).toEqual(left);
      await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(1);
    });

    it("keeps the original expiry exactly, and keeps a non-expiring grant non-expiring", async () => {
      const timed = await setup(3600);
      const rotated = await timed.service.rotateGrant(timed.session.sessionId, timed.grant.grantId, "operator");
      expect(rotated.expiresAt).toBe(timed.grant.expiresAt);
      db?.close();
      const open = await setup();
      const rotatedOpen = await open.service.rotateGrant(open.session.sessionId, open.grant.grantId, "operator");
      expect(rotatedOpen.expiresAt).toBeUndefined();
    });

    it("refuses to rotate a revoked grant, so rotation never restores withdrawn authority", async () => {
      const { service, session, grant } = await setup(3600);
      await service.revokeGrant(session.sessionId, grant.grantId, "operator");
      await expect(service.rotateGrant(session.sessionId, grant.grantId, "operator")).rejects.toMatchObject({
        httpStatus: 409,
      });
      await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(0);
    });

    it("refuses to rotate an expired grant instead of creating one without expiry", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
      const { service, session, grant } = await setup(60);
      vi.setSystemTime(new Date("2026-10-07T12:01:01.000Z"));
      await expect(service.rotateGrant(session.sessionId, grant.grantId, "operator")).rejects.toMatchObject({
        httpStatus: 409,
      });
      const all = await service.listGrants(session.sessionId, { status: "all" });
      expect(all).toHaveLength(1);
      expect(all[0]!.revokedAt).toBeUndefined();
    });

    it("refuses to rotate a grant on a closed session", async () => {
      const { service, session, grant } = await setup(3600);
      await service.closeSession(session.sessionId, "operator");
      await expect(service.rotateGrant(session.sessionId, grant.grantId, "operator")).rejects.toMatchObject({
        httpStatus: 409,
      });
      await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(0);
    });

    it("refuses a request ID replayed with a different expiry", async () => {
      db = new DatabaseSync(":memory:");
      const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
      const session = await service.createSession({ actorId: "operator" });
      const input = {
        actorId: "agent",
        scopes: ["read" as const],
        ttlSeconds: 60,
        requestId: "1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a",
      };
      await service.createGrant(session.sessionId, input, "operator");
      await expect(
        service.createGrant(session.sessionId, { ...input, ttlSeconds: 7 * 24 * 60 * 60 }, "operator"),
      ).rejects.toMatchObject({ httpStatus: 409 });
      await expect(service.listGrants(session.sessionId, { status: "all" })).resolves.toHaveLength(1);
    });

    it("rolls back a grant whose request-ID event cannot be written, so a replay creates exactly one", async () => {
      db = new DatabaseSync(":memory:");
      let failEvent = false;
      const service = new BrowserSessionRuntimeService({
        gatewaySql: transactionalSql(db, (sql) => {
          if (failEvent && sql.includes("INSERT INTO browser_session_events")) {
            failEvent = false;
            throw new Error("event write failed");
          }
        }),
      });
      const session = await service.createSession({ actorId: "operator" });
      const input = {
        actorId: "agent",
        scopes: ["read" as const],
        ttlSeconds: 3600,
        requestId: "2e3d4c5b-6a7f-4e8d-9c0b-1a2f3e4d5c6b",
      };
      failEvent = true;
      await expect(service.createGrant(session.sessionId, input, "operator")).rejects.toThrow("event write failed");
      await expect(service.listGrants(session.sessionId, { status: "all" })).resolves.toHaveLength(0);
      await service.createGrant(session.sessionId, input, "operator");
      await expect(service.listGrants(session.sessionId, { status: "all" })).resolves.toHaveLength(1);
    });

    it("rolls back a session whose request-ID event cannot be written", async () => {
      db = new DatabaseSync(":memory:");
      let failEvent = true;
      const service = new BrowserSessionRuntimeService({
        gatewaySql: transactionalSql(db, (sql) => {
          if (failEvent && sql.includes("INSERT INTO browser_session_events")) {
            failEvent = false;
            throw new Error("event write failed");
          }
        }),
      });
      const input = { workspaceId: "w", label: "L", requestId: "3f4e5d6c-7b8a-4f9e-8d1c-2b3a4f5e6d7c" };
      await expect(service.createSession(input)).rejects.toThrow("event write failed");
      await expect(service.listSessions({ status: "all" })).resolves.toHaveLength(0);
      await service.createSession(input);
      await expect(service.listSessions({ status: "all" })).resolves.toHaveLength(1);
    });

    it("refuses a rotation whose grant is revoked mid-rotation and creates no successor", async () => {
      db = new DatabaseSync(":memory:");
      let raced = false;
      const service = new BrowserSessionRuntimeService({
        gatewaySql: transactionalSql(db, (sql) => {
          // A competing revoke lands just before the rotation's conditional revoke.
          if (!raced && sql.includes("revoked_at IS NULL") && sql.includes("grant_id = @grantId")) {
            raced = true;
            db!.prepare("UPDATE browser_session_grants SET revoked_at = 'raced'").run();
          }
        }),
      });
      const session = await service.createSession({ actorId: "operator" });
      const grant = await service.createGrant(session.sessionId, {
        actorId: "agent",
        scopes: ["read"],
        ttlSeconds: 3600,
      });
      await expect(service.rotateGrant(session.sessionId, grant.grantId, "operator")).rejects.toMatchObject({
        httpStatus: 409,
      });
      const all = await service.listGrants(session.sessionId, { status: "all" });
      expect(all.map((row) => row.grantId)).toEqual([grant.grantId]);
    });

    it("refuses a grant when the session closes between the pre-check and the insert", async () => {
      db = new DatabaseSync(":memory:");
      let armed = false;
      const service = new BrowserSessionRuntimeService({
        gatewaySql: transactionalSql(db, undefined, (sql) => {
          // A competing close commits right after the pre-transaction session read.
          if (armed && sql.includes("FROM browser_sessions WHERE session_id")) {
            armed = false;
            db!.prepare("UPDATE browser_sessions SET status = 'closed'").run();
          }
        }),
      });
      const session = await service.createSession({ actorId: "operator" });
      armed = true;
      await expect(
        service.createGrant(session.sessionId, { actorId: "agent", scopes: ["read"], ttlSeconds: 3600 }),
      ).rejects.toThrow(/closed browser session/i);
      await expect(service.listGrants(session.sessionId, { status: "all" })).resolves.toHaveLength(0);
    });

    it("finishes revoking grants when a session was left closed with an active grant", async () => {
      db = new DatabaseSync(":memory:");
      const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
      const session = await service.createSession({ actorId: "operator" });
      await service.createGrant(session.sessionId, { actorId: "agent", scopes: ["read"], ttlSeconds: 3600 });
      // Simulate an interrupted earlier close: the session row closed, its grant still active.
      db.prepare("UPDATE browser_sessions SET status = 'closed', closed_at = '2026-10-07T00:00:00.000Z'").run();
      const closed = await service.closeSession(session.sessionId, "operator");
      expect(closed.status).toBe("closed");
      await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(0);
    });

    it("closes a session and revokes its grants together", async () => {
      db = new DatabaseSync(":memory:");
      let failRevoke = true;
      const service = new BrowserSessionRuntimeService({
        gatewaySql: transactionalSql(db, (sql) => {
          if (failRevoke && sql.includes("UPDATE browser_sessions")) {
            failRevoke = false;
            throw new Error("close write failed");
          }
        }),
      });
      const session = await service.createSession({ actorId: "operator" });
      await service.createGrant(session.sessionId, { actorId: "agent", scopes: ["read"], ttlSeconds: 3600 });
      await expect(service.closeSession(session.sessionId, "operator")).rejects.toThrow("close write failed");
      // Rolled back together: neither the grant revocation nor the close persisted.
      await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(1);
      expect((await service.getSession(session.sessionId)).status).toBe("active");
    });

    it("replays a session request by its request ID and refuses a different session under the same ID", async () => {
      db = new DatabaseSync(":memory:");
      const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
      const input = {
        actorId: "operator",
        workspaceId: "workspace-1",
        label: "Research",
        requestId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      };
      const first = await service.createSession(input);
      const replay = await service.createSession(input);
      expect(replay).toEqual(first);
      await expect(service.listSessions({ workspaceId: "workspace-1" })).resolves.toHaveLength(1);
      await expect(service.createSession({ ...input, label: "Other" })).rejects.toMatchObject({ httpStatus: 409 });
      await expect(service.createSession({ ...input, workspaceId: "workspace-2" })).rejects.toMatchObject({
        httpStatus: 409,
      });
      await expect(service.listSessions({ status: "all" })).resolves.toHaveLength(1);
    });

    it("replays a grant request by its request ID and refuses a different grant under the same ID", async () => {
      db = new DatabaseSync(":memory:");
      const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
      const session = await service.createSession({ actorId: "operator" });
      const input = {
        actorId: "agent",
        scopes: ["read" as const],
        allowedHosts: ["example.com"],
        ttlSeconds: 3600,
        requestId: "6f4b7f5e-2a4f-4c8e-9d0a-1b2c3d4e5f60",
      };
      const first = await service.createGrant(session.sessionId, input, "operator");
      const replay = await service.createGrant(session.sessionId, input, "operator");
      expect(replay).toEqual(first);
      await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(1);
      await expect(
        service.createGrant(session.sessionId, { ...input, scopes: ["admin"] }, "operator"),
      ).rejects.toMatchObject({ httpStatus: 409 });
      await expect(service.listGrants(session.sessionId, { status: "active" })).resolves.toHaveLength(1);
    });
  });

  it("returns an explicit unavailable state when volatile state is absent", async () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) });
    const session = await service.createSession({ actorId: "operator" });

    expect((await service.getStateProjection(session.sessionId)).state).toMatchObject({
      availability: "not_available",
      valuesHidden: true,
      cookies: { count: 0, domains: [] },
      localStorage: { originCount: 0, keyCount: 0, origins: [] },
    });
  });
});
