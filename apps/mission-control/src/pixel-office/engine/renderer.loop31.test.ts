// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import type { Character, Seat } from "../types";
import { CharacterState, Direction, TILE_SIZE, TileType } from "../types";

vi.mock("../sprites/spriteCache", () => ({
  getCachedSprite: (sprite: string[][], zoom: number) => ({
    width: (sprite[0]?.length ?? 1) * zoom,
    height: sprite.length * zoom,
  }),
  getOutlineSprite: (sprite: string[][]) => sprite,
}));

vi.mock("../sprites/spriteData", () => ({
  BUBBLE_PERMISSION_SPRITE: [["#ffffff"]],
  BUBBLE_WAITING_SPRITE: [["#ffffff"]],
  getCharacterSprites: () => ({
    typing: [
      [[["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]]],
    ],
    reading: [
      [[["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]]],
    ],
    walk: [
      [[["#fff"]], [["#fff"]], [["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]], [["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]], [["#fff"]], [["#fff"]]],
      [[["#fff"]], [["#fff"]], [["#fff"]], [["#fff"]]],
    ],
  }),
}));

vi.mock("../floorTiles", () => ({
  getColorizedFloorSprite: () => [["#222"]],
  hasFloorSprites: () => true,
  WALL_COLOR: "#3a3a5c",
}));

vi.mock("../wallTiles", () => ({
  getWallInstances: () => [{ sprite: [["#999"]], x: 32, y: 16, zY: 48 }],
  hasWallSprites: () => true,
  wallColorToHex: () => "#123456",
}));

import { renderBubbles, renderFrame, renderGhostPreview, renderSeatIndicators } from "./renderer";

function createContext() {
  const calls: string[] = [];
  const ctx = {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    globalAlpha: 1,
    fillRect: vi.fn((...args: unknown[]) => calls.push(`fillRect:${args.join(",")}`)),
    strokeRect: vi.fn((...args: unknown[]) => calls.push(`strokeRect:${args.join(",")}`)),
    drawImage: vi.fn(() => calls.push("drawImage")),
    clearRect: vi.fn(() => calls.push("clearRect")),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    save: vi.fn(() => calls.push("save")),
    restore: vi.fn(() => calls.push("restore")),
    translate: vi.fn(() => calls.push("translate")),
    scale: vi.fn(() => calls.push("scale")),
    setLineDash: vi.fn(),
  };
  return ctx;
}

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: 1,
    state: CharacterState.IDLE,
    dir: Direction.DOWN,
    x: TILE_SIZE,
    y: TILE_SIZE,
    tileCol: 1,
    tileRow: 1,
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
    seatId: "seat-own",
    bubbleType: null,
    bubbleTimer: 1,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    ...overrides,
  };
}

describe("renderer Loop 31 tails", () => {
  it("renders own and busy seat indicators while leaving missing selections untouched", () => {
    const ctx = createContext();
    const seats = new Map<string, Seat>([
      ["seat-own", { uid: "seat-own", seatCol: 1, seatRow: 1, facingDir: Direction.UP, assigned: true }],
      ["seat-busy", { uid: "seat-busy", seatCol: 2, seatRow: 1, facingDir: Direction.UP, assigned: true }],
    ]);
    const characters = new Map([[1, character({ seatId: "seat-own" })]]);

    renderSeatIndicators(ctx as never, seats, characters, null, { col: 1, row: 1 }, 0, 0, 1);
    renderSeatIndicators(ctx as never, seats, characters, 404, { col: 1, row: 1 }, 0, 0, 1);
    expect(ctx.fillRect).not.toHaveBeenCalled();

    renderSeatIndicators(ctx as never, seats, characters, 1, { col: 1, row: 1 }, 0, 0, 1);
    expect(ctx.fillStyle).toContain("0, 127, 212");

    renderSeatIndicators(ctx as never, seats, characters, 1, { col: 2, row: 1 }, 0, 0, 1);
    expect(ctx.fillStyle).toContain("220, 50, 50");
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  it("renders non-mirrored ghosts and full-opacity waiting bubbles", () => {
    const ctx = createContext();

    renderGhostPreview(ctx as never, [["#fff", "#000"]], 2, 3, true, 4, 5, 2, false);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 68, 101);
    expect(ctx.calls).not.toContain("translate");

    renderBubbles(ctx as never, [character({ bubbleType: "waiting", bubbleTimer: 2 })], 0, 0, 1);
    expect(ctx.globalAlpha).toBe(0.25);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
  });

  it("composes wall instances into frames and clears editor bounds without a selection", () => {
    const ctx = createContext();
    const editor = {
      showGrid: false,
      ghostSprite: null,
      ghostMirrored: false,
      ghostCol: -1,
      ghostRow: -1,
      ghostValid: false,
      selectedCol: 0,
      selectedRow: 0,
      selectedW: 1,
      selectedH: 1,
      hasSelection: false,
      isRotatable: true,
      deleteButtonBounds: { cx: 1, cy: 1, radius: 1 },
      rotateButtonBounds: { cx: 2, cy: 2, radius: 1 },
      showGhostBorder: false,
      ghostBorderHoverCol: -1,
      ghostBorderHoverRow: -1,
    };

    const offsets = renderFrame(
      ctx as never,
      128,
      96,
      [
        [TileType.WALL, TileType.FLOOR_1],
        [TileType.FLOOR_2, TileType.WALL],
      ],
      [{ sprite: [["#0f0"]], x: 0, y: 0, zY: 1 }],
      [character({ id: 1, state: CharacterState.TYPE })],
      2,
      3.4,
      -2.6,
      undefined,
      editor,
      [{ h: 10, s: 20, b: 0, c: 0 }, null, null, { h: 40, s: 10, b: 5, c: 0 }],
      2,
      2,
    );

    expect(offsets).toEqual({ offsetX: 35, offsetY: 13 });
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 128, 96);
    expect(ctx.drawImage).toHaveBeenCalled();
    expect(editor.deleteButtonBounds).toBeNull();
    expect(editor.rotateButtonBounds).toBeNull();
  });
});
