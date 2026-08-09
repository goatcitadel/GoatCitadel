import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import {
  NotFoundError,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
} from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../config.js";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import {
  RemoteWorkerOperatorControlUnavailableError,
  RemoteWorkerRegistryInputError,
} from "../services/remote-workers-route-service.js";
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
const ASSIGNMENT_PAGE = {
  schemaVersion: "goatcitadel.remote-worker-assignment-page.v1",
  readOnly: true,
  mutationSemantics: "none",
  workspaceId: "workspace-a",
  filters: {},
  items: [],
  observedAt: "2026-07-15T12:00:00.000Z",
} as const;
const EVENT_PAGE = {
  schemaVersion: "goatcitadel.remote-worker-assignment-event-page.v1",
  readOnly: true,
  mutationSemantics: "none",
  workspaceId: "workspace-a",
  assignmentId: "assign-a",
  assignmentGeneration: 1,
  items: [],
  nextAfterSequence: 0,
  omitted: { transcriptDeltas: 0, terminalOutputs: 0, diagnostics: 0 },
  observedAt: "2026-07-15T12:00:00.000Z",
} as const;
const RECONCILIATION = {
  schemaVersion: "goatcitadel.remote-worker-reconciliation.v1",
  readOnly: true,
  mutationSemantics: "none",
  workspaceId: "workspace-a",
  workerId: "worker-a",
  observedAt: "2026-07-15T12:00:00.000Z",
} as const;

function fullService(overrides: Record<string, unknown> = {}) {
  return {
    listRegistry: vi.fn(() => PAGE),
    getRegistryEntry: vi.fn(() => DETAIL),
    getReconciliation: vi.fn(() => RECONCILIATION),
    listAssignments: vi.fn(() => ASSIGNMENT_PAGE),
    getAssignmentEvents: vi.fn(() => EVENT_PAGE),
    issueBootstrap: vi.fn(() => bootstrapResponse()),
    quarantineGeneration: vi.fn(() => controlResponse("quarantine")),
    revokeGeneration: vi.fn(() => controlResponse("revoke")),
    ...overrides,
  };
}

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
    const service = fullService({ listRegistry, getRegistryEntry });
    app.decorate("services", { remoteWorkers: service } as never);
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
    expect(getRoutes).toHaveLength(5);
    expect(getRoutes.map((route) => route.url).sort()).toEqual([
      "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments",
      "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/events",
      "/api/v1/ops/workspaces/:workspaceId/remote-workers",
      "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId",
      "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/reconciliation",
    ]);
    expect(getRoutes.every((route) => route.config.goatcitadelRouteAccessClass === "operator")).toBe(true);
    const postRoutes = routes.filter((route) => route.method === "POST");
    expect(postRoutes.map((route) => route.url).sort()).toEqual([
      "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/quarantine",
      "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/revoke",
      "/api/v1/ops/workspaces/:workspaceId/remote-workers/bootstrap",
    ]);
    expect(postRoutes.find((route) => route.url.endsWith("/bootstrap"))?.config.goatcitadelRouteAccessClass).toBe(
      "loopback",
    );
    expect(
      postRoutes
        .filter((route) => !route.url.endsWith("/bootstrap"))
        .every((route) => route.config.goatcitadelRouteAccessClass === "operator"),
    ).toBe(true);
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
    expect(
      (postRoutes.find((route) => route.url.endsWith("/bootstrap"))?.config.rateLimit as { max: number }).max,
    ).toBe(5);
    expect(
      postRoutes
        .filter((route) => !route.url.endsWith("/bootstrap"))
        .every((route) => (route.config.rateLimit as { max: number }).max === 30),
    ).toBe(true);
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

describe("remote worker operator assignment + reconciliation routes HX-507B", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function harness(overrides: Record<string, unknown> = {}): Promise<{
    app: FastifyInstance;
    service: ReturnType<typeof fullService>;
  }> {
    const service = fullService(overrides);
    const instance = Fastify();
    instance.decorate("requireOperatorAuth", async () => undefined);
    instance.decorateRequest("authActorId", "operator-a");
    instance.decorateRequest("authActorSource", "loopback");
    instance.decorate("services", { remoteWorkers: service } as never);
    await instance.register(remoteWorkersRoutes);
    app = instance;
    return { app: instance, service };
  }

  it("binds exact worker/session/turn filters and paging for the assignment list, no-store", async () => {
    const { app: instance, service } = await harness();
    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-worker-assignments?workerId=worker-a&sessionId=session-a&turnId=turn-a&limit=10&cursor=opaque",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toContain("Authorization");
    expect(service.listAssignments).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      workerId: "worker-a",
      sessionId: "session-a",
      turnId: "turn-a",
      limit: 10,
      cursor: "opaque",
    });
  });

  it("passes afterSequence and limit to the events route and 404s an unstarted assignment", async () => {
    const { app: instance, service } = await harness();
    const ok = await instance.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-worker-assignments/assign-a/events?afterSequence=3&limit=25",
    });
    expect(ok.statusCode).toBe(200);
    expect(service.getAssignmentEvents).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      assignmentId: "assign-a",
      afterSequence: 3,
      limit: 25,
    });

    const { app: notFound } = await harness({
      getAssignmentEvents: vi.fn(() => {
        throw new NotFoundError({ entity: "remote worker assignment", id: "unavailable" });
      }),
    });
    const missing = await notFound.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-worker-assignments/ghost/events",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  it("serves the worker reconciliation projection and 404s an unknown worker identically", async () => {
    const { app: instance, service } = await harness();
    const ok = await instance.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a/reconciliation",
    });
    expect(ok.statusCode).toBe(200);
    expect(service.getReconciliation).toHaveBeenCalledWith({ workspaceId: "workspace-a", workerId: "worker-a" });

    const { app: notFound } = await harness({
      getReconciliation: vi.fn(() => {
        throw new NotFoundError({ entity: "remote worker registry entry", id: "unavailable" });
      }),
    });
    const missing = await notFound.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/foreign/remote-workers/ghost/reconciliation",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  it("rejects unknown query params and oversized limits on the new routes without echoing them", async () => {
    const secret = "apiKey_SUPER_SECRET_xyz";
    const { app: instance, service } = await harness();
    for (const url of [
      `/api/v1/ops/workspaces/workspace-a/remote-worker-assignments?${secret}=v`,
      "/api/v1/ops/workspaces/workspace-a/remote-worker-assignments?limit=101",
      "/api/v1/ops/workspaces/workspace-a/remote-worker-assignments/assign-a/events?limit=201",
      `/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a/reconciliation?${secret}=v`,
    ]) {
      const response = await instance.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(secret);
      expect(response.json()).toEqual({ error: "Remote worker registry request is invalid." });
    }
    expect(service.listAssignments).not.toHaveBeenCalled();
    expect(service.getAssignmentEvents).not.toHaveBeenCalled();
    expect(service.getReconciliation).not.toHaveBeenCalled();
  });
});

describe("remote worker M2 operator control routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("issues bootstrap material only to true loopback authority and keeps the response non-cacheable", async () => {
    const issueBootstrap = vi.fn(async () => bootstrapResponse());
    app = await buildLoopbackBootstrapHarness(issueBootstrap);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers/bootstrap",
      headers: { "Idempotency-Key": "bootstrap-route-a" },
      payload: bootstrapRequestBody(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.vary).toContain("Authorization");
    expect(response.json()).toMatchObject({
      disposition: "created",
      bootstrapSecret: Buffer.alloc(32, 3).toString("base64url"),
    });
    expect(issueBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        actorId: expect.stringMatching(/^loopback:/u),
        idempotencyKey: "bootstrap-route-a",
        allowedWorkspaceIds: ["workspace-a"],
        capabilityClasses: ["durable_compute"],
        protectedAdmissionSignerPin: bootstrapRequestBody().protectedAdmissionSignerPin,
      }),
    );
  });

  it("rejects proxy-derived and non-loopback bootstrap requests before service invocation", async () => {
    const issueBootstrap = vi.fn(async () => bootstrapResponse());
    app = await buildLoopbackBootstrapHarness(issueBootstrap);

    for (const headers of [
      { "Idempotency-Key": "bootstrap-proxy-a", "x-forwarded-for": "198.51.100.14" },
      { "Idempotency-Key": "bootstrap-proxy-b", forwarded: "for=198.51.100.14" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/ops/workspaces/workspace-a/remote-workers/bootstrap",
        headers,
        payload: bootstrapRequestBody(),
      });
      expect([401, 403]).toContain(response.statusCode);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("198.51.100.14");
    }
    expect(issueBootstrap).not.toHaveBeenCalled();
  });

  it("returns a secret-free replay receipt and maps disabled runtime trust to a no-store 503", async () => {
    const issueBootstrap = vi
      .fn()
      .mockResolvedValueOnce(bootstrapResponse())
      .mockResolvedValueOnce(bootstrapResponse({ disposition: "replayed_without_secret", bootstrapSecret: undefined }))
      .mockRejectedValueOnce(new RemoteWorkerOperatorControlUnavailableError());
    app = await buildLoopbackBootstrapHarness(issueBootstrap);

    const request = (idempotencyKey: string) =>
      app!.inject({
        method: "POST",
        url: "/api/v1/ops/workspaces/workspace-a/remote-workers/bootstrap",
        headers: { "Idempotency-Key": idempotencyKey },
        payload: bootstrapRequestBody(),
      });
    expect((await request("bootstrap-created")).json()).toHaveProperty("bootstrapSecret");
    const replay = await request("bootstrap-replay");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ disposition: "replayed_without_secret" });
    expect(replay.json()).not.toHaveProperty("bootstrapSecret");
    const unavailable = await request("bootstrap-unavailable");
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers["cache-control"]).toBe("no-store");
    expect(unavailable.json()).toEqual({ error: "Remote worker operator control is unavailable." });
  });

  it("binds quarantine and revoke to the path workspace, generation, actor, and idempotency identity", async () => {
    const quarantineGeneration = vi.fn(async () => controlResponse("quarantine"));
    const revokeGeneration = vi.fn(async () => controlResponse("revoke"));
    app = await buildOperatorMutationHarness({ quarantineGeneration, revokeGeneration });

    const quarantine = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a/generations/1/quarantine",
      headers: { "Idempotency-Key": "quarantine-a" },
      payload: { reasonCode: "integrity.checkpoint_missed", reason: "Worker missed a signed checkpoint." },
    });
    expect(quarantine.statusCode).toBe(200);
    expect(quarantine.headers["cache-control"]).toBe("no-store");
    expect(quarantineGeneration).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      workerId: "worker-a",
      workerGeneration: 1,
      reasonCode: "integrity.checkpoint_missed",
      reason: "Worker missed a signed checkpoint.",
      actorId: "operator-a",
      idempotencyKey: "quarantine-a",
    });

    const revoke = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a/generations/2/revoke",
      headers: { "Idempotency-Key": "revoke-a" },
      payload: { reasonCode: "operator.revoked", reason: "Operator retired this worker generation." },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revokeGeneration).toHaveBeenCalledWith(expect.objectContaining({ workerGeneration: 2 }));
  });

  it("rejects malformed and secret-like control input without echo, and hides cross-workspace existence", async () => {
    const secret = "Authorization: Bearer ghp_SUPER_SECRET_TOKEN_1234567890";
    const quarantineGeneration = vi.fn(async () => {
      throw new RemoteWorkerRegistryInputError();
    });
    const revokeGeneration = vi.fn(async () => {
      throw new NotFoundError({ entity: "remote worker generation", id: "unavailable" });
    });
    app = await buildOperatorMutationHarness({ quarantineGeneration, revokeGeneration });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a/generations/1/quarantine",
      headers: { "Idempotency-Key": "quarantine-secret" },
      payload: { reasonCode: "operator.quarantine", reason: secret },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain(secret);

    const foreign = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/foreign/remote-workers/worker-a/generations/1/revoke",
      headers: { "Idempotency-Key": "revoke-foreign" },
      payload: { reasonCode: "operator.revoked", reason: "Operator retired this generation." },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toMatch(/workspace-a|controlRevision|reasonSha256/u);
  });
});

const AUTH_CONFIG = {
  mode: "token",
  allowLoopbackBypass: false,
  token: { value: "operator-token", queryParam: "access_token" },
  basic: { username: "operator", password: "password123" },
} satisfies AuthConfig;

async function buildLoopbackBootstrapHarness(issueBootstrap: ReturnType<typeof vi.fn>): Promise<FastifyInstance> {
  const instance = Fastify({ trustProxy: true });
  instance.decorate("gatewayConfig", {
    assistant: { auth: { ...AUTH_CONFIG, allowLoopbackBypass: true } },
  } as never);
  instance.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: true }),
    validateDeviceAccessToken: () => undefined,
    validateCompanionAccessToken: () => undefined,
    verifyCompanionRequestSignature: () => undefined,
  } as never);
  instance.decorate("services", { remoteWorkers: fullService({ issueBootstrap }) } as never);
  await instance.register(authPlugin);
  await instance.register(idempotencyHeaderPlugin);
  await instance.register(remoteWorkersRoutes);
  return instance;
}

async function buildOperatorMutationHarness(overrides: Record<string, unknown>): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.decorate("requireOperatorAuth", async () => undefined);
  instance.decorateRequest("authActorId", "operator-a");
  instance.decorateRequest("authActorSource", "token");
  instance.decorate("services", { remoteWorkers: fullService(overrides) } as never);
  await instance.register(idempotencyHeaderPlugin);
  await instance.register(remoteWorkersRoutes);
  return instance;
}

function bootstrapResponse(
  overrides: { disposition?: "created" | "replayed_without_secret"; bootstrapSecret?: string } = {},
) {
  const disposition = overrides.disposition ?? "created";
  return {
    disposition,
    workspaceId: "workspace-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    nodeId: "node-a",
    targetWorkerGeneration: 1,
    state: "pending",
    expiresAt: "2026-08-08T12:10:00.000Z",
    manifestPayloadSha256: "1".repeat(64),
    auditDeliveryId: "remote-worker-bootstrap:bootstrap-a:issued",
    ...(disposition === "created"
      ? { bootstrapSecret: overrides.bootstrapSecret ?? Buffer.alloc(32, 3).toString("base64url") }
      : {}),
  };
}

function controlResponse(action: "quarantine" | "revoke") {
  return {
    workspaceId: "workspace-a",
    workerId: "worker-a",
    workerGeneration: 1,
    controlRevision: 1,
    action,
    reasonCode: "operator.control",
    reasonSha256: "2".repeat(64),
    actorId: "operator-a",
    createdAt: "2026-08-08T12:00:00.000Z",
    auditDeliveryId: `remote-worker-control:${action}:${"3".repeat(64)}`,
  };
}

function bootstrapRequestBody() {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: "1".repeat(64),
    dependencyLockSha256: "2".repeat(64),
    vendorTreeSha256: "3".repeat(64),
    launcherSha256: "4".repeat(64),
    installedTreeManifestSha256: "5".repeat(64),
    installedTreeFileCount: 5,
    platform: "windows",
    architecture: "x64",
  } as const;
  const signerSpki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x29)]);
  return {
    workerLabel: "Windows workstation",
    platform: "windows",
    architecture: "x64",
    runtimeManifest: {
      payload,
      payloadSha256: createHash("sha256").update(canonicalJsonString(payload), "utf8").digest("hex"),
      signatureAlgorithm: "ed25519",
      signerKeyId: "release-signer-a",
      signatureBase64Url: Buffer.alloc(64, 8).toString("base64url"),
    },
    allowedWorkspaceIds: ["workspace-a"],
    capabilityClasses: ["durable_compute"],
    protectedAdmissionSignerPin: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
      signatureAlgorithm: "ed25519",
      keysetGeneration: 1,
      keysetReceiptSha256: "6".repeat(64),
      signerSpkiSha256: createHash("sha256").update(signerSpki).digest("hex"),
      signerSpkiBase64Url: signerSpki.toString("base64url"),
    },
    expiresInSeconds: 600,
  };
}

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
