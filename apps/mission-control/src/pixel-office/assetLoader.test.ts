// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assetCalls = vi.hoisted(() => ({
  buildDynamicCatalog: vi.fn(),
  setFloorSprites: vi.fn(),
  setWallSprites: vi.fn(),
  setCharacterTemplates: vi.fn(),
}));

vi.mock("./layout/furnitureCatalog", () => ({
  buildDynamicCatalog: assetCalls.buildDynamicCatalog,
}));

vi.mock("./floorTiles", () => ({
  setFloorSprites: assetCalls.setFloorSprites,
}));

vi.mock("./wallTiles", () => ({
  setWallSprites: assetCalls.setWallSprites,
}));

vi.mock("./sprites/spriteData", () => ({
  setCharacterTemplates: assetCalls.setCharacterTemplates,
}));

function manifestFor(folder: string) {
  if (folder === "BIN") {
    return {
      id: "BIN",
      name: "Waste bin",
      category: "decor",
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
      type: "asset",
    };
  }

  if (folder === "CLOCK") {
    return {
      id: "CLOCK",
      name: "Clock",
      category: "decor",
      canPlaceOnWalls: true,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
      type: "group",
      groupType: "rotation",
      rotationScheme: "four-way",
      members: [
        {
          type: "group",
          groupType: "rotation",
          orientation: "left",
          members: [
            {
              type: "asset",
              id: "CLOCK_LEFT",
              file: "CLOCK_LEFT.png",
              width: 8,
              height: 8,
              footprintW: 1,
              footprintH: 1,
            },
          ],
        },
      ],
    };
  }

  if (folder === "SOFA") {
    return {
      id: "SOFA",
      name: "Sofa",
      category: "seating",
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 2,
      type: "group",
      groupType: "state",
      members: [
        {
          type: "group",
          groupType: "state",
          orientation: "side",
          state: "on",
          members: [
            {
              type: "group",
              groupType: "animation",
              members: [
                {
                  type: "asset",
                  id: "SOFA_SIDE",
                  file: "SOFA_SIDE.png",
                  width: 12,
                  height: 10,
                  footprintW: 2,
                  footprintH: 1,
                  frame: 1,
                  mirrorSide: true,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  return {
    id: folder,
    name: folder.replaceAll("_", " "),
    category: "desks",
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: true,
    backgroundTiles: 1,
    type: "asset",
    width: 6,
    height: 6,
    footprintW: 1,
    footprintH: 1,
    rotationScheme: "side",
  };
}

function installCanvasStub() {
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    if (tagName !== "canvas") {
      return createElement(tagName);
    }
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: true,
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: (_x: number, _y: number, width: number, height: number) => {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < width * height; index += 1) {
            const offset = index * 4;
            data[offset] = index % 255;
            data[offset + 1] = (index * 2) % 255;
            data[offset + 2] = (index * 3) % 255;
            data[offset + 3] = index === 0 ? 1 : index === 1 ? 128 : 255;
          }
          return { data };
        },
      }),
    } as unknown as HTMLCanvasElement;
  });
}

function installImageStub() {
  class TestImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private failedSofaPrimary = false;

    set src(value: string) {
      queueMicrotask(() => {
        if (value.includes("/SOFA/SOFA_SIDE.png") && !this.failedSofaPrimary) {
          this.failedSofaPrimary = true;
          this.onerror?.();
          return;
        }
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("Image", TestImage);
}

function installFetchStub(failFirstLayout = false) {
  let layoutFailuresRemaining = failFirstLayout ? 1 : 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("default-layout-1.json")) {
      if (layoutFailuresRemaining > 0) {
        layoutFailuresRemaining -= 1;
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        json: async () => ({ cols: 12, rows: 8, tileColors: {}, furniture: [] }),
      };
    }

    const match = /\/furniture\/([^/]+)\/manifest\.json/.exec(url);
    if (match) {
      return {
        ok: true,
        json: async () => manifestFor(match[1] ?? "BIN"),
      };
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({}),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("pixel-office assetLoader", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    installCanvasStub();
    installImageStub();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("detects unsupported browser runtimes without loading assets", async () => {
    const { supportsPixelOfficeRuntime } = await import("./assetLoader");
    const originalUserAgent = window.navigator.userAgent;

    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "jsdom",
    });
    expect(supportsPixelOfficeRuntime()).toBe(false);

    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: originalUserAgent,
    });
    vi.stubGlobal("Image", undefined);
    expect(supportsPixelOfficeRuntime()).toBe(false);
  });

  it("loads default layout, furniture, floor, wall, and character sprites once", async () => {
    const fetchMock = installFetchStub();
    const { loadPixelOfficeRuntimeAssets } = await import("./assetLoader");

    const first = await loadPixelOfficeRuntimeAssets();
    const second = await loadPixelOfficeRuntimeAssets();

    expect(second).toBe(first);
    expect(first.defaultLayout.cols).toBe(12);
    expect(assetCalls.buildDynamicCatalog).toHaveBeenCalledTimes(1);
    expect(assetCalls.setFloorSprites).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Array)]));
    expect(assetCalls.setWallSprites).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Array)]));
    expect(assetCalls.setCharacterTemplates).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Object)]));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("default-layout-1.json"));

    const catalog = assetCalls.buildDynamicCatalog.mock.calls[0]?.[0]?.catalog ?? [];
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "BIN", width: 16, footprintW: 1 }),
        expect.objectContaining({ id: "CLOCK_LEFT", orientation: "left", rotationScheme: "four-way" }),
        expect.objectContaining({
          id: "SOFA_SIDE",
          orientation: "side",
          state: "on",
          animationGroup: "SOFA_SIDE_ON",
          mirrorSide: true,
        }),
      ]),
    );
  });

  it("resets the shared asset promise after initialization failures", async () => {
    installFetchStub(true);
    const { loadPixelOfficeRuntimeAssets } = await import("./assetLoader");

    await expect(loadPixelOfficeRuntimeAssets()).rejects.toThrow(
      "Failed to load /assets/pixel-office/default-layout-1.json: 503",
    );
    await expect(loadPixelOfficeRuntimeAssets()).resolves.toEqual({
      defaultLayout: expect.objectContaining({ cols: 12 }),
    });
  });
});
