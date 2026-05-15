import { describe, expect, it } from "vitest";
import { adjustSprite, clearColorizeCache, colorizeSprite, getColorizedSprite } from "./colorize";
import type { FloorColor, SpriteData } from "./types";

const neutralAdjust: FloorColor = { h: 0, s: 0, b: 0, c: 0 };

describe("pixel-office colorize", () => {
  it("caches colorized sprites by caller-provided key and can clear the cache", () => {
    const sprite: SpriteData = [["#808080", ""]];
    const color: FloorColor = { h: 180, s: 70, b: 10, c: 15, colorize: true };

    const first = getColorizedSprite("tile:cyan", sprite, color);
    const second = getColorizedSprite("tile:cyan", [["#FFFFFF"]], color);
    expect(second).toBe(first);

    clearColorizeCache();
    expect(getColorizedSprite("tile:cyan", sprite, color)).not.toBe(first);
  });

  it("colorizes grayscale pixels while preserving transparency and alpha", () => {
    const sprite: SpriteData = [["", "#00000080", "#808080", "#FFFFFF"]];
    const result = colorizeSprite(sprite, { h: 120, s: 100, b: 50, c: 100, colorize: true });

    expect(result[0]?.[0]).toBe("");
    expect(result[0]?.[1]).toMatch(/^#[0-9A-F]{6}80$/);
    expect(result[0]?.[2]).toMatch(/^#[0-9A-F]{6}$/);
    expect(result[0]?.[3]).toBe("#FFFFFF");
  });

  it("covers each HSL sector used by colorize mode", () => {
    const sprite: SpriteData = [["#808080"]];
    const hues = [0, 60, 120, 180, 240, 300];

    const outputs = hues.map((h) => colorizeSprite(sprite, { h, s: 100, b: 0, c: 0, colorize: true })[0]?.[0]);

    expect(new Set(outputs).size).toBe(hues.length);
    expect(outputs.every((pixel) => /^#[0-9A-F]{6}$/.test(pixel ?? ""))).toBe(true);
  });

  it("adjusts existing RGB hues, clamps extremes, and preserves alpha", () => {
    const sprite: SpriteData = [["#FF0000", "#00FF00", "#0000FF", "#777777", "#33669940", ""]];
    const result = adjustSprite(sprite, { h: -120, s: -25, b: -100, c: 100 });

    expect(result[0]).toHaveLength(6);
    expect(result[0]?.[0]).toMatch(/^#[0-9A-F]{6}$/);
    expect(result[0]?.[1]).toMatch(/^#[0-9A-F]{6}$/);
    expect(result[0]?.[2]).toMatch(/^#[0-9A-F]{6}$/);
    expect(result[0]?.[3]).toMatch(/^#[0-9A-F]{6}$/);
    expect(result[0]?.[4]).toMatch(/^#[0-9A-F]{6}40$/);
    expect(result[0]?.[5]).toBe("");
  });

  it("uses adjust mode by default when the color does not request Photoshop colorize", () => {
    const sprite: SpriteData = [["#336699"]];

    expect(getColorizedSprite("adjust-default", sprite, neutralAdjust)).toEqual(adjustSprite(sprite, neutralAdjust));
  });
});
