import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adjustSprite, clearColorizeCache, colorizeSprite, getColorizedSprite } from "./colorize";
import {
  WALL_COLOR,
  getAllFloorSprites,
  getColorizedFloorSprite,
  getFloorPatternCount,
  getFloorSprite,
  hasFloorSprites,
  setFloorSprites,
} from "./floorTiles";
import {
  buildDynamicCatalog,
  getActiveCatalog,
  getActiveCategories,
  getAnimationFrames,
  getCatalogByCategory,
  getCatalogEntry,
  getOffStateType,
  getOnStateType,
  getOrientationInGroup,
  getRotatedType,
  getToggledType,
  isRotatable,
  type LoadedAssetData,
} from "./layout/furnitureCatalog";
import {
  createDefaultLayout,
  deserializeLayout,
  getBlockedTiles,
  getPlacementBlockedTiles,
  getSeatTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
  migrateLayoutColors,
  serializeLayout,
} from "./layout/layoutSerializer";
import { findPath, getWalkableTiles, isWalkable } from "./layout/tileMap";
import {
  getColorizedWallSprite,
  getWallInstances,
  getWallSetCount,
  getWallSetPreviewSprite,
  getWallSprite,
  hasWallSprites,
  setWallSprites,
  wallColorToHex,
} from "./wallTiles";
import {
  Direction,
  CharacterState,
  MATRIX_EFFECT_DURATION,
  TILE_SIZE,
  TileType,
  type OfficeLayout,
  type Seat,
  type SpriteData,
} from "./types";
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
  flipSpriteHorizontal,
  getCharacterSprites,
  setCharacterTemplates,
} from "./sprites/spriteData";
import { getCachedSprite, getOutlineSprite } from "./sprites/spriteCache";
import { createCharacter, getCharacterSprite, isReadingTool, updateCharacter } from "./engine/characters";
import { matrixEffectSeeds, renderMatrixEffect } from "./engine/matrixEffect";
import { OfficeState } from "./engine/officeState";
import {
  renderBubbles,
  renderDeleteButton,
  renderFrame,
  renderGhostBorder,
  renderGhostPreview,
  renderGridOverlay,
  renderScene,
  renderSeatIndicators,
  renderSelectionHighlight,
  renderTileGrid,
} from "./engine/renderer";

type FakeContext = CanvasRenderingContext2D & {
  calls: string[];
};

const sprite: SpriteData = [
  ["#111111", ""],
  ["#888888", "#FFFFFF80"],
];
const tallSprite: SpriteData = Array.from({ length: 32 }, () => Array.from({ length: 16 }, () => "#445566"));

function fakeContext(): FakeContext {
  const calls: string[] = [];
  const ctx = {
    calls,
    imageSmoothingEnabled: false,
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    beginPath: vi.fn(() => calls.push("beginPath")),
    moveTo: vi.fn(() => calls.push("moveTo")),
    lineTo: vi.fn(() => calls.push("lineTo")),
    stroke: vi.fn(() => calls.push("stroke")),
    fill: vi.fn(() => calls.push("fill")),
    fillRect: vi.fn(() => calls.push("fillRect")),
    strokeRect: vi.fn(() => calls.push("strokeRect")),
    clearRect: vi.fn(() => calls.push("clearRect")),
    drawImage: vi.fn(() => calls.push("drawImage")),
    save: vi.fn(() => calls.push("save")),
    restore: vi.fn(() => calls.push("restore")),
    translate: vi.fn(() => calls.push("translate")),
    scale: vi.fn(() => calls.push("scale")),
    arc: vi.fn(() => calls.push("arc")),
    setLineDash: vi.fn(() => calls.push("setLineDash")),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 1, 0, 0, 255, 255, 255, 255, 255, 255]),
    })),
  };
  return ctx as unknown as FakeContext;
}

function installCanvasDocument() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      createElement: vi.fn((tag: string) => ({
        tagName: tag,
        width: 0,
        height: 0,
        style: {},
        getContext: vi.fn(() => fakeContext()),
      })),
    },
  });
}

function buildAssets(): LoadedAssetData {
  const catalog = [
    {
      id: "DESK_FRONT",
      label: "Desk - Front - Off",
      category: "desks",
      width: 2,
      height: 2,
      footprintW: 2,
      footprintH: 1,
      isDesk: true,
      groupId: "DESK",
      orientation: "front",
      state: "off",
    },
    {
      id: "DESK_RIGHT",
      label: "Desk - Right - Off",
      category: "desks",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 2,
      isDesk: true,
      groupId: "DESK",
      orientation: "right",
      state: "off",
    },
    {
      id: "DESK_BACK",
      label: "Desk - Back - Off",
      category: "desks",
      width: 2,
      height: 2,
      footprintW: 2,
      footprintH: 1,
      isDesk: true,
      groupId: "DESK",
      orientation: "back",
      state: "off",
    },
    {
      id: "DESK_SIDE",
      label: "Desk - Side - Off",
      category: "desks",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 2,
      isDesk: true,
      groupId: "DESK",
      orientation: "side",
      state: "off",
      mirrorSide: true,
    },
    {
      id: "PC_FRONT_OFF",
      label: "PC - Front - Off",
      category: "electronics",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      groupId: "PC",
      orientation: "front",
      state: "off",
      canPlaceOnSurfaces: true,
    },
    {
      id: "PC_FRONT_ON",
      label: "PC - Front - On",
      category: "electronics",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      groupId: "PC",
      orientation: "front",
      state: "on",
      animationGroup: "PC_FRONT_ON",
      frame: 0,
      canPlaceOnSurfaces: true,
    },
    {
      id: "PC_FRONT_ON_1",
      label: "PC - Front - On",
      category: "electronics",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      groupId: "PC",
      orientation: "front",
      state: "on",
      animationGroup: "PC_FRONT_ON",
      frame: 1,
      canPlaceOnSurfaces: true,
    },
    {
      id: "WOODEN_CHAIR_FRONT",
      label: "Wooden Chair - Front",
      category: "chairs",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      orientation: "front",
      groupId: "CHAIR",
    },
    {
      id: "WOODEN_CHAIR_BACK",
      label: "Wooden Chair - Back",
      category: "chairs",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      orientation: "back",
      groupId: "CHAIR",
    },
    {
      id: "BOOKSHELF",
      label: "Bookshelf",
      category: "storage",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 2,
      backgroundTiles: 1,
      isDesk: false,
    },
    {
      id: "WALL_DECOR",
      label: "Wall decor",
      category: "wall",
      width: 2,
      height: 2,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      canPlaceOnWalls: true,
    },
  ];
  const sprites = Object.fromEntries(catalog.map((entry) => [entry.id, sprite]));
  return { catalog, sprites };
}

function testLayout(): OfficeLayout {
  return {
    version: 1,
    cols: 5,
    rows: 5,
    tiles: [
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.FLOOR_1,
      TileType.FLOOR_1,
      TileType.FLOOR_2,
      TileType.WALL,
      TileType.WALL,
      TileType.FLOOR_1,
      TileType.FLOOR_2,
      TileType.FLOOR_3,
      TileType.WALL,
      TileType.WALL,
      TileType.FLOOR_1,
      TileType.FLOOR_2,
      TileType.FLOOR_3,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
      TileType.WALL,
    ],
    tileColors: Array.from({ length: 25 }, (_, index) => (index % 5 === 0 ? null : { h: 120, s: 20, b: 5, c: 0 })),
    furniture: [
      { uid: "desk", type: "DESK_FRONT", col: 1, row: 1 },
      { uid: "chair", type: "WOODEN_CHAIR_BACK", col: 1, row: 2 },
      { uid: "chair2", type: "WOODEN_CHAIR_FRONT", col: 3, row: 2 },
      { uid: "pc", type: "PC_FRONT_OFF", col: 1, row: 1, color: { h: 60, s: 20, b: 10, c: 0 } },
      { uid: "shelf", type: "BOOKSHELF", col: 3, row: 1 },
      { uid: "unknown", type: "NOPE", col: 4, row: 4 },
    ],
  };
}

function openLayout(cols = 4, rows = 4, furniture: OfficeLayout["furniture"] = []): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: Array.from({ length: cols * rows }, () => TileType.FLOOR_1),
    tileColors: Array.from({ length: cols * rows }, () => null),
    furniture,
  };
}

function testSprites() {
  const walk = {
    [Direction.DOWN]: [sprite, sprite, sprite, sprite],
    [Direction.UP]: [sprite, sprite, sprite, sprite],
    [Direction.RIGHT]: [sprite, sprite, sprite, sprite],
    [Direction.LEFT]: [sprite, sprite, sprite, sprite],
  };
  const pairs = {
    [Direction.DOWN]: [sprite, sprite],
    [Direction.UP]: [sprite, sprite],
    [Direction.RIGHT]: [sprite, sprite],
    [Direction.LEFT]: [sprite, sprite],
  };
  return { walk, typing: pairs, reading: pairs };
}

describe("pixel office core modules", () => {
  beforeEach(() => {
    installCanvasDocument();
    vi.spyOn(Math, "random").mockReturnValue(0);
    clearColorizeCache();
    setFloorSprites([]);
    setWallSprites([]);
    setCharacterTemplates([{ down: Array(7).fill(sprite), up: Array(7).fill(sprite), right: Array(7).fill(sprite) }]);
    buildDynamicCatalog(buildAssets());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds and queries a dynamic furniture catalog", () => {
    expect(buildDynamicCatalog({ catalog: [], sprites: {} })).toBe(false);
    expect(buildDynamicCatalog({ catalog: [{ ...buildAssets().catalog[0], id: "MISSING" }], sprites: {} })).toBe(false);
    expect(buildDynamicCatalog(buildAssets())).toBe(true);

    expect(getActiveCatalog().map((entry) => entry.type)).toContain("DESK_FRONT");
    expect(getCatalogByCategory("desks").map((entry) => entry.type)).toEqual(expect.arrayContaining(["DESK_FRONT"]));
    expect(getActiveCategories().map((item) => item.id)).toContain("electronics");
    expect(getCatalogEntry("DESK_SIDE")?.mirrorSide).toBe(true);
    expect(getRotatedType("DESK_FRONT", "cw")).toBe("DESK_SIDE");
    expect(getRotatedType("DESK_FRONT", "ccw")).toBe("DESK_SIDE:left");
    expect(getRotatedType("MISSING", "cw")).toBeNull();
    expect(getToggledType("PC_FRONT_OFF")).toBe("PC_FRONT_ON");
    expect(getOnStateType("PC_FRONT_OFF")).toBe("PC_FRONT_ON");
    expect(getOffStateType("PC_FRONT_ON")).toBe("PC_FRONT_OFF");
    expect(getOnStateType("BOOKSHELF")).toBe("BOOKSHELF");
    expect(isRotatable("DESK_BACK")).toBe(true);
    expect(isRotatable("BOOKSHELF")).toBe(false);
    expect(getAnimationFrames("PC_FRONT_ON_1")).toEqual(["PC_FRONT_ON", "PC_FRONT_ON_1"]);
    expect(getAnimationFrames("BOOKSHELF")).toBeNull();
    expect(getOrientationInGroup("DESK_SIDE:left")).toBe("left");
    expect(getOrientationInGroup("BOOKSHELF")).toBeUndefined();
  });

  it("serializes layouts, seats, furniture instances, and pathable tiles", () => {
    const layout = testLayout();
    const tileMap = layoutToTileMap(layout);
    expect(tileMap[1][1]).toBe(TileType.FLOOR_1);
    expect(
      layoutToFurnitureInstances([
        { uid: "desk", type: "DESK_FRONT", col: 0, row: 0 },
        { uid: "pc", type: "PC_FRONT_ON", col: 0, row: 0 },
        { uid: "left", type: "DESK_SIDE:left", col: 2, row: 0 },
      ]),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ mirrored: true })]));
    expect(layoutToFurnitureInstances(layout.furniture)).toEqual(
      expect.arrayContaining([expect.objectContaining({ x: TILE_SIZE, y: TILE_SIZE })]),
    );
    expect(getBlockedTiles(layout.furniture).has("3,2")).toBe(true);
    expect(getBlockedTiles(layout.furniture, new Set(["3,2"])).has("3,2")).toBe(false);
    expect(getBlockedTiles([{ uid: "shelf", type: "BOOKSHELF", col: 3, row: 1 }])).toEqual(new Set(["3,2"]));
    expect(getPlacementBlockedTiles([{ uid: "shelf", type: "BOOKSHELF", col: 3, row: 1 }], "shelf").size).toBe(0);
    expect(getPlacementBlockedTiles([{ uid: "shelf", type: "BOOKSHELF", col: 3, row: 1 }])).toEqual(new Set(["3,2"]));

    const seats = layoutToSeats(layout.furniture);
    expect(seats.get("chair")?.facingDir).toBe(Direction.UP);
    expect(getSeatTiles(seats).has("1,2")).toBe(true);
    expect(isWalkable(1, 2, tileMap, new Set())).toBe(true);
    expect(isWalkable(0, 0, tileMap, new Set())).toBe(false);
    expect(isWalkable(-1, 0, tileMap, new Set())).toBe(false);
    expect(getWalkableTiles(tileMap, new Set(["1,2"])).some((tile) => tile.col === 2 && tile.row === 2)).toBe(true);
    expect(findPath(1, 2, 3, 2, tileMap, new Set())).toEqual(
      expect.arrayContaining([expect.objectContaining({ col: 3, row: 2 })]),
    );
    expect(findPath(1, 2, 1, 2, tileMap, new Set())).toEqual([]);
    expect(findPath(1, 2, 0, 0, tileMap, new Set())).toEqual([]);

    expect(deserializeLayout("not json")).toBeNull();
    expect(deserializeLayout(serializeLayout(layout))?.furniture).toHaveLength(layout.furniture.length);
    expect(
      migrateLayoutColors({
        version: 1,
        cols: 2,
        rows: 2,
        tiles: [0, 1, 2, 8 as never],
        furniture: [
          { uid: "old", type: "cooler", col: 1, row: 1 },
          { uid: "legacy", type: "desk", col: 0, row: 1 },
          { uid: "modern", type: "DESK_FRONT", col: 0, row: 0 },
        ],
      }).tileColors,
    ).toHaveLength(4);
    expect(createDefaultLayout().tiles).toHaveLength(220);
  });

  it("stores floor, wall, sprite, and character render data", () => {
    expect(hasFloorSprites()).toBe(true);
    expect(getFloorPatternCount()).toBe(1);
    expect(getFloorSprite(0)).toBeNull();
    expect(getFloorSprite(1)).toHaveLength(16);
    expect(getAllFloorSprites()).toHaveLength(1);
    setFloorSprites([sprite]);
    expect(getFloorPatternCount()).toBe(1);
    expect(getColorizedFloorSprite(1, { h: 120, s: 50, b: 10, c: 10 })[0][0]).toMatch(/^#/);
    expect(getColorizedFloorSprite(99, { h: 120, s: 50, b: 10, c: 10 })[0][0]).toBe("#FF00FF");
    expect(WALL_COLOR).toMatch(/^#/);

    expect(hasWallSprites()).toBe(false);
    setWallSprites([Array.from({ length: 16 }, () => sprite)]);
    expect(hasWallSprites()).toBe(true);
    expect(getWallSetCount()).toBe(1);
    expect(getWallSetPreviewSprite(0)).toBe(sprite);
    expect(getWallSetPreviewSprite(9)).toBeNull();
    const tileMap = layoutToTileMap(testLayout());
    expect(getWallSprite(0, 0, tileMap)?.sprite).toBe(sprite);
    expect(getColorizedWallSprite(0, 0, tileMap, { h: 200, s: 20, b: 0, c: 0 })?.sprite[0][0]).toMatch(/^#/);
    expect(getWallInstances(tileMap, testLayout().tileColors, testLayout().cols)).toHaveLength(16);
    expect(wallColorToHex({ h: 180, s: 60, b: 10, c: 20 })).toMatch(/^#/);

    expect(colorizeSprite(sprite, { h: 200, s: 40, b: 10, c: 10 })[1][1]).toMatch(/^#/);
    expect(adjustSprite(sprite, { h: -30, s: -20, b: -5, c: -10 })[1][1]).toMatch(/^#/);
    const cached = getColorizedSprite("key", sprite, { h: 20, s: 20, b: 0, c: 0 });
    expect(getColorizedSprite("key", sprite, { h: 40, s: 40, b: 20, c: 20 })).toBe(cached);

    expect(getOutlineSprite(sprite)).toBe(getOutlineSprite(sprite));
    expect(getCachedSprite(sprite, 2)).toBe(getCachedSprite(sprite, 2));
    expect(BUBBLE_PERMISSION_SPRITE.length).toBeGreaterThan(0);
    expect(BUBBLE_WAITING_SPRITE.length).toBeGreaterThan(0);
    expect(flipSpriteHorizontal(sprite)[0]).toEqual(["", "#111111"]);

    const loaded = { down: Array(7).fill(sprite), up: Array(7).fill(sprite), right: Array(7).fill(sprite) };
    setCharacterTemplates([loaded]);
    expect(getCharacterSprites(0).walk[Direction.LEFT][0]).toEqual(flipSpriteHorizontal(sprite));
    expect(getCharacterSprites(0, 90).typing[Direction.DOWN][0][0][0]).toMatch(/^#/);
  });

  it("updates characters across typing, walking, idle, and sprite states", () => {
    const seat: Seat = { uid: "seat", seatCol: 1, seatRow: 1, facingDir: Direction.UP, assigned: false };
    const seats = new Map([["seat", seat]]);
    const tileMap = [
      [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
      [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
      [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
    ];
    const ch = createCharacter(1, 2, "seat", seat, 45);
    expect(ch.dir).toBe(Direction.UP);
    expect(isReadingTool("Read")).toBe(true);
    expect(isReadingTool("Bash")).toBe(false);

    updateCharacter(ch, 1, getWalkableTiles(tileMap, new Set()), seats, tileMap, new Set());
    expect(ch.frame).toBe(1);
    ch.isActive = false;
    ch.seatTimer = 0;
    updateCharacter(ch, 1, getWalkableTiles(tileMap, new Set()), seats, tileMap, new Set());
    expect(ch.state).toBe(CharacterState.IDLE);
    ch.isActive = true;
    ch.tileCol = 2;
    ch.tileRow = 1;
    updateCharacter(ch, 1, getWalkableTiles(tileMap, new Set()), seats, tileMap, new Set());
    expect(ch.state).toBe(CharacterState.WALK);
    updateCharacter(ch, 1, getWalkableTiles(tileMap, new Set()), seats, tileMap, new Set());
    expect(ch.tileCol).toBe(1);

    ch.currentTool = "Read";
    ch.state = CharacterState.TYPE;
    expect(getCharacterSprite(ch, testSprites())).toBe(sprite);
    ch.currentTool = "Bash";
    expect(getCharacterSprite(ch, testSprites())).toBe(sprite);
    ch.state = CharacterState.WALK;
    expect(getCharacterSprite(ch, testSprites())).toBe(sprite);
    ch.state = CharacterState.IDLE;
    expect(getCharacterSprite(ch, testSprites())).toBe(sprite);
  });

  it("manages office state agents, subagents, seats, bubbles, and hit testing", () => {
    const state = new OfficeState(testLayout());
    expect(state.getLayout().cols).toBe(5);

    state.addAgent(1, 0, 0, "chair", true, "workspace");
    state.addAgent(1);
    expect(state.characters.get(1)?.folderName).toBe("workspace");
    expect(state.getSeatAtTile(1, 2)).toBe("chair");
    state.setAgentTool(1, "Bash");
    state.setAgentActive(1, false);
    expect(state.characters.get(1)?.isActive).toBe(false);
    state.showPermissionBubble(1);
    expect(state.characters.get(1)?.bubbleType).toBe("permission");
    state.dismissBubble(1);
    expect(state.characters.get(1)?.bubbleType).toBeNull();
    state.showWaitingBubble(1);
    state.dismissBubble(1);
    expect(state.characters.get(1)?.bubbleTimer).toBeLessThanOrEqual(0.3);
    state.clearPermissionBubble(1);

    state.reassignSeat(1, "chair2");
    expect(state.characters.get(1)?.seatId).toBe("chair2");
    state.sendToSeat(1);
    expect(state.walkToTile(1, 2, 2)).toBe(true);
    expect(state.walkToTile(999, 2, 2)).toBe(false);
    expect(state.walkToTile(1, 0, 0)).toBe(false);

    const subagentId = state.addSubagent(1, "tool-1");
    expect(state.getSubagentId(1, "tool-1")).toBe(subagentId);
    expect(state.addSubagent(1, "tool-1")).toBe(subagentId);
    expect(state.walkToTile(subagentId, 2, 2)).toBe(false);
    state.removeSubagent(1, "tool-1");
    state.removeSubagent(1, "tool-1");
    state.addSubagent(1, "tool-2");
    state.removeAllSubagents(1);

    expect(state.getCharacterAt(state.characters.get(1)!.x, state.characters.get(1)!.y)).toBe(1);
    state.rebuildFromLayout(
      { ...testLayout(), cols: 6, rows: 6, tiles: [...testLayout().tiles, ...Array(11).fill(TileType.WALL)] },
      { col: 1, row: 1 },
    );
    state.removeAgent(1);
    state.removeAgent(1);
    state.update(MATRIX_EFFECT_DURATION + 0.1);
    expect(state.characters.has(1)).toBe(false);
  });

  it("covers office state reassignment, no-seat spawning, subagent cleanup, and auto-on furniture", () => {
    const state = new OfficeState(testLayout());
    state.addAgent(1, 0, 0, "chair", true);
    state.addAgent(2);
    state.addAgent(3);
    state.addAgent(4);
    state.addAgent(5);
    state.addAgent(6);
    state.addAgent(7);
    expect(state.characters.get(7)?.hueShift).toBeGreaterThanOrEqual(45);

    state.setAgentActive(1, true);
    expect(state.furniture.length).toBeGreaterThan(0);

    state.reassignSeat(999, "chair2");
    state.reassignSeat(1, "missing-seat");
    state.sendToSeat(999);
    const ch1 = state.characters.get(1)!;
    ch1.seatId = "missing-seat";
    state.sendToSeat(1);

    const noSeatState = new OfficeState(openLayout());
    noSeatState.addAgent(10);
    expect(noSeatState.characters.get(10)?.seatId).toBeNull();
    const subId = noSeatState.addSubagent(10, "tool");
    expect(noSeatState.characters.get(subId)?.seatId).toBeNull();
    noSeatState.characters.get(subId)!.matrixEffect = "despawn";
    noSeatState.removeSubagent(10, "tool");
    expect(noSeatState.getSubagentId(10, "tool")).toBeNull();

    const first = noSeatState.addSubagent(10, "first");
    const second = noSeatState.addSubagent(10, "second");
    noSeatState.selectedAgentId = second;
    noSeatState.cameraFollowId = second;
    noSeatState.characters.get(first)!.matrixEffect = "despawn";
    noSeatState.removeAllSubagents(10);
    expect(noSeatState.selectedAgentId).toBeNull();
    expect(noSeatState.cameraFollowId).toBeNull();
    expect(noSeatState.getSubagentId(10, "first")).toBeNull();
    expect(noSeatState.getSubagentId(10, "second")).toBeNull();

    noSeatState.characters.get(10)!.matrixEffect = null;
    noSeatState.showWaitingBubble(10);
    noSeatState.update(10);
    expect(noSeatState.characters.get(10)?.bubbleType).toBeNull();

    noSeatState.characters.get(10)!.tileCol = 99;
    noSeatState.characters.get(10)!.tileRow = 99;
    noSeatState.rebuildFromLayout(openLayout());
    expect(noSeatState.characters.get(10)?.tileCol).toBeLessThan(4);

    noSeatState.characters.get(10)!.tileCol = 99;
    noSeatState.characters.get(10)!.tileRow = 99;
    noSeatState.characters.get(10)!.seatId = null;
    noSeatState.rebuildFromLayout({
      version: 1,
      cols: 2,
      rows: 2,
      tiles: Array.from({ length: 4 }, () => TileType.WALL),
      furniture: [],
    });
    expect(noSeatState.walkableTiles).toHaveLength(0);
    noSeatState.addAgent(11);
    expect(noSeatState.characters.get(11)?.tileCol).toBe(1);

    const reassignmentState = new OfficeState(
      openLayout(4, 4, [
        { uid: "chair-a", type: "WOODEN_CHAIR_BACK", col: 1, row: 1 },
        { uid: "chair-b", type: "WOODEN_CHAIR_FRONT", col: 2, row: 1 },
      ]),
    );
    reassignmentState.addAgent(20, 0, 0, "chair-a", true);
    reassignmentState.characters.get(20)!.seatId = "removed-chair";
    reassignmentState.rebuildFromLayout(
      openLayout(4, 4, [{ uid: "chair-b", type: "WOODEN_CHAIR_FRONT", col: 2, row: 1 }]),
    );
    expect(reassignmentState.characters.get(20)?.seatId).toBe("chair-b");
    expect(reassignmentState.getSeatAtTile(99, 99)).toBeNull();

    const seatState = new OfficeState(
      openLayout(4, 4, [
        { uid: "chair-a", type: "WOODEN_CHAIR_BACK", col: 1, row: 1 },
        { uid: "chair-b", type: "WOODEN_CHAIR_FRONT", col: 2, row: 1 },
      ]),
    );
    seatState.addAgent(30, 0, 0, "chair-a", true);
    seatState.addAgent(31, 0, 0, "chair-b", true);
    seatState.reassignSeat(30, "chair-b");
    expect(seatState.characters.get(30)?.seatId).toBe("chair-a");
    seatState.characters.get(30)!.isActive = false;
    seatState.reassignSeat(30, "chair-a");
    expect(seatState.characters.get(30)?.state).toBe(CharacterState.TYPE);
    seatState.sendToSeat(30);
    expect(seatState.characters.get(30)?.state).toBe(CharacterState.TYPE);

    const closestState = new OfficeState(openLayout(4, 4));
    closestState.addAgent(40);
    closestState.characters.get(40)!.tileCol = 3;
    closestState.characters.get(40)!.tileRow = 3;
    const closestSubagent = closestState.addSubagent(40, "nearby");
    expect(closestState.characters.get(closestSubagent)?.tileCol).toBeGreaterThanOrEqual(0);

    const activeFurnitureState = new OfficeState(testLayout());
    activeFurnitureState.addAgent(50, 0, 0, "chair", true);
    activeFurnitureState.seats.get("chair")!.facingDir = Direction.LEFT;
    activeFurnitureState.setAgentActive(50, true);
    activeFurnitureState.update(0.1);
    expect(activeFurnitureState.furniture.length).toBeGreaterThan(0);
    activeFurnitureState.showPermissionBubble(50);
    activeFurnitureState.clearPermissionBubble(50);
    expect(activeFurnitureState.characters.get(50)?.bubbleType).toBeNull();
    activeFurnitureState.characters.get(50)!.matrixEffect = "spawn";
    activeFurnitureState.characters.get(50)!.matrixEffectTimer = 0;
    activeFurnitureState.update(MATRIX_EFFECT_DURATION + 0.1);
    expect(activeFurnitureState.characters.get(50)?.matrixEffect).toBeNull();

    state.characters.get(1)!.matrixEffect = "despawn";
    expect(state.getCharacterAt(state.characters.get(1)!.x, state.characters.get(1)!.y)).not.toBe(1);
    expect(state.getCharacterAt(-100, -100)).toBeNull();
  });

  it("covers character state machine edge transitions", () => {
    const seat: Seat = { uid: "seat", seatCol: 1, seatRow: 1, facingDir: Direction.LEFT, assigned: false };
    const seats = new Map([["seat", seat]]);
    const tileMap = [
      [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
      [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
      [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
    ];
    const walkable = getWalkableTiles(tileMap, new Set());

    const resting = createCharacter(30, 0, "seat", seat);
    resting.isActive = false;
    resting.seatTimer = 5;
    updateCharacter(resting, 1, walkable, seats, tileMap, new Set());
    expect(resting.state).toBe(CharacterState.TYPE);
    expect(resting.seatTimer).toBe(4);

    const activeNoSeat = createCharacter(31, 0, null, null);
    activeNoSeat.state = CharacterState.IDLE;
    activeNoSeat.isActive = true;
    updateCharacter(activeNoSeat, 1, walkable, seats, tileMap, new Set());
    expect(activeNoSeat.state).toBe(CharacterState.TYPE);

    const idleAtSeat = createCharacter(32, 0, "seat", seat);
    idleAtSeat.state = CharacterState.IDLE;
    idleAtSeat.isActive = true;
    updateCharacter(idleAtSeat, 1, walkable, seats, tileMap, new Set());
    expect(idleAtSeat.state).toBe(CharacterState.TYPE);

    const returning = createCharacter(33, 0, "seat", seat);
    returning.state = CharacterState.IDLE;
    returning.isActive = false;
    returning.tileCol = 2;
    returning.tileRow = 1;
    returning.wanderCount = 99;
    returning.wanderLimit = 1;
    returning.wanderTimer = 0;
    updateCharacter(returning, 1, walkable, seats, tileMap, new Set());
    expect(returning.state).toBe(CharacterState.WALK);

    const wandering = createCharacter(34, 0, null, null);
    wandering.state = CharacterState.IDLE;
    wandering.isActive = false;
    wandering.wanderTimer = 0;
    updateCharacter(wandering, 1, walkable, seats, tileMap, new Set());
    expect(wandering.wanderTimer).toBeGreaterThan(0);

    const activeWalkNoSeat = createCharacter(35, 0, null, null);
    activeWalkNoSeat.state = CharacterState.WALK;
    activeWalkNoSeat.path = [];
    updateCharacter(activeWalkNoSeat, 1, walkable, seats, tileMap, new Set());
    expect(activeWalkNoSeat.state).toBe(CharacterState.TYPE);

    const activeWalkAwayFromSeat = createCharacter(36, 0, "seat", seat);
    activeWalkAwayFromSeat.state = CharacterState.WALK;
    activeWalkAwayFromSeat.tileCol = 2;
    activeWalkAwayFromSeat.tileRow = 2;
    activeWalkAwayFromSeat.path = [];
    updateCharacter(activeWalkAwayFromSeat, 1, walkable, seats, tileMap, new Set());
    expect(activeWalkAwayFromSeat.state).toBe(CharacterState.IDLE);

    const inactiveArrivesWithSentinel = createCharacter(37, 0, "seat", seat);
    inactiveArrivesWithSentinel.state = CharacterState.WALK;
    inactiveArrivesWithSentinel.isActive = false;
    inactiveArrivesWithSentinel.seatTimer = -1;
    inactiveArrivesWithSentinel.path = [];
    updateCharacter(inactiveArrivesWithSentinel, 1, walkable, seats, tileMap, new Set());
    expect(inactiveArrivesWithSentinel.seatTimer).toBe(0);

    const inactiveArrivesWithRest = createCharacter(38, 0, "seat", seat);
    inactiveArrivesWithRest.state = CharacterState.WALK;
    inactiveArrivesWithRest.isActive = false;
    inactiveArrivesWithRest.path = [];
    updateCharacter(inactiveArrivesWithRest, 1, walkable, seats, tileMap, new Set());
    expect(inactiveArrivesWithRest.seatTimer).toBeGreaterThan(0);

    const walking = createCharacter(39, 0, "seat", seat);
    walking.state = CharacterState.WALK;
    walking.tileCol = 1;
    walking.tileRow = 1;
    walking.path = [{ col: 0, row: 1 }];
    updateCharacter(walking, 1, walkable, seats, tileMap, new Set());
    expect(walking.dir).toBe(Direction.LEFT);
    walking.path = [{ col: 0, row: 2 }];
    updateCharacter(walking, 1, walkable, seats, tileMap, new Set());
    expect(walking.dir).toBe(Direction.DOWN);
  });

  it("renders the pixel office scene and overlays with a canvas context", () => {
    setWallSprites([Array.from({ length: 16 }, () => sprite)]);
    const ctx = fakeContext();
    renderTileGrid(ctx, [[TileType.FLOOR_1]], 0, 0, 2);
    setFloorSprites([sprite]);
    const layout = testLayout();
    const tileMap = layoutToTileMap(layout);
    const state = new OfficeState(layout);
    state.addAgent(1, 0, 0, "chair", true);
    const character = state.characters.get(1)!;
    character.matrixEffect = "spawn";
    character.matrixEffectSeeds = matrixEffectSeeds();
    character.matrixEffectTimer = 0.2;
    character.bubbleType = "waiting";
    character.bubbleTimer = 0.2;

    renderTileGrid(ctx, tileMap, 0, 0, 2, layout.tileColors, layout.cols);
    renderScene(ctx, [{ sprite, x: 0, y: 0, zY: 1, mirrored: true }], [character], 0, 0, 2, 1, null);
    renderScene(ctx, [], [{ ...character, matrixEffect: null }], 0, 0, 2, 1, 1);
    renderSeatIndicators(ctx, state.seats, state.characters, null, { col: 1, row: 2 }, 0, 0, 2);
    renderSeatIndicators(ctx, state.seats, state.characters, 1, { col: 1, row: 2 }, 0, 0, 2);
    state.seats.get("chair")!.assigned = false;
    renderSeatIndicators(ctx, state.seats, state.characters, 1, { col: 1, row: 2 }, 0, 0, 2);
    state.seats.get("chair")!.assigned = true;
    state.characters.get(1)!.seatId = "chair2";
    renderSeatIndicators(ctx, state.seats, state.characters, 1, { col: 1, row: 2 }, 0, 0, 2);
    renderGridOverlay(ctx, 0, 0, 2, 2, 2, [[TileType.VOID, TileType.FLOOR_1]]);
    renderGhostBorder(ctx, 0, 0, 2, 2, 2, -1, -1);
    renderGhostPreview(ctx, sprite, 1, 1, true, 0, 0, 2);
    renderGhostPreview(ctx, sprite, 1, 1, false, 0, 0, 2, true);
    renderSelectionHighlight(ctx, 1, 1, 1, 1, 0, 0, 2);
    expect(renderDeleteButton(ctx, 1, 1, 1, 1, 0, 0, 2).radius).toBeGreaterThan(0);
    renderBubbles(ctx, [character], 0, 0, 2);
    renderMatrixEffect(ctx, { ...character, matrixEffect: "despawn" }, tallSprite, 0, 0, 2);

    const editor = {
      showGrid: true,
      ghostSprite: sprite,
      ghostMirrored: true,
      ghostCol: 1,
      ghostRow: 1,
      ghostValid: false,
      selectedCol: 1,
      selectedRow: 1,
      selectedW: 1,
      selectedH: 1,
      hasSelection: true,
      isRotatable: true,
      deleteButtonBounds: null,
      rotateButtonBounds: null,
      showGhostBorder: true,
      ghostBorderHoverCol: -1,
      ghostBorderHoverRow: -1,
    };
    const offsets = renderFrame(
      ctx,
      400,
      300,
      tileMap,
      state.furniture,
      state.getCharacters(),
      2,
      4,
      8,
      {
        selectedAgentId: 1,
        hoveredAgentId: 1,
        hoveredTile: { col: 1, row: 2 },
        seats: state.seats,
        characters: state.characters,
      },
      editor,
      layout.tileColors,
      layout.cols,
      layout.rows,
    );
    expect(offsets.offsetX).toEqual(expect.any(Number));
    expect(editor.deleteButtonBounds).not.toBeNull();
    editor.isRotatable = false;
    renderFrame(
      ctx,
      400,
      300,
      tileMap,
      state.furniture,
      state.getCharacters(),
      2,
      4,
      8,
      {
        selectedAgentId: null,
        hoveredAgentId: null,
        hoveredTile: null,
        seats: state.seats,
        characters: state.characters,
      },
      editor,
      layout.tileColors,
      layout.cols,
      layout.rows,
    );
    expect(editor.rotateButtonBounds).toBeNull();
    editor.hasSelection = false;
    renderFrame(
      ctx,
      400,
      300,
      tileMap,
      state.furniture,
      state.getCharacters(),
      2,
      4,
      8,
      {
        selectedAgentId: null,
        hoveredAgentId: null,
        hoveredTile: null,
        seats: state.seats,
        characters: state.characters,
      },
      editor,
      layout.tileColors,
      layout.cols,
      layout.rows,
    );
    expect(editor.deleteButtonBounds).toBeNull();
    expect(ctx.calls).toContain("drawImage");
  });
});
