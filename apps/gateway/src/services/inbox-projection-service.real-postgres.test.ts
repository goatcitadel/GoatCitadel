import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPostgresRemoteStorage,
  POSTGRES_MIGRATIONS,
  PostgresDatabaseClient,
  runPostgresMigrations,
  type AsyncStorage,
} from "@goatcitadel/storage";
import {
  acquireGatewayLivePostgresTestLease,
  type GatewayLivePostgresTestLease,
} from "../test/live-postgres-suite-lock.js";
import { InboxProjectionService, type InboxProjectionDependencies } from "./inbox-projection-service.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

/** The approvals owner is the real PostgreSQL storage; every other Inbox source answers with nothing. */
function projectionDependencies(storage: AsyncStorage): InboxProjectionDependencies {
  return {
    storage: {
      approvals: storage.approvals,
      changePlans: { list: vi.fn(async () => []) },
      documentPatchProposals: { list: vi.fn(async () => []) },
      capabilityProposals: { list: vi.fn(async () => []) },
      chatTurnTraces: { listActive: vi.fn(async () => []) },
      chatSessionMeta: { get: vi.fn(async () => undefined), listBySessionIds: vi.fn(async () => new Map()) },
      taskDeliverables: { listRecentByWorkspace: vi.fn(async () => []) },
      durableChildWatchers: { listRecentCompletedDelegations: vi.fn(async () => []) },
      durableRuns: { getRunsByIds: vi.fn(async () => new Map()) },
      chatDelegationRuns: { get: vi.fn() },
      chatDelegationSteps: { get: vi.fn() },
    },
    memory: { listTraceMemoryCandidates: vi.fn(async () => []) },
    memoryProposalsEnabled: vi.fn(async () => true),
    improvement: { listCuratorReviewItems: vi.fn(async () => ({ generatedAt: "now", items: [] })) },
    durable: {
      listRunHistory: vi.fn(async () => ({ items: [] })),
      listDeadLetters: vi.fn(async () => []),
      getRun: vi.fn(),
    },
    runtimeHealth: {
      listBackups: vi.fn(async () => []),
      getDatabaseHealthSnapshot: vi.fn(async () => ({ configured: true, reachable: true, issues: [] })),
      getDaemonStatus: vi.fn(async () => ({ running: true, diagnostics: [] })),
      inspectLatestBackupTrust: vi.fn(async () => undefined),
    },
  } as unknown as InboxProjectionDependencies;
}

describe.skipIf(!url)("Inbox projection approvals on isolated real PostgreSQL", { timeout: 120_000 }, () => {
  let admin: Pool, storage: AsyncStorage, root: string, scopedUrl: URL;
  let lease: GatewayLivePostgresTestLease | undefined;
  const schema = `inbox_projection_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    lease = await acquireGatewayLivePostgresTestLease(url!);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-inbox-projection-pg-"));
    admin = new Pool({ connectionString: url });
    if (!/^inbox_projection_[a-f0-9]+$/u.test(schema)) throw new Error("Invalid isolated schema");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    scopedUrl = new URL(url!);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const migration = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: scopedUrl.pathname.slice(1) },
      { pool: new Pool({ connectionString: scopedUrl.toString(), max: 2 }) },
    );
    try {
      await runPostgresMigrations(migration, POSTGRES_MIGRATIONS);
    } finally {
      await migration.close();
    }
    storage = createPostgresRemoteStorage({
      connection: {
        connectionString: scopedUrl.toString(),
        database: scopedUrl.pathname.slice(1),
        applicationName: "goatcitadel-inbox-projection-test",
        pool: { max: 2, connectionTimeoutMs: 10_000 },
      },
      migrationsTable: "schema_migrations",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
      startupWaitTimeoutMs: 120_000,
    });
    await storage.waitUntilReady();
  }, 120_000);

  afterAll(async () => {
    try {
      await storage?.close();
    } finally {
      if (admin) {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await admin.end();
        }
      }
      if (
        root &&
        path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) &&
        path.basename(root).startsWith("gc-inbox-projection-pg-")
      ) {
        await fs.rm(root, { recursive: true, force: true });
      }
      await lease?.release();
    }
  }, 120_000);

  it("lists one install-wide skill approval in every workspace's Inbox and keeps linked ones scoped", async () => {
    const linked = (workspaceId: string) =>
      storage.approvals.create({
        kind: "tool.invoke",
        riskLevel: "caution",
        payload: { workspaceId },
        preview: { toolName: "documents.create", path: `notes/${workspaceId}.md` },
        linkage: { workspaceId, toolName: "documents.create" },
      });
    const linkedA = await linked("workspace-a");
    const linkedB = await linked("workspace-b");
    const { approval: skill } = await storage.approvals.createDeterministicDetachedWithTtlDuration(
      {
        approvalId: "skill-lifecycle-planner",
        kind: "skill.lifecycle",
        riskLevel: "danger",
        payload: { action: "skill_state_set", skillId: "planner" },
        preview: {
          title: "Approve skill state change",
          action: "skill_state_set",
          skillId: "planner",
          state: "enabled",
          currentState: "disabled",
        },
      },
      60 * 60_000,
    );
    // A tool approval whose linkage names no workspace is not install-wide, so no Inbox lists it.
    const toolOnly = await storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "caution",
      payload: {},
      preview: { toolName: "fs.write", path: "notes/loose.md" },
      linkage: { toolName: "fs.write" },
    });
    const service = new InboxProjectionService(projectionDependencies(storage));

    const approvalItems = async (workspaceId: string) =>
      (await service.getProjection(workspaceId)).items.filter((item) => item.kind === "approval");
    const inboxA = await approvalItems("workspace-a");
    const inboxB = await approvalItems("workspace-b");

    expect(inboxA.map((item) => item.source.approvalId).sort()).toEqual([linkedA.approvalId, skill.approvalId].sort());
    expect(inboxB.map((item) => item.source.approvalId).sort()).toEqual([linkedB.approvalId, skill.approvalId].sort());
    for (const [workspaceId, inbox] of [
      ["workspace-a", inboxA],
      ["workspace-b", inboxB],
    ] as const) {
      const skillItem = inbox.find((item) => item.source.approvalId === skill.approvalId);
      expect(skillItem).toMatchObject({
        title: "Turn on skill planner",
        summary: "Applies to every workspace.",
        source: { workspaceId, installWide: true },
      });
      const linkedItem = inbox.find((item) => item.source.approvalId !== skill.approvalId);
      expect(linkedItem?.source).not.toHaveProperty("installWide");
      expect(inbox.map((item) => item.source.approvalId)).not.toContain(toolOnly.approvalId);
    }
  });
});
