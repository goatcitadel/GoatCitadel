import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { McpServerStore, type McpServerStoreCtx } from "./mcp-server-store.js";
import { McpCredentialRetirementStore, type McpCredentialMetadataContext } from "./mcp-credential-retirement-store.js";
import { McpCredentialStagingStore } from "./mcp-credential-staging-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { CredentialWriteUncertainError } from "./secret-store-service.js";

const INDEX = "mcp_credential_staging_v1";
const opened = new Set<AsyncStorage>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...opened].map((storage) => storage.close()));
  opened.clear();
});

describe("MCP unpublished credential custody", () => {
  it("quarantines occupied or unacknowledged OS slots without authorizing retirement", async () => {
    const f = await fixture(), ref = f.ref("environment");
    f.secrets.set(ref, "preexisting-slot");
    await expect(f.store.stageCredentialVersions(f.serverId, [ref], () => {
      throw new CredentialWriteUncertainError(new Error("occupied OS slot"));
    }, "a".repeat(64))).rejects.toThrow("ownership was not acknowledged");
    await f.reopen(); f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ writing: 1, retired: 0, remaining: 1 });
    const remove = vi.fn(() => true);
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 0, remaining: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(f.secrets.get(ref)).toBe("preexisting-slot");
    // Repair of a corrupt canonical alias must not promote the unfinished
    // writer's custodian into deletion authority.
    await f.storage.systemSettings.set("mcp_environment_bindings_v1", { [f.serverId]: { credentialRef: ref } });
    await f.store.writeEnvironmentBinding(await f.server(), { credentialRef: ref }, undefined);
    const guarded = vi.fn((_account: string, custodyId: string | null) => custodyId === "a".repeat(64));
    expect(await f.store.reconcileCredentialRetirements(guarded)).toMatchObject({ blocked: 1, deleted: 0, remaining: 1 });
    expect(guarded.mock.calls[0]?.[1]).toBeNull();
    expect(f.secrets.get(ref)).toBe("preexisting-slot");
  });

  it("retains the original custodian through publication, replacement, rejected cleanup and restart", async () => {
    const f = await fixture(), owner = "a".repeat(64), other = "b".repeat(64);
    const first = { credentialRef: f.ref("environment") }, current = { credentialRef: f.ref("environment") };
    await f.store.stageCredentialVersions(f.serverId, [first.credentialRef], () => { f.secrets.set(first.credentialRef, "first-private"); }, owner);
    await f.store.writeEnvironmentBinding(await f.server(), undefined, first);
    await f.store.stageCredentialVersions(f.serverId, [current.credentialRef], () => { f.secrets.set(current.credentialRef, "current-private"); }, other);
    await f.store.writeEnvironmentBinding(await f.server(), first, current);
    await f.reopen();
    const wrongHost = vi.fn((_account: string, custodyId: string | null) => custodyId === other);
    expect(await f.store.reconcileCredentialRetirements(wrongHost)).toMatchObject({ blocked: 1, deleted: 0, remaining: 1 });
    expect(wrongHost.mock.calls[0]?.[1]).toBe(owner);
    expect(f.secrets.size).toBe(2);
    const rightHost = vi.fn((account: string, custodyId: string | null) => {
      if (custodyId !== owner) return false;
      f.secrets.delete(`keychain:goatcitadel:${account}`); return true;
    });
    expect(await f.store.reconcileCredentialRetirements(rightHost)).toMatchObject({ deleted: 1, remaining: 0 });
    expect(f.secrets.has(current.credentialRef)).toBe(true);
    expect(await f.store.readEnvironmentBinding(f.serverId)).toEqual(current);
    await expect(f.store.writeEnvironmentBinding(await f.server(), current, first)).rejects.toThrow("retired");
  });

  it("preserves custody for a completed unpublished write through expiry and restart", async () => {
    const f = await fixture(), ref = f.ref("environment"), owner = "c".repeat(64);
    await f.staging.write(f.serverId, [ref], () => undefined, owner);
    await f.reopen(); f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ retired: 1, remaining: 0 });
    const remove = vi.fn((_account: string, custodyId: string | null) => custodyId === owner);
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 1, remaining: 0 });
    expect(remove.mock.calls[0]?.[1]).toBe(owner);
  });

  it("does not let legacy or foreign custody starve owned retirements in a bounded queue", async () => {
    const f = await fixture(), legacy = { credentialRef: f.ref("environment") }, owner = "d".repeat(64);
    await f.store.writeEnvironmentBinding(await f.server(), undefined, legacy);
    await f.store.writeEnvironmentBinding(await f.server(), legacy, undefined);
    const ref = f.ref("environment");
    await f.staging.write(f.serverId, [ref], () => undefined, owner);
    f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ retired: 1 });
    const remove = vi.fn((_account: string, custodyId: string | null) => custodyId === owner);
    expect(await f.store.reconcileCredentialRetirements(remove, 1)).toMatchObject({ blocked: 1, deleted: 0, remaining: 2 });
    expect(remove.mock.calls[0]?.[1]).toBeNull();
    expect(await f.store.reconcileCredentialRetirements(remove, 1)).toMatchObject({ deleted: 1, remaining: 1 });
    expect(remove.mock.calls[1]?.[1]).toBe(owner);
  });

  it("reads v1 staging and retirement without inventing custody for old records", async () => {
    const f = await fixture(), ref = f.ref("environment");
    await f.staging.write(f.serverId, [ref], () => undefined);
    const oldStage = { ...await f.row(ref), version: 1 } as Record<string, unknown>;
    delete oldStage.custodyId;
    await f.storage.systemSettings.set(stageKey(ref), oldStage);
    f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ retired: 1 });
    const retiredKey = "mcp_credential_retired_v1:" + createHash("sha256").update(ref).digest("hex");
    const retired = (await f.storage.systemSettings.get<Record<string, unknown>>(retiredKey))!.value;
    const oldRetired = { ...retired, version: 1 } as Record<string, unknown>;
    delete oldRetired.custodyId;
    await f.storage.systemSettings.set(retiredKey, oldRetired);
    await f.reopen();
    const refuseUnknown = vi.fn((_account: string, custodyId: string | null) => { expect(custodyId).toBeNull(); return false; });
    expect(await f.store.reconcileCredentialRetirements(refuseUnknown)).toMatchObject({ blocked: 1, deleted: 0, remaining: 1 });
    expect(refuseUnknown).toHaveBeenCalledOnce();
  });

  it("rolls back replacement instead of deleting with corrupted custody metadata", async () => {
    const f = await fixture(), first = { credentialRef: f.ref("environment") }, next = { credentialRef: f.ref("environment") };
    await f.store.stageCredentialVersions(f.serverId, [first.credentialRef], () => undefined, "a".repeat(64));
    await f.store.writeEnvironmentBinding(await f.server(), undefined, first);
    await f.storage.systemSettings.set(stageKey(first.credentialRef), { ...await f.row(first.credentialRef), custodyId: "not-a-custodian" });
    const server = await f.server();
    await expect(f.store.writeEnvironmentBinding(server, first, next)).rejects.toThrow("Invalid MCP credential staging record");
    expect(await f.server()).toEqual(server);
    expect(await f.store.readEnvironmentBinding(f.serverId)).toEqual(first);
    expect(await f.store.reconcileCredentialRetirements(() => true)).toMatchObject({ deleted: 0 });
  });

  it("records before writing and consumes staging with canonical auth publication", async () => {
    const f = await fixture();
    const refs = [f.ref("access-token"), f.ref("refresh-token")];
    await f.staging.write(f.serverId, refs, () => { refs.forEach((ref) => f.secrets.set(ref, "private-value")); });
    for (const ref of refs) expect((await f.row(ref))?.status).toBe("ready");
    const next = { accessTokenRef: refs[0], refreshTokenRef: refs[1], updatedAt: new Date().toISOString() };
    await f.store.writeAuthState({ server: await f.server(), expected: undefined, next });
    await f.reopen();
    for (const ref of refs) expect((await f.row(ref))?.status).toBe("published");
    f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ retired: 0, remaining: 0 });
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.row(refs[0]!))).not.toContain("private-value");
    expect(JSON.stringify(await f.store.readServers())).not.toContain("keychain:");
  });

  it("recovers an unpublished completed write after reopen and permanently rejects its late publication", async () => {
    const f = await fixture(), ref = f.ref("environment");
    await f.staging.write(f.serverId, [ref], () => { f.secrets.set(ref, "private-proof"); });
    expect(await f.staging.reconcile()).toMatchObject({ pending: 1, retired: 0 });
    await f.reopen();
    f.expire();
    await expect(f.staging.publish(f.serverId, [ref])).rejects.toThrow("expired");
    expect(await f.staging.reconcile()).toMatchObject({ retired: 1, remaining: 0 });
    expect(await f.store.reconcileCredentialRetirements((account) => { f.secrets.delete(`keychain:goatcitadel:${account}`); }))
      .toMatchObject({ deleted: 1, remaining: 0 });
    expect(f.secrets.size).toBe(0);
    await expect(f.store.writeEnvironmentBinding(await f.server(), undefined, { credentialRef: ref })).rejects.toThrow("retired");
  });

  it("preserves a published staged credential when the publication acknowledgement is lost", async () => {
    const f = await fixture(), ref = f.ref("environment");
    await f.staging.write(f.serverId, [ref], () => { f.secrets.set(ref, "current-after-uncertain-response"); });
    let depth = 0;
    const store = new McpServerStore({ systemSettings: f.storage.systemSettings,
      runImmediateTransaction: async (callback) => {
        const outermost = depth++ === 0;
        try {
          const result = await f.storage.runImmediateTransaction(callback);
          if (outermost) throw new Error("publication acknowledgement lost");
          return result;
        } finally { depth -= 1; }
      } });
    await expect(store.writeEnvironmentBinding(await f.server(), undefined, { credentialRef: ref }))
      .rejects.toThrow("publication acknowledgement lost");
    await f.reopen(); f.expire();
    expect(await f.store.readEnvironmentBinding(f.serverId)).toEqual({ credentialRef: ref });
    expect((await f.row(ref))?.status).toBe("published");
    expect(await f.staging.reconcile()).toMatchObject({ retired: 0, remaining: 0 });
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(f.secrets.has(ref)).toBe(true);
  });

  it("rejects expired staging at canonical publication before cleanup runs", async () => {
    const f = await fixture(), ref = f.ref("environment");
    await f.staging.write(f.serverId, [ref], () => undefined);
    const readyAt = Date.now() - 11 * 60_000;
    await f.storage.systemSettings.set(stageKey(ref), { ...await f.row(ref), createdAt: readyAt - 1000, readyAt });
    const server = await f.server();
    await expect(f.store.writeEnvironmentBinding(server, undefined, { credentialRef: ref })).rejects.toThrow("expired");
    expect(await f.server()).toEqual(server);
    expect(await f.store.readEnvironmentBinding(f.serverId)).toBeUndefined();
    expect((await f.row(ref))?.status).toBe("ready");
  });

  it("keeps writing quarantined while another owner is suspended before its keychain call", async () => {
    const f = await fixture(), ref = f.ref("environment");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    const ctx: McpCredentialMetadataContext = { systemSettings: f.storage.systemSettings,
      runImmediateTransaction: async (callback) => {
        const value = await f.storage.runImmediateTransaction(callback);
        if (!paused) { paused = true; entered(); await gate; }
        return value;
      } };
    const writer = new McpCredentialStagingStore(ctx, new McpCredentialRetirementStore(ctx));
    const write = vi.fn((): undefined => { f.secrets.set(ref, "late-write"); });
    const pending = writer.write(f.serverId, [ref], write);
    await started;
    try {
      f.expire();
      expect(await f.staging.reconcile()).toMatchObject({ writing: 1, retired: 0, remaining: 1 });
      expect(write).not.toHaveBeenCalled();
      await expect(f.store.writeEnvironmentBinding(await f.server(), undefined, { credentialRef: ref })).rejects.toThrow("unfinished");
      expect(await f.store.reconcileCredentialRetirements(vi.fn())).toMatchObject({ deleted: 0 });
    } finally { release(); await pending; }
    expect(write).toHaveBeenCalledOnce();
    await f.store.writeEnvironmentBinding(await f.server(), undefined, { credentialRef: ref });
    expect((await f.row(ref))?.status).toBe("published");
  });

  it("retains a writing quarantine after an unacknowledged terminal write across restart", async () => {
    const f = await fixture(), ref = f.ref("environment");
    let transactions = 0;
    const ctx: McpCredentialMetadataContext = { systemSettings: f.storage.systemSettings,
      runImmediateTransaction: async (callback) => {
        if (++transactions === 2) throw new Error("terminal receipt unavailable");
        return f.storage.runImmediateTransaction(callback);
      } };
    const writer = new McpCredentialStagingStore(ctx, new McpCredentialRetirementStore(ctx));
    await expect(writer.write(f.serverId, [ref], () => { f.secrets.set(ref, "retained-unknown"); })).rejects.toThrow("receipt unavailable");
    await f.reopen(); f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ writing: 1, retired: 0 });
    expect(f.secrets.has(ref)).toBe(true);
    await expect(f.store.writeEnvironmentBinding(await f.server(), undefined, { credentialRef: ref })).rejects.toThrow("unfinished");
  });

  it("recovers a committed ready receipt when its acknowledgement was lost", async () => {
    const f = await fixture(), ref = f.ref("environment");
    let transactions = 0;
    const ctx: McpCredentialMetadataContext = { systemSettings: f.storage.systemSettings,
      runImmediateTransaction: async (callback) => {
        const value = await f.storage.runImmediateTransaction(callback);
        if (++transactions === 2) throw new Error("ready acknowledgement lost");
        return value;
      } };
    const writer = new McpCredentialStagingStore(ctx, new McpCredentialRetirementStore(ctx));
    await expect(writer.write(f.serverId, [ref], () => undefined)).rejects.toThrow("acknowledgement lost");
    await f.reopen(); f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ retired: 1, remaining: 0 });
  });

  it("retires both attempted versions after a synchronous partial write failure", async () => {
    const f = await fixture(), refs = [f.ref("access-token"), f.ref("refresh-token")];
    await expect(f.staging.write(f.serverId, refs, () => {
      f.secrets.set(refs[0]!, "partial-secret"); throw new Error("writer failed");
    })).rejects.toThrow("writer failed");
    await f.reopen();
    expect(await f.staging.reconcile()).toMatchObject({ remaining: 0 });
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 2, remaining: 0 });
    expect(remove.mock.calls.map(([account]) => account).sort()).toEqual(refs.map((ref) => ref.slice("keychain:goatcitadel:".length)).sort());
    await expect(f.store.writeAuthState({ server: await f.server(), expected: undefined,
      next: { accessTokenRef: refs[0], updatedAt: new Date().toISOString() } })).rejects.toThrow("retired");
  });

  it("never calls the writer without acknowledged durable registration", async () => {
    const f = await fixture();
    const ctx: McpCredentialMetadataContext = { systemSettings: f.storage.systemSettings,
      runImmediateTransaction: async (callback) => {
        await f.storage.runImmediateTransaction(callback); throw new Error("registration acknowledgement lost");
      } };
    const writer = new McpCredentialStagingStore(ctx, new McpCredentialRetirementStore(ctx));
    const write = vi.fn(() => undefined), ref = f.ref("environment");
    await expect(writer.write(f.serverId, [ref], write)).rejects.toThrow("acknowledgement lost");
    expect(write).not.toHaveBeenCalled();
    expect((await f.row(ref))?.status).toBe("writing");
  });

  it("rolls back publication and its staging consumption as one transaction", async () => {
    const f = await fixture(), ref = f.ref("environment");
    await f.staging.write(f.serverId, [ref], () => undefined);
    const server = await f.server();
    const broken = new McpServerStore({ systemSettings: { get: (...args) => f.storage.systemSettings.get(...args),
      set: (...args) => f.storage.systemSettings.set(...args), compareAndSet: async (...args) => {
        if (args[0] === "mcp_environment_bindings_v1") throw new Error("publication rollback");
        return f.storage.systemSettings.compareAndSet(...args);
      } }, runImmediateTransaction: (callback) => f.storage.runImmediateTransaction(callback) });
    await expect(broken.writeEnvironmentBinding(server, undefined, { credentialRef: ref })).rejects.toThrow("publication rollback");
    expect(await f.server()).toEqual(server);
    expect((await f.row(ref))?.status).toBe("ready");
    expect(await f.store.readEnvironmentBinding(f.serverId)).toBeUndefined();
    await f.store.writeEnvironmentBinding(server, undefined, { credentialRef: ref });
  });

  it("preserves corrupt cross-server aliases and advances past them in bounded passes", async () => {
    const f = await fixture(), blocked = f.ref("environment"), ready = f.ref("environment");
    await f.staging.write(f.serverId, [blocked], () => undefined);
    await f.staging.write(f.serverId, [ready], () => undefined);
    await f.storage.systemSettings.set("mcp_environment_bindings_v1", { other: { credentialRef: blocked } });
    f.expire();
    expect(await f.staging.reconcile(1)).toMatchObject({ blocked: 1, retired: 0, remaining: 2 });
    expect(await f.staging.reconcile(1)).toMatchObject({ retired: 1, remaining: 1 });
    const remove = vi.fn();
    expect(await f.store.reconcileCredentialRetirements(remove)).toMatchObject({ deleted: 1 });
    expect(remove.mock.calls.map(([account]) => account)).toEqual([ready.slice("keychain:goatcitadel:".length)]);
  });

  it.each(["foreign", "legacy", "duplicate", "retired"])("rejects %s staging before a keychain write", async (kind) => {
    const f = await fixture(), ref = f.ref("environment"), write = vi.fn(() => undefined);
    let refs = [ref];
    if (kind === "foreign") refs = [ref.replace(f.serverId, "other")];
    if (kind === "legacy") refs = [`keychain:goatcitadel:mcp:${f.serverId}:access-token`];
    if (kind === "duplicate") refs = [ref, ref];
    if (kind === "retired") await new McpCredentialRetirementStore(f.ctx()).record(f.serverId, [ref], []);
    await expect(f.staging.write(f.serverId, refs, write)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("retains corrupt rows without creating a deletion record", async () => {
    const f = await fixture(), ref = f.ref("environment");
    await f.staging.write(f.serverId, [ref], () => undefined);
    await f.storage.systemSettings.set(stageKey(ref), { ...await f.row(ref), credentialRef: f.ref("environment") });
    f.expire();
    expect(await f.staging.reconcile()).toMatchObject({ failed: 1, retired: 0, remaining: 1 });
    expect(await f.store.reconcileCredentialRetirements(vi.fn())).toMatchObject({ deleted: 0 });
  });

  it("rejects a full staging backlog before writing either secret or metadata", async () => {
    const f = await fixture(), ref = f.ref("environment"), write = vi.fn(() => undefined);
    await f.storage.systemSettings.set(INDEX, { version: 1, keys: Array.from({ length: 4096 }, (_, index) =>
      `mcp_credential_staged_v1:${index.toString(16).padStart(64, "0")}`) });
    await expect(f.staging.write(f.serverId, [ref], write)).rejects.toThrow("backlog");
    expect(write).not.toHaveBeenCalled();
    expect(await f.row(ref)).toBeUndefined();
  });
});

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-staging-"));
  const options = { dbPath: path.join(directory, "store.db"), transcriptsDir: path.join(directory, "transcripts"), auditDir: path.join(directory, "audit") };
  let storage = createSqliteAsyncStorage(new Storage(options)); opened.add(storage);
  let clock = Date.now();
  const ctx = (): McpServerStoreCtx => ({ systemSettings: storage.systemSettings,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback) });
  let store = new McpServerStore(ctx());
  const makeStaging = (): McpCredentialStagingStore => new McpCredentialStagingStore(ctx(),
    new McpCredentialRetirementStore(ctx(), (serverId, ref) => staging.readCustody(serverId, ref)), () => clock);
  let staging: McpCredentialStagingStore = makeStaging();
  const serverId = "staging-fixture", secrets = new Map<string, string>();
  const record: McpServerRecord = { serverId, label: "Staging fixture", transport: "stdio", command: "node", args: [],
    authType: "oauth2", enabled: true, category: "development", trustTier: "restricted", costTier: "unknown",
    policy: normalizeMcpPolicy(), status: "disconnected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.writeServers([record], []);
  return { ctx, serverId, secrets, ref: (kind: string) => `keychain:goatcitadel:mcp:${serverId}:${kind}:${randomUUID()}`,
    server: () => store.requireServer(serverId), expire: () => { clock += 11 * 60_000; },
    row: async (ref: string) => (await storage.systemSettings.get<Record<string, unknown>>(stageKey(ref)))?.value,
    get storage() { return storage; }, get store() { return store; }, get staging() { return staging; },
    async reopen() {
      await storage.close(); opened.delete(storage); storage = createSqliteAsyncStorage(new Storage(options)); opened.add(storage);
      store = new McpServerStore(ctx()); staging = makeStaging();
    } };
}
function stageKey(ref: string): string { return "mcp_credential_staged_v1:" + createHash("sha256").update(ref).digest("hex"); }
