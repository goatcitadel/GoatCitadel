import { describe, expect, it, vi } from "vitest";
import type { ChatGoalCommandDependencies } from "./chat-goal-command.js";
import { handleGoalCommand } from "./chat-goal-command.js";

describe("handleGoalCommand", () => {
  it("reports stored goals and usage when no goal is stored", async () => {
    const deps = fakeDeps();

    await expect(handleGoalCommand(deps, "session-1", [])).resolves.toEqual({
      ok: true,
      message: expect.stringContaining("No session goals recorded."),
    });
    deps.listChatSessionLearnedMemory.mockReturnValueOnce({
      items: [
        goalMemory("item-1", "Goal: Finish coverage\nGOAL_OPTIONS: maxIterations=2; budgetUsd=1.5; surface=cowork"),
        { itemType: "note", status: "active" },
        goalMemory("item-2", "Goal: Old", "superseded"),
        goalMemory("item-3", "Goal: Dropped", "dropped"),
      ],
      conflicts: [],
    } as never);

    await expect(handleGoalCommand(deps, "session-1", ["status"])).resolves.toEqual({
      ok: true,
      message: expect.stringContaining("Goal: Finish coverage [active, 80%, item-1]"),
    });
  });

  it("pauses and clears stored goals with honest no-op messages", async () => {
    const deps = fakeDeps();
    deps.listChatSessionLearnedMemory.mockReturnValueOnce({
      items: [goalMemory("active", "Goal: active"), goalMemory("conflict", "Goal: conflict", "conflict")],
      conflicts: [],
    } as never);
    await expect(handleGoalCommand(deps, "session-1", ["pause"])).resolves.toEqual({
      ok: true,
      message: "Paused 2 session goal(s).",
    });

    deps.listChatSessionLearnedMemory.mockReturnValueOnce({
      items: [goalMemory("disabled", "Goal: disabled", "disabled")],
      conflicts: [],
    } as never);
    await expect(handleGoalCommand(deps, "session-1", ["pause"])).resolves.toEqual({
      ok: true,
      message: "No active session goals to pause.",
    });

    deps.listChatSessionLearnedMemory.mockReturnValueOnce({
      items: [goalMemory("active", "Goal: active"), goalMemory("disabled", "Goal: disabled", "disabled")],
      conflicts: [],
    } as never);
    await expect(handleGoalCommand(deps, "session-1", ["clear"])).resolves.toEqual({
      ok: true,
      message: "Cleared 1 session goal(s).",
    });
    expect(deps.updateChatSessionLearnedMemory).toHaveBeenCalledWith("session-1", "active", { status: "disabled" });
    expect(deps.updateChatSessionLearnedMemory).toHaveBeenCalledWith("session-1", "conflict", { status: "disabled" });
    expect(deps.updateChatSessionLearnedMemory).toHaveBeenCalledTimes(3);
  });

  it("resumes a paused goal without writing a new goal memory", async () => {
    const deps = fakeDeps();
    deps.listChatSessionLearnedMemory.mockReturnValueOnce({
      items: [
        goalMemory(
          "paused-1",
          "Goal: Finish release\nGOAL_OPTIONS: maxIterations=2; budgetUsd=1.5; surface=chat",
          "disabled",
        ),
      ],
      conflicts: [],
    } as never);
    deps.runChatDelegation.mockResolvedValueOnce({
      runId: "run-1",
      steps: [qaStep("GOAL_STATUS: pass\nGOAL_REASON: green")],
    } as never);

    const result = await handleGoalCommand(deps, "session-1", ["resume"]);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Goal hit: Finish release");
    expect(deps.updateChatSessionLearnedMemory).toHaveBeenCalledWith("session-1", "paused-1", { status: "active" });
    expect(deps.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
    expect(deps.runChatDelegation).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ surfaceMode: "chat", roles: ["coder", "qa"], mode: "sequential" }),
    );
  });

  it("runs a goal loop until pass, budget, blocked, or iteration cap", async () => {
    const deps = fakeDeps();
    deps.getSession.mockReturnValue({ costUsdTotal: 0.25 });
    deps.runChatDelegation.mockResolvedValueOnce({
      runId: "run-pass",
      taskId: "task-1",
      steps: [qaStep("GOAL_STATUS: pass\nGOAL_REASON: done", "child-1")],
    } as never);

    await expect(
      handleGoalCommand(deps, "session-1", [
        "Ship",
        "it",
        "--max-iterations=2",
        "--budget-usd",
        "1",
        "--surface",
        "cowork",
      ]),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        message: expect.stringContaining("Goal hit: Ship it"),
      }),
    );
    expect(deps.extractAndPersistLearnedMemory).toHaveBeenCalledWith(
      "session-1",
      "Goal: Ship it\nGOAL_OPTIONS: maxIterations=2; budgetUsd=1; surface=cowork",
      { role: "user", sourceRef: "chat-command:/goal" },
    );

    deps.runChatDelegation
      .mockResolvedValueOnce({
        runId: "run-fail-1",
        steps: [qaStep("GOAL_STATUS: fail\nGOAL_REASON: still red", "child-2")],
      } as never)
      .mockResolvedValueOnce({
        runId: "run-fail-2",
        steps: [qaStep("GOAL_STATUS: fail\nGOAL_REASON: still red", "child-3")],
      } as never);
    await expect(
      handleGoalCommand(deps, "session-1", ["Try", "--max-iterations", "2", "--budget", "10"]),
    ).resolves.toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining("Iteration cap hit") }));

    deps.runChatDelegation.mockResolvedValueOnce({
      runId: "run-budget",
      steps: [qaStep("GOAL_STATUS: fail", "child-4")],
    } as never);
    deps.getSession.mockReturnValueOnce({ costUsdTotal: 10 });
    await expect(handleGoalCommand(deps, "session-1", ["Budget", "--budget-usd", "0.01"])).resolves.toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining("Budget cap hit") }),
    );

    deps.runChatDelegation.mockResolvedValueOnce({
      runId: "run-blocked",
      steps: [{ role: "qa", status: "failed", error: "tests failed", childSessionId: "child-5" }],
    } as never);
    await expect(handleGoalCommand(deps, "session-1", ["Blocked"])).resolves.toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining("Blocked: Blocked") }),
    );
  });

  it("handles invalid commands, missing paused goals, delegation errors, and unknown verifier output", async () => {
    const deps = fakeDeps();

    await expect(handleGoalCommand(deps, "session-1", ["pause", "extra"])).resolves.toEqual({
      ok: false,
      message: expect.stringContaining("Usage: /goal Complete"),
    });
    await expect(handleGoalCommand(deps, "session-1", ["resume"])).resolves.toEqual({
      ok: false,
      message: "No paused session goal found to resume.",
    });

    deps.runChatDelegation.mockRejectedValueOnce(new Error("provider down"));
    await expect(handleGoalCommand(deps, "session-1", ["Run"])).resolves.toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining("provider down") }),
    );

    deps.runChatDelegation
      .mockResolvedValueOnce({ runId: "unknown-1", steps: [qaStep("no verdict")] } as never)
      .mockResolvedValueOnce({ runId: "unknown-2", steps: [qaStep("still no verdict")] } as never);
    await expect(
      handleGoalCommand(deps, "session-1", ["Unknown", "--max-iterations", "8", "--budget-usd", "8"]),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining("Verifier did not emit GOAL_STATUS.") }),
    );
  });
});

function fakeDeps() {
  return {
    extractAndPersistLearnedMemory: vi.fn(),
    getSession: vi.fn(() => ({ costUsdTotal: 0 })),
    listChatSessionLearnedMemory: vi.fn(() => ({ items: [], conflicts: [] })),
    runChatDelegation: vi.fn(),
    updateChatSessionLearnedMemory: vi.fn((_, itemId: string, input: unknown) => ({ itemId, ...input })),
  } satisfies ChatGoalCommandDependencies;
}

function goalMemory(itemId: string, content: string, status = "active") {
  return {
    itemId,
    itemType: "goal",
    status,
    content,
    confidence: 0.8,
  };
}

function qaStep(output: string, childSessionId = "child-1") {
  return {
    role: "qa",
    status: "completed",
    output,
    childSessionId,
  };
}
