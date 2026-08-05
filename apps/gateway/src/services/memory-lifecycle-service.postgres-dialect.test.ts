import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryBatchMutationOperation } from "@goatcitadel/contracts";
import { AuditLog, Storage, TranscriptLog, createLocalAsyncStorage, type DatabaseClient } from "@goatcitadel/storage";
import {
  buildMemoryItemsApprovalStateMaterial,
  buildMemoryLifecycleApprovalBinding,
} from "./memory-journey-producer.js";
import {
  buildMemoryLifecycleApprovalPayload,
  deriveMemoryLifecycleApprovalId,
} from "./memory-domain-journey-producer.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { createPostgresDialectStrictDb } from "./testing/postgres-dialect-strict-db.js";

/**
 * These tests drive the REAL MemoryLifecycleService.batchMutateMemoryItems
 * over a REAL migrated sqlite database wrapped in a postgres-dialect facade
 * (see testing/postgres-dialect-strict-db.ts) via the real GatewaySqlRepository
 * exposed by Storage.gatewaySql. Unlike memory-lifecycle-service.test.ts, which
 * proves the service's control flow against a mock whose "rollback" is a JS
 * Map snapshot/restore, this file proves the batch path is atomic against an
 * actual sqlite immediate transaction (real BEGIN IMMEDIATE / COMMIT /
 * ROLLBACK) and that it never depends on sqlite-only raw exec syntax that
 * would break on a real Postgres driver.
 */

interface MemoryItemRow {
  item_id: string;
  namespace: string;
  title: string;
  content: string;
  metadata_json: string;
  pinned: number;
  ttl_override_seconds: number | null;
  expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
}

interface Harness {
  rootDir: string;
  storage: Storage;
  service: MemoryLifecycleService;
  db: DatabaseClient;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

function seedMemoryItem(
  db: DatabaseClient,
  seed: {
    itemId: string;
    title: string;
    content: string;
    namespace?: string;
    pinned?: boolean;
    status?: "active" | "forgotten";
  },
): void {
  const now = "2026-04-10T00:00:00.000Z";
  db.prepare(
    `
    INSERT INTO memory_items (
      item_id, namespace, title, content, metadata_json, pinned,
      ttl_override_seconds, expires_at, status, created_at, updated_at, forgotten_at, workspace_id
    ) VALUES (
      @itemId, @namespace, @title, @content, @metadataJson, @pinned,
      NULL, NULL, @status, @createdAt, @updatedAt, NULL, @workspaceId
    )
  `,
  ).run({
    itemId: seed.itemId,
    namespace: seed.namespace ?? "workspace.default",
    title: seed.title,
    content: seed.content,
    metadataJson: JSON.stringify({}),
    pinned: seed.pinned ? 1 : 0,
    status: seed.status ?? "active",
    createdAt: now,
    updatedAt: now,
    workspaceId: "default",
  });
}

function readMemoryItemRow(db: DatabaseClient, itemId: string): MemoryItemRow | undefined {
  return db
    .prepare(
      `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      WHERE item_id = ?
    `,
    )
    .get(itemId) as MemoryItemRow | undefined;
}

function countMemoryChangeHistoryRows(db: DatabaseClient): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM memory_change_history`).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function createHarness(options: { wrapDb?: (baseDb: DatabaseClient) => DatabaseClient } = {}): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-memory-lifecycle-pg-dialect-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });

  const baseDb = createPostgresDialectStrictDb(rootDir);
  const db = options.wrapDb ? options.wrapDb(baseDb) : baseDb;

  const storage = new Storage({
    db,
    transcriptsDir,
    auditDir,
    // Keep the file-based logs so the sqlite-backed facade never has to serve
    // the postgres transcript/audit SQL variants.
    transcripts: new TranscriptLog(transcriptsDir),
    audit: new AuditLog(auditDir),
  });
  const asyncStorage = createLocalAsyncStorage(storage);

  const service = new MemoryLifecycleService({
    context: {} as never,
    learned: {} as never,
    maintenance: {} as never,
    admin: {
      gatewaySql: asyncStorage.gatewaySql,
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
    approvalAuthority: {
      approvals: asyncStorage.approvals,
      approvalEvents: asyncStorage.approvalEvents,
      governanceJourneyEvents: asyncStorage.governanceJourneyEvents,
    },
    resolveLearnedMemoryPolicy: vi.fn(() => ({ allowWrite: true, reason: "allowed" as const })),
    readTranscriptOrEmpty: vi.fn(async () => []),
  });

  const harness: Harness = { rootDir, storage, service, db };
  harnesses.push(harness);
  return harness;
}

/**
 * HX-402 P1: seed one resolved `memory.lifecycle` batch approval directly.
 * The approvals repository's TTL-window SQL is genuinely postgres-flavored
 * (`AT TIME ZONE`), which the sqlite-backed strict facade cannot execute, so
 * this harness seeds the canonical approval row itself — the producer under
 * test still revalidates every binding field from that row inside its own
 * transaction, which is exactly the surface this file proves.
 */
function seedApprovedBatchApproval(
  harness: Harness,
  input: { actionId: string; operations: MemoryBatchMutationOperation[] },
): { approvalId: string } {
  const items = input.operations
    .map((operation) => {
      const row = readMemoryItemRow(harness.db, operation.itemId);
      if (!row) throw new Error(`Missing seeded memory item ${operation.itemId}.`);
      return {
        itemId: row.item_id,
        namespace: row.namespace,
        title: row.title,
        content: row.content,
        metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
        pinned: Boolean(row.pinned),
        ttlOverrideSeconds: row.ttl_override_seconds ?? undefined,
        expiresAt: row.expires_at ?? undefined,
        status: row.status as "active" | "forgotten",
        lifecycleState: row.status === "forgotten" ? "forgotten" : "active",
        workspaceId: "default",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        forgottenAt: row.forgotten_at ?? undefined,
      };
    })
    .sort((left, right) => (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0));
  const binding = buildMemoryLifecycleApprovalBinding({
    workspaceId: "default",
    subjectKind: "memory_item_batch",
    action: "batch_mutated",
    mutation: { actionId: input.actionId, operations: input.operations },
    expectedState: buildMemoryItemsApprovalStateMaterial(items as never),
  });
  const approvalId = deriveMemoryLifecycleApprovalId(binding);
  const resolvedAt = "2026-04-10T01:00:00.000Z";
  harness.db
    .prepare(
      `INSERT INTO approvals (
         approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
         explanation_status, created_at, expires_at, resolved_at, resolved_by
       ) VALUES (
         @approvalId, 'memory.lifecycle', 'danger', 'approved', @linkageJson, @payloadJson, '{}',
         'not_requested', @createdAt, NULL, @resolvedAt, @resolvedBy
       )`,
    )
    .run({
      approvalId,
      linkageJson: JSON.stringify({ workspaceId: "default" }),
      payloadJson: JSON.stringify(
        buildMemoryLifecycleApprovalPayload({
          binding,
          requesterId: "operator-requester",
          mutation: { actionId: input.actionId, operations: input.operations },
        }),
      ),
      createdAt: "2026-04-10T00:30:00.000Z",
      resolvedAt,
      resolvedBy: "operator-1",
    });
  return { approvalId };
}

describe("MemoryLifecycleService.batchMutateMemoryItems on the postgres dialect", () => {
  it("completes an atomic memory batch mutation through runImmediateTransaction without raw transaction SQL", async () => {
    const harness = createHarness();
    seedMemoryItem(harness.db, { itemId: "item-1", title: "Original item 1", content: "Original content 1" });
    seedMemoryItem(harness.db, { itemId: "item-2", title: "Original item 2", content: "Original content 2" });

    const batchInput = {
      actionId: "batch-real-atomic",
      source: "operator-ui",
      operations: [
        {
          kind: "patch_item" as const,
          itemId: "item-1",
          patch: { title: "Updated via real transaction", pinned: true },
        },
        {
          kind: "forget_item" as const,
          itemId: "item-2",
        },
      ],
    };
    const approved = seedApprovedBatchApproval(harness, batchInput);
    const execSpy = vi.spyOn(harness.db, "exec");

    const response = await harness.service.batchMutateMemoryItems(batchInput, "operator-1", approved);

    expect(response).toMatchObject({
      status: "applied",
      appliedCount: 2,
      targetItemIds: ["item-1", "item-2"],
    });

    // The strict double throws if any raw transaction-control SQL reaches
    // exec() (the way the real Postgres driver would reject sqlite-only BEGIN
    // IMMEDIATE syntax). Assert directly that none of those calls happened,
    // proving the batch went through db.transaction("immediate", ...) only.
    const rawTransactionControlCalls = execSpy.mock.calls.filter(
      ([sql]) =>
        /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|END)\b/i.test(sql) &&
        !/^\s*(?:SAVEPOINT|RELEASE\s+SAVEPOINT|ROLLBACK\s+TO\s+SAVEPOINT)\s+gc_async_storage_\d+\s*$/iu.test(sql),
    );
    expect(rawTransactionControlCalls).toHaveLength(0);

    // Verify the mutations actually landed by reading straight off the inner
    // sqlite connection backing the facade.
    const item1 = readMemoryItemRow(harness.db, "item-1");
    expect(item1).toMatchObject({ title: "Updated via real transaction", pinned: 1, status: "active" });
    const item2 = readMemoryItemRow(harness.db, "item-2");
    expect(item2).toMatchObject({ title: "Original item 2", status: "forgotten" });
    expect(item2?.forgotten_at).toBeTruthy();

    expect(countMemoryChangeHistoryRows(harness.db)).toBe(2);
  });

  it("rolls back every batch mutation on a real transactional failure", async () => {
    let updateCallCount = 0;
    let midTransactionItem1Title: string | undefined;
    let midTransactionCallNumber: number | undefined;

    const harness = createHarness({
      wrapDb: (baseDb) => ({
        ...baseDb,
        prepare: (sql: string) => {
          const stmt = baseDb.prepare(sql);
          if (!sql.includes("UPDATE memory_items")) {
            return stmt;
          }
          return {
            get: (...params: unknown[]) => stmt.get(...params),
            all: (...params: unknown[]) => stmt.all(...params),
            run: (...params: unknown[]) => {
              updateCallCount += 1;
              if (updateCallCount === 2) {
                midTransactionCallNumber = updateCallCount;
                // Read via the SAME underlying sqlite connection (baseDb is
                // never intercepted), proving this is a read-your-own-writes
                // check inside the still-open, uncommitted transaction rather
                // than a post-hoc assertion after commit/rollback.
                midTransactionItem1Title = readMemoryItemRow(baseDb, "item-1")?.title;
                throw new Error("Simulated real transactional update failure");
              }
              return stmt.run(...params);
            },
          };
        },
      }),
    });

    seedMemoryItem(harness.db, { itemId: "item-1", title: "Original item 1", content: "Original content 1" });
    seedMemoryItem(harness.db, { itemId: "item-2", title: "Original item 2", content: "Original content 2" });

    const rollbackInput = {
      actionId: "batch-real-rollback",
      operations: [
        { kind: "patch_item" as const, itemId: "item-1", patch: { title: "Should roll back" } },
        { kind: "patch_item" as const, itemId: "item-2", patch: { title: "Throws on second update" } },
      ],
    };
    const approved = seedApprovedBatchApproval(harness, rollbackInput);

    // Capture full row snapshots BEFORE the batch operation
    const item1Snapshot = readMemoryItemRow(harness.db, "item-1");
    const item2Snapshot = readMemoryItemRow(harness.db, "item-2");

    await expect(harness.service.batchMutateMemoryItems(rollbackInput, "operator-1", approved)).rejects.toThrow(
      "Simulated real transactional update failure",
    );

    // Proof this is a REAL immediate-transaction rollback and not a
    // short-circuit before touching storage: the first UPDATE's write was
    // observable on the live connection at the moment the second UPDATE
    // threw, i.e. it executed against real sqlite inside the still-open
    // transaction before the surrounding BEGIN IMMEDIATE/ROLLBACK undid it.
    expect(midTransactionCallNumber).toBe(2);
    expect(midTransactionItem1Title).toBe("Should roll back");

    // After the throw propagates out of runImmediateTransaction, every row
    // must be byte-unchanged versus the seeded originals: assert full equality
    // across all 12 columns (item_id, namespace, title, content, metadata_json,
    // pinned, ttl_override_seconds, expires_at, status, created_at, updated_at,
    // forgotten_at).
    const item1 = readMemoryItemRow(harness.db, "item-1");
    expect(item1).toStrictEqual(item1Snapshot);
    const item2 = readMemoryItemRow(harness.db, "item-2");
    expect(item2).toStrictEqual(item2Snapshot);

    expect(countMemoryChangeHistoryRows(harness.db)).toBe(0);
  });
});
