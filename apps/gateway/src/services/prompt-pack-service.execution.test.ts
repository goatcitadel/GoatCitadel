import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type {
  PromptPackAutoScoreRecord,
  PromptPackBenchmarkStatusRecord,
  PromptPackHumanReviewRecordV2,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  PromptPackService,
  pickPromptPackAutoScoreRun,
  promptPackExecutionRequiresDurable,
  ensurePromptPackDurableReadiness,
} from "./prompt-pack-service.js";
import {
  buildPromptPackMarkdown,
  createPromptPackExportService,
  createPack,
  createRun,
  createScore,
  createTest,
  createTrace,
} from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack execution, benchmarks, and durable snapshots", () => {
  it("treats shipped chat, cowork, and code prompt-pack runs as durable-owned", () => {
    expect(promptPackExecutionRequiresDurable({ mode: "chat" })).toBe(true);
    expect(promptPackExecutionRequiresDurable({ mode: "cowork" })).toBe(true);
    expect(promptPackExecutionRequiresDurable({ mode: "code" })).toBe(true);
  });

  it("fails prompt-pack preflight before run creation when durable execution is unavailable", () => {
    expect(() =>
      ensurePromptPackDurableReadiness(
        { mode: "cowork" },
        {
          durable: {
            enabled: true,
            executionEnabled: false,
            chatAutoPromoteEnabled: true,
          },
          durableKernelV1Enabled: true,
        },
      ),
    ).toThrow(/Prompt Lab preflight failed/i);

    expect(() =>
      ensurePromptPackDurableReadiness(
        { mode: "code" },
        {
          durable: {
            enabled: true,
            executionEnabled: true,
            chatAutoPromoteEnabled: true,
          },
          durableKernelV1Enabled: false,
        },
      ),
    ).toThrow(/durable-owned code execution is unavailable/i);
  });

  it("does not bootstrap prompt-pack session allows over an inherited active deny grant", () => {
    const createGrant = vi.fn();
    const createTtlGrant = vi.fn();
    const listActive = vi.fn((scope?: string, scopeRef?: string) =>
      scope === "workspace" && scopeRef === "workspace-a"
        ? [
            {
              grantId: "deny-browser",
              toolPattern: "browser.*",
              decision: "deny",
              scope: "workspace",
              scopeRef: "workspace-a",
              grantType: "persistent",
              createdBy: "operator",
              createdAt: "2026-05-20T00:00:00.000Z",
            },
          ]
        : [],
    );
    const service = new PromptPackService(
      {
        storage: {
          toolGrants: {
            list: vi.fn(() => []),
            listActive,
            create: createGrant,
            createTtlForDuration: createTtlGrant,
          },
          chatSessionMeta: {
            get: () => ({ workspaceId: "workspace-a" }),
          },
        },
        gatewaySql: {
          prepare: () => ({
            get: () => undefined,
          }),
        } as never,
        config: {
          rootDir: "F:/code/personal-ai",
          assistant: {
            workspaceDir: ".",
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
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      } as never,
    );

    (
      service as unknown as {
        ensurePromptPackSessionToolGrants(
          sessionId: string,
          profile: {
            mode: "chat";
            toolTier: "explicit-tools";
            toolAutonomy: "manual";
            webMode: "quick";
            memoryMode: "off";
            thinkingLevel: "standard";
          },
          prompt: string,
        ): void;
      }
    ).ensurePromptPackSessionToolGrants(
      "session-1",
      {
        mode: "chat",
        toolTier: "explicit-tools",
        toolAutonomy: "manual",
        webMode: "quick",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      "Use browser.search for current sources.",
    );

    expect(listActive).toHaveBeenCalledWith("session", "session-1");
    expect(listActive).toHaveBeenCalledWith("global", "global");
    expect(listActive).toHaveBeenCalledWith("agent", "assistant");
    expect(listActive).toHaveBeenCalledWith("workspace", "workspace-a");
    const grantedPatterns = createTtlGrant.mock.calls.map((call) => (call[0] as { toolPattern: string }).toolPattern);
    expect(grantedPatterns.some((pattern) => pattern.startsWith("browser."))).toBe(false);
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("inherits default-workspace denies when prompt-pack session metadata is missing", () => {
    const createGrant = vi.fn();
    const createTtlGrant = vi.fn();
    const listActive = vi.fn((scope?: string, scopeRef?: string) =>
      scope === "workspace" && scopeRef === "default"
        ? [
            {
              grantId: "deny-browser-default",
              toolPattern: "browser.*",
              decision: "deny",
              scope: "workspace",
              scopeRef: "default",
              grantType: "persistent",
              createdBy: "operator",
              createdAt: "2026-05-20T00:00:00.000Z",
            },
          ]
        : [],
    );
    const service = new PromptPackService(
      {
        storage: {
          toolGrants: {
            list: vi.fn(() => []),
            listActive,
            create: createGrant,
            createTtlForDuration: createTtlGrant,
          },
          chatSessionMeta: {
            get: () => undefined,
          },
        },
        gatewaySql: {
          prepare: () => ({
            get: () => undefined,
          }),
        } as never,
        config: {
          rootDir: "F:/code/personal-ai",
          assistant: {
            workspaceDir: ".",
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
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      } as never,
    );

    (
      service as unknown as {
        ensurePromptPackSessionToolGrants(
          sessionId: string,
          profile: {
            mode: "chat";
            toolTier: "explicit-tools";
            toolAutonomy: "manual";
            webMode: "quick";
            memoryMode: "off";
            thinkingLevel: "standard";
          },
          prompt: string,
        ): void;
      }
    ).ensurePromptPackSessionToolGrants(
      "session-without-meta",
      {
        mode: "chat",
        toolTier: "explicit-tools",
        toolAutonomy: "manual",
        webMode: "quick",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      "Use browser.search for current sources.",
    );

    expect(listActive).toHaveBeenCalledWith("workspace", "default");
    const grantedPatterns = createTtlGrant.mock.calls.map((call) => (call[0] as { toolPattern: string }).toolPattern);
    expect(grantedPatterns.some((pattern) => pattern.startsWith("browser."))).toBe(false);
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("blocks prompt-pack test execution before creating run rows when durable preflight fails", async () => {
    const createRun = vi.fn();
    const createChatSession = vi.fn();
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-1",
                packId: "pack-1",
                code: "TEST-01",
                title: "Cowork infra gate",
                prompt: "Inspect the repo and summarize the failure.",
                orderIndex: 0,
                mode: "cowork",
                toolTier: "explicit-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: createRun,
          },
        },
        gatewaySql: {} as never,
        config: {
          assistant: {
            durable: {
              enabled: false,
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
        createChatSession,
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );

    await expect(service.runPromptPackTest("pack-1", "test-1")).rejects.toThrow(/preflight failed/i);
    expect(createRun).not.toHaveBeenCalled();
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it("blocks benchmark launch before creating a benchmark row when durable preflight fails", () => {
    const benchmarkInsert = vi.fn();
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            listTests: () => [
              {
                testId: "test-1",
                packId: "pack-1",
                code: "TEST-01",
                title: "Code infra gate",
                prompt: "Inspect the repo and summarize the failure.",
                orderIndex: 0,
                mode: "code",
                toolTier: "explicit-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              } satisfies PromptPackTestRecord,
            ],
          },
        },
        gatewaySql: {
          prepare: () => ({
            run: benchmarkInsert,
          }),
        } as never,
        config: {
          assistant: {
            durable: {
              enabled: true,
              executionEnabled: true,
              chatAutoPromoteEnabled: true,
            },
          },
        } as never,
        normalizeWorkspaceId: () => "default",
        isFeatureEnabled: () => false,
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

    expect(() =>
      service.runPromptPackBenchmark("pack-1", {
        testCodes: ["TEST-01"],
        providers: [{ providerId: "openai", model: "gpt-5.4" }],
      }),
    ).toThrow(/preflight failed/i);
    expect(benchmarkInsert).not.toHaveBeenCalled();
  });

  it("can launch a benchmark for every test in the pack from the backend", () => {
    const firstTest = createTest("test-1", "TEST-01");
    const secondTest = createTest("test-2", "TEST-02");
    const benchmarkInsert = vi.fn();
    const backgroundTasks = new Set<Promise<void>>();
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            listTests: () => [firstTest, secondTest],
          },
        },
        gatewaySql: {
          prepare: (sql: string) => ({
            get: () => undefined,
            all: () => [],
            run: (params: Record<string, unknown>) => {
              if (sql.includes("INSERT INTO prompt_pack_benchmark_runs")) {
                benchmarkInsert(params);
              }
              return { changes: 1 };
            },
          }),
        } as never,
        config: {
          assistant: {
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
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks,
      },
    );

    service.runPromptPackBenchmark("pack-1", {
      allTests: true,
      providers: [{ providerId: "openai", model: "gpt-5.4" }],
    });

    expect(benchmarkInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        testCodesJson: JSON.stringify(["TEST-01", "TEST-02"]),
        totalItems: 2,
      }),
    );
  });

  it("imports prompt packs, exposes list APIs, and rejects markdown without tests", () => {
    const tests = [createTest("test-imported", "TEST-C901")];
    const pack = createPack("pack-imported");
    const replacePackTests = vi.fn(() => ({ pack, tests }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            replacePackTests,
            listPacks: () => [pack],
            getPack: () => pack,
            listTests: () => tests,
          },
        },
        config: {
          rootDir: "F:/code/personal-ai",
          assistant: {
            workspaceDir: ".",
          },
        },
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
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const imported = service.importPromptPack({
      name: " Imported Pack ",
      sourceLabel: "prompt-pack-fixture.md",
      content: buildPromptPackMarkdown([
        {
          mode: "chat",
          toolTier: "no-tools",
          tests: [{ code: "TEST-C901", title: "Imported", prompt: "Answer from the prompt only." }],
        },
      ]),
    });

    expect(imported.pack).toBe(pack);
    expect(replacePackTests).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Imported Pack",
        sourceLabel: "prompt-pack-fixture.md",
        tests: expect.arrayContaining([expect.objectContaining({ code: "TEST-C901" })]),
      }),
    );
    expect(service.listPromptPacks()).toEqual([pack]);
    expect(service.listPromptPackTests(pack.packId)).toEqual(tests);
    expect(() => service.importPromptPack({ content: "# Empty" })).toThrow(/No tests found/);
  });

  it("exports prompt-pack reports with latest and immutable snapshot metadata", () => {
    const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-prompt-pack-export-"));
    try {
      const pack = createPack("pack-1");
      const test = createTest("test-export", "TEST-EXPORT");
      const run: PromptPackRunRecord = {
        ...createRun("run-export", "completed", "2026-03-14T00:00:01.000Z"),
        testId: test.testId,
        responseText: "Exported prompt-pack answer.",
      };
      const service = createPromptPackExportService({
        rootDir,
        pack,
        tests: [test],
        runs: [run],
      });

      const missing = service.getPromptPackExport(pack.packId);
      expect(missing.exists).toBe(false);
      expect(missing.latestSnapshotExists).toBe(false);

      const exported = service.exportPromptPack(pack.packId);
      expect(exported.exists).toBe(true);
      expect(exported.latestSnapshotExists).toBe(true);
      expect(exported.snapshotCount).toBe(1);
      expect(fsSync.existsSync(exported.path)).toBe(true);
      expect(fsSync.existsSync(exported.latestSnapshotPath ?? "")).toBe(true);

      const noOpReset = service.resetPromptPackRunsAndScores(pack.packId, {
        clearRuns: false,
        clearScores: false,
      });
      expect(noOpReset.deletedRuns).toBe(0);
      expect(noOpReset.deletedScores).toBe(0);
      expect(noOpReset.export.exists).toBe(true);
      expect(noOpReset.export.snapshotCount).toBe(1);
    } finally {
      fsSync.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("stores manual score reviews and lists them only for matching pack tests", () => {
    const test = createTest("test-review", "TEST-REVIEW");
    const run: PromptPackRunRecord = {
      ...createRun("run-review", "completed", "2026-03-14T00:00:01.000Z"),
      testId: test.testId,
      responseText: "Reviewed answer with enough concrete detail.",
    };
    const reviews: PromptPackHumanReviewRecordV2[] = [];
    const createReview = vi.fn((input: Omit<PromptPackHumanReviewRecordV2, "createdAt"> & { createdAt?: string }) => {
      const review: PromptPackHumanReviewRecordV2 = {
        ...input,
        createdAt: input.createdAt ?? "2026-03-14T00:00:02.000Z",
      };
      reviews.push(review);
      return review;
    });
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getTest: (testId: string) =>
              testId === "other-test" ? { ...test, testId: "other-test", packId: "other-pack" } : test,
          },
          promptPackRuns: {
            get: () => run,
          },
          promptPackAutoScoresV2: {
            listByRun: () => [],
          },
          promptPackHumanReviewsV2: {
            create: createReview,
            listByTest: (testId: string) => reviews.filter((review) => review.testId === testId),
          },
        },
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
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const review = service.scorePromptPackTest({
      packId: "pack-1",
      testId: test.testId,
      runId: run.runId,
      reviewerId: " qa-operator ",
      routingScore: 2,
      honestyScore: 1,
      handoffScore: 2,
      robustnessScore: 1,
      usabilityScore: 2,
      notes: " Manual scoring from operator review. ",
    });

    expect(review.reviewerId).toBe("qa-operator");
    expect(review.scores).toMatchObject({
      taskSuccess: 4,
      honesty: 2,
      executionQuality: 4,
      robustness: 2,
      usability: 4,
    });
    expect(review.notes).toBe("Manual scoring from operator review.");
    expect(createReview).toHaveBeenCalledWith(expect.objectContaining({ packId: "pack-1", testId: test.testId }));
    expect(service.listPromptPackTestReviews("pack-1", test.testId)).toEqual([review]);
    expect(() => service.listPromptPackTestReviews("pack-1", "other-test")).toThrow(/does not belong/);
  });

  it("scores the latest matching prompt-pack run by code and session", async () => {
    const test = createTest("test-latest-code", "TEST-LATEST");
    const selectedRun: PromptPackRunRecord = {
      ...createRun("run-selected-latest", "completed", "2026-03-14T00:00:02.000Z"),
      testId: test.testId,
      sessionId: "sess-target",
      responseText: "Selected session answer.",
    };
    const otherRun: PromptPackRunRecord = {
      ...createRun("run-other-session", "completed", "2026-03-14T00:00:03.000Z"),
      testId: test.testId,
      sessionId: "sess-other",
      responseText: "Other session answer.",
    };
    const createdReviews: PromptPackHumanReviewRecordV2[] = [];
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listPacks: () => [createPack("pack-1")],
            listTests: () => [test],
            getTest: () => test,
          },
          promptPackRuns: {
            listByTest: () => [otherRun, selectedRun],
            get: (runId: string) => (runId === selectedRun.runId ? selectedRun : otherRun),
          },
          promptPackAutoScoresV2: {
            listByRun: () => [],
          },
          promptPackHumanReviewsV2: {
            create: (input: PromptPackHumanReviewRecordV2) => {
              createdReviews.push(input);
              return input;
            },
          },
        },
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
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const review = await service.scorePromptPackLatestRunByCode({
      sessionId: "sess-target",
      testCode: "test-latest",
      routingScore: 2,
      honestyScore: 2,
      handoffScore: 1,
      robustnessScore: 1,
      usabilityScore: 2,
      notes: " latest session review ",
    });

    expect(review.runId).toBe(selectedRun.runId);
    expect(review.notes).toBe("latest session review");
    expect(createdReviews).toHaveLength(1);
    await expect(
      service.scorePromptPackLatestRunByCode({
        sessionId: "missing-session",
        testCode: "TEST-LATEST",
        routingScore: 2,
        honestyScore: 2,
        handoffScore: 2,
        robustnessScore: 2,
        usabilityScore: 2,
      }),
    ).rejects.toThrow(/No run found/);
  });

  it("runs prompt-pack selectors from an existing chat session with runner defaults", async () => {
    const firstTest = createTest("test-chat-first", "TEST-CHAT-1");
    const secondTest = createTest("test-chat-second", "TEST-CHAT-2");
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listPacks: () => [createPack("pack-1")],
            listTests: () => [firstTest, secondTest],
          },
        },
      } as never,
      {
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "runner-provider", model: "runner-model" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "judge-provider", model: "judge-model" }),
        backgroundTasks: new Set(),
      },
    );
    const runPromptPackTest = vi.spyOn(service, "runPromptPackTest").mockImplementation(
      async (_packId: string, testId: string, options?: { sessionId?: string; providerId?: string; model?: string }) =>
        ({
          ...createRun(`run-${testId}`, "completed", "2026-03-14T00:00:02.000Z"),
          testId,
          sessionId: options?.sessionId ?? "missing-session",
          providerId: options?.providerId,
          model: options?.model,
          responseText: `Ran ${testId}.`,
        }) satisfies PromptPackRunRecord,
    );

    const selected = await service.runPromptPackFromChat("sess-chat", "TEST-CHAT-2");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.testId).toBe(secondTest.testId);
    expect(selected[0]).toMatchObject({
      sessionId: "sess-chat",
      providerId: "runner-provider",
      model: "runner-model",
    });

    const allRuns = await service.runPromptPackFromChat("sess-chat", "all");
    expect(allRuns.map((run) => run.testId)).toEqual([firstTest.testId, secondTest.testId]);
    expect(runPromptPackTest).toHaveBeenCalledTimes(3);
    await expect(service.runPromptPackFromChat("sess-chat", "missing")).rejects.toThrow(/did not match/);
  });

  it("maps prompt-pack execution trace terminal states to persisted run status and errors", async () => {
    const cases: Array<{
      label: string;
      trace: PromptPackRunRecord["trace"];
      content: string;
      expectedStatus: PromptPackRunRecord["status"];
      expectedError?: RegExp;
    }> = [
      {
        label: "approval",
        trace: createTrace("sess-approval", { status: "waiting_for_approval" }),
        content: "Waiting for approval.",
        expectedStatus: "approval_paused",
        expectedError: /approval/i,
      },
      {
        label: "user-input",
        trace: createTrace("sess-user-input", { status: "waiting_for_user_input" }),
        content: "Waiting for user input.",
        expectedStatus: "approval_paused",
        expectedError: /user input/i,
      },
      {
        label: "failed-trace",
        trace: createTrace("sess-failed-trace", { status: "failed" }),
        content: "Trace failed.",
        expectedStatus: "failed",
        expectedError: /failed state/i,
      },
      {
        // Durable-layer failure with a completed trace and retained output is
        // recorded as a scorable completed run with a durable_failed integrity
        // signal instead of erasing the turn.
        label: "failed-durable",
        trace: createTrace("sess-failed-durable", {
          durable: { status: "failed", runId: "durable-failed" } as never,
        }),
        content: "Durable failed.",
        expectedStatus: "completed",
        expectedError: undefined,
      },
    ];

    for (const testCase of cases) {
      const patchRun = vi.fn((_runId: string, patch: Partial<PromptPackRunRecord>) => ({
        ...createRun(`run-${testCase.label}`, patch.status ?? "completed", "2026-03-14T00:00:01.000Z"),
        testId: `test-${testCase.label}`,
        responseText: patch.responseText,
        trace: patch.trace,
        integrity: patch.integrity,
        error: patch.error,
      }));
      const service = new PromptPackService(
        {
          storage: {
            promptPacks: {
              getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
              getTest: () =>
                ({
                  ...createTest(`test-${testCase.label}`, `TEST-${testCase.label.toUpperCase()}`),
                  toolTier: "no-tools",
                  prompt: "Answer from the prompt only.",
                }) satisfies PromptPackTestRecord,
            },
            promptPackRuns: {
              create: vi.fn(),
              patch: patchRun,
            },
            toolGrants: {
              list: () => [],
              create: vi.fn(),
            },
          },
          gatewaySql: {
            prepare: () => ({
              get: () => undefined,
            }),
          } as never,
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
          createChatSession: vi.fn(() => ({ sessionId: `sess-${testCase.label}` })),
          agentSendChatMessage: vi.fn(async () => ({
            sessionId: `sess-${testCase.label}`,
            turnId: `turn-sess-${testCase.label}`,
            userMessage: {} as never,
            assistantMessage: {
              messageId: `assistant-${testCase.label}`,
              sessionId: `sess-${testCase.label}`,
              role: "assistant",
              actorType: "agent",
              actorId: "assistant",
              content: testCase.content,
              timestamp: "2026-03-14T00:00:01.000Z",
            },
            transport: "llm",
            trace: testCase.trace,
            citations: [],
            routing: {},
          })),
          createChatCompletion: vi.fn(),
          getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          backgroundTasks: new Set(),
        },
      );
      vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

      const result = await service.runPromptPackTest("pack-1", `test-${testCase.label}`);

      expect(result.status).toBe(testCase.expectedStatus);
      if (testCase.expectedError) {
        expect(result.error).toMatch(testCase.expectedError);
      } else {
        expect(result.error).toBeUndefined();
      }
      expect(patchRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: result.status }));
    }
  });

  it("marks prompt-pack runs failed when the agent returns no assistant output", async () => {
    const patchRun = vi.fn((_runId: string, patch: Partial<PromptPackRunRecord>) => ({
      ...createRun("run-empty-output", patch.status ?? "completed", "2026-03-14T00:00:01.000Z"),
      responseText: patch.responseText,
      error: patch.error,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () => ({
              ...createTest("test-empty-output", "TEST-C902"),
              toolTier: "no-tools",
              prompt: "Answer from the prompt only.",
            }),
          },
          promptPackRuns: {
            create: vi.fn(),
            patch: patchRun,
          },
          toolGrants: {
            list: () => [],
            create: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: () => ({
            get: () => undefined,
          }),
        } as never,
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
        createChatSession: vi.fn(() => ({ sessionId: "sess-empty-output" })),
        agentSendChatMessage: vi.fn(async () => ({
          sessionId: "sess-empty-output",
          turnId: undefined,
          userMessage: {} as never,
          assistantMessage: {
            messageId: "assistant-empty-output",
            sessionId: "sess-empty-output",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "   ",
            timestamp: "2026-03-14T00:00:01.000Z",
          },
          transport: "llm",
          trace: createTrace("sess-empty-output"),
          citations: [],
          routing: {},
        })),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const result = await service.runPromptPackTest("pack-1", "test-empty-output");

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/No assistant output/);
  });

  it("persists a failed run when the prompt-pack agent call throws", async () => {
    const patchRun = vi.fn((_runId: string, patch: Partial<PromptPackRunRecord>) => ({
      ...createRun("run-agent-throws", patch.status ?? "completed", "2026-03-14T00:00:01.000Z"),
      error: patch.error,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () => createTest("test-agent-throws", "TEST-AGENT-THROWS"),
          },
          promptPackRuns: {
            create: vi.fn(),
            patch: patchRun,
          },
          toolGrants: {
            list: () => [],
            create: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: () => ({
            get: () => undefined,
          }),
        } as never,
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
        createChatSession: vi.fn(() => ({ sessionId: "sess-agent-throws" })),
        agentSendChatMessage: vi.fn(async () => {
          throw new Error("runner exploded");
        }),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const result = await service.runPromptPackTest("pack-1", "test-agent-throws");

    expect(result.status).toBe("failed");
    expect(result.error).toBe("runner exploded");
    expect(patchRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed", error: "runner exploded" }),
    );
  });

  it("runs replay regression comparisons and emits improvement signals for each capability delta", () => {
    const test = createTest("test-1", "TEST-C777");
    const currentScore: PromptPackScoreRecord = {
      ...createScore("score-current", "run-current", "2026-03-16T00:00:00.000Z", 1),
      testId: test.testId,
    };
    const baselineScore: PromptPackScoreRecord = {
      ...createScore("score-baseline", "run-baseline", "2026-03-15T00:00:00.000Z", 2),
      testId: test.testId,
    };
    const regressionRows: Array<Record<string, unknown>> = [];
    let regressionRun: Record<string, unknown> | undefined;
    const publishRealtime = vi.fn();
    const recordImprovementRegressionSignal = vi.fn();
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            listTests: () => [test],
          },
          promptPackRuns: {
            listByPack: () => [
              { ...createRun("run-current", "completed", "2026-03-16T00:00:02.000Z"), testId: test.testId },
              { ...createRun("run-baseline", "completed", "2026-03-15T00:00:01.000Z"), testId: test.testId },
            ],
          },
          promptPackScores: {
            listByPack: () => [currentScore, baselineScore],
          },
        },
        gatewaySql: {
          prepare: (sql: string) => ({
            get: (runId: string) => {
              if (sql.includes("FROM replay_regression_runs") && regressionRun?.regression_run_id === runId) {
                return regressionRun;
              }
              return undefined;
            },
            all: (runId: string) => {
              if (sql.includes("FROM replay_regression_results")) {
                return regressionRows.filter((row) => row.regression_run_id === runId);
              }
              return [];
            },
            run: (params: Record<string, unknown>) => {
              if (sql.includes("INSERT INTO replay_regression_runs")) {
                regressionRun = {
                  regression_run_id: params.regressionRunId,
                  pack_id: params.packId,
                  status: "running",
                  test_codes_json: params.testCodesJson,
                  baseline_ref: params.baselineRef,
                  summary_json: params.summaryJson,
                  started_at: params.startedAt,
                  finished_at: null,
                  error_text: null,
                };
              } else if (sql.includes("INSERT INTO replay_regression_results")) {
                regressionRows.push({
                  result_id: params.resultId,
                  regression_run_id: params.regressionRunId,
                  test_code: params.testCode,
                  capability: params.capability,
                  score_delta: params.scoreDelta,
                  pass_delta: params.passDelta,
                  latency_delta_ms: params.latencyDeltaMs,
                  created_at: params.createdAt,
                });
              } else if (sql.includes("UPDATE replay_regression_runs")) {
                regressionRun = {
                  ...regressionRun,
                  status: "completed",
                  summary_json: params.summaryJson,
                  finished_at: params.finishedAt,
                };
              }
              return { changes: 1 };
            },
          }),
        } as never,
        config: {
          assistant: {
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
        publishRealtime,
      } as never,
      {
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
        recordImprovementRegressionSignal,
      },
    );

    const { regressionRunId } = service.runPromptPackReplayRegression("pack-1", {
      testCodes: ["TEST-C777"],
    });
    const status = service.getPromptPackReplayRegressionStatus(regressionRunId);

    expect(status.run.status).toBe("completed");
    expect(status.results).toHaveLength(5);
    expect(status.results.every((result) => result.scoreDelta === -1)).toBe(true);
    expect(status.results.every((result) => result.passDelta === -1)).toBe(true);
    expect(recordImprovementRegressionSignal).toHaveBeenCalledTimes(5);
    expect(publishRealtime).toHaveBeenCalledWith(
      "prompt_pack_regression_completed",
      "promptLab",
      expect.objectContaining({ regressionRunId, packId: "pack-1", testCodes: ["TEST-C777"] }),
    );
  });

  it("builds prompt-pack capability trends and threshold breaches from v3 scores and run failures", () => {
    const score: PromptPackAutoScoreRecord = {
      autoScoreId: "auto-trend",
      packId: "pack-1",
      testId: "test-trend",
      runId: "run-trend-failed",
      scoringSchemaVersion: "v3",
      finalScores: {
        taskSuccess: 2,
        truthfulness: 4,
        evidenceGrounding: 4,
        formatAdherence: 4,
        operatorUsefulness: 2,
        toolUseQuality: 1,
        orchestrationQuality: 1,
        efficiency: 1,
        recoveryQuality: 1,
      },
      autoVerdict: "review",
      createdAt: "2026-03-16T00:00:00.000Z",
    } as PromptPackAutoScoreRecord;
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => createPack("pack-1"),
          },
          promptPackAutoScoresV2: {
            listByPack: () => [score],
          },
          promptPackRuns: {
            listByPack: () => [
              createRun("run-trend-failed", "failed", "2026-03-16T00:00:01.000Z"),
              createRun("run-trend-completed", "completed", "2026-03-16T00:00:02.000Z"),
            ],
          },
        },
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

    const trends = service.getPromptPackCapabilityTrends("pack-1");

    expect(trends.items.find((item) => item.capability === "taskSuccess")?.breached).toBe(true);
    expect(trends.items.find((item) => item.capability === "run_failure_rate")?.breached).toBe(true);
    expect(trends.items.find((item) => item.capability === "review_rate")?.breached).toBe(false);
  });

  it("uses prompt-runner defaults for prompt execution instead of judge defaults", async () => {
    const agentSendChatMessage = vi.fn(async () => ({
      sessionId: "sess-1",
      turnId: "turn-1",
      userMessage: {
        messageId: "user-1",
        sessionId: "sess-1",
        role: "user",
        actorType: "user",
        actorId: "user",
        content: "Answer only from the prompt.",
        timestamp: "2026-03-14T00:00:00.000Z",
      },
      assistantMessage: {
        messageId: "assistant-1",
        sessionId: "sess-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Runner answer.",
        timestamp: "2026-03-14T00:00:01.000Z",
      },
      transport: "llm",
      trace: createTrace("sess-1"),
      citations: [],
      routing: {},
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-1",
                packId: "pack-1",
                code: "TEST-RUNNER-DEFAULTS",
                title: "Runner defaults",
                prompt: "Answer only from the prompt.",
                orderIndex: 0,
                mode: "chat",
                toolTier: "no-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: vi.fn(),
            patch: vi.fn((_runId: string, patch: Record<string, unknown>) => ({
              ...createRun("run-runner-defaults", String(patch.status ?? "completed"), "2026-03-14T00:00:00.000Z"),
              testId: "test-1",
              responseText: patch.responseText,
              trace: patch.trace,
              citations: patch.citations,
              integrity: patch.integrity,
              error: patch.error,
            })),
          },
          toolGrants: {
            list: () => [],
            create: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: () => ({
            get: () => undefined,
          }),
        } as never,
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
        createChatSession: vi.fn(() => ({ sessionId: "sess-1" })),
        agentSendChatMessage,
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "runner-provider", model: "runner-model" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "judge-provider", model: "judge-model" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    await service.runPromptPackTest("pack-1", "test-1");

    expect(agentSendChatMessage).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        providerId: "runner-provider",
        model: "runner-model",
      }),
    );
  });

  it("binds an existing prompt-pack session to the resolved project before tool execution", async () => {
    const assignProject = vi.fn();
    const createGrant = vi.fn();
    const createTtlGrant = vi.fn();
    const createProject = vi.fn(() => ({
      projectId: "prompt-pack-project",
      workspaceId: "default",
      name: "Prompt Lab Workspace",
      description: "Auto-created project binding for prompt-pack code evaluations.",
      workspacePath: "fixtures/prompt-pack-workspace",
      lifecycleStatus: "active",
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
    }));
    const createRun = vi.fn();
    const patchRun = vi.fn((_runId: string, patch: Record<string, unknown>) => ({
      ...createTest("test-existing-session-project", "TEST-PROJECT-BIND"),
      runId: "run-existing-session-project",
      packId: "pack-1",
      testId: "test-existing-session-project",
      sessionId: "sess-existing-project",
      status: patch.status,
      responseText: patch.responseText,
      trace: patch.trace,
      citations: patch.citations,
      integrity: patch.integrity,
      startedAt: "2026-03-14T00:00:00.000Z",
      finishedAt: "2026-03-14T00:00:01.000Z",
    }));
    const agentSendChatMessage = vi.fn(async () => ({
      sessionId: "sess-existing-project",
      turnId: "turn-existing-project",
      userMessage: {
        messageId: "user-existing-project",
        sessionId: "sess-existing-project",
        role: "user",
        actorType: "user",
        actorId: "user",
        content: "Read package.json",
        timestamp: "2026-03-14T00:00:00.000Z",
      },
      assistantMessage: {
        messageId: "assistant-existing-project",
        sessionId: "sess-existing-project",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Read package.json.",
        timestamp: "2026-03-14T00:00:01.000Z",
      },
      transport: "llm",
      trace: createTrace("sess-existing-project", { toolRuns: [] }),
      citations: [],
      routing: {},
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-existing-session-project",
                packId: "pack-1",
                code: "TEST-PROJECT-BIND",
                title: "Existing session project binding",
                prompt: "Read fixtures/prompt-pack-workspace/package.json using file tools.",
                orderIndex: 0,
                mode: "code",
                toolTier: "explicit-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: createRun,
            patch: patchRun,
          },
          toolGrants: {
            list: () => [
              {
                grantId: "grant-stale-read",
                toolPattern: "fs.read",
                decision: "allow",
                scope: "session",
                scopeRef: "sess-existing-project",
                grantType: "ttl",
                constraints: {
                  allowedPaths: ["F:\\code\\personal-ai\\workspace\\old-prompt-pack-root"],
                },
                createdBy: "test",
                createdAt: "2026-03-14T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            ],
            listActive: (scope?: string, scopeRef?: string) =>
              scope === "session" && scopeRef === "sess-existing-project"
                ? [
                    {
                      grantId: "grant-stale-read",
                      toolPattern: "fs.read",
                      decision: "allow",
                      scope: "session",
                      scopeRef: "sess-existing-project",
                      grantType: "ttl",
                      constraints: {
                        allowedPaths: ["F:\\code\\personal-ai\\workspace\\old-prompt-pack-root"],
                      },
                      createdBy: "test",
                      createdAt: "2026-03-14T00:00:00.000Z",
                      expiresAt: "2099-01-01T00:00:00.000Z",
                    },
                  ]
                : [],
            create: createGrant,
            createTtlForDuration: createTtlGrant,
          },
          chatProjects: {
            list: () => [],
            create: createProject,
          },
          chatSessionProjects: {
            assign: assignProject,
          },
        },
        gatewaySql: {
          prepare: () => ({
            all: () => [],
            get: () => undefined,
          }),
        } as never,
        config: {
          rootDir: "F:/code/personal-ai",
          assistant: {
            workspaceDir: "workspace",
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
        agentSendChatMessage,
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    await service.runPromptPackTest("pack-1", "test-existing-session-project", {
      sessionId: "sess-existing-project",
    });

    expect(createProject).toHaveBeenCalled();
    expect(assignProject).toHaveBeenCalledWith("sess-existing-project", "prompt-pack-project");
    expect(createTtlGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "fs.read",
        constraints: expect.objectContaining({
          allowedPaths: expect.arrayContaining(["F:\\code\\personal-ai\\workspace\\fixtures\\prompt-pack-workspace"]),
        }),
      }),
      2 * 60 * 60 * 1000,
    );
    expect(createGrant).not.toHaveBeenCalled();
    expect(agentSendChatMessage).toHaveBeenCalledWith("sess-existing-project", expect.any(Object));
  });

  it("hydrates retained tool rows before persisting prompt-pack run evidence", async () => {
    const patchRun = vi.fn((_runId: string, patch: Record<string, unknown>) => ({
      ...createRun("run-hydrated-tools", String(patch.status ?? "completed"), "2026-03-14T00:00:00.000Z"),
      testId: "test-hydrated-tools",
      responseText: patch.responseText,
      trace: patch.trace,
      citations: patch.citations,
      integrity: patch.integrity,
      error: patch.error,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-hydrated-tools",
                packId: "pack-1",
                code: "TEST-HYDRATED-TOOLS",
                title: "Hydrated tool rows",
                prompt: "Use browser.search and summarize the result.",
                orderIndex: 0,
                mode: "chat",
                toolTier: "explicit-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: vi.fn(),
            patch: patchRun,
          },
          toolGrants: {
            list: () => [],
            listActive: () => [],
            create: vi.fn(),
            createTtlForDuration: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: () => ({
            all: () => [
              {
                tool_run_id: "tool-hydrated",
                turn_id: "turn-hydrated-tools",
                session_id: "sess-hydrated-tools",
                tool_name: "browser.search",
                status: "blocked",
                approval_id: null,
                args_json: JSON.stringify({ query: "official source" }),
                result_json: null,
                reused: null,
                reused_from_tool_run_id: null,
                reuse_reason: null,
                error: "blocked by policy",
                failure_guidance: "tool unavailable",
                started_at: "2026-03-14T00:00:00.000Z",
                finished_at: "2026-03-14T00:00:00.100Z",
              },
            ],
            get: () => undefined,
          }),
        } as never,
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
        createChatSession: vi.fn(() => ({ sessionId: "sess-hydrated-tools" })),
        agentSendChatMessage: vi.fn(async () => ({
          sessionId: "sess-hydrated-tools",
          turnId: "turn-hydrated-tools",
          userMessage: {
            messageId: "user-hydrated-tools",
            sessionId: "sess-hydrated-tools",
            role: "user",
            actorType: "user",
            actorId: "user",
            content: "Use browser.search",
            timestamp: "2026-03-14T00:00:00.000Z",
          },
          assistantMessage: {
            messageId: "assistant-hydrated-tools",
            sessionId: "sess-hydrated-tools",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "browser.search was blocked by policy, so I cannot claim page contents.",
            timestamp: "2026-03-14T00:00:01.000Z",
          },
          transport: "llm",
          trace: createTrace("sess-hydrated-tools", { toolRuns: [] }),
          citations: [],
          routing: {},
        })),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const run = await service.runPromptPackTest("pack-1", "test-hydrated-tools");

    expect(run.trace?.toolRuns).toEqual([
      expect.objectContaining({
        toolRunId: "tool-hydrated",
        toolName: "browser.search",
        status: "blocked",
        error: "blocked by policy",
        failureGuidance: "tool unavailable",
      }),
    ]);
  });

  it("refreshes a durable-backed turn snapshot before persisting the prompt-pack run", async () => {
    const createRun = vi.fn();
    const patchRun = vi.fn((_: string, patch: Record<string, unknown>) => ({
      runId: "run-1",
      packId: "pack-1",
      testId: "test-1",
      sessionId: "sess-1",
      status: patch.status,
      providerId: "openai",
      model: "gpt-5.4",
      mode: "chat",
      toolTier: "no-tools",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      responseText: patch.responseText,
      trace: patch.trace,
      citations: patch.citations,
      integrity: patch.integrity,
      error: patch.error,
      startedAt: "2026-03-14T00:00:00.000Z",
      finishedAt: patch.finishedAt,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-1",
                packId: "pack-1",
                code: "TEST-REFRESH-01",
                title: "Refresh durable snapshot",
                prompt: "Answer only from the prompt.",
                orderIndex: 0,
                mode: "chat",
                toolTier: "no-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: createRun,
            patch: patchRun,
          },
          toolGrants: {
            list: () => [],
            create: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: (sql: string) => ({
            get: (value: string) => {
              if (sql.includes("FROM chat_turn_traces") && value === "turn-1") {
                return {
                  assistant_message_id: "assistant-1",
                  status: "completed",
                  model: "gpt-5.4",
                  completion_json: JSON.stringify({
                    finishReason: "stop",
                    status: "complete",
                    repaired: false,
                  }),
                  durable_json: JSON.stringify({
                    runId: "dur-1",
                    status: "completed",
                    checkpointKind: "run_completed",
                  }),
                  citations_json: "[]",
                  failure_json: null,
                  finished_at: "2026-03-14T00:00:02.000Z",
                };
              }
              if (sql.includes("FROM chat_messages") && value === "assistant-1") {
                return {
                  content: "Final durable answer.",
                };
              }
              return undefined;
            },
          }),
        } as never,
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
        createChatSession: vi.fn(() => ({ sessionId: "sess-1" })),
        agentSendChatMessage: vi.fn(async () => ({
          sessionId: "sess-1",
          turnId: "turn-1",
          userMessage: {
            messageId: "user-1",
            sessionId: "sess-1",
            role: "user",
            actorType: "user",
            actorId: "user",
            content: "Answer only from the prompt.",
            timestamp: "2026-03-14T00:00:00.000Z",
          },
          assistantMessage: {
            messageId: "assistant-1",
            sessionId: "sess-1",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "",
            timestamp: "2026-03-14T00:00:01.000Z",
          },
          transport: "llm",
          trace: {
            turnId: "turn-1",
            sessionId: "sess-1",
            userMessageId: "user-1",
            assistantMessageId: "assistant-1",
            branchKind: "append",
            status: "completed",
            mode: "chat",
            model: "gpt-5.4",
            webMode: "off",
            memoryMode: "off",
            thinkingLevel: "standard",
            routing: {},
            toolRuns: [],
            citations: [],
            completion: {
              finishReason: "tool_calls",
              status: "complete",
              repaired: false,
            },
            durable: {
              runId: "dur-1",
              status: "running",
              checkpointKind: "run_started",
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
          citations: [],
          routing: {},
        })),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const run = await service.runPromptPackTest("pack-1", "test-1");

    expect(run.responseText).toBe("Final durable answer.");
    expect(run.trace?.completion?.finishReason).toBe("stop");
    expect(run.trace?.durable?.status).toBe("completed");
    expect(patchRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        responseText: "Final durable answer.",
      }),
    );
  });

  it("preserves live response fallbacks when durable snapshot JSON columns are null", async () => {
    const patchRun = vi.fn((_: string, patch: Record<string, unknown>) => ({
      runId: "run-null-refresh",
      packId: "pack-1",
      testId: "test-1",
      sessionId: "sess-1",
      status: patch.status,
      providerId: "openai",
      model: "gpt-5.4",
      mode: "chat",
      toolTier: "no-tools",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      responseText: patch.responseText,
      trace: patch.trace,
      citations: patch.citations,
      integrity: patch.integrity,
      error: patch.error,
      startedAt: "2026-03-14T00:00:00.000Z",
      finishedAt: patch.finishedAt,
    }));
    const liveCitations = [{ title: "live-citation", uri: "file:///repo" }] as never;
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-1",
                packId: "pack-1",
                code: "TEST-REFRESH-NULL",
                title: "Refresh null snapshot",
                prompt: "Answer only from the prompt.",
                orderIndex: 0,
                mode: "chat",
                toolTier: "no-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: vi.fn(),
            patch: patchRun,
          },
          toolGrants: {
            list: () => [],
            create: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: (sql: string) => ({
            get: (value: string) => {
              if (sql.includes("FROM chat_turn_traces") && value === "turn-1") {
                return {
                  assistant_message_id: "assistant-1",
                  status: "completed",
                  model: "gpt-5.4",
                  completion_json: "null",
                  durable_json: "null",
                  citations_json: null,
                  failure_json: "null",
                  finished_at: "2026-03-14T00:00:02.000Z",
                };
              }
              if (sql.includes("FROM chat_messages") && value === "assistant-1") {
                return {
                  content: "Fallback-preserving answer.",
                };
              }
              return undefined;
            },
          }),
        } as never,
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
        createChatSession: vi.fn(() => ({ sessionId: "sess-1" })),
        agentSendChatMessage: vi.fn(async () => ({
          sessionId: "sess-1",
          turnId: "turn-1",
          userMessage: {
            messageId: "user-1",
            sessionId: "sess-1",
            role: "user",
            actorType: "user",
            actorId: "user",
            content: "Answer only from the prompt.",
            timestamp: "2026-03-14T00:00:00.000Z",
          },
          assistantMessage: {
            messageId: "assistant-1",
            sessionId: "sess-1",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "",
            timestamp: "2026-03-14T00:00:01.000Z",
          },
          transport: "llm",
          trace: {
            turnId: "turn-1",
            sessionId: "sess-1",
            userMessageId: "user-1",
            assistantMessageId: "assistant-1",
            branchKind: "append",
            status: "completed",
            mode: "chat",
            model: "gpt-5.4",
            webMode: "off",
            memoryMode: "off",
            thinkingLevel: "standard",
            routing: {},
            toolRuns: [],
            citations: liveCitations,
            completion: {
              finishReason: "stop",
              status: "complete",
              repaired: false,
            },
            durable: {
              runId: "dur-1",
              status: "completed",
              checkpointKind: "run_completed",
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
          citations: liveCitations,
          routing: {},
        })),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const run = await service.runPromptPackTest("pack-1", "test-1");

    expect(run.trace?.completion?.finishReason).toBe("stop");
    expect(run.trace?.durable?.status).toBe("completed");
    expect(run.citations).toEqual(liveCitations);
  });

  it("waits long enough to capture slower durable terminal snapshots", async () => {
    vi.useFakeTimers();
    try {
      const createRun = vi.fn();
      const patchRun = vi.fn((_: string, patch: Record<string, unknown>) => ({
        runId: "run-slow-refresh",
        packId: "pack-1",
        testId: "test-1",
        sessionId: "sess-1",
        status: patch.status,
        providerId: "openai",
        model: "gpt-5.4",
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        responseText: patch.responseText,
        trace: patch.trace,
        citations: patch.citations,
        integrity: patch.integrity,
        error: patch.error,
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: patch.finishedAt,
      }));
      let traceReads = 0;
      const service = new PromptPackService(
        {
          storage: {
            promptPacks: {
              getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
              getTest: () =>
                ({
                  testId: "test-1",
                  packId: "pack-1",
                  code: "TEST-REFRESH-SLOW",
                  title: "Refresh durable snapshot slowly",
                  prompt: "Answer only from the prompt.",
                  orderIndex: 0,
                  mode: "chat",
                  toolTier: "no-tools",
                  createdAt: "2026-03-14T00:00:00.000Z",
                }) satisfies PromptPackTestRecord,
            },
            promptPackRuns: {
              create: createRun,
              patch: patchRun,
            },
            toolGrants: {
              list: () => [],
              create: vi.fn(),
            },
          },
          gatewaySql: {
            prepare: (sql: string) => ({
              get: (value: string) => {
                if (sql.includes("FROM chat_turn_traces") && value === "turn-1") {
                  traceReads += 1;
                  if (traceReads < 10) {
                    return {
                      assistant_message_id: "assistant-1",
                      status: "completed",
                      model: "gpt-5.4",
                      completion_json: JSON.stringify({
                        finishReason: "tool_calls",
                        status: "complete",
                        repaired: false,
                      }),
                      durable_json: JSON.stringify({
                        runId: "dur-1",
                        status: "running",
                        checkpointKind: "run_started",
                      }),
                      citations_json: "[]",
                      failure_json: null,
                      finished_at: "2026-03-14T00:00:01.000Z",
                    };
                  }
                  return {
                    assistant_message_id: "assistant-1",
                    status: "completed",
                    model: "gpt-5.4",
                    completion_json: JSON.stringify({
                      finishReason: "stop",
                      status: "complete",
                      repaired: false,
                    }),
                    durable_json: JSON.stringify({
                      runId: "dur-1",
                      status: "completed",
                      checkpointKind: "run_completed",
                    }),
                    citations_json: "[]",
                    failure_json: null,
                    finished_at: "2026-03-14T00:00:03.000Z",
                  };
                }
                if (sql.includes("FROM chat_messages") && value === "assistant-1") {
                  return {
                    content: traceReads < 10 ? "" : "Delayed durable answer.",
                  };
                }
                return undefined;
              },
            }),
          } as never,
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
          createChatSession: vi.fn(() => ({ sessionId: "sess-1" })),
          agentSendChatMessage: vi.fn(async () => ({
            sessionId: "sess-1",
            turnId: "turn-1",
            userMessage: {
              messageId: "user-1",
              sessionId: "sess-1",
              role: "user",
              actorType: "user",
              actorId: "user",
              content: "Answer only from the prompt.",
              timestamp: "2026-03-14T00:00:00.000Z",
            },
            assistantMessage: {
              messageId: "assistant-1",
              sessionId: "sess-1",
              role: "assistant",
              actorType: "agent",
              actorId: "assistant",
              content: "",
              timestamp: "2026-03-14T00:00:01.000Z",
            },
            transport: "llm",
            trace: {
              turnId: "turn-1",
              sessionId: "sess-1",
              userMessageId: "user-1",
              assistantMessageId: "assistant-1",
              branchKind: "append",
              status: "completed",
              mode: "chat",
              model: "gpt-5.4",
              webMode: "off",
              memoryMode: "off",
              thinkingLevel: "standard",
              routing: {},
              toolRuns: [],
              citations: [],
              completion: {
                finishReason: "tool_calls",
                status: "complete",
                repaired: false,
              },
              durable: {
                runId: "dur-1",
                status: "running",
                checkpointKind: "run_started",
              },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
            citations: [],
            routing: {},
          })),
          createChatCompletion: vi.fn(),
          getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          backgroundTasks: new Set(),
        },
      );
      vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

      const runPromise = service.runPromptPackTest("pack-1", "test-1");
      await vi.advanceTimersByTimeAsync(2_500);
      const run = await runPromise;

      expect(run.responseText).toBe("Delayed durable answer.");
      expect(run.trace?.durable?.status).toBe("completed");
      expect(traceReads).toBeGreaterThanOrEqual(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes interrupted benchmark runs without rerunning completed items", async () => {
    const firstTest = createTest("test-benchmark-1", "TEST-BENCH-01");
    const secondTest = createTest("test-benchmark-2", "TEST-BENCH-02");
    const benchmarkRun: {
      benchmark_run_id: string;
      pack_id: string;
      status: PromptPackBenchmarkStatusRecord["run"]["status"];
      test_codes_json: string;
      providers_json: string;
      total_items: number;
      completed_items: number;
      claimed_by_worker_id: string | null;
      claim_heartbeat_at: string | null;
      claim_expires_at: string | null;
      error: string | null;
      started_at: string;
      finished_at: string | null;
    } = {
      benchmark_run_id: "ppb-resume-1",
      pack_id: "pack-1",
      status: "running",
      test_codes_json: JSON.stringify([firstTest.code, secondTest.code]),
      providers_json: JSON.stringify([{ providerId: "openai", model: "gpt-5.4" }]),
      total_items: 2,
      completed_items: 1,
      claimed_by_worker_id: null,
      claim_heartbeat_at: null,
      claim_expires_at: null,
      error: null,
      started_at: "2026-03-16T00:00:00.000Z",
      finished_at: null,
    };
    const benchmarkItems: Array<Record<string, unknown>> = [
      {
        item_id: "ppbi-existing",
        benchmark_run_id: benchmarkRun.benchmark_run_id,
        pack_id: "pack-1",
        test_id: firstTest.testId,
        test_code: firstTest.code,
        provider_id: "openai",
        model: "gpt-5.4",
        run_id: "run-existing",
        score_id: null,
        auto_score_id: "auto-existing",
        run_status: "completed",
        total_score: null,
        weighted_score: 92,
        verdict: "pass",
        score_state: "auto_valid",
        failure_signal: null,
        created_at: "2026-03-16T00:01:00.000Z",
      },
    ];
    const benchmarkUpdates: Array<Record<string, unknown>> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const publishRealtime = vi.fn();
    const runBackgroundWork = vi.fn(async (_label: string, work: (signal: AbortSignal) => Promise<unknown>) =>
      work(new AbortController().signal),
    );
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listTests: () => [firstTest, secondTest],
          },
        },
        gatewaySql: {
          prepare: (sql: string) => ({
            get: (arg: string) => {
              if (sql.includes("FROM prompt_pack_benchmark_runs") && arg === benchmarkRun.benchmark_run_id) {
                return benchmarkRun;
              }
              return undefined;
            },
            all: (arg?: unknown) => {
              if (sql.includes("FROM prompt_pack_benchmark_runs") && sql.includes("status IN ('queued', 'running')")) {
                return [benchmarkRun];
              }
              if (sql.includes("FROM prompt_pack_benchmark_items") && arg === benchmarkRun.benchmark_run_id) {
                return benchmarkItems;
              }
              return [];
            },
            run: (params: Record<string, unknown>) => {
              benchmarkUpdates.push(params);
              if (sql.includes("INSERT INTO prompt_pack_benchmark_items")) {
                const existingIndex = benchmarkItems.findIndex(
                  (item) =>
                    item.benchmark_run_id === params.benchmarkRunId &&
                    item.provider_id === params.providerId &&
                    item.model === params.model &&
                    item.test_id === params.testId,
                );
                const item = {
                  item_id: String(params.itemId),
                  benchmark_run_id: String(params.benchmarkRunId),
                  pack_id: String(params.packId),
                  test_id: String(params.testId),
                  test_code: String(params.testCode),
                  provider_id: String(params.providerId),
                  model: String(params.model),
                  run_id: typeof params.runId === "string" ? params.runId : null,
                  score_id: typeof params.scoreId === "string" ? params.scoreId : null,
                  auto_score_id: typeof params.autoScoreId === "string" ? params.autoScoreId : null,
                  run_status: String(params.runStatus),
                  total_score: typeof params.totalScore === "number" ? params.totalScore : null,
                  weighted_score: typeof params.weightedScore === "number" ? params.weightedScore : null,
                  verdict: typeof params.verdict === "string" ? params.verdict : null,
                  score_state: typeof params.scoreState === "string" ? params.scoreState : null,
                  failure_signal: typeof params.failureSignal === "string" ? params.failureSignal : null,
                  created_at: String(params.createdAt),
                };
                if (existingIndex >= 0) {
                  benchmarkItems[existingIndex] = { ...benchmarkItems[existingIndex], ...item };
                } else {
                  benchmarkItems.push(item);
                }
              } else if (sql.includes("SET claim_heartbeat_at = @now")) {
                if (benchmarkRun.claimed_by_worker_id === String(params.workerId)) {
                  benchmarkRun.claim_heartbeat_at = String(params.now);
                  benchmarkRun.claim_expires_at = String(params.claimExpiresAt);
                  return { changes: 1 };
                }
                return { changes: 0 };
              } else if (sql.includes("status = 'completed'")) {
                benchmarkRun.status = "completed";
                benchmarkRun.finished_at = String(params.finishedAt);
                benchmarkRun.claimed_by_worker_id = null;
                benchmarkRun.claim_heartbeat_at = null;
                benchmarkRun.claim_expires_at = null;
                return { changes: 1 };
              } else if (sql.includes("status = 'failed'")) {
                benchmarkRun.status = "failed";
                benchmarkRun.error = String(params.error);
                benchmarkRun.finished_at = String(params.finishedAt);
                benchmarkRun.claimed_by_worker_id = null;
                benchmarkRun.claim_heartbeat_at = null;
                benchmarkRun.claim_expires_at = null;
                return { changes: 1 };
              } else if (sql.includes("status = 'running'")) {
                benchmarkRun.status = "running";
                benchmarkRun.error = null;
                benchmarkRun.completed_items = Number(params.completedItems ?? benchmarkRun.completed_items);
                benchmarkRun.claimed_by_worker_id = String(params.workerId ?? "worker-test");
                benchmarkRun.claim_heartbeat_at = String(params.now ?? "2026-03-16T00:00:00.000Z");
                benchmarkRun.claim_expires_at = String(params.claimExpiresAt ?? "2026-03-16T00:02:00.000Z");
                return { changes: 1 };
              } else if (sql.includes("SET completed_items = @completedItems")) {
                benchmarkRun.completed_items = Number(params.completedItems);
                return { changes: 1 };
              }
              return { changes: 0 };
            },
          }),
        } as never,
        config: {
          assistant: {
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
        publishRealtime,
      } as never,
      {
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks,
        runBackgroundWork,
      },
    );
    const resumedRun: PromptPackRunRecord = {
      ...createRun("run-resumed", "completed", "2026-03-16T00:02:00.000Z"),
      testId: secondTest.testId,
      responseText: "Recovered benchmark answer.",
      trace: createTrace("sess-resumed"),
    };
    const runPromptPackTest = vi.spyOn(service, "runPromptPackTest").mockResolvedValue(resumedRun);
    const autoScorePromptPackTest = vi.spyOn(service, "autoScorePromptPackTest").mockResolvedValue({
      score: {
        autoScoreId: "auto-resumed",
        weightedScore: 96,
        autoVerdict: "pass",
        scoreState: "auto_valid",
      },
      legacyScore: undefined,
      run: resumedRun,
    } as never);

    expect(service.resumeInterruptedBenchmarkRuns()).toBe(1);
    await Promise.all([...backgroundTasks]);

    expect(runBackgroundWork).toHaveBeenCalledWith(
      `prompt-pack-benchmark:${benchmarkRun.benchmark_run_id}`,
      expect.any(Function),
    );
    expect(runPromptPackTest).toHaveBeenCalledTimes(1);
    expect(runPromptPackTest).toHaveBeenCalledWith(
      "pack-1",
      secondTest.testId,
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-5.4",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(autoScorePromptPackTest).toHaveBeenCalledTimes(1);
    expect(benchmarkItems).toHaveLength(2);
    expect(benchmarkRun.status).toBe("completed");
    expect(benchmarkRun.completed_items).toBe(2);
    expect(
      publishRealtime.mock.calls.some(
        ([eventType, source, payload]) =>
          eventType === "prompt_pack_benchmark_completed" &&
          source === "promptLab" &&
          (payload as { benchmarkRunId?: string }).benchmarkRunId === benchmarkRun.benchmark_run_id,
      ),
    ).toBe(true);
    expect(benchmarkUpdates.some((params) => params.completedItems === 1)).toBe(true);
    expect(benchmarkUpdates.some((params) => params.completedItems === 2)).toBe(true);
  });

  it("starts pending benchmark prompt-pack items concurrently", async () => {
    const benchmarkTests = Array.from({ length: 5 }, (_, index) =>
      createTest(`test-benchmark-parallel-${index + 1}`, `TEST-BENCH-PAR-${index + 1}`),
    );
    const benchmarkRun: Record<string, unknown> = {
      benchmark_run_id: "ppb-parallel-1",
      pack_id: "pack-1",
      status: "queued",
      test_codes_json: JSON.stringify(benchmarkTests.map((test) => test.code)),
      providers_json: JSON.stringify([{ providerId: "openai", model: "gpt-5.4" }]),
      total_items: benchmarkTests.length,
      completed_items: 0,
      claimed_by_worker_id: null,
      claim_heartbeat_at: null,
      claim_expires_at: null,
      execution_style: "agentic_surface",
      error: null,
      started_at: "2026-03-16T00:00:00.000Z",
      finished_at: null,
    };
    const benchmarkItems: Array<Record<string, unknown>> = [];
    const publishRealtime = vi.fn();
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listTests: () => benchmarkTests,
          },
        },
        gatewaySql: {
          prepare: (sql: string) => ({
            get: (arg: string) =>
              sql.includes("FROM prompt_pack_benchmark_runs") && arg === benchmarkRun.benchmark_run_id
                ? benchmarkRun
                : undefined,
            all: (arg?: unknown) => {
              if (sql.includes("FROM prompt_pack_benchmark_items") && arg === benchmarkRun.benchmark_run_id) {
                return benchmarkItems;
              }
              return [];
            },
            run: (params: Record<string, unknown>) => {
              if (sql.includes("INSERT INTO prompt_pack_benchmark_items")) {
                const existingIndex = benchmarkItems.findIndex(
                  (item) =>
                    item.benchmark_run_id === params.benchmarkRunId &&
                    item.provider_id === params.providerId &&
                    item.model === params.model &&
                    item.test_id === params.testId,
                );
                const item = {
                  item_id: String(params.itemId),
                  benchmark_run_id: String(params.benchmarkRunId),
                  pack_id: String(params.packId),
                  test_id: String(params.testId),
                  test_code: String(params.testCode),
                  provider_id: String(params.providerId),
                  model: String(params.model),
                  run_id: typeof params.runId === "string" ? params.runId : null,
                  score_id: typeof params.scoreId === "string" ? params.scoreId : null,
                  auto_score_id: typeof params.autoScoreId === "string" ? params.autoScoreId : null,
                  run_status: String(params.runStatus),
                  total_score: typeof params.totalScore === "number" ? params.totalScore : null,
                  weighted_score: typeof params.weightedScore === "number" ? params.weightedScore : null,
                  verdict: typeof params.verdict === "string" ? params.verdict : null,
                  score_state: typeof params.scoreState === "string" ? params.scoreState : null,
                  failure_signal: typeof params.failureSignal === "string" ? params.failureSignal : null,
                  created_at: String(params.createdAt),
                };
                if (existingIndex >= 0) {
                  benchmarkItems[existingIndex] = { ...benchmarkItems[existingIndex], ...item };
                } else {
                  benchmarkItems.push(item);
                }
              } else if (sql.includes("SET claim_heartbeat_at = @now")) {
                if (benchmarkRun.claimed_by_worker_id === String(params.workerId)) {
                  benchmarkRun.claim_heartbeat_at = String(params.now);
                  benchmarkRun.claim_expires_at = String(params.claimExpiresAt);
                  return { changes: 1 };
                }
                return { changes: 0 };
              } else if (sql.includes("status = 'completed'")) {
                benchmarkRun.status = "completed";
                benchmarkRun.finished_at = String(params.finishedAt);
                benchmarkRun.claimed_by_worker_id = null;
                benchmarkRun.claim_heartbeat_at = null;
                benchmarkRun.claim_expires_at = null;
                return { changes: 1 };
              } else if (sql.includes("status = 'running'")) {
                benchmarkRun.status = "running";
                benchmarkRun.error = null;
                benchmarkRun.completed_items = Number(params.completedItems ?? benchmarkRun.completed_items);
                benchmarkRun.claimed_by_worker_id = String(params.workerId ?? "worker-test");
                benchmarkRun.claim_heartbeat_at = String(params.now ?? "2026-03-16T00:00:00.000Z");
                benchmarkRun.claim_expires_at = String(params.claimExpiresAt ?? "2026-03-16T00:02:00.000Z");
                return { changes: 1 };
              } else if (sql.includes("SET completed_items = @completedItems")) {
                benchmarkRun.completed_items = Number(params.completedItems);
                return { changes: 1 };
              }
              return { changes: 0 };
            },
          }),
        } as never,
        config: {
          assistant: {
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
        publishRealtime,
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
    const runResolvers: Array<() => void> = [];
    const runPromptPackTest = vi.spyOn(service, "runPromptPackTest").mockImplementation(async (_packId, testId) => {
      await new Promise<void>((resolve) => runResolvers.push(resolve));
      return {
        ...createRun(`run-${testId}`, "completed", "2026-03-16T00:02:00.000Z"),
        testId,
        responseText: `Benchmark answer for ${testId}.`,
        trace: createTrace(`sess-${testId}`),
      };
    });
    const autoScorePromptPackTest = vi.spyOn(service, "autoScorePromptPackTest").mockImplementation(
      async (input) =>
        ({
          score: {
            autoScoreId: `auto-${input.testId}`,
            weightedScore: 96,
            autoVerdict: "pass",
            scoreState: "auto_valid",
          },
          legacyScore: undefined,
          run: createRun(String(input.runId ?? "run-scored"), "completed", "2026-03-16T00:03:00.000Z"),
        }) as never,
    );

    const task = (
      service as unknown as { runPromptPackBenchmarkTask: (benchmarkRunId: string) => Promise<void> }
    ).runPromptPackBenchmarkTask("ppb-parallel-1");
    await vi.waitFor(() => expect(runResolvers.length).toBeGreaterThanOrEqual(4));

    expect(runPromptPackTest).toHaveBeenCalledTimes(4);
    expect(runResolvers).toHaveLength(4);
    const firstBatch = runResolvers.splice(0);
    firstBatch.forEach((resolve) => resolve());
    await vi.waitFor(() => expect(runResolvers.length).toBeGreaterThanOrEqual(1));

    expect(runPromptPackTest).toHaveBeenCalledTimes(5);
    runResolvers.splice(0).forEach((resolve) => resolve());
    await task;

    expect(autoScorePromptPackTest).toHaveBeenCalledTimes(5);
    expect(benchmarkItems).toHaveLength(5);
    expect(benchmarkRun.status).toBe("completed");
    expect(benchmarkRun.completed_items).toBe(5);
    expect(
      publishRealtime.mock.calls.some(
        ([eventType, source, payload]) =>
          eventType === "prompt_pack_benchmark_completed" &&
          source === "promptLab" &&
          (payload as { benchmarkRunId?: string }).benchmarkRunId === benchmarkRun.benchmark_run_id,
      ),
    ).toBe(true);
  });

  it("cancels an in-flight benchmark without flipping it to failed", async () => {
    const test = createTest("test-benchmark-cancel", "TEST-BENCH-CANCEL");
    const benchmarkRun: {
      benchmark_run_id: string;
      pack_id: string;
      status: PromptPackBenchmarkStatusRecord["run"]["status"];
      test_codes_json: string;
      providers_json: string;
      total_items: number;
      completed_items: number;
      claimed_by_worker_id: string | null;
      claim_heartbeat_at: string | null;
      claim_expires_at: string | null;
      error: string | null;
      started_at: string;
      finished_at: string | null;
    } = {
      benchmark_run_id: "ppb-cancel-1",
      pack_id: "pack-1",
      status: "running",
      test_codes_json: JSON.stringify([test.code]),
      providers_json: JSON.stringify([{ providerId: "openai", model: "gpt-5.4" }]),
      total_items: 1,
      completed_items: 0,
      claimed_by_worker_id: null,
      claim_heartbeat_at: null,
      claim_expires_at: null,
      error: null as string | null,
      started_at: "2026-03-16T00:00:00.000Z",
      finished_at: null as string | null,
    };
    const benchmarkItems: Array<Record<string, unknown>> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const publishRealtime = vi.fn();
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listTests: () => [test],
          },
        },
        gatewaySql: {
          prepare: (sql: string) => ({
            get: (arg: string) => {
              if (sql.includes("FROM prompt_pack_benchmark_runs") && arg === benchmarkRun.benchmark_run_id) {
                return benchmarkRun;
              }
              return undefined;
            },
            all: (arg?: unknown) => {
              if (sql.includes("FROM prompt_pack_benchmark_runs") && sql.includes("status IN ('queued', 'running')")) {
                return [benchmarkRun];
              }
              if (sql.includes("FROM prompt_pack_benchmark_items") && arg === benchmarkRun.benchmark_run_id) {
                return benchmarkItems;
              }
              return [];
            },
            run: (params: Record<string, unknown>) => {
              if (sql.includes("INSERT INTO prompt_pack_benchmark_items")) {
                benchmarkItems.push({
                  item_id: String(params.itemId),
                  benchmark_run_id: String(params.benchmarkRunId),
                  pack_id: String(params.packId),
                  test_id: String(params.testId),
                  test_code: String(params.testCode),
                  provider_id: String(params.providerId),
                  model: String(params.model),
                  run_id: params.runId,
                  auto_score_id: params.autoScoreId,
                  run_status: params.runStatus,
                  weighted_score: params.weightedScore,
                  verdict: params.verdict,
                  score_state: params.scoreState,
                  failure_signal: params.failureSignal,
                  created_at: String(params.createdAt),
                });
              } else if (sql.includes("SET claim_heartbeat_at = @now")) {
                if (benchmarkRun.claimed_by_worker_id === String(params.workerId)) {
                  benchmarkRun.claim_heartbeat_at = String(params.now);
                  benchmarkRun.claim_expires_at = String(params.claimExpiresAt);
                  return { changes: 1 };
                }
                return { changes: 0 };
              } else if (sql.includes("status = 'completed'")) {
                benchmarkRun.status = "completed";
                benchmarkRun.finished_at = String(params.finishedAt);
                benchmarkRun.claimed_by_worker_id = null;
                benchmarkRun.claim_heartbeat_at = null;
                benchmarkRun.claim_expires_at = null;
              } else if (sql.includes("status = 'cancelled'")) {
                benchmarkRun.status = "cancelled";
                benchmarkRun.error = String(params.error);
                benchmarkRun.finished_at = String(params.finishedAt);
                benchmarkRun.claimed_by_worker_id = null;
                benchmarkRun.claim_heartbeat_at = null;
                benchmarkRun.claim_expires_at = null;
              } else if (sql.includes("status = 'failed'")) {
                benchmarkRun.status = "failed";
                benchmarkRun.error = String(params.error);
                benchmarkRun.finished_at = String(params.finishedAt);
                benchmarkRun.claimed_by_worker_id = null;
                benchmarkRun.claim_heartbeat_at = null;
                benchmarkRun.claim_expires_at = null;
              } else if (sql.includes("status = 'running'")) {
                if (benchmarkRun.status === "cancelled") {
                  return { changes: 0 };
                }
                benchmarkRun.status = "running";
                benchmarkRun.error = null;
                benchmarkRun.claimed_by_worker_id = String(params.workerId ?? "worker-test");
                benchmarkRun.claim_heartbeat_at = String(params.now ?? "2026-03-16T00:00:00.000Z");
                benchmarkRun.claim_expires_at = String(params.claimExpiresAt ?? "2026-03-16T00:02:00.000Z");
              } else if (sql.includes("SET completed_items = @completedItems")) {
                benchmarkRun.completed_items = Number(params.completedItems);
              }
              return { changes: 1 };
            },
          }),
        } as never,
        config: {
          assistant: {
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
        publishRealtime,
      } as never,
      {
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks,
      },
    );

    let resolveRun: ((value: PromptPackRunRecord) => void) | undefined;
    const runPromise = new Promise<PromptPackRunRecord>((resolve) => {
      resolveRun = resolve;
    });
    const completedRun: PromptPackRunRecord = {
      ...createRun("run-cancelled", "completed", "2026-03-16T00:01:00.000Z"),
      testId: test.testId,
      responseText: "Recovered before cancellation landed.",
      trace: createTrace("sess-cancelled"),
    };
    const runPromptPackTest = vi.spyOn(service, "runPromptPackTest").mockReturnValue(runPromise);
    const autoScorePromptPackTest = vi.spyOn(service, "autoScorePromptPackTest").mockResolvedValue({
      score: {
        autoScoreId: "auto-cancelled",
        weightedScore: 91,
        autoVerdict: "pass",
        scoreState: "auto_valid",
      },
      legacyScore: undefined,
      run: completedRun,
    } as never);

    expect(service.resumeInterruptedBenchmarkRuns()).toBe(1);
    await Promise.resolve();

    const cancelled = service.cancelPromptPackBenchmark(benchmarkRun.benchmark_run_id);
    expect(cancelled.run.status).toBe("cancelled");

    resolveRun?.(completedRun);
    await Promise.all([...backgroundTasks]);

    expect(runPromptPackTest).toHaveBeenCalledTimes(1);
    expect(autoScorePromptPackTest).not.toHaveBeenCalled();
    expect(benchmarkRun.status).toBe("cancelled");
    expect(benchmarkRun.error).toBe("Cancelled by operator.");
    expect(benchmarkItems).toHaveLength(0);
    expect(
      publishRealtime.mock.calls.some(
        ([eventType, source, payload]) =>
          eventType === "prompt_pack_benchmark_cancelled" &&
          source === "promptLab" &&
          (payload as { benchmarkRunId?: string }).benchmarkRunId === benchmarkRun.benchmark_run_id,
      ),
    ).toBe(true);
    expect(publishRealtime.mock.calls.some(([eventType]) => eventType === "prompt_pack_benchmark_completed")).toBe(
      false,
    );
  });

  it("does not resume a cancelled benchmark after service restart", async () => {
    const test = createTest("test-benchmark-restart-cancel", "TEST-BENCH-RESTART-CANCEL");
    const benchmarkRun: {
      benchmark_run_id: string;
      pack_id: string;
      status: PromptPackBenchmarkStatusRecord["run"]["status"];
      test_codes_json: string;
      providers_json: string;
      total_items: number;
      completed_items: number;
      claimed_by_worker_id: string | null;
      claim_heartbeat_at: string | null;
      claim_expires_at: string | null;
      error: string | null;
      started_at: string;
      finished_at: string | null;
    } = {
      benchmark_run_id: "ppb-restart-cancel-1",
      pack_id: "pack-1",
      status: "running",
      test_codes_json: JSON.stringify([test.code]),
      providers_json: JSON.stringify([{ providerId: "openai", model: "gpt-5.4" }]),
      total_items: 1,
      completed_items: 0,
      claimed_by_worker_id: null,
      claim_heartbeat_at: null,
      claim_expires_at: null,
      error: null,
      started_at: "2026-03-16T00:00:00.000Z",
      finished_at: null,
    };
    const benchmarkItems: Array<Record<string, unknown>> = [];
    const createGatewaySql = () =>
      ({
        prepare: (sql: string) => ({
          get: (arg: string) => {
            if (sql.includes("FROM prompt_pack_benchmark_runs") && arg === benchmarkRun.benchmark_run_id) {
              return benchmarkRun;
            }
            return undefined;
          },
          all: (_arg?: unknown) => {
            if (sql.includes("FROM prompt_pack_benchmark_runs") && sql.includes("status IN ('queued', 'running')")) {
              return benchmarkRun.status === "cancelled" ? [] : [benchmarkRun];
            }
            if (sql.includes("FROM prompt_pack_benchmark_items")) {
              return benchmarkItems;
            }
            return [];
          },
          run: (params: Record<string, unknown>) => {
            if (sql.includes("status = 'cancelled'")) {
              benchmarkRun.status = "cancelled";
              benchmarkRun.error = String(params.error);
              benchmarkRun.finished_at = String(params.finishedAt);
              benchmarkRun.claimed_by_worker_id = null;
              benchmarkRun.claim_heartbeat_at = null;
              benchmarkRun.claim_expires_at = null;
              return { changes: 1 };
            }
            return { changes: 0 };
          },
        }),
      }) as never;

    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listTests: () => [test],
          },
        },
        gatewaySql: createGatewaySql(),
        config: {
          assistant: {
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
        publishRealtime: vi.fn(),
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

    service.cancelPromptPackBenchmark(benchmarkRun.benchmark_run_id);

    const resumedService = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listTests: () => [test],
          },
        },
        gatewaySql: createGatewaySql(),
        config: {
          assistant: {
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
        publishRealtime: vi.fn(),
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

    expect(benchmarkRun.status).toBe("cancelled");
    expect(resumedService.resumeInterruptedBenchmarkRuns()).toBe(0);
  });

  it("prefers the newest completed run when auto-score selection has no explicit run id", () => {
    const latestFailed: PromptPackRunRecord = {
      ...createRun("run-latest-failed", "failed", "2026-03-14T00:10:00.000Z"),
      testId: "test-1",
    };
    const olderCompleted: PromptPackRunRecord = {
      ...createRun("run-older-completed", "completed", "2026-03-13T00:10:00.000Z"),
      testId: "test-1",
    };

    expect(pickPromptPackAutoScoreRun([latestFailed, olderCompleted])?.runId).toBe("run-older-completed");
  });
});
