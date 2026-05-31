import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DatabaseSync } from "node:sqlite";
import { BrowserSessionRuntimeService } from "../services/browser-session-runtime-service.js";
import { browserSessionsRoutes } from "./browser-sessions.js";

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
      browserSessionRuntimeService: new BrowserSessionRuntimeService({ gatewaySql: db }),
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
});
