import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { McpServerStore } from "./mcp-server-store.js";
import { McpStaticEnvironmentService, type McpConnectionFence } from "./mcp-static-environment-service.js";
import { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import { GatewayMcpOAuthService } from "./gateway-mcp-oauth-service.js";
import { composeMcpAdministration } from "./gateway-route-composition-tools.js";
import { startMcpOAuth, completeMcpOAuth } from "./mcp-server-admin-service.js";

const opened: AsyncStorage[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const storage of opened.splice(0)) await storage.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const review = (server: McpServerRecord) => ({
  expectedRevision: server.revision!,
  expectedConnectionRevision: server.connectionRevision ?? null,
});
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "gc-reviewed-oauth-"));
  roots.push(root);
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    }),
  );
  opened.push(storage);
  const store = new McpServerStore({
    systemSettings: storage.systemSettings,
    approvalInbox: storage.approvalInbox,
    runImmediateTransaction: (cb) => storage.runImmediateTransaction(cb),
  });
  const seed: McpServerRecord = {
    serverId: "reviewed-oauth",
    label: "Reviewed OAuth fixture",
    transport: "http",
    url: "https://example.invalid/mcp",
    enabled: true,
    authType: "oauth2",
    oauth: {
      authorizationUrl: "https://example.invalid/authorize",
      tokenUrl: "https://example.invalid/token",
      redirectUri: "http://127.0.0.1:8787/manual",
      scopes: ["inspect"],
    },
    category: "development",
    trustTier: "restricted",
    costTier: "free",
    status: "connected",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
      allowedEnvKeys: [],
    },
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
  await store.writeServers([seed], []);
  const values = new Map<string, string>();
  const secrets = {
    isWriteCustodySafe: () => true,
    getSecret: (key: string) => values.get(key),
    setSecret: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    deleteSecret: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
  const environment = new McpStaticEnvironmentService({ registry: store, secretStore: secrets, env: {} });
  const tokens = new McpOAuthTokenService({ secretStore: secrets, networkAllowlist: [] });
  const dispatched = vi.fn();
  const exchange = vi
    .spyOn(tokens, "exchangeAuthorizationCode")
    .mockImplementation(async (_server, _code, auth, boundary) => {
      await boundary!();
      dispatched();
      return {
        ...auth,
        oauthState: undefined,
        accessTokenRef: "keychain:goatcitadel:mcp:reviewed-oauth:access-token:11111111-1111-4111-8111-111111111111",
        tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      };
    });
  const tokenOwner = new GatewayMcpOAuthService({ registry: store, storage, tokenService: tokens });
  const close = vi.fn(),
    prepare = vi.fn((server: McpServerRecord, fence?: McpConnectionFence) => environment.enroll(server, fence));
  const transport = vi.fn(async () => []);
  const host = composeMcpAdministration(store, {
    storage,
    captureMcpServerSessionCloser: () => close,
    prepareMcpStaticEnvironment: prepare,
    resolveMcpOAuthClientId: async () => undefined,
    exchangeMcpOAuthCode: (...args) => tokenOwner.exchangeAuthorizationCode(...args),
    resolveConnectedMcpTools: transport,
    publishRealtime: async () => undefined,
  });
  return {
    storage,
    store,
    secrets,
    environment,
    tokens,
    tokenOwner,
    exchange,
    dispatched,
    close,
    prepare,
    transport,
    host,
    initial: await store.requireServer(seed.serverId),
  };
}

it.each(["configuration", "connection", "oauth-config"])(
  "rejects stale or invalid %s before closing sessions or enrolling credentials",
  async (kind) => {
    const f = await fixture();
    let input = f.initial;
    if (kind === "connection") await f.store.patchServerState(input.serverId, { status: "disconnected" }, input);
    if (kind === "configuration") await f.store.writeServers([{ ...input, label: "Peer" }], [input]);
    if (kind === "oauth-config") {
      await f.store.writeServers(
        [{ ...input, oauth: { ...input.oauth, authorizationUrl: "javascript:alert(1)" } }],
        [input],
      );
      input = await f.store.requireServer(input.serverId);
    }
    const before = await f.store.requireServer(input.serverId);
    await expect(startMcpOAuth(f.host, input.serverId, review(input))).rejects.toThrow();
    expect(await f.store.requireServer(input.serverId)).toEqual(before);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.secrets.setSecret).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
  },
);

it("starts one exact handshake after explicit disconnect and completes credentials without connecting", async () => {
  const f = await fixture(),
    admitted = vi.fn();
  const flow = await startMcpOAuth(f.host, f.initial.serverId, { ...review(f.initial), onCommitted: admitted });
  expect(admitted).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.transport).not.toHaveBeenCalled();
  expect(flow.review?.reviewed).toEqual(review(f.initial));
  expect(flow.review?.server).toEqual(await f.store.requireServer(f.initial.serverId));
  expect(flow.review?.server.status).toBe("disconnected");
  expect(flow.review?.server.connectionRevision).toMatch(/^[a-f0-9]{64}$/u);
  expect(flow.review?.server.revision).toBe(f.initial.revision);
  expect(flow.review?.server.configurationBindingId).toBe(f.initial.configurationBindingId);
  expect(flow.review?.server.connectionRevision).not.toBe(f.initial.connectionRevision);
  expect(new URL(flow.authorizeUrl).searchParams.get("state")).toBe(flow.state);
  const before = flow.review!.server,
    committed = vi.fn();
  const result = await completeMcpOAuth(f.host, before.serverId, "transient-fixture-code", flow.state, {
    ...review(before),
    onCommitted: committed,
  });
  expect(committed).toHaveBeenCalledOnce();
  expect(f.dispatched).toHaveBeenCalledOnce();
  expect(f.transport).not.toHaveBeenCalled();
  expect(result).toEqual(await f.store.requireServer(before.serverId));
  expect(result.authState?.readiness).toBe("ready");
  expect(result.status).toBe("disconnected");
  expect(result.connectionRevision).toBe(before.connectionRevision);
  expect(result.revision).not.toBe(before.revision);
  expect(result.configurationBindingId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  expect(result.configurationBindingId).not.toBe(before.configurationBindingId);
  const rows = await f.storage.externalSideEffectRuns.listByConnection(before.serverId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("completed");
  expect(JSON.stringify(rows)).not.toContain("transient-fixture-code");
  await expect(
    completeMcpOAuth(f.host, before.serverId, "transient-fixture-code", flow.state, review(before)),
  ).rejects.toThrow();
  expect(f.dispatched).toHaveBeenCalledOnce();
});

it("retains original generation when another operation wins during enrollment", async () => {
  const f = await fixture();
  f.prepare.mockImplementation(async (server, fence) => {
    await f.store.patchServerState(server.serverId, { status: "connected" }, server);
    return f.environment.enroll(server, fence);
  });
  await expect(startMcpOAuth(f.host, f.initial.serverId, review(f.initial))).rejects.toMatchObject({
    mutationCommitted: true,
  });
  expect((await f.store.readAuthState())[f.initial.serverId]).toBeUndefined();
  expect(f.secrets.setSecret).not.toHaveBeenCalled();
  expect(f.dispatched).not.toHaveBeenCalled();
});

it.each(["before-external", "after-external"])(
  "fences a superseded OAuth generation %s without adopting its result",
  async (when) => {
    const f = await fixture();
    const flow = await startMcpOAuth(f.host, f.initial.serverId, review(f.initial));
    const before = flow.review!.server;
    f.exchange.mockImplementation(async (server, _code, auth, boundary) => {
      if (when === "after-external") {
        await boundary!();
        f.dispatched();
      }
      await f.store.patchServerState(
        server.serverId,
        { status: "connecting" },
        await f.store.requireServer(server.serverId),
      );
      if (when === "before-external") {
        await boundary!();
        f.dispatched();
      }
      return {
        ...auth,
        oauthState: undefined,
        accessTokenRef: "keychain:goatcitadel:mcp:reviewed-oauth:access-token:11111111-1111-4111-8111-111111111111",
      };
    });
    await expect(
      completeMcpOAuth(f.host, before.serverId, "transient-code", flow.state, review(before)),
    ).rejects.toMatchObject({ mutationCommitted: true });
    expect(f.dispatched).toHaveBeenCalledTimes(when === "before-external" ? 0 : 1);
    expect((await f.store.readAuthState())[before.serverId]?.accessTokenRef).toBeUndefined();
    expect((await f.store.requireServer(before.serverId)).status).toBe("connecting");
    expect(f.transport).not.toHaveBeenCalled();
  },
);

it("binds manual state and auth-attempt CAS before reserving any token request", async () => {
  const f = await fixture();
  const flow = await startMcpOAuth(f.host, f.initial.serverId, review(f.initial));
  const before = flow.review!.server;
  await expect(
    completeMcpOAuth(f.host, before.serverId, "transient-code", "wrong-state", review(before)),
  ).rejects.toThrow("state mismatch");
  const auth = (await f.store.readAuthState())[before.serverId]!;
  await f.store.writeAuthState({ server: before, expected: auth, next: { ...auth, oauthState: "replacement-state" } });
  await expect(
    f.tokenOwner.exchangeAuthorizationCode(before, "transient-code", auth, {
      fence: { expectedConnectionRevision: before.connectionRevision! },
    }),
  ).rejects.toThrow();
  expect(f.dispatched).not.toHaveBeenCalled();
  expect(await f.storage.externalSideEffectRuns.listByConnection(before.serverId)).toEqual([]);
});
