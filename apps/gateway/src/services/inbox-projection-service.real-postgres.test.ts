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
      chatSessionMeta: { listBySessionIds: vi.fn(async () => new Map()) },
      taskDeliverables: { listRecentByWorkspace: vi.fn(async () => []) },
      durableChildWatchers: { listRecentCompletedDelegations: vi.fn(async () => []) },
      durableRuns: { getRunsByIds: vi.fn(async () => new Map()) },
      chatDelegationRuns: storage.chatDelegationRuns,
      chatDelegationSteps: storage.chatDelegationSteps,
    },
    memory: { listTraceMemoryCandidates: vi.fn(async () => []) },
    memoryProposalsEnabled: vi.fn(async () => true),
    improvement: { listCuratorReviewItems: vi.fn(async () => ({ generatedAt: "now", items: [] })) },
    durable: {
      listRunHistory: vi.fn(async () => ({ items: [] })),
      listDeadLetters: vi.fn(async () => []),
      getRunsByIds: vi.fn(async () => new Map()),
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
        applicationName: schema,
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
      try {
        await storage?.close();
      } finally {
        try {
          if (admin) {
            try {
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            } finally {
              await admin.end();
            }
          }
        } finally {
          if (
            root &&
            path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) &&
            path.basename(root).startsWith("gc-inbox-projection-pg-")
          ) {
            await fs.rm(root, { recursive: true, force: true });
          }
        }
      }
    } finally {
      await lease?.release();
    }
  }, 120_000);

  it("loads persisted delegation records for a batch of Inbox lineage IDs", async () => {
    const run = await storage.chatDelegationRuns.create({
      runId: "inbox-delegation",
      sessionId: "inbox-parent-session",
      taskId: "inbox-task",
      objective: "Review the persisted linkage",
      roles: ["Coder"],
      mode: "sequential",
      status: "completed",
      startedAt: "2026-11-25T10:00:00.000Z",
    });
    const step = await storage.chatDelegationSteps.create({
      runId: run.runId,
      stepId: "inbox-step",
      role: "Coder",
      index: 0,
      status: "completed",
      startedAt: "2026-11-25T10:00:00.000Z",
    });

    const [runs, steps] = await Promise.all([
      storage.chatDelegationRuns.listByIds([run.runId, "missing-delegation"]),
      storage.chatDelegationSteps.listByIds([step.stepId, "missing-step"]),
    ]);
    expect(runs).toEqual(new Map([[run.runId, run]]));
    expect(steps).toEqual(new Map([[step.stepId, step]]));
  });

  it("serializes delegation patches behind a concurrent writer and preserves both updates", async () => {
    const runs = storage.chatDelegationRuns;
    const steps = storage.chatDelegationSteps;
    const run = await runs.create({
      runId: "delegation-patch-race",
      sessionId: "delegation-patch-session",
      taskId: "delegation-patch-task",
      objective: "Verify separate PostgreSQL writers",
      roles: ["Coder"],
      mode: "sequential",
    });
    const step = await steps.create({ runId: run.runId, stepId: "delegation-patch-step", role: "Coder", index: 0 });
    for (const operation of [
      {
        write: `UPDATE "${schema}".chat_delegation_runs SET final_summary = $1 WHERE run_id = $2`,
        id: run.runId,
        patch: async () => {
          const value = await runs.patch(run.runId, { status: "completed" });
          return { status: value.status, summary: value.finalSummary };
        },
      },
      {
        write: `UPDATE "${schema}".chat_delegation_steps SET summary = $1 WHERE step_id = $2`,
        id: step.stepId,
        patch: async () => {
          const value = await steps.patch(step.stepId, { status: "completed" });
          return { status: value.status, summary: value.summary };
        },
      },
    ]) {
      const writer = await admin.connect();
      let pending: Promise<PromiseSettledResult<{ status: string; summary?: string }>> | undefined;
      let committed = false;
      try {
        await writer.query("BEGIN");
        await writer.query(operation.write, ["Independent summary", operation.id]);
        pending = operation.patch().then(
          (value) => ({ status: "fulfilled", value }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
        await vi.waitFor(
          async () => {
            const blocked = await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'",
              [schema],
            );
            expect(blocked.rowCount).toBeGreaterThan(0);
          },
          { timeout: 5_000 },
        );
        await writer.query("COMMIT");
        committed = true;
      } finally {
        try {
          if (!committed) await writer.query("ROLLBACK");
        } finally {
          writer.release();
          await pending;
        }
      }
      const result = await pending;
      expect(result).toEqual({ status: "fulfilled", value: { status: "completed", summary: "Independent summary" } });
    }
  }, 30_000);

  it("keeps a superseded run with an active step and refuses to renew its expired dispatch", async () => {
    const runs = storage.chatDelegationRuns;
    const steps = storage.chatDelegationSteps;
    const base = {
      sessionId: "active-delegation-session",
      taskId: "active-delegation-task",
      objective: "Test active child recovery",
      roles: ["Coder"],
      mode: "sequential",
    } as const;
    const stale = await runs.create({
      ...base,
      roles: [...base.roles],
      runId: "active-delegation-stale",
      startedAt: "2026-11-20T10:00:00.000Z",
    });
    await runs.create({
      ...base,
      roles: [...base.roles],
      runId: "active-delegation-new",
      status: "completed",
      startedAt: "2026-11-21T10:00:00.000Z",
    });
    const stepId = "active-delegation-step";
    await steps.create({ runId: stale.runId, stepId, role: "Coder", index: 0 });
    expect(
      await runs.reconcileSupersededRunningRunsForSession(base.sessionId, {
        now: "2026-11-22T10:00:00.000Z",
      }),
    ).toEqual([]);
    expect((await runs.get(stale.runId)).status).toBe("running");

    const liveExpiry = "2099-01-01T00:00:00.000Z";
    const expiredAt = "2000-01-01T00:00:00.000Z";
    const childSessionId = "active-delegation-child";
    const dispatchToken = "active-delegation-dispatch";
    const claimToken = "active-delegation-claim";
    expect(
      await steps.claimPendingForDispatch(stepId, claimToken, liveExpiry, await steps.readDatabaseNow()),
    ).toBeDefined();
    expect(
      await steps.linkClaimedDispatch(stepId, claimToken, childSessionId, dispatchToken, liveExpiry),
    ).toBeDefined();
    const ownership = { stepId, childSessionId, expectedDispatchToken: dispatchToken };
    expect(await steps.bindOwnedDurableRun({ ...ownership, durableRunId: "active-delegation-durable" })).toBeDefined();
    expect(await steps.extendOwnedDispatchLease({ ...ownership, leaseExpiresAt: liveExpiry })).toBeDefined();
    await admin.query(
      `UPDATE "${schema}".chat_delegation_steps SET dispatch_claim_expires_at = $1 WHERE step_id = $2`,
      [expiredAt, stepId],
    );
    expect(await steps.extendOwnedDispatchLease({ ...ownership, leaseExpiresAt: liveExpiry })).toBeUndefined();
    expect((await steps.getDispatchClaim(stepId))?.expiresAt).toBe(expiredAt);
  });

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
