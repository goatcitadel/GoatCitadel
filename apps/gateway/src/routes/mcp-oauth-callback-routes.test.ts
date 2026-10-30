import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetMcpOAuthReturnsForTests,
  registerMcpOAuthCallbackRoute,
  rememberMcpOAuthReturn,
} from "./mcp-oauth-callback-routes.js";

async function buildApp() {
  const app = Fastify();
  registerMcpOAuthCallbackRoute(app);
  await app.ready();
  return app;
}

describe("MCP OAuth callback hand-off", () => {
  afterEach(() => __resetMcpOAuthReturnsForTests());

  it("redirects the code to the Mission Control origin that started sign-in, in the fragment only", async () => {
    const app = await buildApp();
    rememberMcpOAuthReturn("state-1", "http://127.0.0.1:5173");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/mcp/oauth/callback?state=state-1&code=abc%2F123&iss=x",
    });
    expect(response.statusCode).toBe(303);
    const location = new URL(response.headers.location as string);
    expect(location.origin).toBe("http://127.0.0.1:5173");
    expect(location.pathname).toBe("/capabilities/connectors/advanced");
    expect(location.search).toBe("");
    expect(location.hash).toBe("#mcp-oauth-return&state=state-1&code=abc%2F123");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    await app.close();
  });

  it("hands back provider errors and forgets each state after one use", async () => {
    const app = await buildApp();
    rememberMcpOAuthReturn("state-2", "http://127.0.0.1:5173");
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/mcp/oauth/callback?state=state-2&error=access_denied",
    });
    expect(new URL(denied.headers.location as string).hash).toBe("#mcp-oauth-return&state=state-2&error=access_denied");
    const replay = await app.inject({ method: "GET", url: "/api/v1/mcp/oauth/callback?state=state-2&code=late" });
    expect(replay.statusCode).toBe(410);
    expect(replay.body).not.toContain("late");
    await app.close();
  });

  it("does not redirect unknown, expired, or malformed responses", async () => {
    const app = await buildApp();
    rememberMcpOAuthReturn("old", "http://127.0.0.1:5173", Date.now() - 11 * 60 * 1000);
    expect((await app.inject({ method: "GET", url: "/api/v1/mcp/oauth/callback?state=old&code=c" })).statusCode).toBe(
      410,
    );
    expect((await app.inject({ method: "GET", url: "/api/v1/mcp/oauth/callback?state=never&code=c" })).statusCode).toBe(
      410,
    );
    const malformed = await app.inject({ method: "GET", url: "/api/v1/mcp/oauth/callback?state=s&code=c&error=e" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers.location).toBeUndefined();
    rememberMcpOAuthReturn("no-origin", undefined);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/mcp/oauth/callback?state=no-origin&code=c" })).statusCode,
    ).toBe(410);
    await app.close();
  });
});
