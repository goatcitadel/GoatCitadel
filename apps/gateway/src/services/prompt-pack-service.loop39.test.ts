import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { ChatProjectRecord, PromptPackRunRecord, PromptPackTestRecord } from "@goatcitadel/contracts";
import { PromptPackService } from "./prompt-pack-service.js";
import { createPack, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

interface Harness {
  rootDir: string;
  service: PromptPackService;
  agentSendChatMessage: ReturnType<typeof vi.fn>;
  createdRuns: PromptPackRunRecord[];
  patchedRuns: PromptPackRunRecord[];
  restoredProjects: string[];
  projectUpdates: Array<{ projectId: string; patch: Record<string, unknown> }>;
  assignedProjects: Array<{ sessionId: string; projectId: string }>;
  createdGrants: Array<Record<string, unknown>>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("PromptPackService loop39 run behavior", () => {
  it("rejects runs before persistence when required placeholders are missing", async () => {
    const test = {
      ...createTest("test-placeholder-missing", "TEST-L39-MISSING"),
      prompt: "Summarize <LOCAL TOPIC> and <REPO_PATH>.",
    };
    const harness = createHarness(test);

    await expect(
      harness.service.runPromptPackTest("pack-1", test.testId, {
        placeholderValues: {
          "local topic": "runtime fallback",
        },
      }),
    ).rejects.toThrow(/Missing placeholder values.*<REPO_PATH>/);

    expect(harness.createdRuns).toHaveLength(0);
    expect(harness.agentSendChatMessage).not.toHaveBeenCalled();
  });

  it("substitutes placeholders, restores project bindings, mirrors fixtures, and grants session tools", async () => {
    const test = {
      ...createTest("test-placeholder-project", "TEST-L39-PROJECT"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Inspect fixtures/prompt-pack-workspace/src/index.ts for <LOCAL TOPIC> and report the smallest runtime fix.",
    } satisfies PromptPackTestRecord;
    const harness = createHarness(test);
    const sourceFile = path.join(harness.rootDir, "fixtures", "prompt-pack-workspace", "src", "index.ts");
    fsSync.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fsSync.writeFileSync(sourceFile, "export const fixture = true;\n", "utf8");

    const run = await harness.service.runPromptPackTest("pack-1", test.testId, {
      sessionId: "sess-existing",
      placeholderValues: {
        " local topic ": "storage-backed provider fallback",
      },
    });

    const sentPrompt = harness.agentSendChatMessage.mock.calls[0]?.[1]?.content as string;
    expect(sentPrompt).toContain("storage-backed provider fallback");
    expect(sentPrompt).not.toContain("<LOCAL TOPIC>");
    expect(run).toMatchObject({
      status: "completed",
      sessionId: "sess-existing",
      responseText: "Fixture response for substituted prompt.",
    });
    expect(harness.restoredProjects).toEqual(["project-archived"]);
    expect(harness.projectUpdates).toEqual([
      {
        projectId: "project-archived",
        patch: expect.objectContaining({
          workspacePath: "fixtures/prompt-pack-workspace",
        }),
      },
    ]);
    expect(harness.assignedProjects).toEqual([{ sessionId: "sess-existing", projectId: "project-archived" }]);
    expect(
      harness.createdGrants.some((grant) => grant.scopeRef === "sess-existing" && grant.decision === "allow"),
    ).toBe(true);
    expect(
      fsSync.existsSync(
        path.join(harness.rootDir, "workspace", "fixtures", "prompt-pack-workspace", "src", "index.ts"),
      ),
    ).toBe(true);
  });
});

function createHarness(test: PromptPackTestRecord): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-prompt-pack-loop39-"));
  const pack = createPack("pack-1");
  const createdRuns: PromptPackRunRecord[] = [];
  const patchedRuns: PromptPackRunRecord[] = [];
  const restoredProjects: string[] = [];
  const projectUpdates: Array<{ projectId: string; patch: Record<string, unknown> }> = [];
  const assignedProjects: Array<{ sessionId: string; projectId: string }> = [];
  const createdGrants: Array<Record<string, unknown>> = [];
  const archivedProject: ChatProjectRecord = {
    projectId: "project-archived",
    workspaceId: "default",
    name: "Old prompt project",
    description: "Old description",
    workspacePath: "fixtures/prompt-pack-workspace",
    lifecycleStatus: "archived",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const agentSendChatMessage = vi.fn(async (sessionId: string) => ({
    turnId: `turn-${sessionId}`,
    assistantMessage: {
      messageId: `assistant-${sessionId}`,
      sessionId,
      role: "assistant",
      content: "Fixture response for substituted prompt.",
      createdAt: "2026-05-15T00:00:00.000Z",
    },
    trace: createTrace(sessionId, {
      turnId: `turn-${sessionId}`,
      mode: "code",
    }),
    citations: [],
  }));
  const service = new PromptPackService(
    {
      storage: {
        promptPacks: {
          getPack: () => pack,
          getTest: () => test,
          listTests: () => [test],
        },
        promptPackRuns: {
          create: (input: PromptPackRunRecord) => {
            createdRuns.push(input);
            return input;
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
        chatProjects: {
          list: () => [archivedProject],
          restore: (projectId: string) => {
            restoredProjects.push(projectId);
            archivedProject.lifecycleStatus = "active";
          },
          update: (projectId: string, patch: Record<string, unknown>) => {
            projectUpdates.push({ projectId, patch });
            Object.assign(archivedProject, patch);
            return archivedProject;
          },
          create: () => {
            throw new Error("expected existing project binding to be reused");
          },
        },
        chatSessionProjects: {
          assign: (sessionId: string, projectId: string) => {
            assignedProjects.push({ sessionId, projectId });
          },
        },
        toolGrants: {
          list: () => [],
          listActive: (scope?: string, scopeRef?: string) =>
            createdGrants.filter((grant) => grant.scope === scope && grant.scopeRef === scopeRef),
          create: (grant: Record<string, unknown>) => {
            createdGrants.push(grant);
            return grant;
          },
          createTtlForDuration: (grant: Record<string, unknown>) => {
            createdGrants.push(grant);
            return grant;
          },
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
      createChatSession: vi.fn(() => ({ sessionId: "sess-created" })),
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
    restoredProjects,
    projectUpdates,
    assignedProjects,
    createdGrants,
  };
  harnesses.push(harness);
  return harness;
}
