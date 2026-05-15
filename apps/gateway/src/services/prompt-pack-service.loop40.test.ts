import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { ChatTurnTraceRecord, PromptPackRunRecord, PromptPackTestRecord } from "@goatcitadel/contracts";
import { PromptPackService } from "./prompt-pack-service.js";
import { createPack, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

interface Harness {
  rootDir: string;
  service: PromptPackService;
  agentSendChatMessage: ReturnType<typeof vi.fn>;
  createdRuns: PromptPackRunRecord[];
  patchedRuns: PromptPackRunRecord[];
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("PromptPackService loop40 run outcome persistence", () => {
  it.each([
    {
      name: "approval wait",
      trace: { status: "waiting_for_approval" as const },
      expectedStatus: "approval_paused" as const,
      expectedError: "Turn paused for approval.",
    },
    {
      name: "user input wait",
      trace: { status: "waiting_for_user_input" as const },
      expectedStatus: "approval_paused" as const,
      expectedError: "Turn paused for user input.",
    },
    {
      name: "failed trace",
      trace: { status: "failed" as const },
      expectedStatus: "failed" as const,
      expectedError: "Assistant turn finished in failed state.",
    },
    {
      name: "cancelled trace",
      trace: { status: "cancelled" as const },
      expectedStatus: "failed" as const,
      expectedError: "Assistant turn finished in failed state.",
    },
    {
      name: "failed durable run",
      trace: { status: "completed" as const, durable: { status: "failed" as const } },
      expectedStatus: "failed" as const,
      expectedError: "Durable execution finished in failed state.",
    },
  ])("persists $name prompt-pack runs with diagnostic status and retained output", async (scenario) => {
    const harness = createHarness({
      traceOverride: scenario.trace,
      assistantContent: `Output retained for ${scenario.name}.`,
    });

    const run = await harness.service.runPromptPackTest("pack-1", "test-loop40");

    expect(run).toMatchObject({
      status: scenario.expectedStatus,
      error: scenario.expectedError,
      responseText: `Output retained for ${scenario.name}.`,
    });
    expect(harness.createdRuns).toHaveLength(1);
    expect(harness.patchedRuns.at(-1)).toMatchObject({
      status: scenario.expectedStatus,
      error: scenario.expectedError,
      responseText: `Output retained for ${scenario.name}.`,
    });
  });

  it("persists agent execution errors as failed prompt-pack runs without reraising", async () => {
    const harness = createHarness({
      agentError: new Error("provider overloaded during prompt-pack run"),
    });

    const run = await harness.service.runPromptPackTest("pack-1", "test-loop40");

    expect(run).toMatchObject({
      status: "failed",
      error: "provider overloaded during prompt-pack run",
    });
    expect(harness.createdRuns).toHaveLength(1);
    expect(harness.patchedRuns.at(-1)).toMatchObject({
      status: "failed",
      error: "provider overloaded during prompt-pack run",
    });
  });

  it("records benchmark items for paused and failed prompt-pack runs with summarized failure signals", async () => {
    const harness = createBenchmarkHarness();

    await (
      harness.service as unknown as {
        runPromptPackBenchmarkTask: (benchmarkRunId: string) => Promise<void>;
      }
    ).runPromptPackBenchmarkTask("ppb-loop40");

    expect(harness.benchmarkRun.completed_items).toBe(1);
    expect(harness.benchmarkItems).toEqual([
      expect.objectContaining({
        test_code: "TEST-L40-PAUSE",
        run_status: "approval_paused",
        failure_signal: "Turn paused for approval.",
      }),
    ]);
  });
});

function createHarness(input: {
  traceOverride?: Partial<ChatTurnTraceRecord>;
  assistantContent?: string;
  agentError?: Error;
}): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-prompt-pack-loop40-"));
  const pack = createPack("pack-1");
  const test: PromptPackTestRecord = {
    ...createTest("test-loop40", "TEST-L40"),
    mode: "chat",
    toolTier: "no-tools",
    prompt: "Explain the runtime fallback result.",
  };
  const createdRuns: PromptPackRunRecord[] = [];
  const patchedRuns: PromptPackRunRecord[] = [];
  const agentSendChatMessage = vi.fn(async (sessionId: string) => {
    if (input.agentError) {
      throw input.agentError;
    }
    const content = input.assistantContent ?? "Prompt-pack loop40 output.";
    return {
      turnId: `turn-${sessionId}`,
      assistantMessage: {
        messageId: `assistant-${sessionId}`,
        sessionId,
        role: "assistant",
        content,
        createdAt: "2026-05-15T00:00:00.000Z",
      },
      trace: createTrace(sessionId, {
        turnId: `turn-${sessionId}`,
        ...input.traceOverride,
      }),
      citations: [],
    };
  });
  const service = new PromptPackService(
    {
      storage: {
        promptPacks: {
          getPack: () => pack,
          getTest: () => test,
          listTests: () => [test],
        },
        promptPackRuns: {
          create: (run: PromptPackRunRecord) => {
            createdRuns.push(run);
            return run;
          },
          patch: (runId: string, patch: Partial<PromptPackRunRecord>) => {
            const base = createdRuns.find((item) => item.runId === runId);
            if (!base) {
              throw new Error(`missing run ${runId}`);
            }
            const updated = { ...base, ...patch } as PromptPackRunRecord;
            patchedRuns.push(updated);
            return updated;
          },
          listByPack: () => patchedRuns,
        },
        promptPackScores: {
          listByPack: () => [],
        },
        promptPackAutoScoresV2: {
          listByPack: () => [],
        },
        promptPackHumanReviewsV2: {
          listByPack: () => [],
        },
        toolGrants: {
          list: () => [],
          create: vi.fn(),
        },
      },
      gatewaySql: {
        prepare: () => ({
          get: () => undefined,
          all: () => [],
        }),
      },
      config: {
        rootDir,
        assistant: {
          workspaceDir: "workspace",
          durable: {
            enabled: true,
            executionEnabled: true,
            chatAutoPromoteEnabled: true,
          },
        },
      },
      normalizeWorkspaceId: () => "default",
      isFeatureEnabled: (key: string) => key === "durableKernelV1Enabled",
      requireFeatureEnabled: () => undefined,
      publishRealtime: () => undefined,
    } as never,
    {
      createChatSession: vi.fn(() => ({ sessionId: "sess-loop40" })),
      agentSendChatMessage,
      createChatCompletion: vi.fn(),
      getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      backgroundTasks: new Set(),
    },
  );
  const harness = {
    rootDir,
    service,
    agentSendChatMessage,
    createdRuns,
    patchedRuns,
  };
  harnesses.push(harness);
  return harness;
}

function createBenchmarkHarness(): Harness & {
  benchmarkRun: Record<string, unknown>;
  benchmarkItems: Array<Record<string, unknown>>;
  published: Array<{ channel: string; topic: string; payload: Record<string, unknown> }>;
  benchmarkSignals: Array<Record<string, unknown>>;
} {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-prompt-pack-loop40-benchmark-"));
  const pack = createPack("pack-1");
  const tests: PromptPackTestRecord[] = [
    {
      ...createTest("test-loop40-pause", "TEST-L40-PAUSE"),
      mode: "chat",
      toolTier: "no-tools",
      prompt: "Pause for approval.",
    },
  ];
  const benchmarkRun: Record<string, unknown> = {
    benchmark_run_id: "ppb-loop40",
    pack_id: "pack-1",
    status: "queued",
    test_codes_json: JSON.stringify(tests.map((test) => test.code)),
    providers_json: JSON.stringify([{ providerId: "openai", model: "gpt-5.4" }]),
    total_items: 1,
    completed_items: 0,
    claimed_by_worker_id: null,
    claim_heartbeat_at: null,
    claim_expires_at: null,
    execution_style: "chat_surface",
    error: null,
    started_at: "2026-05-15T00:00:00.000Z",
    finished_at: null,
  };
  const benchmarkItems: Array<Record<string, unknown>> = [];
  const createdRuns: PromptPackRunRecord[] = [];
  const patchedRuns: PromptPackRunRecord[] = [];
  const published: Array<{ channel: string; topic: string; payload: Record<string, unknown> }> = [];
  const benchmarkSignals: Array<Record<string, unknown>> = [];
  const agentSendChatMessage = vi.fn(async (sessionId: string, request: { content: string }) => {
    const content = request.content.includes("Pause for approval")
      ? "Approval is required before continuing."
      : "Prompt-pack benchmark output.";
    return {
      turnId: `turn-${sessionId}`,
      assistantMessage: {
        messageId: `assistant-${sessionId}`,
        sessionId,
        role: "assistant",
        content,
        createdAt: "2026-05-15T00:00:00.000Z",
      },
      trace: createTrace(sessionId, {
        turnId: `turn-${sessionId}`,
        status: "waiting_for_approval",
      }),
      citations: [],
    };
  });
  const service = new PromptPackService(
    {
      storage: {
        promptPacks: {
          getPack: () => pack,
          getTest: (testId: string) => tests.find((test) => test.testId === testId) ?? tests[0],
          listTests: () => tests,
        },
        promptPackRuns: {
          create: (run: PromptPackRunRecord) => {
            createdRuns.push(run);
            return run;
          },
          patch: (runId: string, patch: Partial<PromptPackRunRecord>) => {
            const base = createdRuns.find((item) => item.runId === runId);
            if (!base) {
              throw new Error(`missing run ${runId}`);
            }
            const updated = { ...base, ...patch } as PromptPackRunRecord;
            patchedRuns.push(updated);
            return updated;
          },
          listByPack: () => patchedRuns,
        },
        promptPackScores: {
          listByPack: () => [],
        },
        promptPackAutoScoresV2: {
          listByPack: () => [],
        },
        promptPackHumanReviewsV2: {
          listByPack: () => [],
        },
        toolGrants: {
          list: () => [],
          create: vi.fn(),
        },
      },
      gatewaySql: {
        prepare: (sql: string) => ({
          get: () => (sql.includes("FROM prompt_pack_benchmark_runs") ? benchmarkRun : undefined),
          all: () => {
            if (sql.includes("FROM prompt_pack_benchmark_items")) {
              return benchmarkItems;
            }
            return [];
          },
          run: (params: Record<string, unknown> = {}) => {
            if (sql.includes("status = 'completed'")) {
              benchmarkRun.status = "completed";
              benchmarkRun.finished_at = params.finishedAt;
              benchmarkRun.claimed_by_worker_id = null;
              benchmarkRun.claim_heartbeat_at = null;
              benchmarkRun.claim_expires_at = null;
              return { changes: 1 };
            }
            if (sql.includes("UPDATE prompt_pack_benchmark_runs") && sql.includes("status = 'running'")) {
              benchmarkRun.status = "running";
              benchmarkRun.error = null;
              benchmarkRun.completed_items = params.completedItems ?? benchmarkRun.completed_items;
              benchmarkRun.claimed_by_worker_id = params.workerId;
              benchmarkRun.claim_heartbeat_at = params.now;
              benchmarkRun.claim_expires_at = params.claimExpiresAt;
              return { changes: 1 };
            }
            if (sql.includes("SET claim_heartbeat_at")) {
              benchmarkRun.claim_heartbeat_at = params.now;
              benchmarkRun.claim_expires_at = params.claimExpiresAt;
              return { changes: 1 };
            }
            if (sql.includes("INSERT INTO prompt_pack_benchmark_items")) {
              const existingIndex = benchmarkItems.findIndex(
                (item) =>
                  item.benchmark_run_id === params.benchmarkRunId &&
                  item.provider_id === params.providerId &&
                  item.model === params.model &&
                  item.test_id === params.testId,
              );
              const item = {
                item_id: params.itemId,
                benchmark_run_id: params.benchmarkRunId,
                pack_id: params.packId,
                test_id: params.testId,
                test_code: params.testCode,
                provider_id: params.providerId,
                model: params.model,
                run_id: params.runId,
                score_id: params.scoreId,
                auto_score_id: params.autoScoreId,
                run_status: params.runStatus,
                total_score: params.totalScore,
                weighted_score: params.weightedScore,
                verdict: params.verdict,
                score_state: params.scoreState,
                failure_signal: params.failureSignal,
                created_at: params.createdAt,
              };
              if (existingIndex >= 0) {
                benchmarkItems[existingIndex] = item;
              } else {
                benchmarkItems.push(item);
              }
              return { changes: 1 };
            }
            if (sql.includes("SET completed_items = @completedItems")) {
              benchmarkRun.completed_items = params.completedItems;
              return { changes: 1 };
            }
            return { changes: 1 };
          },
        }),
      },
      config: {
        rootDir,
        assistant: {
          workspaceDir: "workspace",
          durable: {
            enabled: true,
            executionEnabled: true,
            chatAutoPromoteEnabled: true,
          },
        },
      },
      normalizeWorkspaceId: () => "default",
      isFeatureEnabled: (key: string) => key === "durableKernelV1Enabled",
      requireFeatureEnabled: () => undefined,
      publishRealtime: (channel: string, topic: string, payload: Record<string, unknown>) => {
        published.push({ channel, topic, payload });
      },
    } as never,
    {
      createChatSession: vi.fn(() => ({ sessionId: `sess-loop40-${createdRuns.length + 1}` })),
      agentSendChatMessage,
      createChatCompletion: vi.fn(),
      getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      recordImprovementBenchmarkSignal: (signal: Record<string, unknown>) => {
        benchmarkSignals.push(signal);
      },
      backgroundTasks: new Set(),
    },
  );
  const harness = {
    rootDir,
    service,
    agentSendChatMessage,
    createdRuns,
    patchedRuns,
    benchmarkRun,
    benchmarkItems,
    published,
    benchmarkSignals,
  };
  harnesses.push(harness);
  return harness;
}
