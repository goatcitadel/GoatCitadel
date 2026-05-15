import { describe, expect, it } from "vitest";
import { Direction, TileType, type OfficeLayout, type PlacedFurniture } from "../types";
import { buildDynamicCatalog } from "./furnitureCatalog";
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
} from "./layoutSerializer";

const deskSprite = [
  ["#111111", "#222222"],
  ["#333333", "#444444"],
];
const chairSprite = [["#555555"]];
const surfaceSprite = [["#666666"]];

function installLayoutCatalog(): void {
  buildDynamicCatalog({
    catalog: [
      {
        id: "DESK_FRONT",
        label: "Desk - Front",
        category: "desks",
        width: 2,
        height: 2,
        footprintW: 2,
        footprintH: 1,
        isDesk: true,
      },
      {
        id: "WOODEN_CHAIR_FRONT",
        label: "Chair - Front",
        category: "chairs",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: "chair",
        orientation: "front",
      },
      {
        id: "WOODEN_CHAIR_BACK",
        label: "Chair - Back",
        category: "chairs",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: "chair",
        orientation: "back",
      },
      {
        id: "WOODEN_CHAIR_SIDE",
        label: "Chair - Side",
        category: "chairs",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: "chair",
        orientation: "side",
        mirrorSide: true,
      },
      {
        id: "SOFA_FRONT",
        label: "Sofa - Front",
        category: "chairs",
        width: 2,
        height: 1,
        footprintW: 2,
        footprintH: 1,
        isDesk: false,
      },
      {
        id: "MONITOR",
        label: "Monitor",
        category: "electronics",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnSurfaces: true,
        backgroundTiles: 1,
      },
      {
        id: "BOOKSHELF",
        label: "Bookshelf",
        category: "storage",
        width: 1,
        height: 2,
        footprintW: 1,
        footprintH: 2,
        isDesk: false,
        backgroundTiles: 1,
      },
      {
        id: "PLANT",
        label: "Plant",
        category: "decor",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
      },
      {
        id: "WHITEBOARD",
        label: "Whiteboard",
        category: "wall",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
      },
      {
        id: "PC_FRONT_OFF",
        label: "PC",
        category: "electronics",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
      },
    ],
    sprites: {
      DESK_FRONT: deskSprite,
      WOODEN_CHAIR_FRONT: chairSprite,
      WOODEN_CHAIR_BACK: chairSprite,
      WOODEN_CHAIR_SIDE: chairSprite,
      "WOODEN_CHAIR_SIDE:left": chairSprite,
      SOFA_FRONT: [["#777777", "#888888"]],
      MONITOR: surfaceSprite,
      BOOKSHELF: [["#999999"], ["#aaaaaa"]],
      PLANT: [["#00aa00"]],
      WHITEBOARD: [["#ffffff"]],
      PC_FRONT_OFF: [["#000000"]],
    },
  });
}

function layout(overrides: Partial<OfficeLayout> = {}): OfficeLayout {
  return {
    version: 1,
    cols: 3,
    rows: 2,
    tiles: [TileType.WALL, TileType.FLOOR_1, TileType.FLOOR_2, TileType.FLOOR_3, TileType.FLOOR_4, TileType.VOID],
    furniture: [],
    ...overrides,
  };
}

describe("pixel-office layoutSerializer", () => {
  it("converts flat layouts, serializes valid layouts, and rejects invalid JSON", () => {
    const source = layout();

    expect(layoutToTileMap(source)).toEqual([
      [TileType.WALL, TileType.FLOOR_1, TileType.FLOOR_2],
      [TileType.FLOOR_3, TileType.FLOOR_4, TileType.VOID],
    ]);
    expect(deserializeLayout(serializeLayout(source))).toMatchObject({
      version: 1,
      cols: 3,
      rows: 2,
      furniture: [],
    });
    expect(deserializeLayout("{bad")).toBeNull();
    expect(deserializeLayout(JSON.stringify({ version: 1, tiles: [] }))).toBeNull();
  });

  it("migrates legacy furniture, void tiles, and missing tile color metadata", () => {
    installLayoutCatalog();

    const migrated = deserializeLayout(
      JSON.stringify(
        layout({
          tiles: [0, 1, 2, 3, 4, 8 as TileType],
          furniture: [
            { uid: "desk", type: "desk", col: 0, row: 0 },
            { uid: "cooler", type: "cooler", col: 1, row: 0 },
            { uid: "unknown", type: "CUSTOM", col: 2, row: 0 },
          ],
        }),
      ),
    );

    expect(migrated?.tiles.at(-1)).toBe(TileType.VOID);
    expect(migrated?.furniture.map((item) => item.type)).toEqual(["DESK_FRONT", "CUSTOM"]);
    expect(migrated?.tileColors).toEqual([
      null,
      { h: 35, s: 30, b: 15, c: 0 },
      { h: 25, s: 45, b: 5, c: 10 },
      { h: 280, s: 40, b: -5, c: 0 },
      { h: 35, s: 25, b: 10, c: 0 },
      null,
    ]);

    const alreadyColored = layout({
      tileColors: [null, null, null, null, null, null],
      layoutRevision: 2,
    });
    expect(migrateLayoutColors(alreadyColored)).toStrictEqual(alreadyColored);
  });

  it("creates the fallback layout with perimeter walls and room floor colors", () => {
    const fallback = createDefaultLayout();

    expect(fallback.cols).toBe(20);
    expect(fallback.rows).toBe(11);
    expect(fallback.tiles).toHaveLength(220);
    expect(fallback.tileColors).toHaveLength(220);
    expect(fallback.tiles[0]).toBe(TileType.WALL);
    expect(fallback.tiles[21]).toBe(TileType.FLOOR_1);
    expect(fallback.tiles[31]).toBe(TileType.FLOOR_2);
    expect(fallback.tileColors?.[0]).toBeNull();
    expect(fallback.tileColors?.[21]).toEqual({ h: 35, s: 30, b: 15, c: 0 });
    expect(fallback.tileColors?.[31]).toEqual({ h: 25, s: 45, b: 5, c: 10 });
  });

  it("turns furniture into render instances with desk, chair, surface, color, and mirror behavior", () => {
    installLayoutCatalog();

    const furniture: PlacedFurniture[] = [
      { uid: "desk", type: "DESK_FRONT", col: 1, row: 1 },
      { uid: "monitor", type: "MONITOR", col: 1, row: 1 },
      { uid: "chair-back", type: "WOODEN_CHAIR_BACK", col: 0, row: 2 },
      { uid: "chair-left", type: "WOODEN_CHAIR_SIDE:left", col: 2, row: 2 },
      {
        uid: "plant",
        type: "PLANT",
        col: 3,
        row: 2,
        color: { h: 120, s: 40, b: 10, c: 0, colorize: true },
      },
      { uid: "unknown", type: "UNKNOWN", col: 9, row: 9 },
    ];

    const instances = layoutToFurnitureInstances(furniture);

    expect(instances).toHaveLength(5);
    expect(instances[0]!).toMatchObject({ x: 16, y: 16, zY: 18 });
    expect(instances[1]!.zY).toBe(18.5);
    expect(instances[2]!.zY).toBe(49);
    expect(instances[3]).toMatchObject({ mirrored: true });
    expect(instances[4]!.sprite).not.toBe(chairSprite);
  });

  it("computes blocked placement tiles and seat metadata from furniture footprints", () => {
    installLayoutCatalog();

    const furniture: PlacedFurniture[] = [
      { uid: "desk", type: "DESK_FRONT", col: 1, row: 1 },
      { uid: "bookshelf", type: "BOOKSHELF", col: 4, row: 1 },
      { uid: "chair", type: "WOODEN_CHAIR_FRONT", col: 1, row: 2 },
      { uid: "sofa", type: "SOFA_FRONT", col: 3, row: 3 },
      { uid: "unknown", type: "UNKNOWN", col: 9, row: 9 },
    ];

    expect([...getBlockedTiles(furniture)].sort()).toEqual(["1,1", "1,2", "2,1", "3,3", "4,2", "4,3"].sort());
    expect([...getBlockedTiles(furniture, new Set(["1,1", "4,2"]))].sort()).toEqual(
      ["1,2", "2,1", "3,3", "4,3"].sort(),
    );
    expect([...getPlacementBlockedTiles(furniture, "desk")].sort()).toEqual(["1,2", "3,3", "4,2", "4,3"].sort());

    const seats = layoutToSeats(furniture);
    expect(seats.get("chair")).toMatchObject({
      seatCol: 1,
      seatRow: 2,
      facingDir: Direction.DOWN,
      assigned: false,
    });
    expect(seats.get("sofa")).toMatchObject({ seatCol: 3, seatRow: 3 });
    expect(seats.get("sofa:1")).toMatchObject({ seatCol: 4, seatRow: 3 });
    expect([...getSeatTiles(seats)].sort()).toEqual(["1,2", "3,3", "4,3"]);
  });
});
