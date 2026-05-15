import { afterEach, describe, expect, it, vi } from "vitest";
import { MATRIX_HEAD_COLOR, MATRIX_SPRITE_COLS, MATRIX_SPRITE_ROWS } from "../constants";
import { CharacterState, Direction, MATRIX_EFFECT_DURATION, type Character, type SpriteData } from "../types";
import { matrixEffectSeeds, renderMatrixEffect } from "./matrixEffect";

type DrawCall = { fillStyle: string; x: number; y: number; w: number; h: number };

function character(overrides: Partial<Character>): Character {
  return {
    id: 1,
    state: CharacterState.IDLE,
    dir: Direction.DOWN,
    x: 0,
    y: 0,
    tileCol: 0,
    tileRow: 0,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette: 0,
    hueShift: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: 0,
    isActive: true,
    seatId: null,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: "spawn",
    matrixEffectTimer: MATRIX_EFFECT_DURATION / 2,
    matrixEffectSeeds: new Array(MATRIX_SPRITE_COLS).fill(0),
    ...overrides,
  };
}

function spriteData(): SpriteData {
  return Array.from({ length: MATRIX_SPRITE_ROWS }, (_, row) =>
    Array.from({ length: MATRIX_SPRITE_COLS }, (_, col) =>
      row === col || ((row === 20 || row === 23) && col === 0) ? "#123456" : "",
    ),
  );
}

function mockContext() {
  const calls: DrawCall[] = [];
  const ctx = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ fillStyle: this.fillStyle, x, y, w, h });
    },
  } as CanvasRenderingContext2D & { fillStyle: string };
  return { calls, ctx };
}

describe("matrixEffect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates one stagger seed per sprite column", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);

    expect(matrixEffectSeeds()).toEqual(new Array(MATRIX_SPRITE_COLS).fill(0.25));
  });

  it("renders spawn heads, trail overlays, empty rain, and revealed sprite pixels", () => {
    const { calls, ctx } = mockContext();

    renderMatrixEffect(ctx, character({ matrixEffect: "spawn" }), spriteData(), 10, 20, 2);

    expect(calls.some((call) => call.fillStyle === MATRIX_HEAD_COLOR)).toBe(true);
    expect(calls.some((call) => call.fillStyle === "#123456")).toBe(true);
    expect(calls.some((call) => call.fillStyle.startsWith("rgba(0, 255, 65,"))).toBe(true);
    expect(calls.some((call) => call.x >= 10 && call.y >= 20 && call.w === 2 && call.h === 2)).toBe(true);
  });

  it("renders despawn pixels ahead of the head and fading trail bands", () => {
    const { calls, ctx } = mockContext();

    renderMatrixEffect(
      ctx,
      character({
        matrixEffect: "despawn",
        matrixEffectTimer: MATRIX_EFFECT_DURATION / 2,
        matrixEffectSeeds: new Array(MATRIX_SPRITE_COLS).fill(0),
      }),
      spriteData(),
      0,
      0,
      1,
    );

    expect(calls.some((call) => call.fillStyle === MATRIX_HEAD_COLOR)).toBe(true);
    expect(calls.some((call) => call.fillStyle === "#123456")).toBe(true);
    expect(calls.some((call) => call.fillStyle.startsWith("rgba(0, 170, 40,"))).toBe(true);
  });
});
