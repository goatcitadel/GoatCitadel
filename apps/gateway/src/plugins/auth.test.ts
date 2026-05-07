import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "./auth.js";
import { authRoutes } from "../routes/auth.js";
import type { AuthConfig } from "../config.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

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
  app.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({
      completed: false,
    }),
    validateDeviceAccessToken: (token: string) => {
      if (token === "device-bearer") {
        return {
          actorId: "device:test-grant",
          deviceId: "test-grant",
          grantId: "test-grant",
        };
      }
      return undefined;
    },
    validateCompanionAccessToken: (token: string) => {
      if (token === "companion-bearer") {
        return {
          actorId: "companion:test-session",
          deviceId: "test-grant",
          grantId: "test-grant",
          sessionId: "test-session",
        };
      }
      return undefined;
    },
    verifyCompanionRequestSignature: (input: { path: string }) => {
      if (input.path.includes("?")) {
        throw new Error("Companion signed mutations must not include query parameters.");
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
    exchangeCompanionSessionFromDeviceGrant: async () => ({
      contractId: "companion.android.v1",
      sessionId: "test-session",
      grantId: "test-grant",
      actorId: "companion:test-session",
      deviceLabel: "Pixel 9",
      deviceType: "mobile",
      platform: "Android",
      accessToken: "companion-bearer",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "refresh-token",
      refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      issuedAt: new Date().toISOString(),
      signatureAlgorithm: "ed25519",
    }),
    rotateCompanionSession: async () => ({
      contractId: "companion.android.v1",
      sessionId: "test-session",
      grantId: "test-grant",
      actorId: "companion:test-session",
      accessToken: "companion-bearer-next",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "refresh-token-next",
      refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      issuedAt: new Date().toISOString(),
      signatureAlgorithm: "ed25519",
    }),
    getCompanionSessionInfo: () => ({
      contractId: "companion.android.v1",
      sessionId: "test-session",
      grantId: "test-grant",
      actorId: "companion:test-session",
      deviceLabel: "Pixel 9",
      deviceType: "mobile",
      platform: "Android",
      createdAt: new Date().toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      signatureAlgorithm: "ed25519",
      metadata: {},
    }),
  } as never);
  app.decorate("gatewayConfig", {
    assistant: {
      auth,
    },
  } as never);
  app.decorate("services", {
    authAdmin: {
      getAuthCredentialPlan: () => ({
        mode: auth.mode,
        warnings: [],
        token: {
          configured: Boolean(auth.token.value?.trim()),
          source: auth.mode === "token" ? "env" : "none",
        },
        basicUsername: {
          configured: Boolean(auth.basic.username?.trim()),
          source: auth.mode === "basic" ? "env" : "none",
        },
        basicPassword: {
          configured: Boolean(auth.basic.password?.trim()),
          source: auth.mode === "basic" ? "env" : "none",
        },
      }),
      resolveGatewayInstallToken: async () => ({
        token: "install-token-1",
        source: "env",
        persistedToEnv: false,
        warnings: [],
      }),
      createDeviceAccessRequest: app.gatewayAuth.createDeviceAccessRequest,
      getDeviceAccessRequestStatus: app.gatewayAuth.getDeviceAccessRequestStatus,
      exchangeCompanionSessionFromDeviceGrant: app.gatewayAuth.exchangeCompanionSessionFromDeviceGrant,
      rotateCompanionSession: app.gatewayAuth.rotateCompanionSession,
      getCompanionSessionInfo: app.gatewayAuth.getCompanionSessionInfo,
      listCompanionSessions: () => [],
      getCompanionSessionRecord: () => undefined,
      revokeCompanionSession: async () => ({ revoked: true }),
      listCompanionAuditEvents: async () => [],
      listDeviceAccessGrants: () => [],
      revokeDeviceAccessGrant: async (grantId: string) => ({ grantId }),
    },
  } as never);

  await app.register(authPlugin);
  await app.register(authRoutes);

  app.get("/protected", async (request) => ({
    ok: true,
    actorId: request.authActorId,
    actorSource: request.authActorSource,
  }));

  app.get("/api/v1/onboarding/startup", async (request) => ({
    ok: true,
    actorId: request.authActorId,
    actorSource: request.authActorSource,
  }));

  app.get("/api/v1/events/stream", async (request) => ({
    ok: true,
    actorId: request.authActorId,
    actorSource: request.authActorSource,
  }));

  app.get("/api/v1/dev/diagnostics/stream", async (request) => ({
    ok: true,
    actorId: request.authActorId,
    actorSource: request.authActorSource,
  }));

  app.post("/protected-write", async (request) => ({
    ok: true,
    actorId: request.authActorId,
    actorSource: request.authActorSource,
    body: request.body,
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

  it("accepts case-insensitive bearer auth with extra whitespace", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: "bEaReR   alpha-token   ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorSource: "token",
    });
  });

  it("short-circuits device and companion lookups for the configured operator token", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const validateDeviceAccessToken = vi.fn(() => undefined);
    const validateCompanionAccessToken = vi.fn(() => undefined);
    app.gatewayAuth.validateDeviceAccessToken = validateDeviceAccessToken;
    app.gatewayAuth.validateCompanionAccessToken = validateCompanionAccessToken;

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: "Bearer alpha-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorSource: "token",
    });
    expect(validateDeviceAccessToken).not.toHaveBeenCalled();
    expect(validateCompanionAccessToken).not.toHaveBeenCalled();
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
    const warnSpy = vi.spyOn(app.log, "warn");

    const response = await app.inject({
      method: "GET",
      url: "/protected?access_token=alpha-token",
    });

    expect(response.statusCode).toBe(401);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "token",
        queryParam: "access_token",
        url: "/protected?access_token=alpha-token",
      }),
      "assistant.auth.token.queryParam is deprecated for normal gateway requests; only SSE bridge tokens still use query parameters.",
    );
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

  it("accepts case-insensitive basic auth with extra whitespace", async () => {
    app = await buildApp({
      mode: "basic",
      basic: { username: "goat", password: "citadel" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: `bAsIc   ${Buffer.from("goat:citadel", "utf8").toString("base64")}   `,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ actorSource: "basic" });
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

  it("allows loopback onboarding recovery when token auth is enabled without a token", async () => {
    app = await buildApp({
      mode: "token",
      allowLoopbackBypass: false,
      token: { value: undefined, queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/onboarding/startup",
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorSource: "loopback",
    });
  });

  it("keeps non-recovery routes blocked when token auth is enabled without a token", async () => {
    app = await buildApp({
      mode: "token",
      allowLoopbackBypass: false,
      token: { value: undefined, queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(503);
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

  it("accepts diagnostics SSE bridge tokens on the diagnostics stream", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "sse-bearer", queryParam: "access_token" },
    });

    const issued = app.issueSseToken("dev:diagnostics:stream", 30_000);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/dev/diagnostics/stream?sse_token=${encodeURIComponent(issued.token)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ actorSource: "sse" });
  });

  it("consumes SSE bridge tokens on wrong-scope attempts", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "sse-bearer", queryParam: "access_token" },
    });

    const issued = app.issueSseToken("dev:diagnostics:stream", 30_000);

    const wrongScope = await app.inject({
      method: "GET",
      url: `/api/v1/events/stream?sse_token=${encodeURIComponent(issued.token)}`,
    });
    expect(wrongScope.statusCode).toBe(401);

    const retryOnCorrectScope = await app.inject({
      method: "GET",
      url: `/api/v1/dev/diagnostics/stream?sse_token=${encodeURIComponent(issued.token)}`,
    });
    expect(retryOnCorrectScope.statusCode).toBe(401);
  });

  it("evicts the oldest SSE bridge token when one actor exceeds the per-actor cap", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "sse-bearer", queryParam: "access_token" },
    });

    const issued = Array.from({ length: 51 }, () => app!.issueSseToken("events:stream", 30_000, "token:test-actor"));

    const oldest = await app.inject({
      method: "GET",
      url: `/api/v1/events/stream?sse_token=${encodeURIComponent(issued[0]!.token)}`,
    });
    expect(oldest.statusCode).toBe(401);

    const newest = await app.inject({
      method: "GET",
      url: `/api/v1/events/stream?sse_token=${encodeURIComponent(issued.at(-1)?.token ?? "")}`,
    });
    expect(newest.statusCode).toBe(200);
    expect(newest.json()).toMatchObject({ actorSource: "sse" });
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

  it("accepts companion bearer tokens for read requests", async () => {
    app = await buildApp({
      mode: "basic",
      basic: { username: "goat", password: "citadel" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        Authorization: "Bearer companion-bearer",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorSource: "companion",
      actorId: "companion:test-session",
    });
  });

  it("rejects unsigned companion mutating requests", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/protected-write",
      headers: {
        Authorization: "Bearer companion-bearer",
      },
      payload: {
        action: "mutate",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "Missing companion request signature headers.",
    });
  });

  it("accepts signed companion mutating requests", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/protected-write",
      headers: {
        Authorization: "Bearer companion-bearer",
        "x-goatcitadel-companion-timestamp": "2026-03-30T12:00:00.000Z",
        "x-goatcitadel-companion-nonce": "nonce-123456",
        "x-goatcitadel-companion-signature": "ZmFrZV9zaWduYXR1cmU",
      },
      payload: {
        action: "mutate",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorSource: "companion",
      actorId: "companion:test-session",
      body: {
        action: "mutate",
      },
    });
  });

  it("rejects companion mutating requests that include query params", async () => {
    app = await buildApp({
      mode: "token",
      token: { value: "alpha-token", queryParam: "access_token" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/protected-write?force=true",
      headers: {
        Authorization: "Bearer companion-bearer",
        "x-goatcitadel-companion-timestamp": "2026-03-30T12:00:00.000Z",
        "x-goatcitadel-companion-nonce": "nonce-123456",
        "x-goatcitadel-companion-signature": "ZmFrZV9zaWduYXR1cmU",
      },
      payload: {
        action: "mutate",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "Companion signed mutations must not include query parameters.",
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
