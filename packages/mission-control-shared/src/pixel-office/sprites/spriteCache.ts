import type { SpriteData } from "../types";

const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>();

/**
 * Width of the first row, or 0 for a zero-row sprite. Guards the bare
 * `sprite[0].length` access that previously threw on an empty sprite outside
 * the React error boundary (the `@ts-nocheck` masked it).
 */
function spriteCols(sprite: SpriteData): number {
  const firstRow = sprite[0];
  return firstRow ? firstRow.length : 0;
}

// ── Outline sprite generation ─────────────────────────────────

const outlineCache = new WeakMap<SpriteData, SpriteData>();

/** Generate a 1px white outline SpriteData (2px larger in each dimension) */
export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const cached = outlineCache.get(sprite);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = spriteCols(sprite);
  // Expanded grid: +2 in each dimension for 1px border
  const outline: string[][] = [];
  for (let r = 0; r < rows + 2; r++) {
    outline.push(new Array<string>(cols + 2).fill(""));
  }

  // For each opaque pixel, mark its 4 cardinal neighbors as white
  for (let r = 0; r < rows; r++) {
    const spriteRow = sprite[r] ?? [];
    for (let c = 0; c < cols; c++) {
      if (spriteRow[c] === "" || spriteRow[c] === undefined) continue;
      const er = r + 1;
      const ec = c + 1;
      if (outline[er - 1]![ec] === "") outline[er - 1]![ec] = "#FFFFFF";
      if (outline[er + 1]![ec] === "") outline[er + 1]![ec] = "#FFFFFF";
      if (outline[er]![ec - 1] === "") outline[er]![ec - 1] = "#FFFFFF";
      if (outline[er]![ec + 1] === "") outline[er]![ec + 1] = "#FFFFFF";
    }
  }

  // Clear pixels that overlap with original opaque pixels
  for (let r = 0; r < rows; r++) {
    const spriteRow = sprite[r] ?? [];
    for (let c = 0; c < cols; c++) {
      if (spriteRow[c] !== "" && spriteRow[c] !== undefined) {
        outline[r + 1]![c + 1] = "";
      }
    }
  }

  outlineCache.set(sprite, outline);
  return outline;
}

export function getCachedSprite(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let cache = zoomCaches.get(zoom);
  if (!cache) {
    cache = new WeakMap();
    zoomCaches.set(zoom, cache);
  }

  const cached = cache.get(sprite);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = spriteCols(sprite);
  const canvas = document.createElement("canvas");
  canvas.width = cols * zoom;
  canvas.height = rows * zoom;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  for (let r = 0; r < rows; r++) {
    const spriteRow = sprite[r] ?? [];
    for (let c = 0; c < cols; c++) {
      const color = spriteRow[c];
      if (color === "" || color === undefined) continue;
      ctx.fillStyle = color;
      ctx.fillRect(c * zoom, r * zoom, zoom, zoom);
    }
  }

  cache.set(sprite, canvas);
  return canvas;
}
