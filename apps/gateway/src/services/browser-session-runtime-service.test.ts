import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BrowserSessionRuntimeService } from "./browser-session-runtime-service.js";

describe("BrowserSessionRuntimeService", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates local sessions, enforces scoped grants, and records events", async () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({ gatewaySql: db });
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
    const service = new BrowserSessionRuntimeService({ gatewaySql: db });
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
      gatewaySql: db,
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

  it("returns an explicit unavailable state when volatile state is absent", async () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({ gatewaySql: db });
    const session = await service.createSession({ actorId: "operator" });

    expect((await service.getStateProjection(session.sessionId)).state).toMatchObject({
      availability: "not_available",
      valuesHidden: true,
      cookies: { count: 0, domains: [] },
      localStorage: { originCount: 0, keyCount: 0, origins: [] },
    });
  });
});
