import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresRemoteStorage, POSTGRES_MIGRATIONS, PostgresDatabaseClient,
  runPostgresMigrations, type AsyncStorage,
} from "@goatcitadel/storage";
import type { ImprovementCandidateReviewPrecondition } from "@goatcitadel/contracts";
import { acquireGatewayLivePostgresTestLease, type GatewayLivePostgresTestLease } from "../test/live-postgres-suite-lock.js";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

describe.skipIf(!url)("Improvement reviewed decisions on isolated real PostgreSQL", { timeout: 120_000 }, () => {
  let admin: Pool, storage: AsyncStorage, second: AsyncStorage, root: string, scopedUrl: URL;
  let firstService: ImprovementService, secondService: ImprovementService;
  let lease: GatewayLivePostgresTestLease | undefined;
  const schema = `improvement_review_${randomUUID().replaceAll("-", "")}`;
  const open = () => createPostgresRemoteStorage({
    connection: {
      connectionString: scopedUrl.toString(), database: scopedUrl.pathname.slice(1),
      applicationName: "goatcitadel-improvement-review-test", pool: { max: 2, connectionTimeoutMs: 10_000 },
    },
    migrationsTable: "schema_migrations", transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"), startupWaitTimeoutMs: 120_000,
  });

  beforeAll(async () => {
    lease = await acquireGatewayLivePostgresTestLease(url!);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-improvement-review-pg-"));
    admin = new Pool({ connectionString: url });
    if (!/^improvement_review_[a-f0-9]+$/u.test(schema)) throw new Error("Invalid isolated schema");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    scopedUrl = new URL(url!);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const migration = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: scopedUrl.pathname.slice(1) },
      { pool: new Pool({ connectionString: scopedUrl.toString(), max: 2 }) },
    );
    try { await runPostgresMigrations(migration, POSTGRES_MIGRATIONS); }
    finally { await migration.close(); }
    storage = open();
    await storage.waitUntilReady();
    second = open();
    await second.waitUntilReady();
    firstService = makeService(storage);
    secondService = makeService(second);
    await firstService.initialize();
    await secondService.initialize();
  }, 120_000);

  afterAll(async () => {
    firstService?.stopScheduler();
    secondService?.stopScheduler();
    try { await Promise.all([storage?.close(), second?.close()]); }
    finally {
      if (admin) {
        try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
      if (root && path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())
        && path.basename(root).startsWith("gc-improvement-review-pg-")) {
        await fs.rm(root, { recursive: true, force: true });
      }
      await lease?.release();
    }
  }, 120_000);

  async function seed(suffix: string) {
    const signal = {
      regressionRunId: `review-pg-${suffix}`, packId: "pack-review-pg", capability: suffix,
      scoreDelta: -0.6, passDelta: -0.2, latencyDeltaMs: 35,
    };
    // Exercise the actual synthesis owner, including replay deduplication,
    // rather than inserting candidates, revisions, or evaluations directly.
    await firstService.recordPromptLabRegressionCompletionSignal(signal);
    await firstService.recordPromptLabRegressionCompletionSignal(signal);
    const candidates = (await firstService.listImprovementCandidates(100, "prompt-lab"))
      .filter((item) => item.targetKey === `pack-review-pg:${suffix}`);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ supportingSignalCount: 1, negativeSignalCount: 1, status: "ready_for_approval" });
    const review = await firstService.getCuratorReviewItem(candidates[0]!.candidateId);
    expect(review.latestEvaluation).toMatchObject({ status: "passed", revisionId: review.currentRevision?.revisionId,
      changeHash: review.currentRevision?.changeHash });
    expect(review.actionStatuses.approve).toBe("ready");
    return review;
  }

  async function decisionSignals(candidateId: string) {
    return (await firstService.listImprovementSignals(100)).filter((signal) =>
      signal.metadata.candidateId === candidateId && ["candidate_approved", "candidate_rejected"].includes(signal.signalKind));
  }

  it("admits one guarded approval across independent PostgreSQL storage workers", async () => {
    const review = await seed("concurrent");
    const input = { reviewPrecondition: review.reviewPrecondition };
    expect(input.reviewPrecondition).toBeDefined();
    const attempts = await Promise.allSettled([
      firstService.approveImprovementCandidate(review.candidate.candidateId, input),
      secondService.approveImprovementCandidate(review.candidate.candidateId, input),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const refused = attempts.find((attempt) => attempt.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : undefined).toMatchObject({ code: "WRITE_CONFLICT" });
    expect((await secondService.getCuratorReviewItem(review.candidate.candidateId)).candidate.status).toBe("approved");
    expect(await decisionSignals(review.candidate.candidateId)).toHaveLength(1);
  });

  it("rejects stale or foreign bindings without persisting even the candidate lock write", async () => {
    const review = await seed("stale");
    const before = await storage.db.prepare("SELECT * FROM improvement_candidates WHERE candidate_id = ?")
      .get(review.candidate.candidateId);
    const mismatches: Partial<ImprovementCandidateReviewPrecondition>[] = [
      { workspaceId: "foreign" }, { expectedStatus: "proposed" },
      { expectedRevisionId: "old-revision" }, { expectedChangeHash: "old-hash" },
    ];
    for (const mismatch of mismatches) {
      const input = { reviewPrecondition: { ...review.reviewPrecondition!, ...mismatch } };
      await expect(secondService.approveImprovementCandidate(review.candidate.candidateId, input))
        .rejects.toMatchObject({ code: "WRITE_CONFLICT" });
      await expect(secondService.rejectImprovementCandidate(review.candidate.candidateId, input))
        .rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    }
    expect(await storage.db.prepare("SELECT * FROM improvement_candidates WHERE candidate_id = ?")
      .get(review.candidate.candidateId)).toEqual(before);
    expect(await decisionSignals(review.candidate.candidateId)).toEqual([]);
  });

  it("rolls back rejected status if suppression clearing fails, then commits both on the guarded retry", async () => {
    const initial = await seed("suppression");
    const candidateId = initial.candidate.candidateId;
    await storage.db.prepare("UPDATE improvement_candidates SET suppression_until = ? WHERE candidate_id = ?")
      .run("2099-01-01T00:00:00.000Z", candidateId);
    const review = await firstService.getCuratorReviewItem(candidateId);
    const input = { reviewPrecondition: review.reviewPrecondition };
    await storage.db.exec(`
      CREATE FUNCTION reject_review_suppression_clear() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected suppression clear failure'; END $$;
      CREATE TRIGGER reject_review_suppression_clear BEFORE UPDATE ON improvement_candidates
      FOR EACH ROW WHEN (OLD.suppression_until IS NOT NULL AND NEW.suppression_until IS NULL)
      EXECUTE FUNCTION reject_review_suppression_clear();
    `);
    try {
      await expect(secondService.rejectImprovementCandidate(candidateId, input))
        .rejects.toThrow("injected suppression clear failure");
      expect((await firstService.getCuratorReviewItem(candidateId)).candidate).toEqual(review.candidate);
      expect(await decisionSignals(candidateId)).toEqual([]);
    } finally {
      await storage.db.exec("DROP TRIGGER reject_review_suppression_clear ON improvement_candidates; DROP FUNCTION reject_review_suppression_clear();");
    }
    const result = await secondService.rejectImprovementCandidate(candidateId, input);
    expect(result.status).toBe("rejected");
    const saved = await firstService.getCuratorReviewItem(candidateId);
    expect(saved.candidate.status).toBe("rejected");
    expect(saved.candidate.suppressionUntil).toBeUndefined();
    expect(await decisionSignals(candidateId)).toHaveLength(1);
  });
});

function makeService(storage: AsyncStorage): ImprovementService {
  const unused = async (): Promise<never> => { throw new Error("Unexpected side effect in reviewed-decision fixture"); };
  const callbacks: ImprovementServiceCallbacks = {
    createApproval: unused,
    captureRepairPolicySnapshot: unused, applyRepairPolicyCandidate: unused, restoreRepairPolicySnapshot: unused,
    captureRoutingPolicySnapshot: unused, applyRoutingPolicyCandidate: unused, restoreRoutingPolicySnapshot: unused,
    captureSkillRevisionSnapshot: unused, applySkillRevisionCandidate: unused, restoreSkillRevisionSnapshot: unused,
    createChatCompletion: unused, getPromptRunnerModelDefaults: async () => ({ providerId: "mock", model: "mock" }),
    readEffectiveBlockerTemplateStrictness: unused, readEffectiveRetryRepairThreshold: unused, readEffectiveLiveIntentThreshold: unused,
    readTranscriptOrEmpty: async () => [], retryChatTurn: unused, backgroundTasks: new Set(), closing: false,
  };
  return new ImprovementService({
    storage, publishRealtime: async () => undefined, requireFeatureEnabled: async () => undefined,
    isFeatureEnabled: async () => true, normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
  }, callbacks);
}
