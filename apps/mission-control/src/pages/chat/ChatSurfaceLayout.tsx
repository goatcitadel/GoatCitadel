import type { ChatMode } from "@goatcitadel/contracts";
import type { ReactNode } from "react";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function ChatSurfaceLayout({
  mode,
  sessionRail,
  primaryColumn,
  workflowColumn,
  contextDock,
  dockOpen,
}: {
  mode: ChatMode;
  sessionRail: ReactNode;
  primaryColumn: ReactNode;
  workflowColumn?: ReactNode;
  contextDock: ReactNode;
  dockOpen: boolean;
}) {
  const layout = getMissionControlSurfaceConfig(mode).layout;
  const workflowIsPrimary = layout.workflowPlacement === "primary" && workflowColumn;
  const artifactColumn = workflowIsPrimary ? workflowColumn : primaryColumn;
  const supportThreadColumn = layout.threadPlacement === "support" ? primaryColumn : null;

  return (
    <div
      className={`chat-v11-shell ${layout.shellClassName}`}
      data-dominant-artifact={layout.dominantArtifact}
      data-thread-placement={layout.threadPlacement}
      data-session-rail-visibility={layout.sessionRailVisibility}
      data-support-thread-behavior={layout.supportThreadBehavior}
      data-dock-behavior={layout.dockBehavior}
      data-desktop-density={layout.desktopDensity}
    >
      <div className={`chat-v11-session-rail ${layout.sessionRailClassName}`}>{sessionRail}</div>
      <div className="chat-v11-main">
        <div className={`chat-v11-conversation-shell surface-${mode}`}>
          <div
            className={`chat-v11-main-grid ${layout.mainGridClassName}${mode === "cowork" ? " with-cowork" : ""}${mode === "code" ? " with-code" : ""}${dockOpen ? " with-dock-open" : " with-dock-collapsed"}`}
          >
            <div
              className={`chat-v11-artifact-column ${workflowIsPrimary ? `chat-v11-secondary-column chat-v11-secondary-column-${mode} ${layout.workflowColumnClassName ?? ""}` : `chat-v11-primary-column ${layout.primaryColumnClassName}`}`.trim()}
              data-surface-slot="artifact"
            >
              {artifactColumn}
            </div>
            {supportThreadColumn ? (
              <div
                className={`chat-v11-support-column chat-v11-primary-column ${layout.primaryColumnClassName}`.trim()}
                data-surface-slot="support-thread"
              >
                {supportThreadColumn}
              </div>
            ) : null}
            {dockOpen ? (
              <div className={`chat-v11-dock-column ${layout.dockClassName}`} data-surface-slot="dock">
                {contextDock}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
