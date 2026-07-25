import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { journeyRoutes } from "./journey.js";

describe("journey routes HX-402", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("exposes an operator-only read route with normalized filters", async () => {
    const listTimeline = vi.fn(() => ({
      schemaVersion: "goatcitadel.journey-timeline-page.v1",
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-1",
      includeGlobal: true,
      items: [],
      generatedAt: "2026-07-13T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-1");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { journeyTimeline: { listTimeline } } as never);
    await app.register(journeyRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/journey/events?workspaceId=workspace-1&includeGlobal=true&eventTypes=memory_lifecycle,skill_learning_evidence_assessed&poisoningStatuses=blocked,conflicting&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.json()).toMatchObject({ readOnly: true, mutationSemantics: "none" });
    expect(listTimeline).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      includeGlobal: true,
      eventTypes: ["memory_lifecycle", "skill_learning_evidence_assessed"],
      subjectKinds: [],
      actions: [],
      trustDispositions: [],
      poisoningStatuses: ["blocked", "conflicting"],
      limit: 25,
    });
  });

  it("rejects malformed filters and cursor errors without invoking mutations", async () => {
    const listTimeline = vi.fn(() => {
      throw new TypeError("Journey timeline cursor is malformed.");
    });
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-1");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { journeyTimeline: { listTimeline } } as never);
    await app.register(journeyRoutes);

    const invalidStatus = await app.inject({
      method: "GET",
      url: "/api/v1/journey/events?workspaceId=workspace-1&poisoningStatuses=trusted",
    });
    expect(invalidStatus.statusCode).toBe(400);
    expect(listTimeline).not.toHaveBeenCalled();

    const invalidCursor = await app.inject({
      method: "GET",
      url: "/api/v1/journey/events?workspaceId=workspace-1&cursor=bad",
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toEqual({ error: "Journey timeline cursor is malformed." });
    expect(listTimeline).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown query keys instead of weakening workspace-scoped filters", async () => {
    const listTimeline = vi.fn();
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-1");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { journeyTimeline: { listTimeline } } as never);
    await app.register(journeyRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/journey/events?workspaceId=workspace-1&workspaceID=workspace-2",
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(listTimeline).not.toHaveBeenCalled();
  });

  it("keeps provenance history non-cacheable when operator authentication denies access", async () => {
    const listTimeline = vi.fn();
    app = Fastify();
    app.decorate("requireOperatorAuth", async (_request, reply) => {
      await reply.code(403).send({ error: "operator required" });
    });
    app.decorateRequest("authActorId", "anonymous");
    app.decorateRequest("authActorSource", "none");
    app.decorate("services", { journeyTimeline: { listTimeline } } as never);
    await app.register(journeyRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/journey/events?workspaceId=workspace-1",
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(listTimeline).not.toHaveBeenCalled();
  });

  it("fails closed when production wiring is unavailable", async () => {
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-1");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {} as never);
    await app.register(journeyRoutes);
    const response = await app.inject({ method: "GET", url: "/api/v1/journey/events?workspaceId=workspace-1" });
    expect(response.statusCode).toBe(503);
  });
});
