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

    const grant = service.createGrant(session.sessionId, {
      actorId: "agent",
      scopes: ["read"],
      allowedHosts: ["example.com"],
    });

    expect(grant.allowedHosts).toEqual(["example.com"]);
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
    expect(service.listEvents(session.sessionId).map((event) => event.eventType)).toContain("grant_created");
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
