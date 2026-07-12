import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POSTGRES_MIGRATIONS,
  PostgresDatabaseClient,
  PostgresSyncDatabaseClient,
  Storage,
  runPostgresMigrations,
} from "@goatcitadel/storage";
import type { MemoryForgetRequest, MemoryForgetResponse } from "@goatcitadel/contracts";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";

const realPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

interface ForgetMemoryHooks {
  onCommit?: () => void;
  afterCommit?: () => void;
}

interface Harness {
  adminPool: Pool;
  scopedPool: Pool;
  schemaName: string;
  rootDir: string;
  storage: Storage;
  service: MemoryLifecycleService;
  forgetMemory(input: MemoryForgetRequest, hooks?: ForgetMemoryHooks): MemoryForgetResponse;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

describe.skipIf(!realPostgresUrl)("MemoryLifecycleService real PostgreSQL bulk forget", { timeout: 120_000 }, () => {
  it("forgets every matching scoped item beyond the list cap and commits history atomically", async () => {
    const harness = await createHarness();
    await seedScopedCompletenessFixture(harness.scopedPool);

    const rollbackAfterCommit = vi.fn();
    expect(() =>
      harness.forgetMemory(
        {
          workspaceId: "workspace-a",
          namespace: "workspace.shared",
          query: "fr108-purge-marker",
          actionId: "fr108-real-pg-rollback",
          source: "verification.real-postgres",
          actorId: "operator:postgres-proof",
        },
        {
          onCommit: () => {
            throw new Error("forced pre-commit failure");
          },
          afterCommit: rollbackAfterCommit,
        },
      ),
    ).toThrow("forced pre-commit failure");
    expect(rollbackAfterCommit).not.toHaveBeenCalled();
    await expect(countRows(harness.scopedPool, "memory_items", "status = 'forgotten'")).resolves.toBe(1);
    await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(0);

    const afterCommit = vi.fn();
    const response = harness.forgetMemory(
      {
        workspaceId: "workspace-a",
        namespace: "workspace.shared",
        query: "fr108-purge-marker",
        actionId: "fr108-real-pg-complete",
        source: "verification.real-postgres",
        actorId: "operator:postgres-proof",
      },
      { afterCommit },
    );

    expect(response).toMatchObject({
      actionId: "fr108-real-pg-complete",
      matchedCount: 532,
      alreadyForgottenCount: 0,
      forgottenCount: 532,
    });
    expect(response.itemIds).toHaveLength(532);
    expect(new Set(response.itemIds).size).toBe(532);
    expect(response.items).toHaveLength(532);
    expect(response.items.every((item) => item.status === "forgotten")).toBe(true);
    expect(afterCommit).toHaveBeenCalledTimes(1);

    const scopedCounts = await harness.scopedPool.query<{
      workspace_id: string;
      status: string;
      count: string;
    }>(`
      SELECT COALESCE(workspace_id, '<legacy-or-global>') AS workspace_id, status, COUNT(*)::text AS count
      FROM memory_items
      GROUP BY COALESCE(workspace_id, '<legacy-or-global>'), status
      ORDER BY workspace_id, status
    `);
    expect(scopedCounts.rows).toEqual(
      expect.arrayContaining([
        { workspace_id: "workspace-a", status: "forgotten", count: "526" },
        { workspace_id: "workspace-b", status: "active", count: "4" },
        { workspace_id: "<legacy-or-global>", status: "forgotten", count: "7" },
        { workspace_id: "<legacy-or-global>", status: "active", count: "3" },
      ]),
    );

    const history = await harness.scopedPool.query<{
      count: string;
      action_count: string;
      source_count: string;
    }>(`
      SELECT
        COUNT(*)::text AS count,
        COUNT(*) FILTER (WHERE payload_json::jsonb ->> 'actionId' = 'fr108-real-pg-complete')::text AS action_count,
        COUNT(*) FILTER (WHERE payload_json::jsonb ->> 'source' = 'verification.real-postgres')::text AS source_count
      FROM memory_change_history
      WHERE change_type = 'forgotten'
    `);
    expect(history.rows[0]).toEqual({ count: "532", action_count: "532", source_count: "532" });
  });

  it("waits for a concurrent duplicate and records exactly one active-to-forgotten transition", async () => {
    const harness = await createHarness();
    const itemId = "fr108-concurrent-item";
    await seedMemoryItem(harness.scopedPool, {
      itemId,
      workspaceId: "workspace-a",
      metadata: { workspaceId: "workspace-b" },
    });

    let blocker: PoolClient | undefined;
    try {
      blocker = await harness.scopedPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT item_id FROM memory_items WHERE item_id = $1 FOR UPDATE", [itemId]);

      const now = "2026-07-12T08:00:00.000Z";
      const firstHistoryPayload = JSON.stringify({
        previousStatus: "active",
        actionId: "fr108-concurrent-first",
        source: "verification.concurrent-owner",
      });
      const releaseConcurrentOwner = blocker.query(`
        UPDATE memory_items
        SET status = 'forgotten',
            forgotten_at = '${escapePostgresLiteral(now)}',
            updated_at = '${escapePostgresLiteral(now)}'
        WHERE item_id = '${escapePostgresLiteral(itemId)}'
          AND status = 'active';
        INSERT INTO memory_change_history (
          change_id, item_id, change_type, actor_id, payload_json, created_at
        ) VALUES (
          '${randomUUID()}',
          '${escapePostgresLiteral(itemId)}',
          'forgotten',
          'operator:concurrent-owner',
          '${escapePostgresLiteral(firstHistoryPayload)}',
          '${escapePostgresLiteral(now)}'
        );
        SELECT pg_sleep(0.8);
        COMMIT;
      `);

      const startedAt = Date.now();
      const response = harness.forgetMemory({
        workspaceId: "workspace-a",
        itemIds: [itemId],
        actionId: "fr108-concurrent-duplicate",
        source: "verification.concurrent-duplicate",
        actorId: "operator:duplicate",
      });
      const waitedMs = Date.now() - startedAt;
      await releaseConcurrentOwner;
      blocker.release();
      blocker = undefined;

      expect(waitedMs).toBeGreaterThanOrEqual(650);
      expect(response).toMatchObject({
        actionId: "fr108-concurrent-duplicate",
        matchedCount: 1,
        alreadyForgottenCount: 1,
        forgottenCount: 0,
        itemIds: [],
        items: [],
      });
      await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(
        1,
      );
      const row = await harness.scopedPool.query<{ status: string; forgotten_at: string | null }>(
        "SELECT status, forgotten_at FROM memory_items WHERE item_id = $1",
        [itemId],
      );
      expect(row.rows[0]).toEqual({ status: "forgotten", forgotten_at: now });
    } finally {
      if (blocker) {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
    }
  });
});

async function createHarness(): Promise<Harness> {
  if (!realPostgresUrl) {
    throw new Error("GOATCITADEL_TEST_POSTGRES_URL is required.");
  }
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const schemaName = `memory_forget_${suffix}`;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-memory-forget-pg-"));
  const adminPool = new Pool({ connectionString: realPostgresUrl });
  const scopedUrl = new URL(realPostgresUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
  const migrationPool = new Pool({ connectionString: scopedUrl.toString(), max: 2 });
  const migrationClient = new PostgresDatabaseClient(
    { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
    { pool: migrationPool },
  );

  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  let scopedPool: Pool | undefined;
  let syncClient: PostgresSyncDatabaseClient | undefined;
  let storage: Storage | undefined;
  try {
    try {
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
    } finally {
      await migrationClient.close();
    }

    scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    syncClient = new PostgresSyncDatabaseClient({
      connectionString: scopedUrl.toString(),
      database: "goatcitadel_test",
      applicationName: `goatcitadel-memory-forget-real-postgres-${suffix}`,
      pool: { max: 2, connectionTimeoutMs: 10_000 },
    });
    syncClient.prepare("SELECT 1 AS ready").get();
    storage = new Storage({
      db: syncClient,
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
    });
    const service = new MemoryLifecycleService({
      context: {} as never,
      learned: {} as never,
      maintenance: {} as never,
      admin: {
        gatewaySql: storage.gatewaySql,
        memoryQualityIssues: {} as never,
        tryParseJson: (raw: string | null | undefined, fallback: unknown) => {
          try {
            return raw ? JSON.parse(raw) : fallback;
          } catch {
            return fallback;
          }
        },
        requireFeatureEnabled: () => undefined,
        publishRealtime: vi.fn(),
      } as never,
      resolveLearnedMemoryPolicy: vi.fn(() => ({ allowWrite: true, reason: "allowed" as const })),
      readTranscriptOrEmpty: vi.fn(async () => []),
    });
    const forgetMemory = service.forgetMemory.bind(service) as unknown as Harness["forgetMemory"];

    let closed = false;
    const harness: Harness = {
      adminPool,
      scopedPool,
      schemaName,
      rootDir,
      storage,
      service,
      forgetMemory,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        storage.close();
        await scopedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
        await fs.rm(rootDir, { recursive: true, force: true });
      },
    };
    harnesses.push(harness);
    return harness;
  } catch (error) {
    try {
      if (storage) {
        storage.close();
      } else {
        syncClient?.close();
      }
    } catch {
      // Preserve the original setup failure while still cleaning the schema.
    }
    await scopedPool?.end().catch(() => undefined);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

async function seedScopedCompletenessFixture(pool: Pool): Promise<void> {
  const seedGroup = async (input: {
    prefix: string;
    count: number;
    workspaceId: string | null;
    legacyWorkspaceId?: string;
    status?: "active" | "forgotten";
  }) => {
    await pool.query(
      `
        INSERT INTO memory_items (
          item_id, namespace, title, content, metadata_json, pinned,
          ttl_override_seconds, expires_at, status, created_at, updated_at, forgotten_at, workspace_id
        )
        SELECT
          $1 || series::text,
          'workspace.shared',
          'FR-108 fixture ' || series::text,
          'fr108-purge-marker ' || series::text,
          $2,
          0,
          NULL,
          NULL,
          $3,
          '2026-07-12T07:00:00.000Z',
          '2026-07-12T07:00:00.000Z',
          CASE WHEN $3 = 'forgotten' THEN '2026-07-12T07:00:00.000Z' ELSE NULL END,
          $4
        FROM generate_series(1, $5) AS series
      `,
      [
        input.prefix,
        JSON.stringify(input.legacyWorkspaceId ? { workspaceId: input.legacyWorkspaceId } : {}),
        input.status ?? "active",
        input.workspaceId,
        input.count,
      ],
    );
  };

  await seedGroup({ prefix: "canonical-a-", count: 525, workspaceId: "workspace-a", legacyWorkspaceId: "workspace-b" });
  await seedGroup({ prefix: "legacy-a-", count: 7, workspaceId: null, legacyWorkspaceId: "workspace-a" });
  await seedGroup({ prefix: "canonical-b-", count: 4, workspaceId: "workspace-b", legacyWorkspaceId: "workspace-a" });
  await seedGroup({ prefix: "global-", count: 3, workspaceId: null });
  await seedGroup({
    prefix: "already-forgotten-a-",
    count: 1,
    workspaceId: "workspace-a",
    legacyWorkspaceId: "workspace-b",
    status: "forgotten",
  });
}

async function seedMemoryItem(
  pool: Pool,
  input: { itemId: string; workspaceId: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await pool.query(
    `
      INSERT INTO memory_items (
        item_id, namespace, title, content, metadata_json, pinned,
        ttl_override_seconds, expires_at, status, created_at, updated_at, forgotten_at, workspace_id
      ) VALUES ($1, 'workspace.shared', 'Concurrent item', 'fr108-purge-marker', $2, 0,
        NULL, NULL, 'active', '2026-07-12T07:00:00.000Z', '2026-07-12T07:00:00.000Z', NULL, $3)
    `,
    [input.itemId, JSON.stringify(input.metadata ?? {}), input.workspaceId],
  );
}

async function countRows(
  pool: Pool,
  table: "memory_items" | "memory_change_history",
  predicate: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table} WHERE ${predicate}`);
  return Number(result.rows[0]?.count ?? 0);
}

function escapePostgresLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
