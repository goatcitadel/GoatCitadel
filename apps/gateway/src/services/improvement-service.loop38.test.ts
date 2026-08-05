import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAsyncStorage, Storage } from "@goatcitadel/storage";
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
