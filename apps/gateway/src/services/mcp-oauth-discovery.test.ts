import http from "node:http";
import { createHash } from "node:crypto";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  createAllowlistedOAuthFetch,
  discoverMcpAuthorizationServer,
  isMcpAuthorizationServerRecord,
  McpOAuthPkceStore,
  mcpOAuthPkceStore,
  type McpAuthorizationServerRecord,
} from "./mcp-oauth-discovery.js";
import { ValidationError } from "@goatcitadel/contracts";
import { prepareReviewedMcpOAuthDiscovery, startMcpOAuth } from "./mcp-oauth-handshake-service.js";
import { mcpServerRevision } from "./mcp-server-revision.js";
import { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import type { McpAuthStateRecord, McpAuthStateUpdate } from "./mcp-server-admin-service.js";

const REDIRECT = "http://127.0.0.1:8787/api/v1/mcp/oauth/callback";

interface FakeAuthServerOptions {
  advertiseS256?: boolean;
  registration?: boolean;
  registrationSecret?: boolean;
  resourceOverride?: string;
  insecureAuthorize?: boolean;
}

interface FakeAuthServer {
  base: string;
  host: string;
  requests: Array<{ method: string; path: string; body: string }>;
}

async function withFakeAuthServer<T>(
  options: FakeAuthServerOptions,
  run: (server: FakeAuthServer) => Promise<T>,
): Promise<T> {
  const requests: FakeAuthServer["requests"] = [];
  let base = "";
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", base).pathname;
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "GET", path, body });
      const json = (status: number, value: unknown) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return json(200, {
          resource: options.resourceOverride ?? `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["read", "write"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: base,
          authorization_endpoint: options.insecureAuthorize ? "http://auth.example/authorize" : `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(options.registration === false ? {} : { registration_endpoint: `${base}/register` }),
          response_types_supported: ["code"],
          ...(options.advertiseS256 === false ? {} : { code_challenge_methods_supported: ["S256"] }),
        });
      }
      if (path === "/register" && request.method === "POST") {
        const metadata = JSON.parse(body) as Record<string, unknown>;
        return json(201, {
          ...metadata,
          client_id: "registered-public-client",
          ...(options.registrationSecret ? { client_secret: "issued-secret" } : {}),
        });
      }
      if (path === "/token" && request.method === "POST") {
        return json(200, { access_token: "discovered-access", refresh_token: "discovered-refresh", expires_in: 3600 });
      }
      return json(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fake auth server did not bind.");
    base = `http://127.0.0.1:${address.port}`;
    return await run({ base, host: `127.0.0.1:${address.port}`, requests });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function discoveryServer(base: string): Pick<McpServerRecord, "label" | "url"> {
  return { label: "Vendor MCP", url: `${base}/mcp` };
}

describe("discoverMcpAuthorizationServer", () => {
  it("follows protected-resource and authorization-server metadata, then registers a public client", async () => {
    await withFakeAuthServer({}, async ({ base, host, requests }) => {
      const result = await discoverMcpAuthorizationServer({
        server: discoveryServer(base),
        redirectUri: REDIRECT,
        fetchFn: createAllowlistedOAuthFetch([host]),
        now: () => new Date("2026-10-24T00:00:00.000Z"),
      });
      expect(result).toEqual({
        record: {
          issuer: base,
          authorizationEndpoint: `${base}/authorize`,
          tokenEndpoint: `${base}/token`,
          clientId: "registered-public-client",
          resource: `${base}/mcp`,
          redirectUri: REDIRECT,
          discoveredAt: "2026-10-24T00:00:00.000Z",
        },
        scope: "read write",
      });
      const registration = requests.find((entry) => entry.path === "/register");
      expect(JSON.parse(registration!.body)).toMatchObject({
        client_name: "GoatCitadel",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      });
      expect(isMcpAuthorizationServerRecord(result.record)).toBe(true);
    });
  });

  it("reuses the registered client when issuer, resource and redirect still match", async () => {
    await withFakeAuthServer({}, async ({ base, host, requests }) => {
      const input = {
        server: discoveryServer(base),
        redirectUri: REDIRECT,
        fetchFn: createAllowlistedOAuthFetch([host]),
      };
      const first = await discoverMcpAuthorizationServer(input);
      const again = await discoverMcpAuthorizationServer({
        ...input,
        previous: { ...first.record, clientId: "kept-client" },
      });
      expect(again.record.clientId).toBe("kept-client");
      const moved = await discoverMcpAuthorizationServer({
        ...input,
        previous: { ...first.record, clientId: "kept-client", redirectUri: "http://127.0.0.1:9999/other" },
      });
      expect(moved.record.clientId).toBe("registered-public-client");
      expect(requests.filter((entry) => entry.path === "/register")).toHaveLength(2);
    });
  });

  it("uses a configured client id and operator scopes without registering", async () => {
    await withFakeAuthServer({ registration: false }, async ({ base, host, requests }) => {
      const result = await discoverMcpAuthorizationServer({
        server: discoveryServer(base),
        redirectUri: REDIRECT,
        scopes: ["read"],
        configuredClientId: "operator-client",
        fetchFn: createAllowlistedOAuthFetch([host]),
      });
      expect(result.record.clientId).toBe("operator-client");
      expect(result.scope).toBe("read");
      expect(requests.some((entry) => entry.path === "/register")).toBe(false);
    });
  });

  it.each([
    [{ advertiseS256: false }, "does not advertise PKCE S256"],
    [{ registration: false }, "does not support automatic client registration"],
    [{ registrationSecret: true }, "issued a confidential client"],
    [{ resourceOverride: "https://other.example/mcp" }, "different resource"],
    [{ insecureAuthorize: true }, "authorization endpoint for Vendor MCP must be a credential-free HTTPS URL"],
  ] as const)("fails closed with an operator-readable reason: %o", async (options, message) => {
    await withFakeAuthServer(options, async ({ base, host }) => {
      await expect(
        discoverMcpAuthorizationServer({
          server: discoveryServer(base),
          redirectUri: REDIRECT,
          fetchFn: createAllowlistedOAuthFetch([host]),
        }),
      ).rejects.toThrow(message);
    });
  });

  it("never reaches a host outside the operator network allowlist", async () => {
    await withFakeAuthServer({}, async ({ base, requests }) => {
      await expect(
        discoverMcpAuthorizationServer({
          server: discoveryServer(base),
          redirectUri: REDIRECT,
          fetchFn: createAllowlistedOAuthFetch(["allowed.example"]),
        }),
      ).rejects.toThrow();
      expect(requests).toHaveLength(0);
    });
  });
});

describe("isMcpAuthorizationServerRecord", () => {
  const valid: McpAuthorizationServerRecord = {
    issuer: "https://auth.vendor.example",
    authorizationEndpoint: "https://auth.vendor.example/authorize",
    tokenEndpoint: "https://auth.vendor.example/token",
    clientId: "client",
    resource: "https://mcp.vendor.example/mcp",
    redirectUri: REDIRECT,
    discoveredAt: "2026-10-24T00:00:00.000Z",
  };

  it("accepts the exact shape and rejects extra keys, credentials, or remote plain HTTP", () => {
    expect(isMcpAuthorizationServerRecord(valid)).toBe(true);
    expect(isMcpAuthorizationServerRecord({ ...valid, clientSecret: "x" })).toBe(false);
    expect(
      isMcpAuthorizationServerRecord({ ...valid, tokenEndpoint: "https://user:pass@auth.vendor.example/token" }),
    ).toBe(false);
    expect(isMcpAuthorizationServerRecord({ ...valid, tokenEndpoint: "http://auth.vendor.example/token" })).toBe(false);
    expect(isMcpAuthorizationServerRecord({ ...valid, tokenEndpoint: "http://127.0.0.1:9000/token" })).toBe(true);
    expect(isMcpAuthorizationServerRecord({ ...valid, discoveredAt: "not a date" })).toBe(false);
  });
});

describe("McpOAuthPkceStore", () => {
  it("binds one verifier to the server and state, replaces earlier flows, and expires", () => {
    let now = 0;
    const store = new McpOAuthPkceStore(() => now);
    const first = store.create();
    store.remember("server-1", "state-a", first.verifier);
    const verifierA = store.read("server-1", "state-a")!;
    expect(createHash("sha256").update(verifierA).digest("base64url")).toBe(first.challenge);
    expect(store.read("server-1", "state-b")).toBeUndefined();
    expect(store.read("server-2", "state-a")).toBeUndefined();
    store.remember("server-1", "state-b", store.create().verifier);
    expect(store.read("server-1", "state-a")).toBeUndefined();
    expect(store.read("server-1", "state-b")).toBeDefined();
    now = 10 * 60 * 1000 + 1;
    expect(store.read("server-1", "state-b")).toBeUndefined();
  });
});

function discoveryServerRecord(base: string): McpServerRecord {
  return {
    serverId: "server-1",
    label: "Vendor MCP",
    transport: "http",
    url: `${base}/mcp`,
    authType: "oauth2",
    oauth: { metadataDiscovery: true },
    enabled: true,
    status: "disconnected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
}

describe("discovered MCP OAuth flow", () => {
  it("starts with PKCE and resource, then exchanges against the discovered token endpoint", async () => {
    await withFakeAuthServer({}, async ({ base, host, requests }) => {
      const server = discoveryServerRecord(base);
      const auth: Record<string, McpAuthStateRecord> = {};
      const writes: McpAuthStateUpdate[] = [];
      const fetchFn = createAllowlistedOAuthFetch([host]);
      const started = await startMcpOAuth(
        {
          requireMcpServer: async () => server,
          readMcpAuthState: async () => auth,
          writeMcpAuthState: async (update) => {
            writes.push(update);
            auth[server.serverId] = JSON.parse(JSON.stringify(update.next)) as McpAuthStateRecord;
          },
          discoverMcpOAuthAuthorization: (target, input) =>
            discoverMcpAuthorizationServer({ ...input, server: target, fetchFn }),
        },
        server.serverId,
      );
      const authorize = new URL(started.authorizeUrl);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(`${base}/authorize`);
      expect(authorize.searchParams.get("client_id")).toBe("registered-public-client");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("resource")).toBe(`${base}/mcp`);
      expect(authorize.searchParams.get("scope")).toBe("read write");
      expect(writes[0]!.next?.authorizationServer?.tokenEndpoint).toBe(`${base}/token`);

      const tokens = new McpOAuthTokenService({
        secretStore: createMemorySecretStore(),
        // A getter: the token service reads the live allowlist, not a startup copy.
        networkAllowlist: () => [host],
      });
      const stateRecord = auth[server.serverId]!;
      const published = await tokens.exchangeAuthorizationCode(
        server,
        "vendor-code",
        stateRecord,
        async () => undefined,
      );
      expect(published.accessTokenRef).toContain("keychain:goatcitadel:mcp:server-1:access-token");
      expect(published.authorizationServer?.clientId).toBe("registered-public-client");
      const tokenRequest = new URLSearchParams(requests.find((entry) => entry.path === "/token")!.body);
      expect(tokenRequest.get("client_id")).toBe("registered-public-client");
      expect(tokenRequest.get("resource")).toBe(`${base}/mcp`);
      const verifier = tokenRequest.get("code_verifier")!;
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
        authorize.searchParams.get("code_challenge"),
      );
      expect(mcpOAuthPkceStore.read(server.serverId, stateRecord.oauthState)).toBeUndefined();
    });
  });

  it("discovers before a reviewed start commits, and reports a blocked host without changing anything", async () => {
    await withFakeAuthServer({}, async ({ base, host, requests }) => {
      const server = discoveryServerRecord(base);
      const review = { expectedRevision: mcpServerRevision(server), expectedConnectionRevision: null };
      const hostFor = (allowlist: string[]) => ({
        requireMcpServer: async () => server,
        readMcpAuthState: async () => ({}),
        writeMcpAuthState: async () => {
          throw new Error("pre-admission discovery must not write auth state");
        },
        discoverMcpOAuthAuthorization: (target: McpServerRecord, input: { redirectUri: string }) =>
          discoverMcpAuthorizationServer({ ...input, server: target, fetchFn: createAllowlistedOAuthFetch(allowlist) }),
      });
      const blocked = prepareReviewedMcpOAuthDiscovery(hostFor(["other.example"]), server.serverId, review);
      await expect(blocked).rejects.toBeInstanceOf(ValidationError);
      await expect(blocked).rejects.toThrow("Sign-in discovery for Vendor MCP failed:");
      expect(requests).toHaveLength(0);

      const prepared = await prepareReviewedMcpOAuthDiscovery(hostFor([host]), server.serverId, review);
      expect(prepared?.result.record.clientId).toBe("registered-public-client");
      await expect(
        prepareReviewedMcpOAuthDiscovery(hostFor([host]), server.serverId, {
          ...review,
          expectedRevision: "f".repeat(64),
        }),
      ).rejects.toThrow();
      const saved = { ...server, oauth: { authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/token` } };
      await expect(
        prepareReviewedMcpOAuthDiscovery({ ...hostFor([host]), requireMcpServer: async () => saved }, server.serverId, {
          ...review,
          expectedRevision: mcpServerRevision(saved),
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("refuses a discovered exchange whose PKCE verifier is gone", async () => {
    await withFakeAuthServer({}, async ({ base, host }) => {
      const server = discoveryServerRecord(base);
      const tokens = new McpOAuthTokenService({
        secretStore: createMemorySecretStore(),
        networkAllowlist: [host],
      });
      const stateRecord: McpAuthStateRecord = {
        oauthState: "lost-state",
        updatedAt: "2026-10-24T00:00:00.000Z",
        authorizationServer: {
          issuer: base,
          authorizationEndpoint: `${base}/authorize`,
          tokenEndpoint: `${base}/token`,
          clientId: "registered-public-client",
          resource: `${base}/mcp`,
          redirectUri: REDIRECT,
          discoveredAt: "2026-10-24T00:00:00.000Z",
        },
      };
      await expect(
        tokens.exchangeAuthorizationCode(server, "vendor-code", stateRecord, async () => undefined),
      ).rejects.toThrow("start Connect again");
    });
  });
});

function createMemorySecretStore() {
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
