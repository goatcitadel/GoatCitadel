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

vi.mock("../wallTiles", () => ({
  getWallInstances: () => [],
  hasWallSprites: () => false,
  wallColorToHex: () => "#123456",
}));

import {
  renderBubbles,
  renderDeleteButton,
  renderFrame,
  renderGhostBorder,
  renderGhostPreview,
  renderGridOverlay,
  renderRotateButton,
  renderScene,
  renderSeatIndicators,
  renderSelectionHighlight,
  renderTileGrid,
} from "./renderer";

function createContext() {
  const calls: string[] = [];
  const ctx = {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    globalAlpha: 1,
    imageSmoothingEnabled: false,
    fillRect: vi.fn((...args: unknown[]) => calls.push(`fillRect:${args.join(",")}`)),
    strokeRect: vi.fn((...args: unknown[]) => calls.push(`strokeRect:${args.join(",")}`)),
    drawImage: vi.fn(() => calls.push("drawImage")),
    clearRect: vi.fn(() => calls.push("clearRect")),
    beginPath: vi.fn(() => calls.push("beginPath")),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(() => calls.push("stroke")),
    fill: vi.fn(() => calls.push("fill")),
    arc: vi.fn(),
    save: vi.fn(() => calls.push("save")),
    restore: vi.fn(() => calls.push("restore")),
    translate: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
  };
  return ctx;
}

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: 1,
    state: CharacterState.TYPE,
    dir: Direction.DOWN,
    x: TILE_SIZE * 2,
    y: TILE_SIZE * 2,
    tileCol: 2,
    tileRow: 2,
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
    seatId: "seat-1",
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    ...overrides,
  };
}

describe("renderer", () => {
  it("renders tiles, overlays, controls, and a complete frame", () => {
    const ctx = createContext();
    const tileMap = [
      [TileType.WALL, TileType.FLOOR_1, TileType.VOID],
      [TileType.FLOOR_2, TileType.FLOOR_1, TileType.WALL],
    ];
    const seat: Seat = { uid: "seat-1", seatCol: 1, seatRow: 1, facingDir: Direction.UP, assigned: false };
    const seats = new Map([["seat-1", seat]]);
    const chars = new Map([[1, character()]]);

    renderTileGrid(ctx as never, tileMap, 0, 0, 1, [null, { h: 0, s: 0, b: 0, c: 0 }, null, null, null, null], 3);
    renderSeatIndicators(ctx as never, seats, chars, 1, { col: 1, row: 1 }, 0, 0, 1);
    renderGridOverlay(ctx as never, 0, 0, 1, 3, 2, tileMap);
    renderGhostBorder(ctx as never, 0, 0, 1, 3, 2, -1, 0);
    renderGhostPreview(ctx as never, [["#fff"]], 1, 1, true, 0, 0, 1, true);
    renderSelectionHighlight(ctx as never, 1, 1, 2, 1, 0, 0, 1);

    const deleteBounds = renderDeleteButton(ctx as never, 1, 1, 2, 1, 0, 0, 1);
    const rotateBounds = renderRotateButton(ctx as never, 1, 1, 2, 1, 0, 0, 1);
    expect(deleteBounds.radius).toBeGreaterThan(0);
    expect(rotateBounds.radius).toBeGreaterThan(0);

    const editor = {
      showGrid: true,
      ghostSprite: [["#fff"]],
      ghostMirrored: false,
      ghostCol: 1,
      ghostRow: 1,
      ghostValid: false,
      selectedCol: 1,
      selectedRow: 1,
      selectedW: 1,
      selectedH: 1,
      hasSelection: true,
      isRotatable: false,
      deleteButtonBounds: null,
      rotateButtonBounds: null,
      showGhostBorder: true,
      ghostBorderHoverCol: -1,
      ghostBorderHoverRow: 0,
    };
    const offsets = renderFrame(
      ctx as never,
      200,
      120,
      tileMap,
      [{ sprite: [["#0f0"]], x: 0, y: 0, zY: 1, mirrored: true }],
      [character({ bubbleType: "permission" })],
      1,
      0,
      0,
      { selectedAgentId: 1, hoveredAgentId: null, hoveredTile: { col: 1, row: 1 }, seats, characters: chars },
      editor,
      undefined,
      3,
      2,
    );

    expect(offsets.offsetX).toBeGreaterThan(0);
    expect(editor.deleteButtonBounds).toBeTruthy();
    expect(editor.rotateButtonBounds).toBeNull();
    expect(ctx.drawImage).toHaveBeenCalled();
    expect(ctx.strokeRect).toHaveBeenCalled();
  });

  it("renders scene selection outlines and waiting bubbles", () => {
    const ctx = createContext();
    renderScene(
      ctx as never,
      [{ sprite: [["#0f0"]], x: 0, y: 0, zY: 0 }],
      [character({ id: 1 }), character({ id: 2, x: 40, y: 40 })],
      0,
      0,
      1,
      1,
      2,
    );
    renderBubbles(ctx as never, [character({ bubbleType: "waiting", bubbleTimer: 0.1 })], 0, 0, 1);

    expect(ctx.save).toHaveBeenCalled();
    expect(ctx.restore).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it("renders matrix-effect characters through the per-pixel path", () => {
    const ctx = createContext();
    renderScene(
      ctx as never,
      [],
      [
        character({
          matrixEffect: "spawn",
          matrixEffectTimer: 0.3,
          matrixEffectSeeds: Array.from({ length: 16 }, () => 0),
        }),
        character({
          id: 2,
          x: 48,
          y: 48,
          matrixEffect: "despawn",
          matrixEffectTimer: 0.3,
          matrixEffectSeeds: Array.from({ length: 16 }, () => 0),
        }),
      ],
      0,
      0,
      1,
      null,
      null,
    );

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });
});
