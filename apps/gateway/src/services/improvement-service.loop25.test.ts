import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ApprovalRequest, DurableRunRecord, RealtimeEvent } from "@goatcitadel/contracts";
import {
  ImprovementService,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
} from "./improvement-service.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  published: Array<{
    channel: string;
    topic: string;
    payload: Record<string, unknown>;
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;
  }>;
  featureEnabled: boolean;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService loop25 runtime signals", () => {
  it("skips durable-run signal writes when the improvement ledger feature is disabled", async () => {
    const harness = await createHarness({ featureEnabled: false });

    const signal = await harness.service.recordDurableRunFailureSignal({
      run: createDurableRun({ runId: "run-disabled" }),
      message: "model provider failed",
    });

    expect(signal).toBeUndefined();
    expect(countRows(harness.storage, "improvement_signals")).toBe(0);
    expect(harness.published).toEqual([]);
  });

  it("persists durable-run failure details and returns the existing idempotent signal on retry", async () => {
    const harness = await createHarness();
    const run = createDurableRun({
      runId: "run-failed",
      workflowKey: "chat.turn",
      payload: {
        workspaceId: " ws-runtime ",
        sessionId: "sess-1",
        turnId: "turn-1",
      },
      updatedAt: "2026-05-15T04:00:00.000Z",
      finishedAt: "2026-05-15T04:01:00.000Z",
    });

    const first = await harness.service.recordDurableRunFailureSignal({
      run,
      message: "provider timeout persisted for operator review",
    });
    const second = await harness.service.recordDurableRunFailureSignal({
      run,
      message: "provider timeout persisted for operator review",
    });

    expect(first).toMatchObject({
      sourceService: "durable-run-service",
      sourceType: "durable_run",
      sourceId: "run-failed",
      workspaceId: "ws-runtime",
      signalKind: "durable_run_failed",
      outcome: "negative",
      severity: "medium",
      sessionId: "sess-1",
      turnId: "turn-1",
      durableRunId: "run-failed",
    });
    expect(second?.signalId).toBe(first?.signalId);
    expect(countRows(harness.storage, "improvement_signals")).toBe(1);

    const row = readSignalRow(harness.storage, first!.signalId);
    expect(JSON.parse(String(row.metadata_json))).toMatchObject({
      workflowKey: "chat.turn",
      lastError: "provider timeout persisted for operator review",
      payload: {
        workspaceId: " ws-runtime ",
        sessionId: "sess-1",
        turnId: "turn-1",
      },
    });
    expect(JSON.parse(String(row.evidence_refs_json))).toEqual([
      expect.objectContaining({
        refType: "durable_run",
        refId: "run-failed",
        hash: expect.any(String),
      }),
    ]);
  });

  it("records focused tool failures with durable-run evidence and trims optional workspace ids", async () => {
    const harness = await createHarness();

    const signal = await harness.service.recordFocusedToolFailureSignal({
      workspaceId: " ws-tools ",
      sessionId: "sess-tools",
      turnId: "turn-tools",
      durableRunId: "run-tools",
      toolName: "browser.search",
      providerId: "openai",
      model: "gpt-5.4",
      failureClass: "tool_provider_unavailable",
      operationPhase: "invoke",
      policyReason: "missing executor",
    });

    expect(signal).toMatchObject({
      workspaceId: "ws-tools",
      signalKind: "tool_provider_failure",
      toolName: "browser.search",
      durableRunId: "run-tools",
      outcome: "negative",
    });
    const stored = await harness.service.getImprovementSignal(signal!.signalId);
    expect(stored.metadata).toMatchObject({
      providerId: "openai",
      model: "gpt-5.4",
      failureClass: "tool_provider_unavailable",
      operationPhase: "invoke",
      policyReason: "missing executor",
    });
    expect(stored.evidenceRefs).toEqual([
      expect.objectContaining({
        refType: "durable_run",
        refId: "run-tools",
      }),
    ]);
  });

  it("persists approval resolution signals with approval linkage and human outcome", async () => {
    const harness = await createHarness();
    const approval = {
      approvalId: "approval-1",
      kind: "tool",
      status: "rejected",
      riskLevel: "high",
      createdAt: "2026-05-15T01:00:00.000Z",
      resolvedAt: "2026-05-15T01:05:00.000Z",
      payload: { toolName: "filesystem.write" },
      preview: { title: "Write file" },
      linkage: {
        workspaceId: "ws-approval",
        sessionId: "sess-approval",
        turnId: "turn-approval",
        durableRunId: "run-approval",
        taskId: "task-approval",
        toolName: "filesystem.write",
      },
    } as unknown as ApprovalRequest;

    const signal = await harness.service.recordApprovalResolutionSignal(approval);

    expect(signal).toMatchObject({
      sourceService: "gatehouse",
      signalClass: "approval",
      signalKind: "approval_resolution",
      origin: "human",
      outcome: "negative",
      workspaceId: "ws-approval",
      approvalId: "approval-1",
      taskId: "task-approval",
      toolName: "filesystem.write",
    });
    expect((await harness.service.getImprovementSignal(signal!.signalId)).metadata).toMatchObject({
      approvalKind: "tool",
      riskLevel: "high",
      status: "rejected",
    });
  });
});

async function createHarness(options: { featureEnabled?: boolean } = {}): Promise<Harness> {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-loop25-"));
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
  const harness = {
    rootDir,
    storage,
    service: undefined as unknown as ImprovementService,
    published,
    featureEnabled: options.featureEnabled ?? true,
  };
  const ctx: ImprovementServiceContext = {
    storage: createLocalAsyncStorage(storage),
    gatewaySql: storage.gatewaySql,
    publishRealtime: async (channel, topic, payload, realtimeOptions) => {
      published.push({ channel, topic, payload, options: realtimeOptions });
    },
    requireFeatureEnabled: (flag) => {
      if (!harness.featureEnabled) {
        throw new Error(`Feature disabled: ${String(flag)}`);
      }
    },
    isFeatureEnabled: () => harness.featureEnabled,
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

  harness.service = new ImprovementService(ctx, callbacks);
  await harness.service.initialize();
  harnesses.push(harness);
  return harness;
}

function createDurableRun(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
    runId: "run-1",
    workflowKey: "workflow",
    status: "failed",
    payload: {},
    checkpointState: {},
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:01:00.000Z",
    finishedAt: "2026-05-15T00:01:00.000Z",
    ...overrides,
  } as DurableRunRecord;
}

function countRows(storage: Storage, table: string): number {
  return Number(
    (storage.gatewaySql.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  );
}

function readSignalRow(storage: Storage, signalId: string): Record<string, unknown> {
  return storage.gatewaySql.prepare("SELECT * FROM improvement_signals WHERE signal_id = ?").get(signalId) as Record<
    string,
    unknown
  >;
}
