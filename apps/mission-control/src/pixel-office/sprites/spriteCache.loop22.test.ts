import { afterEach, describe, expect, it, vi } from "vitest";
import { getCachedSprite, getOutlineSprite } from "./spriteCache";
import type { SpriteData } from "../types";

describe("spriteCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds and reuses outline sprites without covering original opaque pixels", () => {
    const sprite: SpriteData = [
      ["", "#111111"],
      ["#222222", ""],
    ];

    const outline = getOutlineSprite(sprite);

    expect(outline).toHaveLength(4);
    expect(outline[0]).toHaveLength(4);
    expect(outline[1]?.[2]).toBe("");
    expect(outline[2]?.[1]).toBe("");
    expect(outline[0]?.[2]).toBe("#FFFFFF");
    expect(outline[1]?.[1]).toBe("#FFFFFF");
    expect(getOutlineSprite(sprite)).toBe(outline);
  });

  it("renders opaque pixels into a zoom-specific cached canvas", () => {
    const fillRect = vi.fn();
    const context = {
      fillRect,
      fillStyle: "",
      imageSmoothingEnabled: true,
    };
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      width: 0,
    };
    const createElement = vi.fn((tagName: string) => {
      expect(tagName).toBe("canvas");
      return canvas;
    });
    vi.stubGlobal("document", { createElement });

    const sprite: SpriteData = [
      ["#111111", ""],
      ["#222222", "#333333"],
    ];

    const first = getCachedSprite(sprite, 3);
    const second = getCachedSprite(sprite, 3);

    expect(first).toBe(canvas);
    expect(second).toBe(first);
    expect(canvas.width).toBe(6);
    expect(canvas.height).toBe(6);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(fillRect).toHaveBeenCalledTimes(3);
    expect(fillRect).toHaveBeenNthCalledWith(1, 0, 0, 3, 3);
    expect(fillRect).toHaveBeenNthCalledWith(2, 0, 3, 3, 3);
    expect(fillRect).toHaveBeenNthCalledWith(3, 3, 3, 3, 3);
    expect(createElement).toHaveBeenCalledTimes(1);
  });
});
