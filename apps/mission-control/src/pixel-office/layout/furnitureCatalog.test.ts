import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "./furnitureCatalog";

const sprite = [["#111111"]];

function buildAssets(): LoadedAssetData {
  return {
    catalog: [
      {
        id: "DESK_FRONT_OFF",
        label: "Desk - Front - Off",
        category: "desks",
        width: 1,
        height: 1,
        footprintW: 2,
        footprintH: 1,
        isDesk: true,
        groupId: "desk",
        orientation: "front",
        state: "off",
      },
      {
        id: "DESK_RIGHT_OFF",
        label: "Desk - Right - Off",
        category: "desks",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 2,
        isDesk: true,
        groupId: "desk",
        orientation: "right",
        state: "off",
      },
      {
        id: "DESK_BACK_OFF",
        label: "Desk - Back - Off",
        category: "desks",
        width: 1,
        height: 1,
        footprintW: 2,
        footprintH: 1,
        isDesk: true,
        groupId: "desk",
        orientation: "back",
        state: "off",
      },
      {
        id: "DESK_LEFT_OFF",
        label: "Desk - Left - Off",
        category: "desks",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 2,
        isDesk: true,
        groupId: "desk",
        orientation: "left",
        state: "off",
      },
      {
        id: "DESK_FRONT_ON",
        label: "Desk - Front - On",
        category: "desks",
        width: 1,
        height: 1,
        footprintW: 2,
        footprintH: 1,
        isDesk: true,
        groupId: "desk",
        orientation: "front",
        state: "on",
      },
      {
        id: "DESK_RIGHT_ON",
        label: "Desk - Right - On",
        category: "desks",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 2,
        isDesk: true,
        groupId: "desk",
        orientation: "right",
        state: "on",
      },
      {
        id: "SOFA_FRONT",
        label: "Sofa - Front",
        category: "chairs",
        width: 1,
        height: 1,
        footprintW: 2,
        footprintH: 1,
        isDesk: false,
        groupId: "sofa",
        orientation: "front",
        rotationScheme: "2-way",
      },
      {
        id: "SOFA_SIDE",
        label: "Sofa - Side",
        category: "chairs",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 2,
        isDesk: false,
        groupId: "sofa",
        orientation: "side",
        mirrorSide: true,
        rotationScheme: "2-way",
      },
      {
        id: "SCREEN_OFF",
        label: "Screen - Off",
        category: "electronics",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: "screen",
        state: "off",
      },
      {
        id: "SCREEN_ON_0",
        label: "Screen - On",
        category: "electronics",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: "screen",
        state: "on",
        animationGroup: "screen-on",
        frame: 0,
      },
      {
        id: "SCREEN_ON_1",
        label: "Screen - On 2",
        category: "electronics",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: "screen",
        state: "on",
        animationGroup: "screen-on",
        frame: 1,
      },
      {
        id: "MISSING_SPRITE",
        label: "Missing",
        category: "decor",
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
      },
    ],
    sprites: {
      DESK_FRONT_OFF: sprite,
      DESK_RIGHT_OFF: sprite,
      DESK_BACK_OFF: sprite,
      DESK_LEFT_OFF: sprite,
      DESK_FRONT_ON: sprite,
      DESK_RIGHT_ON: sprite,
      SOFA_FRONT: sprite,
      SOFA_SIDE: sprite,
      SCREEN_OFF: sprite,
      SCREEN_ON_0: sprite,
      SCREEN_ON_1: sprite,
    },
  };
}

describe("pixel-office furnitureCatalog", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unusable asset payloads without replacing the active catalog", () => {
    expect(buildDynamicCatalog({ catalog: [], sprites: {} })).toBe(false);
    expect(buildDynamicCatalog({ catalog: [{ id: "missing" } as never], sprites: {} })).toBe(false);
  });

  it("builds a visible catalog, categories, state groups, rotations, mirrors, and animations", () => {
    expect(buildDynamicCatalog(buildAssets())).toBe(true);

    expect(getActiveCatalog().map((entry) => entry.type)).toEqual([
      "DESK_FRONT_OFF",
      "SOFA_FRONT",
      "SCREEN_OFF",
      "SOFA_SIDE:left",
    ]);
    expect(getActiveCatalog()[0]!.label).toBe("Desk");
    expect(getActiveCategories()).toEqual([
      { id: "desks", label: "Desks" },
      { id: "chairs", label: "Chairs" },
      { id: "electronics", label: "Tech" },
    ]);
    expect(getCatalogByCategory("chairs").map((entry) => entry.type)).toEqual(["SOFA_FRONT", "SOFA_SIDE:left"]);
    expect(getCatalogEntry("SOFA_SIDE:left")).toMatchObject({
      type: "SOFA_SIDE:left",
      orientation: "left",
      mirrorSide: true,
    });

    expect(isRotatable("DESK_FRONT_OFF")).toBe(true);
    expect(getRotatedType("DESK_FRONT_OFF", "cw")).toBe("DESK_RIGHT_OFF");
    expect(getRotatedType("DESK_FRONT_OFF", "ccw")).toBe("DESK_LEFT_OFF");
    expect(getRotatedType("SOFA_SIDE", "cw")).toBe("SOFA_FRONT");
    expect(getRotatedType("missing", "cw")).toBeNull();
    expect(getOrientationInGroup("SOFA_SIDE:left")).toBeUndefined();

    expect(getToggledType("SCREEN_OFF")).toBe("SCREEN_ON_0");
    expect(getToggledType("SCREEN_ON_0")).toBe("SCREEN_OFF");
    expect(getOnStateType("SCREEN_OFF")).toBe("SCREEN_ON_0");
    expect(getOffStateType("SCREEN_ON_0")).toBe("SCREEN_OFF");
    expect(getOnStateType("ungrouped")).toBe("ungrouped");
    expect(getOffStateType("ungrouped")).toBe("ungrouped");
    expect(getAnimationFrames("SCREEN_ON_1")).toEqual(["SCREEN_ON_0", "SCREEN_ON_1"]);
    expect(getAnimationFrames("DESK_FRONT_OFF")).toBeNull();
  });
});
