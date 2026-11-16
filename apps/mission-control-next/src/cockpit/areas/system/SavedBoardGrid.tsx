import type { CSSProperties } from "react";
import type { OpsSavedBoardPlacement } from "@goatcitadel/contracts";
import { SystemDashboardWidget } from "./SystemDashboardWidget";

/** The saved-board widget grid: each widget at its own column, row and size. Used by the saved board and by the editor's preview. */
export function SavedBoardGrid({
  label,
  placements,
  workspaceId,
}: {
  label: string;
  placements: readonly OpsSavedBoardPlacement[];
  workspaceId: string;
}) {
  return (
    <div role="region" aria-label={label} className="cockpit-saved-board-grid">
      {placements.map((placement) => (
        <div
          key={placement.widgetId}
          className="cockpit-saved-board-placement"
          style={
            {
              "--board-column-start": placement.x + 1,
              "--board-column-span": placement.width,
              "--board-row-start": placement.y + 1,
              "--board-row-span": placement.height,
            } as CSSProperties
          }
        >
          <SystemDashboardWidget kind={placement.kind} workspaceId={workspaceId} />
        </div>
      ))}
    </div>
  );
}
