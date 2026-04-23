import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin.js";
import { approvalsRoutes } from "./approvals.js";
import { authRoutes } from "./auth.js";
import { durableRoutes } from "./durable.js";
import { eventsRoutes } from "./events.js";
import { memoryRoutes } from "./memory.js";
import { orchestrationRoutes } from "./orchestration.js";
import { installRouteAccessTracking, listMissingTrackedRouteAccessClasses } from "./route-access.js";

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
    app.decorate("gateway", {} as never);
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
      tracked: true,
    });

    expect(
      app.routeAccessManifest.find((entry) => entry.method === "GET" && entry.url === "/api/v1/events/stream"),
    ).toMatchObject({
      accessClass: "sse-read",
      tracked: true,
    });

    expect(
      app.routeAccessManifest.find((entry) => entry.method === "POST" && entry.url === "/api/v1/orchestration/plans"),
    ).toMatchObject({
      accessClass: "operator",
      tracked: true,
    });
  });
});
