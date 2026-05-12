import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startGameLoop } from "./gameLoop";

describe("pixel office game loop", () => {
  const rafCallbacks: FrameRequestCallback[] = [];
  const cancelAnimationFrame = vi.fn();

  beforeEach(() => {
    rafCallbacks.length = 0;
    cancelAnimationFrame.mockClear();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates, renders, clamps large deltas, and cancels future frames", () => {
    const context = { imageSmoothingEnabled: true } as CanvasRenderingContext2D;
    const canvas = {
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;
    const callbacks = {
      update: vi.fn(),
      render: vi.fn(),
    };

    const stop = startGameLoop(canvas, callbacks);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(rafCallbacks).toHaveLength(1);

    rafCallbacks[0]!(1000);
    expect(callbacks.update).toHaveBeenLastCalledWith(0);
    expect(callbacks.render).toHaveBeenLastCalledWith(context);
    expect(rafCallbacks).toHaveLength(2);

    rafCallbacks[1]!(5000);
    expect(callbacks.update).toHaveBeenLastCalledWith(0.1);
    expect(callbacks.render).toHaveBeenCalledTimes(2);

    stop();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(3);
    rafCallbacks[2]!(6000);
    expect(callbacks.update).toHaveBeenCalledTimes(2);
  });
});
