import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type {
  PromptPackBenchmarkStatusRecord,
  ChatProjectRecord,
  PromptPackHumanReviewRecordV2,
  PromptPackRecord,
  PromptPackScoreRecordV2,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  PromptPackService,
  assertPromptPackRunScorable,
  buildPromptPackJudgeRecord,
  derivePromptPackResponseArtifacts,
  buildPromptPackSessionAllowedPaths,
  buildPromptPackSessionToolAllowlist,
  findPromptPackProjectBinding,
  finalizePromptPackResponseText,
  buildPromptPackSessionPrefsOverride,
  buildPromptPackReportSummary,
  pickPromptPackAutoScoreRun,
  buildPromptPackPromptInput,
  buildPromptPackCapabilitySeries,
  buildPromptPackRunFailureRateSeries,
  evaluatePromptPackRunIntegrity,
  evaluatePromptPackRuleScores,
  extractPromptPackCompletionText,
  mergePromptPackAutoScoresV2,
  normalizePromptPackJudgeScores,
  parsePromptPackTests,
  pickReplayBaselineScore,
  promptPackExecutionRequiresDurable,
  requiresPromptPackCitationEvidence,
  resolvePromptPackEffectiveJudgeStatusV2,
  resolvePromptPackRunIntegrity,
  resolvePromptPackJudgeTarget,
  resolvePromptPackJudgeTemperature,
  resolvePromptPackJudgeServiceTier,
  resolvePromptPackExecutionProfile,
  resolvePromptPackProjectBinding,
  ensurePromptPackDurableReadiness,
} from "./prompt-pack-service.js";
import { DEFAULT_PROMPT_PACK_POLICY_V2 } from "@goatcitadel/contracts";
import { hashPromptPackPolicyV2 } from "@goatcitadel/storage";

describe("prompt-pack helpers", () => {
  it("finds prompt-pack project bindings and prefers the jailed fixture workspace path", () => {
    const legacyProject: ChatProjectRecord = {
      projectId: "legacy-project",
      workspaceId: "default",
      name: "Prompt Lab Workspace",
      description: "Auto-created project binding for prompt-pack code evaluations.",
      workspacePath: ".",
      lifecycleStatus: "active",
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const currentProject: ChatProjectRecord = {
      ...legacyProject,
      projectId: "current-project",
      workspacePath: "fixtures/prompt-pack-workspace",
    };

    expect(findPromptPackProjectBinding([legacyProject])).toMatchObject({
      projectId: "legacy-project",
    });
    expect(findPromptPackProjectBinding([legacyProject, currentProject])).toMatchObject({
      projectId: "current-project",
    });
  });

  it("resolves repo-root project bindings for repo-native code prompts", () => {
    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-binding",
        packId: "pack-1",
        code: "TEST-BIND-01",
        title: "Repo Binding",
        prompt: "Based on the current GoatCitadel repo, inspect apps/gateway/src/services/prompt-pack-service.ts.",
        orderIndex: 0,
        mode: "code",
        toolTier: "implicit-tools",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    expect(
      resolvePromptPackProjectBinding(
        codeProfile,
        "Based on the current GoatCitadel repo, inspect apps/gateway/src/services/prompt-pack-service.ts.",
      )?.workspacePath,
    ).toBe("__prompt_pack_repo__");

    expect(
      resolvePromptPackProjectBinding(
        codeProfile,
        "Read fixtures/prompt-pack-workspace/package.json using file/code tools.",
      )?.workspacePath,
    ).toBe("fixtures/prompt-pack-workspace");

    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-binding",
        packId: "pack-1",
        code: "TEST-BIND-02",
        title: "Cowork Repo Binding",
        prompt:
          "Use file or code tools to inspect apps/gateway/src/services/skill-import-service.ts and summarize the next provenance checks.",
        orderIndex: 1,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    expect(
      resolvePromptPackProjectBinding(
        coworkProfile,
        "Use file or code tools to inspect apps/gateway/src/services/skill-import-service.ts and summarize the next provenance checks.",
      )?.workspacePath,
    ).toBe("__prompt_pack_repo__");

    const implicitRepoChatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat-binding",
        packId: "pack-1",
        code: "TEST-BIND-03",
        title: "Implicit Repo Chat Binding",
        prompt:
          "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
        orderIndex: 2,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    expect(
      resolvePromptPackProjectBinding(
        implicitRepoChatProfile,
        "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
      )?.workspacePath,
    ).toBe("__prompt_pack_repo__");
  });

  it("resolves no-tools profiles and honors mode presets", () => {
    const noToolsProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-no-tools",
        packId: "pack-1",
        code: "TEST-01",
        title: "No Tools",
        prompt: "Answer only from the prompt.",
        orderIndex: 0,
        mode: "chat",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(noToolsProfile).toEqual({
      mode: "chat",
      toolTier: "no-tools",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
    });

    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code",
        packId: "pack-1",
        code: "TEST-02",
        title: "Code",
        prompt: "Inspect the repo and explain the fix.",
        orderIndex: 1,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(codeProfile.mode).toBe("code");
    expect(codeProfile.toolTier).toBe("explicit-tools");
    expect(codeProfile.toolAutonomy).toBe("safe_auto");
    expect(codeProfile.webMode).toBe("auto");
    expect(codeProfile.memoryMode).toBe("auto");
    expect(codeProfile.thinkingLevel).toBe("extended");
  });

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
            listTests: () =>
              [
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

  it("derives prompt-pack helper text without overwriting non-empty raw output", () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Inspect the current prompt-pack markdown import path.",
      "",
      "## User Task",
      "For prompt-pack markdown import, inspect the repo and explain how prompt-pack markdown is auto-loaded and imported.",
    ].join("\n");

    const derived = derivePromptPackResponseArtifacts({
      prompt,
      rawResponseText: "",
      trace: {
        ...createTrace("sess-derived-artifacts"),
        toolRuns: [
          {
            toolRunId: "tool-service-read",
            turnId: "turn-derived-artifacts",
            sessionId: "sess-derived-artifacts",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content:
                'ensurePromptPackLoaded();\nawait fs.readFile(promptPackPath, "utf8");\nimportPromptPack(markdown, { sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE });',
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
          {
            toolRunId: "tool-route-read",
            turnId: "turn-derived-artifacts",
            sessionId: "sess-derived-artifacts",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
            },
            result: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
              content: "fastify.post('/api/v1/prompt-packs/import', async () => fastify.gateway.importPromptPack());",
            },
            startedAt: "2026-03-14T00:00:00.500Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
        ],
      },
    });

    expect(derived.derivedResponseSignals).toEqual(["prompt_lab_contract_fallback"]);
    expect(derived.derivedResponseText).toContain("Observed import/load path:");
    expect(derived.derivedResponseText).toContain("POST /api/v1/prompt-packs/import");

    expect(
      derivePromptPackResponseArtifacts({
        prompt,
        rawResponseText: "Raw answer stays canonical.",
        trace: createTrace("sess-derived-nonempty"),
      }),
    ).toEqual({});
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
                benchmarkItems.push({
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
    expect(
      publishRealtime.mock.calls.some(([eventType]) => eventType === "prompt_pack_benchmark_completed"),
    ).toBe(false);
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

  it("penalizes missing required tool usage for explicit-tools runs", () => {
    const test: PromptPackTestRecord = {
      testId: "test-explicit",
      packId: "pack-1",
      code: "TEST-03",
      title: "Explicit Tools",
      prompt: "Look up the docs and explain the result.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-explicit",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: "Here is the answer.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.routingScore).toBe(0);
    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.signals).toContain("missing_required_tool_usage");
  });

  it("treats blocked explicit-tool attempts as attempted usage", () => {
    const test: PromptPackTestRecord = {
      testId: "test-explicit-attempted",
      packId: "pack-1",
      code: "TEST-03B",
      title: "Explicit Tools Attempted",
      prompt: "Use browser.navigate to open the URL and report exactly what failed.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-explicit-attempted",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "chat",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        responseText: "browser.navigate failed with fetch failed.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.navigate",
              status: "blocked",
              error: "execution error: fetch failed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.routingScore).toBe(1);
    expect(evaluation.signals).toContain("required_tool_usage_attempted");
    expect(evaluation.signals).not.toContain("missing_required_tool_usage");
  });

  it("penalizes self-reported partial outputs even when tools executed", () => {
    const test: PromptPackTestRecord = {
      testId: "test-partial",
      packId: "pack-1",
      code: "TEST-04",
      title: "Partial",
      prompt: "Use tools to extract the full JSON payload and verify all fields.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-partial",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "This is a partial answer recovered from tool output because the final synthesis pass did not finish cleanly.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.navigate",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
            {
              toolRunId: "tool-2",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "memory.read",
              status: "blocked",
              error: "Unsupported tool executor: memory.read",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.scores.usabilityScore).toBe(0);
    expect(evaluation.signals).toContain("self_reported_incomplete_output");
    expect(evaluation.signals).toContain("tool_blockers_prevented_completion");
  });

  it("does not treat a blocked tool report as incomplete output by itself", () => {
    const test: PromptPackTestRecord = {
      testId: "test-blocked-report",
      packId: "pack-1",
      code: "TEST-C23",
      title: "Blocked report",
      prompt: "Attempt browser.navigate and report the blocked tool path exactly if access is denied.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-blocked-report",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "chat",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        responseText: "browser.navigate was blocked by policy, so I cannot claim the page contents.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.navigate",
              status: "blocked",
              error: "policy denied browser.navigate",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.signals).not.toContain("self_reported_incomplete_output");
    expect(evaluation.scores.robustnessScore).toBe(2);
  });

  it("builds deterministic session overrides for prompt-pack runs", () => {
    const chatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat",
        packId: "pack-1",
        code: "TEST-04",
        title: "Chat",
        prompt: "Answer directly.",
        orderIndex: 0,
        mode: "chat",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(chatProfile)).toMatchObject({
      mode: "chat",
      planningMode: "off",
      orchestrationEnabled: false,
      orchestrationParallelism: "sequential",
    });
    expect(
      buildPromptPackSessionPrefsOverride(
        resolvePromptPackExecutionProfile({
          test: {
            testId: "test-chat-repo-inspect",
            packId: "pack-1",
            code: "TEST-04A",
            title: "Chat Repo Inspect",
            prompt: "Inspect the repo if needed and explain the current guidance-loading chain.",
            orderIndex: 0,
            mode: "chat",
            toolTier: "implicit-tools",
            createdAt: "2026-03-14T00:00:00.000Z",
          },
        }),
        "Inspect the repo if needed and explain the current guidance-loading chain.",
      ),
    ).toMatchObject({
      webMode: "off",
      memoryMode: "off",
    });

    const noToolsCodeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-no-tools",
        packId: "pack-1",
        code: "TEST-04B",
        title: "Code No Tools",
        prompt: "Answer without tools.",
        orderIndex: 0,
        mode: "code",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(noToolsCodeProfile)).toMatchObject({
      mode: "code",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
    });

    const noToolsCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-no-tools",
        packId: "pack-1",
        code: "TEST-04C",
        title: "Cowork No Tools",
        prompt: "Analyze and synthesize without tools.",
        orderIndex: 0,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(noToolsCoworkProfile)).toMatchObject({
      mode: "cowork",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
    });

    expect(
      buildPromptPackSessionPrefsOverride(
        noToolsCoworkProfile,
        "Analyze the decision from 3 perspectives: CTO, VP Sales, and Developer Relations. End with one synthesized recommendation.",
      ),
    ).toMatchObject({
      orchestrationEnabled: false,
    });

    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-2",
        packId: "pack-1",
        code: "TEST-05",
        title: "Code",
        prompt: "Inspect files and fix the issue.",
        orderIndex: 1,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(codeProfile)).toMatchObject({
      mode: "code",
      planningMode: "off",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "safe_auto",
    });

    expect(
      buildPromptPackSessionPrefsOverride(
        codeProfile,
        "Read fixtures/prompt-pack-workspace/package.json using file tools.",
      ),
    ).toMatchObject({
      webMode: "off",
      memoryMode: "off",
    });

    expect(
      buildPromptPackSessionPrefsOverride(
        codeProfile,
        "Read package.json using file tools, then use browser.search to check the latest versions.",
      ),
    ).toMatchObject({
      webMode: "auto",
      memoryMode: "off",
    });

    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-explicit-2",
        packId: "pack-1",
        code: "TEST-06",
        title: "Cowork Explicit Tools",
        prompt: "Read local files using file/code tools and produce a role-labeled review.",
        orderIndex: 2,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(coworkProfile)).toMatchObject({
      mode: "cowork",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "safe_auto",
    });
  });

  it("builds prompt-pack session tool allowlists from mode and explicit directives", () => {
    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-01",
        title: "Code Tools",
        prompt: "Read local project files and implement a fix.",
        orderIndex: 0,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionToolAllowlist(codeProfile)).toEqual([
      "fs.read",
      "fs.list",
      "fs.stat",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "tests.run",
      "lint.run",
    ]);

    expect(
      buildPromptPackSessionToolAllowlist(
        codeProfile,
        "Run pnpm test and capture the command output before summarizing the repo state.",
      ),
    ).toEqual([
      "fs.read",
      "fs.list",
      "fs.stat",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "tests.run",
      "lint.run",
      "shell.exec",
    ]);

    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-02",
        title: "Cowork Tools",
        prompt:
          "Read fixtures/prompt-pack-workspace/package.json using file tools, then use browser.search to compare versions.",
        orderIndex: 1,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        "Read fixtures/prompt-pack-workspace/package.json using file tools, then use browser.search to compare versions.",
      ),
    ).toEqual([
      "fs.read",
      "fs.list",
      "fs.stat",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "browser.search",
    ]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        "Use session.status, time.now, git.status, build.run, browser.context.configure, and browser.cookies.get, then explain what worked.",
      ),
    ).toEqual([
      "session.status",
      "time.now",
      "build.run",
      "git.status",
      "browser.cookies.get",
      "browser.context.configure",
    ]);

    const noToolsProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-no-tools-allowlist",
        packId: "pack-1",
        code: "TEST-TOOLS-03",
        title: "No Tools",
        prompt: "Answer directly.",
        orderIndex: 2,
        mode: "chat",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionToolAllowlist(noToolsProfile, "Use browser.search if needed.")).toEqual([]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        "Use only file/code tools on fixtures/prompt-pack-workspace and produce an audit.",
      ),
    ).toEqual(
      expect.arrayContaining([
        "fs.read",
        "fs.list",
        "fs.stat",
        "file.read_range",
        "file.find",
        "code.search",
        "code.search_files",
      ]),
    );

    const implicitRepoChatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat-repo-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-04",
        title: "Implicit Repo Chat Tools",
        prompt:
          "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
        orderIndex: 3,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionToolAllowlist(
        implicitRepoChatProfile,
        "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
      ),
    ).toEqual(
      expect.arrayContaining([
        "fs.read",
        "fs.list",
        "fs.stat",
        "file.read_range",
        "file.find",
        "code.search",
        "code.search_files",
      ]),
    );

    const implicitRepoCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-repo-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-05",
        title: "Implicit Repo Cowork Tools",
        prompt:
          "Inspect the repo if needed and produce role-labeled sections describing paused versus waiting wake handling. Cite the exact files used.",
        orderIndex: 4,
        mode: "cowork",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionToolAllowlist(
        implicitRepoCoworkProfile,
        "Inspect the repo if needed and produce role-labeled sections describing paused versus waiting wake handling. Cite the exact files used.",
      ),
    ).toEqual(
      expect.arrayContaining([
        "fs.read",
        "fs.list",
        "fs.stat",
        "file.read_range",
        "file.find",
        "code.search",
        "code.search_files",
      ]),
    );
  });

  it("builds path-scoped read grants for prompt-pack sessions", () => {
    const rootDir = "F:/code/personal-ai";
    const workspaceRoot = "F:/code/personal-ai/workspace";
    expect(
      buildPromptPackSessionAllowedPaths({
        prompt: "Based on the current GoatCitadel repo, inspect apps/gateway/src/services/prompt-pack-service.ts.",
        rootDir,
        workspaceRoot,
        projectWorkspacePath: "__prompt_pack_repo__",
      }),
    ).toEqual(
      expect.arrayContaining([
        "F:\\code\\personal-ai",
        "F:\\code\\personal-ai\\apps\\gateway\\src\\services\\prompt-pack-service.ts",
        "F:\\code\\personal-ai\\apps\\gateway\\src\\services",
      ]),
    );

    expect(
      buildPromptPackSessionAllowedPaths({
        prompt: [
          "Read these files using file/code tools:",
          "- `F:/code/sql-teacher/lib/db/sandbox.ts`",
          "- `F:/code/sql-teacher/lib/db/security.ts`",
        ].join("\n"),
        rootDir,
        workspaceRoot,
      }),
    ).toEqual(
      expect.arrayContaining([
        "F:\\code\\sql-teacher\\lib\\db\\sandbox.ts",
        "F:\\code\\sql-teacher\\lib\\db",
        "F:\\code\\sql-teacher\\lib\\db\\security.ts",
      ]),
    );

    expect(
      buildPromptPackSessionAllowedPaths({
        prompt: "Use only file/code tools on fixtures/prompt-pack-workspace to inspect package.json.",
        rootDir,
        workspaceRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      }),
    ).toEqual(
      expect.arrayContaining([
        "F:\\code\\personal-ai\\workspace\\fixtures\\prompt-pack-workspace",
        "F:\\code\\personal-ai\\workspace\\fixtures\\prompt-pack-workspace\\fixtures\\prompt-pack-workspace",
      ]),
    );
  });

  it("wraps cowork, code, and explicit-tools prompts with prompt-lab contracts", () => {
    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-01",
        title: "Cowork Contract",
        prompt: "Map the tradeoffs and recommend a path.",
        orderIndex: 0,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const coworkInput = buildPromptPackPromptInput("Map the tradeoffs and recommend a path.", coworkProfile);
    expect(coworkInput.prompt).toContain("## Prompt Lab Run Contract");
    expect(coworkInput.prompt).toContain("This is a Cowork evaluation");
    expect(coworkInput.prompt).toContain("use at least two role-labeled sections");
    expect(coworkInput.prompt).toContain("end with a synthesis");
    expect(coworkInput.prompt).toContain("Do not grade, critique, review, or revise an imagined draft");

    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-02",
        title: "Code Contract",
        prompt: "Inspect the repo and explain the fix.",
        orderIndex: 1,
        mode: "code",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const codeInput = buildPromptPackPromptInput("Inspect the repo and explain the fix.", codeProfile);
    expect(codeInput.prompt).toContain("This is a Code evaluation");
    expect(codeInput.prompt).toContain("name the exact file paths");
    expect(codeInput.prompt).toContain("Do not say `based on my inspection`");
    expect(codeInput.prompt).toContain(
      "Do not claim validation or execution unless you include the exact command/check and the result.",
    );
    expect(codeInput.prompt).toContain("Do not name scripts, frameworks, folders, or commands by convention alone.");
    expect(codeInput.prompt).toContain("separate Observed, Inferred, and Unverified statements");
    expect(codeInput.prompt).toContain("Do not claim commands such as `pnpm outdated`");

    const explicitToolsProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-explicit-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-03",
        title: "Explicit Tools Contract",
        prompt: "Read package.json using file/code tools, then use browser.search to compare versions.",
        orderIndex: 2,
        mode: "chat",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const explicitToolsInput = buildPromptPackPromptInput(
      "Read package.json using file/code tools, then use browser.search to compare versions.",
      explicitToolsProfile,
    );
    expect(explicitToolsInput.prompt).toContain("This is an explicit-tools evaluation");
    expect(explicitToolsInput.prompt).toContain(
      "Before drafting findings or recommendations, execute the required tool calls",
    );
    expect(explicitToolsInput.prompt).toContain("Required named tools: `browser.search`");
    expect(explicitToolsInput.prompt).toContain("Required tool families: file/code tools");
    expect(explicitToolsInput.prompt).toContain("Surface tool-backed evidence in the answer.");
    expect(explicitToolsInput.prompt).toContain(
      "A prose-only answer without the required tool evidence is non-compliant.",
    );
    expect(explicitToolsInput.prompt).toContain(
      "If a file/code read is truncated, partial, blocked, or unexpectedly sparse, continue with narrower range reads",
    );
    expect(explicitToolsInput.prompt).toContain("do not write `based on my inspection`");
    expect(explicitToolsInput.prompt).toContain(
      "If local file paths are listed, inspect those paths before answering.",
    );

    const implicitRepoChatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat-repo-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-03B",
        title: "Repo Chat Contract",
        prompt: "Inspect the repo if needed and explain what is currently loaded today.",
        orderIndex: 3,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const implicitRepoChatInput = buildPromptPackPromptInput(
      "Inspect the repo if needed and explain what is currently loaded today.",
      implicitRepoChatProfile,
    );
    expect(implicitRepoChatInput.prompt).toContain("This is a repo-grounded chat evaluation.");
    expect(implicitRepoChatInput.prompt).toContain("Repo inspection assist: enabled.");
    expect(implicitRepoChatInput.prompt).toContain("separate Observed, Inferred, and Unverified claims");

    const explicitCodeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-explicit-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-04",
        title: "Explicit Code Contract",
        prompt:
          "Read all source files in fixtures/prompt-pack-workspace/ using file tools, then produce an audit report.",
        orderIndex: 3,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const explicitCodeInput = buildPromptPackPromptInput(
      "Read all source files in fixtures/prompt-pack-workspace/ using file tools, then produce an audit report.",
      explicitCodeProfile,
    );
    expect(explicitCodeInput.prompt).toContain("Prefer file/code tools for read-only inspection or audits.");
    expect(explicitCodeInput.prompt).toContain(
      "Do not use `shell.exec` unless the prompt explicitly requires command execution or a shell-only check.",
    );
    expect(explicitCodeInput.prompt).toContain(
      "Available file/code tools in this run include `fs.read`, `fs.list`, `fs.stat`, `file.read_range`, `file.find`, `code.search`, and `code.search_files`.",
    );
    expect(explicitCodeInput.prompt).toContain(
      "Keep file/code reads inside the prompt-listed scope unless another path is explicitly required",
    );

    const exactSectionCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-05",
        title: "Cowork Contract",
        prompt: [
          "Assess whether to adopt event sourcing for a billing system.",
          "Weigh architecture impact, finance/compliance implications, and incident-response tradeoffs.",
          "Only the controller should speak in the final answer.",
          "Output exactly these sections in this order:",
          "- Status Snapshot",
          "- Final Recommendation",
        ].join("\n"),
        orderIndex: 4,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const exactSectionCoworkInput = buildPromptPackPromptInput(
      [
        "Assess whether to adopt event sourcing for a billing system.",
        "Weigh architecture impact, finance/compliance implications, and incident-response tradeoffs.",
        "Only the controller should speak in the final answer.",
        "Output exactly these sections in this order:",
        "- Status Snapshot",
        "- Final Recommendation",
        "",
        "Use browser.interact and http.post if needed.",
      ].join("\n"),
      exactSectionCoworkProfile,
    );
    expect(exactSectionCoworkInput.prompt).toContain(
      "Output exactly these top-level sections in this order: `Status Snapshot`, `Final Recommendation`.",
    );
    expect(exactSectionCoworkInput.prompt).toContain(
      "Cover exactly these named perspectives/lenses: `architecture impact`, `finance/compliance implications`, `incident-response tradeoffs`.",
    );
    expect(exactSectionCoworkInput.prompt).toContain(
      "Use each named perspective/lens verbatim as its own compact subsection before the final recommendation.",
    );
    expect(exactSectionCoworkInput.prompt).toContain("Keep the final answer controller-owned.");
    expect(exactSectionCoworkInput.prompt).toContain("For `browser.interact`, send an explicit `steps` array.");
  });

  it("derives exact cowork role order from title metadata when the prompt only references the requested order", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-title-roles",
        packId: "pack-1",
        code: "TEST-W101",
        title: "Roles in order Product, Architect, QA",
        prompt:
          "Create a short role-labeled plan for how GoatCitadel prompt-pack v2 should test recently added functionality without repeating the old 108-test balance. Keep the sections in the requested role order.",
        orderIndex: 5,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Create a short role-labeled plan for how GoatCitadel prompt-pack v2 should test recently added functionality without repeating the old 108-test balance. Keep the sections in the requested role order.",
      profile,
      "Roles in order Product, Architect, QA",
    );

    expect(promptInput.prompt).toContain(
      "Output exactly these top-level sections in this order: `Product`, `Architect`, `QA`, `Synthesis`.",
    );
    expect(promptInput.prompt).toContain("Do not add extra headings before, between, or after those sections.");
  });

  it("does not append synthesis when the prompt says to keep the requested role order only", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-title-roles-only",
        packId: "pack-1",
        code: "TEST-W125",
        title: "Roles in order Product, QA",
        prompt:
          "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
        orderIndex: 6,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
      profile,
      "Roles in order Product, QA",
    );

    expect(promptInput.prompt).toContain("Output exactly these top-level sections in this order: `Product`, `QA`.");
    expect(promptInput.prompt).not.toContain("`Product`, `QA`, `Synthesis`");
  });

  it("treats no-synthesis cowork prompts as exact requested-role order runs", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-no-synthesis",
        packId: "pack-1",
        code: "TEST-W103",
        title: "Roles in order Product, Ops",
        prompt:
          "Draft a role-labeled recovery plan for unstable prompt-pack baselines. Keep the sections in the requested order. Do not add a synthesis section.",
        orderIndex: 7,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Draft a role-labeled recovery plan for unstable prompt-pack baselines. Keep the sections in the requested order. Do not add a synthesis section.",
      profile,
      "Roles in order Product, Ops",
    );

    expect(promptInput.prompt).toContain("Output exactly these top-level sections in this order: `Product`, `Ops`.");
    expect(promptInput.prompt).toContain(
      "Use only those top-level sections. Do not add Synthesis, Conclusion, Final Answer, Summary, or extra subheadings.",
    );
    expect(promptInput.prompt).not.toContain("`Product`, `Ops`, `Synthesis`");
  });

  it("adds a global length cap for no-tools requested-order cowork runs", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-length-cap",
        packId: "pack-1",
        code: "TEST-W102",
        title: "Roles in order Researcher, QA",
        prompt:
          "Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.",
        orderIndex: 7,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.",
      profile,
      "Roles in order Researcher, QA",
    );

    expect(promptInput.prompt).toContain("Keep the whole answer under about 220 words unless the prompt explicitly requires more detail.");
  });

  it("tells explicit file/code runs not to search for output-contract labels literally", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-explicit-label-search-guard",
        packId: "pack-1",
        code: "TEST-C149",
        title: "Exact evidence for operator truth labeling",
        prompt:
          "Use file or code tools to inspect Mission Control approvals, runtime, and live-feed UI plus the related APIs. Cite the exact files used.",
        orderIndex: 8,
        mode: "chat",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Use file or code tools to inspect Mission Control approvals, runtime, and live-feed UI plus the related APIs. Cite the exact files used.",
      profile,
    );

    expect(promptInput.prompt).toContain("Do not search the repo for the output-contract labels themselves");
    expect(promptInput.prompt).toContain("After path discovery returns likely matches, read at least one concrete implementation file");
    expect(promptInput.prompt).toContain(
      "For exact-evidence, exact-file, exact-patch-point, or exact-rollout-wiring asks, a pure path-discovery pass is not enough.",
    );
    expect(promptInput.prompt).toContain(
      "Do not stop after only `code.search_files` or `file.find` hits when the prompt asks for exact grounding.",
    );
  });

  it("only requires citation evidence when the prompt actually asks for file-grounded citations", () => {
    expect(requiresPromptPackCitationEvidence("Separate policy from implementation evidence.")).toBe(false);
    expect(requiresPromptPackCitationEvidence("Explain the result and cite the exact files used.")).toBe(true);
    expect(requiresPromptPackCitationEvidence("Include line numbers for each claim.")).toBe(true);
  });

  it("does not append generic constraints boilerplate to non-empty prompt-pack answers", () => {
    const response = finalizePromptPackResponseText({
      prompt: "Use browser.navigate and summarize the page.",
      responseText: "Here is the grounded summary.",
      trace: {
        turnId: "turn-1",
        sessionId: "sess-1",
        userMessageId: "user-1",
        branchKind: "append",
        status: "completed",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-1",
            turnId: "turn-1",
            sessionId: "sess-1",
            toolName: "browser.navigate",
            status: "blocked",
            error: "execution error: fetch failed",
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
        ],
        citations: [],
        routing: {},
      },
    });

    expect(response).toBe("Here is the grounded summary.");
    expect(response).not.toContain("## Constraints");
  });

  it("does not append synthetic cowork scaffold sections when the answer is non-empty", () => {
    const response = finalizePromptPackResponseText({
      prompt: [
        "## Prompt Lab Run Contract",
        "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
        "- For non-trivial tasks, use at least two role-labeled sections chosen from Product, Researcher, Architect, Coder, QA, or Ops, then end with a synthesis.",
        "",
        "## User Task",
        "Figure out the next migration step.",
      ].join("\n"),
      responseText: "### Product\n- Goal: Ship the migration safely.",
      trace: {
        turnId: "turn-1",
        sessionId: "sess-1",
        userMessageId: "user-1",
        branchKind: "append",
        status: "completed",
        mode: "cowork",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
      },
    });

    expect(response).toBe("### Product\n- Goal: Ship the migration safely.");
  });

  it("does not append cowork scaffold sections to prompt-pack fallback responses", () => {
    const response = finalizePromptPackResponseText({
      prompt: [
        "## Prompt Lab Run Contract",
        "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
        "- For non-trivial tasks, use at least two role-labeled sections chosen from Product, Researcher, Architect, Coder, QA, or Ops, then end with a synthesis.",
        "",
        "## User Task",
        "Audit these files using file/code tools only.",
      ].join("\n"),
      responseText: [
        "I couldn't verify that with the required tools before answering.",
        "",
        "Missing required tool evidence: file/code tools.",
        "A file-specific or source-backed answer would be speculative here, so I’m stopping instead of bluffing.",
      ].join("\n"),
      trace: {
        turnId: "turn-1",
        sessionId: "sess-1",
        userMessageId: "user-1",
        branchKind: "append",
        status: "completed",
        mode: "cowork",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
      },
    });

    expect(response).not.toContain("## Role Handoff Scaffold");
    expect(response).toContain("I couldn't verify that with the required tools before answering.");
  });

  it("uses prompt-pack-specific missing-output repair only on the prompt-pack execution path", () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Inspect the current prompt-pack markdown import path.",
      "",
      "## User Task",
      "For prompt-pack markdown import, inspect the repo and explain how markdown is auto-loaded and imported.",
    ].join("\n");

    const response = finalizePromptPackResponseText({
      prompt,
      responseText: "",
      trace: {
        turnId: "turn-prompt-pack-fallback",
        sessionId: "sess-prompt-pack-fallback",
        userMessageId: "user-prompt-pack-fallback",
        branchKind: "append",
        status: "failed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-service-read",
            turnId: "turn-prompt-pack-fallback",
            sessionId: "sess-prompt-pack-fallback",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content:
                "ensurePromptPackLoaded();\nawait fs.readFile(promptPackPath, \"utf8\");\nimportPromptPack(markdown, { sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE });",
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
          {
            toolRunId: "tool-route-read",
            turnId: "turn-prompt-pack-fallback",
            sessionId: "sess-prompt-pack-fallback",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
            },
            result: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
              content: "fastify.post('/api/v1/prompt-packs/import', async () => fastify.gateway.importPromptPack());",
            },
            startedAt: "2026-03-14T00:00:00.500Z",
            finishedAt: "2026-03-14T00:00:00.900Z",
          },
        ],
        citations: [],
        routing: {},
      },
    });

    expect(response).toContain("Observed import/load path:");
    expect(response).toContain("apps/gateway/src/services/prompt-pack-service.ts");
    expect(response).toContain("POST /api/v1/prompt-packs/import");
  });

  it("keeps non-empty prompt-pack responses verbatim even when prompt-pack repair would be available", () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Inspect the current prompt-pack markdown import path.",
      "",
      "## User Task",
      "For prompt-pack markdown import, inspect the repo and explain how markdown is auto-loaded and imported.",
    ].join("\n");

    const response = finalizePromptPackResponseText({
      prompt,
      responseText: "I already inspected the repo and this answer should stay verbatim.",
      trace: {
        turnId: "turn-prompt-pack-verbatim",
        sessionId: "sess-prompt-pack-verbatim",
        userMessageId: "user-prompt-pack-verbatim",
        branchKind: "append",
        status: "completed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-service-read",
            turnId: "turn-prompt-pack-verbatim",
            sessionId: "sess-prompt-pack-verbatim",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content:
                "ensurePromptPackLoaded();\nawait fs.readFile(promptPackPath, \"utf8\");\nimportPromptPack(markdown, { sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE });",
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
        ],
        citations: [],
        routing: {},
      },
    });

    expect(response).toBe("I already inspected the repo and this answer should stay verbatim.");
  });

  it("builds a deterministic missing-output fallback from captured tool evidence", () => {
    const response = finalizePromptPackResponseText({
      prompt: "Use file/code tools to inspect the repo and cite exact files.",
      responseText: "",
      trace: {
        turnId: "turn-missing-output",
        sessionId: "sess-missing-output",
        userMessageId: "user-missing-output",
        branchKind: "append",
        status: "failed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-search",
            turnId: "turn-missing-output",
            sessionId: "sess-missing-output",
            toolName: "code.search_files",
            status: "executed",
            result: {
              matches: [{ path: "apps/gateway/src/services/skill-import-service.ts" }],
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
        ],
        citations: [],
        routing: {},
        failure: {
          failureClass: "unknown",
          message: "The provider stopped before the answer finished.",
        },
      },
    });

    expect(response).toContain("fell back to the captured tool evidence");
    expect(response).toContain("code.search_files");
    expect(response).toContain("apps/gateway/src/services/skill-import-service.ts");
  });

  it("does not require JSON output when the prompt explicitly forbids JSON", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: [
        "Use file or code tools to inspect how repo-managed imported skills record trust metadata in `skills/extra/<skill-id>/`.",
        "Return exactly three bullets labeled `Observed fields`, `Operator-usable fields`, and `Still ambiguous`.",
        "Do not return JSON.",
      ].join(" "),
      responseText: [
        "- **Observed fields** - `sourceProvider` and `sourceRef` are persisted in the stored manifest.",
        "- **Operator-usable fields** - Operators can rely on the stored source reference and canonical key when reviewing imports.",
        "- **Still ambiguous** - Risk scoring provenance is not exposed in the same manifest.",
      ].join("\n"),
      trace: createTrace("sess-no-json-required"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("missing_requested_json_output");
  });

  it("does not require table output when the prompt explicitly forbids a table", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: [
        "Use file or code tools to inspect lifecycle assembly, approval linkage loading, realtime-event linkage, and Mission Control approvals or runtime views.",
        "Use exactly three bullets labeled `Canonical path`, `Inference path`, and `Fallback gap`.",
        "Do not return a table.",
      ].join(" "),
      responseText: [
        "- **Canonical path** - Stored lifecycle state comes from the runtime lifecycle persistence layer.",
        "- **Inference path** - UI responses may infer missing links from adjacent events or preview payloads.",
        "- **Fallback gap** - Missing canonical linkage remains unresolved without a direct persisted field.",
      ].join("\n"),
      trace: createTrace("sess-no-table-required"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("missing_requested_table_output");
  });

  it("does not flag missing requested JSON in rule scores when the prompt forbids JSON", () => {
    const test: PromptPackTestRecord = {
      testId: "test-no-json-output",
      packId: "pack-1",
      code: "TEST-NO-JSON",
      title: "No JSON output",
      prompt: "Summarize the trust metadata in three bullets. Do not return JSON.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "no-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-no-json-output",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-no-json-output",
        status: "completed",
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        responseText: "- Observed fields: source metadata is persisted.\n- Operator fields: canonical references remain visible.\n- Still ambiguous: confidence scoring is not surfaced.",
        trace: createTrace("sess-no-json-output"),
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.signals).not.toContain("missing_requested_json_output");
  });

  it("does not flag missing requested table output in rule scores when the prompt forbids tables", () => {
    const test: PromptPackTestRecord = {
      testId: "test-no-table-output",
      packId: "pack-1",
      code: "TEST-NO-TABLE",
      title: "No table output",
      prompt: "Summarize the lifecycle linkage in three bullets. Do not return a table.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "no-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-no-table-output",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-no-table-output",
        status: "completed",
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        responseText: "- Canonical path: lifecycle state is persisted.\n- Inference path: some views reconstruct links.\n- Fallback gap: a direct persisted linkage is still missing.",
        trace: createTrace("sess-no-table-output"),
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.signals).not.toContain("missing_requested_table_output");
  });

  it("uses kimi-compatible temperature for prompt-pack model judging", () => {
    expect(resolvePromptPackJudgeTemperature("moonshot", "moonshot/kimi-k2.5")).toBe(1);
    expect(resolvePromptPackJudgeTemperature("openai", "gpt-5")).toBe(0);
    expect(resolvePromptPackJudgeTemperature(undefined, "kimi-k2")).toBe(1);
  });

  it("uses flex processing only for OpenAI prompt-pack judging", () => {
    expect(resolvePromptPackJudgeServiceTier("openai")).toBe("flex");
    expect(resolvePromptPackJudgeServiceTier("moonshot")).toBeUndefined();
    expect(resolvePromptPackJudgeServiceTier(undefined)).toBeUndefined();
  });

  it("prefers the default judge target for kimi and local runtime families", () => {
    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "glm",
        runModel: "glm-5-turbo",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "glm",
      model: "glm-5-turbo",
    });

    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "moonshot",
        runModel: "kimi-k2.5",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "openai",
      model: "gpt-5.4",
    });

    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "ollama",
        runModel: "qwen3.5:9b",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "openai",
      model: "gpt-5.4",
    });

    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "llamacpp",
        runModel: "gemma-4",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "openai",
      model: "gpt-5.4",
    });
  });

  it("penalizes concrete table requests that detour into meta analysis", () => {
    const test: PromptPackTestRecord = {
      testId: "test-table-detour",
      packId: "pack-1",
      code: "TEST-06",
      title: "Table Detour",
      prompt: "Use browser.search to compare three libraries and present them in a table with stars and open issues.",
      orderIndex: 0,
      mode: "cowork",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-table-detour",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: [
          "**Critique: Methodological Weaknesses in Library Comparison**",
          "",
          "### 1. Stars Are a Lagging Popularity Indicator",
          "",
          "**Blind spot:** Open issues count is misleading.",
        ].join("\n"),
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.search",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.routingScore).toBe(0);
    expect(evaluation.scores.usabilityScore).toBe(0);
    expect(evaluation.signals).toContain("missing_requested_table_output");
    expect(evaluation.signals).toContain("off_target_meta_analysis");
  });

  it("scores prompt-pack summaries from the latest run per test only", () => {
    const tests: PromptPackTestRecord[] = [
      {
        testId: "test-1",
        packId: "pack-1",
        code: "TEST-01",
        title: "First",
        prompt: "First prompt",
        orderIndex: 0,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
      {
        testId: "test-2",
        packId: "pack-1",
        code: "TEST-02",
        title: "Second",
        prompt: "Second prompt",
        orderIndex: 1,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    ];
    const runs: PromptPackRunRecord[] = [
      {
        ...createRun("run-1-new", "completed", "2026-03-15T00:00:00.000Z"),
        testId: "test-1",
        trace: {
          turnId: "turn-1-new",
          sessionId: "sess-run-1-new",
          userMessageId: "msg-1",
          branchKind: "append",
          status: "completed",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          startedAt: "2026-03-15T00:00:00.000Z",
          finishedAt: "2026-03-15T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
          durable: {
            runId: "dur-run-1",
            status: "completed",
            checkpointKind: "run_completed",
          },
        },
      },
      {
        ...createRun("run-1-old", "completed", "2026-03-14T00:00:00.000Z"),
        testId: "test-1",
      },
      {
        ...createRun("run-2", "failed", "2026-03-15T00:05:00.000Z"),
        testId: "test-2",
        trace: {
          turnId: "turn-2",
          sessionId: "sess-run-2",
          userMessageId: "msg-2",
          branchKind: "append",
          status: "waiting_for_approval",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          startedAt: "2026-03-15T00:05:00.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
          durable: {
            runId: "dur-run-2",
            status: "backgrounded",
            checkpointKind: "run_waiting",
          },
        },
      },
    ];
    const scores: PromptPackScoreRecord[] = [
      {
        ...createScore("score-old", "run-1-old", "2026-03-14T00:05:00.000Z", 2),
        testId: "test-1",
      },
    ];

    const summary = buildPromptPackReportSummary(tests, runs, scores);

    expect(summary.completedRuns).toBe(1);
    expect(summary.failedRuns).toBe(1);
    expect(summary.runFailureCount).toBe(1);
    expect(summary.scoreFailureCount).toBe(0);
    expect(summary.needsScoreCount).toBe(1);
    expect(summary.durableRuns).toBe(2);
    expect(summary.approvalPausedRuns).toBe(1);
    expect(summary.backgroundedRuns).toBe(1);
    expect(summary.averageTotalScore).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.failingCodes).toEqual(["TEST-02"]);
  });

  it("requires file-specific evidence for code prompt-pack responses", () => {
    const test: PromptPackTestRecord = {
      testId: "test-file-evidence",
      packId: "pack-1",
      code: "TEST-D18",
      title: "File evidence",
      prompt: "Inspect package.json and explain the scripts.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-file-evidence",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: "I inspected the repo and found the main scripts for development and testing.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "file.read_range",
              status: "executed",
              args: { path: "package.json" },
              result: { path: "package.json" },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(0);
    expect(evaluation.signals).toContain("missing_file_specific_evidence");
    expect(evaluation.signals).toContain("inspection_claim_without_cited_evidence");
    expect(evaluation.signals).not.toContain("file_specific_evidence_present");
  });

  it("keeps exact-evidence prompts noncompliant when only search hits exist and no file was read", () => {
    const test: PromptPackTestRecord = {
      testId: "test-exact-evidence-search-only",
      packId: "pack-1",
      code: "TEST-EXACT-EVIDENCE",
      title: "Exact evidence requires concrete reads",
      prompt: "Inspect the repo and cite the exact files used to justify the patch plan.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-exact-evidence-search-only",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-exact-evidence-search-only",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "I inspected the repo and used `apps/gateway/src/services/skill-import-service.ts` plus `docs/SKILL_ADOPTION_MATRIX.md` to justify the patch plan.",
        trace: createTrace("sess-exact-evidence-search-only", {
          mode: "code",
          toolRuns: [
            {
              toolRunId: "tool-search-only",
              turnId: "turn-sess-exact-evidence-search-only",
              sessionId: "sess-exact-evidence-search-only",
              toolName: "code.search_files",
              status: "executed",
              result: {
                matches: [
                  { path: "apps/gateway/src/services/skill-import-service.ts" },
                  { path: "docs/SKILL_ADOPTION_MATRIX.md" },
                ],
              },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
        }),
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(0);
    expect(evaluation.signals).toContain("exact_evidence_missing_concrete_file_reads");
    expect(evaluation.signals).not.toContain("file_specific_evidence_present");
  });

  it("penalizes repo-inspection claims that do not surface cited evidence", () => {
    const test: PromptPackTestRecord = {
      testId: "test-inspection-claim-without-evidence",
      packId: "pack-1",
      code: "TEST-D19",
      title: "Inspection claim without evidence",
      prompt: "Inspect the repo and cite the exact files used to justify the patch plan.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-inspection-claim-without-evidence",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "Based on my inspection of the repository, the patch belongs in the prompt-pack loader and benchmark runner.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "file.read_range",
              status: "executed",
              args: { path: "apps/gateway/src/services/prompt-pack-service.ts" },
              result: { excerpt: "..." },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(0);
    expect(evaluation.scores.usabilityScore).toBe(0);
    expect(evaluation.signals).toContain("inspection_claim_without_cited_evidence");
  });

  it("penalizes explicit-tools code answers that stop after one truncated file read", () => {
    const test: PromptPackTestRecord = {
      testId: "test-partial-read-not-recovered",
      packId: "pack-1",
      code: "TEST-D20",
      title: "Partial read not recovered",
      prompt: "Inspect the repo and identify the exact patch points for the fix.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-partial-read-not-recovered",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "The file output was truncated, so I cannot determine the exact patch points without the full file.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "file.read_range",
              status: "executed",
              args: { path: "apps/gateway/src/services/prompt-pack-service.ts", startLine: 1, endLine: 250 },
              result: { path: "apps/gateway/src/services/prompt-pack-service.ts", truncated: true },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.signals).toContain("partial_read_not_recovered");
  });

  it("enforces the cowork prompt-pack role contract in scoring", () => {
    const test: PromptPackTestRecord = {
      testId: "test-cowork-contract",
      packId: "pack-1",
      code: "TEST-W17",
      title: "Cowork contract",
      prompt: "Plan the next release.",
      orderIndex: 0,
      mode: "cowork",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-cowork-contract",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: "### Product\n- Scope: Ship the release.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.search",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(0);
    expect(evaluation.scores.routingScore).toBe(1);
    expect(evaluation.signals).toContain("cowork_role_contract_missing_sections");
    expect(evaluation.signals).toContain("cowork_missing_role_sections");
    expect(evaluation.signals).toContain("cowork_missing_synthesis_section");
  });

  it("accepts ordered cowork sections when the prompt defines an exact section contract", () => {
    const test: PromptPackTestRecord = {
      testId: "test-cowork-ordered-sections",
      packId: "pack-1",
      code: "TEST-W18",
      title: "Cowork ordered sections",
      prompt: [
        "Roles in order: `Researcher`, `Architect`, `QA`.",
        "Output exactly these sections in this order:",
        "- Researcher",
        "- Architect",
        "- QA",
        "- Synthesis",
      ].join("\n"),
      orderIndex: 0,
      mode: "cowork",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-cowork-ordered-sections",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: [
          "**Researcher**",
          "- Evidence: grounded.",
          "",
          "**Architect**",
          "- View: sufficient.",
          "",
          "**QA**",
          "- Risk: bounded.",
          "",
          "**Synthesis**",
          "- Recommendation: proceed.",
        ].join("\n"),
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.search",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
    expect(evaluation.signals).not.toContain("cowork_role_contract_missing_sections");
  });

  it("does not require synthesis in cowork scoring when the prompt says requested role order only", () => {
    const evaluation = evaluatePromptPackRuleScores({
      prompt:
        "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
      profile: {
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
      },
      run: {
        runId: "run-role-order-only",
        packId: "pack-1",
        testId: "test-role-order-only",
        sessionId: "sess-role-order-only",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText:
          "## Product\n- Slice: Keep the qwen gate small.\n\n## QA\n- Unknowns: Verify uncertainty labels and extra-heading rejection.",
        trace: {
          turnId: "turn-role-order-only",
          sessionId: "sess-role-order-only",
          userMessageId: "user-role-order-only",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
    expect(evaluation.signals).not.toContain("cowork_missing_synthesis_section");
  });

  it("accepts inline exact ordered cowork sections in scoring", () => {
    const evaluation = evaluatePromptPackRuleScores({
      prompt: [
        "Roles in order Product, Ops, Researcher.",
        "Answer contract:",
        "- Keep exactly these sections in order: `Product`, `Ops`, `Researcher`.",
        "- Do not add any intro, recap, or synthesis section.",
        "- Each section must cover pack drift, score drift, and provider drift explicitly.",
      ].join("\n"),
      profile: {
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
      },
      run: {
        runId: "run-inline-ordered-cowork",
        packId: "pack-1",
        testId: "test-inline-ordered-cowork",
        sessionId: "sess-inline-ordered-cowork",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText: [
          "Product",
          "- Pack drift: Re-baseline when prompts or weights change.",
          "- Score drift: Treat stable-pack score movement as a quality signal.",
          "- Provider drift: Separate model changes from product changes.",
          "",
          "Ops",
          "- Pack drift: Diff pack IDs, counts, and config snapshots.",
          "- Score drift: Validate run health before escalation.",
          "- Provider drift: Check model/version and fallback usage.",
          "",
          "Researcher",
          "- Pack drift: Compare prompt text and rubric wording.",
          "- Score drift: Look at clustering, not just averages.",
          "- Provider drift: Cross-check the same pack on another provider.",
        ].join("\n"),
        trace: {
          turnId: "turn-inline-ordered-cowork",
          sessionId: "sess-inline-ordered-cowork",
          userMessageId: "user-inline-ordered-cowork",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
  });

  it("treats no-tools planning responses without access claims as honest", () => {
    const evaluation = evaluatePromptPackRuleScores({
      prompt: "Create role-labeled sections for an overnight qwen-focused prompt-pack slice that tests fresh failure modes.",
      profile: {
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
      },
      run: {
        runId: "run-no-tools-honesty",
        packId: "pack-1",
        testId: "test-no-tools-honesty",
        sessionId: "sess-no-tools-honesty",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText: "Product\n- Target fresh regressions only.\n\nQA\n- Cluster failures by mechanism.",
        trace: {
          turnId: "turn-no-tools-honesty",
          sessionId: "sess-no-tools-honesty",
          userMessageId: "user-no-tools-honesty",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(2);
    expect(evaluation.signals).toContain("no_unsupported_access_claims");
  });

  it("accepts controller-owned cowork delivery when named perspectives are covered", () => {
    const test: PromptPackTestRecord = {
      testId: "test-cowork-controller-owned",
      packId: "pack-1",
      code: "TEST-W19",
      title: "Cowork controller owned",
      prompt: [
        "Analyze the decision from 3 perspectives: CTO, VP Sales, and Developer Relations.",
        "Only the controller should speak in the final answer.",
        "End with one synthesized recommendation.",
      ].join(" "),
      orderIndex: 0,
      mode: "cowork",
      toolTier: "no-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-cowork-controller-owned",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText: [
          "## Status Snapshot",
          "- Architecture Impact: manageable with guardrails.",
          "- Finance/Compliance: enterprise differentiation stays intact.",
          "- Incident-Response: rollout needs staged controls.",
          "",
          "## Final Recommendation",
          "Proceed with a staged release and explicit guardrails.",
        ].join("\n"),
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
    expect(evaluation.signals).not.toContain("cowork_missing_named_perspectives");
  });

  it("chooses previous or timestamp baselines from scored history", () => {
    const current: PromptPackScoreRecord = createScore("score-3", "run-3", "2026-03-14T00:05:00.000Z", 2);
    const previous: PromptPackScoreRecord = createScore("score-2", "run-2", "2026-03-12T00:05:00.000Z", 1);
    const earliest: PromptPackScoreRecord = createScore("score-1", "run-1", "2026-03-10T00:05:00.000Z", 0);
    const scores = [current, previous, earliest];

    expect(pickReplayBaselineScore(scores, current)?.scoreId).toBe("score-2");
    expect(pickReplayBaselineScore(scores, current, "2026-03-11T00:00:00.000Z")?.scoreId).toBe("score-1");
    expect(pickReplayBaselineScore(scores, current, "2026-03-13T00:00:00.000Z")?.scoreId).toBe("score-2");
    expect(pickReplayBaselineScore(scores, current, "2026-03-14T00:05:00.000Z")?.scoreId).toBe("score-2");
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

  it("marks truncated prompt-pack outputs invalid and records completion metadata", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Answer in one paragraph under 80 words.",
      responseText: "The most likely causes are config drift, stale environment variables, and an unreviewed deploy.",
      trace: createTrace("sess-integrity-truncated", {
        completion: {
          status: "truncated",
          finishReason: "length",
          repaired: false,
        },
      }),
      outputTokenCount: 73,
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("completion_truncated");
    expect(integrity.signals).toContain("finish_reason_length");
    expect(integrity.completionStatus).toBe("truncated");
    expect(integrity.finishReason).toBe("length");
    expect(integrity.outputTokenCount).toBe(73);
    expect(integrity.responseChecksumSha256).toHaveLength(64);
  });

  it("does not mark complete prompt-pack outputs invalid solely for finish_reason_length", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Keep exactly these sections in order: Product, Ops, Researcher. Keep the whole answer under 220 words.",
      responseText: [
        "Product",
        "- Pack drift: Prompt/test pack changed.",
        "- Score drift: Metrics moved beyond tolerance.",
        "- Provider drift: Provider behavior changed.",
        "",
        "Ops",
        "- Pack drift: Diff pack IDs, prompts, and weights.",
        "- Score drift: Recompute scores from stored outputs.",
        "- Provider drift: Check model alias and provider release notes.",
        "",
        "Researcher",
        "- Pack drift: Confirm direct prompt and rubric diffs.",
        "- Score drift: Look for broad distribution movement with stable inputs.",
        "- Provider drift: Compare same prompts under the same scorer.",
      ].join("\n"),
      trace: createTrace("sess-integrity-complete-length", {
        completion: {
          status: "complete",
          finishReason: "length",
          repaired: false,
        },
      }),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("finish_reason_length");
    expect(integrity.signals).not.toContain("cut_off_ending");
  });

  it("marks mid-sequence starts and cut-off endings invalid", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Give a 3-step response. Each step must be 10 words or fewer. No explanation outside the steps.",
      responseText: [
        "12. Compare prior routing failures against the newest trace evidence now",
        "13. Rank the likeliest causes using only the supplied local facts",
        "14. Check the",
      ].join("\n"),
      trace: createTrace("sess-integrity-sequence"),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("mid_sequence_start");
    expect(integrity.signals).toContain("cut_off_ending");
  });

  it("does not mark a final file-path bullet as cut off", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Inspect the repo and cite the exact files used.",
      responseText: [
        "## Ops",
        "- Review the scheduler and summary cache surfaces together.",
        "",
        "Files used",
        "- apps/gateway/src/services/gateway-service.ts",
        "- apps/gateway/src/services/gateway/update-review.ts",
        "- artifacts/update-review/update-review-2026-04-17.md",
      ].join("\n"),
      trace: createTrace("sess-integrity-final-file-path-bullet"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("cut_off_ending");
  });

  it("does not mark a short emphasized summary bullet as cut off", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Explain when to use rerun, replay, or matrix.",
      responseText: [
        "Use this rule of thumb:",
        "",
        "- **Rerun = confirm**",
        "- **Replay = protect**",
        "- **Matrix = compare**",
      ].join("\n"),
      trace: createTrace("sess-integrity-emphasis-summary"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("cut_off_ending");
  });

  it("does not mark normal sentence openings as fragmentary starts", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Answer directly.",
      responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-integrity-normal-start"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("fragmentary_start");
  });

  it("still marks lowercase continuation starts as fragmentary", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Answer directly.",
      responseText: "and then surface the conflict before taking action.",
      trace: createTrace("sess-integrity-fragmentary-start"),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("fragmentary_start");
  });

  it("marks strict prompt-format violations invalid", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: [
        "Give a 3-step answer under 40 words.",
        "Each step must be 5 words or fewer.",
        "No headings.",
        "No explanation outside the steps.",
        "No step may repeat a verb.",
      ].join(" "),
      responseText: [
        "## Plan",
        "1. Check logs for config drift",
        "2. Check stale env overrides now",
        "3. Verify recent deploy history",
      ].join("\n"),
      trace: createTrace("sess-integrity-strict"),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("heading_present");
    expect(integrity.signals).toContain("non_step_content_present");
    expect(integrity.signals).toContain("repeated_step_verb");
  });

  it("derives integrity from trace metadata when historical runs lack integrity_json", () => {
    const integrity = resolvePromptPackRunIntegrity("Answer directly.", {
      responseText: "A partial answer that never finished cleanly.",
      trace: createTrace("sess-integrity-historical", {
        completion: {
          status: "interrupted",
          finishReason: "content_filter",
          repaired: false,
        },
      }),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.completionStatus).toBe("interrupted");
    expect(integrity.finishReason).toBe("content_filter");
    expect(integrity.signals).toContain("completion_interrupted");
    expect(integrity.signals).toContain("finish_reason_content_filter");
  });

  it("blocks scoring invalid runs before manual or auto scoring can proceed", () => {
    const test = createTest("test-invalid-score", "TEST-INV-01");
    const run: PromptPackRunRecord = {
      ...createRun("run-invalid-score", "completed", "2026-03-15T00:00:00.000Z"),
      testId: test.testId,
      responseText: "A partial answer that stopped mid stream",
      trace: createTrace("sess-invalid-score", {
        completion: {
          status: "truncated",
          finishReason: "length",
          repaired: false,
        },
      }),
    };

    expect(() => assertPromptPackRunScorable(test, run)).toThrowError(/Cannot score TEST-INV-01/);
    expect(() => assertPromptPackRunScorable(test, run)).toThrowError(/completion_truncated/);
  });

  it("records judge health metadata for ok, rate-limited, schema-repair, and rule-only fallback paths", () => {
    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        ruleSignals: [],
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
      }),
    ).toMatchObject({
      usedModelJudge: true,
      status: "ok",
      attemptCount: 1,
    });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: false,
        modelJudgeError: "429 Too Many Requests",
        ruleSignals: ["missing_required_tool_usage"],
        attemptCount: 2,
        fallbackUsed: true,
        repairedSchema: false,
      }),
    ).toMatchObject({
      usedModelJudge: false,
      status: "rate_limited",
      attemptCount: 2,
      ruleSignals: ["missing_required_tool_usage"],
    });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        modelJudgeRationale: "Recovered the structured payload from evaluator notes.",
        ruleSignals: [],
        attemptCount: 3,
        fallbackUsed: true,
        repairedSchema: true,
      }),
    ).toMatchObject({
      usedModelJudge: true,
      status: "schema_repair",
      attemptCount: 3,
    });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: false,
        ruleSignals: ["tool_blockers_prevented_completion"],
        attemptCount: 3,
        fallbackUsed: true,
        repairedSchema: false,
      }),
    ).toMatchObject({
      usedModelJudge: false,
      status: "fallback",
      attemptCount: 3,
      ruleSignals: ["tool_blockers_prevented_completion"],
    });
  });

  it("normalizes judge scores only when all required keys are present", () => {
    expect(
      normalizePromptPackJudgeScores({
        routingScore: 2,
        honestyScore: 1,
        handoffScore: 2,
        robustnessScore: 0,
        usabilityScore: 1,
      }),
    ).toEqual({
      routingScore: 2,
      honestyScore: 1,
      handoffScore: 2,
      robustnessScore: 0,
      usabilityScore: 1,
    });

    expect(
      normalizePromptPackJudgeScores({
        routingScore: 2,
        honestyScore: 1,
        handoffScore: 2,
        robustnessScore: 0,
      } as Record<string, unknown>),
    ).toBeUndefined();
  });

  it("marks unusable judge output invalid while keeping deterministic rule scores as diagnostics", () => {
    const test = createTest("test-v2-fallback", "TEST-V2-FALLBACK");
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-fallback", "completed", "2026-03-16T00:00:00.000Z"),
      testId: test.testId,
      responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-v2-fallback"),
    };
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test,
      run,
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 4,
        fallbackUsed: true,
        repairedSchema: false,
        judgeStatus: "invalid",
        error: "Model judge returned non-JSON output.",
      },
    });

    expect(merged.judgeStatus).toBe("invalid");
    expect(merged.scoreState).toBe("auto_degraded");
    expect(merged.autoVerdict).toBe("review");
    expect(merged.degradedReasons).toEqual(["judge_invalid"]);
    expect(merged.reviewReasons).toEqual(["judge_invalid"]);
    expect(merged.finalScores).toEqual({
      taskSuccess: 4,
      honesty: 4,
      executionQuality: 4,
      robustness: 4,
      usability: 4,
    });
    expect(merged.notes).toContain("Judge error: Model judge returned non-JSON output.");
  });

  it("always reviews fallback judge status when policy requires a judge", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-judge-required", "TEST-V2-JUDGE-REQUIRED"),
      run: {
        ...createRun("run-v2-judge-required", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "Grounded answer with enough detail to score well.",
        trace: createTrace("sess-v2-judge-required"),
      },
      policy: {
        ...DEFAULT_PROMPT_PACK_POLICY_V2,
        judgeRequired: true,
      },
      profile: {
        mode: "chat",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 2,
        fallbackUsed: true,
        repairedSchema: false,
        judgeStatus: "invalid",
        error: "Model judge returned non-JSON output.",
      },
    });

    expect(merged.judgeStatus).toBe("invalid");
    expect(merged.autoVerdict).toBe("review");
    expect(merged.reviewReasons).toContain("judge_invalid");
  });

  it("does not review a strong run solely because honesty evidence scoring is conservative", () => {
    const pack: PromptPackRecord = {
      packId: "pack-1",
      name: "Pack 1",
      testCount: 1,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const test = createTest("test-v2-soft-honesty", "TEST-V2-SOFT-HONESTY");
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-soft-honesty", "completed", "2026-03-16T00:00:00.000Z"),
      testId: test.testId,
      responseText: "The repo likely routes through the prompt-pack service, but I cannot verify exact files from this run alone.",
      trace: createTrace("sess-v2-soft-honesty"),
    };

    const merged = mergePromptPackAutoScoresV2({
      pack,
      test,
      run,
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "safe_auto",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 2,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
      },
    });

    expect(merged.finalScores.honesty).toBe(4);
    expect(merged.reviewReasons).toContain("major_disagreement");
    expect(merged.degradedReasons).toContain("major_disagreement");
    expect(merged.weightedScore).toBeGreaterThanOrEqual(75);
    expect(merged.autoVerdict).toBe("review");
  });

  it("requires a valid judge result when the policy says judgeRequired", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-judge-required-valid", "TEST-V2-JUDGE-REQUIRED-VALID"),
      run: {
        ...createRun("run-v2-judge-required-valid", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "Grounded answer with enough detail to score well.",
        trace: createTrace("sess-v2-judge-required-valid"),
      },
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 2,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
      },
    });

    expect(merged.judgeStatus).toBe("valid");
    expect(merged.scoreState).toBe("auto_valid");
    expect(merged.autoVerdict).toBe("pass");
  });

  it("still reviews major honesty disagreement when a concrete evidence cap is present", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-hard-honesty", "TEST-V2-HARD-HONESTY"),
      run: {
        ...createRun("run-v2-hard-honesty", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "I checked the exact files and here is the answer.",
        trace: createTrace("sess-v2-hard-honesty"),
      },
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "safe_auto",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 2,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {
          honesty: ["missing_required_citation_evidence"],
        },
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
      },
    });

    expect(merged.reviewReasons).toContain("major_disagreement");
  });

  it("keeps fail precedence when a score-driven failure overlaps with review signals", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-task-disagreement", "TEST-V2-TASK-DISAGREEMENT"),
      run: {
        ...createRun("run-v2-task-disagreement", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "Researcher\n- grounded answer\n\nArchitect\n- grounded answer\n\nProduct\n- grounded answer",
        trace: createTrace("sess-v2-task-disagreement"),
      },
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "cowork",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 2,
          honesty: 4,
          executionQuality: 3,
          robustness: 2,
          usability: 2,
        },
      },
    });

    expect(merged.reviewReasons).toContain("major_disagreement");
    expect(merged.finalScores.taskSuccess).toBe(2);
    expect(merged.autoVerdict).toBe("fail");
  });

  it("only marks judge failures as fallback when rule coverage is complete", () => {
    expect(
      resolvePromptPackEffectiveJudgeStatusV2({
        ruleEvaluation: {
          protocol: { protocolPass: true, reasonCodes: [] },
          hardFailReasons: [],
          reviewReasons: [],
          degradedReasons: [],
          applicability: {
            taskSuccess: true,
            honesty: true,
            executionQuality: true,
            robustness: true,
            usability: true,
          },
          ruleScores: {
            taskSuccess: 4,
            honesty: 4,
            robustness: 4,
            usability: 4,
          },
          reasonCaps: {},
        } as never,
        judgeEvaluation: {
          attemptCount: 2,
          fallbackUsed: true,
          repairedSchema: false,
          judgeStatus: "invalid",
          error: "Model judge omitted one or more required score keys.",
        },
      }),
    ).toBe("invalid");
  });

  it("extracts judge text from structured content parts with nested text values", () => {
    expect(
      extractPromptPackCompletionText({
        choices: [
          {
            index: 0,
            message: {
              content: [{ type: "output_text", text: { value: '{"routingScore":2}' } }],
            },
          },
        ],
      }),
    ).toBe('{"routingScore":2}');
  });

  it("falls back to reasoning_content when judge content is empty", () => {
    expect(
      extractPromptPackCompletionText({
        choices: [
          {
            index: 0,
            message: {
              content: "",
              reasoning_content:
                '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2}',
            },
          },
        ],
      }),
    ).toBe('{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2}');
  });

  it("uses the newest run by timestamp even when report rows are unsorted", () => {
    const tests: PromptPackTestRecord[] = [createTest("test-1", "TEST-01")];
    const olderRun: PromptPackRunRecord = {
      ...createRun("run-older", "completed", "2026-03-14T00:00:00.000Z"),
      testId: "test-1",
    };
    const newerRun: PromptPackRunRecord = {
      ...createRun("run-newer", "completed", "2026-03-15T00:00:00.000Z"),
      testId: "test-1",
    };
    const newerScore: PromptPackScoreRecord = {
      ...createScore("score-newer", "run-newer", "2026-03-15T00:05:00.000Z", 2),
      testId: "test-1",
    };

    const summary = buildPromptPackReportSummary(tests, [olderRun, newerRun], [newerScore]);

    expect(summary.completedRuns).toBe(1);
    expect(summary.averageTotalScore).toBe(10);
    expect(summary.passRate).toBe(1);
  });

  it("tracks invalid latest runs and judge health separately from score math", () => {
    const tests: PromptPackTestRecord[] = [
      createTest("test-invalid", "TEST-INV"),
      createTest("test-fallback", "TEST-FALLBACK"),
      createTest("test-error", "TEST-ERROR"),
    ];
    const invalidRun: PromptPackRunRecord = {
      ...createRun("run-invalid", "completed", "2026-03-15T00:00:00.000Z"),
      testId: "test-invalid",
      integrity: {
        validationStatus: "invalid",
        signals: ["output_cut_off_fragment"],
      },
    };
    const fallbackRun: PromptPackRunRecord = {
      ...createRun("run-fallback", "completed", "2026-03-15T00:01:00.000Z"),
      testId: "test-fallback",
      integrity: {
        validationStatus: "valid",
        signals: [],
      },
    };
    const errorRun: PromptPackRunRecord = {
      ...createRun("run-error", "completed", "2026-03-15T00:02:00.000Z"),
      testId: "test-error",
      integrity: {
        validationStatus: "valid",
        signals: [],
      },
    };
    const fallbackScore: PromptPackScoreRecord = {
      ...createScore("score-fallback", "run-fallback", "2026-03-15T00:03:00.000Z", 2),
      testId: "test-fallback",
      judge: {
        usedModelJudge: true,
        status: "schema_repair",
        attemptCount: 2,
        ruleSignals: [],
      },
    };
    const errorScore: PromptPackScoreRecord = {
      ...createScore("score-error", "run-error", "2026-03-15T00:04:00.000Z", 0),
      testId: "test-error",
      judge: {
        usedModelJudge: false,
        status: "rate_limited",
        attemptCount: 2,
        ruleSignals: ["missing_required_tool_usage"],
        modelJudgeError: "429 Too Many Requests",
      },
    };

    const summary = buildPromptPackReportSummary(
      tests,
      [invalidRun, fallbackRun, errorRun],
      [fallbackScore, errorScore],
    );

    expect(summary.completedRuns).toBe(3);
    expect(summary.invalidLatestRuns).toBe(1);
    expect(summary.judgeFallbackCount).toBe(2);
    expect(summary.judgeErrorCount).toBe(1);
    expect(summary.scoreFailureCount).toBe(1);
    expect(summary.needsScoreCount).toBe(0);
    expect(summary.averageTotalScore).toBe(5);
    expect(summary.passRate).toBe(0.5);
    expect(summary.failingCodes).toEqual(["TEST-INV", "TEST-ERROR"]);
  });

  it("treats stale latest autoscores as needing rescore when the policy hash changed", () => {
    const tests = [createTest("test-v2-stale-policy", "TEST-V2-STALE-POLICY")];
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-stale-policy", "completed", "2026-03-16T00:30:00.000Z"),
      testId: "test-v2-stale-policy",
      trace: createTrace("sess-v2-stale-policy"),
    };
    const staleScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-stale-policy",
      packId: "pack-1",
      testId: "test-v2-stale-policy",
      runId: "run-v2-stale-policy",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-old",
      policySource: "inherited_default",
      scoreState: "auto_valid",
      protocol: { protocolPass: true, reasonCodes: [] },
      hardFailReasons: [],
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      ruleScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      finalScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      disagreement: {},
      weightedScore: 92,
      autoVerdict: "pass",
      judgeStatus: "valid",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      createdAt: "2026-03-16T00:31:00.000Z",
    };

    const summary = buildPromptPackReportSummary(
      tests,
      [run],
      [],
      [staleScore],
      [],
      [],
      { policyHash: "policy-current" },
    );

    expect(summary.needsScoreCount).toBe(1);
    expect(summary.staleLatestAutoScoreCount).toBe(1);
    expect(summary.autoScoredRuns).toBe(0);
    expect(summary.passCount).toBe(0);
    expect(summary.effectivePassRate).toBe(0);
  });

  it("treats stale latest autoscores as needing rescore when the scorer generation changed", () => {
    const tests = [createTest("test-v2-stale-scorer", "TEST-V2-STALE-SCORER")];
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-stale-scorer", "completed", "2026-03-16T00:30:00.000Z"),
      testId: "test-v2-stale-scorer",
      trace: createTrace("sess-v2-stale-scorer"),
    };
    const staleScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-stale-scorer",
      packId: "pack-1",
      testId: "test-v2-stale-scorer",
      runId: "run-v2-stale-scorer",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-01.1",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-current",
      policySource: "inherited_default",
      scoreState: "auto_valid",
      protocol: { protocolPass: true, reasonCodes: [] },
      hardFailReasons: [],
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      ruleScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      finalScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      disagreement: {},
      weightedScore: 92,
      autoVerdict: "pass",
      judgeStatus: "valid",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      createdAt: "2026-03-16T00:31:00.000Z",
    };

    const summary = buildPromptPackReportSummary(
      tests,
      [run],
      [],
      [staleScore],
      [],
      [],
      { policyHash: "policy-current" },
    );

    expect(summary.needsScoreCount).toBe(1);
    expect(summary.staleLatestAutoScoreCount).toBe(1);
    expect(summary.autoScoredRuns).toBe(0);
    expect(summary.passCount).toBe(0);
    expect(summary.effectivePassRate).toBe(0);
  });

  it("summarizes v2 scores, degraded rows, and human override verdicts separately", () => {
    const tests: PromptPackTestRecord[] = [
      createTest("test-v2-pass", "TEST-V2-PASS"),
      createTest("test-v2-review", "TEST-V2-REVIEW"),
    ];
    const passRun: PromptPackRunRecord = {
      ...createRun("run-v2-pass", "completed", "2026-03-16T00:00:00.000Z"),
      testId: "test-v2-pass",
    };
    const reviewRun: PromptPackRunRecord = {
      ...createRun("run-v2-review", "completed", "2026-03-16T00:10:00.000Z"),
      testId: "test-v2-review",
    };
    const passScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-pass",
      packId: "pack-1",
      testId: "test-v2-pass",
      runId: "run-v2-pass",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-hash",
      policySource: "inherited_default",
      assertionSetVersion: undefined,
      scoreState: "auto_valid",
      protocol: {
        protocolPass: true,
        reasonCodes: [],
      },
      hardFailReasons: [],
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      ruleScores: {
        taskSuccess: 3,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 3,
      },
      judgeScores: {
        taskSuccess: 4,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 4,
      },
      finalScores: {
        taskSuccess: 4,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 4,
      },
      disagreement: {
        taskSuccess: 1,
        usability: 1,
      },
      weightedScore: 82.5,
      autoVerdict: "pass",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      judgeStatus: "valid",
      notes: "",
      createdAt: "2026-03-16T00:05:00.000Z",
    };
    const degradedReviewScore: PromptPackScoreRecordV2 = {
      ...passScore,
      autoScoreId: "auto-v2-review",
      testId: "test-v2-review",
      runId: "run-v2-review",
      scoreState: "auto_degraded",
      finalScores: {
        taskSuccess: 2,
        honesty: 3,
        executionQuality: 2,
        robustness: 2,
        usability: 2,
      },
      weightedScore: 56.3,
      autoVerdict: "review",
      reviewReasons: ["judge_invalid"],
      degradedReasons: ["judge_invalid"],
      judgeStatus: "invalid",
      createdAt: "2026-03-16T00:15:00.000Z",
    };
    const overrideReview: PromptPackHumanReviewRecordV2 = {
      reviewId: "review-v2-review",
      packId: "pack-1",
      testId: "test-v2-review",
      runId: "run-v2-review",
      autoScoreId: "auto-v2-review",
      reviewerId: "qa-user",
      scores: {
        taskSuccess: 3,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 3,
      },
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      overrideVerdict: "pass",
      notes: "Manual adjudication accepted the bounded answer.",
      createdAt: "2026-03-16T00:20:00.000Z",
    };

    const summary = buildPromptPackReportSummary(
      tests,
      [passRun, reviewRun],
      [],
      [passScore, degradedReviewScore],
      [overrideReview],
    );

    expect(summary.autoScoredRuns).toBe(2);
    expect(summary.humanReviewedRuns).toBe(1);
    expect(summary.degradedScoreCount).toBe(1);
    expect(summary.passCount).toBe(2);
    expect(summary.reviewCount).toBe(0);
    expect(summary.failCount).toBe(0);
    expect(summary.averageWeightedScore).toBeCloseTo(69.4, 1);
    expect(summary.effectivePassRate).toBe(1);
    expect(summary.failingCodes).toEqual([]);
  });

  it("treats fallback judge rows as review blockers in report summary", () => {
    const tests = [createTest("test-v2-fallback-summary", "TEST-V2-FALLBACK-SUMMARY")];
    const runs: PromptPackRunRecord[] = [
      {
        ...createRun("run-v2-fallback-summary", "completed", "2026-03-16T00:30:00.000Z"),
        testId: "test-v2-fallback-summary",
        responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
        trace: createTrace("sess-v2-fallback-summary"),
      },
    ];
    const fallbackScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-fallback-summary",
      packId: "pack-1",
      testId: "test-v2-fallback-summary",
      runId: "run-v2-fallback-summary",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-hash",
      policySource: "inherited_default",
      assertionSetVersion: undefined,
      scoreState: "auto_valid",
      protocol: {
        protocolPass: true,
        reasonCodes: [],
      },
      hardFailReasons: [],
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      ruleScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      judgeScores: undefined,
      finalScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      disagreement: {},
      weightedScore: 100,
      autoVerdict: "review",
      reviewReasons: ["judge_fallback"],
      degradedReasons: ["judge_fallback"],
      mergeProvenance: {},
      judgeStatus: "fallback",
      notes: "Judge fallback: deterministic rule scores were used because the model judge output was unusable.",
      createdAt: "2026-03-16T00:31:00.000Z",
    };

    const summary = buildPromptPackReportSummary(tests, runs, [], [fallbackScore], []);

    expect(summary.judgeFallbackCount).toBe(1);
    expect(summary.judgeErrorCount).toBe(0);
    expect(summary.degradedScoreCount).toBe(0);
    expect(summary.passCount).toBe(0);
    expect(summary.reviewCount).toBe(1);
  });

  it("recomputes auto scores when force is true instead of reusing the current score row", async () => {
    const pack = {
      packId: "pack-1",
      name: "Pack 1",
      testCount: 1,
      policyHash: "policy-hash",
      policySource: "inherited_default" as const,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const test = createTest("test-force-rescore", "TEST-V2-FORCE");
    const run: PromptPackRunRecord = {
      ...createRun("run-force-rescore", "completed", "2026-03-16T00:40:00.000Z"),
      testId: test.testId,
      responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-force-rescore"),
    };
    const existingScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-existing",
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-hash",
      policySource: "inherited_default",
      assertionSetVersion: undefined,
      scoreState: "auto_valid",
      protocol: { protocolPass: true, reasonCodes: [] },
      hardFailReasons: [],
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      ruleScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      judgeScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      finalScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      disagreement: {},
      weightedScore: 100,
      autoVerdict: "pass",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      judgeStatus: "valid",
      notes: "",
      createdAt: "2026-03-16T00:41:00.000Z",
    };
    const createAutoScore = vi.fn((input: PromptPackScoreRecordV2) => input);
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => pack,
            getTest: () => test,
            listTests: () => [test],
          },
          promptPackRuns: {
            listByTest: () => [run],
            get: () => run,
            listByPack: () => [run],
          },
          promptPackAutoScoresV2: {
            listByRun: () => [existingScore],
            create: createAutoScore,
            listByPack: () => [existingScore],
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
                  '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"Looks good."}',
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

    const result = await service.autoScorePromptPackTest({
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      force: true,
    });

    expect(createAutoScore).toHaveBeenCalledTimes(1);
    expect(result.score.autoScoreId).toBe(existingScore.autoScoreId);
  });

  it("keeps auto-scoring successful when export refresh fails after persistence", async () => {
    const pack = {
      packId: "pack-1",
      name: "Pack 1",
      testCount: 1,
      policyHash: "policy-hash",
      policySource: "inherited_default" as const,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const test = createTest("test-export-refresh", "TEST-V2-EXPORT");
    const run: PromptPackRunRecord = {
      ...createRun("run-export-refresh", "completed", "2026-03-16T00:40:00.000Z"),
      testId: test.testId,
      responseText: "The correct precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-export-refresh"),
    };
    const createAutoScore = vi.fn((input: PromptPackScoreRecordV2) => input);
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => pack,
            getTest: () => test,
            listTests: () => [test],
          },
          promptPackRuns: {
            listByTest: () => [run],
            get: () => run,
            listByPack: () => [run],
          },
          promptPackAutoScoresV2: {
            listByRun: () => [],
            create: createAutoScore,
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
                  '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"Looks good."}',
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
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await service.autoScorePromptPackTest({
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      force: true,
    });

    expect(createAutoScore).toHaveBeenCalledTimes(1);
    expect(result.score.runId).toBe(run.runId);
    expect(result.score.judgeStatus).toBe("valid");
  });

  it("does not mark current-default autoscores stale when a legacy inherited-default row carried old policy metadata", () => {
    const rootDir = path.join(os.tmpdir(), `goatcitadel-prompt-pack-export-${randomUUID()}`);
    try {
      const pack = {
        packId: "pack-legacy-default",
        name: "Legacy Default Pack",
        testCount: 1,
        policyHash: hashPromptPackPolicyV2(DEFAULT_PROMPT_PACK_POLICY_V2),
        policySource: "inherited_default" as const,
        policyV2: DEFAULT_PROMPT_PACK_POLICY_V2,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      };
      const test = createTest("test-export-current-default", "TEST-EXPORT-CURRENT-DEFAULT");
      const run: PromptPackRunRecord = {
        ...createRun("run-export-current-default", "completed", "2026-03-16T00:40:00.000Z"),
        testId: test.testId,
        responseText: "Completed answer.",
        trace: createTrace("sess-export-current-default"),
      };
      const autoScore: PromptPackScoreRecordV2 = {
        autoScoreId: "auto-export-current-default",
        packId: pack.packId,
        testId: test.testId,
        runId: run.runId,
        scoringSchemaVersion: "v2",
        scorerVersion: "2026-04-16.2",
        judgeRubricVersion: "2026-04-09.1",
        policyHash: pack.policyHash,
        policySource: "inherited_default",
        scoreState: "scored",
        protocol: { protocolPass: true, reasonCodes: [] },
        hardFailReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        finalScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        disagreement: {},
        weightedScore: 1,
        autoVerdict: "pass",
        judgeStatus: "valid",
        reviewReasons: [],
        degradedReasons: [],
        mergeProvenance: {},
        createdAt: "2026-03-16T00:41:00.000Z",
      };
      const service = new PromptPackService(
        {
          storage: {
            promptPacks: {
              getPack: () => pack,
              listTests: () => [test],
            },
            promptPackRuns: {
              listByPack: () => [run],
            },
            promptPackScores: {
              listByPack: () => [],
            },
            promptPackAutoScoresV2: {
              listByPack: () => [autoScore],
            },
            promptPackHumanReviewsV2: {
              listByPack: () => [],
            },
          },
          gatewaySql: {} as never,
          config: {
            rootDir,
            assistant: {
              workspaceDir: ".",
              durable: {
                enabled: true,
                executionEnabled: true,
                chatAutoPromoteEnabled: true,
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

      const exported = service.exportPromptPack(pack.packId);
      const markdown = fs.readFileSync(exported.path, "utf8");

      expect(markdown).toContain("Current-generation latest v2 score rows: 1/1");
      expect(markdown).toContain("Stale latest v2 score rows: 0");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("continues batch auto-scoring after a per-test failure and prefers completed runs", async () => {
    const firstTest = createTest("test-batch-1", "TEST-BATCH-01");
    const secondTest = createTest("test-batch-2", "TEST-BATCH-02");
    const olderCompleted: PromptPackRunRecord = {
      ...createRun("run-batch-completed", "completed", "2026-03-16T00:40:00.000Z"),
      testId: firstTest.testId,
      responseText: "Completed answer.",
      trace: createTrace("sess-batch-completed"),
    };
    const latestFailed: PromptPackRunRecord = {
      ...createRun("run-batch-failed", "failed", "2026-03-16T00:41:00.000Z"),
      testId: firstTest.testId,
    };
    const secondCompleted: PromptPackRunRecord = {
      ...createRun("run-batch-second", "completed", "2026-03-16T00:42:00.000Z"),
      testId: secondTest.testId,
      responseText: "Completed answer.",
      trace: createTrace("sess-batch-second"),
    };
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({
              packId: "pack-1",
              name: "Pack 1",
              policyHash: "policy-hash",
            }),
            listTests: () => [firstTest, secondTest],
          },
          promptPackRuns: {
            listByTest: (testId: string) =>
              testId === firstTest.testId ? [latestFailed, olderCompleted] : [secondCompleted],
          },
          promptPackAutoScoresV2: {
            listByRun: () => [],
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
    const autoScoreSpy = vi
      .spyOn(service, "autoScorePromptPackTest")
      .mockRejectedValueOnce(new Error("Cannot score first run"))
      .mockResolvedValueOnce({
        score: {
          autoScoreId: "auto-batch-second",
        },
        run: secondCompleted,
      } as never);

    const result = await service.autoScorePromptPackBatch({
      packId: "pack-1",
      onlyUnscored: false,
      limit: 2,
    });

    expect(autoScoreSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        testId: firstTest.testId,
        runId: olderCompleted.runId,
      }),
    );
    expect(autoScoreSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        testId: secondTest.testId,
        runId: secondCompleted.runId,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([
      {
        testId: firstTest.testId,
        runId: olderCompleted.runId,
        error: "Cannot score first run",
      },
    ]);
  });

  it("builds trend series from historical score and run timestamps only", () => {
    const capabilitySeries = buildPromptPackCapabilitySeries(
      [
        createScore("score-1", "run-1", "2026-03-10T00:05:00.000Z", 0),
        createScore("score-2", "run-2", "2026-03-12T00:05:00.000Z", 1),
        createScore("score-3", "run-3", "2026-03-14T00:05:00.000Z", 2),
      ],
      "routing",
    );
    expect(capabilitySeries).toEqual([
      { timestamp: "2026-03-10T00:05:00.000Z", value: 0 },
      { timestamp: "2026-03-12T00:05:00.000Z", value: 0.5 },
      { timestamp: "2026-03-14T00:05:00.000Z", value: 1 },
    ]);

    const failureSeries = buildPromptPackRunFailureRateSeries([
      createRun("run-1", "completed", "2026-03-10T00:00:01.000Z"),
      createRun("run-2", "failed", "2026-03-12T00:00:02.000Z"),
      createRun("run-3", "completed", "2026-03-14T00:00:03.000Z"),
    ]);
    expect(failureSeries).toEqual([
      { timestamp: "2026-03-10T00:00:01.000Z", value: 0 },
      { timestamp: "2026-03-12T00:00:02.000Z", value: 0.5 },
      { timestamp: "2026-03-14T00:00:03.000Z", value: 0.3333 },
    ]);
  });

  it("parses the repo expansion prompt pack markdown with stable mode and tool tiers", () => {
    const markdown = buildRepoExpansionPromptPackMarkdown();
    const tests = parsePromptPackTests(markdown);

    expect(tests.map((test) => test.code)).toEqual([
      "TEST-D26",
      "TEST-D27",
      "TEST-D28",
      "TEST-D29",
      "TEST-D30",
      "TEST-D31",
      "TEST-D32",
      "TEST-W31",
      "TEST-W32",
    ]);
    expect(tests.slice(0, 7).every((test) => test.mode === "code" && test.toolTier === "explicit-tools")).toBe(true);
    expect(tests.slice(7).every((test) => test.mode === "cowork" && test.toolTier === "explicit-tools")).toBe(true);
    expect(tests[0]?.prompt).toContain("F:/code/goatcitadel-arena/packages/engine/src/judge/rules-judge.ts");
    expect(tests[7]?.prompt).toContain("Roles in order: `Researcher`, `Architect`, `QA`.");
  });

  it("parses mode headings even when they omit the word tests", () => {
    const tests = parsePromptPackTests(
      [
        "# Chat",
        "",
        "## No Tools",
        "",
        "### TEST-X01: Direct answer",
        "",
        "Prompt body.",
        "",
        "# Cowork",
        "",
        "## Explicit Tools",
        "",
        "### TEST-X02: Coordinated answer",
        "",
        "Another prompt body.",
      ].join("\n"),
    );

    expect(tests).toHaveLength(2);
    expect(tests[0]).toMatchObject({ code: "TEST-X01", mode: "chat", toolTier: "no-tools" });
    expect(tests[1]).toMatchObject({ code: "TEST-X02", mode: "cowork", toolTier: "explicit-tools" });
  });

  it("parses the canonical merged prompt pack markdown with the v4 balanced layout", () => {
    const markdown = buildCanonicalMergedPromptPackMarkdown();
    const tests = parsePromptPackTests(markdown);
    const codes = tests.map((test) => test.code);
    const byMode = new Map<string, number>();
    for (const test of tests) {
      if (!test.mode) {
        continue;
      }
      byMode.set(test.mode, (byMode.get(test.mode) ?? 0) + 1);
    }

    expect(tests).toHaveLength(108);
    expect(new Set(codes).size).toBe(108);
    expect(codes[0]).toBe("TEST-C01");
    expect(codes).toContain("TEST-W27");
    expect(codes).toContain("TEST-D27");
    expect(codes).toContain("TEST-T01");
    expect(codes).toContain("TEST-T27");
    expect(codes[codes.length - 1]).toBe("TEST-T27");
    expect(byMode.get("chat")).toBe(36);
    expect(byMode.get("cowork")).toBe(36);
    expect(byMode.get("code")).toBe(36);
  });

  it("parses the focused v2 prompt pack markdown for recent GoatCitadel capabilities", () => {
    const markdown = buildFocusedV2PromptPackMarkdown();
    const tests = parsePromptPackTests(markdown);
    const byMode = new Map<string, number>();
    for (const test of tests) {
      if (!test.mode) {
        continue;
      }
      byMode.set(test.mode, (byMode.get(test.mode) ?? 0) + 1);
    }

    expect(tests).toHaveLength(96);
    expect(new Set(tests.map((test) => test.code)).size).toBe(96);
    expect(tests[0]?.code).toBe("TEST-C101");
    expect(tests.some((test) => test.code === "TEST-W111" && test.prompt.includes("skill-import-service.ts"))).toBe(
      true,
    );
    expect(tests.some((test) => test.code === "TEST-D110" && test.prompt.includes("update-review-daily"))).toBe(true);
    expect(tests.some((test) => test.code === "TEST-C121" && test.prompt.includes("memory routes"))).toBe(true);
    expect(tests.some((test) => test.code === "TEST-D122" && test.prompt.includes("run-prompt-pack-gates.ts"))).toBe(
      true,
    );
    expect(tests.some((test) => test.code === "TEST-W130" && test.prompt.includes("judge target selection"))).toBe(
      true,
    );
    expect(tests.some((test) => test.code === "TEST-D132" && test.prompt.includes("wall-clock timing"))).toBe(true);
    expect(byMode.get("chat")).toBe(32);
    expect(byMode.get("cowork")).toBe(32);
    expect(byMode.get("code")).toBe(32);
  });

  it("parses dotted manual test codes so they survive import refreshes", () => {
    const markdown = [
      "## 2.6 Baseline sanity check",
      "Validate the baseline behavior.",
      "",
      "## 2.7 Streaming refresh check",
      "Verify the list updates after the first run.",
      "",
      "[2.8] Follow-up regression",
      "Confirm the previous fix still holds.",
    ].join("\n");

    const tests = parsePromptPackTests(markdown);

    expect(tests.map((test) => test.code)).toEqual(["2.6", "2.7", "2.8"]);
    expect(tests[1]).toMatchObject({
      code: "2.7",
      title: "Streaming refresh check",
    });
  });
});

function buildRepoExpansionPromptPackMarkdown(): string {
  return buildPromptPackMarkdown([
    {
      mode: "code",
      toolTier: "explicit-tools",
      tests: [
        {
          code: "TEST-D26",
          title: "Rules judge inspection",
          prompt:
            "Inspect F:/code/goatcitadel-arena/packages/engine/src/judge/rules-judge.ts and explain the minimal patch.",
        },
        { code: "TEST-D27", title: "Planner follow-up", prompt: "Review the repo-level planner follow-up flow." },
        { code: "TEST-D28", title: "Replay wiring", prompt: "Trace the replay benchmark wiring end to end." },
        { code: "TEST-D29", title: "Capability register", prompt: "Verify the capability register update path." },
        { code: "TEST-D30", title: "Approval resume", prompt: "Inspect the approval resume checkpoint path." },
        { code: "TEST-D31", title: "Storage boundary", prompt: "Check the storage repo usage for runtime state." },
        { code: "TEST-D32", title: "Regression guard", prompt: "Add the narrowest regression guard for this path." },
      ],
    },
    {
      mode: "cowork",
      toolTier: "explicit-tools",
      tests: [
        {
          code: "TEST-W31",
          title: "Role-labeled repo plan",
          prompt: "Roles in order: `Researcher`, `Architect`, `QA`. Produce a compact repo expansion validation plan.",
        },
        {
          code: "TEST-W32",
          title: "Operator rollout",
          prompt: "Coordinate the rollout checklist for the repo expansion lane.",
        },
      ],
    },
  ]);
}

function buildCanonicalMergedPromptPackMarkdown(): string {
  return buildPromptPackMarkdown([
    {
      mode: "chat",
      toolTier: "no-tools",
      tests: [
        ...Array.from({ length: 35 }, (_, index) => createPromptPackFixture(`TEST-C${padPromptPackCode(index + 1)}`)),
        createPromptPackFixture("TEST-D27"),
      ],
    },
    {
      mode: "cowork",
      toolTier: "explicit-tools",
      tests: Array.from({ length: 36 }, (_, index) => createPromptPackFixture(`TEST-W${padPromptPackCode(index + 1)}`)),
    },
    {
      mode: "code",
      toolTier: "explicit-tools",
      tests: [
        ...Array.from({ length: 9 }, (_, index) => createPromptPackFixture(`TEST-D${padPromptPackCode(index + 1)}`)),
        ...Array.from({ length: 27 }, (_, index) => createPromptPackFixture(`TEST-T${padPromptPackCode(index + 1)}`)),
      ],
    },
  ]);
}

function buildFocusedV2PromptPackMarkdown(): string {
  return buildPromptPackMarkdown([
    {
      mode: "chat",
      toolTier: "no-tools",
      tests: Array.from({ length: 32 }, (_, index) => {
        const codeNumber = 101 + index;
        const code = `TEST-C${codeNumber}`;
        if (code === "TEST-C121") {
          return createPromptPackFixture(code, "Trace the memory routes and explain the highest-signal regression.");
        }
        return createPromptPackFixture(code);
      }),
    },
    {
      mode: "cowork",
      toolTier: "explicit-tools",
      tests: Array.from({ length: 32 }, (_, index) => {
        const codeNumber = 101 + index;
        const code = `TEST-W${codeNumber}`;
        if (code === "TEST-W111") {
          return createPromptPackFixture(
            code,
            "Inspect skill-import-service.ts and explain the operator-facing import path.",
          );
        }
        if (code === "TEST-W130") {
          return createPromptPackFixture(code, "Audit judge target selection across the benchmark lane.");
        }
        return createPromptPackFixture(code);
      }),
    },
    {
      mode: "code",
      toolTier: "explicit-tools",
      tests: Array.from({ length: 32 }, (_, index) => {
        const codeNumber = 101 + index;
        const code = `TEST-D${codeNumber}`;
        if (code === "TEST-D110") {
          return createPromptPackFixture(
            code,
            "Review update-review-daily and explain the safest implementation path.",
          );
        }
        if (code === "TEST-D122") {
          return createPromptPackFixture(
            code,
            "Inspect run-prompt-pack-gates.ts and describe the release gate wiring.",
          );
        }
        if (code === "TEST-D132") {
          return createPromptPackFixture(
            code,
            "Measure wall-clock timing behavior and call out retry-sensitive drift.",
          );
        }
        return createPromptPackFixture(code);
      }),
    },
  ]);
}

function buildPromptPackMarkdown(
  sections: Array<{
    mode: "chat" | "cowork" | "code";
    toolTier: "no-tools" | "implicit-tools" | "explicit-tools";
    tests: Array<{ code: string; title: string; prompt: string }>;
  }>,
): string {
  return sections
    .map((section) =>
      [
        `# ${capitalizePromptPackMode(section.mode)}`,
        "",
        `## ${formatPromptPackToolTier(section.toolTier)}`,
        "",
        ...section.tests.flatMap((test) => [`### ${test.code}: ${test.title}`, "", test.prompt, ""]),
      ].join("\n"),
    )
    .join("\n");
}

function createPromptPackFixture(code: string, prompt?: string): { code: string; title: string; prompt: string } {
  return {
    code,
    title: `Fixture ${code}`,
    prompt: prompt ?? `Run the ${code} fixture and summarize the most important finding.`,
  };
}

function padPromptPackCode(value: number): string {
  return value.toString().padStart(2, "0");
}

function capitalizePromptPackMode(mode: "chat" | "cowork" | "code"): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function formatPromptPackToolTier(toolTier: "no-tools" | "implicit-tools" | "explicit-tools"): string {
  if (toolTier === "no-tools") {
    return "No Tools";
  }
  if (toolTier === "implicit-tools") {
    return "Implicit Tools";
  }
  return "Explicit Tools";
}

function createScore(scoreId: string, runId: string, createdAt: string, value: 0 | 1 | 2): PromptPackScoreRecord {
  return {
    scoreId,
    packId: "pack-1",
    testId: "test-1",
    runId,
    routingScore: value,
    honestyScore: value,
    handoffScore: value,
    robustnessScore: value,
    usabilityScore: value,
    totalScore: value * 5,
    createdAt,
  };
}

function createRun(runId: string, status: PromptPackRunRecord["status"], finishedAt: string): PromptPackRunRecord {
  return {
    runId,
    packId: "pack-1",
    testId: "test-1",
    sessionId: `sess-${runId}`,
    status,
    mode: "chat",
    toolTier: "implicit-tools",
    toolAutonomy: "safe_auto",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: finishedAt,
    finishedAt,
  };
}

function createTest(testId: string, code: string): PromptPackTestRecord {
  return {
    testId,
    packId: "pack-1",
    code,
    title: code,
    prompt: `Prompt for ${code}`,
    orderIndex: 0,
    mode: "chat",
    toolTier: "implicit-tools",
    createdAt: "2026-03-14T00:00:00.000Z",
  };
}

function createTrace(
  sessionId: string,
  overrides?: Partial<NonNullable<PromptPackRunRecord["trace"]>>,
): NonNullable<PromptPackRunRecord["trace"]> {
  return {
    turnId: `turn-${sessionId}`,
    sessionId,
    userMessageId: `user-${sessionId}`,
    branchKind: "append",
    status: "completed",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: "2026-03-14T00:00:00.000Z",
    finishedAt: "2026-03-14T00:00:01.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
    ...overrides,
  };
}
