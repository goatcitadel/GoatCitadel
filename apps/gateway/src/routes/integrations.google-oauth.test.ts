import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import {
  __resetGoogleOAuthReturnsForTests,
  registerGoogleOAuthIntegrationRoutes,
} from "./integrations-google-oauth-routes.js";
import { installRouteAccessTracking } from "./route-access.js";

const connectionId = "33333333-3333-4333-8333-333333333333";
const state = "44444444-4444-4444-8444-444444444444";
let app: FastifyInstance;

function fixture() {
  app = Fastify();
  const integrations = {
    getGoogleWorkspaceOAuthStatus: vi.fn(async () => ({ connectionId, connected: false })),
    startGoogleWorkspaceOAuth: vi.fn(async () => ({
      connectionId,
      state,
      authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      redirectUri: "http://127.0.0.1:8787/api/v1/integrations/google/oauth/callback",
      capabilities: ["gmail.read"],
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
    completeGoogleWorkspaceOAuth: vi.fn(async () => ({ connectionId, connected: true })),
    disconnectGoogleWorkspaceOAuth: vi.fn(async () => ({
      revoked: true,
      message: "ended",
      status: { connected: false },
    })),
  };
  app.decorate("services", { integrations } as never);
  registerGoogleOAuthIntegrationRoutes(app);
  return integrations;
}

afterEach(async () => {
  __resetGoogleOAuthReturnsForTests();
  await app?.close();
});

describe("Google Workspace sign-in routes", () => {
  it("starts only with reviewed capabilities and hands Google's redirect back to the starting origin in the fragment", async () => {
    const integrations = fixture();
    const base = `/api/v1/integrations/connections/${connectionId}/google-oauth`;
    expect(
      (await app.inject({ method: "POST", url: `${base}/start`, payload: { capabilities: ["drive.read"] } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: `${base}/start`, payload: { capabilities: ["gmail.read"], extra: 1 } }))
        .statusCode,
    ).toBe(400);
    const started = await app.inject({
      method: "POST",
      url: `${base}/start`,
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { capabilities: ["gmail.read"], clientSecret: "GOCSPX-secret" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.headers["cache-control"]).toBe("no-store");
    expect(integrations.startGoogleWorkspaceOAuth).toHaveBeenCalledWith(connectionId, {
      capabilities: ["gmail.read"],
      clientSecret: "GOCSPX-secret",
    });
    expect(started.body).not.toContain("GOCSPX-secret");

    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/google/oauth/callback?state=${state}&code=4%2F0Adeu&scope=x`,
    });
    expect(callback.statusCode).toBe(303);
    const location = new URL(callback.headers.location as string);
    expect(location.origin).toBe("http://127.0.0.1:5173");
    expect(location.pathname).toBe("/capabilities/connectors/advanced");
    expect(location.search).toBe("");
    expect(location.hash).toBe(`#google-oauth-return&state=${state}&code=4%2F0Adeu`);
    expect(callback.headers["referrer-policy"]).toBe("no-referrer");
    // One use per state; the callback itself exchanges nothing.
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/integrations/google/oauth/callback?state=${state}&code=again` }))
        .statusCode,
    ).toBe(410);
    expect(integrations.completeGoogleWorkspaceOAuth).not.toHaveBeenCalled();
  });

  it("completes, reports status and disconnects through the integration owner", async () => {
    const integrations = fixture();
    const base = `/api/v1/integrations/connections/${connectionId}/google-oauth`;
    expect(
      (await app.inject({ method: "POST", url: `${base}/complete`, payload: { state: "nope", code: "c" } })).statusCode,
    ).toBe(400);
    const completed = await app.inject({
      method: "POST",
      url: `${base}/complete`,
      payload: { state, code: "4/0Adeu" },
    });
    expect(completed.statusCode).toBe(200);
    expect(integrations.completeGoogleWorkspaceOAuth).toHaveBeenCalledWith(connectionId, { state, code: "4/0Adeu" });
    integrations.completeGoogleWorkspaceOAuth.mockRejectedValueOnce(
      new ConflictError({ message: "This Google sign-in is no longer pending. Start Connect Google again." }),
    );
    const stale = await app.inject({ method: "POST", url: `${base}/complete`, payload: { state, code: "4/0Adeu" } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: base })).json()).toEqual({ connectionId, connected: false });
    const disconnected = await app.inject({ method: "POST", url: `${base}/disconnect`, payload: {} });
    expect(disconnected.json()).toMatchObject({ revoked: true });
  });

  it("keeps only the provider callback public", async () => {
    app = Fastify();
    installRouteAccessTracking(app);
    app.decorate("services", { integrations: {} } as never);
    registerGoogleOAuthIntegrationRoutes(app);
    await app.ready();
    const classes = Object.fromEntries(
      app.routeAccessManifest
        .filter((entry) => entry.method !== "HEAD")
        .map((entry) => [`${entry.method} ${entry.url}`, entry.accessClass]),
    );
    expect(classes).toEqual({
      "GET /api/v1/integrations/google/oauth/callback": "public",
      "GET /api/v1/integrations/connections/:connectionId/google-oauth": "operator",
      "POST /api/v1/integrations/connections/:connectionId/google-oauth/start": "operator",
      "POST /api/v1/integrations/connections/:connectionId/google-oauth/complete": "operator",
      "POST /api/v1/integrations/connections/:connectionId/google-oauth/disconnect": "operator",
    });
  });
});
