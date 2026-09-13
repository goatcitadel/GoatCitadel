import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { McpServerStore } from "./mcp-server-store.js";
import { McpCredentialRetirementStore } from "./mcp-credential-retirement-store.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";

const INDEX = "mcp_credential_retirements_v1";
const opened = new Set<AsyncStorage>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...opened].map((storage) => storage.close()));
  opened.clear();
});

describe("MCP credential retirement custody", () => {
  it("recovers committed retirement after reopen and deletes only superseded credentials", async () => {
    const f = await fixture();
    const old = await f.auth();
    const current = await f.publish();
    await f.reopen();
    const remove = vi.fn((account: string) => { f.secrets.delete(account); });
    expect(await f.store.reconcileCredentialRetirements(remove)).toEqual({ deleted: 2, blocked: 0, failed: 0, remaining: 0 });
    expect(remove.mock.calls.map(([account]) => account).sort()).toEqual([accountFor(old.accessTokenRef!), accountFor(old.refreshTokenRef!)].sort());
    expect(f.secrets.has(accountFor(current.accessTokenRef!))).toBe(true);
    expect(f.secrets.has(accountFor(current.refreshTokenRef!))).toBe(true);
    expect(JSON.stringify(await f.store.readServers())).not.toContain("keychain:");
    remove.mockClear();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 0, remaining: 0 });
    expect(remove).not.toHaveBeenCalled();
    await expect(f.publish(old)).rejects.toThrow("retired");
    expect(await f.auth()).toEqual(current);
  });

  it("retains the retirement when canonical publication acknowledgement is lost", async () => {
    const f = await fixture();
    const before = await f.auth();
    const next = f.freshAuth();
    let lost = true;
    let depth = 0;
    const store = new McpServerStore({ systemSettings: f.storage.systemSettings,
      runImmediateTransaction: async (callback) => {
        const outermost = depth++ === 0;
        try {
          const value = await f.storage.runImmediateTransaction(callback);
          if (outermost && lost && (await f.auth()).accessTokenRef === next.accessTokenRef) {
            lost = false; throw new Error("commit acknowledgement lost");
          }
          return value;
        } finally { depth -= 1; }
      } });
    await expect(store.writeAuthState({ server: await f.server(), expected: before, next })).rejects.toThrow("acknowledgement lost");
    await f.reopen();
    expect(await f.auth()).toEqual(next);
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 2, remaining: 0 });
    expect(remove.mock.calls.flat()).not.toContain(accountFor(next.accessTokenRef!));
  });

  it("rolls back configuration, auth and retirement together when the index write fails", async () => {
    const f = await fixture();
    const before = await f.auth(), server = await f.server();
    const broken = new McpServerStore({
      systemSettings: { get: (...args) => f.storage.systemSettings.get(...args), set: (...args) => f.storage.systemSettings.set(...args),
        compareAndSet: async (...args) => {
          if (args[0] === INDEX) throw new Error("index rollback fixture");
          return f.storage.systemSettings.compareAndSet(...args);
        } },
      runImmediateTransaction: (callback) => f.storage.runImmediateTransaction(callback),
    });
    await expect(broken.writeAuthState({ server, expected: before, next: f.freshAuth() })).rejects.toThrow("index rollback fixture");
    expect(await f.auth()).toEqual(before);
    expect(await f.server()).toEqual(server);
    expect(await f.storage.systemSettings.get(retiredKey(before.accessTokenRef!))).toBeUndefined();
    expect(await f.storage.systemSettings.get(INDEX)).toBeUndefined();
  });

  it("fences republication during deletion and safely retries a lost deletion acknowledgement", async () => {
    const f = await fixture();
    const old = await f.auth(), current = await f.publish();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const remove = vi.fn(async (account: string) => { f.secrets.delete(account); await gate; throw new Error("private cleanup error"); });
    const pending = f.store.reconcileCredentialRetirements(remove, 1);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await expect(f.publish({ ...current, accessTokenRef: old.accessTokenRef })).rejects.toThrow("retired");
    release();
    expect(await pending).toEqual({ deleted: 0, blocked: 0, failed: 1, remaining: 2 });
    expect(await f.auth()).toEqual(current);
    await f.reopen();
    expect(await f.store.reconcileCredentialRetirements((account) => { f.secrets.delete(account); })).toMatchObject({ deleted: 2, remaining: 0 });
    expect(f.secrets.has(accountFor(current.accessTokenRef!))).toBe(true);
  });

  it.each(["own", "other-server"])("preserves any currently referenced credential, including %s corruption", async (scope) => {
    const f = await fixture();
    const old = await f.auth();
    await f.publish();
    const rows = await f.store.readAuthState();
    await f.storage.systemSettings.set("mcp_auth_state_v1", { ...rows,
      [scope === "own" ? f.serverId : "foreign-fixture"]: old });
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 0, blocked: 2, remaining: 2 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("retires replaced environment and OAuth bindings together and retains the current environment", async () => {
    const f = await fixture();
    const first = { credentialRef: f.ref("environment") };
    await f.store.writeEnvironmentBinding(await f.server(), undefined, first);
    await f.publish();
    await f.store.reconcileCredentialRetirements(() => undefined);
    const oldAuth = await f.auth();
    const next = { credentialRef: f.ref("environment") };
    await f.store.writeEnvironmentBinding(await f.server(), first, next);
    expect((await f.store.readAuthState())[f.serverId]).toBeUndefined();
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 3, remaining: 0 });
    expect(remove.mock.calls.map(([account]) => account).sort()).toEqual([first.credentialRef, oldAuth.accessTokenRef!, oldAuth.refreshTokenRef!].map(accountFor).sort());
    expect(await f.store.readEnvironmentBinding(f.serverId)).toEqual(next);
    await expect(f.store.writeEnvironmentBinding(await f.server(), next, first)).rejects.toThrow("retired");
  });

  it("retains all credential retirements when a server is deleted and refuses reuse after recreation", async () => {
    const f = await fixture();
    const environment = { credentialRef: f.ref("environment") };
    await f.store.writeEnvironmentBinding(await f.server(), undefined, environment);
    const auth = await f.publish();
    await f.store.reconcileCredentialRetirements(() => undefined);
    const server = await f.server();
    await f.store.writeServers([], [server]);
    await f.reopen();
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 3, remaining: 0 });
    await f.store.writeServers([server], []);
    await expect(f.publish(auth)).rejects.toThrow("retired");
    await expect(f.store.writeEnvironmentBinding(await f.server(), undefined, environment)).rejects.toThrow("retired");
  });

  it("bounds one pass and retains the remaining queue", async () => {
    const f = await fixture();
    await f.publish();
    expect(await f.store.reconcileCredentialRetirements(() => undefined, 1)).toMatchObject({ deleted: 1, remaining: 1 });
    expect(await f.store.reconcileCredentialRetirements(() => undefined, 1)).toMatchObject({ deleted: 1, remaining: 0 });
    await expect(f.store.reconcileCredentialRetirements(() => undefined, 0)).rejects.toThrow("limit");
  });

  it("refuses foreign or malformed retirement records without invoking the secret store", async () => {
    const f = await fixture();
    const old = await f.auth();
    await f.publish();
    const key = retiredKey(old.accessTokenRef!);
    const entry = (await f.storage.systemSettings.get<Record<string, unknown>>(key))!.value;
    await f.storage.systemSettings.set(key, { ...entry, credentialRef: f.ref("access-token", "another-server") });
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove, 1)).toMatchObject({ failed: 1, remaining: 2 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses cleanup when canonical credential state is malformed", async () => {
    const f = await fixture();
    await f.publish();
    await f.storage.systemSettings.set("mcp_auth_state_v1", { bad: { accessTokenRef: ["invalid"] } });
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ failed: 2, remaining: 2 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("rolls back publication when its bounded retirement queue is full", async () => {
    const f = await fixture();
    const before = await f.auth();
    await f.storage.systemSettings.set(INDEX, { version: 1, keys: Array.from({ length: 4096 }, (_, index) =>
      `mcp_credential_retired_v1:${index.toString(16).padStart(64, "0")}`) });
    await expect(f.publish()).rejects.toThrow("backlog");
    expect(await f.auth()).toEqual(before);
    expect(await f.storage.systemSettings.get(retiredKey(before.accessTokenRef!))).toBeUndefined();
  });

  it("keeps completed tombstones after an uncertain completion acknowledgement", async () => {
    const f = await fixture();
    const old = await f.auth();
    await f.publish();
    const key = retiredKey(old.accessTokenRef!);
    const owner = new McpCredentialRetirementStore({ systemSettings: f.storage.systemSettings,
      runImmediateTransaction: async (callback) => {
        const result = await f.storage.runImmediateTransaction(callback);
        if ((await f.storage.systemSettings.get<{ status: string }>(key))?.value.status === "deleted")
          throw new Error("completion acknowledgment fixture");
        return result;
      } });
    expect(await owner.reconcile(() => undefined, 1)).toMatchObject({ deleted: 0, failed: 1, remaining: 1 });
    await expect(f.publish(old)).rejects.toThrow("retired");
    expect(await f.store.reconcileCredentialRetirements(() => undefined)).toMatchObject({ deleted: 1, remaining: 0 });
  });
});

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-retirement-"));
  const options = { dbPath: path.join(directory, "store.db"), transcriptsDir: path.join(directory, "transcripts"), auditDir: path.join(directory, "audit") };
  let storage = createSqliteAsyncStorage(new Storage(options));
  opened.add(storage);
  const makeStore = () => new McpServerStore({ systemSettings: storage.systemSettings,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback) });
  let store = makeStore();
  const serverId = "retirement-fixture";
  const secrets = new Map<string, string>();
  const ref = (kind: string, owner = serverId) => `keychain:goatcitadel:mcp:${owner}:${kind}:${randomUUID()}`;
  const freshAuth = (): McpAuthStateRecord => {
    const accessTokenRef = ref("access-token"), refreshTokenRef = ref("refresh-token");
    secrets.set(accountFor(accessTokenRef), "fixture-access");
    secrets.set(accountFor(refreshTokenRef), "fixture-refresh");
    return { accessTokenRef, refreshTokenRef, updatedAt: new Date().toISOString() };
  };
  const record: McpServerRecord = { serverId, label: "Retirement fixture", transport: "stdio", command: "node", args: [],
    authType: "oauth2", enabled: true, category: "development", trustTier: "restricted", costTier: "unknown",
    policy: normalizeMcpPolicy(), status: "disconnected", createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" };
  await store.writeServers([record], []);
  const auth = async () => (await store.readAuthState())[serverId]!;
  const server = () => store.requireServer(serverId);
  const publish = async (next = freshAuth()) => {
    await store.writeAuthState({ server: await server(), expected: await auth(), next });
    return next;
  };
  await publish();
  return { directory, serverId, secrets, ref, freshAuth, auth, server, publish,
    get storage() { return storage; }, get store() { return store; },
    async reopen() {
      await storage.close(); opened.delete(storage);
      storage = createSqliteAsyncStorage(new Storage(options)); opened.add(storage); store = makeStore();
    } };
}
function accountFor(ref: string): string { return ref.slice("keychain:goatcitadel:".length); }
function retiredKey(ref: string): string { return "mcp_credential_retired_v1:" + createHash("sha256").update(ref).digest("hex"); }
