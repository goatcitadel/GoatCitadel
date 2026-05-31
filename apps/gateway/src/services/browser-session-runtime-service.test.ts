import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BrowserSessionRuntimeService } from "./browser-session-runtime-service.js";

describe("BrowserSessionRuntimeService", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates local sessions, enforces scoped grants, and records events", () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({ gatewaySql: db });
    const session = service.createSession({ actorId: "operator", label: "Review browser" });

    expect(() =>
      service.assertAccess({ sessionId: session.sessionId, actorId: "agent", requiredScope: "read" }),
    ).toThrow(/does not grant read access/i);

    const grant = service.createGrant(
      session.sessionId,
      {
        actorId: "agent",
        scopes: ["read"],
        allowedHosts: ["example.com"],
      },
      "operator",
    );

    expect(grant.allowedHosts).toEqual(["example.com"]);
    expect(service.listGrants(session.sessionId, { status: "active" })).toHaveLength(1);
    expect(service.listGrants(session.sessionId, { status: "revoked" })).toHaveLength(0);
    expect(() =>
      service.assertAccess({
        sessionId: session.sessionId,
        actorId: "agent",
        requiredScope: "read",
        host: "https://example.com/page",
      }),
    ).not.toThrow();
    expect(() =>
      service.assertAccess({
        sessionId: session.sessionId,
        actorId: "agent",
        requiredScope: "interact",
        host: "example.com",
      }),
    ).toThrow(/does not grant interact access/i);
    service.revokeGrant(session.sessionId, grant.grantId, "operator");
    expect(service.listGrants(session.sessionId, { status: "active" })).toHaveLength(0);
    expect(service.listGrants(session.sessionId, { status: "revoked" })).toHaveLength(1);
    const grantCreatedEvent = service
      .listEvents(session.sessionId)
      .find((event) => event.eventType === "grant_created" && event.payload.grantId === grant.grantId);
    expect(grantCreatedEvent).toMatchObject({
      actorId: "operator",
      payload: {
        grantActorId: "agent",
      },
    });
  });

  it("revokes active grants when a session closes", () => {
    db = new DatabaseSync(":memory:");
    const service = new BrowserSessionRuntimeService({ gatewaySql: db });
    const session = service.createSession({ actorId: "operator" });
    service.createGrant(session.sessionId, { actorId: "agent", scopes: ["admin"] });

    service.closeSession(session.sessionId, "operator");

    expect(service.getSession(session.sessionId)).toMatchObject({ status: "closed" });
    expect(() =>
      service.assertAccess({ sessionId: session.sessionId, actorId: "agent", requiredScope: "read" }),
    ).toThrow(/closed/i);
  });
});
