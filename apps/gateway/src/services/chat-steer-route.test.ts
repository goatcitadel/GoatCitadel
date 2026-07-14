import { describe, expect, it, vi } from "vitest";
import {
  handleChatSteerRequest,
  handleChatGoalSetRequest,
  handleChatGoalStatusRequest,
  handleChatGoalClearRequest,
} from "./chat-steer-route";
import { ChatSteerService } from "./chat-steer-service";

describe("handleChatSteerRequest", () => {
  it("rejects when no active turn", async () => {
    const service = new ChatSteerService();
    const result = await handleChatSteerRequest({
      sessionId: "s-1",
      body: { instruction: "go" },
      steerService: service,
    });
    expect(result.accepted).toBe(false);
  });

  it("rejects empty instruction", async () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    const result = await handleChatSteerRequest({
      sessionId: "s-1",
      body: { instruction: "   " },
      steerService: service,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/required/i);
  });

  it("accepts and enqueues when an active turn exists", async () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    const result = await handleChatSteerRequest({
      sessionId: "s-1",
      body: { instruction: "go" },
      steerService: service,
    });
    expect(result.accepted).toBe(true);
    expect(result.turnId).toBe("t-1");
  });
});

describe("handleChatGoalSetRequest", () => {
  it("persists goal and returns status", async () => {
    const meta = {
      ensure: vi.fn(() => ({
        revision: 4,
        pinnedGoal: undefined,
        goalTurnBudget: undefined,
        goalTurnsUsed: 0,
        goalSetAt: undefined,
      })),
      patchWithRevision: vi.fn(
        (
          _id: string,
          p: { pinnedGoal?: string | null; goalTurnBudget?: number | null; goalSetAt?: string | null },
        ) => ({
          revision: 5,
          pinnedGoal: p.pinnedGoal ?? undefined,
          goalTurnBudget: p.goalTurnBudget ?? undefined,
          goalTurnsUsed: 0,
          goalSetAt: p.goalSetAt ?? undefined,
        }),
      ),
    };
    const result = await handleChatGoalSetRequest({
      sessionId: "s-1",
      body: { goal: "ship kanban", turnBudget: 10 },
      chatSessionMeta: meta as never,
      now: () => "2026-05-15T10:00:00Z",
    });
    expect(result.goal).toBe("ship kanban");
    expect(result.turnBudget).toBe(10);
    expect(meta.patchWithRevision).toHaveBeenCalledWith(
      "s-1",
      {
        pinnedGoal: "ship kanban",
        goalTurnBudget: 10,
        goalSetAt: "2026-05-15T10:00:00Z",
      },
      4,
    );
    expect(result.revision).toBe(5);
  });

  it("throws on empty goal", async () => {
    const meta = { ensure: vi.fn(), patch: vi.fn() };
    await expect(
      handleChatGoalSetRequest({
        sessionId: "s-1",
        body: { goal: "   " },
        chatSessionMeta: meta as never,
      }),
    ).rejects.toThrow(/required/i);
  });
});

describe("handleChatGoalStatusRequest", () => {
  it("returns current goal status", async () => {
    const meta = {
      ensure: vi.fn(() => ({
        revision: 6,
        pinnedGoal: "ship kanban",
        goalTurnBudget: 10,
        goalTurnsUsed: 3,
        goalSetAt: "2026-05-15T10:00:00Z",
      })),
      patch: vi.fn(),
    };
    const result = await handleChatGoalStatusRequest({
      sessionId: "s-1",
      chatSessionMeta: meta as never,
    });
    expect(result.goal).toBe("ship kanban");
    expect(result.turnsUsed).toBe(3);
  });
});

describe("handleChatGoalClearRequest", () => {
  it("clears and returns null goal", async () => {
    const meta = {
      ensure: vi.fn(() => ({ revision: 8 })),
      patchWithRevision: vi.fn(() => ({
        revision: 9,
        pinnedGoal: undefined,
        goalTurnBudget: undefined,
        goalTurnsUsed: 0,
        goalSetAt: undefined,
      })),
    };
    const result = await handleChatGoalClearRequest({
      sessionId: "s-1",
      chatSessionMeta: meta as never,
    });
    expect(result.goal).toBeNull();
    expect(meta.patchWithRevision).toHaveBeenCalledWith(
      "s-1",
      { pinnedGoal: null, goalTurnBudget: null, goalSetAt: null },
      8,
    );
    expect(result.revision).toBe(9);
  });
});
