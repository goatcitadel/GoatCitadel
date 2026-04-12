import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { authPlugin } from "../plugins/auth.js";
import { authRoutes } from "./auth.js";
import type { AuthConfig } from "../config.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function baseAuthConfig(mode: AuthConfig["mode"]): AuthConfig {
  return {
    mode,
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

const COMPANION_SESSION_ID = "4b229ee9-bf83-4012-86c8-620f6e5306e0";

async function buildApp(
  mode: AuthConfig["mode"],
  options: { registerRateLimit?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("gateway", {
    getAuthCredentialPlan: () => ({
      mode: baseAuthConfig(mode).mode,
      warnings: [],
      token: {
        configured: mode === "token",
        source: mode === "token" ? "env" : "none",
      },
      basicUsername: {
        configured: mode === "basic",
        source: mode === "basic" ? "env" : "none",
      },
      basicPassword: {
        configured: mode === "basic",
        source: mode === "basic" ? "env" : "none",
      },
    }),
    resolveGatewayInstallToken: async () => ({
      token: "install-token-1",
      source: "env",
      persistedToEnv: false,
      warnings: [],
    }),
    createDeviceAccessRequest: async () => ({
      requestId: "request-device-1",
      requestSecret: "request-secret-1",
      approvalId: "approval-device-1",
      status: "pending",
      expiresAt: "2026-03-10T12:00:00.000Z",
      pollAfterMs: 2500,
      message: "Waiting for approval.",
    }),
    getDeviceAccessRequestStatus: async () => ({
      requestId: "request-device-1",
      approvalId: "approval-device-1",
      status: "approved",
      expiresAt: "2026-03-10T12:00:00.000Z",
      resolvedAt: "2026-03-10T11:55:00.000Z",
      deviceToken: "device-bearer",
      deviceTokenExpiresAt: "2026-04-09T11:55:00.000Z",
      message: "Access approved.",
    }),
    listDeviceAccessGrants: () => [
      {
        grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
        requestId: "request-device-1",
        actorId: "device:ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
        deviceLabel: "LAN laptop",
        deviceType: "desktop",
        platform: "windows",
        grantedBy: "operator:test",
        createdAt: "2026-03-10T11:55:00.000Z",
        expiresAt: "2026-04-09T11:55:00.000Z",
        lastUsedAt: "2026-03-10T12:05:00.000Z",
        revokedAt: undefined,
        metadata: {},
      },
    ],
    revokeDeviceAccessGrant: async (grantId: string) => ({
      grantId,
      requestId: "request-device-1",
      actorId: `device:${grantId}`,
      deviceLabel: "LAN laptop",
      deviceType: "desktop",
      platform: "windows",
      grantedBy: "operator:test",
      createdAt: "2026-03-10T11:55:00.000Z",
      expiresAt: "2026-04-09T11:55:00.000Z",
      lastUsedAt: "2026-03-10T12:05:00.000Z",
      revokedAt: "2026-03-10T12:10:00.000Z",
      metadata: {},
    }),
    exchangeCompanionSessionFromDeviceGrant: async (
      grantId: string,
      input: { clientName?: string; appVersion?: string },
    ) => ({
      contractId: "companion.android.v1",
      sessionId: COMPANION_SESSION_ID,
      grantId,
      actorId: `companion:${COMPANION_SESSION_ID}`,
      deviceLabel: "LAN laptop",
      deviceType: "desktop",
      platform: "windows",
      accessToken: "companion-bearer",
      accessTokenExpiresAt: "2026-03-10T12:20:00.000Z",
      refreshToken: "refresh-token-1",
      refreshTokenExpiresAt: "2026-03-11T12:10:00.000Z",
      issuedAt: "2026-03-10T12:10:00.000Z",
      signatureAlgorithm: "ed25519",
      metadata: input,
    }),
    rotateCompanionSession: async () => ({
      contractId: "companion.android.v1",
      sessionId: COMPANION_SESSION_ID,
      grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
      actorId: `companion:${COMPANION_SESSION_ID}`,
      accessToken: "companion-bearer-next",
      accessTokenExpiresAt: "2026-03-10T12:30:00.000Z",
      refreshToken: "refresh-token-2",
      refreshTokenExpiresAt: "2026-03-11T12:20:00.000Z",
      issuedAt: "2026-03-10T12:20:00.000Z",
      signatureAlgorithm: "ed25519",
    }),
    getCompanionSessionInfo: () => ({
      contractId: "companion.android.v1",
      sessionId: COMPANION_SESSION_ID,
      grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
      actorId: `companion:${COMPANION_SESSION_ID}`,
      deviceLabel: "LAN laptop",
      deviceType: "desktop",
      platform: "windows",
      createdAt: "2026-03-10T12:10:00.000Z",
      lastSeenAt: "2026-03-10T12:20:00.000Z",
      accessTokenExpiresAt: "2026-03-10T12:30:00.000Z",
      refreshTokenExpiresAt: "2026-03-11T12:20:00.000Z",
      signatureAlgorithm: "ed25519",
      metadata: {
        clientName: "Android Companion",
      },
    }),
    listCompanionSessions: () => ({
      items: [
        {
          contractId: "companion.android.v1",
          sessionId: COMPANION_SESSION_ID,
          grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
          actorId: `companion:${COMPANION_SESSION_ID}`,
          deviceLabel: "LAN laptop",
          deviceType: "desktop",
          platform: "windows",
          createdAt: "2026-03-10T12:10:00.000Z",
          lastSeenAt: "2026-03-10T12:20:00.000Z",
          lastRotatedAt: "2026-03-10T12:20:00.000Z",
          accessTokenExpiresAt: "2026-03-10T12:30:00.000Z",
          refreshTokenExpiresAt: "2026-03-11T12:20:00.000Z",
          signatureAlgorithm: "ed25519",
          grantExpiresAt: "2026-04-09T11:55:00.000Z",
          metadata: {
            clientName: "Android Companion",
          },
        },
      ],
    }),
    getCompanionSessionRecord: () => ({
      contractId: "companion.android.v1",
      sessionId: COMPANION_SESSION_ID,
      grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
      actorId: `companion:${COMPANION_SESSION_ID}`,
      deviceLabel: "LAN laptop",
      deviceType: "desktop",
      platform: "windows",
      createdAt: "2026-03-10T12:10:00.000Z",
      lastSeenAt: "2026-03-10T12:20:00.000Z",
      lastRotatedAt: "2026-03-10T12:20:00.000Z",
      accessTokenExpiresAt: "2026-03-10T12:30:00.000Z",
      refreshTokenExpiresAt: "2026-03-11T12:20:00.000Z",
      signatureAlgorithm: "ed25519",
      grantExpiresAt: "2026-04-09T11:55:00.000Z",
      metadata: {
        clientName: "Android Companion",
      },
    }),
    revokeCompanionSession: async () => ({
      session: {
        contractId: "companion.android.v1",
        sessionId: COMPANION_SESSION_ID,
        grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
        actorId: `companion:${COMPANION_SESSION_ID}`,
        deviceLabel: "LAN laptop",
        deviceType: "desktop",
        platform: "windows",
        createdAt: "2026-03-10T12:10:00.000Z",
        lastSeenAt: "2026-03-10T12:20:00.000Z",
        lastRotatedAt: "2026-03-10T12:20:00.000Z",
        accessTokenExpiresAt: "2026-03-10T12:30:00.000Z",
        refreshTokenExpiresAt: "2026-03-11T12:20:00.000Z",
        revokedAt: "2026-03-10T12:25:00.000Z",
        signatureAlgorithm: "ed25519",
        grantExpiresAt: "2026-04-09T11:55:00.000Z",
        metadata: {
          clientName: "Android Companion",
        },
      },
    }),
    listCompanionAuditEvents: async () => [
      {
        timestamp: "2026-03-10T12:20:00.000Z",
        event: "auth.companion_request.accepted",
        actorId: `companion:${COMPANION_SESSION_ID}`,
        grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
        companionSessionId: COMPANION_SESSION_ID,
        method: "POST",
        path: "/api/v1/chat/sessions",
        nonce: "nonce-1",
        requestHash: "hash-1",
      },
    ],
    validateDeviceAccessToken: (token: string) =>
      token === "device-bearer"
        ? {
            actorId: "device:ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
            deviceId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
            grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
          }
        : undefined,
    validateCompanionAccessToken: (token: string) =>
      token === "companion-bearer"
        ? {
            actorId: `companion:${COMPANION_SESSION_ID}`,
            deviceId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
            grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
            sessionId: COMPANION_SESSION_ID,
          }
        : undefined,
    verifyCompanionRequestSignature: () => undefined,
  } as never);
  app.decorate("gatewayConfig", {
    assistant: {
      auth: baseAuthConfig(mode),
    },
  } as never);
  if (options.registerRateLimit) {
    await app.register(rateLimit, {
      global: false,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.ip,
      allowList: [],
      max: 20,
    });
    app.addHook("onRoute", (routeOptions) => {
      const currentConfig = (routeOptions.config ?? {}) as Record<string, unknown>;
      const currentRateLimit =
        currentConfig.rateLimit && typeof currentConfig.rateLimit === "object"
          ? (currentConfig.rateLimit as Record<string, unknown>)
          : {};
      routeOptions.config = {
        ...currentConfig,
        rateLimit: {
          ...currentRateLimit,
          max: typeof currentRateLimit.max === "number" ? currentRateLimit.max : 20,
        },
      };
    });
  }
  await app.register(authPlugin);
  await app.register(authRoutes);
  return app;
}

describe("auth routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns 400 for SSE token bridge in auth mode none", async () => {
    app = await buildApp("none");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sse-token",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "SSE token bridge is not needed when auth mode is none",
    });
  });

  it("issues SSE token in token mode", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sse-token",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: expect.any(String),
      expiresAt: expect.any(String),
      scope: "events:stream",
    });
  });

  it("issues diagnostics SSE token when a scope is requested", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sse-token",
      headers: {
        Authorization: "Bearer test-token",
      },
      payload: {
        scope: "dev:diagnostics:stream",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: expect.any(String),
      expiresAt: expect.any(String),
      scope: "dev:diagnostics:stream",
    });
  });

  it("creates a device approval request without prior auth", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-requests",
      payload: {
        deviceLabel: "LAN laptop",
        deviceType: "desktop",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      requestId: "request-device-1",
      approvalId: "approval-device-1",
      status: "pending",
    });
  });

  it("returns the credential plan on the authenticated auth plan route", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/plan",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: "token",
      token: {
        configured: true,
        source: "env",
      },
    });
  });

  it("resolves an install token on the authenticated auth install-token route", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/install-token",
      headers: {
        Authorization: "Bearer test-token",
      },
      payload: {
        generateWhenMissing: true,
        persistToEnv: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: "install-token-1",
      source: "env",
    });
  });

  it("returns device request status when the request secret matches", async () => {
    app = await buildApp("basic");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/device-requests/ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f/status",
      headers: {
        "x-goatcitadel-device-request-secret": "request-secret-1",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestId: "request-device-1",
      status: "approved",
      deviceToken: "device-bearer",
    });
  });

  it("lists approved device grants", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/devices?view=all",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
          deviceLabel: "LAN laptop",
        },
      ],
    });
  });

  it("revokes an approved device grant", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/devices/ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f/revoke",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      grant: {
        grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
        revokedAt: "2026-03-10T12:10:00.000Z",
      },
    });
  });

  it("exchanges a device grant for a companion session bundle", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/companion/session/exchange",
      headers: {
        Authorization: "Bearer device-bearer",
      },
      payload: {
        signingPublicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA7v0fakefakefakefakefakefakefakefakefak=\n-----END PUBLIC KEY-----",
        clientName: "Android Companion",
        appVersion: "0.1.0",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      contractId: "companion.android.v1",
      sessionId: COMPANION_SESSION_ID,
      grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
      accessToken: "companion-bearer",
      refreshToken: "refresh-token-1",
    });
  });

  it("refreshes a companion session without prior auth", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/companion/session/refresh",
      payload: {
        refreshToken: "refresh-token-1",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      contractId: "companion.android.v1",
      sessionId: COMPANION_SESSION_ID,
      accessToken: "companion-bearer-next",
      refreshToken: "refresh-token-2",
    });
  });

  it("returns companion session info for companion-authenticated requests", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/companion/session",
      headers: {
        Authorization: "Bearer companion-bearer",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      contractId: "companion.android.v1",
      sessionId: COMPANION_SESSION_ID,
      actorId: `companion:${COMPANION_SESSION_ID}`,
      metadata: {
        clientName: "Android Companion",
      },
    });
  });

  it("lists companion sessions for operator-authenticated requests", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/companion/sessions?view=all",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          sessionId: COMPANION_SESSION_ID,
          grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
          lastRotatedAt: "2026-03-10T12:20:00.000Z",
        },
      ],
    });
  });

  it("returns one companion session record for operator-authenticated requests", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/companion/sessions/${COMPANION_SESSION_ID}`,
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: COMPANION_SESSION_ID,
      grantId: "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f",
      lastRotatedAt: "2026-03-10T12:20:00.000Z",
    });
  });

  it("revokes one companion session for operator-authenticated requests", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/auth/companion/sessions/${COMPANION_SESSION_ID}/revoke`,
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session: {
        sessionId: COMPANION_SESSION_ID,
        revokedAt: "2026-03-10T12:25:00.000Z",
      },
    });
  });

  it("lists companion audit events for operator-authenticated requests", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/companion/audit?sessionId=${COMPANION_SESSION_ID}`,
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          event: "auth.companion_request.accepted",
          path: "/api/v1/chat/sessions",
        },
      ],
    });
  });

  it("blocks companion admin routes for companion-authenticated requests", async () => {
    app = await buildApp("token");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/companion/sessions",
      headers: {
        Authorization: "Bearer companion-bearer",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "Operator authentication is required for this control-plane route.",
    });
  });

  it("applies tighter per-route rate limits on device request creation", async () => {
    app = await buildApp("token", { registerRateLimit: true });

    let limitedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device-requests",
      remoteAddress: "203.0.113.10",
      payload: {
        deviceLabel: "LAN laptop",
        deviceType: "desktop",
      },
    });

    for (let index = 0; index < 5; index += 1) {
      limitedResponse = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device-requests",
        remoteAddress: "203.0.113.10",
        payload: {
          deviceLabel: `LAN laptop ${index}`,
          deviceType: "desktop",
        },
      });
    }

    expect(limitedResponse.statusCode).toBe(429);
  });
});
