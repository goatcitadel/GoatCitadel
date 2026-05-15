import { describe, expect, it, vi } from "vitest";
import { Direction, type SpriteData } from "../types";

function frame(color: string): SpriteData {
  return [
    [color, ""],
    ["#000000", color],
  ];
}

function frames(prefix: string): SpriteData[] {
  return Array.from({ length: 7 }, (_unused, index) => frame(`#${prefix}${index}${index}${index}${index}${index}`));
}

describe("spriteData", () => {
  it("returns cached transparent placeholder sprites before PNG character templates load", async () => {
    vi.resetModules();
    const { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE, getCharacterSprites } = await import("./spriteData");

    expect(BUBBLE_PERMISSION_SPRITE.length).toBeGreaterThan(0);
    expect(BUBBLE_WAITING_SPRITE.length).toBeGreaterThan(0);
    const first = getCharacterSprites(0);
    const second = getCharacterSprites(0);
    expect(second).toBe(first);
    expect(first.walk[Direction.DOWN][0]).toHaveLength(32);
    expect(first.walk[Direction.DOWN][0][0]).toHaveLength(16);
    expect(first.typing[Direction.LEFT][0][0][0]).toBe("");
  }, 30_000);

  it("builds directional walk, typing, reading, flipped-left, and hue-shifted sprites from loaded templates", async () => {
    vi.resetModules();
    const { flipSpriteHorizontal, getCharacterSprites, setCharacterTemplates } = await import("./spriteData");

    const rightFrames = frames("3");
    setCharacterTemplates([
      {
        down: frames("1"),
        up: frames("2"),
        right: rightFrames,
      },
    ]);

    const sprites = getCharacterSprites(99);
    expect(sprites.walk[Direction.DOWN][0]).toEqual(frame("#100000"));
    expect(sprites.walk[Direction.DOWN][3]).toEqual(frame("#111111"));
    expect(sprites.walk[Direction.RIGHT][2]).toEqual(rightFrames[2]);
    expect(sprites.walk[Direction.LEFT][0]).toEqual(flipSpriteHorizontal(rightFrames[0]!));
    expect(sprites.typing[Direction.DOWN]).toEqual([frame("#133333"), frame("#144444")]);
    expect(sprites.reading[Direction.UP]).toEqual([frame("#255555"), frame("#266666")]);

    const hueShifted = getCharacterSprites(0, 90);
    expect(hueShifted.walk[Direction.DOWN]).toHaveLength(4);
    expect(getCharacterSprites(0, 90)).toBe(hueShifted);
  });
});
