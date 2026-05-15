// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDynamicCatalog } from "../layout/furnitureCatalog";
import type { OfficeLayout } from "../types";
import { CharacterState, Direction, TILE_SIZE, TileType } from "../types";
import { OfficeState } from "./officeState";

function sprite(color: string): string[][] {
  return [[color]];
}

function installCatalog(): void {
  buildDynamicCatalog({
    catalog: [
      {
        id: "DESK_FRONT",
        label: "Desk - Front - Off",
        category: "desks",
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: true,
        groupId: "desk",
        orientation: "front",
        state: "off",
      },
      {
        id: "DESK_FRONT_ON",
        label: "Desk - Front - On",
        category: "desks",
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: true,
        groupId: "desk",
        orientation: "front",
        state: "on",
        animationGroup: "desk-front-on",
        frame: 0,
      },
      {
        id: "DESK_FRONT_ON_2",
        label: "Desk - Front - On 2",
        category: "desks",
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: true,
        groupId: "desk",
        orientation: "front",
        state: "on",
        animationGroup: "desk-front-on",
        frame: 1,
      },
      {
        id: "WOODEN_CHAIR_BACK",
        label: "Wood chair - Back",
        category: "chairs",
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        orientation: "back",
      },
      {
        id: "PLANT",
        label: "Plant",
        category: "decor",
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
      },
    ],
    sprites: {
      DESK_FRONT: sprite("#101010"),
      DESK_FRONT_ON: sprite("#00ffcc"),
      DESK_FRONT_ON_2: sprite("#00ddaa"),
      WOODEN_CHAIR_BACK: sprite("#202020"),
      PLANT: sprite("#00aa00"),
    },
  });
}

function makeLayout(): OfficeLayout {
  const cols = 6;
  const rows = 6;
  const tiles = Array.from({ length: cols * rows }, (_, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return col === 0 || row === 0 || col === cols - 1 || row === rows - 1 ? TileType.WALL : TileType.FLOOR_1;
  });
  return {
    version: 1,
    cols,
    rows,
    tiles,
    tileColors: tiles.map((tile) => (tile === TileType.WALL ? null : { h: 0, s: 0, b: 0, c: 0 })),
    furniture: [
      { uid: "desk-1", type: "DESK_FRONT", col: 2, row: 1 },
      { uid: "chair-1", type: "WOODEN_CHAIR_BACK", col: 2, row: 2 },
      { uid: "chair-2", type: "WOODEN_CHAIR_BACK", col: 3, row: 2 },
      { uid: "plant-1", type: "PLANT", col: 4, row: 4 },
    ],
  };
}

describe("OfficeState", () => {
  beforeEach(() => {
    installCatalog();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("assigns seats, updates agent state, bubbles, and hit testing", () => {
    const state = new OfficeState(makeLayout());

    state.addAgent(1, 2, 15, "chair-1", true, "workspace-a");
    const agent = state.characters.get(1)!;

    expect(agent.seatId).toBe("chair-1");
    expect(agent.folderName).toBe("workspace-a");
    expect(agent.dir).toBe(Direction.UP);
    expect(state.getSeatAtTile(2, 2)).toBe("chair-1");

    state.setAgentTool(1, "Read");
    state.showPermissionBubble(1);
    expect(agent.currentTool).toBe("Read");
    expect(agent.bubbleType).toBe("permission");

    state.clearPermissionBubble(1);
    state.showWaitingBubble(1);
    state.dismissBubble(1);
    expect(agent.bubbleType).toBe("waiting");
    expect(agent.bubbleTimer).toBeLessThan(1);

    state.update(1);
    expect(agent.bubbleType).toBeNull();

    expect(state.getCharacterAt(agent.x, agent.y)).toBe(1);
    state.removeAgent(1);
    expect(agent.matrixEffect).toBe("despawn");
    expect(state.getCharacterAt(agent.x, agent.y)).toBeNull();
    state.update(10);
    expect(state.characters.has(1)).toBe(false);
  });

  it("walks, reassigns seats, rebuilds shifted layouts, and manages subagents", () => {
    const state = new OfficeState(makeLayout());
    state.addAgent(1, 0, 0, "chair-1", true);

    expect(state.walkToTile(1, 1, 1)).toBe(true);
    expect(state.characters.get(1)!.state).toBe(CharacterState.WALK);
    expect(state.walkToTile(999, 1, 1)).toBe(false);

    state.reassignSeat(1, "chair-2");
    expect(state.characters.get(1)!.seatId).toBe("chair-2");
    state.sendToSeat(1);

    const subagentId = state.addSubagent(1, "tool-a");
    expect(subagentId).toBeLessThan(0);
    expect(state.getSubagentId(1, "tool-a")).toBe(subagentId);
    expect(state.addSubagent(1, "tool-a")).toBe(subagentId);

    state.removeSubagent(1, "tool-a");
    expect(state.getSubagentId(1, "tool-a")).toBeNull();
    expect(state.characters.get(subagentId)!.matrixEffect).toBe("despawn");

    const subagentB = state.addSubagent(1, "tool-b");
    state.removeAllSubagents(1);
    expect(state.getSubagentId(1, "tool-b")).toBeNull();
    expect(state.characters.get(subagentB)!.matrixEffect).toBe("despawn");

    const before = state.characters.get(1)!;
    state.rebuildFromLayout({ ...makeLayout(), cols: 7, rows: 7 }, { col: 1, row: 1 });
    expect(before.x).toBe(before.tileCol * TILE_SIZE + TILE_SIZE / 2);
  });

  it("falls back to walkable spawn points when no seats exist", () => {
    const layout = makeLayout();
    layout.furniture = [];
    const state = new OfficeState(layout);

    state.addAgent(7, undefined, undefined, undefined, false);
    const agent = state.characters.get(7)!;

    expect(agent.seatId).toBeNull();
    expect(agent.matrixEffect).toBe("spawn");
    state.update(10);
    expect(agent.matrixEffect).toBeNull();

    state.setAgentActive(7, false);
    expect(agent.isActive).toBe(false);
    expect(agent.seatTimer).toBe(-1);
  });

  it("uses balanced palettes after the first round and falls back when no walkable spawn exists", () => {
    const layout = makeLayout();
    layout.furniture = [];
    const state = new OfficeState(layout);

    for (let id = 1; id <= 7; id += 1) {
      state.addAgent(id, undefined, undefined, undefined, true);
    }

    expect(state.characters.get(7)!.hueShift).toBeGreaterThanOrEqual(45);

    const blockedLayout: OfficeLayout = {
      version: 1,
      cols: 2,
      rows: 2,
      tiles: [TileType.WALL, TileType.WALL, TileType.WALL, TileType.WALL],
      tileColors: [null, null, null, null],
      furniture: [],
    };
    const blockedState = new OfficeState(blockedLayout);
    blockedState.addAgent(99, undefined, undefined, undefined, true);

    expect(blockedState.walkableTiles).toHaveLength(0);
    expect(blockedState.characters.get(99)).toMatchObject({
      tileCol: 1,
      tileRow: 1,
    });
  });

  it("reassigns and sends inactive agents directly into a seat rest when already at the seat", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const state = new OfficeState(makeLayout());
    state.addAgent(1, 0, 0, "chair-1", true);
    const agent = state.characters.get(1)!;
    agent.isActive = false;
    agent.tileCol = 3;
    agent.tileRow = 2;
    agent.x = 3 * TILE_SIZE + TILE_SIZE / 2;
    agent.y = 2 * TILE_SIZE + TILE_SIZE / 2;

    state.reassignSeat(1, "chair-2");
    expect(agent.seatId).toBe("chair-2");
    expect(agent.state).toBe(CharacterState.TYPE);
    expect(agent.seatTimer).toBeGreaterThan(0);

    agent.seatTimer = 0;
    state.sendToSeat(1);
    expect(agent.state).toBe(CharacterState.TYPE);
    expect(agent.seatTimer).toBeGreaterThan(0);
  });

  it("relocates unseated out-of-bounds agents and manages despawning subagent cleanup branches", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const layout = makeLayout();
    layout.furniture = [];
    const state = new OfficeState(layout);
    state.addAgent(1, 0, 0, undefined, true);
    const agent = state.characters.get(1)!;
    agent.tileCol = 99;
    agent.tileRow = 99;
    agent.x = 99;
    agent.y = 99;

    state.rebuildFromLayout(layout);
    expect(agent.tileCol).toBeGreaterThanOrEqual(1);
    expect(agent.tileCol).toBeLessThan(layout.cols - 1);
    expect(agent.path).toEqual([]);

    const subagentId = state.addSubagent(1, "tool-despawn");
    state.characters.get(subagentId)!.matrixEffect = "despawn";
    state.removeSubagent(1, "tool-despawn");
    expect(state.getSubagentId(1, "tool-despawn")).toBeNull();
    expect(state.subagentMeta.has(subagentId)).toBe(false);

    const subagentA = state.addSubagent(1, "tool-a");
    const subagentB = state.addSubagent(1, "tool-b");
    state.characters.get(subagentA)!.matrixEffect = "despawn";
    state.removeAllSubagents(1);
    expect(state.getSubagentId(1, "tool-a")).toBeNull();
    expect(state.getSubagentId(1, "tool-b")).toBeNull();
    expect(state.characters.get(subagentB)!.matrixEffect).toBe("despawn");
  });

  it("dismisses permission bubbles and animates auto-on furniture for active agents", () => {
    const state = new OfficeState(makeLayout());
    state.addAgent(1, 0, 0, "chair-1", true);
    const agent = state.characters.get(1)!;

    state.showPermissionBubble(1);
    state.dismissBubble(1);
    expect(agent.bubbleType).toBeNull();

    state.setAgentActive(1, true);
    expect(state.furniture.some((item) => item.sprite[0]?.[0] === "#00ffcc")).toBe(true);

    state.furnitureAnimTimer = 1;
    state.setAgentActive(1, true);
    expect(state.furniture.some((item) => item.sprite[0]?.[0] === "#00ddaa")).toBe(true);

    state.setAgentActive(1, false);
    expect(state.furniture.some((item) => item.sprite[0]?.[0] === "#101010")).toBe(true);
  });
});
