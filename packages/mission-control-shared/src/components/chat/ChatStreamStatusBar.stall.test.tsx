import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_STREAM_STALL_THRESHOLD_MS, ChatStreamStatusBar } from "./ChatStreamStatusBar";
import * as chatStreamActivityStore from "../../state/chat-stream-activity-store";
import {
  clearChatStreamActivity,
  getChatStreamActivityAt,
  recordChatStreamChunkActivity,
  resetChatStreamActivityForTests,
} from "../../state/chat-stream-activity-store";

function hasText(node: unknown, text: string): boolean {
  return JSON.stringify(node).includes(text);
}

function findStallSpan(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findStallSpan(child);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const asRecord = node as { type?: string; props?: { className?: string }; children?: unknown };
  if (asRecord.type === "span" && asRecord.props?.className === "chat-stream-status-stall") {
    return node;
  }
  return findStallSpan(asRecord.children);
}

describe("ChatStreamStatusBar stall indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetChatStreamActivityForTests();
  });

  afterEach(() => {
    resetChatStreamActivityForTests();
    vi.useRealTimers();
  });

  it("shows no stall node while streaming with fresh activity just under the threshold", () => {
    recordChatStreamChunkActivity("session-1", Date.now());
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ChatStreamStatusBar status="streaming" queuedCount={0} error={null} activitySessionId="session-1" />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_STREAM_STALL_THRESHOLD_MS - 1_000);
    });
    const tree = renderer!.toJSON();
    expect(findStallSpan(tree)).toBeNull();
    expect(hasText(tree, "Still working")).toBe(false);
    act(() => {
      renderer!.unmount();
    });
  });

  it("shows the stall node with elapsed seconds once activity is 13s old, with the ticking text aria-hidden", () => {
    const startedAt = Date.now();
    recordChatStreamChunkActivity("session-1", startedAt);
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ChatStreamStatusBar status="streaming" queuedCount={0} error={null} activitySessionId="session-1" />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_STREAM_STALL_THRESHOLD_MS + 1_000);
    });
    const tree = renderer!.toJSON();
    const stallSpan = findStallSpan(tree) as { children?: unknown[] } | null;
    expect(stallSpan).not.toBeNull();
    expect(hasText(tree, "13")).toBe(true);
    expect(hasText(tree, "s since last activity")).toBe(true);
    expect(hasText(tree, "is-stalled")).toBe(true);

    // The ticking sentence must live inside an aria-hidden span so the bar's
    // existing polite live region announces the stable copy once, not the
    // per-second countdown.
    const children = stallSpan!.children as Array<{ props?: { "aria-hidden"?: string } }>;
    const ariaHiddenChild = children.find((child) => child.props?.["aria-hidden"] === "true");
    expect(ariaHiddenChild).toBeDefined();
    expect(hasText(ariaHiddenChild, "13")).toBe(true);
    expect(hasText(ariaHiddenChild, "s since last activity")).toBe(true);

    const visuallyHiddenChild = children.find((child) => child.props?.["aria-hidden"] !== "true");
    expect(visuallyHiddenChild).toBeDefined();
    expect(hasText(visuallyHiddenChild, "Still working")).toBe(true);

    act(() => {
      renderer!.unmount();
    });
  });

  it("clears the stall on the next tick after recordChatStreamChunkActivity is called again", () => {
    const startedAt = Date.now();
    recordChatStreamChunkActivity("session-1", startedAt);
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ChatStreamStatusBar status="streaming" queuedCount={0} error={null} activitySessionId="session-1" />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_STREAM_STALL_THRESHOLD_MS + 1_000);
    });
    expect(findStallSpan(renderer!.toJSON())).not.toBeNull();

    act(() => {
      recordChatStreamChunkActivity("session-1", Date.now());
      vi.advanceTimersByTime(1_000);
    });
    expect(findStallSpan(renderer!.toJSON())).toBeNull();

    act(() => {
      renderer!.unmount();
    });
  });

  it("never reads the store and leaks no interval when idle or suppressed", () => {
    const spy = vi.spyOn(chatStreamActivityStore, "getChatStreamActivityAt");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ChatStreamStatusBar status="idle" queuedCount={0} error={null} activitySessionId="session-1" />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    act(() => {
      renderer!.unmount();
    });

    spy.mockClear();
    setIntervalSpy.mockClear();
    act(() => {
      renderer = create(
        <ChatStreamStatusBar
          status="streaming"
          queuedCount={0}
          error={null}
          activitySessionId="session-1"
          suppressStallIndicator
        />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    act(() => {
      renderer!.unmount();
    });

    // A healthy stream (activitySessionId set, not suppressed, eligible status)
    // must still tear its interval down cleanly on unmount.
    spy.mockClear();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    act(() => {
      renderer = create(
        <ChatStreamStatusBar status="streaming" queuedCount={0} error={null} activitySessionId="session-1" />,
      );
    });
    act(() => {
      renderer!.unmount();
    });
    expect(clearIntervalSpy).toHaveBeenCalled();

    spy.mockRestore();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("round-trips record/clear/get per session through the module store and resets cleanly", () => {
    expect(getChatStreamActivityAt("session-a")).toBeNull();
    expect(getChatStreamActivityAt(null)).toBeNull();
    expect(getChatStreamActivityAt(undefined)).toBeNull();

    recordChatStreamChunkActivity("session-a", 1000);
    recordChatStreamChunkActivity("session-b", 2000);
    expect(getChatStreamActivityAt("session-a")).toBe(1000);
    expect(getChatStreamActivityAt("session-b")).toBe(2000);

    clearChatStreamActivity("session-a");
    expect(getChatStreamActivityAt("session-a")).toBeNull();
    expect(getChatStreamActivityAt("session-b")).toBe(2000);

    resetChatStreamActivityForTests();
    expect(getChatStreamActivityAt("session-a")).toBeNull();
    expect(getChatStreamActivityAt("session-b")).toBeNull();
  });
});
