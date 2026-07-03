import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  getChatStreamingPreview,
  publishChatStreamingPreview,
  resetChatStreamingPreviewForTests,
  subscribeChatStreamingPreview,
  type ChatStreamingPreviewSnapshot,
} from "./chat-streaming-preview-store";

function makeSnapshot(overrides: Partial<ChatStreamingPreviewSnapshot> = {}): ChatStreamingPreviewSnapshot {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: "assistant-1",
    text: "Hello",
    visibleText: "Hello",
    isRunning: true,
    updatedAt: 1,
    ...overrides,
  };
}

describe("chat-streaming-preview-store", () => {
  beforeEach(() => {
    resetChatStreamingPreviewForTests();
  });

  it("round-trips a published preview through get", () => {
    expect(getChatStreamingPreview("session-1")).toBeNull();

    const snapshot = makeSnapshot();
    publishChatStreamingPreview("session-1", snapshot);

    expect(getChatStreamingPreview("session-1")).toBe(snapshot);
  });

  it("returns null for an unknown, null, or undefined sessionId", () => {
    publishChatStreamingPreview("session-1", makeSnapshot());

    expect(getChatStreamingPreview("session-does-not-exist")).toBeNull();
    expect(getChatStreamingPreview(null)).toBeNull();
    expect(getChatStreamingPreview(undefined)).toBeNull();
  });

  it("clears a published preview when publishing null", () => {
    publishChatStreamingPreview("session-1", makeSnapshot());
    expect(getChatStreamingPreview("session-1")).not.toBeNull();

    publishChatStreamingPreview("session-1", null);

    expect(getChatStreamingPreview("session-1")).toBeNull();
  });

  it("notifies a subscribed listener only for its own session, not for another session's publish", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    subscribeChatStreamingPreview("session-a", listenerA);
    subscribeChatStreamingPreview("session-b", listenerB);

    publishChatStreamingPreview("session-a", makeSnapshot({ sessionId: "session-a" }));

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();

    publishChatStreamingPreview("session-b", makeSnapshot({ sessionId: "session-b" }));

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it("notifies every listener subscribed to the same session", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeChatStreamingPreview("session-1", first);
    subscribeChatStreamingPreview("session-1", second);

    publishChatStreamingPreview("session-1", makeSnapshot());

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops notifying a listener once its unsubscribe function has been called", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatStreamingPreview("session-1", listener);

    publishChatStreamingPreview("session-1", makeSnapshot());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishChatStreamingPreview("session-1", makeSnapshot({ text: "Hello again" }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when publishing the exact same snapshot reference again", () => {
    const listener = vi.fn();
    subscribeChatStreamingPreview("session-1", listener);
    const snapshot = makeSnapshot();

    publishChatStreamingPreview("session-1", snapshot);
    expect(listener).toHaveBeenCalledTimes(1);

    publishChatStreamingPreview("session-1", snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify a no-op null-to-null publish for a session with nothing published", () => {
    const listener = vi.fn();
    subscribeChatStreamingPreview("session-1", listener);

    publishChatStreamingPreview("session-1", null);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does notify when a distinct new snapshot object replaces the previous one, even with equal fields", () => {
    const listener = vi.fn();
    subscribeChatStreamingPreview("session-1", listener);
    publishChatStreamingPreview("session-1", makeSnapshot());
    expect(listener).toHaveBeenCalledTimes(1);

    // A distinct object reference with identical field values still counts as
    // an identity change (the store never deep-compares) -- each buffer flush
    // constructs a fresh immutable snapshot object.
    publishChatStreamingPreview("session-1", makeSnapshot());

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clears all sessions and listeners via the test reset helper", () => {
    const listener = vi.fn();
    subscribeChatStreamingPreview("session-1", listener);
    publishChatStreamingPreview("session-1", makeSnapshot());
    expect(getChatStreamingPreview("session-1")).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    resetChatStreamingPreviewForTests();

    expect(getChatStreamingPreview("session-1")).toBeNull();
    // Re-publishing after reset must not notify the pre-reset listener: reset
    // also drops all listener registrations, not just the snapshot map. The
    // count must stay at 1 (its one pre-reset call), not grow to 2.
    publishChatStreamingPreview("session-1", makeSnapshot());
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
