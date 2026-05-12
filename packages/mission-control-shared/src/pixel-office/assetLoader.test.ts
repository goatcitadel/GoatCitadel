import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeLayout } from "./types";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static failedUrls = new Set<string>();

  set src(value: string) {
    if (value.includes("_PRIMARY_FAIL.png") && !FakeImage.failedUrls.has(value)) {
      FakeImage.failedUrls.add(value);
      this.onerror?.();
      return;
    }
    this.onload?.();
  }
}

function installRuntimeDom(
  origin = "http://localhost:5173",
  userAgent = "Chrome",
  options: { contextAvailable?: boolean; imageData?: Uint8ClampedArray } = {},
) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        origin,
      },
      navigator: {
        userAgent,
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      createElement: vi.fn(() => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: vi.fn(() =>
            options.contextAvailable === false
              ? null
              : {
                  imageSmoothingEnabled: false,
                  clearRect: vi.fn(),
                  drawImage: vi.fn(),
                  getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
                    data: options.imageData ?? new Uint8ClampedArray(width * height * 4).fill(255),
                  })),
                },
          ),
        };
        return canvas;
      }),
    },
  });
  vi.stubGlobal("Image", FakeImage);
}

function manifest(folder: string) {
  return {
    id: folder,
    name: folder,
    category: folder.includes("CHAIR") ? "chairs" : folder.includes("DESK") ? "desks" : "decor",
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    type: "asset",
    file: `${folder}.png`,
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
  };
}

const defaultLayout: OfficeLayout = {
  version: 1,
  cols: 2,
  rows: 2,
  tiles: [0, 1, 1, 0],
  furniture: [],
};

describe("pixel office asset loader", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeImage.failedUrls.clear();
    installRuntimeDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("detects supported and unsupported browser runtimes", async () => {
    const { supportsPixelOfficeRuntime } = await import("./assetLoader");
    expect(supportsPixelOfficeRuntime()).toBe(true);

    installRuntimeDom("http://localhost:5173", "jsdom");
    expect(supportsPixelOfficeRuntime()).toBe(false);

    Reflect.deleteProperty(globalThis, "window");
    expect(supportsPixelOfficeRuntime()).toBe(false);
  });

  it("loads runtime assets once and populates floor, wall, character, and furniture stores", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/default-layout-1.json")) {
        return Response.json(defaultLayout);
      }
      if (parsed.pathname.endsWith("/manifest.json")) {
        const parts = parsed.pathname.split("/");
        return Response.json(manifest(parts.at(-2) ?? "UNKNOWN"));
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadPixelOfficeRuntimeAssets } = await import("./assetLoader");
    const { hasWallSprites } = await import("./wallTiles");
    const { getFloorPatternCount } = await import("./floorTiles");
    const { getActiveCatalog } = await import("./layout/furnitureCatalog");
    const { getCharacterSprites } = await import("./sprites/spriteData");

    await expect(loadPixelOfficeRuntimeAssets()).resolves.toEqual({ defaultLayout });
    await expect(loadPixelOfficeRuntimeAssets()).resolves.toEqual({ defaultLayout });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("default-layout")).length).toBe(1);
    expect(getFloorPatternCount()).toBe(9);
    expect(hasWallSprites()).toBe(true);
    expect(getActiveCatalog().length).toBeGreaterThan(0);
    expect(getCharacterSprites(0).walk[0][0]).toHaveLength(32);
  });

  it("flattens grouped furniture manifests and falls back to secondary image names", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/default-layout-1.json")) {
        return Response.json(defaultLayout);
      }
      if (parsed.pathname.endsWith("/manifest.json")) {
        const parts = parsed.pathname.split("/");
        const folder = parts.at(-2) ?? "UNKNOWN";
        return Response.json({
          id: folder,
          name: `${folder} group`,
          category: folder.includes("DESK") ? "desks" : "decor",
          canPlaceOnWalls: true,
          canPlaceOnSurfaces: true,
          backgroundTiles: 2,
          type: "group",
          groupType: "rotation",
          rotationScheme: "four-way",
          members: [
            {
              type: "asset",
              id: `${folder}_PRIMARY_FAIL`,
              file: "primary.png",
              width: 16,
              height: 16,
              footprintW: 1,
              footprintH: 1,
              orientation: "front",
            },
            {
              type: "group",
              groupType: "state",
              orientation: "left",
              state: "active",
              members: [
                {
                  type: "group",
                  groupType: "animation",
                  state: "blink",
                  members: [
                    {
                      type: "asset",
                      id: `${folder}_frame_0`,
                      file: "frame.png",
                      width: 16,
                      height: 16,
                      footprintW: 2,
                      footprintH: 1,
                      frame: 0,
                      mirrorSide: true,
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadPixelOfficeRuntimeAssets } = await import("./assetLoader");
    const { getActiveCatalog, getCatalogEntry, getAnimationFrames } = await import("./layout/furnitureCatalog");

    await expect(loadPixelOfficeRuntimeAssets()).resolves.toEqual({ defaultLayout });
    const catalog = getActiveCatalog();
    const fallbackEntry = catalog.find((item) => item.type?.endsWith("_PRIMARY_FAIL"));
    const frameEntry = catalog.find((item) => item.type?.endsWith("_frame_0"));
    expect(fallbackEntry).toMatchObject({ orientation: "front", canPlaceOnWalls: true, canPlaceOnSurfaces: true });
    expect(frameEntry).toMatchObject({ orientation: "left", mirrorSide: true, footprintW: 2 });
    expect(getCatalogEntry(frameEntry!.type)).toMatchObject({ mirrorSide: true });
    expect(getAnimationFrames(frameEntry!.type)).toEqual([frameEntry!.type]);
    expect(FakeImage.failedUrls.size).toBeGreaterThan(0);
  });

  it("resolves absolute and null-origin assets while preserving transparent and translucent pixels", async () => {
    const imageData = new Uint8ClampedArray(16 * 16 * 4);
    imageData.set([1, 2, 3, 1], 0);
    imageData.set([4, 5, 6, 128], 4);
    installRuntimeDom("null", "Chrome", { imageData });
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/default-layout-1.json")) {
        return Response.json(defaultLayout);
      }
      if (parsed.pathname.endsWith("/manifest.json")) {
        const parts = parsed.pathname.split("/");
        return Response.json(manifest(parts.at(-2) ?? "UNKNOWN"));
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadPixelOfficeRuntimeAssets } = await import("./assetLoader");
    const { getFloorSprite } = await import("./floorTiles");

    await expect(loadPixelOfficeRuntimeAssets()).resolves.toEqual({ defaultLayout });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost/assets/pixel-office/default-layout-1.json");
    expect(getFloorSprite(1)?.[0]?.[0]).toBe("");
    expect(getFloorSprite(1)?.[0]?.[1]).toBe("#04050680");
  });

  it("surfaces image load and canvas extraction failures", async () => {
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          this.onerror?.();
        }
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/default-layout-1.json")) {
          return Response.json(defaultLayout);
        }
        if (parsed.pathname.endsWith("/manifest.json")) {
          const parts = parsed.pathname.split("/");
          return Response.json(manifest(parts.at(-2) ?? "UNKNOWN"));
        }
        return Response.json({});
      }),
    );

    let assetLoader = await import("./assetLoader");
    await expect(assetLoader.loadPixelOfficeRuntimeAssets()).rejects.toThrow("Failed to load image");

    vi.resetModules();
    installRuntimeDom("http://localhost:5173", "Chrome", { contextAvailable: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/default-layout-1.json")) {
          return Response.json(defaultLayout);
        }
        if (parsed.pathname.endsWith("/manifest.json")) {
          const parts = parsed.pathname.split("/");
          return Response.json(manifest(parts.at(-2) ?? "UNKNOWN"));
        }
        return Response.json({});
      }),
    );
    assetLoader = await import("./assetLoader");
    await expect(assetLoader.loadPixelOfficeRuntimeAssets()).rejects.toThrow("Unable to read sprite image data");
  });

  it("resets the cached runtime promise after a load failure", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/default-layout-1.json")) {
          if (fail) {
            fail = false;
            return new Response("missing", { status: 500 });
          }
          return Response.json(defaultLayout);
        }
        if (parsed.pathname.endsWith("/manifest.json")) {
          const parts = parsed.pathname.split("/");
          return Response.json(manifest(parts.at(-2) ?? "UNKNOWN"));
        }
        return Response.json({});
      }),
    );
    const { loadPixelOfficeRuntimeAssets } = await import("./assetLoader");

    await expect(loadPixelOfficeRuntimeAssets()).rejects.toThrow(
      "Failed to load /assets/pixel-office/default-layout-1.json: 500",
    );
    await expect(loadPixelOfficeRuntimeAssets()).resolves.toEqual({ defaultLayout });
  });
});
