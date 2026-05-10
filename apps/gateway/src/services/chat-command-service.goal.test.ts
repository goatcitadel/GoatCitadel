import { describe, expect, it, vi } from "vitest";
import type { ChatDelegationStepRecord, ChatSessionPrefsRecord, LearnedMemoryItemRecord } from "@goatcitadel/contracts";
import { listChatCommandCatalog, parseChatCommand, type ChatCommandDependencies } from "./chat-command-service.js";

const basePrefs: ChatSessionPrefsRecord = {
  sessionId: "session-1",
  mode: "chat",
  planningMode: "off",
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "standard",
  speedMode: "standard",
  subagentPolicy: "ask_when_useful",
  toolAutonomy: "safe_auto",
  orchestrationEnabled: true,
  orchestrationIntensity: "balanced",
  orchestrationVisibility: "summarized",
  orchestrationProviderPreference: "balanced",
  orchestrationReviewDepth: "standard",
  orchestrationParallelism: "auto",
  codeAutoApply: "manual",
  createdAt: "2026-05-10T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:00.000Z",
};

function goalItem(overrides: Partial<LearnedMemoryItemRecord> = {}): LearnedMemoryItemRecord {
  return {
    itemId: "goal-item-123456",
    sessionId: "session-1",
    itemType: "goal",
    content: "Goal: Ship the launch checklist.",
    confidence: 0.86,
    status: "active",
    redacted: false,
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
    ...overrides,
  };
}

function createDeps(
  input: {
    prefs?: Partial<ChatSessionPrefsRecord>;
    items?: LearnedMemoryItemRecord[];
    runChatDelegation?: ChatCommandDependencies["runChatDelegation"];
    sessions?: Record<string, { costUsdTotal: number }>;
  } = {},
): ChatCommandDependencies {
  return {
    getSession: vi.fn((sessionId: string) => input.sessions?.[sessionId] ?? { sessionId }),
    getChatSessionPrefs: vi.fn(() => ({ ...basePrefs, ...input.prefs })),
    listChatSessionLearnedMemory: vi.fn(() => ({ items: input.items ?? [], conflicts: [] })),
    extractAndPersistLearnedMemory: vi.fn(),
    updateChatSessionLearnedMemory: vi.fn((sessionId: string, itemId: string, patch: { status?: string }) => ({
      ...goalItem({ sessionId, itemId }),
      status: patch.status ?? "active",
    })),
    runChatDelegation:
      input.runChatDelegation ??
      vi.fn(async () => ({
        runId: "run-1",
        taskId: "task-1",
        steps: [
          step({ stepId: "goal-1-implement", role: "coder", childSessionId: "child-coder" }),
          step({
            stepId: "goal-1-verify",
            role: "qa",
            childSessionId: "child-qa",
            output: "Validation passed.\nGOAL_STATUS: pass\nGOAL_REASON: The requested end state is verified.",
          }),
        ],
        stitchedOutput: "Validation passed.\nGOAL_STATUS: pass\nGOAL_REASON: The requested end state is verified.",
      })),
  } as unknown as ChatCommandDependencies;
}

function step(overrides: Partial<ChatDelegationStepRecord>): ChatDelegationStepRecord {
  return {
    stepId: "step-1",
    runId: "run-1",
    role: "coder",
    status: "completed",
    index: 0,
    startedAt: "2026-05-10T00:00:00.000Z",
    finishedAt: "2026-05-10T00:00:01.000Z",
    output: "Done.",
    ...overrides,
  };
}

describe("chat goal command", () => {
  it("is listed in the command catalog and /help", async () => {
    expect(listChatCommandCatalog().some((item) => item.command === "/goal")).toBe(true);

    const result = await parseChatCommand(createDeps(), "session-1", "/help");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("/goal [pause|resume|clear|<objective>]");
  });

  it("lists session goal memories", async () => {
    const result = await parseChatCommand(
      createDeps({
        items: [
          goalItem(),
          goalItem({ itemId: "disabled-goal", content: "Goal: Resume me.", status: "disabled" }),
          goalItem({ itemId: "pref-item", itemType: "preference", content: "Remember dark mode." }),
        ],
      }),
      "session-1",
      "/goal",
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Session goals:");
    expect(result.message).toContain("Goal: Ship the launch checklist.");
    expect(result.message).toContain("Resume me");
    expect(result.message).not.toContain("dark mode");
  });

  it("runs a bounded implement and verify loop until QA marks the goal passing", async () => {
    const deps = createDeps({
      sessions: {
        "child-coder": { costUsdTotal: 0.25 },
        "child-qa": { costUsdTotal: 0.1 },
      },
    });

    const result = await parseChatCommand(
      deps,
      "session-1",
      "/goal Complete the launch checklist without stopping until tests pass. --max-iterations 2 --budget-usd 1",
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Goal hit:");
    expect(result.message).toContain("Iterations: 1/2");
    expect(result.message).toContain("Estimated cost: $0.3500 / $1.00");
    expect(deps.extractAndPersistLearnedMemory).toHaveBeenCalledWith(
      "session-1",
      [
        "Goal: Complete the launch checklist without stopping until tests pass.",
        "GOAL_OPTIONS: maxIterations=2; budgetUsd=1; surface=code",
      ].join("\n"),
      {
        role: "user",
        sourceRef: "chat-command:/goal",
      },
    );
    expect(deps.runChatDelegation).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        roles: ["coder", "qa"],
        mode: "sequential",
        surfaceMode: "code",
      }),
    );
  });

  it("keeps looping until the iteration cap when QA does not mark the goal passing", async () => {
    const runChatDelegation = vi
      .fn()
      .mockResolvedValueOnce({
        runId: "run-1",
        taskId: "task-1",
        steps: [
          step({ stepId: "goal-1-implement", role: "coder" }),
          step({
            stepId: "goal-1-verify",
            role: "qa",
            output: "Still failing.\nGOAL_STATUS: fail\nGOAL_REASON: One validation remains red.",
          }),
        ],
        stitchedOutput: "Still failing.\nGOAL_STATUS: fail\nGOAL_REASON: One validation remains red.",
      })
      .mockResolvedValueOnce({
        runId: "run-2",
        taskId: "task-2",
        steps: [
          step({ stepId: "goal-2-implement", runId: "run-2", role: "coder" }),
          step({
            stepId: "goal-2-verify",
            runId: "run-2",
            role: "qa",
            output: "Still failing.\nGOAL_STATUS: fail\nGOAL_REASON: Needs another pass.",
          }),
        ],
        stitchedOutput: "Still failing.\nGOAL_STATUS: fail\nGOAL_REASON: Needs another pass.",
      });
    const deps = createDeps({ runChatDelegation });

    const result = await parseChatCommand(deps, "session-1", "/goal Ship the launch checklist. --max-iterations 2");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Iteration cap hit:");
    expect(runChatDelegation).toHaveBeenCalledTimes(2);
  });

  it("blocks when QA omits a verifier verdict", async () => {
    const runChatDelegation = vi.fn(async () => ({
      runId: "run-unknown",
      steps: [
        step({ stepId: "goal-1-implement", role: "coder" }),
        step({ stepId: "goal-1-verify", role: "qa", output: "Looks fine, ship it." }),
      ],
      stitchedOutput: "Looks fine, ship it.",
    }));
    const deps = createDeps({ runChatDelegation });

    const result = await parseChatCommand(deps, "session-1", "/goal Ship the launch checklist. --max-iterations 8");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Blocked:");
    expect(result.message).toContain("Verifier did not emit GOAL_STATUS.");
    expect(runChatDelegation).toHaveBeenCalledTimes(1);
  });

  it("stops after the iteration that reaches the budget cap", async () => {
    const runChatDelegation = vi.fn(async () => ({
      runId: "run-budget",
      steps: [
        step({ stepId: "goal-1-implement", role: "coder", childSessionId: "child-coder" }),
        step({
          stepId: "goal-1-verify",
          role: "qa",
          childSessionId: "child-qa",
          output: "Still failing.\nGOAL_STATUS: fail\nGOAL_REASON: Needs one more change.",
        }),
      ],
      stitchedOutput: "Still failing.\nGOAL_STATUS: fail\nGOAL_REASON: Needs one more change.",
    }));
    const deps = createDeps({
      runChatDelegation,
      sessions: {
        "child-coder": { costUsdTotal: 0.4 },
        "child-qa": { costUsdTotal: 0.2 },
      },
    });

    const result = await parseChatCommand(deps, "session-1", "/goal Ship the launch checklist. --budget-usd 0.5");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Budget cap hit:");
    expect(result.message).toContain("Estimated cost: $0.6000 / $0.50");
    expect(runChatDelegation).toHaveBeenCalledTimes(1);
  });

  it("pauses and resumes stored goals", async () => {
    const deps = createDeps({ items: [goalItem({ status: "active" })] });

    let result = await parseChatCommand(deps, "session-1", "/goal pause");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Paused 1 session goal");
    expect(deps.updateChatSessionLearnedMemory).toHaveBeenCalledWith("session-1", "goal-item-123456", {
      status: "disabled",
    });

    const runChatDelegation = vi.fn(async () => ({
      runId: "run-resume",
      steps: [
        step({ stepId: "goal-1-implement", role: "coder" }),
        step({
          stepId: "goal-1-verify",
          role: "qa",
          output: "Validation passed.\nGOAL_STATUS: pass\nGOAL_REASON: Done.",
        }),
      ],
      stitchedOutput: "Validation passed.\nGOAL_STATUS: pass\nGOAL_REASON: Done.",
    }));
    const pausedDeps = createDeps({
      items: [
        goalItem({
          status: "disabled",
          content: "Goal: Resume me.\nGOAL_OPTIONS: maxIterations=1; budgetUsd=0.5; surface=cowork",
        }),
      ],
      runChatDelegation,
    });
    result = await parseChatCommand(pausedDeps, "session-1", "/goal resume");
    expect(result.ok).toBe(true);
    expect(pausedDeps.updateChatSessionLearnedMemory).toHaveBeenCalledWith("session-1", "goal-item-123456", {
      status: "active",
    });
    expect(pausedDeps.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
    expect(result.message).toContain("Iterations: 1/1");
    expect(result.message).toContain("Estimated cost: $0.0000 / $0.50");
    expect(runChatDelegation).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        surfaceMode: "cowork",
      }),
    );
  });

  it("does not treat malformed pause/resume/clear commands as new goals", async () => {
    const deps = createDeps();

    const result = await parseChatCommand(deps, "session-1", "/goal pause extra-word");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Usage: /goal Complete");
    expect(deps.runChatDelegation).not.toHaveBeenCalled();
  });
});
