import { describe, expect, it } from "vitest";
import {
  getAllFloorSprites,
  getColorizedFloorSprite,
  getFloorPatternCount,
  getFloorSprite,
  hasFloorSprites,
  setFloorSprites,
} from "./floorTiles";

describe("floorTiles", () => {
  it("falls back to a default floor pattern before assets load", () => {
    setFloorSprites([]);

    expect(hasFloorSprites()).toBe(true);
    expect(getFloorPatternCount()).toBe(1);
    expect(getAllFloorSprites()).toHaveLength(1);
    expect(getFloorSprite(1)?.[0]?.[0]).toMatch(/^#/);
    expect(getFloorSprite(0)).toBeNull();
  });

  it("uses loaded sprites and returns magenta for invalid colorized pattern indexes", () => {
    const sprite = [["#111111", "#222222"]];
    setFloorSprites([sprite]);

    expect(getFloorPatternCount()).toBe(1);
    expect(getAllFloorSprites()).toEqual([sprite]);
    expect(getFloorSprite(1)).toBe(sprite);
    expect(getFloorSprite(2)).toBeNull();

    const invalid = getColorizedFloorSprite(-1, { h: 0, s: 0, b: 0, c: 0 });
    expect(invalid).toHaveLength(16);
    expect(invalid[0]![0]).toBe("#FF00FF");
  });
});
