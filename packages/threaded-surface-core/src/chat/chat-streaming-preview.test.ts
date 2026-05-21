import { describe, expect, it, vi } from "vitest";
import { ChatStreamingPreviewBuffer, resolveVisibleStreamingText } from "./chat-streaming-preview";

describe("chat streaming preview", () => {
  it("reveals completed lines before the unstable tail", () => {
    expect(resolveVisibleStreamingText("First line\nsecond", 1000, 1010)).toBe("First line\n");
  });

  it("reveals short no-newline answers after the fallback delay", () => {
    expect(resolveVisibleStreamingText("short answer", 1000, 1100)).toBe("");
    expect(resolveVisibleStreamingText("short answer", 1000, 1260)).toBe("short answer");
  });

  it("reveals long no-newline answers once the character threshold is reached", () => {
    expect(resolveVisibleStreamingText("x".repeat(80), 1000, 1005)).toBe("x".repeat(80));
  });

  it("reveals all text in reduced-motion mode", () => {
    expect(resolveVisibleStreamingText("partial", 1000, 1001, { reducedMotion: true })).toBe("partial");
  });

  it("batches flushes through frame cadence and max-delay fallback", () => {
    let now = 1000;
    const frameCallbacks: Array<() => void> = [];
    const timerCallbacks: Array<() => void> = [];
    const onFlush = vi.fn();
    const buffer = new ChatStreamingPreviewBuffer({
      now: () => now,
      onFlush,
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: vi.fn(),
      setTimer: (callback) => {
        timerCallbacks.push(callback);
        return timerCallbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      isReducedMotion: () => false,
    });

    buffer.start({ sessionId: "sess", turnId: "turn", messageId: "msg" });
    buffer.append({ sessionId: "sess", turnId: "turn", messageId: "msg", delta: "Hello" });
    expect(onFlush).toHaveBeenCalledTimes(1);

    now = 1260;
    frameCallbacks.shift()?.();
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Hello",
        visibleText: "Hello",
      }),
    );

    timerCallbacks.length = 0;
    buffer.append({ sessionId: "sess", turnId: "turn", delta: " again" });
    timerCallbacks.shift()?.();
    expect(onFlush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Hello again",
        visibleText: "Hello again",
      }),
    );
  });

  it("cleans up scheduled work without publishing more preview state", () => {
    const onFlush = vi.fn();
    const cancelFrame = vi.fn();
    const clearTimer = vi.fn();
    const buffer = new ChatStreamingPreviewBuffer({
      onFlush,
      requestFrame: () => 7,
      cancelFrame,
      setTimer: () => 11 as unknown as ReturnType<typeof setTimeout>,
      clearTimer,
    });

    buffer.start({ sessionId: "sess", turnId: "turn" });
    buffer.append({ sessionId: "sess", turnId: "turn", delta: "pending" });
    buffer.dispose();

    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(clearTimer).toHaveBeenCalledWith(11);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});
