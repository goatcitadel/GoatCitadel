import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createSqliteAsyncStorage, createPostgresRemoteStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import type { McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { McpServerStore } from "./mcp-server-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { mcpServerRevision } from "./mcp-server-revision.js";

const KEY = "mcp_servers_v1";
const own = (storage: AsyncStorage) => new McpServerStore({ systemSettings: storage.systemSettings, approvalInbox: storage.approvalInbox, runImmediateTransaction: callback => storage.runImmediateTransaction(callback) });
const fixture = (serverId: string): McpServerRecord => ({ serverId, label: "MCP review fixture", transport: "stdio", command: "node", args: ["fixture.mjs"], authType: "none", enabled: false,
  status: "disconnected", category: "development", trustTier: "restricted", costTier: "free", policy: normalizeMcpPolicy(), createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" });
const tool = (serverId: string, toolName: string): McpToolRecord => ({ serverId, toolName, enabled: true, updatedAt: "2026-09-13T00:00:00.000Z" });
const reviewedSave = async (store: McpServerStore, base: McpServerRecord, patch: Partial<McpServerRecord> = {}) => {
  const current = await store.readServers();
  const result = await store.writeServers(current.map(item => item.serverId === base.serverId ? { ...item, ...patch } : item), current,
    { serverId: base.serverId, expectedRevision: mcpServerRevision(base) });
  return result.find(item => item.serverId === base.serverId)!;
};
const reviewedDelete = async (store: McpServerStore, base: McpServerRecord) => {
  const current = await store.readServers();
  return store.writeServers(current.filter(item => item.serverId !== base.serverId), current, { serverId: base.serverId, expectedRevision: mcpServerRevision(base) });
};

async function verify(storage: AsyncStorage, other: AsyncStorage) {
  const a = own(storage), b = own(other);
  const base = fixture("review-server");
  await storage.systemSettings.set(KEY, [base]);
  const before = await storage.systemSettings.get(KEY);
  const legacy = await a.requireServer(base.serverId);
  expect(legacy.revision).toMatch(/^[a-f0-9]{64}$/u);
  expect((await b.requireServer(base.serverId)).revision).toBe(legacy.revision);
  expect(await storage.systemSettings.get(KEY)).toEqual(before);
  const adopted = await reviewedSave(a, legacy, { label: "Reviewed legacy", revision: "a".repeat(64) });
  expect(adopted.revision).not.toBe(legacy.revision);
  expect(adopted.revision).not.toBe("a".repeat(64));
  expect(adopted.args).toEqual(base.args);

  const status = await b.patchServerState(base.serverId, { status: "connecting" }, adopted);
  expect(status.revision).toBe(adopted.revision);
  const noOp = await reviewedSave(a, adopted);
  expect(noOp.revision).not.toBe(adopted.revision);
  expect(noOp.configurationBindingId).toBe(adopted.configurationBindingId);
  expect(noOp.status).toBe("disconnected");
  await expect(reviewedSave(b, adopted, { label: "Stale" })).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  await expect(reviewedDelete(b, adopted)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  await expect(a.completeConnection(status, [tool(base.serverId, "late.old")])).rejects.toMatchObject({ httpStatus: 409 });
  expect((await a.readTools()).some(item => item.serverId === base.serverId)).toBe(false);

  const firstAttempt = await a.patchServerState(base.serverId, { status: "connecting" }, noOp);
  const secondAttempt = await b.patchServerState(base.serverId, { status: "connecting" }, firstAttempt);
  await expect(a.completeConnection(firstAttempt, [tool(base.serverId, "late.first")])).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  const connected = await b.completeConnection(secondAttempt, [tool(base.serverId, "current.tool")]);
  expect(connected.revision).toBe(noOp.revision);
  await expect(a.patchServerState(base.serverId, { status: "error", lastError: "Late failure" }, firstAttempt)).rejects.toMatchObject({ httpStatus: 409 });
  expect((await a.requireServer(base.serverId)).status).toBe("connected");

  // Capturing a fresh aggregate does not substitute for the old operator review.
  const winner = await reviewedSave(b, connected, { command: "peer-node", args: ["--token", "synthetic-peer"] });
  await expect(reviewedSave(a, connected, { command: "old-node", args: ["--token", "synthetic-old"] })).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  expect(await a.requireServer(base.serverId)).toEqual(winner);
  expect((await a.readTools()).some(item => item.serverId === base.serverId)).toBe(false);

  const rollback = new McpServerStore({ systemSettings: storage.systemSettings, approvalInbox: { deleteByReceiver: async () => { throw new Error("Fixture approval removal failed"); } }, runImmediateTransaction: callback => storage.runImmediateTransaction(callback) });
  await expect(reviewedDelete(rollback, winner)).rejects.toThrow("Fixture approval removal failed");
  expect(await a.requireServer(base.serverId)).toEqual(winner);
  const connectingBeforeDelete = await a.patchServerState(base.serverId, { status: "connecting" }, winner);
  await reviewedDelete(a, winner);
  const afterDelete = await a.readServers();
  await a.writeServers([winner, ...afterDelete], afterDelete);
  const recreated = await a.requireServer(base.serverId);
  expect(recreated.revision).not.toBe(winner.revision);
  await expect(reviewedDelete(b, winner)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  await expect(a.completeConnection(connectingBeforeDelete, [tool(base.serverId, "late.deleted")])).rejects.toMatchObject({ httpStatus: 409 });

  // Credential authority changes advance the edit revision without using secret bytes.
  const oauth = await reviewedSave(a, recreated, { authType: "oauth2", transport: "http", url: "https://example.invalid/mcp", command: undefined });
  await a.writeAuthState({ server: oauth, expected: undefined, next: { oauthState: "synthetic-handshake", updatedAt: base.updatedAt } });
  expect((await a.requireServer(base.serverId)).revision).toBe(oauth.revision);
  await a.writeAuthState({ server: oauth, expected: (await a.readAuthState())[base.serverId], next: { accessTokenRef: `keychain:goatcitadel:mcp:${base.serverId}:access-token:${randomUUID()}`, updatedAt: base.updatedAt } });
  const authorized = await a.requireServer(base.serverId);
  expect(authorized.revision).not.toBe(oauth.revision);
  await expect(reviewedSave(b, oauth)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  const enrolled = await a.writeEnvironmentBinding(authorized, undefined, { credentialRef: `keychain:goatcitadel:mcp:${base.serverId}:environment:${randomUUID()}` });
  expect(enrolled.revision).not.toBe(authorized.revision);
  await expect(reviewedDelete(b, authorized)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });

  // The returned result remains this writer's own snapshot even if a peer commits before return.
  let followUp = true;
  const racing = new McpServerStore({ systemSettings: storage.systemSettings, runImmediateTransaction: async callback => {
    const result = await storage.runImmediateTransaction(callback);
    if (followUp) { followUp = false; await reviewedSave(b, await b.requireServer(base.serverId), { label: "Later peer" }); }
    return result;
  } });
  const ownAck = await reviewedSave(racing, await a.requireServer(base.serverId), { label: "Own acknowledgement" });
  expect(ownAck.label).toBe("Own acknowledgement");
  expect((await a.requireServer(base.serverId)).label).toBe("Later peer");
  expect(ownAck.revision).not.toBe((await a.requireServer(base.serverId)).revision);

  // A tool write failure rolls back its connected status and attempt generation.
  const current = await a.requireServer(base.serverId);
  const attempt = await a.patchServerState(base.serverId, { status: "connecting" }, current);
  const broken = new McpServerStore({ systemSettings: { ...storage.systemSettings, get: storage.systemSettings.get, set: storage.systemSettings.set,
    compareAndSet: async (key, expected, value, now) => { if (key === "mcp_tools_v1") throw new Error("Fixture tool write failed"); return storage.systemSettings.compareAndSet(key, expected, value, now); } }, runImmediateTransaction: callback => storage.runImmediateTransaction(callback) });
  await expect(broken.completeConnection(attempt, [tool(base.serverId, "uncommitted")])).rejects.toThrow("Fixture tool write failed");
  expect(await a.requireServer(base.serverId)).toMatchObject(JSON.parse(JSON.stringify(attempt)));
}

it("enforces MCP review, credential, acknowledgement and connection boundaries on SQLite", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-review-sqlite-"));
  const storage = createSqliteAsyncStorage(new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") }));
  try { await verify(storage, storage); } finally { await storage.close(); }
}, 60_000);

it.skipIf(!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim())("enforces MCP reviews on actual PostgreSQL RPC workers and competing writers", async () => {
  const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL!.trim();
  const schemaName = `mcp_review_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const scoped = new URL(connectionString); scoped.searchParams.set("options", `-csearch_path=${schemaName}`);
  const root = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-review-pg-"));
  const clients: AsyncStorage[] = [];
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schemaName}`); created = true;
    for (let i = 0; i < 2; i++) {
      const client = createPostgresRemoteStorage({ connection: { connectionString: scoped.toString(), database: decodeURIComponent(scoped.pathname.slice(1)), pool: { max: 1, connectionTimeoutMs: 10_000 } }, migrationsTable: "schema_migrations", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit"), startupWaitTimeoutMs: 60_000 });
      clients.push(client); await client.waitUntilReady();
    }
    await verify(clients[0]!, clients[1]!);
    const a = own(clients[0]!), b = own(clients[1]!);
    for (const actions of [["save", "save"], ["save", "delete"], ["delete", "save"], ["delete", "delete"]]) {
      const current = await a.readServers(); const base = fixture(randomUUID());
      await a.writeServers([...current, base], current);
      const review = await a.requireServer(base.serverId);
      const results = await Promise.allSettled([a, b].map((store, i) => actions[i] === "save" ? reviewedSave(store, review, { label: `Writer ${i}` }) : reviewedDelete(store, review)));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
      expect([404, 409]).toContain(rejected.reason.httpStatus);
    }
  } finally {
    await Promise.all(clients.map(client => client.close()));
    if (created) await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await admin.end();
  }
}, 180_000);
