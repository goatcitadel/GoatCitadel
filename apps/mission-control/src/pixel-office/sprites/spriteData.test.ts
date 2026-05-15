import { describe, expect, it } from "vitest";
import { Direction, type SpriteData } from "../types";
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
  flipSpriteHorizontal,
  getCharacterSprites,
  setCharacterTemplates,
} from "./spriteData";

function sprite(label: string): SpriteData {
  return [
    [`#${label}0000`, `#${label}1111`, ""],
    [`#${label}2222`, `#${label}3333`, `#${label}4444`],
  ];
}

function makeCharacter(prefix: string) {
  return {
    down: Array.from({ length: 7 }, (_value, index) => sprite(`${prefix}${index}`)),
    up: Array.from({ length: 7 }, (_value, index) => sprite(`${prefix}${index + 10}`)),
    right: Array.from({ length: 7 }, (_value, index) => sprite(`${prefix}${index + 20}`)),
  };
}

describe("spriteData", () => {
  it("resolves speech-bubble palette JSON into renderable sprite colors", () => {
    expect(BUBBLE_PERMISSION_SPRITE).toHaveLength(13);
    expect(BUBBLE_PERMISSION_SPRITE[0]).toHaveLength(11);
    expect(BUBBLE_PERMISSION_SPRITE[5]).toContain("#CCA700");
    expect(BUBBLE_PERMISSION_SPRITE[10]).toContain("");
    expect(BUBBLE_PERMISSION_SPRITE.flat()).not.toContain("A");

    expect(BUBBLE_WAITING_SPRITE).toHaveLength(13);
    expect(BUBBLE_WAITING_SPRITE[0]).toHaveLength(11);
    expect(BUBBLE_WAITING_SPRITE.flat()).toContain("#44BB66");
    expect(BUBBLE_WAITING_SPRITE.flat()).not.toContain("G");
  });

  it("returns cached transparent placeholder sprites before character templates are loaded", () => {
    const first = getCharacterSprites(0);
    const second = getCharacterSprites(0);

    expect(second).toBe(first);
    expect(first.walk[Direction.DOWN]).toHaveLength(4);
    expect(first.typing[Direction.LEFT]).toHaveLength(2);
    expect(first.reading[Direction.RIGHT]).toHaveLength(2);
    expect(first.walk[Direction.DOWN][0]).toHaveLength(32);
    expect(first.walk[Direction.DOWN][0][0]).toHaveLength(16);
    expect(first.walk[Direction.DOWN][0].flat().every((pixel) => pixel === "")).toBe(true);
  });

  it("maps loaded character templates into movement, typing, and reading sprite sets", () => {
    const characters = [makeCharacter("A"), makeCharacter("B")];
    const character = characters[1]!;

    setCharacterTemplates(characters);

    const sprites = getCharacterSprites(3);
    expect(sprites.walk[Direction.DOWN]).toEqual([
      character.down[0],
      character.down[1],
      character.down[2],
      character.down[1],
    ]);
    expect(sprites.walk[Direction.UP]).toEqual([character.up[0], character.up[1], character.up[2], character.up[1]]);
    expect(sprites.walk[Direction.RIGHT]).toEqual([
      character.right[0],
      character.right[1],
      character.right[2],
      character.right[1],
    ]);
    expect(sprites.typing[Direction.DOWN]).toEqual([character.down[3], character.down[4]]);
    expect(sprites.reading[Direction.RIGHT]).toEqual([character.right[5], character.right[6]]);
    expect(sprites.walk[Direction.LEFT][0]).toEqual(flipSpriteHorizontal(character.right[0]!));
    expect(sprites.typing[Direction.LEFT]).toEqual([
      flipSpriteHorizontal(character.right[3]!),
      flipSpriteHorizontal(character.right[4]!),
    ]);
    expect(sprites.reading[Direction.LEFT]).toEqual([
      flipSpriteHorizontal(character.right[5]!),
      flipSpriteHorizontal(character.right[6]!),
    ]);
  });

  it("clears cached character sets when templates change and caches hue-shifted variants separately", () => {
    const firstCharacters = [makeCharacter("C")];
    setCharacterTemplates(firstCharacters);
    const first = getCharacterSprites(0);

    const nextCharacters = [makeCharacter("D")];
    const nextCharacter = nextCharacters[0]!;
    setCharacterTemplates(nextCharacters);
    const next = getCharacterSprites(0);
    const hueShifted = getCharacterSprites(0, 45);
    const hueShiftedAgain = getCharacterSprites(0, 45);

    expect(next).not.toBe(first);
    expect(next.walk[Direction.DOWN][0]).toEqual(nextCharacter.down[0]);
    expect(hueShiftedAgain).toBe(hueShifted);
    expect(hueShifted).not.toBe(next);
    expect(hueShifted.walk[Direction.DOWN][0]).not.toEqual(next.walk[Direction.DOWN][0]);
    expect(hueShifted.walk[Direction.DOWN][0]![0]![2]).toBe("");
  });

  it("flips sprites horizontally without mutating the original rows", () => {
    const original = [
      ["left", "middle", "right"],
      ["alpha", "", "omega"],
    ];

    const flipped = flipSpriteHorizontal(original);

    expect(flipped).toEqual([
      ["right", "middle", "left"],
      ["omega", "", "alpha"],
    ]);
    expect(original).toEqual([
      ["left", "middle", "right"],
      ["alpha", "", "omega"],
    ]);
    expect(flipped[0]!).not.toBe(original[0]);
  });
});
