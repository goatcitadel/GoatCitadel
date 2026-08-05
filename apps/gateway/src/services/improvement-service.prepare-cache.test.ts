import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalAsyncStorage, Storage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";
import {
  readBlockerTemplateStrictness,
  readLiveIntentThreshold,
  readRetryRepairThreshold,
} from "./improvement-tune-reads.js";
import type { ServiceContext } from "./service-context.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

async function createHarness(): Promise<Harness> {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-prepare-cache-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });

  const storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir,
    auditDir,
  });
  const ctx: ServiceContext = {
    storage: createLocalAsyncStorage(storage),
    config: {} as never,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: storage.gatewaySql,
    publishRealtime: async () => undefined,
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
    createChatCompletion: vi.fn(async () => ({ id: "mock", choices: [] }) as never),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readEffectiveBlockerTemplateStrictness: () => readBlockerTemplateStrictness(storage.systemSettings),
    readEffectiveRetryRepairThreshold: () => readRetryRepairThreshold(storage.systemSettings),
    readEffectiveLiveIntentThreshold: () => readLiveIntentThreshold(storage.systemSettings),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(async () => ({ sessionId: "retry-session", turnId: "retry-turn" }) as never),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  };

  const service = new ImprovementService(ctx, callbacks);
  await service.initialize();
  const harness: Harness = { rootDir, storage, service };
  harnesses.push(harness);
  return harness;
}

async function seedSignals(service: ImprovementService, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await service.recordPromptLabRegressionCompletionSignal({
      regressionRunId: `regression-${index}`,
      packId: "pack-cache",
      capability: `cache-capability-${index}`,
      scoreDelta: -0.5,
      passDelta: -0.2,
      latencyDeltaMs: 10,
    });
  }
}

function preparedCacheSize(service: ImprovementService): number {
  return (service as unknown as { preparedCache: Map<string, unknown> }).preparedCache.size;
}

describe("ImprovementService prepared-statement caching", () => {
  it("prepares the listImprovementSignals statement once across repeated calls", async () => {
    const harness = await createHarness();
    await seedSignals(harness.service, 3);

    // First call retains the async statement handle; subsequent identical-shape
    // calls reuse it. The local async adapter intentionally prepares the native
    // SQLite statement at execution time, so the service-owned cache is the
    // authoritative boundary to assert here.
    const first = await harness.service.listImprovementSignals(100);
    const second = await harness.service.listImprovementSignals(100);
    const third = await harness.service.listImprovementSignals(100);

    expect(preparedCacheSize(harness.service)).toBe(1);

    // Results are unchanged across calls.
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("prepares the listImprovementCandidates statement once across repeated calls", async () => {
    const harness = await createHarness();
    await seedSignals(harness.service, 3);

    // First call materializes the async list handle; later calls reuse it.
    const first = await harness.service.listImprovementCandidates(100);
    const second = await harness.service.listImprovementCandidates(100);
    const third = await harness.service.listImprovementCandidates(100);

    expect(preparedCacheSize(harness.service)).toBe(1);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("caches workspace-filtered and unfiltered variants independently (one prepare each)", async () => {
    const harness = await createHarness();
    await seedSignals(harness.service, 2);

    await harness.service.listImprovementSignals(100);
    await harness.service.listImprovementSignals(100);
    await harness.service.listImprovementSignals(100, "prompt-lab");
    await harness.service.listImprovementSignals(100, "prompt-lab");

    // Two distinct SQL variants → two prepares total, regardless of call count.
    expect(preparedCacheSize(harness.service)).toBe(2);
  });
});
