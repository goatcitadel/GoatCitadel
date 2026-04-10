import { describe, expect, it } from "vitest";
import { ChatTurnExecutionRegistry } from "./chat-turn-execution-registry.js";

describe("ChatTurnExecutionRegistry", () => {
  it("serializes chat turn writes by session and clears stale session leases", async () => {
    const registry = new ChatTurnExecutionRegistry();

    await expect(
      registry.withWriteLease("session-1", "agent-send", async () => {
        await expect(registry.withWriteLease("session-1", "retry-turn", async () => "unexpected")).rejects.toThrow(
          /already in progress/,
        );
        return "done";
      }),
    ).resolves.toBe("done");

    await expect(registry.withWriteLease("session-1", "retry-turn", async () => "next")).resolves.toBe("next");

    const leaseToken = registry.acquireWriteLease("session-1", "edit-turn");
    registry.clearSessionWriteLease("session-1");

    await expect(registry.withWriteLease("session-1", "agent-send", async () => "recovered")).resolves.toBe(
      "recovered",
    );
    registry.releaseWriteLease("session-1", leaseToken);
  });

  it("tracks active turn controllers by turn id", () => {
    const registry = new ChatTurnExecutionRegistry();

    const controller = registry.beginActiveExecution("session-1", "turn-1", "agent-send");

    expect(registry.getActiveExecution("turn-1")).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      operation: "agent-send",
    });
    expect(registry.isCancellationRequested("turn-1")).toBe(false);

    controller.abort();
    expect(registry.isCancellationRequested("turn-1")).toBe(true);

    registry.endActiveExecution("turn-1", controller);
    expect(registry.getActiveExecution("turn-1")).toBeUndefined();
  });

  it("tracks live stream sequence and completion state", () => {
    const registry = new ChatTurnExecutionRegistry();

    const state = registry.registerActiveStream("session-1", "turn-1", 7, "run-1");

    expect(state.nextSequence).toBe(8);
    expect(registry.getActiveStream("turn-1")?.completed).toBe(false);

    registry.getActiveStream("turn-1")!.nextSequence += 1;
    expect(registry.getActiveStream("turn-1")?.nextSequence).toBe(9);

    registry.completeActiveStream("turn-1");
    expect(registry.getActiveStream("turn-1")?.completed).toBe(true);

    registry.closeActiveStream("turn-1");
    expect(registry.getActiveStream("turn-1")).toBeUndefined();
  });
});
