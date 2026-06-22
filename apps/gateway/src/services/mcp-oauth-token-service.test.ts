import http from "node:http";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpStaleAuthInvokeError,
  buildPublicMcpAuthState,
  isMcpAuthReadinessInvokeBlocked,
  McpOAuthTokenService,
  resolveMcpInvokeAuthReadiness,
} from "./mcp-oauth-token-service.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";
import type { SecretStoreService } from "./secret-store-service.js";

describe("McpOAuthTokenService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges authorization codes into OS secret-store refs without serializing raw tokens", async () => {
    vi.setSystemTime(new Date("2026-06-03T12:00:00.000Z"));
    const secretStore = createMemorySecretStore();
    const accessToken = "mcp-access-token-secret-1234567890";
    const refreshToken = "mcp-refresh-token-secret-1234567890";

    await withTokenEndpoint(
      ({ body }) => {
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("secret-code-value");
        expect(body.get("redirect_uri")).toBe("http://127.0.0.1:8787/api/v1/mcp/oauth/callback");
        expect(body.get("client_id")).toBe("client-id-from-env");
        expect(body.get("client_secret")).toBe("client-secret-from-env");
        expect(body.get("scope")).toBe("remote.read remote.write");
        return {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
          scope: "remote.read remote.write",
        };
      },
      async ({ url }) => {
        const service = new McpOAuthTokenService({
          secretStore,
          networkAllowlist: [new URL(url).host],
          env: {
            MCP_CLIENT_ID: "client-id-from-env",
            MCP_CLIENT_SECRET: "client-secret-from-env",
          },
        });
        const server = createOAuthServer(url, {
          oauth: {
            authorizationUrl: "https://mcp.example/oauth/authorize",
            tokenUrl: url,
            clientIdEnv: "MCP_CLIENT_ID",
            clientSecretEnv: "MCP_CLIENT_SECRET",
            scopes: ["remote.read", "remote.write"],
          },
        });

        const state = await service.exchangeAuthorizationCode(server, "secret-code-value", {
          oauthState: "state-1",
          updatedAt: "2026-06-03T11:59:00.000Z",
        });

        expect(state).toMatchObject({
          accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
          refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
          tokenExpiresAt: "2026-06-03T13:00:00.000Z",
          scopes: ["remote.read", "remote.write"],
          resourceIndicator: "mcp://server-1",
          oauthState: undefined,
          lastCodePreview: "secret-c",
        });
        expect(secretStore.getSecret("mcp:server-1:access-token")).toBe(accessToken);
        expect(secretStore.getSecret("mcp:server-1:refresh-token")).toBe(refreshToken);
        const serializedState = JSON.stringify(state);
        expect(serializedState).not.toContain(accessToken);
        expect(serializedState).not.toContain(refreshToken);
        expect(serializedState).not.toContain("secret-code-value");
      },
    );
  });

  it("refreshes near-expired access tokens through stored refresh-token refs", async () => {
    vi.setSystemTime(new Date("2026-06-03T12:00:00.000Z"));
    const secretStore = createMemorySecretStore();
    secretStore.setSecret("mcp:server-1:access-token", "stale-access-token-secret-1234567890");
    secretStore.setSecret("mcp:server-1:refresh-token", "old-refresh-token-secret-1234567890");

    await withTokenEndpoint(
      ({ body }) => {
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh-token-secret-1234567890");
        return {
          access_token: "fresh-access-token-secret-1234567890",
          refresh_token: "rotated-refresh-token-secret-1234567890",
          expires_in: 900,
          scope: "remote.search",
        };
      },
      async ({ url }) => {
        const service = new McpOAuthTokenService({
          secretStore,
          networkAllowlist: [new URL(url).host],
        });
        const server = createOAuthServer(url, {
          oauth: {
            authorizationUrl: "https://mcp.example/oauth/authorize",
            tokenUrl: url,
            tokenRefreshSkewSeconds: 300,
          },
        });
        const stateRecord: McpAuthStateRecord = {
          accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
          refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
          tokenExpiresAt: "2026-06-03T12:02:00.000Z",
          scopes: ["old.scope"],
          updatedAt: "2026-06-03T11:00:00.000Z",
        };

        const resolved = await service.resolveAccessToken(server, stateRecord);

        expect(resolved.accessToken).toBe("fresh-access-token-secret-1234567890");
        expect(secretStore.getSecret("mcp:server-1:access-token")).toBe("fresh-access-token-secret-1234567890");
        expect(secretStore.getSecret("mcp:server-1:refresh-token")).toBe("rotated-refresh-token-secret-1234567890");
        expect(resolved.state).toMatchObject({
          accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
          refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
          tokenExpiresAt: "2026-06-03T12:15:00.000Z",
          scopes: ["remote.search"],
        });
        const serializedState = JSON.stringify(resolved.state);
        expect(serializedState).not.toContain("fresh-access-token-secret");
        expect(serializedState).not.toContain("rotated-refresh-token-secret");
        expect(serializedState).not.toContain("old-refresh-token-secret");
      },
    );
  });

  it("fails closed when an expired OAuth token has no refresh token ref", async () => {
    vi.setSystemTime(new Date("2026-06-03T12:00:00.000Z"));
    const service = new McpOAuthTokenService({
      secretStore: createMemorySecretStore(),
      networkAllowlist: [],
    });
    const server = createOAuthServer("https://mcp.example/oauth/token", {
      oauth: {
        authorizationUrl: "https://mcp.example/oauth/authorize",
        tokenUrl: "https://mcp.example/oauth/token",
      },
    });

    await expect(
      service.resolveAccessToken(server, {
        accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
        tokenExpiresAt: "2026-06-03T11:59:00.000Z",
        updatedAt: "2026-06-03T11:00:00.000Z",
      }),
    ).rejects.toThrow("MCP OAuth token expired and no refresh token is available");
  });

  it("projects public OAuth readiness from metadata and token refs only", () => {
    vi.setSystemTime(new Date("2026-06-03T12:00:00.000Z"));
    const tokenServer = createOAuthServer("https://mcp.example/oauth/token", {
      oauth: {
        authorizationUrl: "https://mcp.example/oauth/authorize",
        tokenUrl: "https://mcp.example/oauth/token",
      },
    });

    expect(
      buildPublicMcpAuthState(createOAuthServer("https://mcp.example/oauth/token", { oauth: {} }), undefined),
    ).toMatchObject({
      authType: "oauth2",
      readiness: "missing_oauth_config",
    });
    expect(buildPublicMcpAuthState(tokenServer, undefined)).toMatchObject({
      authType: "oauth2",
      readiness: "needs_auth",
    });
    expect(
      buildPublicMcpAuthState(tokenServer, {
        accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
        refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
        tokenExpiresAt: "2026-06-03T11:59:00.000Z",
        updatedAt: "2026-06-03T11:00:00.000Z",
      }),
    ).toMatchObject({
      authType: "oauth2",
      readiness: "expired",
      accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
      refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
    });
    const ready = buildPublicMcpAuthState(tokenServer, {
      accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
      refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
      tokenExpiresAt: "2026-06-03T12:30:00.000Z",
      scopes: ["remote.search"],
      updatedAt: "2026-06-03T12:00:00.000Z",
    });

    expect(ready).toMatchObject({
      authType: "oauth2",
      readiness: "ready",
      scopes: ["remote.search"],
    });
    expect(JSON.stringify(ready)).not.toContain("secret");
    expect(buildPublicMcpAuthState({ ...tokenServer, authType: "token" }, undefined)).toEqual({
      authType: "token",
      readiness: "not_required",
    });
  });

  it("flags only stale/missing-auth readiness as invoke-blocked", () => {
    expect(isMcpAuthReadinessInvokeBlocked("needs_auth")).toBe(true);
    expect(isMcpAuthReadinessInvokeBlocked("expired")).toBe(true);
    expect(isMcpAuthReadinessInvokeBlocked("ready")).toBe(false);
    expect(isMcpAuthReadinessInvokeBlocked("not_required")).toBe(false);
    expect(isMcpAuthReadinessInvokeBlocked("missing_oauth_config")).toBe(false);
    expect(isMcpAuthReadinessInvokeBlocked(undefined)).toBe(false);
  });

  it("resolves invoke readiness from the projected authState when present", () => {
    const server = {
      ...createOAuthServer("https://mcp.example/oauth/token", {
        oauth: { authorizationUrl: "https://mcp.example/oauth/authorize", tokenUrl: "https://mcp.example/oauth/token" },
      }),
      authState: { authType: "oauth2" as const, readiness: "expired" as const },
    };
    expect(resolveMcpInvokeAuthReadiness(server)).toBe("expired");
  });

  it("recomputes invoke readiness from the live auth-state record when authState is absent", () => {
    const server = createOAuthServer("https://mcp.example/oauth/token", {
      oauth: { authorizationUrl: "https://mcp.example/oauth/authorize", tokenUrl: "https://mcp.example/oauth/token" },
    });
    expect(resolveMcpInvokeAuthReadiness(server, undefined)).toBe("needs_auth");
  });

  it("builds an actionable stale-auth invoke error per readiness", () => {
    const expired = buildMcpStaleAuthInvokeError({ serverId: "srv-1", label: "Remote OAuth MCP" }, "expired");
    expect(expired).toContain("Remote OAuth MCP");
    expect(expired).toContain("srv-1");
    expect(expired).toContain("expired");
    expect(expired).toContain("reconnect");

    const needsAuth = buildMcpStaleAuthInvokeError({ serverId: "srv-1", label: "Remote OAuth MCP" }, "needs_auth");
    expect(needsAuth).toContain("not been authenticated");
  });

  it("deletes stored OAuth token refs without surfacing stale keychain failures", () => {
    const secretStore = createMemorySecretStore();
    const deleted: string[] = [];
    secretStore.deleteSecret = (account: string) => {
      deleted.push(account);
      if (account.endsWith("refresh-token")) {
        throw new Error("stale keychain row");
      }
    };
    const service = new McpOAuthTokenService({ secretStore, networkAllowlist: [] });

    expect(() => service.deleteStoredTokens("server-1")).not.toThrow();
    expect(deleted).toEqual(["mcp:server-1:access-token", "mcp:server-1:refresh-token"]);
  });
});

function createOAuthServer(tokenUrl: string, overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "server-1",
    label: "Remote OAuth MCP",
    transport: "http",
    url: "https://mcp.example/mcp",
    authType: "oauth2",
    enabled: true,
    status: "connected",
    category: "research",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    oauth: {
      tokenUrl,
      ...overrides.oauth,
    },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

async function withTokenEndpoint<T>(
  handler: (input: { body: URLSearchParams; request: http.IncomingMessage }) => Record<string, unknown>,
  run: (input: { url: string }) => Promise<T>,
): Promise<T> {
  let handlerError: unknown;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = new URLSearchParams(rawBody);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(handler({ body, request })));
      } catch (error) {
        handlerError = error;
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "handler failed" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("MCP OAuth token test server did not bind to a TCP port.");
    }
    const result = await run({ url: `http://127.0.0.1:${address.port}/oauth/token` });
    if (handlerError) {
      throw handlerError;
    }
    return result;
  } catch (error) {
    if (handlerError) {
      throw handlerError;
    }
    throw error;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createMemorySecretStore(): Pick<SecretStoreService, "setSecret" | "getSecret" | "deleteSecret"> {
  const secrets = new Map<string, string>();
  return {
    setSecret: (account: string, secret: string) => {
      secrets.set(account, secret);
    },
    getSecret: (account: string) => secrets.get(account),
    deleteSecret: (account: string) => {
      secrets.delete(account);
    },
  };
}
