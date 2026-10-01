import { MODE_META, formatThreadedPermissionSummary, type ThreadedPermissionState } from "./threaded-surface-model";
import { panelOwnsActiveFocus, getDrawerFocusableElements, resolveDrawerTabTarget } from "./threaded-drawer-focus";
import type { ThreadedUtilityPanelId } from "./threaded-utility-navigation";
import { LazyThreadedWorkflowPanel } from "./ThreadedWorkflowPanelLoader";
import { ThreadConversationSurface } from "./ThreadConversationSurface";
import { ThreadEmptyState } from "./ThreadEmptyState";
import { ThreadedUtilityPanel } from "./ThreadedUtilityPanel";
import { ThreadedSessionRail } from "./ThreadedSessionRail";
export {
  formatThreadedPermissionSummary,
  formatThreadedApprovalMode,
  formatThreadedOverrideExpiry,
  getArchiveActionLabel,
  type ThreadedPermissionState,
} from "./threaded-surface-model";
export { panelOwnsActiveFocus, getDrawerFocusableElements, resolveDrawerTabTarget } from "./threaded-drawer-focus";
import { useDraftLeave } from "../native-routes/library/DraftLeaveDialog";
import { useCallback, useEffect, useMemo, useRef, useState, Suspense, type CSSProperties } from "react";
import { Code2, Menu, PanelRight } from "lucide-react";
import type { ChatMode } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { groupDelegatedSessionsForRail } from "@goatcitadel/threaded-surface-core";

import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";

import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";

import { useUnifiedSidebar } from "@next/app/UnifiedSidebar";

import { ThreadedBtwSideChatPanel } from "./ThreadedBtwSideChatPanel";
import { ThreadedContextDrawer } from "./ThreadedContextDrawer";

import { PaneResizeHandle, useHorizontalPaneResize } from "./ThreadedPaneResize";

import "./styles/rail.css";
import "./styles/header.css";
import "./styles/timeline-frame.css";
import "./styles/visual-regression.css";
import "./styles/side-panels.css";
import "./styles/timeline.css";
import "./styles/code-highlight.css";
import "./styles/composer.css";
import "./styles/mobile.css";
import "./styles/btw-side-chat.css";
import "./styles/generated-artifact.css";
import "./styles/conversation-workspace.css";
import "./styles/capability-profile.css";
import "./styles/background-task-rail.css";
import "./styles/session-control-banner.css";
import "./styles/chat-session-status.css";
import "./styles/chat-timer.css";
import "./styles/run-variables.css";
import "./styles/change-plans.css";
import "./styles/calm-chat.css";

export { formatRelativeTime } from "./ThreadedSessionGroup";

const PANE_WIDTHS = {
  rail: { initial: 216, min: 184, max: 300 },
  workbench: { initial: 560, min: 320, max: 840 },
  context: { initial: 400, min: 320, max: 560 },
};
const MIN_CONVERSATION_WIDTH = 680;
const PANEL_GRID_GAP = 12;

export function ThreadedSurfacePage({
  surface,
  input,
  permissionState,
  onCopyTrustReport,
  onOpenUniversalRunDetail,
}: {
  surface: ChatMode;
  input: MissionThreadedRenderSurfaceInput;
  permissionState?: ThreadedPermissionState;
  onCopyTrustReport?: (sessionId?: string | null, turnId?: string | null) => void;
  onOpenUniversalRunDetail?: (runId: string) => void;
}) {
  const sidebar = useUnifiedSidebar();
  const detailLeave = useDraftLeave();
  const leaveRef = useRef(detailLeave);
  leaveRef.current = detailLeave;
  const embeddedRail = Boolean(sidebar);
  const railDrawerLayout = useMediaQuery("(width < 1280px)");
  // The controller-owned rail state is intentionally reserved for the compact
  // drawer. Desktop Chat owns its own temporary disclosure state so opening
  // Threads never makes a persistent rail compete with the conversation.
  const [desktopSessionRailOpen, setDesktopSessionRailOpen] = useState(false);
  const railPane = useHorizontalPaneResize({
    direction: "right",
    initialWidth: PANE_WIDTHS.rail.initial,
    maxWidth: PANE_WIDTHS.rail.max,
    minWidth: PANE_WIDTHS.rail.min,
  });
  const workbenchPane = useHorizontalPaneResize({
    direction: "left",
    initialWidth: PANE_WIDTHS.workbench.initial,
    maxWidth: PANE_WIDTHS.workbench.max,
    minWidth: PANE_WIDTHS.workbench.min,
  });
  const contextPane = useHorizontalPaneResize({
    direction: "left",
    initialWidth: PANE_WIDTHS.context.initial,
    maxWidth: PANE_WIDTHS.context.max,
    minWidth: PANE_WIDTHS.context.min,
  });
  const desktopPanelsCanCoexist = useMediaQuery(
    `(width >= ${MIN_CONVERSATION_WIDTH + railPane.width + contextPane.width + PANEL_GRID_GAP}px)`,
  );
  const railOpen = sidebar
    ? sidebar.mobile
      ? sidebar.navOpen
      : !sidebar.collapsed
    : railDrawerLayout
      ? input.sessionRailOpen
      : desktopSessionRailOpen;
  const railDrawerOpen = !embeddedRail && railDrawerLayout && railOpen;
  const railCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const railPanelRef = useRef<HTMLElement | null>(null);
  const railFocusReturnRef = useRef<HTMLElement | null>(null);
  const desktopPanelsCouldCoexistRef = useRef(desktopPanelsCanCoexist);
  const contextPanelRef = useRef<HTMLElement | null>(null);
  const contextFocusReturnRef = useRef<HTMLElement | null>(null);
  const activeProps = input.activeSessionSurfaceProps;
  const [activeUtilityPanel, setActiveUtilityPanel] = useState<ThreadedUtilityPanelId | null>(null);
  const [inspectorPinned, setInspectorPinned] = useState(() => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem("mc-next:chat:inspector-pinned") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("mc-next:chat:inspector-pinned", String(inspectorPinned));
    } catch {
      /* Presentation preference storage is optional. */
    }
  }, [inspectorPinned]);
  const previousSessionRef = useRef(activeProps?.selectedSessionId);
  const dockOpen = Boolean((input.dockOpen || activeUtilityPanel) && activeProps);
  const workflowPanel = input.workflowPanel;
  const activeMode: ChatMode = "chat";
  const modeMeta = MODE_META[activeMode];
  const [codeWorkbenchOpen, setCodeWorkbenchOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const lastActivityOpenRequestRef = useRef(0);
  const statusWasOpen = useRef(false);
  const workflowPanelOpen = Boolean(workflowPanel && codeWorkbenchOpen);
  const workbenchEvidenceRequested =
    codeWorkbenchOpen || ["files", "diff", "runlog", "background"].includes(activeUtilityPanel ?? "");
  const onWorkbenchOpenChange = input.onWorkbenchOpenChange;
  useEffect(() => {
    onWorkbenchOpenChange?.(workbenchEvidenceRequested);
  }, [onWorkbenchOpenChange, workbenchEvidenceRequested]);
  const missionSessionGroups = useMemo(
    () => groupDelegatedSessionsForRail(input.sessionRail.missionSessions),
    [input.sessionRail.missionSessions],
  );
  const externalSessionGroups = useMemo(
    () => groupDelegatedSessionsForRail(input.sessionRail.externalSessions),
    [input.sessionRail.externalSessions],
  );
  const stageLayoutClass = [
    "mc-next-threaded-stage",
    `mode-${activeMode}`,
    workflowPanelOpen ? "has-workbench" : "",
    workflowPanelOpen && workflowPanel?.kind === "cowork" ? "has-cowork-panel" : "",
    workflowPanelOpen && workflowPanel?.kind === "code" ? "has-code-panel" : "",
    dockOpen ? "has-context" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const archiveWorkspaceCount = input.sessionRail.archiveWorkspaceCount ?? 0;
  const archiveWorkspaceMessage =
    archiveWorkspaceCount > 0
      ? `Archive ${archiveWorkspaceCount} active mission chats in this workspace? Archived chats leave the default history rail but stay recoverable from Archived view.`
      : "Archive active mission chats in this workspace?";
  const rootStyle = useMemo(
    () =>
      ({
        "--mc-session-rail-width": `${railPane.width}px`,
      }) as CSSProperties,
    [railPane.width],
  );
  const stageStyle = useMemo(
    () =>
      ({
        "--mc-workbench-panel-width": `${workbenchPane.width}px`,
        "--mc-context-panel-width": `${contextPane.width}px`,
      }) as CSSProperties,
    [contextPane.width, workbenchPane.width],
  );
  const captureContextFocusReturn = useCallback(() => {
    if (
      typeof document !== "undefined" &&
      typeof HTMLElement !== "undefined" &&
      document.activeElement instanceof HTMLElement
    ) {
      contextFocusReturnRef.current = document.activeElement;
    }
  }, []);
  const restoreContextFocusReturn = useCallback(() => {
    queueMicrotask(() => {
      const target = contextFocusReturnRef.current;
      if (
        target &&
        typeof target.focus === "function" &&
        (typeof document === "undefined" || !document.contains || document.contains(target))
      ) {
        target.focus();
      }
      contextFocusReturnRef.current = null;
    });
  }, []);
  const handleDockOpenChange = useCallback(
    (next: boolean) =>
      leaveRef.current.request(() => {
        if (next && !dockOpen) {
          captureContextFocusReturn();
        }
        if (!next) {
          activeProps?.sessionStatusPanel?.onClose();
          restoreContextFocusReturn();
        }
        setActiveUtilityPanel(null);
        input.onDockOpenChange(next);
      }),
    [activeProps?.sessionStatusPanel, captureContextFocusReturn, dockOpen, input, restoreContextFocusReturn],
  );
  const closeSessionRail = useCallback(
    (restoreFocus = true) => {
      if (sidebar) {
        sidebar.close();
        return;
      }
      if (railDrawerLayout) {
        input.onSessionRailOpenChange(false);
      } else {
        setDesktopSessionRailOpen(false);
      }
      if (!restoreFocus) {
        return;
      }
      queueMicrotask(() => {
        const target = railFocusReturnRef.current;
        if (
          target &&
          typeof target.focus === "function" &&
          (typeof document === "undefined" || !document.contains || document.contains(target))
        ) {
          target.focus();
        }
        railFocusReturnRef.current = null;
      });
    },
    [input, railDrawerLayout, sidebar],
  );
  const openSessionRail = useCallback(() => {
    if (sidebar) {
      sidebar.open();
      return;
    }
    if (
      typeof document !== "undefined" &&
      typeof HTMLElement !== "undefined" &&
      document.activeElement instanceof HTMLElement
    ) {
      railFocusReturnRef.current = document.activeElement;
    }
    // A rail and Activity panel together turn the conversation into a narrow
    // afterthought. Keep the two disclosures mutually exclusive at every
    // breakpoint, including desktop where the controller only manages the
    // compact rail drawer.
    if (dockOpen && (railDrawerLayout || !desktopPanelsCanCoexist)) {
      setActiveUtilityPanel(null);
      input.onDockOpenChange(false);
    }
    if (railDrawerLayout) {
      input.onSessionRailOpenChange(true);
    } else {
      setDesktopSessionRailOpen(true);
    }
  }, [desktopPanelsCanCoexist, dockOpen, input, railDrawerLayout, sidebar]);
  const handleSelectUtilityPanel = useCallback(
    (panel: ThreadedUtilityPanelId) =>
      leaveRef.current.request(() => {
        if (!dockOpen) {
          captureContextFocusReturn();
        }
        // The build workbench and Activity compete for the same supporting
        // panel budget. Opening Activity from any entry point closes the editor
        // just as opening the editor closes Activity below.
        if (workflowPanel?.kind === "code" && codeWorkbenchOpen) {
          setCodeWorkbenchOpen(false);
        }
        if (railOpen && (railDrawerLayout || !desktopPanelsCanCoexist)) {
          closeSessionRail(false);
        }
        if (panel !== "status") activeProps?.sessionStatusPanel?.onClose();
        else if (!activeProps?.sessionStatusPanel?.open) activeProps?.sessionStatusPanel?.onRefresh();
        setActiveUtilityPanel(panel);
        input.onDockOpenChange(true);
      }),
    [
      captureContextFocusReturn,
      closeSessionRail,
      codeWorkbenchOpen,
      desktopPanelsCanCoexist,
      dockOpen,
      input,
      railDrawerLayout,
      railOpen,
      workflowPanel?.kind,
      activeProps?.sessionStatusPanel,
    ],
  );
  const handleToggleActivity = useCallback(() => {
    if (dockOpen) {
      handleDockOpenChange(false);
      return;
    }
    handleSelectUtilityPanel("preview");
  }, [dockOpen, handleDockOpenChange, handleSelectUtilityPanel]);
  const openBuildEditor = useCallback(
    () =>
      leaveRef.current.request(() => {
        setCodeWorkbenchOpen(true);
        setActiveUtilityPanel(null);
        activeProps?.sessionStatusPanel?.onClose();
        input.onDockOpenChange(false);
      }),
    [activeProps?.sessionStatusPanel, input],
  );
  const handleToggleBuildEditor = useCallback(() => {
    if (codeWorkbenchOpen) leaveRef.current.request(() => setCodeWorkbenchOpen(false));
    else openBuildEditor();
  }, [codeWorkbenchOpen, openBuildEditor]);
  const handleCreateSessionFromRail = useCallback(
    () =>
      leaveRef.current.request(async () => {
        // Keep the drawer over the old composer until the new session owns its draft.
        await input.sessionRail.onCreateSession();
        closeSessionRail();
      }),
    [closeSessionRail, input.sessionRail],
  );
  const handleArchiveWorkspace = () => {
    if (
      !input.sessionRail.archiveWorkspaceEnabled ||
      input.sessionRail.archiveWorkspacePending ||
      !input.sessionRail.onConfirmArchiveWorkspace
    ) {
      return;
    }
    setArchiveConfirmOpen(true);
  };
  const handleArchiveWorkspaceConfirmed = () => {
    setArchiveConfirmOpen(false);
    input.sessionRail.onConfirmArchiveWorkspace?.();
  };
  useEffect(() => {
    if (railDrawerLayout) {
      setDesktopSessionRailOpen(false);
    }
  }, [railDrawerLayout]);
  useEffect(() => {
    if (previousSessionRef.current === activeProps?.selectedSessionId) return;
    previousSessionRef.current = activeProps?.selectedSessionId;
    if (!inspectorPinned) {
      setActiveUtilityPanel(null);
      input.onDockOpenChange(false);
    }
    setCodeWorkbenchOpen(false);
  }, [activeProps?.selectedSessionId, input, inspectorPinned]);
  useEffect(() => {
    const request = input.activityOpenRequest ?? 0;
    if (request <= lastActivityOpenRequestRef.current) {
      return;
    }
    lastActivityOpenRequestRef.current = request;
    handleSelectUtilityPanel(activeProps?.activeGeneratedArtifact ? "artifacts" : "preview");
  }, [activeProps?.activeGeneratedArtifact, handleSelectUtilityPanel, input.activityOpenRequest]);
  useEffect(() => {
    const open = activeProps?.sessionStatusPanel?.open === true;
    if (open && !statusWasOpen.current) handleSelectUtilityPanel("status");
    statusWasOpen.current = open;
  }, [activeProps?.sessionStatusPanel?.open, handleSelectUtilityPanel]);
  useEffect(() => {
    const didLoseDesktopPanelRoom = desktopPanelsCouldCoexistRef.current && !desktopPanelsCanCoexist;
    desktopPanelsCouldCoexistRef.current = desktopPanelsCanCoexist;
    if (!railDrawerLayout && didLoseDesktopPanelRoom && railOpen && dockOpen) {
      closeSessionRail(false);
    }
  }, [closeSessionRail, desktopPanelsCanCoexist, dockOpen, railDrawerLayout, railOpen]);
  useEffect(() => {
    if (!railOpen || embeddedRail) {
      return;
    }
    queueMicrotask(() => {
      railCloseButtonRef.current?.focus();
    });
  }, [railOpen, embeddedRail]);
  useEffect(() => {
    if (
      embeddedRail ||
      !railOpen ||
      typeof document === "undefined" ||
      typeof document.addEventListener !== "function"
    ) {
      return undefined;
    }
    const eventTarget = document;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !panelOwnsActiveFocus(railPanelRef.current, document.activeElement)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeSessionRail();
    };
    eventTarget.addEventListener("keydown", handleKeyDown);
    return () => eventTarget.removeEventListener("keydown", handleKeyDown);
  }, [closeSessionRail, railOpen, embeddedRail]);
  useEffect(() => {
    if (!dockOpen) {
      return;
    }
    queueMicrotask(() => {
      contextPanelRef.current?.focus();
    });
  }, [activeUtilityPanel, dockOpen]);
  useEffect(() => {
    if (!dockOpen || typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return undefined;
    }
    const eventTarget = document;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !panelOwnsActiveFocus(contextPanelRef.current, document.activeElement)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleDockOpenChange(false);
    };
    eventTarget.addEventListener("keydown", handleKeyDown);
    return () => eventTarget.removeEventListener("keydown", handleKeyDown);
  }, [dockOpen, handleDockOpenChange]);
  useEffect(() => {
    const modalPanel =
      railDrawerLayout && railOpen
        ? railPanelRef.current
        : railDrawerLayout && dockOpen
          ? contextPanelRef.current
          : null;
    if (!modalPanel || typeof document === "undefined") {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeDialog = (document.activeElement as HTMLElement | null)?.closest?.(
        '[role="dialog"][aria-modal="true"]',
      );
      if (event.key !== "Tab" || event.defaultPrevented || (activeDialog && activeDialog !== modalPanel)) {
        return;
      }
      const nextFocus = resolveDrawerTabTarget({
        activeElement: document.activeElement,
        focusable: getDrawerFocusableElements(modalPanel),
        modalPanel,
        shiftKey: event.shiftKey,
      });
      if (nextFocus) {
        event.preventDefault();
        nextFocus.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [dockOpen, railDrawerLayout, railOpen]);

  return (
    <div
      className={`mc-next-threaded-surface unified${!embeddedRail && !railDrawerLayout && railOpen ? " session-rail-open" : ""}`}
      data-mode={surface}
      data-active-mode={activeMode}
      data-area={surface}
      data-surface-intent={MODE_META.chat.posture}
      style={rootStyle}
    >
      <button
        type="button"
        className={`mc-next-threaded-scrim${railDrawerOpen ? " open" : ""}`}
        aria-label="Dismiss session rail"
        aria-hidden={!railDrawerOpen}
        tabIndex={-1}
        onClick={() => closeSessionRail()}
      />
      <button
        type="button"
        className={`mc-next-threaded-context-scrim${railDrawerLayout && dockOpen ? " open" : ""}`}
        aria-label="Dismiss Activity"
        aria-hidden={!(railDrawerLayout && dockOpen)}
        tabIndex={-1}
        onClick={() => handleDockOpenChange(false)}
      />
      {activeProps && !dockOpen ? <div id="mc-next-threaded-context-panel" hidden aria-hidden="true" /> : null}
      {detailLeave.dialog}

      <ThreadedSessionRail
        input={input}
        railPanelRef={railPanelRef}
        railCloseButtonRef={railCloseButtonRef}
        railDrawerOpen={railDrawerOpen}
        embeddedRail={embeddedRail}
        railDrawerLayout={railDrawerLayout}
        railOpen={railOpen}
        closeSessionRail={closeSessionRail}
        handleCreateSessionFromRail={handleCreateSessionFromRail}
        handleArchiveWorkspace={handleArchiveWorkspace}
        missionSessionGroups={missionSessionGroups}
        externalSessionGroups={externalSessionGroups}
        onSelectMissionSession={(...args) =>
          detailLeave.request(() => {
            input.sessionRail.onSelectSession(...args);
            if (sidebar?.mobile) sidebar.close();
          })
        }
        onSelectExternalSession={(...args) =>
          detailLeave.request(() => {
            input.sessionRail.onSelectSession(...args);
            if (sidebar?.mobile) sidebar.close();
          })
        }
      />

      {!embeddedRail && !railDrawerLayout && railOpen ? (
        <PaneResizeHandle
          ariaLabel="Resize session rail"
          className="rail"
          dragging={railPane.dragging}
          maxWidth={PANE_WIDTHS.rail.max}
          minWidth={PANE_WIDTHS.rail.min}
          onDoubleClick={railPane.reset}
          onKeyDown={railPane.handleKeyDown}
          onPointerDown={railPane.handlePointerDown}
          width={railPane.width}
        />
      ) : null}

      <section
        aria-label={MODE_META[activeMode].stageLabel}
        className={stageLayoutClass}
        data-stage-posture={MODE_META[activeMode].posture}
        style={stageStyle}
      >
        <div className="mc-next-threaded-primary-column">
          <input
            ref={input.dropTargetProps.fileInputRef}
            type="file"
            multiple
            aria-label="Upload files"
            className="mc-next-hidden-file"
            onChange={(event) => input.dropTargetProps.onUploadFiles(event.target.files)}
          />
          <div className="mc-next-threaded-mobile-bar">
            <button
              type="button"
              className="mc-next-threaded-menu-button"
              onClick={openSessionRail}
              aria-controls="mc-next-threaded-session-rail"
              aria-expanded={railOpen}
            >
              <Menu size={16} />
              <span>Threads</span>
            </button>
            {workflowPanel?.kind === "code" ? (
              <button type="button" className="mc-next-threaded-menu-button" onClick={handleToggleBuildEditor}>
                <Code2 size={16} />
                <span>{codeWorkbenchOpen ? "Hide build editor" : "Build editor"}</span>
              </button>
            ) : null}
            {activeProps ? (
              <button
                type="button"
                className="mc-next-threaded-menu-button"
                onClick={handleToggleActivity}
                aria-controls="mc-next-threaded-context-panel"
                aria-expanded={dockOpen}
              >
                <PanelRight size={16} />
                <span>{dockOpen ? "Hide activity" : "Activity"}</span>
              </button>
            ) : null}
          </div>

          {activeProps ? (
            <ThreadConversationSurface
              surface={activeProps.mode}
              props={activeProps}
              dropTarget={input.dropTargetProps}
              dockOpen={dockOpen}
              railOpen={railOpen}
              changePlanReceipt={input.changePlanReceipt}
              onReviewChangePlan={input.onReviewChangePlan}
              onToggleSessionRail={() => (railOpen ? closeSessionRail() : openSessionRail())}
              onToggleActivity={handleToggleActivity}
              onOpenActivity={(turnId) => {
                if (turnId) {
                  activeProps.onSelectTurn(turnId);
                }
                handleSelectUtilityPanel("preview");
              }}
              permissionState={permissionState}
              onOpenUniversalRunDetail={onOpenUniversalRunDetail}
            />
          ) : (
            <ThreadEmptyState
              surface={surface}
              helper={modeMeta.helper}
              input={input}
              dropTarget={input.dropTargetProps}
            />
          )}
        </div>

        {workflowPanelOpen && workflowPanel ? (
          <aside className={`mc-next-threaded-side-panel ${workflowPanel.kind}`}>
            <PaneResizeHandle
              ariaLabel={`Resize ${workflowPanel.kind === "code" ? "build workbench" : "planning panel"}`}
              className="panel"
              dragging={workbenchPane.dragging}
              maxWidth={PANE_WIDTHS.workbench.max}
              minWidth={PANE_WIDTHS.workbench.min}
              onDoubleClick={workbenchPane.reset}
              onKeyDown={workbenchPane.handleKeyDown}
              onPointerDown={workbenchPane.handlePointerDown}
              width={workbenchPane.width}
            />
            <Suspense fallback={<div className="mc-next-threaded-panel-loading">Loading workflow panel...</div>}>
              <LazyThreadedWorkflowPanel panel={workflowPanel} />
            </Suspense>
          </aside>
        ) : null}

        {dockOpen ? (
          <aside
            id="mc-next-threaded-context-panel"
            ref={contextPanelRef}
            className={`mc-next-threaded-context-panel${activeUtilityPanel ? " utility" : ""}`}
            role={railDrawerLayout ? "dialog" : "complementary"}
            aria-label={activeUtilityPanel ? "Thread utility drawer" : "Thread context drawer"}
            aria-modal={railDrawerLayout ? true : undefined}
            tabIndex={-1}
          >
            {!railDrawerLayout ? (
              <PaneResizeHandle
                ariaLabel="Resize right drawer"
                className="panel"
                dragging={contextPane.dragging}
                maxWidth={PANE_WIDTHS.context.max}
                minWidth={PANE_WIDTHS.context.min}
                onDoubleClick={contextPane.reset}
                onKeyDown={contextPane.handleKeyDown}
                onPointerDown={contextPane.handlePointerDown}
                width={contextPane.width}
              />
            ) : null}
            {!activeUtilityPanel ? (
              <div className="mc-next-threaded-context-close-row">
                <button
                  type="button"
                  className="mc-next-threaded-menu-button"
                  onClick={() => handleDockOpenChange(false)}
                >
                  Close
                </button>
              </div>
            ) : null}
            {activeUtilityPanel && activeProps ? (
              <ThreadedUtilityPanel
                pinned={inspectorPinned}
                onTogglePinned={() => setInspectorPinned((value) => !value)}
                activePanel={activeUtilityPanel}
                activeProps={activeProps}
                contextDockProps={input.contextDockProps}
                onClose={() => handleDockOpenChange(false)}
                onOpenUniversalRunDetail={onOpenUniversalRunDetail}
                onOpenTasks={input.emptyStateProps?.onOpenTasks}
                onSelectPanel={handleSelectUtilityPanel}
                onSelectSession={(...args) => detailLeave.request(() => input.sessionRail.onSelectSession(...args))}
                changePlans={input.changePlans}
                onOpenBuildEditor={workflowPanel?.kind === "code" ? openBuildEditor : undefined}
                surface={activeMode}
                workflowPanel={workflowPanel}
              />
            ) : input.contextDockProps ? (
              <ThreadedContextDrawer
                surface={activeMode}
                props={input.contextDockProps}
                permissionSummary={formatThreadedPermissionSummary(permissionState)}
                permissionOverrideActive={Boolean(permissionState?.localOperatorOverrideId)}
                onCopyTrustReport={onCopyTrustReport}
              />
            ) : (
              <p>Context evidence is unavailable.</p>
            )}
          </aside>
        ) : null}
      </section>

      <ConfirmModal
        open={archiveConfirmOpen}
        title="Archive workspace chats?"
        message={archiveWorkspaceMessage}
        confirmLabel="Archive workspace chats"
        danger
        pending={input.sessionRail.archiveWorkspacePending}
        cancelDisabled={input.sessionRail.archiveWorkspacePending}
        disableDismiss={input.sessionRail.archiveWorkspacePending}
        onCancel={() => setArchiveConfirmOpen(false)}
        onConfirm={handleArchiveWorkspaceConfirmed}
      />
      <ThreadedBtwSideChatPanel sideChat={input.btwSideChatProps} />
    </div>
  );
}
