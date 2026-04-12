import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AuthConfig } from "../config.js";
import { authPlugin } from "../plugins/auth.js";
import { adminRoutes } from "./admin.js";
import { authRoutes } from "./auth.js";
import { durableRoutes } from "./durable.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

const DEVICE_GRANT_ID = "ef7d2d5a-f19c-4aa0-b5cf-1a501928ea3f";
const COMPANION_SESSION_ID = "4b229ee9-bf83-4012-86c8-620f6e5306e0";

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

function createGatewayMocks() {
  const verifyCompanionRequestSignature = vi.fn(() => undefined);
  const listDeviceAccessGrants = vi.fn(() => [
    {
      grantId: DEVICE_GRANT_ID,
      requestId: "request-device-1",
      actorId: `device:${DEVICE_GRANT_ID}`,
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
  ]);
  const resolveGatewayInstallToken = vi.fn(async () => ({
    token: "install-token-1",
    source: "env",
    persistedToEnv: false,
    warnings: [],
  }));
  const listCompanionSessions = vi.fn(() => ({
    items: [
      {
        contractId: "companion.android.v1",
        sessionId: COMPANION_SESSION_ID,
        grantId: DEVICE_GRANT_ID,
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
  }));
  const getRetentionPolicy = vi.fn(() => ({
    realtimeEventsDays: 14,
    backupsKeep: 5,
  }));
  const createBackup = vi.fn(async () => ({
    backupId: "backup-1",
    filePath: "F:/code/personal-ai/backups/backup-1.zip",
    createdAt: "2026-04-11T00:00:00.000Z",
  }));
  const getDurableDiagnostics = vi.fn(() => ({
    enabled: true,
    replayFoundationReady: true,
    runCount: 2,
    queuedCount: 0,
    runningCount: 1,
    waitingCount: 1,
    failedCount: 0,
    deadLetterCount: 0,
    recentRuns: [],
    recentDeadLetters: [],
    generatedAt: "2026-04-11T00:00:00.000Z",
  }));
  const resumeDurableRun = vi.fn((runId: string, actorId: string) => ({
    runId,
    status: "running",
    actorId,
  }));

  return {
    gateway: {
      getAuthCredentialPlan: () => ({
        mode: "token",
        warnings: [],
        token: {
          configured: true,
          source: "env",
        },
        basicUsername: {
          configured: false,
          source: "none",
        },
        basicPassword: {
          configured: false,
          source: "none",
        },
      }),
      listDeviceAccessGrants,
      resolveGatewayInstallToken,
      listCompanionSessions,
      getRetentionPolicy,
      createBackup,
      getDurableDiagnostics,
      resumeDurableRun,
      validateDeviceAccessToken: (token: string) =>
        token === "device-bearer"
          ? {
              actorId: `device:${DEVICE_GRANT_ID}`,
              deviceId: DEVICE_GRANT_ID,
              grantId: DEVICE_GRANT_ID,
            }
          : undefined,
      validateCompanionAccessToken: (token: string) =>
        token === "companion-bearer"
          ? {
              actorId: `companion:${COMPANION_SESSION_ID}`,
              deviceId: DEVICE_GRANT_ID,
              grantId: DEVICE_GRANT_ID,
              sessionId: COMPANION_SESSION_ID,
            }
          : undefined,
      verifyCompanionRequestSignature,
    },
    spies: {
      verifyCompanionRequestSignature,
      listDeviceAccessGrants,
      resolveGatewayInstallToken,
      listCompanionSessions,
      getRetentionPolicy,
      createBackup,
      getDurableDiagnostics,
      resumeDurableRun,
    },
  };
}

async function buildApp(mode: AuthConfig["mode"]) {
  const { gateway, spies } = createGatewayMocks();
  const app = Fastify();
  app.decorate("gateway", gateway as never);
  app.decorate("gatewayConfig", {
    assistant: {
      auth: baseAuthConfig(mode),
    },
  } as never);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(durableRoutes);
  return { app, spies };
}

describe("privileged auth boundary", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("allows operator tokens on representative privileged routes", async () => {
    const built = await buildApp("token");
    app = built.app;

    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/admin/retention",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/durable/diagnostics",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/auth/devices?view=all",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/auth/companion/sessions?view=all",
        headers: { Authorization: "Bearer test-token" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/auth/install-token",
        headers: { Authorization: "Bearer test-token" },
        payload: { generateWhenMissing: true },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
    }
    expect(built.spies.getRetentionPolicy).toHaveBeenCalledTimes(1);
    expect(built.spies.getDurableDiagnostics).toHaveBeenCalledTimes(1);
    expect(built.spies.listDeviceAccessGrants).toHaveBeenCalledTimes(1);
    expect(built.spies.listCompanionSessions).toHaveBeenCalledTimes(1);
    expect(built.spies.resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
  });

  it("preserves operator access for auth.mode=none installs", async () => {
    const built = await buildApp("none");
    app = built.app;

    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/admin/retention",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/durable/diagnostics",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/auth/install-token",
        payload: { generateWhenMissing: true },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
    }
  });

  it("rejects device bearer credentials on representative privileged GET and POST routes", async () => {
    const built = await buildApp("token");
    app = built.app;

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/v1/admin/retention",
      headers: { Authorization: "Bearer device-bearer" },
    });
    const postResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/install-token",
      headers: { Authorization: "Bearer device-bearer" },
      payload: { generateWhenMissing: true },
    });

    expect(getResponse.statusCode).toBe(403);
    expect(postResponse.statusCode).toBe(403);
    expect(built.spies.getRetentionPolicy).not.toHaveBeenCalled();
    expect(built.spies.resolveGatewayInstallToken).not.toHaveBeenCalled();
  });

  it("rejects companion bearer credentials on representative privileged GET routes", async () => {
    const built = await buildApp("token");
    app = built.app;

    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/admin/retention",
        headers: { Authorization: "Bearer companion-bearer" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/durable/diagnostics",
        headers: { Authorization: "Bearer companion-bearer" },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/auth/devices?view=all",
        headers: { Authorization: "Bearer companion-bearer" },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: "Operator authentication is required for this control-plane route.",
      });
    }
  });

  it("rejects signed companion mutations on privileged POST routes after signature verification passes", async () => {
    const built = await buildApp("token");
    app = built.app;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/install-token",
      headers: {
        Authorization: "Bearer companion-bearer",
        "x-goatcitadel-companion-timestamp": "2026-04-11T00:00:00.000Z",
        "x-goatcitadel-companion-nonce": "nonce-1",
        "x-goatcitadel-companion-signature": "signature-1",
      },
      payload: {
        generateWhenMissing: true,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "Operator authentication is required for this control-plane route.",
    });
    expect(built.spies.verifyCompanionRequestSignature).toHaveBeenCalledTimes(1);
    expect(built.spies.resolveGatewayInstallToken).not.toHaveBeenCalled();
  });
});
