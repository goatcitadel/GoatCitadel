import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  POSTGRES_MIGRATIONS,
  PostgresDatabaseClient,
  createPostgresRemoteStorage,
  runPostgresMigrations,
  type AsyncStorage,
} from "@goatcitadel/storage";
import type { MemoryForgetRequest } from "@goatcitadel/contracts";
import {
  acquireGatewayLivePostgresTestLease,
  type GatewayLivePostgresTestLease,
} from "../test/live-postgres-suite-lock.js";
import { MemoryLifecycleService, type MemoryForgetApprovalOutcome } from "./memory-lifecycle-service.js";

const realPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

interface Harness {
  adminPool: Pool;
  scopedPool: Pool;
  schemaName: string;
  rootDir: string;
  storage: AsyncStorage;
  service: MemoryLifecycleService;
  requestForget(input: MemoryForgetRequest): Promise<MemoryForgetApprovalOutcome>;
  approve(approvalId: string): Promise<void>;
  execute(approvalId: string): ReturnType<MemoryLifecycleService["executeApprovedMemoryLifecycleMutation"]>;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

/**
 * HX-402 P1 (coverage-preserving rewrite): the retired unapproved bulk-forget
 * ran directly; the approval-first flow is request (criteria resolve to exact
 * IDs) -> approve -> recovered-effect execution through the approved
 * producer. Live PostgreSQL proves the dialect-sensitive pieces: FOR UPDATE
 * row/approval locking, lock_timeout bounds, atomic history + governed
 * lifecycle + Journey commit, and the P0 owner's trigger immutability.
 */
describe.skipIf(!realPostgresUrl)("MemoryLifecycleService real PostgreSQL bulk forget", { timeout: 120_000 }, () => {
  let livePostgresTestLease: GatewayLivePostgresTestLease | undefined;

  beforeAll(async () => {
    livePostgresTestLease = await acquireGatewayLivePostgresTestLease(realPostgresUrl!);
  }, 120_000);

  afterAll(async () => {
    await livePostgresTestLease?.release();
    livePostgresTestLease = undefined;
  }, 120_000);

  it("binds canonical-workspace criteria beyond the list cap and commits history plus governed evidence atomically", async () => {
    const harness = await createHarness();
    await seedScopedCompletenessFixture(harness.scopedPool);

    // The purge-marker scope resolves legacy rows (NULL workspace_id, only a
    // metadata workspace claim) alongside canonical rows. The approval binding
    // fails closed on both the include-global scope AND the default scope:
    // canonical workspace ownership is never inferred from metadata, and a
    // refused request leaves zero deltas.
    await expect(
      harness.requestForget({
        workspaceId: "workspace-a",
        namespace: "workspace.shared",
        query: "fr108-purge-marker",
        includeGlobal: true,
        actionId: "fr108-real-pg-legacy-refusal",
      }),
    ).rejects.toThrow(/workspace-owned/i);
    await expect(
      harness.requestForget({
        workspaceId: "workspace-a",
        namespace: "workspace.shared",
        query: "fr108-purge-marker",
        actionId: "fr108-real-pg-legacy-default-refusal",
      }),
    ).rejects.toThrow(/workspace-owned/i);
    await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(0);
    await expect(countRows(harness.scopedPool, "memory_items", "status = 'forgotten'")).resolves.toBe(1);

    // The canonical-only marker binds all 525 active canonically-owned rows —
    // beyond the 500-row update chunk — in one deterministic approval.
    const outcome = await harness.requestForget({
      workspaceId: "workspace-a",
      namespace: "workspace.shared",
      query: "fr108-canonical-scope",
      actionId: "fr108-real-pg-complete",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    expect(outcome.pendingApproval.itemIds).toHaveLength(525);
    // No durable mutation before approval.
    await expect(countRows(harness.scopedPool, "memory_items", "status = 'forgotten'")).resolves.toBe(1);
    await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(0);

    await harness.approve(outcome.pendingApproval.approvalId);
    const applied = await harness.execute(outcome.pendingApproval.approvalId);
    expect(applied).toMatchObject({ disposition: "applied", action: "items_forgotten", changedCount: 525 });

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
        { workspace_id: "<legacy-or-global>", status: "active", count: "10" },
      ]),
    );

    const history = await harness.scopedPool.query<{
      count: string;
      approval_count: string;
      operation_count: string;
    }>(
      `
      SELECT
        COUNT(*)::text AS count,
        COUNT(*) FILTER (WHERE payload_json::jsonb ->> 'approvalId' = $1)::text AS approval_count,
        COUNT(*) FILTER (WHERE payload_json::jsonb ->> 'operationKind' = 'approved_forget')::text AS operation_count
      FROM memory_change_history
      WHERE change_type = 'forgotten'
    `,
      [outcome.pendingApproval.approvalId],
    );
    expect(history.rows[0]).toEqual({ count: "525", approval_count: "525", operation_count: "525" });

    // Every history change has its immutable governed twin plus Journey.
    const governed = await harness.scopedPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM governed_lifecycle_events WHERE operation = 'item_forgotten'",
    );
    expect(governed.rows[0]?.count).toBe("525");
    await expect(
      harness.scopedPool.query(
        "UPDATE governed_lifecycle_events SET actor_id = 'forged' WHERE operation = 'item_forgotten'",
      ),
    ).rejects.toThrow(/immutable|append-only/i);
    await expect(
      harness.scopedPool.query("DELETE FROM governed_lifecycle_events WHERE operation = 'item_forgotten'"),
    ).rejects.toThrow(/immutable|append-only/i);

    // Replayed execution converges without new writes.
    const replay = await harness.execute(outcome.pendingApproval.approvalId);
    expect(replay.changedCount).toBe(525);
    await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(
      525,
    );
  });

  it("waits on the concurrent row owner and conflicts on the post-review drift with zero new writes", async () => {
    const harness = await createHarness();
    const itemId = "fr108-concurrent-item";
    await seedMemoryItem(harness.scopedPool, {
      itemId,
      workspaceId: "workspace-a",
      metadata: { workspaceId: "workspace-b" },
    });

    const outcome = await harness.requestForget({
      workspaceId: "workspace-a",
      itemIds: [itemId],
      actionId: "fr108-concurrent-duplicate",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    await harness.approve(outcome.pendingApproval.approvalId);

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
      await blocker.query(
        `
          SELECT
            set_config('goatcitadel.test_memory_item_id', $1, true),
            set_config('goatcitadel.test_memory_now', $2, true),
            set_config('goatcitadel.test_memory_change_id', $3, true),
            set_config('goatcitadel.test_memory_history_payload', $4, true)
        `,
        [itemId, now, randomUUID(), firstHistoryPayload],
      );
      // Send one static server-side batch before awaiting the async executor;
      // the dynamic fixture values were bound above through transaction-local
      // settings, and the Gateway event loop remains free while PostgreSQL waits.
      const releaseConcurrentOwner = blocker.query(`
        UPDATE memory_items
        SET status = 'forgotten',
            forgotten_at = current_setting('goatcitadel.test_memory_now'),
            updated_at = current_setting('goatcitadel.test_memory_now')
        WHERE item_id = current_setting('goatcitadel.test_memory_item_id')
          AND status = 'active';
        INSERT INTO memory_change_history (
          change_id, item_id, change_type, actor_id, payload_json, created_at
        ) VALUES (
          current_setting('goatcitadel.test_memory_change_id'),
          current_setting('goatcitadel.test_memory_item_id'),
          'forgotten',
          'operator:concurrent-owner',
          current_setting('goatcitadel.test_memory_history_payload'),
          current_setting('goatcitadel.test_memory_now')
        );
        SELECT pg_sleep(0.8);
        COMMIT;
      `);

      const startedAt = Date.now();
      let failure: unknown;
      try {
        await harness.execute(outcome.pendingApproval.approvalId);
      } catch (error) {
        failure = error;
      }
      const waitedMs = Date.now() - startedAt;
      await releaseConcurrentOwner;
      blocker.release();
      blocker = undefined;

      // The executor waited on the row lock, then observed state that drifted
      // after approval review — a terminal conflict, never a silent overwrite.
      expect(waitedMs).toBeGreaterThanOrEqual(650);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/conflicts with canonical state/i);
      await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(
        1,
      );
      const row = await harness.scopedPool.query<{ status: string; forgotten_at: string | null }>(
        "SELECT status, forgotten_at FROM memory_items WHERE item_id = $1",
        [itemId],
      );
      expect(row.rows[0]).toEqual({ status: "forgotten", forgotten_at: now });

      // A fresh request over the drifted (already forgotten) state settles as
      // a pure no-op without any approval.
      const noOp = await harness.requestForget({
        workspaceId: "workspace-a",
        itemIds: [itemId],
        actionId: "fr108-concurrent-follow-up",
      });
      expect(noOp).toMatchObject({ pendingApproval: null, noMutationRequired: true, alreadyForgottenCount: 1 });
    } finally {
      if (blocker) {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
    }
  });

  it("fails a stalled row lock within the production timeout without partial writes", async () => {
    const harness = await createHarness();
    const itemId = "fr108-lock-timeout-item";
    await seedMemoryItem(harness.scopedPool, { itemId, workspaceId: "workspace-a" });

    const outcome = await harness.requestForget({
      workspaceId: "workspace-a",
      itemIds: [itemId],
      actionId: "fr108-lock-timeout",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    await harness.approve(outcome.pendingApproval.approvalId);

    let blocker: PoolClient | undefined;
    try {
      blocker = await harness.scopedPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT item_id FROM memory_items WHERE item_id = $1 FOR UPDATE", [itemId]);
      const releaseBlocker = blocker.query("SELECT pg_sleep(7); COMMIT;");

      const startedAt = Date.now();
      let failure: unknown;
      try {
        await harness.execute(outcome.pendingApproval.approvalId);
      } catch (error) {
        failure = error;
      }
      const waitedMs = Date.now() - startedAt;
      await releaseBlocker;
      blocker.release();
      blocker = undefined;

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/lock timeout/i);
      expect(waitedMs).toBeGreaterThanOrEqual(4_000);
      expect(waitedMs).toBeLessThan(10_000);
      await expect(countRows(harness.scopedPool, "memory_items", "status = 'active'")).resolves.toBe(1);
      await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(
        0,
      );

      // The SAME approval retries cleanly once the lock clears: the approved
      // state is unchanged, so the recovered effect converges.
      const retry = await harness.execute(outcome.pendingApproval.approvalId);
      expect(retry).toMatchObject({ disposition: "applied", changedCount: 1 });
      await expect(countRows(harness.scopedPool, "memory_change_history", "change_type = 'forgotten'")).resolves.toBe(
        1,
      );
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
  const quotedSchemaName = quotePostgresTestIdentifier(schemaName);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-memory-forget-pg-"));
  const adminPool = new Pool({ connectionString: realPostgresUrl });
  const scopedUrl = new URL(realPostgresUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
  const migrationPool = new Pool({ connectionString: scopedUrl.toString(), max: 2 });
  const migrationClient = new PostgresDatabaseClient(
    { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
    { pool: migrationPool },
  );

  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  let scopedPool: Pool | undefined;
  let storage: AsyncStorage | undefined;
  try {
    try {
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
    } finally {
      await migrationClient.close();
    }

    scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    storage = createPostgresRemoteStorage({
      connection: {
        connectionString: scopedUrl.toString(),
        database: new URL(scopedUrl.toString()).pathname.slice(1),
        applicationName: `goatcitadel-memory-forget-real-postgres-${suffix}`,
        pool: { max: 2, connectionTimeoutMs: 10_000 },
      },
      migrationsTable: "schema_migrations",
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
      startupWaitTimeoutMs: 120_000,
    });
    await storage.waitUntilReady();
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
        publishRealtime: vi.fn(async () => undefined),
      },
      approvalAuthority: {
        approvals: storage.approvals,
        approvalEvents: storage.approvalEvents,
        governanceJourneyEvents: storage.governanceJourneyEvents,
      },
      resolveLearnedMemoryPolicy: vi.fn(async () => ({ allowWrite: true, reason: "allowed" as const })),
      readTranscriptOrEmpty: vi.fn(async () => []),
    });
    const storageRef = storage;
    const requestForget = (input: MemoryForgetRequest) =>
      service.requestMemoryForgetApproval({ ...input, requesterId: "operator:postgres-proof" });
    const approve = async (approvalId: string): Promise<void> => {
      await storageRef.approvals.resolve(approvalId, {
        decision: "approve",
        resolvedBy: "operator:postgres-proof",
      });
    };
    const execute = (approvalId: string) =>
      service.executeApprovedMemoryLifecycleMutation({ workspaceId: "workspace-a", approvalId });

    let closed = false;
    const harness: Harness = {
      adminPool,
      scopedPool,
      schemaName,
      rootDir,
      storage,
      service,
      requestForget,
      approve,
      execute,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await storage.close();
        await scopedPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
        await adminPool.end();
        await fs.rm(rootDir, { recursive: true, force: true });
      },
    };
    harnesses.push(harness);
    return harness;
  } catch (error) {
    try {
      if (storage) {
        await storage.close();
      }
    } catch {
      // Preserve the original setup failure while still cleaning the schema.
    }
    await scopedPool?.end().catch(() => undefined);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`).catch(() => undefined);
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
    contentMarker?: string;
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
          $6 || ' ' || series::text,
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
        input.contentMarker ?? "fr108-purge-marker",
      ],
    );
  };

  await seedGroup({
    prefix: "canonical-a-",
    count: 525,
    workspaceId: "workspace-a",
    legacyWorkspaceId: "workspace-b",
    // The canonical rows carry BOTH markers: the broad marker (to prove the
    // mixed-scope refusal) and the canonical-only marker (to bind the >500-row
    // approval scope without the legacy rows).
    contentMarker: "fr108-purge-marker fr108-canonical-scope",
  });
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

function quotePostgresTestIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe PostgreSQL test identifier: ${value}`);
  }
  return `"${value}"`;
}
