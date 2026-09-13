import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import {
  Storage,
  createSqliteAsyncStorage,
  createPostgresRemoteStorage,
  type AsyncStorage,
} from "@goatcitadel/storage";
import { Pool } from "pg";
import { GATEWAY_OWNED_MCP_SERVER_IDS, McpServerStore } from "./mcp-server-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";

const KEY = "mcp_servers_v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

describe("McpServerStore configuration authority", () => {
  let storage: AsyncStorage;
  let store: McpServerStore;
  beforeAll(() => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-registry-"));
    storage = createSqliteAsyncStorage(
      new Storage({
        dbPath: ":memory:",
        transcriptsDir: path.join(directory, "transcripts"),
        auditDir: path.join(directory, "audit"),
      }),
    );
    store = createStore(storage);
  });
  beforeEach(async () => {
    await storage.systemSettings.set(KEY, []);
    await storage.systemSettings.set("mcp_auth_state_v1", {});
    await storage.systemSettings.set("mcp_tools_v1", []);
    await storage.systemSettings.set("mcp_tool_first_approval_v1", {});
    await storage.systemSettings.set("mcp_environment_bindings_v1", {});
  });
  afterAll(async () => {
    await storage?.close();
  });
  const callers = async () =>
    (await store.readServers()).filter((server) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId));

  it("issues an opaque identity, ignores supplied identity, and preserves it across status-only changes", async () => {
    const supplied = randomUUID();
    await store.writeServers([{ ...server(), configurationBindingId: supplied }], []);
    const [created] = await callers();
    expect(created!.configurationBindingId).toMatch(uuid);
    expect(created!.configurationBindingId).not.toBe(supplied);
    await store.patchServerState(created!.serverId, { status: "connected", lastError: undefined });
    const current = await store.requireServer(created!.serverId);
    expect(current.configurationBindingId).toBe(created!.configurationBindingId);
    await store.writeServers([{ ...created!, configurationBindingId: randomUUID() }], [created!]);
    expect(await store.requireServer(created!.serverId)).toMatchObject({
      configurationBindingId: created!.configurationBindingId,
      status: "connected",
    });
  });

  it.each([
    { command: "different-node" },
    { args: ["other-fixture.js"] },
    { url: "https://example.invalid/mcp" },
    { authType: "oauth2" as const },
    { oauth: { scopes: ["read"] } },
    { enabled: false },
    { trustTier: "trusted" as const },
    { policy: normalizeMcpPolicy({ blockedToolPatterns: ["write*"] }) },
  ])("rotates identity for configuration changes: %j", async (patch) => {
    await store.writeServers([server()], []);
    const previous = await callers();
    await store.writeServers([{ ...previous[0]!, ...patch }], previous);
    expect((await callers())[0]!.configurationBindingId).not.toBe(previous[0]!.configurationBindingId);
  });

  it("refuses a stale edit after a competing edit without overwriting its configuration", async () => {
    await store.writeServers([server()], []);
    const previous = await callers();
    await store.writeServers([{ ...previous[0]!, command: "new-command" }], previous);
    const committed = await callers();
    await expect(store.writeServers([{ ...previous[0]!, enabled: false }], previous)).rejects.toThrow(
      /configuration changed/,
    );
    expect(await callers()).toEqual(committed);
  });

  it("refuses stale delete and update after removal and recreation of the same target", async () => {
    await store.writeServers([server()], []);
    const original = await callers();
    await store.writeServers([], original);
    await store.writeServers(original, []);
    const recreated = await callers();
    expect(recreated[0]!.configurationBindingId).not.toBe(original[0]!.configurationBindingId);
    await expect(store.writeServers([], original)).rejects.toThrow(/configuration changed/);
    await expect(store.writeServers(original, original)).rejects.toThrow(/configuration changed/);
    expect(await callers()).toEqual(recreated);
  });

  it("allows only one competing create against the same empty registry snapshot", async () => {
    const peer = createStore(storage);
    const results = await Promise.allSettled([
      store.writeServers([server("first")], []),
      peer.writeServers([server("second")], []),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await callers()).toHaveLength(1);
  });

  it("retries a storage race caused only by status and preserves the newer status", async () => {
    await store.writeServers([server()], []);
    const previous = await callers();
    let raced = false;
    const settings: AsyncStorage["systemSettings"] = {
      ...storage.systemSettings,
      get: storage.systemSettings.get,
      set: storage.systemSettings.set,
      compareAndSet: async (key, expected, value, now) => {
        if (!raced) {
          raced = true;
          await store.patchServerState("server-1", { status: "connected" });
        }
        return storage.systemSettings.compareAndSet(key, expected, value, now);
      },
    };
    const racing = createStore(storage, settings);
    await racing.writeServers([{ ...previous[0]!, enabled: false }], previous);
    expect(await store.requireServer("server-1")).toMatchObject({ enabled: false, status: "connected" });
  });

  it("preserves normalized legacy defaults in a status update response", async () => {
    const legacy: Partial<McpServerRecord> = server();
    delete legacy.category;
    delete legacy.trustTier;
    delete legacy.costTier;
    delete legacy.policy;
    await storage.systemSettings.set(KEY, [legacy]);
    expect(await store.patchServerState("server-1", { status: "connected" })).toMatchObject({
      category: "development",
      trustTier: "restricted",
      costTier: "unknown",
      policy: normalizeMcpPolicy(),
      status: "connected",
    });
  });

  it("issues one legacy identity on explicit enrollment, while inventory reads remain read-only", async () => {
    await storage.systemSettings.set(KEY, [server()]);
    const before = await storage.systemSettings.get(KEY);
    expect((await callers())[0]!.configurationBindingId).toBeUndefined();
    expect(await storage.systemSettings.get(KEY)).toEqual(before);
    const peer = createStore(storage);
    const [left, right] = await Promise.all([
      store.ensureStaticConfigurationBinding("server-1"),
      peer.ensureStaticConfigurationBinding("server-1"),
    ]);
    expect(left.configurationBindingId).toMatch(uuid);
    expect(left.configurationBindingId).toBe(right.configurationBindingId);
    const enrolled = await storage.systemSettings.get(KEY);
    const compareAndSet = vi.fn(storage.systemSettings.compareAndSet);
    const enrolledStore = createStore(storage, {
      ...storage.systemSettings,
      get: storage.systemSettings.get,
      set: storage.systemSettings.set,
      compareAndSet,
    });
    await enrolledStore.ensureStaticConfigurationBinding("server-1");
    expect(compareAndSet).not.toHaveBeenCalled();
    expect(await storage.systemSettings.get(KEY)).toEqual(enrolled);
  });

  it("refuses requester-scoped, missing, duplicate or corrupt identities without changing storage", async () => {
    const cases = [
      [{ ...server(), connectionMode: "requester_scoped" }],
      [server(), server()],
      [{ ...server(), configurationBindingId: "invalid" }],
      [],
    ];
    for (const rows of cases) {
      await storage.systemSettings.set(KEY, rows);
      const before = await storage.systemSettings.get(KEY);
      await expect(store.ensureStaticConfigurationBinding("server-1")).rejects.toThrow();
      expect(await storage.systemSettings.get(KEY)).toEqual(before);
    }
    await expect(store.patchServerState("missing", { status: "connected" })).rejects.toThrow(/Unknown/);
    expect((await storage.systemSettings.get(KEY))?.value).toEqual([]);
  });

  it("publishes OAuth refs and configuration invalidation together without invalidating metadata-only changes", async () => {
    await store.writeServers([oauthServer()], []);
    const original = await store.requireServer("server-1");
    const handshake = { oauthState: "fixture-state", updatedAt: "2026-09-11T00:00:00.000Z" };
    await store.writeAuthState({ server: original, expected: undefined, next: handshake });
    expect((await store.requireServer("server-1")).configurationBindingId).toBe(original.configurationBindingId);
    await storage.systemSettings.set("mcp_tool_first_approval_v1", { "server-1": ["write"], peer: ["read"] });
    const next = authState();
    await store.writeAuthState({ server: original, expected: handshake, next });
    const published = await store.requireServer("server-1");
    expect(published.configurationBindingId).not.toBe(original.configurationBindingId);
    expect((await store.readAuthState())["server-1"]).toEqual(next);
    expect((await storage.systemSettings.get("mcp_tool_first_approval_v1"))?.value).toEqual({ peer: ["read"] });
    const diagnostic = { ...next, error: "Fixture diagnostic", updatedAt: "2026-09-11T01:00:00.000Z" };
    await store.writeAuthState({ server: published, expected: next, next: diagnostic });
    expect((await store.requireServer("server-1")).configurationBindingId).toBe(published.configurationBindingId);
    await expect(store.writeAuthState({ server: published, expected: next, next })).rejects.toThrow(
      /auth state changed/,
    );
  });

  it("allows only one competing OAuth publication for the same configuration and auth state", async () => {
    await store.writeServers([oauthServer()], []);
    const original = await store.requireServer("server-1");
    const next = [authState(), authState()];
    const outcomes = await Promise.allSettled(
      next.map((state) => store.writeAuthState({ server: original, expected: undefined, next: state })),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    expect((await store.readAuthState())["server-1"]).toEqual(next[winner]);
  });

  it.each(["mcp_auth_state_v1", "mcp_tool_first_approval_v1"])(
    "rolls back configuration and auth when %s fails",
    async (failedKey) => {
      await store.writeServers([oauthServer()], []);
      const original = await store.requireServer("server-1");
      await storage.systemSettings.set("mcp_tool_first_approval_v1", { "server-1": ["read"] });
      const settings = {
        ...storage.systemSettings,
        get: storage.systemSettings.get,
        set: storage.systemSettings.set,
        compareAndSet: async (...args: Parameters<AsyncStorage["systemSettings"]["compareAndSet"]>) => {
          if (args[0] === failedKey) throw new Error("storage failure fixture");
          return storage.systemSettings.compareAndSet(...args);
        },
      } as AsyncStorage["systemSettings"];
      await expect(
        createStore(storage, settings).writeAuthState({ server: original, expected: undefined, next: authState() }),
      ).rejects.toThrow("storage failure fixture");
      expect((await store.requireServer("server-1")).configurationBindingId).toBe(original.configurationBindingId);
      expect(await store.readAuthState()).toEqual({});
      expect((await storage.systemSettings.get("mcp_tool_first_approval_v1"))?.value).toEqual({ "server-1": ["read"] });
    },
  );

  it("rejects another server's refs, swapped token kinds and raw token fields", async () => {
    await store.writeServers([oauthServer()], []);
    const original = await store.requireServer("server-1");
    const valid = authState();
    for (const next of [
      authState("other-server"),
      { ...valid, accessTokenRef: valid.refreshTokenRef },
      { ...valid, resourceIndicator: "mcp://other-server" },
      { ...valid, access_token: "fixture-raw-token" },
    ]) {
      await expect(store.writeAuthState({ server: original, expected: undefined, next })).rejects.toThrow();
    }
    expect(await store.readAuthState()).toEqual({});
    expect((await store.requireServer("server-1")).configurationBindingId).toBe(original.configurationBindingId);
  });

  it("removes auth, tool inventory and first-use approvals with the server and rejects old publication after recreation", async () => {
    await store.writeServers([oauthServer()], []);
    await store.writeAuthState({
      server: await store.requireServer("server-1"),
      expected: undefined,
      next: authState(),
    });
    const previous = await callers();
    const expectedAuth = (await store.readAuthState())["server-1"];
    await storage.systemSettings.set("mcp_tools_v1", [
      { serverId: "server-1", toolName: "read" },
      { serverId: "peer", toolName: "read" },
    ]);
    await storage.systemSettings.set("mcp_tool_first_approval_v1", { "server-1": ["read"], peer: ["read"] });
    await store.writeServers([], previous);
    expect(await store.readAuthState()).toEqual({});
    expect((await storage.systemSettings.get("mcp_tools_v1"))?.value).toEqual([{ serverId: "peer", toolName: "read" }]);
    expect((await storage.systemSettings.get("mcp_tool_first_approval_v1"))?.value).toEqual({ peer: ["read"] });
    await expect(
      store.writeAuthState({ server: previous[0]!, expected: expectedAuth, next: authState() }),
    ).rejects.toThrow(/removed/);
    await store.writeServers([oauthServer()], []);
    await expect(
      store.writeAuthState({ server: previous[0]!, expected: undefined, next: authState() }),
    ).rejects.toThrow(/configuration changed/);
    expect(await store.readAuthState()).toEqual({});
  });

  it("does not persist a losing edit or manufacture success after storage failure", async () => {
    await store.writeServers([server()], []);
    const before = await callers();
    const failing = new McpServerStore({
      runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
      systemSettings: {
        get: storage.systemSettings.get,
        set: storage.systemSettings.set,
        compareAndSet: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    await expect(failing.writeServers([{ ...before[0]!, enabled: false }], before)).rejects.toThrow(
      "database unavailable",
    );
    expect(await callers()).toEqual(before);
  });
});

it.skipIf(!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim())(
  "persists registry authority across actual PostgreSQL RPC workers and restart",
  async () => {
    const url = process.env.GOATCITADEL_TEST_POSTGRES_URL!.trim();
    const schemaName = `mcp_registry_${randomUUID().replaceAll("-", "")}`;
    const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-registry-pg-"));
    const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const options = {
      connection: {
        connectionString: scopedUrl.toString(),
        database: decodeURIComponent(scopedUrl.pathname.slice(1)),
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      migrationsTable: "schema_migrations",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
      startupWaitTimeoutMs: 60_000,
    };
    const clients: AsyncStorage[] = [];
    let created = false;
    let closeResults: PromiseSettledResult<void>[];
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`);
      created = true;
      const left = createPostgresRemoteStorage(options);
      clients.push(left);
      await left.waitUntilReady();
      const right = createPostgresRemoteStorage(options);
      clients.push(right);
      await right.waitUntilReady();
      const a = createStore(left);
      const b = createStore(right);
      const results = await Promise.allSettled([
        a.writeServers([server("first")], []),
        b.writeServers([server("second")], []),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const saved = (await a.readServers()).filter((item) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId));
      expect(saved).toHaveLength(1);
      expect(saved[0]!.configurationBindingId).toMatch(uuid);
      await b.patchServerState(saved[0]!.serverId, { status: "connected" });
      await a.writeServers([{ ...saved[0]!, enabled: false }], saved);
      const current = (await a.readServers()).filter((item) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId));
      expect(current[0]).toMatchObject({ enabled: false, status: "connected" });
      await expect(b.writeServers([], saved)).rejects.toThrow(/configuration changed/);
      const beforeRollback = await left.systemSettings.get(KEY);
      await expect(
        left.runImmediateTransaction(async () => {
          expect(await left.systemSettings.compareAndSet(KEY, beforeRollback, [])).toBeDefined();
          throw new Error("rollback fixture");
        }),
      ).rejects.toThrow("rollback fixture");
      expect(await right.systemSettings.get(KEY)).toEqual(beforeRollback);
      await a.writeServers([...current, oauthServer("oauth-fixture")], current);
      const authOriginal = await a.requireServer("oauth-fixture");
      const proposals = [authState("oauth-fixture"), authState("oauth-fixture")];
      const publications = await Promise.allSettled([
        a.writeAuthState({ server: authOriginal, expected: undefined, next: proposals[0] }),
        b.writeAuthState({ server: authOriginal, expected: undefined, next: proposals[1] }),
      ]);
      expect(publications.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const publishedAuth = (await a.readAuthState())["oauth-fixture"]!;
      expect(publishedAuth).toEqual(proposals[publications.findIndex((result) => result.status === "fulfilled")]);
      const authCommitted = await b.requireServer("oauth-fixture");
      expect(authCommitted.configurationBindingId).not.toBe(authOriginal.configurationBindingId);
      const failingSettings = {
        ...left.systemSettings,
        get: left.systemSettings.get,
        set: left.systemSettings.set,
        compareAndSet: async (...args: Parameters<AsyncStorage["systemSettings"]["compareAndSet"]>) => {
          if (args[0] === "mcp_auth_state_v1") throw new Error("auth publication rollback fixture");
          return left.systemSettings.compareAndSet(...args);
        },
      } as AsyncStorage["systemSettings"];
      await expect(
        createStore(left, failingSettings).writeAuthState({
          server: authCommitted,
          expected: publishedAuth,
          next: authState("oauth-fixture"),
        }),
      ).rejects.toThrow("auth publication rollback fixture");
      expect((await b.requireServer("oauth-fixture")).configurationBindingId).toBe(
        authCommitted.configurationBindingId,
      );
      expect((await b.readAuthState())["oauth-fixture"]).toEqual(publishedAuth);
      const environmentProposals = [0, 1].map(() => ({
        credentialRef: `keychain:goatcitadel:mcp:oauth-fixture:environment:${randomUUID()}`,
      }));
      await expect(
        createStore(left, failingSettings).writeEnvironmentBinding(authCommitted, undefined, environmentProposals[0]),
      ).rejects.toThrow("auth publication rollback fixture");
      expect((await b.requireServer("oauth-fixture")).configurationBindingId).toBe(
        authCommitted.configurationBindingId,
      );
      expect(await b.readEnvironmentBinding("oauth-fixture")).toBeUndefined();
      expect((await b.readAuthState())["oauth-fixture"]).toEqual(publishedAuth);
      await left.systemSettings.set("mcp_tool_first_approval_v1", { "oauth-fixture": ["read"], peer: ["read"] });
      const environmentPublications = await Promise.allSettled([
        a.writeEnvironmentBinding(authCommitted, undefined, environmentProposals[0]),
        b.writeEnvironmentBinding(authCommitted, undefined, environmentProposals[1]),
      ]);
      expect(environmentPublications.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const environmentBinding = await a.readEnvironmentBinding("oauth-fixture");
      expect(environmentBinding).toEqual(
        environmentProposals[environmentPublications.findIndex((result) => result.status === "fulfilled")],
      );
      const environmentCommitted = await a.requireServer("oauth-fixture");
      expect(environmentCommitted.configurationBindingId).not.toBe(authCommitted.configurationBindingId);
      expect((await b.readAuthState())["oauth-fixture"]).toBeUndefined();
      expect(await b.readFirstApprovals()).toEqual({ peer: ["read"] });
      expect(
        (await a.writeEnvironmentBinding(environmentCommitted, environmentBinding, environmentBinding))
          .configurationBindingId,
      ).toBe(environmentCommitted.configurationBindingId);
      await expect(
        b.writeAuthState({ server: authCommitted, expected: publishedAuth, next: authState("oauth-fixture") }),
      ).rejects.toThrow(/configuration changed/);
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      const interruptedDelete = vi.fn(async () => {
        await cleanupGate;
        throw new Error("PostgreSQL retirement delete acknowledgement fixture");
      });
      const cleanup = a.reconcileCredentialRetirements(interruptedDelete, 1);
      try {
        await vi.waitFor(() => expect(interruptedDelete).toHaveBeenCalledOnce());
        await expect(b.writeAuthState({ server: environmentCommitted, expected: undefined, next: publishedAuth }))
          .rejects.toThrow("retired");
      } finally { releaseCleanup(); }
      expect(await cleanup).toMatchObject({ deleted: 0, failed: 1, remaining: 2 });
      await clients.pop()!.close();
      await clients.pop()!.close();
      const reopened = createPostgresRemoteStorage(options);
      clients.push(reopened);
      await reopened.waitUntilReady();
      const reopenedStore = createStore(reopened);
      expect(await reopenedStore.requireServer(current[0]!.serverId)).toEqual(current[0]);
      expect(await reopenedStore.requireServer("oauth-fixture")).toEqual(environmentCommitted);
      expect((await reopenedStore.readAuthState())["oauth-fixture"]).toBeUndefined();
      expect(await reopenedStore.readEnvironmentBinding("oauth-fixture")).toEqual(environmentBinding);
      const retiredAccounts: string[] = [];
      expect(await reopenedStore.reconcileCredentialRetirements((account) => { retiredAccounts.push(account); }))
        .toMatchObject({ deleted: 2, failed: 0, remaining: 0 });
      expect(retiredAccounts.sort()).toEqual([publishedAuth!.accessTokenRef!, publishedAuth!.refreshTokenRef!]
        .map((ref) => ref.slice("keychain:goatcitadel:".length)).sort());
      await expect(reopenedStore.writeAuthState({ server: environmentCommitted, expected: undefined, next: publishedAuth }))
        .rejects.toThrow("retired");
      expect(await reopenedStore.readEnvironmentBinding("oauth-fixture")).toEqual(environmentBinding);
    } finally {
      closeResults = await Promise.allSettled(clients.map((client) => client.close()));
      try {
        if (created) await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
      } finally {
        await admin.end();
      }
    }
    expect(closeResults.filter((result) => result.status === "rejected")).toEqual([]);
  },
  120_000,
);

function server(serverId = "server-1"): McpServerRecord {
  return {
    serverId,
    label: "Fixture MCP",
    transport: "stdio",
    command: "node",
    args: ["fixture.js"],
    authType: "none",
    enabled: true,
    category: "development",
    trustTier: "restricted",
    costTier: "unknown",
    policy: normalizeMcpPolicy(),
    status: "disconnected",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

function createStore(storage: AsyncStorage, systemSettings = storage.systemSettings): McpServerStore {
  return new McpServerStore({
    systemSettings,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
  });
}

function oauthServer(serverId = "server-1"): McpServerRecord {
  return {
    ...server(serverId),
    transport: "http",
    command: undefined,
    args: undefined,
    authType: "oauth2",
    url: "https://example.invalid/mcp",
    oauth: { authorizationUrl: "https://example.invalid/authorize", tokenUrl: "https://example.invalid/token" },
  };
}

function authState(serverId = "server-1"): McpAuthStateRecord {
  const version = randomUUID();
  return {
    accessTokenRef: `keychain:goatcitadel:mcp:${serverId}:access-token:${version}`,
    refreshTokenRef: `keychain:goatcitadel:mcp:${serverId}:refresh-token:${version}`,
    resourceIndicator: `mcp://${serverId}`,
    scopes: ["read"],
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}
