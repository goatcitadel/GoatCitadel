import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DatabaseSync } from "node:sqlite";
import { BrowserSessionRuntimeService } from "../services/browser-session-runtime-service.js";
import { browserSessionsRoutes } from "./browser-sessions.js";

/** node:sqlite with the Gateway's immediate-transaction contract. */
function transactionalSql(db: DatabaseSync) {
  return {
    dialect: "sqlite" as const,
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
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

describe("browser session routes", () => {
  let app: FastifyInstance | undefined;
  let db: DatabaseSync | undefined;

  afterEach(async () => {
    await app?.close();
    db?.close();
    app = undefined;
    db = undefined;
  });

  async function buildApp() {
    app = Fastify();
    db = new DatabaseSync(":memory:");
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("gatewayRuntime", {
      browserSessionRuntimeService: new BrowserSessionRuntimeService({ gatewaySql: transactionalSql(db) }),
    });
    await app.register(browserSessionsRoutes);
    return app;
  }

  it("creates sessions, lists grants, rotates grants, and records events", async () => {
    const fastify = await buildApp();
    const created = await fastify.inject({
      method: "POST",
      url: "/api/v1/browser-sessions",
      payload: { workspaceId: "workspace-1", label: "Research browser" },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json();

    const grant = await fastify.inject({
      method: "POST",
      url: `/api/v1/browser-sessions/${session.sessionId}/grants`,
      payload: { actorId: "agent-1", scopes: ["read", "state"], allowedHosts: ["example.com"], ttlSeconds: 300 },
    });
    expect(grant.statusCode).toBe(201);
    const grantBody = grant.json();

    const grants = await fastify.inject({
      method: "GET",
      url: `/api/v1/browser-sessions/${session.sessionId}/grants?status=active`,
    });
    expect(grants.statusCode).toBe(200);
    expect(grants.json()).toMatchObject([{ grantId: grantBody.grantId, actorId: "agent-1" }]);

    const rotated = await fastify.inject({
      method: "POST",
      url: `/api/v1/browser-sessions/${session.sessionId}/grants/${grantBody.grantId}/rotate`,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().grantId).not.toBe(grantBody.grantId);

    const events = await fastify.inject({
      method: "GET",
      url: `/api/v1/browser-sessions/${session.sessionId}/events?limit=10`,
    });
    expect(events.statusCode).toBe(200);
    const eventBody = events.json();
    expect(eventBody.map((item: { eventType: string }) => item.eventType)).toContain("grant_rotated");
    const createdGrantEvent = eventBody.find(
      (item: { eventType: string; payload?: { grantId?: string } }) =>
        item.eventType === "grant_created" && item.payload?.grantId === grantBody.grantId,
    );
    expect(createdGrantEvent).toMatchObject({
      actorId: "operator-test",
      payload: {
        grantActorId: "agent-1",
      },
    });

    const state = await fastify.inject({
      method: "GET",
      url: `/api/v1/browser-sessions/${session.sessionId}/state`,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      session: { sessionId: session.sessionId, label: "Research browser" },
      state: {
        availability: "not_available",
        valuesHidden: true,
        cookies: { count: 0, domains: [] },
      },
      eventSummary: {
        recentEventCount: expect.any(Number),
        guardBlockCount: 0,
        grantedAccessCount: 0,
      },
    });
  });

  it("rejects invalid grant scopes without creating runtime state", async () => {
    const fastify = await buildApp();
    const created = await fastify.inject({ method: "POST", url: "/api/v1/browser-sessions", payload: {} });
    const response = await fastify.inject({
      method: "POST",
      url: `/api/v1/browser-sessions/${created.json().sessionId}/grants`,
      payload: { actorId: "agent-1", scopes: ["write"] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("replays a grant by request ID, rejects malformed IDs and refuses rotating a revoked grant", async () => {
    const fastify = await buildApp();
    const created = await fastify.inject({ method: "POST", url: "/api/v1/browser-sessions", payload: {} });
    const url = `/api/v1/browser-sessions/${created.json().sessionId}/grants`;
    const payload = {
      actorId: "agent-1",
      scopes: ["read"],
      ttlSeconds: 3600,
      requestId: "0b8f2c1e-7d3a-4e5f-8a9b-1c2d3e4f5a6b",
    };

    const malformed = await fastify.inject({ method: "POST", url, payload: { ...payload, requestId: "not-a-uuid" } });
    expect(malformed.statusCode).toBe(400);
    const first = await fastify.inject({ method: "POST", url, payload });
    const replay = await fastify.inject({ method: "POST", url, payload });
    expect(first.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const active = await fastify.inject({ method: "GET", url: `${url}?status=active` });
    expect(active.json()).toHaveLength(1);

    const grantId = first.json().grantId;
    await fastify.inject({ method: "DELETE", url: `${url}/${grantId}` });
    const rotateRevoked = await fastify.inject({ method: "POST", url: `${url}/${grantId}/rotate` });
    expect(rotateRevoked.statusCode).toBe(409);
  });

  it("returns 404 for a missing browser session state projection", async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({
      method: "GET",
      url: "/api/v1/browser-sessions/missing-session/state",
    });

    expect(response.statusCode).toBe(404);
  });
});
