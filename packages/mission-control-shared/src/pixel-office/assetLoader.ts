import { setFloorSprites } from "./floorTiles";
import { buildDynamicCatalog, type LoadedAssetData } from "./layout/furnitureCatalog";
import type { OfficeLayout, SpriteData } from "./types";
import { setWallSprites } from "./wallTiles";
import { setCharacterTemplates } from "./sprites/spriteData";

const PNG_ALPHA_THRESHOLD = 2;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;
const FLOOR_TILE_SIZE = 16;
const CHARACTER_DIRECTIONS = ["down", "up", "right"] as const;
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CHAR_COUNT = 6;
const FURNITURE_FOLDERS = [
  "BIN",
  "BOOKSHELF",
  "CACTUS",
  "CLOCK",
  "COFFEE",
  "COFFEE_TABLE",
  "CUSHIONED_BENCH",
  "CUSHIONED_CHAIR",
  "DESK",
  "DOUBLE_BOOKSHELF",
  "HANGING_PLANT",
  "LARGE_PAINTING",
  "LARGE_PLANT",
  "PC",
  "PLANT",
  "PLANT_2",
  "POT",
  "SMALL_PAINTING",
  "SMALL_PAINTING_2",
  "SMALL_TABLE",
  "SOFA",
  "TABLE_FRONT",
  "WHITEBOARD",
  "WOODEN_BENCH",
  "WOODEN_CHAIR",
] as const;

type CharacterDirectionSprites = {
  down: string[][][];
  up: string[][][];
  right: string[][][];
};

type ManifestAsset = {
  type: "asset";
  id: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  orientation?: string;
  state?: string;
  frame?: number;
  mirrorSide?: boolean;
};

type ManifestGroup = {
  type: "group";
  groupType: "rotation" | "state" | "animation";
  rotationScheme?: string;
  orientation?: string;
  state?: string;
  members: ManifestNode[];
};

type ManifestNode = ManifestAsset | ManifestGroup;

type FurnitureManifest = {
  id: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  type: "asset" | "group";
  file?: string;
  width?: number;
  height?: number;
  footprintW?: number;
  footprintH?: number;
  groupType?: string;
  rotationScheme?: string;
  members?: ManifestNode[];
};

type InheritedProps = {
  groupId: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  orientation?: string;
  state?: string;
  rotationScheme?: string;
  animationGroup?: string;
};

export type PixelOfficeRuntimeAssets = {
  defaultLayout: OfficeLayout;
};

let runtimeAssetsPromise: Promise<PixelOfficeRuntimeAssets> | null = null;

export function loadPixelOfficeRuntimeAssets(): Promise<PixelOfficeRuntimeAssets> {
  if (!runtimeAssetsPromise) {
    runtimeAssetsPromise = initializeRuntimeAssets().catch((error) => {
      runtimeAssetsPromise = null;
      throw error;
    });
  }
  return runtimeAssetsPromise;
}

export function supportsPixelOfficeRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof Image !== "undefined" &&
    !/jsdom/i.test(window.navigator.userAgent)
  );
}

async function initializeRuntimeAssets(): Promise<PixelOfficeRuntimeAssets> {
  const [defaultLayout, furnitureAssets, floorSprites, wallSprites, characters] = await Promise.all([
    fetchJson<OfficeLayout>("/assets/pixel-office/default-layout-1.json"),
    loadFurnitureAssets(),
    loadFloorSprites(),
    loadWallSprites(),
    loadCharacterSprites(),
  ]);

  buildDynamicCatalog(furnitureAssets);
  setFloorSprites(floorSprites);
  setWallSprites(wallSprites);
  setCharacterTemplates(characters);

  return { defaultLayout };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(resolveAssetUrl(url));
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image ${url}`));
    image.src = resolveAssetUrl(url);
  });
}

function resolveAssetUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  const base =
    typeof window !== "undefined" && window.location.origin && window.location.origin !== "null"
      ? window.location.origin
      : "http://localhost";
  return new URL(url, base).toString();
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < PNG_ALPHA_THRESHOLD) return "";
  const rgb =
    `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
  if (a >= 255) return rgb;
  return `${rgb}${a.toString(16).padStart(2, "0").toUpperCase()}`;
}

function extractSpriteFromImage(image: CanvasImageSource, width: number, height: number, sx = 0, sy = 0): SpriteData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to read sprite image data");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, sx, sy, width, height, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const sprite: string[][] = [];
  for (let y = 0; y < height; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      row.push(rgbaToHex(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0, data[index + 3] ?? 0));
    }
    sprite.push(row);
  }
  return sprite;
}

function flattenManifest(node: ManifestNode, inherited: InheritedProps): LoadedAssetData["catalog"] {
  if (node.type === "asset") {
    const orientation = node.orientation ?? inherited.orientation;
    const state = node.state ?? inherited.state;
    return [
      {
        id: node.id,
        label: inherited.name,
        category: inherited.category,
        width: node.width,
        height: node.height,
        footprintW: node.footprintW,
        footprintH: node.footprintH,
        isDesk: inherited.category === "desks",
        groupId: inherited.groupId,
        canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
        backgroundTiles: inherited.backgroundTiles,
        canPlaceOnWalls: inherited.canPlaceOnWalls,
        orientation,
        state,
        mirrorSide: node.mirrorSide,
        rotationScheme: inherited.rotationScheme,
        animationGroup: inherited.animationGroup,
        frame: node.frame,
      },
    ];
  }

  const results: LoadedAssetData["catalog"] = [];
  for (const member of node.members) {
    const childProps: InheritedProps = { ...inherited };
    if (node.groupType === "rotation" && node.rotationScheme) {
      childProps.rotationScheme = node.rotationScheme;
    }
    if (node.groupType === "state") {
      if (node.orientation) childProps.orientation = node.orientation;
      if (node.state) childProps.state = node.state;
    }
    if (node.groupType === "animation") {
      const orientation = node.orientation ?? inherited.orientation ?? "";
      const state = node.state ?? inherited.state ?? "";
      childProps.animationGroup = `${inherited.groupId}_${orientation}_${state}`.toUpperCase();
      if (node.state) childProps.state = node.state;
    }
    if (node.orientation && !childProps.orientation) {
      childProps.orientation = node.orientation;
    }
    results.push(...flattenManifest(member, childProps));
  }
  return results;
}

async function loadFurnitureAssets(): Promise<LoadedAssetData> {
  const manifests = await Promise.all(
    FURNITURE_FOLDERS.map(async (folder) => {
      const manifest = await fetchJson<FurnitureManifest>(`/assets/pixel-office/furniture/${folder}/manifest.json`);
      const inherited: InheritedProps = {
        groupId: manifest.id,
        name: manifest.name,
        category: manifest.category,
        canPlaceOnWalls: manifest.canPlaceOnWalls,
        canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
        backgroundTiles: manifest.backgroundTiles,
      };

      if (manifest.type === "asset") {
        return [
          {
            id: manifest.id,
            label: manifest.name,
            category: manifest.category,
            width: manifest.width ?? 16,
            height: manifest.height ?? 16,
            footprintW: manifest.footprintW ?? 1,
            footprintH: manifest.footprintH ?? 1,
            isDesk: manifest.category === "desks",
            canPlaceOnWalls: manifest.canPlaceOnWalls,
            canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
            backgroundTiles: manifest.backgroundTiles,
            groupId: manifest.id,
            rotationScheme: manifest.rotationScheme,
          },
        ];
      }

      return flattenManifest(
        {
          type: "group",
          groupType: (manifest.groupType as "rotation" | "state" | "animation") ?? "rotation",
          rotationScheme: manifest.rotationScheme,
          members: manifest.members ?? [],
        },
        inherited,
      );
    }),
  );

  const catalog = manifests.flat();
  const sprites = Object.fromEntries(
    await Promise.all(
      catalog.map(async (asset) => {
        const image = await loadImage(
          `/assets/pixel-office/furniture/${asset.groupId ?? asset.id}/${asset.id}.png`,
        ).catch(async () =>
          loadImage(
            `/assets/pixel-office/furniture/${asset.groupId ?? asset.id}/${asset.id.replace(
              `${asset.groupId ?? asset.id}_`,
              "",
            )}.png`,
          ),
        );
        return [asset.id, extractSpriteFromImage(image, asset.width, asset.height)] as const;
      }),
    ),
  );

  return { catalog, sprites };
}

async function loadFloorSprites(): Promise<SpriteData[]> {
  return await Promise.all(
    Array.from({ length: 9 }, async (_, index) => {
      const image = await loadImage(`/assets/pixel-office/floors/floor_${index}.png`);
      return extractSpriteFromImage(image, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
    }),
  );
}

async function loadWallSprites(): Promise<SpriteData[][]> {
  const image = await loadImage("/assets/pixel-office/walls/wall_0.png");
  const sprites: SpriteData[] = [];
  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask += 1) {
    const col = mask % WALL_GRID_COLS;
    const row = Math.floor(mask / WALL_GRID_COLS);
    sprites.push(
      extractSpriteFromImage(
        image,
        WALL_PIECE_WIDTH,
        WALL_PIECE_HEIGHT,
        col * WALL_PIECE_WIDTH,
        row * WALL_PIECE_HEIGHT,
      ),
    );
  }
  return [sprites];
}

async function loadCharacterSprites(): Promise<CharacterDirectionSprites[]> {
  return await Promise.all(
    Array.from({ length: CHAR_COUNT }, async (_, characterIndex) => {
      const image = await loadImage(`/assets/pixel-office/characters/char_${characterIndex}.png`);
      const character: CharacterDirectionSprites = { down: [], up: [], right: [] };
      for (const [directionIndex, direction] of CHARACTER_DIRECTIONS.entries()) {
        const rowOffsetY = directionIndex * CHAR_FRAME_H;
        const frames: SpriteData[] = [];
        for (let frameIndex = 0; frameIndex < CHAR_FRAMES_PER_ROW; frameIndex += 1) {
          frames.push(extractSpriteFromImage(image, CHAR_FRAME_W, CHAR_FRAME_H, frameIndex * CHAR_FRAME_W, rowOffsetY));
        }
        character[direction] = frames;
      }
      return character;
    }),
  );
}
