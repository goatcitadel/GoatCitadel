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
  hasActiveSession = true,
}: {
  mode: ChatMode;
  sessionRail: ReactNode;
  primaryColumn: ReactNode;
  workflowColumn?: ReactNode;
  contextDock: ReactNode;
  dockOpen: boolean;
  hasActiveSession?: boolean;
}) {
  const layout = getMissionControlSurfaceConfig(mode).layout;
  if (!hasActiveSession) {
    return (
      <div
        className={`chat-v11-shell ${layout.shellClassName} is-idle-simplified`}
        data-dominant-artifact={layout.dominantArtifact}
        data-thread-placement={layout.threadPlacement}
        data-session-rail-visibility={layout.sessionRailVisibility}
        data-support-thread-behavior={layout.supportThreadBehavior}
        data-dock-behavior={layout.dockBehavior}
        data-desktop-density={layout.desktopDensity}
        data-session-state="idle"
        data-idle-min-height={layout.idleMinHeight}
      >
        <div className={`chat-v11-session-rail ${layout.sessionRailClassName}`}>{sessionRail}</div>
        <div className="chat-v11-main">
          <div className={`chat-v11-conversation-shell surface-${mode}`}>
            <div className="chat-v11-main-grid chat-v11-main-grid-idle">
              <div
                className={`chat-v11-primary-column ${layout.primaryColumnClassName}`.trim()}
                data-surface-slot="primary"
              >
                {workflowColumn ?? primaryColumn}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  const workflowIsPrimary = layout.workflowPlacement === "primary" && workflowColumn;
  const artifactColumn = workflowIsPrimary ? workflowColumn : primaryColumn;
  const supportThreadColumn =
    layout.threadPlacement === "support" && (hasActiveSession || layout.idleSupportVisibility === "visible")
      ? primaryColumn
      : null;
  const effectiveDockOpen = hasActiveSession ? dockOpen : layout.idleDockOpen;

  return (
    <div
      className={`chat-v11-shell ${layout.shellClassName}`}
      data-dominant-artifact={layout.dominantArtifact}
      data-thread-placement={layout.threadPlacement}
      data-session-rail-visibility={layout.sessionRailVisibility}
      data-support-thread-behavior={layout.supportThreadBehavior}
      data-dock-behavior={layout.dockBehavior}
      data-desktop-density={layout.desktopDensity}
      data-session-state={hasActiveSession ? "active" : "idle"}
      data-idle-min-height={layout.idleMinHeight}
    >
      <div className={`chat-v11-session-rail ${layout.sessionRailClassName}`}>{sessionRail}</div>
      <div className="chat-v11-main">
        <div className={`chat-v11-conversation-shell surface-${mode}`}>
          <div
            className={`chat-v11-main-grid ${layout.mainGridClassName}${mode === "cowork" ? " with-cowork" : ""}${mode === "code" ? " with-code" : ""}${effectiveDockOpen ? " with-dock-open" : " with-dock-collapsed"}${hasActiveSession ? " is-active" : " is-idle"}`}
          >
            <div
              className={`chat-v11-artifact-column ${workflowIsPrimary ? `chat-v11-primary-column chat-v11-workflow-primary chat-v11-workflow-primary-${mode} ${layout.workflowColumnClassName ?? ""}` : `chat-v11-primary-column ${layout.primaryColumnClassName}`}`.trim()}
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
            {effectiveDockOpen ? (
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
