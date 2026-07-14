import { OPS_SAVED_BOARD_LIMITS, OPS_SAVED_BOARD_WIDGET_KINDS } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  OPS_SAVED_BOARDS_WIDGET_OPTIONS,
  addOpsSavedBoardsWidget,
  adjustOpsSavedBoardsPlacement,
  createOpsSavedBoardsDraft,
  removeOpsSavedBoardsWidget,
} from "./OpsSavedBoardsModel";

describe("OpsSavedBoardsModel", () => {
  it("exposes exactly the five compiled widget kinds", () => {
    expect(OPS_SAVED_BOARDS_WIDGET_OPTIONS.map((option) => option.kind)).toEqual([...OPS_SAVED_BOARD_WIDGET_KINDS]);
    expect(OPS_SAVED_BOARDS_WIDGET_OPTIONS).toHaveLength(5);
  });

  it("keeps placement moves and resizes inside contract bounds", () => {
    let draft = createOpsSavedBoardsDraft();
    const widgetId = draft.placements[0]!.widgetId;

    for (let index = 0; index < 300; index += 1) {
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "right");
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "down");
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "wider");
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "taller");
    }

    const placement = draft.placements[0]!;
    expect(placement.x + placement.width).toBeLessThanOrEqual(OPS_SAVED_BOARD_LIMITS.gridColumns);
    expect(placement.y).toBe(OPS_SAVED_BOARD_LIMITS.maxGridRow);
    expect(placement.height).toBe(OPS_SAVED_BOARD_LIMITS.maxWidgetSpan);

    for (let index = 0; index < 300; index += 1) {
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "left");
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "up");
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "narrower");
      draft = adjustOpsSavedBoardsPlacement(draft, widgetId, "shorter");
    }

    expect(draft.placements[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("caps boards at twelve placements and never removes the final widget", () => {
    let draft = createOpsSavedBoardsDraft();
    for (let index = 0; index < 20; index += 1) {
      draft = addOpsSavedBoardsWidget(draft, "task_status_summary");
    }
    expect(draft.placements).toHaveLength(OPS_SAVED_BOARD_LIMITS.placementsPerBoard);
    expect(new Set(draft.placements.map((placement) => placement.widgetId)).size).toBe(
      OPS_SAVED_BOARD_LIMITS.placementsPerBoard,
    );

    for (const placement of [...draft.placements]) {
      draft = removeOpsSavedBoardsWidget(draft, placement.widgetId);
    }
    expect(draft.placements).toHaveLength(1);
  });
});
