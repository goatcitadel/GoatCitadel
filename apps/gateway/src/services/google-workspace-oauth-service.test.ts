import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError, type IntegrationConnection } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { GoogleWorkspaceOAuthService } from "./google-workspace-oauth-service.js";

const REDIRECT = "http://127.0.0.1:8787/api/v1/integrations/google/oauth/callback";
const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.events.readonly";

let rootDir: string;
let syncStorage: Storage;
let storage: AsyncStorage;

beforeAll(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-google-workspace-oauth-"));
  syncStorage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
  storage = createSqliteAsyncStorage(syncStorage);
}, 180_000); // One full SQLite migration replay.

afterAll(async () => {
  syncStorage?.close();
  await fs.rm(rootDir, { recursive: true, force: true });
});

class MemorySecretStore {
  public readonly secrets = new Map<string, string>();
  public available = true;
  public isAvailable() {
    return this.available;
  }
  public getSecret(account: string) {
    return this.secrets.get(account);
  }
  public setSecret(account: string, secret: string) {
    this.secrets.set(account, secret);
  }
  public deleteSecret(account: string) {
    this.secrets.delete(account);
  }
}

interface GoogleFake {
  fetch: ReturnType<typeof vi.fn>;
  tokenBodies: URLSearchParams[];
  revokeBodies: URLSearchParams[];
  /** What the token endpoint answers next. */
  nextToken: (body: URLSearchParams) => Response;
  revokeStatus: number;
}

function googleFake(): GoogleFake {
  const fake: GoogleFake = {
    tokenBodies: [],
    revokeBodies: [],
    revokeStatus: 200,
    nextToken: () => Response.json({ error: "unexpected" }, { status: 500 }),
    fetch: vi.fn(),
  };
  fake.fetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init?.body));
      fake.tokenBodies.push(body);
      return fake.nextToken(body);
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      fake.revokeBodies.push(new URLSearchParams(String(init?.body)));
      return new Response(fake.revokeStatus === 200 ? "" : JSON.stringify({ error: "server_error" }), {
        status: fake.revokeStatus,
      });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return Response.json({ emailAddress: "operator@example.com" });
    }
    throw new Error(`Unexpected Google URL ${url}`);
  });
  return fake;
}

async function googleConnection(config: Record<string, unknown> = {}): Promise<IntegrationConnection> {
  return await storage.integrationConnections.create({
    catalogId: "automation.gmail",
    kind: "automation",
    key: "gmail",
    label: "Google",
    status: "disconnected",
    config: { clientId: CLIENT_ID, gmailRead: true, ...config },
  });
}

function setup() {
  const secrets = new MemorySecretStore();
  const google = googleFake();
  const service = new GoogleWorkspaceOAuthService({
    secretStore: secrets,
    storage,
    fetchFn: google.fetch as unknown as typeof fetch,
    defaultRedirectUri: REDIRECT,
  });
  return { secrets, google, service };
}

/** Runs Connect Google end to end and returns the authorize URL Google would have shown. */
async function connect(
  ctx: ReturnType<typeof setup>,
  connectionId: string,
  capabilities: Parameters<GoogleWorkspaceOAuthService["start"]>[1]["capabilities"],
  grant: { scope: string; expiresIn?: number },
) {
  const flow = await ctx.service.start(connectionId, { capabilities, clientSecret: "GOCSPX-desktop-secret" });
  ctx.google.nextToken = () =>
    Response.json({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: grant.expiresIn ?? 3600,
      scope: grant.scope,
      token_type: "Bearer",
    });
  const status = await ctx.service.complete(connectionId, { state: flow.state, code: "auth-code-1" });
  return { flow, status };
}

describe("Google Workspace sign-in", { timeout: 60_000 }, () => {
  it("asks Google for exactly the reviewed scopes, with PKCE S256 and a loopback redirect, and keeps the client secret in the keychain", async () => {
    const ctx = setup();
    const connection = await googleConnection();
    const flow = await ctx.service.start(connection.connectionId, {
      capabilities: ["calendar.read", "gmail.read"],
      clientSecret: "GOCSPX-desktop-secret",
    });
    const url = new URL(flow.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(`${GMAIL_READONLY} ${CALENDAR_READONLY}`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(flow.capabilities).toEqual(["gmail.read", "calendar.read"]);
    expect([...ctx.secrets.secrets.entries()]).toEqual([
      [`integration:google-workspace:${connection.connectionId}:client-secret`, "GOCSPX-desktop-secret"],
    ]);
    expect(JSON.stringify(await storage.integrationConnections.get(connection.connectionId))).not.toContain("GOCSPX");
    expect(ctx.google.fetch).not.toHaveBeenCalled();
  });

  it("refuses to start without a client ID, a client secret, a capability, or on another kind of connection", async () => {
    const ctx = setup();
    const noClient = await googleConnection({ clientId: "" });
    await expect(ctx.service.start(noClient.connectionId, { capabilities: ["gmail.read"] })).rejects.toThrow(
      /OAuth client ID/,
    );
    const noSecret = await googleConnection();
    await expect(ctx.service.start(noSecret.connectionId, { capabilities: ["gmail.read"] })).rejects.toThrow(
      /client secret/,
    );
    await expect(
      ctx.service.start(noSecret.connectionId, { capabilities: [], clientSecret: "GOCSPX-x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const slack = await storage.integrationConnections.create({
      catalogId: "channel.slack",
      kind: "channel",
      key: "slack",
      label: "Slack",
      config: { clientId: CLIENT_ID },
    });
    await expect(ctx.service.getStatus(slack.connectionId)).rejects.toThrow(/only available on a Gmail/);
  });

  it("exchanges the code with the PKCE verifier, keeps tokens out of config and the ledger, and turns on only what Google granted", async () => {
    const ctx = setup();
    const connection = await googleConnection({ calendarRead: false });
    const { flow, status } = await connect(ctx, connection.connectionId, ["gmail.read", "calendar.read"], {
      // The operator unticked Calendar on Google's consent page.
      scope: GMAIL_READONLY,
    });

    const exchange = ctx.google.tokenBodies[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("auth-code-1");
    expect(exchange.get("client_id")).toBe(CLIENT_ID);
    expect(exchange.get("client_secret")).toBe("GOCSPX-desktop-secret");
    expect(exchange.get("redirect_uri")).toBe(REDIRECT);
    const challenge = createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url");
    expect(challenge).toBe(new URL(flow.authorizeUrl).searchParams.get("code_challenge"));

    expect(status).toMatchObject({ connected: true, requiresReauth: false, accountLabel: "operator@example.com" });
    expect(status.capabilities.find((item) => item.capability === "gmail.read")).toMatchObject({
      enabled: true,
      granted: true,
    });
    expect(status.capabilities.find((item) => item.capability === "calendar.read")).toMatchObject({
      enabled: false,
      granted: false,
    });
    const saved = await storage.integrationConnections.get(connection.connectionId);
    expect(saved).toMatchObject({ status: "connected", config: { gmailRead: true, calendarRead: false } });
    const credential = JSON.parse(
      ctx.secrets.secrets.get(`integration:google-workspace:${connection.connectionId}:oauth`)!,
    );
    expect(credential).toMatchObject({
      refreshToken: "refresh-1",
      accessToken: "access-1",
      grantedScopes: [GMAIL_READONLY],
    });
    expect(JSON.stringify(saved)).not.toMatch(/access-1|refresh-1|auth-code-1/);

    const runs = await storage.externalSideEffectRuns.listByConnection(connection.connectionId, {});
    expect(runs.map((run) => [run.boundary, run.actionId, run.status])).toEqual([
      ["google_oauth_token", "authorization_code", "completed"],
    ]);
    expect(JSON.stringify(runs)).not.toMatch(/access-1|refresh-1|auth-code-1|GOCSPX|code_verifier/);

    // The state is single use: a replayed or late code never reaches Google again.
    await expect(
      ctx.service.complete(connection.connectionId, { state: flow.state, code: "auth-code-1" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.google.tokenBodies).toHaveLength(1);
  });

  it("refreshes an expiring token once for concurrent tool calls and keeps using the stored one until then", async () => {
    const ctx = setup();
    const connection = await googleConnection();
    await connect(ctx, connection.connectionId, ["gmail.read"], { scope: GMAIL_READONLY, expiresIn: 60 });
    ctx.google.nextToken = () => Response.json({ access_token: "access-2", expires_in: 3600, scope: GMAIL_READONLY });

    const [first, second] = await Promise.all([
      ctx.service.resolveToolAccessToken({ connectionId: connection.connectionId, toolName: "gmail.read" }),
      ctx.service.resolveToolAccessToken({ connectionId: connection.connectionId, toolName: "gmail.read" }),
    ]);
    expect([first, second]).toEqual(["access-2", "access-2"]);
    const refreshes = ctx.google.tokenBodies.filter((body) => body.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.get("refresh_token")).toBe("refresh-1");
    expect(refreshes[0]!.get("client_secret")).toBe("GOCSPX-desktop-secret");

    // Fresh for an hour now: no further request.
    await expect(ctx.service.resolveAccessToken(connection.connectionId, "gmail.read")).resolves.toBe("access-2");
    expect(ctx.google.tokenBodies).toHaveLength(2);
    const credential = JSON.parse(
      ctx.secrets.secrets.get(`integration:google-workspace:${connection.connectionId}:oauth`)!,
    );
    expect(credential).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });
    const runs = await storage.externalSideEffectRuns.listByConnection(connection.connectionId, {});
    expect(runs.map((run) => run.actionId).sort()).toEqual(["authorization_code", "refresh_token"]);
  });

  it("marks the sign-in for renewal when Google refuses a refresh, and stops asking Google until it is reconnected", async () => {
    const ctx = setup();
    const connection = await googleConnection();
    await connect(ctx, connection.connectionId, ["gmail.read"], { scope: GMAIL_READONLY, expiresIn: 1 });
    ctx.google.nextToken = () =>
      Response.json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        { status: 400 },
      );

    await expect(ctx.service.resolveAccessToken(connection.connectionId, "gmail.read")).rejects.toThrow(
      /^blocked: Google refused to renew the sign-in \(invalid_grant/,
    );
    expect(await ctx.service.getStatus(connection.connectionId)).toMatchObject({
      connected: false,
      requiresReauth: true,
    });
    const requests = ctx.google.fetch.mock.calls.length;
    await expect(ctx.service.resolveAccessToken(connection.connectionId, "gmail.read")).rejects.toThrow(
      /^blocked: Google sign-in needs to be renewed/,
    );
    expect(ctx.google.fetch.mock.calls.length).toBe(requests);
  });

  it("gates every tool on its capability switch and Google's grant before returning a token", async () => {
    const ctx = setup();
    const connection = await googleConnection({ gmailSend: true, calendarWrite: false });
    await connect(ctx, connection.connectionId, ["gmail.read", "gmail.send"], { scope: GMAIL_READONLY });
    const requests = ctx.google.fetch.mock.calls.length;

    await expect(
      ctx.service.resolveToolAccessToken({ connectionId: connection.connectionId, toolName: "gmail.read" }),
    ).resolves.toBe("access-1");
    // Requested and switched on, but unticked at Google.
    await expect(
      ctx.service.resolveToolAccessToken({ connectionId: connection.connectionId, toolName: "gmail.send" }),
    ).rejects.toThrow(/^blocked: Send Gmail is turned off/);
    await storage.integrationConnections.update(connection.connectionId, {
      config: { ...(await storage.integrationConnections.get(connection.connectionId)).config, gmailSend: true },
    });
    await expect(
      ctx.service.resolveToolAccessToken({ connectionId: connection.connectionId, toolName: "gmail.send" }),
    ).rejects.toThrow(
      new RegExp(`^blocked: Google did not grant Send Gmail \\(${GMAIL_SEND.replace(/\./g, "\\.")}\\)`),
    );
    await expect(
      ctx.service.resolveToolAccessToken({ connectionId: connection.connectionId, toolName: "calendar.create_event" }),
    ).rejects.toThrow(/^blocked: Create Calendar events is turned off/);
    await expect(
      ctx.service.resolveToolAccessToken({ connectionId: connection.connectionId, toolName: "slack.send" }),
    ).rejects.toThrow(/^blocked: slack\.send is not a Google Workspace tool/);
    const other = await googleConnection();
    await expect(ctx.service.resolveAccessToken(other.connectionId, "gmail.read")).rejects.toThrow(
      /^blocked: Google sign-in is missing/,
    );
    await storage.integrationConnections.update(connection.connectionId, {
      config: {
        ...(await storage.integrationConnections.get(connection.connectionId)).config,
        clientId: "9999999999-other.apps.googleusercontent.com",
      },
    });
    await expect(ctx.service.resolveAccessToken(connection.connectionId, "gmail.read")).rejects.toThrow(
      /^blocked: Google sign-in needs to be renewed/,
    );
    expect(ctx.google.fetch.mock.calls.length).toBe(requests);
  });

  it("revokes the grant at Google on Disconnect and always removes the local sign-in", async () => {
    const ctx = setup();
    const connection = await googleConnection();
    await connect(ctx, connection.connectionId, ["gmail.read"], { scope: GMAIL_READONLY });

    const result = await ctx.service.disconnect(connection.connectionId);
    expect(ctx.google.revokeBodies.map((body) => body.get("token"))).toEqual(["refresh-1"]);
    expect(result).toMatchObject({ revoked: true, status: { connected: false, requiresReauth: false } });
    expect(ctx.secrets.secrets.has(`integration:google-workspace:${connection.connectionId}:oauth`)).toBe(false);
    // The client secret stays so the operator can connect again.
    expect(ctx.secrets.secrets.has(`integration:google-workspace:${connection.connectionId}:client-secret`)).toBe(true);
    expect(await storage.integrationConnections.get(connection.connectionId)).toMatchObject({ status: "disconnected" });
    await expect(ctx.service.resolveAccessToken(connection.connectionId, "gmail.read")).rejects.toThrow(
      /^blocked: Google sign-in is missing/,
    );

    await connect(ctx, connection.connectionId, ["gmail.read"], { scope: GMAIL_READONLY });
    ctx.google.revokeStatus = 503;
    const unconfirmed = await ctx.service.disconnect(connection.connectionId);
    expect(unconfirmed.revoked).toBe(false);
    expect(unconfirmed.message).toMatch(/did not confirm the revocation/);
    expect(ctx.secrets.secrets.has(`integration:google-workspace:${connection.connectionId}:oauth`)).toBe(false);
    const runs = await storage.externalSideEffectRuns.listByConnection(connection.connectionId, {});
    expect(runs.filter((run) => run.actionId === "revoke")).toHaveLength(2);
  });

  it("uses a saved redirect override only when it is this loopback callback", async () => {
    const ctx = setup();
    const custom = "http://localhost:9000/api/v1/integrations/google/oauth/callback";
    const loopback = await googleConnection({ redirectUri: custom });
    const remote = await googleConnection({
      redirectUri: "https://evil.example/api/v1/integrations/google/oauth/callback",
    });
    const otherPath = await googleConnection({ redirectUri: "http://127.0.0.1:9000/elsewhere" });
    expect((await ctx.service.getStatus(loopback.connectionId)).redirectUri).toBe(custom);
    expect((await ctx.service.getStatus(remote.connectionId)).redirectUri).toBe(REDIRECT);
    expect((await ctx.service.getStatus(otherPath.connectionId)).redirectUri).toBe(REDIRECT);
  });

  it("reports a leftover pasted access token as ignored and needs the OS keychain to connect", async () => {
    const ctx = setup();
    const connection = await googleConnection({ accessToken: "ya29.pasted" });
    expect(await ctx.service.getStatus(connection.connectionId)).toMatchObject({
      legacyAccessTokenConfigured: true,
      connected: false,
      clientSecretSource: "none",
    });
    ctx.secrets.available = false;
    await expect(
      ctx.service.start(connection.connectionId, { capabilities: ["gmail.read"], clientSecret: "GOCSPX-x" }),
    ).rejects.toThrow(/OS keychain/);
    await expect(ctx.service.resolveAccessToken(connection.connectionId, "gmail.read")).rejects.toThrow(
      /^blocked: The OS keychain/,
    );
  });
});
