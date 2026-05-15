import { describe, expect, it, vi } from "vitest";
import type { CharacterSprites } from "../sprites/spriteData";
import { CharacterState, Direction, TileType, type Character, type Seat, type SpriteData } from "../types";
import { createCharacter, getCharacterSprite, isReadingTool, updateCharacter } from "./characters";

const openMap = [
  [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
  [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
  [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
];
const walkableTiles = [
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 2, row: 0 },
  { col: 0, row: 1 },
  { col: 1, row: 1 },
  { col: 2, row: 1 },
  { col: 0, row: 2 },
  { col: 1, row: 2 },
  { col: 2, row: 2 },
];

const seat: Seat = {
  uid: "seat-a",
  seatCol: 2,
  seatRow: 1,
  facingDir: Direction.LEFT,
  assigned: false,
};

function cloneCharacter(overrides: Partial<Character> = {}): Character {
  return {
    ...createCharacter(7, 2, "seat-a", seat, 90),
    ...overrides,
  };
}

function sprite(label: string): SpriteData {
  return [[label]];
}

const sprites: CharacterSprites = {
  typing: {
    [Direction.DOWN]: [sprite("type-down-0"), sprite("type-down-1")],
    [Direction.LEFT]: [sprite("type-left-0"), sprite("type-left-1")],
    [Direction.RIGHT]: [sprite("type-right-0"), sprite("type-right-1")],
    [Direction.UP]: [sprite("type-up-0"), sprite("type-up-1")],
  },
  reading: {
    [Direction.DOWN]: [sprite("read-down-0"), sprite("read-down-1")],
    [Direction.LEFT]: [sprite("read-left-0"), sprite("read-left-1")],
    [Direction.RIGHT]: [sprite("read-right-0"), sprite("read-right-1")],
    [Direction.UP]: [sprite("read-up-0"), sprite("read-up-1")],
  },
  walk: {
    [Direction.DOWN]: [sprite("walk-down-0"), sprite("walk-down-1"), sprite("walk-down-2"), sprite("walk-down-3")],
    [Direction.LEFT]: [sprite("walk-left-0"), sprite("walk-left-1"), sprite("walk-left-2"), sprite("walk-left-3")],
    [Direction.RIGHT]: [sprite("walk-right-0"), sprite("walk-right-1"), sprite("walk-right-2"), sprite("walk-right-3")],
    [Direction.UP]: [sprite("walk-up-0"), sprite("walk-up-1"), sprite("walk-up-2"), sprite("walk-up-3")],
  },
};

describe("pixel-office characters", () => {
  it("creates seated and unseated characters with deterministic tile-centered defaults", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(isReadingTool(null)).toBe(false);
    expect(isReadingTool("Read")).toBe(true);
    expect(isReadingTool("Edit")).toBe(false);

    expect(createCharacter(1, 3, "seat-a", seat, 45)).toMatchObject({
      id: 1,
      state: CharacterState.TYPE,
      dir: Direction.LEFT,
      x: 40,
      y: 24,
      tileCol: 2,
      tileRow: 1,
      palette: 3,
      hueShift: 45,
      wanderLimit: 3,
      seatId: "seat-a",
      matrixEffectSeeds: [],
    });
    expect(createCharacter(2, 1, null, null)).toMatchObject({
      dir: Direction.DOWN,
      x: 24,
      y: 24,
      tileCol: 1,
      tileRow: 1,
      seatId: null,
    });
  });

  it("advances typing frames and transitions inactive workers through the seat timer into idle wandering", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const ch = cloneCharacter({ isActive: false, seatTimer: 1 });

    updateCharacter(ch, 0.3, walkableTiles, new Map([["seat-a", seat]]), openMap, new Set());
    expect(ch.frame).toBe(1);
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.seatTimer).toBeCloseTo(0.7);

    updateCharacter(ch, 1, walkableTiles, new Map([["seat-a", seat]]), openMap, new Set());
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.seatTimer).toBeLessThan(0);

    updateCharacter(ch, 0.1, walkableTiles, new Map([["seat-a", seat]]), openMap, new Set());
    expect(ch.state).toBe(CharacterState.IDLE);
    expect(ch.frame).toBe(0);
    expect(ch.seatTimer).toBe(0);
    expect(ch.wanderTimer).toBe(11);
    expect(ch.wanderLimit).toBe(5);
  });

  it("paths active idle characters to their seat or resumes typing in place", () => {
    const seats = new Map([["seat-a", seat]]);
    const ch = cloneCharacter({
      state: CharacterState.IDLE,
      tileCol: 0,
      tileRow: 1,
      x: 8,
      y: 24,
      isActive: true,
    });

    updateCharacter(ch, 0.1, walkableTiles, seats, openMap, new Set());
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.path.at(-1)).toEqual({ col: 2, row: 1 });

    const unseated = cloneCharacter({
      state: CharacterState.IDLE,
      seatId: null,
      isActive: true,
    });
    updateCharacter(unseated, 0.1, walkableTiles, seats, openMap, new Set());
    expect(unseated.state).toBe(CharacterState.TYPE);

    const blocked = cloneCharacter({
      state: CharacterState.IDLE,
      tileCol: 0,
      tileRow: 1,
      isActive: true,
    });
    updateCharacter(
      blocked,
      0.1,
      walkableTiles,
      seats,
      openMap,
      new Set(["1,1", "0,0", "1,0", "2,0", "0,2", "1,2", "2,2"]),
    );
    expect(blocked.state).toBe(CharacterState.TYPE);
    expect(blocked.dir).toBe(Direction.LEFT);
  });

  it("lets inactive idle characters wander, return to seats, and clear negative seat sentinels", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const seats = new Map([["seat-a", seat]]);
    const returning = cloneCharacter({
      state: CharacterState.IDLE,
      tileCol: 0,
      tileRow: 1,
      isActive: false,
      wanderTimer: 0,
      wanderCount: 6,
      wanderLimit: 3,
    });

    updateCharacter(returning, 0.1, walkableTiles, seats, openMap, new Set());
    expect(returning.state).toBe(CharacterState.WALK);
    expect(returning.path.at(-1)).toEqual({ col: 2, row: 1 });

    const wandering = cloneCharacter({
      state: CharacterState.IDLE,
      tileCol: 1,
      tileRow: 1,
      isActive: false,
      seatId: null,
      wanderTimer: 0,
    });
    updateCharacter(wandering, 0.1, walkableTiles, seats, openMap, new Set());
    expect(wandering.state).toBe(CharacterState.WALK);
    expect(wandering.wanderCount).toBe(1);
    expect(wandering.wanderTimer).toBe(2);

    const sentinel = cloneCharacter({
      state: CharacterState.IDLE,
      isActive: false,
      seatTimer: -1,
      wanderTimer: 10,
    });
    updateCharacter(sentinel, 0.1, walkableTiles, seats, openMap, new Set());
    expect(sentinel.seatTimer).toBe(0);
  });

  it("walks tile-to-tile, repaths active walkers, and settles into the correct terminal state", () => {
    const seats = new Map([["seat-a", seat]]);
    const ch = cloneCharacter({
      state: CharacterState.WALK,
      tileCol: 0,
      tileRow: 1,
      x: 8,
      y: 24,
      path: [{ col: 1, row: 1 }],
      isActive: true,
    });

    updateCharacter(ch, 0.5, walkableTiles, seats, openMap, new Set());
    expect(ch).toMatchObject({
      dir: Direction.RIGHT,
      tileCol: 1,
      tileRow: 1,
      x: 24,
      y: 24,
    });
    expect(ch.path.at(-1)).toEqual({ col: 2, row: 1 });

    ch.path = [];
    ch.tileCol = 2;
    ch.tileRow = 1;
    updateCharacter(ch, 0.1, walkableTiles, seats, openMap, new Set());
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.dir).toBe(Direction.LEFT);

    const inactiveAtSeat = cloneCharacter({
      state: CharacterState.WALK,
      path: [],
      tileCol: 2,
      tileRow: 1,
      isActive: false,
      seatTimer: -1,
    });
    updateCharacter(inactiveAtSeat, 0.1, walkableTiles, seats, openMap, new Set());
    expect(inactiveAtSeat.state).toBe(CharacterState.TYPE);
    expect(inactiveAtSeat.seatTimer).toBe(0);

    const inactiveAway = cloneCharacter({
      state: CharacterState.WALK,
      path: [],
      tileCol: 0,
      tileRow: 0,
      isActive: false,
    });
    updateCharacter(inactiveAway, 0.1, walkableTiles, seats, openMap, new Set());
    expect(inactiveAway.state).toBe(CharacterState.IDLE);
  });

  it("selects reading, typing, walking, idle, and fallback sprites", () => {
    expect(getCharacterSprite(cloneCharacter({ currentTool: "Read", frame: 1 }), sprites)).toEqual(
      sprite("read-left-1"),
    );
    expect(getCharacterSprite(cloneCharacter({ currentTool: "Edit", frame: 3 }), sprites)).toEqual(
      sprite("type-left-1"),
    );
    expect(
      getCharacterSprite(cloneCharacter({ state: CharacterState.WALK, dir: Direction.RIGHT, frame: 7 }), sprites),
    ).toEqual(sprite("walk-right-3"));
    expect(getCharacterSprite(cloneCharacter({ state: CharacterState.IDLE, dir: Direction.UP }), sprites)).toEqual(
      sprite("walk-up-1"),
    );
    expect(
      getCharacterSprite(cloneCharacter({ state: "unknown" as CharacterState, dir: Direction.DOWN }), sprites),
    ).toEqual(sprite("walk-down-1"));
  });
});
