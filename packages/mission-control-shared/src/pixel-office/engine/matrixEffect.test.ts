import { afterEach, describe, expect, it, vi } from "vitest";

import { MATRIX_EFFECT_DURATION, type SpriteData } from "../types";
import { matrixEffectSeeds, renderMatrixEffect } from "./matrixEffect";

function sprite(): SpriteData {
  return Array.from({ length: 32 }, (_row, row) =>
    Array.from({ length: 16 }, (_col, col) => ((row + col) % 3 === 0 ? "#112233" : "")),
  );
}

function context() {
  const fillStyles: unknown[] = [];
  return {
    get fillStyle() {
      return fillStyles.at(-1);
    },
    set fillStyle(value: unknown) {
      fillStyles.push(value);
    },
    fillStyles,
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D & { fillStyles: unknown[]; fillRect: ReturnType<typeof vi.fn> };
}

describe("matrixEffect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates deterministic seed arrays from Math.random", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    expect(matrixEffectSeeds()).toEqual(Array.from({ length: 16 }, () => 0.25));
  });

  it("renders spawn head, trail, empty trail, and revealed character pixels", () => {
    const ctx = context();
    const character = {
      matrixEffect: "spawn",
      matrixEffectTimer: MATRIX_EFFECT_DURATION,
      matrixEffectSeeds: Array.from({ length: 16 }, () => 0),
    };

    renderMatrixEffect(ctx, character as never, sprite(), 10, 20, 2);
    renderMatrixEffect(
      ctx,
      { ...character, matrixEffectTimer: MATRIX_EFFECT_DURATION / 2 } as never,
      sprite(),
      10,
      20,
      2,
    );

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fillStyles).toContain("#112233");
    expect(ctx.fillStyles.some((value) => String(value).startsWith("rgba(0, 255, 65"))).toBe(true);
    expect(ctx.fillStyles.some((value) => String(value).startsWith("rgba(0, 170, 40"))).toBe(true);
  });

  it("renders despawn preserved pixels, head pixels, and trail fade", () => {
    const ctx = context();
    const character = {
      matrixEffect: "despawn",
      matrixEffectTimer: MATRIX_EFFECT_DURATION / 2,
      matrixEffectSeeds: Array.from({ length: 16 }, () => 0),
    };

    renderMatrixEffect(ctx, character as never, sprite(), 0, 0, 1);

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fillStyles).toContain("#112233");
    expect(ctx.fillStyles.some((value) => String(value).includes("255, 65"))).toBe(true);
    expect(ctx.fillStyles.some((value) => String(value).startsWith("rgba(0, 85, 20"))).toBe(true);
  });
});
