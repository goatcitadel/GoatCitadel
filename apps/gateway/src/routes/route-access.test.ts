import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin.js";
import { approvalsRoutes } from "./approvals.js";
import { authRoutes } from "./auth.js";
import { durableRoutes } from "./durable.js";
import { engineeringLearningRoutes } from "./engineering-learnings.js";
import { eventsRoutes } from "./events.js";
import { memoryRoutes } from "./memory.js";
import { notificationRoutes } from "./notifications.js";
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
    await app.register(engineeringLearningRoutes);
    await app.register(eventsRoutes);
    await app.register(memoryRoutes);
    await app.register(orchestrationRoutes);

    expect(listMissingTrackedRouteAccessClasses(app)).toEqual([]);

    expect(
      app.routeAccessManifest.find(
        (entry) => entry.method === "POST" && entry.url === "/api/v1/auth/companion/session/exchange",
      ),
    ).toMatchObject({
      accessClass: "device-session-exchange",
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

    const engineeringLearningManifest = app.routeAccessManifest.filter(
      (entry) => entry.method !== "HEAD" && entry.url.startsWith("/api/v1/engineering-learnings"),
    );
    expect(engineeringLearningManifest).toHaveLength(7);
    expect(engineeringLearningManifest).toEqual(
      expect.arrayContaining(
        engineeringLearningManifest.map((entry) =>
          expect.objectContaining({
            method: entry.method,
            url: entry.url,
            accessClass: "operator",
            classificationSource: "policy",
            tracked: true,
          }),
        ),
      ),
    );
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
    app.get("/api/v1/mobile/capabilities", async () => ({ ok: true }));
    app.get("/api/v1/ops/quality", async () => ({ ok: true }));
    app.get("/api/v1/trust/policy-snapshot", async () => ({ ok: true }));
    app.post("/api/v1/code-mode/runs", async () => ({ ok: true }));
    app.post("/api/v1/surface/classify", async () => ({ ok: true }));
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
      "/api/v1/mobile/capabilities",
      "/api/v1/ops/quality",
      "/api/v1/trust/policy-snapshot",
      "/api/v1/code-mode/runs",
      "/api/v1/surface/classify",
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

  it("classifies every notification route as operator-only and rejects non-operator principals", async () => {
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
    app.decorate(
      "requireOperatorAuth",
      vi.fn(async (request, reply) => {
        if (request.authActorSource === "token") {
          return;
        }
        return reply.code(403).send({
          error: "Operator authentication is required for this control-plane route.",
        });
      }),
    );
    app.addHook("onRequest", async (request) => {
      const source = request.headers["x-auth-source"];
      request.authActorSource = source === "token" || source === "companion" ? source : "device";
    });
    const integrations = {
      listNotificationTargets: vi.fn(() => []),
      createNotificationTarget: vi.fn(() => ({ targetId: "target-1" })),
      updateNotificationTarget: vi.fn(() => ({ targetId: "target-1", revision: 2 })),
      sendTestNotification: vi.fn(async () => ({ event: { eventId: "event-1" }, deliveries: [] })),
      listNotificationRules: vi.fn(() => []),
      createNotificationRule: vi.fn(() => ({ ruleId: "rule-1" })),
      updateNotificationRule: vi.fn(() => ({ ruleId: "rule-1", revision: 2 })),
      upsertNotificationPresence: vi.fn((input) => ({ ...input, leaseId: "lease-1" })),
      listNotificationDeliveries: vi.fn(() => []),
      requestNotification: vi.fn(async () => ({ event: { eventId: "event-1" }, deliveries: [] })),
    };
    app.decorate("services", { integrations } as never);
    await app.register(notificationRoutes);
    await app.ready();

    const notificationManifest = app.routeAccessManifest.filter(
      (entry) => entry.method !== "HEAD" && entry.url.startsWith("/api/v1/notifications"),
    );
    expect(notificationManifest).toHaveLength(10);
    expect(notificationManifest).toEqual(
      expect.arrayContaining(
        notificationManifest.map((entry) =>
          expect.objectContaining({
            method: entry.method,
            url: entry.url,
            accessClass: "operator",
            classificationSource: "policy",
            tracked: true,
          }),
        ),
      ),
    );
    expect(listMissingTrackedRouteAccessClasses(app)).toEqual([]);

    const nonOperatorRequests = [
      { method: "GET", url: "/api/v1/notifications/targets" },
      {
        method: "POST",
        url: "/api/v1/notifications/targets",
        payload: { target: { label: "Ops", kind: "channel_connection", channelConnectionId: "channel-1" } },
      },
      {
        method: "PATCH",
        url: "/api/v1/notifications/targets/target-1",
        payload: {
          expectedRevision: 1,
          target: { label: "Ops", kind: "channel_connection", channelConnectionId: "channel-1" },
        },
      },
      { method: "POST", url: "/api/v1/notifications/targets/target-1/test", payload: {} },
      { method: "GET", url: "/api/v1/notifications/rules" },
      {
        method: "POST",
        url: "/api/v1/notifications/rules",
        payload: { rule: { label: "Failures", eventTypes: ["turn.failed"], targetIds: ["target-1"] } },
      },
      {
        method: "PATCH",
        url: "/api/v1/notifications/rules/rule-1",
        payload: {
          expectedRevision: 1,
          rule: { label: "Failures", eventTypes: ["turn.failed"], targetIds: ["target-1"] },
        },
      },
      {
        method: "PUT",
        url: "/api/v1/notifications/presence",
        payload: { clientId: "client-1", focused: true, visible: true },
      },
      { method: "GET", url: "/api/v1/notifications/deliveries" },
      {
        method: "POST",
        url: "/api/v1/notifications/requests",
        payload: { eventType: "turn.failed", title: "Failure", message: "A turn failed." },
      },
    ] as const;

    for (const source of ["device", "companion"] as const) {
      for (const request of nonOperatorRequests) {
        const response = await app.inject({
          ...request,
          headers: { "x-auth-source": source },
        });
        expect(response.statusCode, `${source}: ${request.method} ${request.url}`).toBe(403);
      }
    }
    expect(Object.values(integrations).every((handler) => handler.mock.calls.length === 0)).toBe(true);

    const operatorResponse = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/targets",
      headers: { "x-auth-source": "token" },
    });
    expect(operatorResponse.statusCode).toBe(200);
    expect(integrations.listNotificationTargets).toHaveBeenCalledOnce();
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

const PURPOSE_ROUTE_CLASSES = [
  "public",
  "authenticated-read",
  "sse-read",
  "operator",
  "device",
  "companion",
  "device-session-exchange",
  "session-control-companion",
  "operator-or-session-control-companion",
] as const;

type PurposeInjection = {
  source?: string;
  purpose?: string;
  companionSessionId?: string;
};

function purposeHeaders(injection: PurposeInjection): Record<string, string> {
  const headers: Record<string, string> = {};
  if (injection.source !== undefined) headers["x-auth-source"] = injection.source;
  if (injection.purpose !== undefined) headers["x-auth-purpose"] = injection.purpose;
  if (injection.companionSessionId !== undefined) headers["x-companion-session-id"] = injection.companionSessionId;
  return headers;
}

async function buildPurposeIsolationApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  installRouteAccessTracking(instance);
  instance.decorate("gatewayConfig", {
    assistant: {
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
      },
    },
  } as never);
  // Mirror the real operator gate: token / basic / loopback are operators.
  instance.decorate(
    "requireOperatorAuth",
    vi.fn(
      async (
        request: { authActorSource?: string },
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
      ) => {
        const source = request.authActorSource;
        if (source === "token" || source === "basic" || source === "loopback") {
          return undefined;
        }
        return reply.code(403).send({ error: "Operator authentication is required for this control-plane route." });
      },
    ),
  );
  instance.addHook("onRequest", async (request) => {
    const source = request.headers["x-auth-source"];
    (request as { authActorSource?: string }).authActorSource = typeof source === "string" ? source : "none";
    const purpose = request.headers["x-auth-purpose"];
    (request as { authPrincipalPurpose?: string }).authPrincipalPurpose =
      typeof purpose === "string" ? purpose : undefined;
    const companionSessionId = request.headers["x-companion-session-id"];
    (request as { authCompanionSessionId?: string }).authCompanionSessionId =
      typeof companionSessionId === "string" ? companionSessionId : undefined;
  });
  for (const routeClass of PURPOSE_ROUTE_CLASSES) {
    instance.get(`/cls/${routeClass}`, withRouteAccess(instance, routeClass), async () => ({ ok: true }));
  }
  // A non-/api/v1 route registered with no access class at all: "unscoped".
  instance.get("/unscoped", async () => ({ ok: true }));
  await instance.ready();
  return instance;
}

describe("principal purpose route isolation", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  async function status(url: string, injection: PurposeInjection): Promise<number> {
    const response = await app!.inject({ method: "GET", url, headers: purposeHeaders(injection) });
    return response.statusCode;
  }

  it("confines a purpose-bound device to the exact session-exchange class", async () => {
    app = await buildPurposeIsolationApp();
    const boundDevice: PurposeInjection = { source: "device", purpose: "session_control_client" };

    expect(await status("/cls/device-session-exchange", boundDevice)).toBe(200);
    // Every other class — including the generic device class — rejects it.
    for (const routeClass of [
      "device",
      "operator",
      "authenticated-read",
      "sse-read",
      "companion",
      "session-control-companion",
      "operator-or-session-control-companion",
    ] as const) {
      expect(await status(`/cls/${routeClass}`, boundDevice)).toBe(403);
    }
    // Unscoped routes reject it too.
    expect(await status("/unscoped", boundDevice)).toBe(403);
    // Public routes ignore the attached bearer authority entirely.
    expect(await status("/cls/public", boundDevice)).toBe(200);
  });

  it("confines a purpose-bound companion to the two control classes", async () => {
    app = await buildPurposeIsolationApp();
    const boundCompanion: PurposeInjection = {
      source: "companion",
      purpose: "session_control_client",
      companionSessionId: "companion-session-1",
    };

    expect(await status("/cls/session-control-companion", boundCompanion)).toBe(200);
    expect(await status("/cls/operator-or-session-control-companion", boundCompanion)).toBe(200);
    for (const routeClass of [
      "device-session-exchange",
      "device",
      "companion",
      "operator",
      "authenticated-read",
      "sse-read",
    ] as const) {
      expect(await status(`/cls/${routeClass}`, boundCompanion)).toBe(403);
    }
    expect(await status("/unscoped", boundCompanion)).toBe(403);
    expect(await status("/cls/public", boundCompanion)).toBe(200);
    // A purpose-bound companion missing its session id cannot use a control class.
    expect(
      await status("/cls/session-control-companion", { source: "companion", purpose: "session_control_client" }),
    ).toBe(403);
  });

  it("rejects generic (non-purpose-bound) principals from the session-control classes", async () => {
    app = await buildPurposeIsolationApp();
    const genericCompanion: PurposeInjection = {
      source: "companion",
      purpose: "general_companion",
      companionSessionId: "companion-session-1",
    };

    // Generic companion keeps its existing companion + sse access...
    expect(await status("/cls/companion", genericCompanion)).toBe(200);
    expect(await status("/cls/sse-read", genericCompanion)).toBe(200);
    // ...but is refused the control classes because it lacks the confined purpose.
    expect(await status("/cls/session-control-companion", genericCompanion)).toBe(403);
    expect(await status("/cls/operator-or-session-control-companion", genericCompanion)).toBe(403);

    // A generic device (default purpose) still exchanges and uses the device class.
    const genericDevice: PurposeInjection = { source: "device", purpose: "general_companion" };
    expect(await status("/cls/device-session-exchange", genericDevice)).toBe(200);
    expect(await status("/cls/device", genericDevice)).toBe(200);
    expect(await status("/cls/session-control-companion", genericDevice)).toBe(403);
  });

  it("admits operators to operator-or-session-control-companion but not the pure companion control class", async () => {
    app = await buildPurposeIsolationApp();
    const operator: PurposeInjection = { source: "token" };

    expect(await status("/cls/operator-or-session-control-companion", operator)).toBe(200);
    expect(await status("/cls/operator", operator)).toBe(200);
    // The pure session-control-companion class never admits a bare operator.
    expect(await status("/cls/session-control-companion", operator)).toBe(403);
  });

  it("runs the purpose guard before a later-registered replay-persistence hook", async () => {
    app = Fastify();
    installRouteAccessTracking(app);
    app.decorate("gatewayConfig", {
      assistant: { auth: { mode: "token", allowLoopbackBypass: false } },
    } as never);
    app.decorate(
      "requireOperatorAuth",
      vi.fn(async () => undefined),
    );
    app.addHook("onRequest", async (request) => {
      const source = request.headers["x-auth-source"];
      (request as { authActorSource?: string }).authActorSource = typeof source === "string" ? source : "none";
      const purpose = request.headers["x-auth-purpose"];
      (request as { authPrincipalPurpose?: string }).authPrincipalPurpose =
        typeof purpose === "string" ? purpose : undefined;
    });
    // A stand-in for the companion signed-request replay persistence hook, which
    // in production is registered AFTER installRouteAccessTracking (app.ts). The
    // central purpose guard must reject purpose-bound authority before it runs.
    const replayPersistence = vi.fn(async () => undefined);
    app.addHook("preHandler", replayPersistence);
    app.post("/api/v1/chat/messages", withRouteAccess(app, "operator"), async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/messages",
      headers: { "x-auth-source": "companion", "x-auth-purpose": "session_control_client" },
      payload: { text: "control" },
    });

    expect(response.statusCode).toBe(403);
    expect(replayPersistence).not.toHaveBeenCalled();
  });
});
