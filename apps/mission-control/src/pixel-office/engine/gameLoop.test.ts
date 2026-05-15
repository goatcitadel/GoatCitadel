import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DELTA_TIME_SEC } from "../constants";
import { startGameLoop } from "./gameLoop";

describe("startGameLoop", () => {
  let nextFrame: FrameRequestCallback | null;
  let rafId: number;

  beforeEach(() => {
    nextFrame = null;
    rafId = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        rafId += 1;
        return rafId;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates and renders every frame with capped delta time", () => {
    const ctx = { imageSmoothingEnabled: true } as CanvasRenderingContext2D;
    const canvas = {
      getContext: vi.fn(() => ctx),
    } as unknown as HTMLCanvasElement;
    const update = vi.fn();
    const render = vi.fn();

    const stop = startGameLoop(canvas, { update, render });
    expect(canvas.getContext).toHaveBeenCalledWith("2d");
    expect(ctx.imageSmoothingEnabled).toBe(false);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    nextFrame?.(1000);
    expect(update).toHaveBeenLastCalledWith(0);
    expect(render).toHaveBeenLastCalledWith(ctx);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    nextFrame?.(1100);
    expect(update).toHaveBeenLastCalledWith(0.1);

    nextFrame?.(10_000);
    expect(update).toHaveBeenLastCalledWith(MAX_DELTA_TIME_SEC);

    stop();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(4);

    nextFrame?.(10_100);
    expect(update).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenCalledTimes(3);
  });
});
