import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../config.js";
import { authPlugin } from "../plugins/auth.js";
import { RemoteWorkerRegistryInputError } from "../services/remote-workers-route-service.js";
import { remoteWorkersRoutes } from "./remote-workers.js";

const PAGE = {
  schemaVersion: "goatcitadel.remote-worker-registry-page.v1",
  readOnly: true,
  mutationSemantics: "none",
  workspaceId: "workspace-a",
  items: [],
  observedAt: "2026-07-15T12:00:00.000Z",
} as const;
const DETAIL = {
  schemaVersion: "goatcitadel.remote-worker-registry-detail.v1",
  readOnly: true,
  mutationSemantics: "none",
  workspaceId: "workspace-a",
  item: { workerId: "worker-a" },
  observedAt: "2026-07-15T12:00:00.000Z",
} as const;

describe("remote worker operator registry routes HX-507A", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("exposes only actor-keyed operator GETs with strict inputs and no-cache headers", async () => {
    const listRegistry = vi.fn(() => PAGE);
    const getRegistryEntry = vi.fn(() => DETAIL);
    const routes: RouteOptions[] = [];
    app = Fastify();
    app.addHook("onRoute", (route) => routes.push(route));
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-a");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { remoteWorkers: { listRegistry, getRegistryEntry } } as never);
    await app.register(remoteWorkersRoutes);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers?limit=10&cursor=opaque-cursor",
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.headers.pragma).toBe("no-cache");
    expect(list.headers.vary).toContain("Authorization");
    expect(listRegistry).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      limit: 10,
      cursor: "opaque-cursor",
    });

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a",
    });
    expect(detail.statusCode).toBe(200);
    expect(getRegistryEntry).toHaveBeenCalledWith({ workspaceId: "workspace-a", workerId: "worker-a" });
    const getRoutes = routes.filter((route) => route.method === "GET");
    expect(getRoutes).toHaveLength(2);
    expect(getRoutes.map((route) => route.url).sort()).toEqual([
      "/api/v1/ops/workspaces/:workspaceId/remote-workers",
      "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId",
    ]);
    expect(routes.every((route) => route.method === "GET" || route.method === "HEAD")).toBe(true);
    expect(routes.every((route) => route.config.goatcitadelRouteAccessClass === "operator")).toBe(true);
    for (const route of getRoutes) {
      const rateLimit = route.config.rateLimit as {
        max: number;
        keyGenerator: (request: { authActorId?: string; ip?: string }) => string;
      };
      expect(rateLimit.max).toBe(120);
      expect((rateLimit as typeof rateLimit & { hook: string }).hook).toBe("preHandler");
      expect(rateLimit.keyGenerator({ authActorId: "operator-a", ip: "127.0.0.1" })).toBe("actor:operator-a");
      expect(rateLimit.keyGenerator({ ip: "192.0.2.9" })).toBe("ip:192.0.2.9");
    }
  });

  it("denies unauthenticated reads before service invocation and keeps denial responses non-cacheable", async () => {
    const listRegistry = vi.fn(() => PAGE);
    app = Fastify();
    app.decorate("requireOperatorAuth", async (_request, reply) => {
      await reply.code(403).send({ error: "operator required" });
    });
    app.decorateRequest("authActorId", "anonymous");
    app.decorateRequest("authActorSource", "none");
    app.decorate("services", { remoteWorkers: { listRegistry, getRegistryEntry: vi.fn() } } as never);
    await app.register(remoteWorkersRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers",
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.vary).toContain("Authorization");
    expect(listRegistry).not.toHaveBeenCalled();
  });

  it("denies unauthenticated, device, companion, A2A-peer, and arbitrary worker bearers before reads", async () => {
    const listRegistry = vi.fn(() => PAGE);
    app = await buildAuthenticatedHarness(listRegistry);
    const probes = [
      { label: "unauthenticated", headers: {}, expectedStatus: 401 },
      { label: "device", headers: { authorization: "Bearer device-bearer" }, expectedStatus: 403 },
      { label: "companion", headers: { authorization: "Bearer companion-bearer" }, expectedStatus: 403 },
      {
        label: "a2a-peer",
        headers: { authorization: "Bearer operator-token", "x-test-a2a-peer": "peer-a" },
        expectedStatus: 403,
      },
      {
        label: "arbitrary-worker-runtime",
        headers: { authorization: "Bearer arbitrary-worker-runtime-bearer" },
        expectedStatus: 401,
      },
    ] as const;

    for (const probe of probes) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/ops/workspaces/workspace-a/remote-workers",
        headers: probe.headers,
      });
      expect(response.statusCode, probe.label).toBe(probe.expectedStatus);
      expect(response.headers["cache-control"], probe.label).toBe("no-store");
      expect(response.headers.pragma, probe.label).toBe("no-cache");
      expect(response.headers.vary, probe.label).toContain("Authorization");
      expect(response.body, probe.label).not.toMatch(/device-bearer|companion-bearer|worker-runtime-bearer/u);
    }
    expect(listRegistry).not.toHaveBeenCalled();
  });

  it("runs actor-key rate limiting after real auth attribution, separating two actors on one IP", async () => {
    const listRegistry = vi.fn(() => PAGE);
    app = await buildAuthenticatedHarness(listRegistry, { installRateLimit: true, allowActorOverride: true });
    const request = (actorId: string) =>
      app!.inject({
        method: "GET",
        url: "/api/v1/ops/workspaces/workspace-a/remote-workers",
        headers: { authorization: "Bearer operator-token", "x-test-actor": actorId },
      });

    for (let count = 0; count < 120; count += 1) {
      expect((await request("operator-a")).statusCode).toBe(200);
    }
    expect((await request("operator-b")).statusCode).toBe(200);
    const exceeded = await request("operator-a");
    expect(exceeded.statusCode).toBe(429);
    expect(exceeded.headers["cache-control"]).toBe("no-store");
    expect(exceeded.headers.vary).toContain("Authorization");
    expect(listRegistry).toHaveBeenCalledTimes(121);
  });

  it("rejects unknown, noncanonical, oversized, and service cursor inputs without echoing them", async () => {
    const secret = "apiKey_SUPER_SECRET_abc123";
    const listRegistry = vi.fn(() => {
      throw new RemoteWorkerRegistryInputError();
    });
    const getRegistryEntry = vi.fn(() => DETAIL);
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-a");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { remoteWorkers: { listRegistry, getRegistryEntry } } as never);
    await app.register(remoteWorkersRoutes);

    for (const url of [
      `/api/v1/ops/workspaces/workspace-a/remote-workers?${secret}=private-value`,
      "/api/v1/ops/workspaces/%20workspace-a/remote-workers",
      "/api/v1/ops/workspaces/workspace-a/remote-workers?limit=01",
      `/api/v1/ops/workspaces/workspace-a/remote-workers?cursor=${"a".repeat(2_049)}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain("private-value");
      expect(response.json()).toEqual({ error: "Remote worker registry request is invalid." });
    }
    expect(listRegistry).not.toHaveBeenCalled();

    const cursorFailure = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers?cursor=bad",
    });
    expect(cursorFailure.statusCode).toBe(400);
    expect(cursorFailure.json()).toEqual({ error: "Remote worker registry request is invalid." });
    expect(listRegistry).toHaveBeenCalledTimes(1);

    const detailWithUnknownQuery = await app.inject({
      method: "GET",
      url: `/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a?${secret}=private-value`,
    });
    expect(detailWithUnknownQuery.statusCode).toBe(400);
    expect(detailWithUnknownQuery.body).not.toContain(secret);
    expect(detailWithUnknownQuery.body).not.toContain("private-value");
    expect(detailWithUnknownQuery.json()).toEqual({ error: "Remote worker registry request is invalid." });
    expect(getRegistryEntry).not.toHaveBeenCalled();
  });

  it("returns the same 404 for absent or foreign-workspace IDs without leaking private control evidence", async () => {
    const privateEvidence = "private revoke reason";
    const getRegistryEntry = vi.fn(() => {
      throw new NotFoundError({ entity: "remote worker registry entry", id: "unavailable" });
    });
    app = Fastify({ logger: false });
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-a");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { remoteWorkers: { listRegistry: vi.fn(), getRegistryEntry } } as never);
    await app.register(remoteWorkersRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/foreign-workspace/remote-workers/worker-a",
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(privateEvidence);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toContain("Authorization");
  });

  it("fails closed with 503 when canonical composition is unavailable", async () => {
    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorateRequest("authActorId", "operator-a");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {} as never);
    await app.register(remoteWorkersRoutes);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers",
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

const AUTH_CONFIG = {
  mode: "token",
  allowLoopbackBypass: false,
  token: { value: "operator-token", queryParam: "access_token" },
  basic: { username: "operator", password: "password123" },
} satisfies AuthConfig;

async function buildAuthenticatedHarness(
  listRegistry: ReturnType<typeof vi.fn>,
  options: { installRateLimit?: boolean; allowActorOverride?: boolean } = {},
): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.decorate("gatewayConfig", { assistant: { auth: AUTH_CONFIG } } as never);
  instance.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: true }),
    validateDeviceAccessToken: (token: string) =>
      token === "device-bearer" ? { actorId: "device:grant-a", deviceId: "device-a", grantId: "grant-a" } : undefined,
    validateCompanionAccessToken: (token: string) =>
      token === "companion-bearer"
        ? {
            actorId: "companion:session-a",
            deviceId: "device-a",
            grantId: "grant-a",
            sessionId: "session-a",
          }
        : undefined,
    verifyCompanionRequestSignature: () => undefined,
  } as never);
  instance.decorate("services", {
    remoteWorkers: { listRegistry, getRegistryEntry: vi.fn(() => DETAIL) },
  } as never);
  if (options.installRateLimit) {
    await instance.register(rateLimit, {
      global: false,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.ip,
      allowList: () => false,
      max: 500,
    });
  }
  await instance.register(authPlugin);
  instance.addHook("onRequest", async (request) => {
    const peerId = request.headers["x-test-a2a-peer"];
    if (typeof peerId === "string" && peerId) {
      request.authActorId = `a2a:${peerId}`;
      request.authActorSource = "a2a_peer";
      request.a2aPeerId = peerId;
    }
    const actorId = request.headers["x-test-actor"];
    if (options.allowActorOverride && request.authActorSource === "token" && typeof actorId === "string" && actorId) {
      request.authActorId = actorId;
    }
  });
  await instance.register(remoteWorkersRoutes);
  return instance;
}
