import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createPostgresRemoteStorage, type AsyncStorage } from "@goatcitadel/storage";
import { McpServerStore, type McpServerStoreCtx } from "./mcp-server-store.js";
import { McpCredentialRetirementStore, type McpCredentialMetadataContext } from "./mcp-credential-retirement-store.js";
import { McpCredentialStagingStore } from "./mcp-credential-staging-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";

it.skipIf(!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim())(
  "reconciles staged credentials across PostgreSQL RPC owners, uncertain deletion and restart",
  async () => {
    const url = process.env.GOATCITADEL_TEST_POSTGRES_URL!.trim();
    const schemaName = `mcp_staging_${randomUUID().replaceAll("-", "")}`;
    const directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-staging-pg-"));
    const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const options = { connection: { connectionString: scopedUrl.toString(),
      database: decodeURIComponent(scopedUrl.pathname.slice(1)), pool: { max: 1, connectionTimeoutMs: 10_000 } },
      migrationsTable: "schema_migrations", transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"), startupWaitTimeoutMs: 60_000 };
    const clients = new Set<AsyncStorage>();
    const open = async () => {
      const client = createPostgresRemoteStorage(options);
      clients.add(client); await client.waitUntilReady(); return { client };
    };
    const context = (storage: AsyncStorage): McpServerStoreCtx => ({ systemSettings: storage.systemSettings,
      runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback) });
    let created = false;
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`); created = true;
      const left = (await open()).client, right = (await open()).client;
      const a = new McpServerStore(context(left)), b = new McpServerStore(context(right));
      const serverId = "staging-pg-fixture";
      await a.writeServers([{ serverId, label: "PostgreSQL staging fixture", transport: "stdio", command: "node", args: [],
        authType: "oauth2", enabled: true, category: "development", trustTier: "restricted", costTier: "unknown",
        policy: normalizeMcpPolicy(), status: "disconnected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], []);
      const ref = (kind: string) => `keychain:goatcitadel:mcp:${serverId}:${kind}:${randomUUID()}`;
      const access = ref("access-token"), orphan = ref("environment"), unknown = ref("environment");
      const owner = "a".repeat(64), otherCustodian = "b".repeat(64);
      const secrets = new Map<string, string>();
      await a.stageCredentialVersions(serverId, [access], () => { secrets.set(access, "private-current"); }, otherCustodian);
      await a.stageCredentialVersions(serverId, [orphan], () => { secrets.set(orphan, "private-orphan"); }, owner);
      const published = { accessTokenRef: access, updatedAt: new Date().toISOString() };
      await b.writeAuthState({ server: await b.requireServer(serverId), expected: undefined, next: published });
      const lateStaging: McpCredentialStagingStore = new McpCredentialStagingStore(context(right),
        new McpCredentialRetirementStore(context(right), (id, credentialRef) => lateStaging.readCustody(id, credentialRef)),
        () => Date.now() + 11 * 60_000);
      expect(await lateStaging.reconcile()).toMatchObject({ retired: 1, remaining: 0 });
      expect(await b.reconcileCredentialRetirements((_account, custodyId) => custodyId === otherCustodian))
        .toMatchObject({ blocked: 1, deleted: 0, remaining: 1 });

      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const interruptedDelete = vi.fn(async (account: string, custodyId: string | null) => {
        expect(custodyId).toBe(owner);
        secrets.delete(`keychain:goatcitadel:${account}`); entered(); await gate;
        throw new Error("keychain deletion acknowledgement lost");
      });
      const cleanup = a.reconcileCredentialRetirements(interruptedDelete);
      await Promise.race([started, cleanup.then(() => { throw new Error("Expected keychain boundary was not reached."); })]);
      try {
        await expect(b.writeEnvironmentBinding(await b.requireServer(serverId), undefined, { credentialRef: orphan }))
          .rejects.toThrow("retired");
        expect(secrets.get(access)).toBe("private-current");
      } finally { release(); }
      expect(await cleanup).toMatchObject({ failed: 1, remaining: 1 });

      const lostContext: McpCredentialMetadataContext = { systemSettings: left.systemSettings,
        runImmediateTransaction: async (callback) => {
          await left.runImmediateTransaction(callback); throw new Error("staging registration acknowledgement lost");
        } };
      const writer = new McpCredentialStagingStore(lostContext, new McpCredentialRetirementStore(lostContext));
      const write = vi.fn(() => undefined);
      await expect(writer.write(serverId, [unknown], write, owner)).rejects.toThrow("registration acknowledgement lost");
      expect(write).not.toHaveBeenCalled();
      await Promise.all([left.close(), right.close()]); clients.delete(left); clients.delete(right);

      const restarted = (await open()).client, store = new McpServerStore(context(restarted));
      const reconciler = new McpCredentialStagingStore(context(restarted), new McpCredentialRetirementStore(context(restarted)),
        () => Date.now() + 24 * 60 * 60_000);
      expect(await reconciler.reconcile()).toMatchObject({ writing: 1, retired: 0, remaining: 1 });
      const deleted: string[] = [];
      expect(await store.reconcileCredentialRetirements((account, custodyId) => { expect(custodyId).toBe(owner); deleted.push(account); return true; }))
        .toMatchObject({ deleted: 1, remaining: 0 });
      expect(deleted).toEqual([orphan.slice("keychain:goatcitadel:".length)]);
      expect((await store.readAuthState())[serverId]).toEqual(published);
      expect(secrets.get(access)).toBe("private-current");
      await expect(store.writeEnvironmentBinding(await store.requireServer(serverId), undefined, { credentialRef: unknown }))
        .rejects.toThrow("unfinished");
      await expect(store.writeEnvironmentBinding(await store.requireServer(serverId), undefined, { credentialRef: orphan }))
        .rejects.toThrow("retired");
    } finally {
      const closed = await Promise.allSettled([...clients].map((client) => client.close()));
      try { if (created) await admin.query(`DROP SCHEMA ${schemaName} CASCADE`); }
      finally { await admin.end(); }
      expect(closed.filter((result) => result.status === "rejected")).toEqual([]);
    }
  }, 120_000,
);
