import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "@goatcitadel/storage";
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

function createHarness(): Harness {
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
    storage,
    config: {} as never,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: storage.gatewaySql,
    publishRealtime: () => undefined,
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
  const harness: Harness = { rootDir, storage, service };
  harnesses.push(harness);
  return harness;
}

function seedSignals(service: ImprovementService, count: number): void {
  for (let index = 0; index < count; index += 1) {
    service.recordPromptLabRegressionCompletionSignal({
      regressionRunId: `regression-${index}`,
      packId: "pack-cache",
      capability: `cache-capability-${index}`,
      scoreDelta: -0.5,
      passDelta: -0.2,
      latencyDeltaMs: 10,
    });
  }
}

// Count how many times prepare() was invoked with a SQL string that matches the
// list query for a given table — i.e. a SELECT … ORDER BY against that table.
// (The per-row reconcile path issues its own single-row prepares against the
// same table without ORDER BY, so the ORDER BY clause isolates the list query.)
function countListPrepares(prepareSpy: ReturnType<typeof vi.spyOn>, table: string): number {
  return prepareSpy.mock.calls.filter((call) => {
    const sql = String(call[0]);
    return sql.includes(`FROM ${table}`) && sql.includes("ORDER BY");
  }).length;
}

describe("ImprovementService prepared-statement caching", () => {
  it("prepares the listImprovementSignals statement once across repeated calls", () => {
    const harness = createHarness();
    seedSignals(harness.service, 3);

    const prepareSpy = vi.spyOn(harness.storage.gatewaySql, "prepare");

    // First call compiles the statement; subsequent identical-shape calls must
    // reuse the cached one. Without caching this filtered count would be 3.
    const first = harness.service.listImprovementSignals(100);
    const second = harness.service.listImprovementSignals(100);
    const third = harness.service.listImprovementSignals(100);

    expect(countListPrepares(prepareSpy, "improvement_signals")).toBe(1);

    // Results are unchanged across calls.
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    prepareSpy.mockRestore();
  });

  it("prepares the listImprovementCandidates statement once across repeated calls", () => {
    const harness = createHarness();
    seedSignals(harness.service, 3);

    const prepareSpy = vi.spyOn(harness.storage.gatewaySql, "prepare");

    // First call materializes + compiles the list statement; later calls reuse it.
    // Without caching the filtered count would be 3.
    const first = harness.service.listImprovementCandidates(100);
    const second = harness.service.listImprovementCandidates(100);
    const third = harness.service.listImprovementCandidates(100);

    expect(countListPrepares(prepareSpy, "improvement_candidates")).toBe(1);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    prepareSpy.mockRestore();
  });

  it("caches workspace-filtered and unfiltered variants independently (one prepare each)", () => {
    const harness = createHarness();
    seedSignals(harness.service, 2);

    const prepareSpy = vi.spyOn(harness.storage.gatewaySql, "prepare");

    harness.service.listImprovementSignals(100);
    harness.service.listImprovementSignals(100);
    harness.service.listImprovementSignals(100, "prompt-lab");
    harness.service.listImprovementSignals(100, "prompt-lab");

    // Two distinct SQL variants → two prepares total, regardless of call count.
    expect(countListPrepares(prepareSpy, "improvement_signals")).toBe(2);

    prepareSpy.mockRestore();
  });
});
