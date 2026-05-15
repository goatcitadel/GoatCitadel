import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { PromptPackRunRecord, PromptPackScoreRecordV3, PromptPackTestRecord } from "@goatcitadel/contracts";
import { PromptPackService } from "./prompt-pack-service.js";
import { createPack, createRun, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PromptPackService loop44 scoring and benchmark watchdog behavior", () => {
  it("persists v3 auto-scores with deterministic caps for missing tools, evidence, and JSON output", async () => {
    const pack = createPack("pack-loop44");
    const test: PromptPackTestRecord = {
      ...createTest("test-loop44-v3", "TEST-L44-V3"),
      packId: pack.packId,
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use a web lookup to inspect the current official source, cite exact file evidence with line numbers, and return one JSON object only.",
    };
    const run: PromptPackRunRecord = {
      ...createRun("run-loop44-v3", "completed", "2026-05-15T00:00:02.000Z"),
      packId: pack.packId,
      testId: test.testId,
      mode: "code",
      toolTier: "explicit-tools",
      toolAutonomy: "safe_auto",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "extended",
      responseText:
        "I inspected the repository and found the issue, but the browser tool was unavailable. The safest next step is to retry with an enabled browser profile and then cite the exact evidence before making any runtime claim.",
      trace: createTrace("sess-loop44", {
        turnId: "turn-loop44",
        mode: "code",
        toolRuns: [],
        completion: {
          status: "complete",
          finishReason: "stop",
        },
      }),
      citations: [],
      integrity: {
        validationStatus: "valid",
        signals: [],
        completionStatus: "complete",
        finishReason: "stop",
      },
    };
    const createdScores: PromptPackScoreRecordV3[] = [];
    const service = createAutoScoreService({
      pack,
      test,
      run,
      createAutoScore: (score) => {
        createdScores.push(score as PromptPackScoreRecordV3);
        return score;
      },
    });

    const result = await service.autoScorePromptPackTest({
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      force: true,
      scoringSchemaVersion: "v3",
    });

    expect(createdScores).toHaveLength(1);
    expect(result.score).toBe(createdScores[0]);
    expect(result.score).toMatchObject({
      scoringSchemaVersion: "v3",
      judgeStatus: "valid",
      autoVerdict: "fail",
      attribution: expect.objectContaining({
        primary: "missing_tool",
      }),
    });
    expect(result.score.protocol.reasonCodes).toEqual(
      expect.arrayContaining([
        "tool_tier_violation",
        "unsupported_access_claim",
        "missing_required_json",
        "missing_required_citation_evidence",
      ]),
    );
    expect(result.score.hardFailReasons).toEqual(
      expect.arrayContaining(["tool_tier_violation", "missing_required_citation_evidence"]),
    );
    expect(result.score.mergeProvenance.toolUseQuality?.caps).toContain("tool_tier_violation");
    expect(result.score.mergeProvenance.formatAdherence?.caps).toContain("missing_required_json");
    expect(result.score.mergeProvenance.evidenceGrounding?.caps).toEqual(
      expect.arrayContaining(["unsupported_access_claim", "missing_required_citation_evidence"]),
    );
    expect(result.score.finalScores.toolUseQuality).toBeLessThanOrEqual(1);
    expect(result.score.finalScores.evidenceGrounding).toBeLessThanOrEqual(1);
  });

  it("aborts benchmark execution when the heartbeat observes a cancelled run", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-15T00:00:00.000Z") });
    const service = createHeartbeatService({
      benchmarkRow: {
        benchmark_run_id: "ppb-loop44",
        pack_id: "pack-loop44",
        status: "cancelled",
        test_codes_json: "[]",
        providers_json: "[]",
        total_items: 1,
        completed_items: 0,
        claimed_by_worker_id: "worker-other",
        claim_heartbeat_at: null,
        claim_expires_at: null,
        execution_style: null,
        error: null,
        started_at: "2026-05-15T00:00:00.000Z",
        finished_at: null,
      },
    });
    let observedAbort: unknown;

    const execution = (
      service as unknown as {
        executeWithBenchmarkClaimHeartbeat: <T>(
          benchmarkRunId: string,
          execute: (signal: AbortSignal) => Promise<T>,
        ) => Promise<T>;
      }
    ).executeWithBenchmarkClaimHeartbeat("ppb-loop44", async (signal) => {
      signal.addEventListener("abort", () => {
        observedAbort = signal.reason;
      });
      return new Promise<string>(() => undefined);
    });

    const rejection = expect(execution).rejects.toThrow(/was cancelled/);
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(observedAbort).toBeInstanceOf(Error);
    expect((observedAbort as Error).message).toMatch(/was cancelled/);
  });
});

function createAutoScoreService(input: {
  pack: ReturnType<typeof createPack>;
  test: PromptPackTestRecord;
  run: PromptPackRunRecord;
  createAutoScore: (score: PromptPackScoreRecordV3) => PromptPackScoreRecordV3;
}): PromptPackService {
  const service = new PromptPackService(
    {
      storage: {
        promptPacks: {
          getPack: () => input.pack,
          getTest: () => input.test,
          listTests: () => [input.test],
        },
        promptPackRuns: {
          listByTest: () => [input.run],
          get: () => input.run,
          listByPack: () => [input.run],
        },
        promptPackAutoScoresV2: {
          listByRun: () => [],
          create: input.createAutoScore,
          listByPack: () => [],
        },
        promptPackScores: {
          listByRun: () => [],
          listByPack: () => [],
        },
        promptPackHumanReviewsV2: {
          listByPack: () => [],
        },
      },
      gatewaySql: {} as never,
      config: {
        rootDir: "F:/code/personal-ai",
        assistant: {
          workspaceDir: ".",
          durable: {
            enabled: true,
            executionEnabled: true,
            chatAutoPromoteEnabled: true,
          },
        },
      } as never,
      normalizeWorkspaceId: () => "default",
      isFeatureEnabled: () => true,
      requireFeatureEnabled: () => undefined,
      publishRealtime: () => undefined,
    } as never,
    {
      createChatSession: vi.fn(),
      agentSendChatMessage: vi.fn(),
      createChatCompletion: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"The answer is fluent, but deterministic checks own protocol failures."}',
            },
            finish_reason: "stop",
          },
        ],
      })),
      getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      backgroundTasks: new Set(),
    },
  );
  vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);
  return service;
}

function createHeartbeatService(input: { benchmarkRow: Record<string, unknown> }): PromptPackService {
  return new PromptPackService(
    {
      storage: {},
      gatewaySql: {
        prepare: (sql: string) => ({
          get: () => (sql.includes("SELECT") ? input.benchmarkRow : undefined),
          run: () => ({ changes: 0 }),
          all: () => [],
        }),
      },
      config: {
        assistant: {
          durable: {
            enabled: true,
            executionEnabled: true,
            chatAutoPromoteEnabled: true,
          },
        },
      },
      normalizeWorkspaceId: () => "default",
      isFeatureEnabled: () => true,
      requireFeatureEnabled: () => undefined,
      publishRealtime: () => undefined,
    } as never,
    {
      createChatSession: vi.fn(),
      agentSendChatMessage: vi.fn(),
      createChatCompletion: vi.fn(),
      getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
      backgroundTasks: new Set(),
    },
  );
}
