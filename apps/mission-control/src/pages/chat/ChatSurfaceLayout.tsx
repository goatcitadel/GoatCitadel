import type { ChatMode } from "@goatcitadel/contracts";
import type { ReactNode } from "react";
import { Drawer, DrawerContent, Sheet, SheetContent } from "../../components/ui";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function ChatSurfaceLayout({
  mode,
  sessionRail,
  primaryColumn,
  workflowColumn,
  contextDock,
  dockOpen,
  onDockOpenChange,
  hasActiveSession = true,
  sessionRailOpen = false,
  onSessionRailOpenChange,
}: {
  mode: ChatMode;
  sessionRail: ReactNode;
  primaryColumn: ReactNode;
  workflowColumn?: ReactNode;
  contextDock: ReactNode;
  dockOpen: boolean;
  onDockOpenChange?: (next: boolean) => void;
  hasActiveSession?: boolean;
  sessionRailOpen?: boolean;
  onSessionRailOpenChange?: (next: boolean) => void;
}) {
  const layout = getMissionControlSurfaceConfig(mode).layout;
  const compactSecondaryPanels = useMediaQuery("(max-width: 840px)");
  const inlineSessionRail = !compactSecondaryPanels;
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
        {inlineSessionRail ? (
          <div className={`chat-v11-session-rail ${layout.sessionRailClassName}`}>{sessionRail}</div>
        ) : null}
        <div className="chat-v11-main">
          {compactSecondaryPanels ? (
            <div className="chat-v11-mobile-rail-launcher">
              <button
                type="button"
                className="gc-nav-button gc-nav-tier-chip"
                onClick={() => onSessionRailOpenChange?.(!sessionRailOpen)}
              >
                {sessionRailOpen ? "Hide history" : "History"}
              </button>
            </div>
          ) : null}
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
        {compactSecondaryPanels ? (
          <Sheet open={sessionRailOpen} onOpenChange={onSessionRailOpenChange}>
            <SheetContent side="left" className="chat-v11-session-sheet">
              {sessionRail}
            </SheetContent>
          </Sheet>
        ) : null}
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
  const inlineDock = !compactSecondaryPanels && effectiveDockOpen;

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
      {inlineSessionRail ? (
        <div className={`chat-v11-session-rail ${layout.sessionRailClassName}`}>{sessionRail}</div>
      ) : null}
      <div className="chat-v11-main">
        {compactSecondaryPanels ? (
          <div className="chat-v11-mobile-rail-launcher">
            <button
              type="button"
              className="gc-nav-button gc-nav-tier-chip"
              onClick={() => onSessionRailOpenChange?.(!sessionRailOpen)}
            >
              {sessionRailOpen ? "Hide history" : "History"}
            </button>
          </div>
        ) : null}
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
            {inlineDock ? (
              <div className={`chat-v11-dock-column ${layout.dockClassName}`} data-surface-slot="dock">
                {contextDock}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {compactSecondaryPanels ? (
        <Sheet open={sessionRailOpen} onOpenChange={onSessionRailOpenChange}>
          <SheetContent side="left" className="chat-v11-session-sheet">
            {sessionRail}
          </SheetContent>
        </Sheet>
      ) : null}
      {compactSecondaryPanels && hasActiveSession ? (
        <Drawer open={effectiveDockOpen} onOpenChange={onDockOpenChange} shouldScaleBackground={false}>
          <DrawerContent className="mission-context-dock-drawer">{contextDock}</DrawerContent>
        </Drawer>
      ) : null}
    </div>
  );
}
