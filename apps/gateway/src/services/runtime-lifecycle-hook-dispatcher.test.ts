import { describe, expect, it, vi } from "vitest";
import { runtimeLifecycleHookDispatcher } from "./runtime-lifecycle-hook-dispatcher.js";

describe("runtimeLifecycleHookDispatcher", () => {
  it("isolates dispatch failures for record_only observers", async () => {
    // session.start / session.end / subagent.* / context.compaction.* are
    // observe-only (failureSemantics: "record_only"): the hooks service
    // records the failed run, and the committed runtime operation the
    // observer describes must never appear to fail because of it.
    const hooksService = {
      runInlineHooks: vi.fn(async () => {
        throw new Error("webhook endpoint down");
      }),
      enqueueAfterHooks: vi.fn(async () => {
        throw new Error("durable enqueue unavailable");
      }),
    } as never;

    await expect(
      runtimeLifecycleHookDispatcher.runObserveHook(hooksService, {
        workspaceId: "ws",
        trigger: "session.start",
        entityType: "chat_session",
        entityId: "session-1",
        payload: { workspaceId: "ws", sessionId: "session-1", origin: "operator", mode: "chat" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      runtimeLifecycleHookDispatcher.enqueueObserveHook(hooksService, {
        workspaceId: "ws",
        trigger: "session.end",
        entityType: "chat_session",
        entityId: "session-1",
        payload: { workspaceId: "ws", sessionId: "session-1", reason: "deleted" },
      }),
    ).resolves.toBeUndefined();
  });

  it("still dispatches through to the hooks service when delivery succeeds", async () => {
    const runInlineHooks = vi.fn(async () => []);
    const enqueueAfterHooks = vi.fn(async () => []);
    const hooksService = { runInlineHooks, enqueueAfterHooks } as never;

    await runtimeLifecycleHookDispatcher.runObserveHook(hooksService, {
      workspaceId: "ws",
      trigger: "session.start",
      entityType: "chat_session",
      entityId: "session-2",
      payload: { workspaceId: "ws", sessionId: "session-2", origin: "operator", mode: "chat" },
    });
    expect(runInlineHooks).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "session.start", entityId: "session-2" }),
    );

    await runtimeLifecycleHookDispatcher.enqueueObserveHook(hooksService, {
      workspaceId: "ws",
      trigger: "subagent.end",
      entityType: "chat_subagent",
      entityId: "child-1",
      payload: {
        parentSessionId: "session-2",
        childSessionId: "child-1",
        delegationRunId: "run-1",
        stepId: "step-1",
        role: "analyst",
        status: "completed",
      },
    });
    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "subagent.end", entityId: "child-1" }),
    );
  });
});
