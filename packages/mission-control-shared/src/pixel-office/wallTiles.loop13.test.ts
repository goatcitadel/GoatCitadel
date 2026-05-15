import { beforeEach, describe, expect, it } from "vitest";

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
import { TileType, type FloorColor, type SpriteData } from "./types";

function sprite(id: string): SpriteData {
  return [[`#${id.padEnd(6, "0").slice(0, 6)}`], ["#ffffff"]];
}

const wallSet = Array.from({ length: 16 }, (_value, index) => sprite(index.toString(16).repeat(6)));

describe("wall tile loop13 tails", () => {
  beforeEach(() => {
    setWallSprites([]);
  });

  it("handles missing wall sets, invalid previews, set fallbacks, and missing mask sprites", () => {
    const map = [[TileType.WALL]];

    expect(hasWallSprites()).toBe(false);
    expect(getWallSetCount()).toBe(0);
    expect(getWallSetPreviewSprite(0)).toBeNull();
    expect(getWallSprite(0, 0, map)).toBeNull();

    setWallSprites([wallSet, []]);

    expect(hasWallSprites()).toBe(true);
    expect(getWallSetCount()).toBe(2);
    expect(getWallSetPreviewSprite(0)).toBe(wallSet[0]);
    expect(getWallSetPreviewSprite(99)).toBeNull();
    expect(getWallSprite(0, 0, map, 99)?.sprite).toBe(wallSet[0]);
    expect(getWallSprite(0, 0, map, 1)).toBeNull();
  });

  it("builds cardinal masks, colorized sprites, and wall instances with explicit layout columns", () => {
    setWallSprites([wallSet]);
    const map = [
      [TileType.FLOOR_1, TileType.WALL, TileType.FLOOR_1],
      [TileType.WALL, TileType.WALL, TileType.WALL],
      [TileType.FLOOR_1, TileType.WALL, TileType.FLOOR_1],
    ];
    const color: FloorColor = { h: 180, s: 70, b: 20, c: 15 };

    const center = getWallSprite(1, 1, map);
    expect(center?.sprite).toBe(wallSet[15]);
    expect(center?.offsetY).toBeGreaterThan(0);

    const colorized = getColorizedWallSprite(1, 1, map, color);
    expect(colorized?.sprite).not.toBe(wallSet[15]);
    expect(colorized?.offsetY).toBe(center?.offsetY);

    const sparseColors = Array.from<FloorColor | null>({ length: 12 }).fill(null);
    sparseColors[1 * 4 + 1] = color;
    const instances = getWallInstances(map, sparseColors, 4);

    expect(instances).toHaveLength(5);
    expect(instances.some((instance) => instance.sprite === colorized?.sprite)).toBe(true);
    expect(instances.every((instance) => Number.isFinite(instance.zY))).toBe(true);
  });

  it.each([
    [{ h: 0, s: 80, b: 0, c: 0 }, "#e61919"],
    [{ h: 90, s: 80, b: 20, c: 0 }, "#99eb47"],
    [{ h: 150, s: 80, b: -20, c: 0 }, "#14b866"],
    [{ h: 210, s: 80, b: 0, c: 50 }, "#1980e6"],
    [{ h: 270, s: 80, b: 0, c: -50 }, "#8019e6"],
    [{ h: 330, s: 80, b: 120, c: 0 }, "#ffffff"],
  ] satisfies Array<[FloorColor, string]>)("converts wall colors across hue segments %#", (color, expected) => {
    expect(wallColorToHex(color)).toBe(expected);
  });
});
