import { describe, expect, it } from "vitest";
import { TileType } from "../types";
import { findPath, getWalkableTiles, isWalkable } from "./tileMap";

const map = [
  [TileType.FLOOR_1, TileType.FLOOR_2, TileType.WALL],
  [TileType.VOID, TileType.FLOOR_3, TileType.FLOOR_4],
  [TileType.FLOOR_5, TileType.FLOOR_6, TileType.FLOOR_7],
];

describe("pixel-office tileMap", () => {
  it("identifies bounds, walls, voids, blocked tiles, and open floor tiles", () => {
    expect(isWalkable(-1, 0, map, new Set())).toBe(false);
    expect(isWalkable(0, 3, map, new Set())).toBe(false);
    expect(isWalkable(2, 0, map, new Set())).toBe(false);
    expect(isWalkable(0, 1, map, new Set())).toBe(false);
    expect(isWalkable(1, 1, map, new Set(["1,1"]))).toBe(false);
    expect(isWalkable(1, 1, map, new Set())).toBe(true);
  });

  it("returns all walkable tiles after furniture blocking is applied", () => {
    expect(getWalkableTiles(map, new Set(["1,1"]))).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 1 },
      { col: 0, row: 2 },
      { col: 1, row: 2 },
      { col: 2, row: 2 },
    ]);
  });

  it("finds four-way paths, returns no-op same-tile paths, and rejects unreachable ends", () => {
    expect(findPath(0, 0, 0, 0, map, new Set())).toEqual([]);
    expect(findPath(0, 0, 2, 0, map, new Set())).toEqual([]);
    expect(findPath(0, 0, 2, 2, map, new Set())).toEqual([
      { col: 1, row: 0 },
      { col: 1, row: 1 },
      { col: 1, row: 2 },
      { col: 2, row: 2 },
    ]);
    expect(findPath(0, 0, 2, 2, map, new Set(["1,0", "1,1"]))).toEqual([]);
  });
});
