import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "./auth.js";
import { authRoutes } from "../routes/auth.js";
import type { AuthConfig } from "../config.js";

function defaultAuthConfig(): AuthConfig {
  return {
    mode: "token",
    allowLoopbackBypass: false,
    token: {
      value: "test-token",
      queryParam: "access_token",
    },
    basic: {
      username: "operator",
      password: "password123",
    },
  };
}

async function buildApp(authPatch: Partial<AuthConfig>): Promise<FastifyInstance> {
  const auth = {
    ...defaultAuthConfig(),
    ...authPatch,
    token: {
      ...defaultAuthConfig().token,
      ...(authPatch.token ?? {}),
    },
    basic: {
      ...defaultAuthConfig().basic,
      ...(authPatch.basic ?? {}),
    },
  } satisfies AuthConfig;

  const app = Fastify();
  app.decorate("gateway", {
    validateDeviceAccessToken: (token: string) => {
      if (token === "device-bearer") {
        return { actorId: "device:test-grant" };
      }
      return undefined;
    },
    createDeviceAccessRequest: async () => ({
      requestId: "request-device-1",
      requestSecret: "request-secret-1",
      approvalId: "approval-device-1",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollAfterMs: 2500,
      message: "Waiting for approval.",
    }),
    getDeviceAccessRequestStatus: async () => ({
      requestId: "request-device-1",
      approvalId: "approval-device-1",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      message: "Waiting for approval.",
    }),
  } as never);
  app.decorate("gatewayConfig", {
    assistant: {
      auth,
    },
  } as never);

  await app.register(authPlugin);
  await app.register(authRoutes);

  app.get("/protected", async (request) => ({
    ok: true,
    actorId: request.authActorId,
    actorSource: request.authActorSource,
  }));

  app.get("/api/v1/events/stream", async (request) => ({
    ok: true,
    actorId: request.authActorId,
    actorSource: request.authActorSource,
  }));

  return app;
}

describe("auth plugin", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("accepts valid bearer token in token mode", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: "Bearer alpha-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      actorSource: "token",
    });
  });

  it("rejects missing and oversized tokens in token mode", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const missing = await app.inject({
      method: "GET",
      url: "/protected",
    });
    expect(missing.statusCode).toBe(401);

    const oversizedToken = "x".repeat(4097);
    const oversized = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: `Bearer ${oversizedToken}`,
      },
    });
    expect(oversized.statusCode).toBe(401);
  });

  it("rejects deprecated query-param auth tokens on normal routes", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected?access_token=alpha-token",
    });

    expect(response.statusCode).toBe(401);
  });

  it("handles long token comparisons via timing-safe flow", async () => {
    const longToken = "t".repeat(3000);
    app = await buildApp({
      mode: "token",
      token: { value: longToken, queryParam: "access_token" },
    });

    const valid = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: `Bearer ${longToken}`,
      },
    });
    expect(valid.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: `Bearer ${longToken.slice(0, -1)}x`,
      },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("accepts valid basic auth and rejects invalid credentials", async () => {
    app = await buildApp({
      mode: "basic",
      basic: { username: "goat", password: "citadel" },
    });

    const valid = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: `Basic ${Buffer.from("goat:citadel", "utf8").toString("base64")}`,
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ actorSource: "basic" });

    const invalid = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: `Basic ${Buffer.from("goat:wrong", "utf8").toString("base64")}`,
      },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("allows loopback bypass when enabled", async () => {
    app = await buildApp({
      mode: "token",
      allowLoopbackBypass: true,
      token: { value: undefined, queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorSource: "loopback",
    });
  });

  it("issues one-time SSE bridge token and rejects reuse", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "sse-bearer", queryParam: "access_token" },
    });

    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sse-token",
      headers: {
        Authorization: "Bearer sse-bearer",
      },
    });
    expect(issue.statusCode).toBe(200);
    const { token } = issue.json() as { token: string };
    expect(token).toBeTruthy();

    const firstUse = await app.inject({
      method: "GET",
      url: `/api/v1/events/stream?sse_token=${encodeURIComponent(token)}`,
    });
    expect(firstUse.statusCode).toBe(200);
    expect(firstUse.json()).toMatchObject({ actorSource: "sse" });

    const secondUse = await app.inject({
      method: "GET",
      url: `/api/v1/events/stream?sse_token=${encodeURIComponent(token)}`,
    });
    expect(secondUse.statusCode).toBe(401);
  });

  it("rejects expired SSE bridge token", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-05T01:00:00.000Z");
    vi.setSystemTime(now);

    app = await buildApp({
      mode: "token",
      token: { value: "sse-bearer", queryParam: "access_token" },
    });

    const issued = app.issueSseToken("events:stream", 30_000);
    vi.setSystemTime(new Date(now.getTime() + 31_000));

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/events/stream?sse_token=${encodeURIComponent(issued.token)}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts approved device bearer tokens across auth modes", async () => {
    app = await buildApp({
      mode: "basic",
      basic: { username: "goat", password: "citadel" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: "Bearer device-bearer",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorSource: "device",
      actorId: "device:test-grant",
    });
  });

  it("allows anonymous device approval request creation", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-requests",
      payload: {
        deviceLabel: "iPhone Safari",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      requestId: "request-device-1",
      approvalId: "approval-device-1",
      status: "pending",
    });
  });
});
