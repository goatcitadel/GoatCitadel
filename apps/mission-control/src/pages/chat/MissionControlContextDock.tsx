import type { ReactNode } from "react";
import type { ChatMode } from "@goatcitadel/contracts";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function MissionControlContextDock({
  mode,
  open,
  children,
}: {
  mode: ChatMode;
  open: boolean;
  children: ReactNode;
}) {
  const config = getMissionControlSurfaceConfig(mode);

  return (
    <aside
      className={`chat-v11-inspector-lane mission-context-dock mode-${mode}${open ? " is-open" : " is-collapsed"}`}
      aria-hidden={!open}
    >
      <div className="mission-context-dock-head">
        <div>
          <p className="mission-context-dock-kicker">{config.dockTitle}</p>
          <h3>{config.stageTitle}</h3>
          <p className="mission-context-dock-posture">{config.stageSummary}</p>
          <p>{config.dockSummary}</p>
        </div>
      </div>
      <div className="mission-context-dock-body">
        {children}
      </div>
    </aside>
  );
}
