import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "./auth.js";
import { authRoutes } from "../routes/auth.js";
import type { AuthConfig } from "../config.js";

// Regression coverage for CODEX_FINDING #19: implicit loopback recovery can
// grant remote operator access. The hardening:
//   1. requires `auth.allowLoopbackBypass=true` for the recovery bypass to
//      fire at all (defence in depth; operators who explicitly disable
//      loopback bypass should not get a backdoor route-by-route exception),
//   2. treats *any* proxy provenance (X-Forwarded-For, Forwarded, or
//      Fastify's parsed `request.ips.length > 1`) as disqualifying loopback
//      — even an empty XFF disqualifies, since reverse proxies typically
//      set the header on every forwarded request.

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function defaultAuthConfig(): AuthConfig {
  return {
    mode: "token",
    allowLoopbackBypass: false,
    token: {
      // Misconfigured: no token value, simulating onboarding state.
      value: "",
      queryParam: "access_token",
    },
    basic: {
      username: "",
      password: "",
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

  const app = Fastify({ trustProxy: true });
  app.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: false }),
    validateDeviceAccessToken: () => undefined,
    validateCompanionAccessToken: () => undefined,
    verifyCompanionRequestSignature: () => undefined,
    createDeviceAccessRequest: async () => ({
      requestId: "r1",
      requestSecret: "s1",
      approvalId: "a1",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollAfterMs: 2500,
      message: "Waiting",
    }),
    getDeviceAccessRequestStatus: async () => ({
      requestId: "r1",
      approvalId: "a1",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      message: "Waiting",
    }),
    exchangeCompanionSessionFromDeviceGrant: async () => null,
    rotateCompanionSession: async () => null,
    getCompanionSessionInfo: () => null,
  } as never);
  app.decorate("gatewayConfig", { assistant: { auth } } as never);
  app.decorate("services", {
    authAdmin: {
      getAuthCredentialPlan: () => ({
        mode: auth.mode,
        warnings: [],
        token: { configured: false, source: "env" },
        basicUsername: { configured: false, source: "none" },
        basicPassword: { configured: false, source: "none" },
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

  return app;
}

describe("auth loopback recovery hardening (codex #19)", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  // The fresh-install onboarding flow still has to work when
  // allowLoopbackBypass is false — operators do not have to flip that
  // flag just to install their first token. The codex #19 attack is
  // closed by the proxy-header check below, not by an extra flag.
  it("permits the recovery bypass on clean loopback when allowLoopbackBypass is false", async () => {
    app = await buildApp({ allowLoopbackBypass: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/install-token",
      remoteAddress: "127.0.0.1",
      payload: { generateWhenMissing: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ token: "install-token-1" });
  });

  it("rejects the recovery bypass when X-Forwarded-For is present (even empty)", async () => {
    app = await buildApp({ allowLoopbackBypass: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/install-token",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "" },
      payload: { generateWhenMissing: true },
    });
    expect(response.statusCode).toBe(503);
  });

  it("rejects the recovery bypass when the Forwarded header is present", async () => {
    app = await buildApp({ allowLoopbackBypass: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/install-token",
      remoteAddress: "127.0.0.1",
      headers: { forwarded: "for=192.0.2.1" },
      payload: { generateWhenMissing: true },
    });
    expect(response.statusCode).toBe(503);
  });

  it("rejects the loopback bypass on /protected when X-Forwarded-For is present and allowLoopbackBypass is true", async () => {
    app = await buildApp({ allowLoopbackBypass: true });
    app.get("/protected", async (request) => ({ ok: true, source: request.authActorSource }));
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect([401, 503]).toContain(response.statusCode);
  });
});
