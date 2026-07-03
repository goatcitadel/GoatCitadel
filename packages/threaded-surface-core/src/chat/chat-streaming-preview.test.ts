import { describe, expect, it, vi } from "vitest";
import { ChatStreamingPreviewBuffer, resolveVisibleStreamingText } from "./chat-streaming-preview";

describe("chat streaming preview", () => {
  it("reveals an in-progress line instead of waiting for a newline", () => {
    expect(resolveVisibleStreamingText("First line\nsecond", 1000, 1010, { revealCharsPerFrame: 120 })).toBe(
      "First line\nsecond",
    );
  });

  it("continues from the prior visible prefix", () => {
    expect(
      resolveVisibleStreamingText("short answer continues", 1000, 1016, {
        previousVisibleText: "short",
        revealCharsPerFrame: 7,
      }),
    ).toBe("short answer");
  });

  it("keeps late no-newline chunks on the frame reveal budget", () => {
    expect(
      resolveVisibleStreamingText("short answer continues", 1000, 2000, {
        previousVisibleText: "short",
        revealCharsPerFrame: 7,
        noNewlineRevealChars: 80,
      }),
    ).toBe("short answer");
  });

  it("reveals long no-newline answers progressively", () => {
    const content = "x".repeat(80);
    const firstFrame = resolveVisibleStreamingText(content, 1000, 1005, { revealCharsPerFrame: 12 });
    const secondFrame = resolveVisibleStreamingText(content, 1000, 1021, {
      previousVisibleText: firstFrame,
      revealCharsPerFrame: 12,
    });

    expect(firstFrame).toBe("x".repeat(12));
    expect(secondFrame).toBe("x".repeat(24));
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

    now = 1016;
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

  it("keeps revealing a large incoming chunk on follow-up frames", () => {
    const frameCallbacks: Array<() => void> = [];
    const timerCallbacks: Array<() => void> = [];
    const onFlush = vi.fn();
    const buffer = new ChatStreamingPreviewBuffer({
      now: () => 1000,
      onFlush,
      revealCharsPerFrame: 5,
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

    buffer.start({ sessionId: "sess", turnId: "turn" });
    buffer.append({ sessionId: "sess", turnId: "turn", delta: "Hello smooth stream" });

    frameCallbacks.shift()?.();
    expect(onFlush).toHaveBeenLastCalledWith(expect.objectContaining({ visibleText: "Hello" }));

    frameCallbacks.shift()?.();
    expect(onFlush).toHaveBeenLastCalledWith(expect.objectContaining({ visibleText: "Hello smoo" }));

    frameCallbacks.shift()?.();
    expect(onFlush).toHaveBeenLastCalledWith(expect.objectContaining({ visibleText: "Hello smooth st" }));
    expect(timerCallbacks.length).toBeGreaterThan(0);
  });

  it("reveals message_done final text before clearing the preview", () => {
    const frameCallbacks: Array<() => void> = [];
    const onFlush = vi.fn();
    const finalText = "A compact smooth chat UI keeps late final chunks visually streaming.";
    const buffer = new ChatStreamingPreviewBuffer({
      now: () => 1000,
      onFlush,
      revealCharsPerFrame: 8,
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: vi.fn(),
      setTimer: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      isReducedMotion: () => false,
    });

    buffer.start({ sessionId: "sess", turnId: "turn" });
    buffer.finish({ clear: true, forceVisible: false, finalText });

    expect(onFlush).toHaveBeenLastCalledWith(expect.objectContaining({ visibleText: finalText.slice(0, 8) }));
    expect(onFlush).not.toHaveBeenLastCalledWith(null);

    while (frameCallbacks.length > 0 && onFlush.mock.calls.at(-1)?.[0] !== null) {
      frameCallbacks.shift()?.();
    }

    const visibleTexts = onFlush.mock.calls
      .map(([preview]) => preview?.visibleText)
      .filter((visibleText): visibleText is string => typeof visibleText === "string" && visibleText.length > 0);

    expect(visibleTexts).toContain(finalText.slice(0, 16));
    expect(visibleTexts.at(-1)).toBe(finalText);
    expect(onFlush).toHaveBeenLastCalledWith(null);
  });

  it("forces divergent message_done final text visible before clearing", () => {
    const frameCallbacks: Array<() => void> = [];
    const onFlush = vi.fn();
    const finalText = "Final server answer replaced the optimistic preview.";
    const buffer = new ChatStreamingPreviewBuffer({
      now: () => 1000,
      onFlush,
      revealCharsPerFrame: 5,
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: vi.fn(),
      setTimer: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      isReducedMotion: () => false,
    });

    buffer.start({ sessionId: "sess", turnId: "turn" });
    buffer.append({ sessionId: "sess", turnId: "turn", delta: "Draft visible prefix" });
    frameCallbacks.shift()?.();
    expect(onFlush).toHaveBeenLastCalledWith(expect.objectContaining({ visibleText: "Draft" }));

    buffer.finish({ clear: true, forceVisible: false, finalText });

    const finalIndex = onFlush.mock.calls.findIndex(([preview]) => preview?.visibleText === finalText);
    const clearIndex = onFlush.mock.calls.findIndex(([preview], index) => index > finalIndex && preview === null);

    expect(finalIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(finalIndex);
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

  it("adaptive reveal: 3000-char backlog / base 18 → reveals ceil(3000/15)=200 chars", () => {
    const backlog = "x".repeat(3000);
    const result = resolveVisibleStreamingText(backlog, 1000, 1016, {
      previousVisibleText: "",
      revealCharsPerFrame: 18,
    });
    expect(result.length).toBe(200);
  });

  it("adaptive reveal: 100000-char backlog → capped at MAX_REVEAL_CHARS_PER_FRAME (600)", () => {
    const backlog = "x".repeat(100000);
    const result = resolveVisibleStreamingText(backlog, 1000, 1016, {
      previousVisibleText: "",
      revealCharsPerFrame: 18,
    });
    expect(result.length).toBe(600);
  });

  it("adaptive reveal: 30-char backlog / base 18 → reveals 18 (base floor preserved)", () => {
    const backlog = "x".repeat(30);
    const result = resolveVisibleStreamingText(backlog, 1000, 1016, {
      previousVisibleText: "",
      revealCharsPerFrame: 18,
    });
    expect(result.length).toBe(18);
  });

  it("adaptive reveal: large incoming chunk drains within bounded frames with no single step > 600", () => {
    const frameCallbacks: Array<() => void> = [];
    const onFlush = vi.fn();
    const buffer = new ChatStreamingPreviewBuffer({
      now: () => 1000,
      onFlush,
      revealCharsPerFrame: 18,
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: vi.fn(),
      setTimer: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      isReducedMotion: () => false,
    });

    buffer.start({ sessionId: "sess", turnId: "turn" });
    buffer.append({ sessionId: "sess", turnId: "turn", delta: "x".repeat(5000) });

    let lastVisibleLength = 0;
    let converged = false;

    // Pump frames until convergence to full text or max 200 frames
    for (let i = 0; i < 200 && frameCallbacks.length > 0; i++) {
      frameCallbacks.shift()?.();
      const lastCall = onFlush.mock.calls.at(-1);
      const preview = lastCall?.[0];
      if (preview) {
        const step = preview.visibleText.length - lastVisibleLength;
        expect(step).toBeLessThanOrEqual(600);
        lastVisibleLength = preview.visibleText.length;
        if (preview.visibleText.length === preview.text.length) {
          converged = true;
          break;
        }
      }
    }

    expect(converged).toBe(true);
  });

  it("regression: finish({ finalText }) force-reveal path still works", () => {
    const frameCallbacks: Array<() => void> = [];
    const onFlush = vi.fn();
    const finalText = "Final text revealed.";
    const buffer = new ChatStreamingPreviewBuffer({
      now: () => 1000,
      onFlush,
      revealCharsPerFrame: 5,
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: vi.fn(),
      setTimer: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      isReducedMotion: () => false,
    });

    buffer.start({ sessionId: "sess", turnId: "turn" });
    buffer.finish({ clear: true, forceVisible: false, finalText });

    // Pump frames to reveal the final text progressively
    while (frameCallbacks.length > 0 && onFlush.mock.calls.at(-1)?.[0]?.visibleText !== finalText) {
      frameCallbacks.shift()?.();
    }

    const finalIndex = onFlush.mock.calls.findIndex(([preview]) => preview?.visibleText === finalText);
    expect(finalIndex).toBeGreaterThan(-1);
  });
});
