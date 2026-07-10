import { describe, expect, it } from "vitest";
import { ChatTurnExecutionRegistry, ChatTurnStreamRegistrationMismatchError } from "./chat-turn-execution-registry.js";

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

    const lease = registry.registerActiveStream("session-1", "turn-1", 7, "run-1");

    expect(Object.isFrozen(lease)).toBe(true);
    expect(lease.nextSequence).toBe(8);
    expect(registry.getActiveStream("turn-1")?.completed).toBe(false);

    expect(lease.claimNextSequence()).toBe(8);
    expect(registry.getActiveStream("turn-1")?.nextSequence).toBe(9);

    expect(lease.complete()).toBe(true);
    expect(registry.getActiveStream("turn-1")?.completed).toBe(true);

    expect(lease.close()).toBe(true);
    expect(registry.getActiveStream("turn-1")).toBeUndefined();
  });

  it("rejects cross-turn use of a bound stream lease", () => {
    const registry = new ChatTurnExecutionRegistry();
    const lease = registry.registerActiveStream("session-1", "turn-1", 0, "run-1");

    expect(() => lease.requireActive("turn-2")).toThrow(ChatTurnStreamRegistrationMismatchError);
    expect(() => lease.claimNextSequence("turn-2")).toThrow(ChatTurnStreamRegistrationMismatchError);
    expect(lease.nextSequence).toBe(1);
    expect(lease.isActive()).toBe(true);
  });

  it("ignores stale durable-attempt completion and close callbacks after the turn is re-registered", () => {
    const registry = new ChatTurnExecutionRegistry();

    const pausedAttempt = registry.registerActiveStream("session-1", "turn-1", 4, "run-1");
    const resumedAttempt = registry.registerActiveStream("session-1", "turn-1", 7, "run-1");

    expect(resumedAttempt.registrationId).not.toBe(pausedAttempt.registrationId);
    expect(pausedAttempt.isActive()).toBe(false);
    expect(resumedAttempt.isActive()).toBe(true);
    expect(() => registry.requireActiveStreamRegistration("turn-1", pausedAttempt.registrationId)).toThrow(
      ChatTurnStreamRegistrationMismatchError,
    );
    expect(registry.requireActiveStreamRegistration("turn-1", resumedAttempt.registrationId)).toBe(resumedAttempt);
    expect(registry.completeActiveStream("turn-1", pausedAttempt.registrationId)).toBe(false);
    expect(registry.getActiveStream("turn-1")).toBe(resumedAttempt);
    expect(resumedAttempt.completed).toBe(false);

    expect(registry.closeActiveStream("turn-1", pausedAttempt.registrationId)).toBe(false);
    expect(registry.getActiveStream("turn-1")).toBe(resumedAttempt);

    expect(resumedAttempt.complete()).toBe(true);
    expect(resumedAttempt.completed).toBe(true);
    expect(resumedAttempt.isActive()).toBe(false);
    expect(() => registry.requireActiveStreamRegistration("turn-1", resumedAttempt.registrationId)).toThrow(
      ChatTurnStreamRegistrationMismatchError,
    );
    // A completed registration remains closeable so delayed cancellation cleanup
    // retains its historical compatibility behavior.
    expect(resumedAttempt.close()).toBe(true);
    expect(registry.getActiveStream("turn-1")).toBeUndefined();
  });

  it("aborts active executions and clears singleton state on close", () => {
    const registry = new ChatTurnExecutionRegistry();
    const controller = registry.beginActiveExecution("session-1", "turn-1", "agent-send");
    registry.acquireWriteLease("session-1", "agent-send");
    registry.registerActiveStream("session-1", "turn-1", 0, "run-1");

    registry.close("shutdown");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(Error);
    expect(registry.getActiveExecution("turn-1")).toBeUndefined();
    expect(registry.getActiveStream("turn-1")).toBeUndefined();
    expect(registry.hasAnyActiveChatTurnExecution()).toBe(false);
    expect(() => registry.acquireWriteLease("session-1", "retry-turn")).not.toThrow();
  });
});
