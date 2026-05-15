import { beforeEach, describe, expect, it } from "vitest";
import type { FloorColor, SpriteData } from "./types";
import { TILE_SIZE, TileType } from "./types";
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

function makeSprite(label: string, height = 1): SpriteData {
  return Array.from({ length: height }, () => [`#${label.padStart(6, "0").slice(0, 6)}`]);
}

function makeSpriteSet(prefix: string): SpriteData[] {
  return Array.from({ length: 16 }, (_, mask) => makeSprite(`${prefix}${mask.toString(16)}`, (mask % 3) + 1));
}

describe("wallTiles", () => {
  beforeEach(() => {
    setWallSprites([]);
  });

  it("selects wall sprites by neighbor bitmask with preview and fallback set behavior", () => {
    const primary = makeSpriteSet("aa");
    const secondary = makeSpriteSet("bb");
    setWallSprites([primary, secondary]);

    const tileMap = [
      [TileType.WALL, TileType.WALL, TileType.FLOOR_1],
      [TileType.WALL, TileType.WALL, TileType.WALL],
      [TileType.FLOOR_1, TileType.WALL, TileType.FLOOR_1],
    ];

    expect(hasWallSprites()).toBe(true);
    expect(getWallSetCount()).toBe(2);
    expect(getWallSetPreviewSprite(1)).toBe(secondary[0]);
    expect(getWallSetPreviewSprite(99)).toBeNull();

    expect(getWallSprite(1, 1, tileMap, 0)).toEqual({
      sprite: primary[15],
      offsetY: TILE_SIZE - (primary[15]?.length ?? 0),
    });
    expect(getWallSprite(0, 0, tileMap, 99)).toEqual({
      sprite: primary[6],
      offsetY: TILE_SIZE - (primary[6]?.length ?? 0),
    });
  });

  it("returns null before sprites are loaded and skips missing mask sprites", () => {
    expect(hasWallSprites()).toBe(false);
    expect(getWallSprite(0, 0, [[TileType.WALL]])).toBeNull();
    expect(getColorizedWallSprite(0, 0, [[TileType.WALL]], { h: 120, s: 80, b: 0, c: 0 })).toBeNull();

    const sparse = makeSpriteSet("cc");
    sparse[0] = undefined as unknown as SpriteData;
    setWallSprites([sparse]);

    expect(getWallSprite(0, 0, [[TileType.WALL]])).toBeNull();
  });

  it("builds z-sorted wall instances and colorized variants from flat tile color indexes", () => {
    const primary = makeSpriteSet("dd");
    setWallSprites([primary]);

    const tileMap = [
      [TileType.WALL, TileType.FLOOR_1, TileType.WALL],
      [TileType.WALL, TileType.WALL, TileType.FLOOR_1],
    ];
    const red: FloorColor = { h: 0, s: 100, b: 0, c: 0 };
    const colors: Array<FloorColor | null> = [red, null, null, null, null, null];

    const instances = getWallInstances(tileMap, colors, 3);

    expect(instances).toHaveLength(4);
    expect(instances[0]).toEqual(
      expect.objectContaining({
        x: 0,
        zY: TILE_SIZE,
      }),
    );
    expect(instances[0]?.sprite).not.toBe(primary[4]);

    const colorized = getColorizedWallSprite(0, 0, tileMap, red);
    expect(colorized?.sprite).not.toBe(primary[4]);
    expect(colorized?.offsetY).toBe(TILE_SIZE - (primary[4]?.length ?? 0));
  });

  it("converts wall color settings to a clamped HSL fill color", () => {
    expect(wallColorToHex({ h: 0, s: 100, b: 0, c: 0 })).toBe("#ff0000");
    expect(wallColorToHex({ h: 120, s: 100, b: 100, c: 100 })).toBe("#ffffff");
    expect(wallColorToHex({ h: 240, s: 100, b: -100, c: 100 })).toBe("#000000");
  });
});
