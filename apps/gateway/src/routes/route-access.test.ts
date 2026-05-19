import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin.js";
import { approvalsRoutes } from "./approvals.js";
import { authRoutes } from "./auth.js";
import { durableRoutes } from "./durable.js";
import { eventsRoutes } from "./events.js";
import { memoryRoutes } from "./memory.js";
import { orchestrationRoutes } from "./orchestration.js";
import { installRouteAccessTracking, listMissingTrackedRouteAccessClasses, withRouteAccess } from "./route-access.js";

describe("route access manifest", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("tracks access classes for the control-plane route surface", async () => {
    app = Fastify();
    installRouteAccessTracking(app);
    app.decorate("services", {
      authAdmin: {},
      approvals: {},
      durable: {},
      memory: {},
      orchestration: {},
    } as never);
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("issueSseToken", () => ({
      token: "sse-token",
      expiresAt: "2026-04-22T00:00:00.000Z",
      scope: "events:stream",
    }));

    await app.register(adminRoutes);
    await app.register(approvalsRoutes);
    await app.register(authRoutes);
    await app.register(durableRoutes);
    await app.register(eventsRoutes);
    await app.register(memoryRoutes);
    await app.register(orchestrationRoutes);

    expect(listMissingTrackedRouteAccessClasses(app)).toEqual([]);

    expect(
      app.routeAccessManifest.find(
        (entry) => entry.method === "POST" && entry.url === "/api/v1/auth/companion/session/exchange",
      ),
    ).toMatchObject({
      accessClass: "device",
      classificationSource: "explicit",
      tracked: true,
    });

    expect(
      app.routeAccessManifest.find((entry) => entry.method === "GET" && entry.url === "/api/v1/events/stream"),
    ).toMatchObject({
      accessClass: "sse-read",
      classificationSource: "explicit",
      tracked: true,
    });

    expect(
      app.routeAccessManifest.find((entry) => entry.method === "POST" && entry.url === "/api/v1/orchestration/plans"),
    ).toMatchObject({
      accessClass: "operator",
      classificationSource: "explicit",
      tracked: true,
    });
  });

  it("classifies the full api surface even when routes do not opt in locally", async () => {
    app = Fastify();
    installRouteAccessTracking(app);
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);

    app.get("/api/v1/llm/providers", async () => ({ ok: true }));
    app.get("/api/v1/tools/catalog", async () => ({ ok: true }));
    app.get("/api/v1/mcp/servers", async () => ({ ok: true }));
    app.get("/api/v1/addons/catalog", async () => ({ ok: true }));
    app.get("/api/v1/capabilities/catalog", async () => ({ ok: true }));
    app.post("/api/v1/code-mode/runs", async () => ({ ok: true }));
    app.post("/api/v1/integrations/connections/:connectionId/:channel/inbound", async () => ({ ok: true }));
    app.post("/api/v1/integrations/connections/:connectionId/telegram/webhook", async () => ({ ok: true }));
    app.get("/api/v1/unclassified/new-surface", async () => ({ ok: true }));
    await app.ready();

    expect(listMissingTrackedRouteAccessClasses(app)).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "/api/v1/unclassified/new-surface",
        accessClass: "operator",
        classificationSource: "default",
      }),
    ]);
    for (const url of [
      "/api/v1/llm/providers",
      "/api/v1/tools/catalog",
      "/api/v1/mcp/servers",
      "/api/v1/addons/catalog",
      "/api/v1/capabilities/catalog",
      "/api/v1/code-mode/runs",
    ]) {
      expect(app.routeAccessManifest.find((entry) => entry.url === url)).toMatchObject({
        accessClass: "operator",
        classificationSource: "policy",
        tracked: true,
      });
    }
    expect(
      app.routeAccessManifest.find((entry) => entry.method === "GET" && entry.url === "/api/v1/tools/catalog"),
    ).toMatchObject({
      accessClass: "operator",
      classificationSource: "policy",
      tracked: true,
    });
    expect(
      app.routeAccessManifest.find(
        (entry) =>
          entry.method === "POST" && entry.url === "/api/v1/integrations/connections/:connectionId/:channel/inbound",
      ),
    ).toMatchObject({
      accessClass: "webhook",
      classificationSource: "policy",
      tracked: true,
    });
    expect(
      app.routeAccessManifest.find(
        (entry) =>
          entry.method === "POST" && entry.url === "/api/v1/integrations/connections/:connectionId/telegram/webhook",
      ),
    ).toMatchObject({
      accessClass: "webhook",
      classificationSource: "policy",
      tracked: true,
    });
    expect(
      app.routeAccessManifest.find(
        (entry) => entry.method === "GET" && entry.url === "/api/v1/unclassified/new-surface",
      ),
    ).toMatchObject({
      accessClass: "operator",
      classificationSource: "default",
      tracked: true,
    });
  });

  it("fails closed when an operator route is registered without the auth decorator", async () => {
    app = Fastify();
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
      },
    } as never);

    app.get("/api/v1/operator-only", withRouteAccess(app, "operator"), async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/api/v1/operator-only" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: "Operator authentication is not installed for this route.",
    });
  });

  it("enforces read, SSE, and actor-source specific access classes", async () => {
    app = Fastify();
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
      },
    } as never);
    app.decorate(
      "requireOperatorAuth",
      vi.fn(async () => undefined),
    );
    app.addHook("onRequest", async (request) => {
      const source = request.headers["x-auth-source"];
      (request as { authActorSource?: string }).authActorSource = typeof source === "string" ? source : "none";
      const companionSessionId = request.headers["x-companion-session-id"];
      (request as { authCompanionSessionId?: string }).authCompanionSessionId =
        typeof companionSessionId === "string" ? companionSessionId : undefined;
    });
    app.get("/read", withRouteAccess(app, "authenticated-read"), async () => ({ ok: true }));
    app.get("/sse", withRouteAccess(app, "sse-read"), async () => ({ ok: true }));
    app.get("/loopback", withRouteAccess(app, "loopback"), async () => ({ ok: true }));
    app.get("/device", withRouteAccess(app, "device"), async () => ({ ok: true }));
    app.get("/companion", withRouteAccess(app, "companion"), async () => ({ ok: true }));

    expect((await app.inject({ method: "GET", url: "/read" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/read", headers: { "x-auth-source": "token" } })).statusCode).toBe(
      200,
    );

    expect((await app.inject({ method: "GET", url: "/sse" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/sse", headers: { "x-auth-source": "sse" } })).statusCode).toBe(
      200,
    );
    expect(
      (await app.inject({ method: "GET", url: "/sse", headers: { "x-auth-source": "companion" } })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/sse",
          headers: { "x-auth-source": "companion", "x-companion-session-id": "session-1" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/sse", headers: { "x-auth-source": "device" } })).statusCode).toBe(
      403,
    );

    expect((await app.inject({ method: "GET", url: "/loopback" })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/loopback", headers: { "x-auth-source": "loopback" } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/device", headers: { "x-auth-source": "device" } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/companion", headers: { "x-auth-source": "companion" } })).statusCode,
    ).toBe(200);
  });

  it("merges local prehandlers and ignores untracked or non-runtime manifest misses", async () => {
    app = Fastify();
    installRouteAccessTracking(app);
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "none",
        },
      },
    } as never);
    const localPreHandler = vi.fn(async () => undefined);
    app.get(
      "/api/v1/events",
      withRouteAccess(app, "authenticated-read", {
        preHandler: localPreHandler,
      }),
      async () => ({ ok: true }),
    );
    app.head("/api/v1/unclassified/head-only", async () => undefined);
    app.options("/api/v1/unclassified/options-only", async () => undefined);
    app.get("/internal/status", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/api/v1/events" });

    expect(response.statusCode).toBe(200);
    expect(localPreHandler).toHaveBeenCalled();
    expect(listMissingTrackedRouteAccessClasses(app)).toEqual([]);
    expect(app.routeAccessManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", url: "/api/v1/events", accessClass: "authenticated-read" }),
        expect.objectContaining({ method: "HEAD", url: "/api/v1/unclassified/head-only", tracked: true }),
        expect.objectContaining({ method: "OPTIONS", url: "/api/v1/unclassified/options-only", tracked: true }),
        expect.objectContaining({ method: "GET", url: "/internal/status", tracked: false }),
      ]),
    );
  });
});
