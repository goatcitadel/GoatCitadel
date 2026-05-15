import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { DurableRunRecord } from "@goatcitadel/contracts";
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

describe("ImprovementService loop37 signal persistence", () => {
  it("persists durable completion signals with checkpoint workspace fallback and idempotent reads", () => {
    const harness = createHarness();
    const run = createDurableRun({
      runId: "run-completed-loop37",
      status: "completed",
      workflowKey: "chat.turn",
      payload: {
        sessionId: "sess-loop37",
        turnId: "turn-loop37",
      },
      updatedAt: "2026-05-15T12:00:00.000Z",
      finishedAt: "2026-05-15T12:01:00.000Z",
    });
    const checkpointState = {
      workspaceId: " ws-checkpoint ",
      phase: "final",
      toolCount: 2,
    };

    const first = harness.service.recordDurableRunCompletionSignal({ run, checkpointState });
    const second = harness.service.recordDurableRunCompletionSignal({ run, checkpointState });
    const row = readSignalRow(harness.storage, first!.signalId);

    expect(second?.signalId).toBe(first?.signalId);
    expect(first).toMatchObject({
      sourceService: "durable-run-service",
      sourceType: "durable_run",
      sourceId: "run-completed-loop37",
      workspaceId: "ws-checkpoint",
      signalKind: "durable_run_completed",
      outcome: "positive",
      sessionId: "sess-loop37",
      turnId: "turn-loop37",
      durableRunId: "run-completed-loop37",
    });
    expect(JSON.parse(String(row.metadata_json))).toMatchObject({
      workflowKey: "chat.turn",
      payload: {
        sessionId: "sess-loop37",
        turnId: "turn-loop37",
      },
      checkpointState,
    });
    expect(JSON.parse(String(row.evidence_refs_json))).toEqual([
      expect.objectContaining({
        refType: "durable_run",
        refId: "run-completed-loop37",
        hash: expect.any(String),
      }),
    ]);
  });

  it("records prompt-lab benchmark positives and negatives with persisted routing metadata", () => {
    const harness = createHarness();

    const positive = harness.service.recordPromptLabBenchmarkCompletionSignal({
      benchmarkRunId: "bench-loop37-positive",
      packId: "pack-routing",
      providerId: "openai",
      model: "gpt-5.4",
      weightedScore: 91,
      passRate: 0.95,
      runFailures: 0,
    });
    const negative = harness.service.recordPromptLabBenchmarkCompletionSignal({
      benchmarkRunId: "bench-loop37-negative",
      packId: "pack-routing",
      providerId: "openai",
      model: "gpt-5.4-mini",
      weightedScore: 52,
      passRate: 0.5,
      runFailures: 3,
      failureSignal: "no assistant output",
    });
    const negativeAgain = harness.service.recordPromptLabBenchmarkCompletionSignal({
      benchmarkRunId: "bench-loop37-negative",
      packId: "pack-routing",
      providerId: "openai",
      model: "gpt-5.4-mini",
      weightedScore: 52,
      passRate: 0.5,
      runFailures: 3,
      failureSignal: "no assistant output",
    });

    expect(positive).toMatchObject({
      workspaceId: "prompt-lab",
      signalKind: "prompt_lab_benchmark_completed",
      outcome: "positive",
      severity: "low",
      scoreDelta: 91,
    });
    expect(negative).toMatchObject({
      workspaceId: "prompt-lab",
      signalKind: "prompt_lab_benchmark_completed",
      outcome: "negative",
      severity: "medium",
      scoreDelta: 52,
    });
    expect(negativeAgain?.signalId).toBe(negative?.signalId);

    const storedNegative = harness.service.getImprovementSignal(negative!.signalId);
    expect(storedNegative.metadata).toMatchObject({
      packId: "pack-routing",
      targetKey: "pack-routing:openai:gpt-5.4-mini",
      causeClass: "benchmark_failures",
      providerId: "openai",
      model: "gpt-5.4-mini",
      passRate: 0.5,
      runFailures: 3,
      failureSignal: "no assistant output",
    });
    expect(harness.service.listImprovementSignals(10, "prompt-lab").map((signal) => signal.signalId)).toEqual(
      expect.arrayContaining([positive!.signalId, negative!.signalId]),
    );
  });
});

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-loop37-"));
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
    storage,
    gatewaySql: storage.gatewaySql,
    publishRealtime: (channel, topic, payload) => {
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
  const harness: Harness = {
    rootDir,
    storage,
    service: new ImprovementService(ctx, callbacks),
    published,
  };
  harnesses.push(harness);
  return harness;
}

function createDurableRun(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
    runId: "run-loop37",
    workflowKey: "workflow",
    status: "completed",
    payload: {},
    checkpointState: {},
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:01:00.000Z",
    finishedAt: "2026-05-15T12:01:00.000Z",
    ...overrides,
  } as DurableRunRecord;
}

function readSignalRow(storage: Storage, signalId: string): Record<string, unknown> {
  return storage.gatewaySql.prepare("SELECT * FROM improvement_signals WHERE signal_id = ?").get(signalId) as Record<
    string,
    unknown
  >;
}
