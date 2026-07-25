import {
  OPS_SAVED_BOARD_LIMITS,
  OPS_SAVED_BOARD_WIDGET_KINDS,
  type OpsSavedBoardPlacement,
  type OpsSavedBoardRecord,
  type OpsSavedBoardWidgetKind,
} from "@goatcitadel/contracts";

export interface OpsSavedBoardsDraft {
  name: string;
  description: string;
  placements: OpsSavedBoardPlacement[];
}

export interface OpsSavedBoardsWidgetOption {
  kind: OpsSavedBoardWidgetKind;
  label: string;
  description: string;
}

export const OPS_SAVED_BOARDS_WIDGET_OPTIONS: readonly OpsSavedBoardsWidgetOption[] = Object.freeze([
  {
    kind: OPS_SAVED_BOARD_WIDGET_KINDS[0],
    label: "Agentic run Kanban",
    description: "Current run posture and attention signals from the canonical agentic-run owner.",
  },
  {
    kind: OPS_SAVED_BOARD_WIDGET_KINDS[1],
    label: "Approval queue",
    description: "Pending workspace-linked decisions grouped by current risk posture.",
  },
  {
    kind: OPS_SAVED_BOARD_WIDGET_KINDS[2],
    label: "Runtime truth",
    description: "Gateway host, daemon, memory, and recent runtime signal.",
  },
  {
    kind: OPS_SAVED_BOARD_WIDGET_KINDS[3],
    label: "Task status",
    description: "Current workspace task flow, blockers, and completed work.",
  },
  {
    kind: OPS_SAVED_BOARD_WIDGET_KINDS[4],
    label: "Usage and cost",
    description: "Canonical Gateway day-scope token and cost coverage.",
  },
]);

export function createOpsSavedBoardsDraft(board?: OpsSavedBoardRecord): OpsSavedBoardsDraft {
  if (board) {
    return {
      name: board.name,
      description: board.description ?? "",
      placements: board.placements.map((placement) => ({ ...placement })),
    };
  }
  return {
    name: "",
    description: "",
    placements: [createPlacement("runtime_truth_summary", [])],
  };
}

export function addOpsSavedBoardsWidget(
  draft: OpsSavedBoardsDraft,
  kind: OpsSavedBoardWidgetKind,
): OpsSavedBoardsDraft {
  if (draft.placements.length >= OPS_SAVED_BOARD_LIMITS.placementsPerBoard) {
    return draft;
  }
  return {
    ...draft,
    placements: [...draft.placements, createPlacement(kind, draft.placements)],
  };
}

export function removeOpsSavedBoardsWidget(draft: OpsSavedBoardsDraft, widgetId: string): OpsSavedBoardsDraft {
  if (draft.placements.length <= 1) {
    return draft;
  }
  return {
    ...draft,
    placements: draft.placements.filter((placement) => placement.widgetId !== widgetId),
  };
}

export type OpsSavedBoardsPlacementAdjustment =
  | "left"
  | "right"
  | "up"
  | "down"
  | "narrower"
  | "wider"
  | "shorter"
  | "taller";

export function adjustOpsSavedBoardsPlacement(
  draft: OpsSavedBoardsDraft,
  widgetId: string,
  adjustment: OpsSavedBoardsPlacementAdjustment,
): OpsSavedBoardsDraft {
  return {
    ...draft,
    placements: draft.placements.map((placement) =>
      placement.widgetId === widgetId ? adjustPlacement(placement, adjustment) : placement,
    ),
  };
}

export function formatOpsSavedBoardsWidgetLabel(kind: OpsSavedBoardWidgetKind): string {
  return OPS_SAVED_BOARDS_WIDGET_OPTIONS.find((option) => option.kind === kind)?.label ?? "Unsupported widget";
}

function createPlacement(
  kind: OpsSavedBoardWidgetKind,
  existing: readonly OpsSavedBoardPlacement[],
): OpsSavedBoardPlacement {
  const widgetId = createWidgetId(kind, existing);
  const nextRow = existing.reduce((max, placement) => Math.max(max, placement.y + placement.height), 0);
  return {
    widgetId,
    kind,
    x: 0,
    y: Math.min(nextRow, OPS_SAVED_BOARD_LIMITS.maxGridRow),
    width: 6,
    height: 4,
  };
}

function createWidgetId(kind: OpsSavedBoardWidgetKind, existing: readonly OpsSavedBoardPlacement[]): string {
  const existingIds = new Set(existing.map((placement) => placement.widgetId));
  let sequence = 1;
  while (existingIds.has(`${kind}-${sequence}`)) sequence += 1;
  return `${kind}-${sequence}`;
}

function adjustPlacement(
  placement: OpsSavedBoardPlacement,
  adjustment: OpsSavedBoardsPlacementAdjustment,
): OpsSavedBoardPlacement {
  switch (adjustment) {
    case "left":
      return { ...placement, x: Math.max(0, placement.x - 1) };
    case "right":
      return {
        ...placement,
        x: Math.min(OPS_SAVED_BOARD_LIMITS.gridColumns - placement.width, placement.x + 1),
      };
    case "up":
      return { ...placement, y: Math.max(0, placement.y - 1) };
    case "down":
      return { ...placement, y: Math.min(OPS_SAVED_BOARD_LIMITS.maxGridRow, placement.y + 1) };
    case "narrower":
      return { ...placement, width: Math.max(1, placement.width - 1) };
    case "wider":
      return {
        ...placement,
        width: Math.min(OPS_SAVED_BOARD_LIMITS.gridColumns - placement.x, placement.width + 1),
      };
    case "shorter":
      return { ...placement, height: Math.max(1, placement.height - 1) };
    case "taller":
      return {
        ...placement,
        height: Math.min(OPS_SAVED_BOARD_LIMITS.maxWidgetSpan, placement.height + 1),
      };
  }
}
