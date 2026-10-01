import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ImprovementCandidateReviewPrecondition } from "@goatcitadel/contracts";
import {
  ImprovementService,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
} from "./improvement-service.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  published: Array<{ channel: string; topic: string; payload: Record<string, unknown> }>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService loop38 curator lifecycle behavior", () => {
  it("lists curator review items, rejects candidates, and clears existing suppression", async () => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, "reject");
    await harness.service.snoozeImprovementCandidate(candidate.candidateId, {
      actorId: "operator-a",
      snoozeUntil: "2026-05-20T00:00:00.000Z",
      reason: "temporarily suppress before explicit rejection",
    });

    const rejected = await harness.service.rejectImprovementCandidate(candidate.candidateId, {
      actorId: "operator-b",
      reason: "not worth applying",
    });
    const detail = await harness.service.getImprovementCandidateDetail(candidate.candidateId);

    expect(rejected).toMatchObject({
      action: "reject",
      status: "rejected",
      mutationApplied: false,
    });
    expect(detail.candidate).toMatchObject({
      status: "rejected",
      suppressionUntil: undefined,
    });
    expect(
      (await harness.service.listCuratorReviewItems({ limit: 20 })).items.map((item) => item.candidate.candidateId),
    ).not.toContain(candidate.candidateId);
    expect(await harness.service.getCuratorReviewItem(candidate.candidateId)).toMatchObject({
      candidate: expect.objectContaining({
        candidateId: candidate.candidateId,
        status: "rejected",
      }),
      mutationApplied: false,
    });
    expect(
      (await harness.service.listImprovementSignals(20)).some(
        (signal) =>
          signal.signalKind === "candidate_rejected" &&
          signal.metadata.candidateId === candidate.candidateId &&
          signal.metadata.actorId === "operator-b",
      ),
    ).toBe(true);
  });

  it("snoozes candidates with default suppression windows and emits lifecycle audit signals", async () => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, "snooze");

    const snoozed = await harness.service.snoozeImprovementCandidate(candidate.candidateId, {
      actorId: "operator-snooze",
      reason: "wait for next benchmark",
    });
    const detail = await harness.service.getImprovementCandidateDetail(candidate.candidateId);

    expect(snoozed).toMatchObject({
      action: "snooze",
      status: "snoozed",
      mutationApplied: false,
    });
    expect(detail.candidate.status).toBe("rejected");
    expect(Date.parse(detail.candidate.suppressionUntil ?? "")).toBeGreaterThan(Date.now());
    expect(
      (await harness.service.listImprovementSignals(20)).some(
        (signal) =>
          signal.signalKind === "candidate_snoozed" &&
          signal.metadata.candidateId === candidate.candidateId &&
          signal.metadata.actorId === "operator-snooze",
      ),
    ).toBe(true);
  });
});

describe("ImprovementService reviewed decision bindings", () => {
  it.each(["approve", "reject"] as const)("binds %s to the owner-authored workspace and revision", async (action) => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, `bound-${action}`);
    const review = await harness.service.getCuratorReviewItem(candidate.candidateId);
    expect(review.reviewPrecondition).toEqual({ workspaceId: candidate.workspaceId, expectedStatus: candidate.status,
      expectedRevisionId: review.currentRevision?.revisionId, expectedChangeHash: review.currentRevision?.changeHash });
    const result = action === "approve"
      ? await harness.service.approveImprovementCandidate(candidate.candidateId, { reviewPrecondition: review.reviewPrecondition })
      : await harness.service.rejectImprovementCandidate(candidate.candidateId, { reviewPrecondition: review.reviewPrecondition });
    expect(result.status).toBe(action === "approve" ? "approved" : "rejected");
    expect(result.review.currentRevision?.changeHash).toBe(review.currentRevision?.changeHash);
    expect(result.mutationApplied).toBe(false);
  });

  it.each(["approve", "reject"] as const)("refuses stale or foreign %s review bindings without changing the candidate", async (action) => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, `stale-${action}`);
    const review = await harness.service.getCuratorReviewItem(candidate.candidateId);
    const binding = review.reviewPrecondition!;
    const changed: Partial<ImprovementCandidateReviewPrecondition>[] = [
      { workspaceId: "foreign-workspace" }, { expectedStatus: "proposed" },
      { expectedRevisionId: "old-revision" }, { expectedChangeHash: "old-hash" },
    ];
    for (const mismatch of changed) {
      const input = { reviewPrecondition: { ...binding, ...mismatch } };
      await expect(action === "approve"
        ? harness.service.approveImprovementCandidate(candidate.candidateId, input)
        : harness.service.rejectImprovementCandidate(candidate.candidateId, input)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
      expect((await harness.service.getCuratorReviewItem(candidate.candidateId)).candidate).toEqual(review.candidate);
    }
    expect((await harness.service.listImprovementSignals(100)).filter((signal) =>
      signal.signalKind === (action === "approve" ? "candidate_approved" : "candidate_rejected"))).toHaveLength(0);
  });

  it("serializes concurrent decisions so the second reviewed status cannot overwrite the first", async () => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, "concurrent-review");
    const review = await harness.service.getCuratorReviewItem(candidate.candidateId);
    const input = { reviewPrecondition: review.reviewPrecondition };
    const attempts = await Promise.allSettled([
      harness.service.approveImprovementCandidate(candidate.candidateId, input),
      harness.service.rejectImprovementCandidate(candidate.candidateId, input),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const conflict = attempts.find((result) => result.status === "rejected");
    expect(conflict && conflict.status === "rejected" ? conflict.reason : undefined).toMatchObject({ code: "WRITE_CONFLICT" });
    const saved = await harness.service.getCuratorReviewItem(candidate.candidateId);
    expect(saved.candidate.status).toBe("approved");
    expect((await harness.service.listImprovementSignals(100)).filter((signal) =>
      ["candidate_approved", "candidate_rejected"].includes(signal.signalKind))).toHaveLength(1);
  });

  it("allows an explicitly bound rejection of a candidate with no revision", async () => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, "without-revision");
    harness.storage.db.prepare("UPDATE improvement_candidates SET current_revision_id = NULL WHERE candidate_id = ?").run(candidate.candidateId);
    const review = await harness.service.getCuratorReviewItem(candidate.candidateId);
    expect(review.reviewPrecondition).toMatchObject({ expectedRevisionId: null, expectedChangeHash: null });
    expect(await harness.service.rejectImprovementCandidate(candidate.candidateId,
      { reviewPrecondition: review.reviewPrecondition })).toMatchObject({ status: "rejected" });
  });

  it("requires the passed evaluation hash to match the approved revision", async () => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, "evaluation-hash");
    harness.storage.db.prepare("UPDATE improvement_evaluations SET change_hash = 'wrong-hash' WHERE candidate_id = ?").run(candidate.candidateId);
    const before = await harness.service.getCuratorReviewItem(candidate.candidateId);
    expect(before.actionStatuses.approve).toBe("blocked");
    expect(before.disabledReasons.approve).toMatch(/must pass validation/);
    await expect(harness.service.approveImprovementCandidate(candidate.candidateId,
      { reviewPrecondition: before.reviewPrecondition })).rejects.toThrow(/must pass validation/);
    expect((await harness.service.getCuratorReviewItem(candidate.candidateId)).candidate).toEqual(before.candidate);
  });

  it.each([
    ["approve", "review"], ["approve", "audit"], ["reject", "review"], ["reject", "audit"],
  ] as const)("preserves the committed %s decision when %s delivery fails", async (action, failurePoint) => {
    const harness = await createHarness();
    const candidate = await createRoutingCandidate(harness.service, `committed-${action}-${failurePoint}`);
    const review = await harness.service.getCuratorReviewItem(candidate.candidateId);
    const cause = new Error(`${failurePoint} unavailable`);
    if (failurePoint === "review") {
      vi.spyOn(harness.service, "getCuratorReviewItem").mockRejectedValueOnce(cause);
    } else {
      vi.spyOn(harness.published, "push").mockImplementationOnce(() => { throw cause; });
    }
    const input = { reviewPrecondition: review.reviewPrecondition };
    const status = action === "approve" ? "approved" : "rejected";
    await expect(action === "approve"
      ? harness.service.approveImprovementCandidate(candidate.candidateId, input)
      : harness.service.rejectImprovementCandidate(candidate.candidateId, input)).rejects.toMatchObject({
      name: "ImprovementCandidateDecisionPostCommitError", mutationCommitted: true, cause,
      canonicalResult: { candidateId: candidate.candidateId, workspaceId: candidate.workspaceId, status,
        currentRevisionId: review.currentRevision?.revisionId, changeHash: review.currentRevision?.changeHash },
    });
    const saved = await harness.service.getImprovementCandidateDetail(candidate.candidateId);
    expect(saved.candidate.status).toBe(status);
    expect(saved.currentRevision).toEqual(review.currentRevision);
  });
});

async function createHarness(): Promise<Harness> {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-loop38-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir,
    auditDir,
  });
  const published: Harness["published"] = [];
  const ctx: ImprovementServiceContext = {
    storage: createLocalAsyncStorage(storage),
    gatewaySql: storage.gatewaySql,
    publishRealtime: async (channel, topic, payload) => {
      published.push({ channel, topic, payload });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks: ImprovementServiceCallbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn(),
    applyRepairPolicyCandidate: vi.fn(),
    restoreRepairPolicySnapshot: vi.fn(),
    captureRoutingPolicySnapshot: vi.fn(),
    applyRoutingPolicyCandidate: vi.fn(),
    restoreRoutingPolicySnapshot: vi.fn(),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;
  const service = new ImprovementService(ctx, callbacks);
  await service.initialize();
  const harness: Harness = {
    rootDir,
    storage,
    service,
    published,
  };
  harnesses.push(harness);
  return harness;
}

async function createRoutingCandidate(service: ImprovementService, suffix: string) {
  await service.recordPromptLabRegressionCompletionSignal({
    regressionRunId: `regression-loop38-${suffix}`,
    packId: "pack-routing",
    capability: `provider-balance-${suffix}`,
    scoreDelta: -0.6,
    passDelta: -0.2,
    latencyDeltaMs: 35,
  });
  const candidate = (await service.listImprovementCandidates(20, "prompt-lab")).find(
    (item) => item.targetKey === `pack-routing:provider-balance-${suffix}`,
  );
  expect(candidate).toBeDefined();
  return candidate!;
}
