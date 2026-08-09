/* eslint-disable max-lines -- ThreadedSurfacePage coordinates the chat layout, composer chrome, timeline, drawer, and workflow panels while decomposition lands (plan W3.1 in local decomposition notes). */
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileDiff,
  FileText,
  Folder,
  FolderPlus,
  ListChecks,
  Menu,
  MessageSquareText,
  PanelRight,
  Play,
  Search,
  Terminal,
  Workflow,
} from "lucide-react";
import type { ChatMode, ChatSessionRecord, ChatSessionSearchHitRecord } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedDropTargetProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { groupDelegatedSessionsForRail } from "@goatcitadel/threaded-surface-core";
import { buildThreadedSessionStatusSummary } from "@goatcitadel/threaded-surface-core/work-trust";
import { StatusChip } from "../native-routes/primitives";
import { ChatModelPicker } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { ChatExecutionPlanSummary } from "@goatcitadel/mission-control-shared/components/chat/ChatExecutionPlanSummary";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@goatcitadel/mission-control-shared/components/ui";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { ThreadedComposer, computeUsageTotals, formatCostLabel, formatTokenLabel } from "./ThreadedComposer";
import { ChatSessionStatusPanel } from "./ChatSessionStatusPanel";
import { ChatTimerPanel } from "./ChatTimerPanel";
import { RunVariablePanel } from "./RunVariablePanel";
import { SessionControlBanner } from "./SessionControlBanner";
import { ThreadedBtwSideChatPanel } from "./ThreadedBtwSideChatPanel";
import { ThreadedContextDrawer } from "./ThreadedContextDrawer";
import { ThreadedModeControl } from "./ThreadedModeControl";
import { ThreadedTimeline } from "./ThreadedTimeline";
import { DurableBackgroundTaskRail } from "./DurableBackgroundTaskRail";
import { shortId } from "./workflow/format";
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

const LazyThreadedWorkflowPanel = lazy(async () => {
  const module = await import("./ThreadedWorkflowPanel");
  return { default: module.ThreadedWorkflowPanel };
});

const MODE_META: Record<
  ChatMode,
  { label: string; icon: typeof MessageSquareText; helper: string; posture: string; stageLabel: string }
> = {
  chat: {
    label: "Chat",
    icon: MessageSquareText,
    helper: "Conversation, attachments, planning, tools, approvals, and source context in one place.",
    posture: "chat",
    stageLabel: "Chat workspace stage",
  },
  cowork: {
    label: "Chat",
    icon: Workflow,
    helper: "Legacy planning posture now resolves into Chat.",
    posture: "chat",
    stageLabel: "Chat workspace stage",
  },
  code: {
    label: "Chat",
    icon: Code2,
    helper: "Legacy build posture now resolves into Chat with governed code capabilities.",
    posture: "chat",
    stageLabel: "Chat workspace stage",
  },
};

type EmptyStateGuidance = {
  title: string;
  body: string;
  startLabel: string;
  startHereLabel: string;
  cards: Array<{ title: string; body: string }>;
};

const EMPTY_STATE_GUIDANCE: Record<ChatMode, EmptyStateGuidance> = {
  chat: {
    title: "Start with the first useful move",
    body: "Ask directly, attach context, or open Start Here when this workspace still needs its first chat.",
    startLabel: "Start chat",
    startHereLabel: "Open Start Here",
    cards: [
      { title: "Fast answer", body: "Draft, compare, summarize, or ask a short question." },
      { title: "Guided setup", body: "Use the sample mission when provider, workspace, or memory context is unclear." },
      {
        title: "Escalate",
        body: "Ask for a plan, use tools, or add source context in the same chat when the work needs structure.",
      },
    ],
  },
  cowork: {
    title: "Set up supervised work",
    body: "Turn a goal into a visible plan with task lanes, approvals, checkpoints, and delegated follow-through.",
    startLabel: "Start plan",
    startHereLabel: "Use Start Here mission",
    cards: [
      { title: "Plan", body: "Frame the work before durable steps begin." },
      { title: "Task board", body: "Track delegation, retries, blockers, and checkpoints." },
      { title: "Approvals", body: "Review human-gated decisions before the run advances." },
    ],
  },
  code: {
    title: "Prepare a governed code pass",
    body: "Bind source context, review diffs, run validation, and keep Code Mode proof visible before handoff.",
    startLabel: "Start build",
    startHereLabel: "Use Start Here mission",
    cards: [
      { title: "Source", body: "Attach files or start from a project-bound thread." },
      { title: "Diffs", body: "Keep implementation changes reviewable in the workbench." },
      { title: "Proof", body: "Pair approvals, artifacts, and validation with the final code pass." },
    ],
  },
};

type ThreadedUtilityPanelId = "preview" | "diff" | "terminal" | "files" | "background" | "plan";
type ThreadedUtilityPanelMeta = { id: ThreadedUtilityPanelId; label: string; icon: typeof PanelRight };

const UTILITY_PANEL_ITEMS: ThreadedUtilityPanelMeta[] = [
  { id: "preview", label: "Work Record", icon: Play },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "terminal", label: "Run log", icon: Terminal },
  { id: "files", label: "Files", icon: Folder },
  { id: "background", label: "Background tasks", icon: Eye },
  { id: "plan", label: "Plan", icon: ListChecks },
];

const PANE_WIDTHS = {
  rail: { initial: 216, min: 184, max: 360 },
  workbench: { initial: 560, min: 320, max: 840 },
  context: { initial: 268, min: 244, max: 420 },
};

export interface ThreadedPermissionState {
  loading?: boolean;
  error?: string;
  profileId?: string;
  profileLabel?: string;
  approvalMode?: string;
  localOperatorOverrideId?: string;
  overrideExpiresAt?: string;
}

export function formatThreadedPermissionSummary(state?: ThreadedPermissionState): string {
  if (!state || state.loading) {
    return "Policy loading";
  }
  if (state.error) {
    return "Policy unavailable";
  }
  const profile = state.profileLabel ?? state.profileId ?? "Safe";
  const details = [formatThreadedApprovalMode(state.approvalMode)].filter(Boolean);
  if (state.localOperatorOverrideId) {
    details.push(
      state.overrideExpiresAt
        ? `override until ${formatThreadedOverrideExpiry(state.overrideExpiresAt)}`
        : "local override active",
    );
  }
  return `Policy: ${[profile, ...details].join(" · ")}`;
}

export function formatThreadedApprovalMode(value?: string): string | undefined {
  switch (value) {
    case "approve_all":
      return "asks every time";
    case "approve_risky":
      return "asks on risk";
    case "bypass":
      return "skips normal prompts";
    default:
      return value;
  }
}

export function formatThreadedOverrideExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return `${new Date(timestamp).toISOString().slice(11, 16)} UTC`;
}

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
  const railDrawerLayout = useMediaQuery("(width < 1180px)");
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
  const railOpen = input.sessionRailOpen;
  const railDrawerOpen = railDrawerLayout && railOpen;
  const railCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const railFocusReturnRef = useRef<HTMLElement | null>(null);
  const contextPanelRef = useRef<HTMLElement | null>(null);
  const contextFocusReturnRef = useRef<HTMLElement | null>(null);
  const activeProps = input.activeSessionSurfaceProps;
  const [activeUtilityPanel, setActiveUtilityPanel] = useState<ThreadedUtilityPanelId | null>(null);
  const dockOpen = Boolean((input.dockOpen || activeUtilityPanel) && activeProps);
  const workflowPanel = input.workflowPanel;
  const activeMode: ChatMode = "chat";
  const modeMeta = MODE_META[activeMode];
  const [codeWorkbenchOpen, setCodeWorkbenchOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const workflowPanelOpen = Boolean(workflowPanel && (workflowPanel.kind !== "code" || codeWorkbenchOpen));
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
    (next: boolean) => {
      if (next && !dockOpen) {
        captureContextFocusReturn();
      }
      if (!next) {
        restoreContextFocusReturn();
      }
      setActiveUtilityPanel(null);
      input.onDockOpenChange(next);
    },
    [captureContextFocusReturn, dockOpen, input, restoreContextFocusReturn],
  );
  const handleSelectUtilityPanel = useCallback(
    (panel: ThreadedUtilityPanelId) => {
      if (!dockOpen) {
        captureContextFocusReturn();
      }
      setActiveUtilityPanel(panel);
      input.onDockOpenChange(true);
    },
    [captureContextFocusReturn, dockOpen, input],
  );
  const closeSessionRail = useCallback(() => {
    input.onSessionRailOpenChange(false);
    if (!railDrawerLayout) {
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
  }, [input, railDrawerLayout]);
  const openSessionRail = useCallback(() => {
    if (
      railDrawerLayout &&
      typeof document !== "undefined" &&
      typeof HTMLElement !== "undefined" &&
      document.activeElement instanceof HTMLElement
    ) {
      railFocusReturnRef.current = document.activeElement;
    }
    input.onSessionRailOpenChange(true);
  }, [input, railDrawerLayout]);
  const handleCreateSessionFromRail = useCallback(() => {
    input.sessionRail.onCreateSession();
    if (railDrawerLayout) {
      closeSessionRail();
    }
  }, [closeSessionRail, input.sessionRail, railDrawerLayout]);
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
    if (!railDrawerOpen) {
      return;
    }
    queueMicrotask(() => {
      railCloseButtonRef.current?.focus();
    });
  }, [railDrawerOpen]);
  useEffect(() => {
    if (!railDrawerOpen || typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return undefined;
    }
    const eventTarget = document;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeSessionRail();
    };
    eventTarget.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => eventTarget.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [closeSessionRail, railDrawerOpen]);
  useEffect(() => {
    if (!dockOpen) {
      return;
    }
    queueMicrotask(() => {
      contextPanelRef.current?.focus();
    });
  }, [activeUtilityPanel, dockOpen]);
  useEffect(() => {
    if (
      !dockOpen ||
      railDrawerOpen ||
      typeof document === "undefined" ||
      typeof document.addEventListener !== "function"
    ) {
      return undefined;
    }
    const eventTarget = document;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleDockOpenChange(false);
    };
    eventTarget.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => eventTarget.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [dockOpen, handleDockOpenChange, railDrawerOpen]);

  return (
    <div
      className="mc-next-threaded-surface unified"
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
        tabIndex={railDrawerOpen ? 0 : -1}
        onClick={closeSessionRail}
      />

      <aside
        id="mc-next-threaded-session-rail"
        className={`mc-next-threaded-rail${railDrawerOpen ? " open" : ""}`}
        aria-label="Sessions"
        aria-hidden={railDrawerLayout && !railOpen}
        inert={railDrawerLayout && !railOpen}
      >
        <div className="mc-next-threaded-rail-head">
          <div>
            <p>Sessions</p>
            <h2>{input.sessionRail.summaryTitle}</h2>
            <span>Conversation, planning, and build threads stay connected by project.</span>
          </div>
          <button
            ref={railCloseButtonRef}
            type="button"
            className="mc-next-threaded-menu-button"
            onClick={closeSessionRail}
            aria-label="Close session rail"
          >
            <PanelRight size={16} />
          </button>
        </div>

        <div className="mc-next-threaded-rail-actions">
          <button type="button" className="mc-next-threaded-primary" onClick={handleCreateSessionFromRail}>
            <MessageSquareText size={16} />
            <span>New thread</span>
          </button>
          <button
            type="button"
            className={`mc-next-threaded-secondary${input.sessionRail.showProjectCreate ? " active" : ""}`}
            onClick={input.sessionRail.onToggleProjectCreate}
            aria-label={input.sessionRail.showProjectCreate ? "Hide project form" : "Create project"}
          >
            <FolderPlus size={15} />
            <span>{input.sessionRail.showProjectCreate ? "Hide project" : "Project"}</span>
          </button>
        </div>

        <label className="mc-next-threaded-search">
          <Search size={15} />
          <input
            value={input.sessionRail.search}
            onChange={(event) => input.sessionRail.onSearchChange(event.target.value)}
            placeholder="Search threads"
          />
        </label>

        <div className="mc-next-threaded-filters secondary">
          <FilterChip
            active={input.sessionRail.historyView === "active"}
            onClick={() => input.sessionRail.onHistoryViewChange("active")}
          >
            Active
          </FilterChip>
          <FilterChip
            active={input.sessionRail.historyView === "archived"}
            onClick={() => input.sessionRail.onHistoryViewChange("archived")}
          >
            Archived
          </FilterChip>
          <FilterChip
            active={input.sessionRail.selectedProjectId === "all"}
            onClick={() => input.sessionRail.onSelectProjectId("all")}
          >
            All projects
          </FilterChip>
          <FilterChip
            active={input.sessionRail.selectedProjectId === "none"}
            onClick={() => input.sessionRail.onSelectProjectId("none")}
          >
            Unassigned
          </FilterChip>
        </div>

        {input.sessionRail.availableFolders.length > 0 || input.sessionRail.selectedTag ? (
          <div className="mc-next-threaded-folder-row">
            <FilterChip
              active={input.sessionRail.selectedFolderId === "all"}
              onClick={() => input.sessionRail.onSelectFolderId("all")}
            >
              All folders
            </FilterChip>
            <FilterChip
              active={input.sessionRail.selectedFolderId === "none"}
              onClick={() => input.sessionRail.onSelectFolderId("none")}
            >
              No folder
            </FilterChip>
            {input.sessionRail.availableFolders.map((folder) => (
              <FilterChip
                key={folder.folderId}
                active={input.sessionRail.selectedFolderId === folder.folderId}
                onClick={() => input.sessionRail.onSelectFolderId(folder.folderId)}
              >
                {folder.name} · {folder.count}
              </FilterChip>
            ))}
            {input.sessionRail.selectedTag ? (
              <FilterChip active onClick={() => input.sessionRail.onSelectTag(null)}>
                #{input.sessionRail.selectedTag}
              </FilterChip>
            ) : null}
          </div>
        ) : null}

        {input.sessionRail.showProjectCreate ? (
          <section className="mc-next-threaded-project-card">
            <h3>Project</h3>
            <input
              value={input.sessionRail.projectName}
              onChange={(event) => input.sessionRail.onProjectNameChange(event.target.value)}
              placeholder="Project name"
            />
            <input
              value={input.sessionRail.projectPath}
              onChange={(event) => input.sessionRail.onProjectPathChange(event.target.value)}
              placeholder="Project path (optional)"
            />
            <button type="button" className="mc-next-threaded-primary" onClick={input.sessionRail.onCreateProject}>
              Create project
            </button>
          </section>
        ) : null}

        {input.sessionRail.archiveWorkspaceEnabled && input.sessionRail.onConfirmArchiveWorkspace ? (
          <button
            type="button"
            className="mc-next-threaded-archive"
            disabled={input.sessionRail.archiveWorkspacePending}
            onClick={handleArchiveWorkspace}
          >
            {input.sessionRail.archiveWorkspacePending ? "Archiving..." : "Archive workspace threads"}
          </button>
        ) : null}

        <SessionGroup
          title="Recent threads"
          items={missionSessionGroups.topLevelSessions}
          count={missionSessionGroups.topLevelSessions.length}
          selectedSessionId={input.sessionRail.selectedSessionId}
          onSelectSession={input.sessionRail.onSelectSession}
          renderSessionLabel={input.sessionRail.renderSessionLabel}
          nestedChildrenByParentId={missionSessionGroups.delegatedChildrenByParentId}
          orphanDelegatedItems={missionSessionGroups.orphanDelegatedSessions}
        />
        <SessionGroup
          title="External bindings"
          items={externalSessionGroups.topLevelSessions}
          count={externalSessionGroups.topLevelSessions.length}
          selectedSessionId={input.sessionRail.selectedSessionId}
          onSelectSession={input.sessionRail.onSelectSession}
          renderSessionLabel={input.sessionRail.renderSessionLabel}
          nestedChildrenByParentId={externalSessionGroups.delegatedChildrenByParentId}
          orphanDelegatedItems={externalSessionGroups.orphanDelegatedSessions}
          emptyCopy="External bindings show up here when a thread is linked out."
        />
      </aside>

      {!railDrawerLayout ? (
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
              aria-expanded={railDrawerOpen}
            >
              <Menu size={16} />
              <span>Sessions</span>
            </button>
            {workflowPanel?.kind === "code" ? (
              <button
                type="button"
                className="mc-next-threaded-menu-button"
                onClick={() => setCodeWorkbenchOpen((current) => !current)}
              >
                <Code2 size={16} />
                <span>{codeWorkbenchOpen ? "Hide build editor" : "Build editor"}</span>
              </button>
            ) : null}
            {activeProps ? (
              <button
                type="button"
                className="mc-next-threaded-menu-button"
                onClick={() => handleDockOpenChange(!dockOpen)}
              >
                <PanelRight size={16} />
                <span>{dockOpen ? "Hide context" : "Context"}</span>
              </button>
            ) : null}
          </div>

          {activeProps ? (
            <ThreadConversationSurface
              surface={activeProps.mode}
              props={activeProps}
              dropTarget={input.dropTargetProps}
              dockOpen={dockOpen}
              activeUtilityPanel={activeUtilityPanel}
              onToggleDock={() => handleDockOpenChange(!dockOpen)}
              onSelectUtilityPanel={handleSelectUtilityPanel}
              codeWorkbenchOpen={codeWorkbenchOpen}
              onToggleCodeWorkbench={
                workflowPanel?.kind === "code" ? () => setCodeWorkbenchOpen((current) => !current) : undefined
              }
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

        {dockOpen && input.contextDockProps ? (
          <aside
            id="mc-next-threaded-context-panel"
            ref={contextPanelRef}
            className={`mc-next-threaded-context-panel${activeUtilityPanel ? " utility" : ""}`}
            role="complementary"
            aria-label={activeUtilityPanel ? "Thread utility drawer" : "Thread context drawer"}
            tabIndex={-1}
          >
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
            {activeUtilityPanel && activeProps ? (
              <ThreadedUtilityPanel
                activePanel={activeUtilityPanel}
                activeProps={activeProps}
                contextDockProps={input.contextDockProps}
                onClose={() => handleDockOpenChange(false)}
                onOpenUniversalRunDetail={onOpenUniversalRunDetail}
                onOpenTasks={input.emptyStateProps?.onOpenTasks}
                onSelectPanel={setActiveUtilityPanel}
                onSelectSession={input.sessionRail.onSelectSession}
                surface={activeMode}
                workflowPanel={workflowPanel}
              />
            ) : (
              <ThreadedContextDrawer
                surface={activeMode}
                props={input.contextDockProps}
                permissionSummary={formatThreadedPermissionSummary(permissionState)}
                permissionOverrideActive={Boolean(permissionState?.localOperatorOverrideId)}
                onCopyTrustReport={onCopyTrustReport}
              />
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

function ThreadConversationSurface({
  // `surface` is part of the typed prop contract but not consumed here; don't destructure it.
  props,
  dropTarget,
  dockOpen,
  activeUtilityPanel,
  onToggleDock,
  onSelectUtilityPanel,
  codeWorkbenchOpen,
  onToggleCodeWorkbench,
  permissionState,
  onOpenUniversalRunDetail,
}: {
  surface: ChatMode;
  props: MissionThreadedActiveSessionSurfaceProps;
  dropTarget: MissionThreadedDropTargetProps;
  dockOpen: boolean;
  activeUtilityPanel: ThreadedUtilityPanelId | null;
  onToggleDock: () => void;
  onSelectUtilityPanel: (panel: ThreadedUtilityPanelId) => void;
  codeWorkbenchOpen: boolean;
  onToggleCodeWorkbench?: () => void;
  permissionState?: ThreadedPermissionState;
  onOpenUniversalRunDetail?: (runId: string) => void;
}) {
  const compactArtifactSheet = useMediaQuery("(max-width: 840px)");
  const approvalSignalText = `${props.trust.approvalsSummary} ${props.trust.runStateSummary ?? ""}`.toLowerCase();
  const approvalsAreBlocking =
    props.approvalsCount > 0 &&
    (approvalSignalText.includes("approval") ||
      approvalSignalText.includes("pending") ||
      approvalSignalText.includes("waiting"));
  const permissionSummary = formatThreadedPermissionSummary(permissionState);
  const headerStatus = buildThreadedSessionStatusSummary({
    trust: props.trust,
    policySummary: permissionSummary,
    policyOverrideActive: Boolean(permissionState?.localOperatorOverrideId),
  });
  const usageTotals = computeUsageTotals(props.thread);
  const routeSelectionSummary = props.routePreflight?.selectionSource
    ? `Selection: ${props.routePreflight.selectionSource}`
    : (props.trust.selectionSourceSummary ?? "Route pending");

  return (
    <div
      className={`mc-next-threaded-dropzone${dropTarget.isDragActive ? " drop-active" : ""}`}
      onDragEnter={dropTarget.onDragEnter}
      onDragOver={dropTarget.onDragOver}
      onDragLeave={dropTarget.onDragLeave}
      onDrop={dropTarget.onDrop}
    >
      {dropTarget.isDragActive ? (
        <div className="mc-next-threaded-drop-overlay">Drop files to attach to this thread</div>
      ) : null}
      <header className="mc-next-threaded-header">
        <div className="mc-next-threaded-header-copy">
          <ThreadedModeControl
            mode={props.modeOverridePending ?? (props.autoRouteActive ? undefined : props.mode)}
            preview={props.surfaceRoutePreview}
            onOverride={props.onModeOverride}
            variant="compact"
          />
          <div className="mc-next-threaded-title-block">
            <span className="mc-next-threaded-title-kicker">Operator thread</span>
            <h1>{props.sessionTitle}</h1>
          </div>
          <span>{props.summary}</span>
        </div>

        <div className="mc-next-threaded-header-meta">
          <div className="mc-next-threaded-chip-row">
            <StatusChip
              tone="muted"
              title="Active provider and model for this session"
              ariaLabel={`Model: ${headerStatus.providerModelSummary}`}
            >
              {headerStatus.providerModelSummary}
            </StatusChip>
            <StatusChip tone="muted" title="Route selection source" ariaLabel={`Route: ${routeSelectionSummary}`}>
              {routeSelectionSummary}
            </StatusChip>
            <StatusChip
              tone={props.trust.runtimeTone ?? "muted"}
              title="Session runtime and active run state"
              ariaLabel={`Runtime: ${headerStatus.runtimeRunSummary}`}
            >
              {headerStatus.runtimeRunSummary}
            </StatusChip>
            <StatusChip
              tone="muted"
              title="Pending tool and risk approvals waiting on you"
              ariaLabel={`Approvals: ${headerStatus.approvalsSummary}`}
            >
              {headerStatus.approvalsSummary}
            </StatusChip>
            <StatusChip
              tone={permissionState?.localOperatorOverrideId ? "warning" : "muted"}
              title="Session policy posture"
              ariaLabel={`Policy: ${headerStatus.compactPolicySummary}`}
            >
              {headerStatus.compactPolicySummary}
            </StatusChip>
            <details className="mc-next-threaded-runtime-detail">
              <summary>Runtime detail</summary>
              <div>
                <span aria-label={`Tokens: ${formatTokenLabel(usageTotals.tokens)}`}>
                  Tokens {formatTokenLabel(usageTotals.tokens)}
                </span>
                <span aria-label={`Cost: ${formatCostLabel(usageTotals.costUsd)}`}>
                  Estimated cost {formatCostLabel(usageTotals.costUsd)}
                </span>
                <span>{headerStatus.providerModelSummary}</span>
                <span>{routeSelectionSummary}</span>
              </div>
            </details>
          </div>
        </div>

        <div className="mc-next-threaded-header-actions">
          <div className="mc-next-threaded-model-picker">
            <ChatModelPicker
              providers={props.providerOptions}
              providerId={props.selectedProviderId}
              model={props.selectedModel}
              disabled={props.modelSwitchDisabled}
              onChangeProvider={props.onRequestProviderChange}
              onChangeModel={props.onRequestModelChange}
            />
          </div>
          <div className="mc-next-threaded-panel-switcher-row">
            <ThreadedPanelSwitcher activePanel={activeUtilityPanel} onSelectPanel={onSelectUtilityPanel} />
          </div>
          <div className={`mc-next-threaded-action-row${approvalsAreBlocking ? " has-priority-approval" : ""}`}>
            <button
              type="button"
              className="mc-next-threaded-secondary mc-next-threaded-work-record"
              aria-controls="mc-next-threaded-context-panel"
              aria-expanded={Boolean(dockOpen && activeUtilityPanel === "preview")}
              onClick={() => onSelectUtilityPanel("preview")}
            >
              Work Record
            </button>
            {onToggleCodeWorkbench ? (
              <button
                type="button"
                className="mc-next-threaded-secondary mc-next-threaded-build-editor"
                onClick={onToggleCodeWorkbench}
              >
                {codeWorkbenchOpen ? "Hide build editor" : "Build editor"}
              </button>
            ) : null}
            {props.onExportRunBundle ? (
              <button type="button" className="mc-next-threaded-secondary" onClick={props.onExportRunBundle}>
                Export run bundle
              </button>
            ) : null}
            {props.approvalsCount > 0 ? (
              <button
                type="button"
                className={`mc-next-threaded-approval-review ${
                  approvalsAreBlocking ? "mc-next-threaded-primary" : "mc-next-threaded-secondary"
                }`}
                onClick={() => props.onOpenApprovals()}
              >
                Approvals ({props.approvalsCount})
              </button>
            ) : null}
            <button
              type="button"
              className="mc-next-threaded-secondary"
              disabled={props.sessionArchivePending}
              onClick={props.onToggleArchiveSession}
            >
              {getArchiveActionLabel(props.sessionLifecycleStatus, props.sessionArchivePending)}
            </button>
            <button type="button" className="mc-next-threaded-secondary" onClick={onToggleDock}>
              {dockOpen ? "Hide context" : "Show context"}
            </button>
          </div>
        </div>
      </header>

      <section className="mc-next-threaded-conversation">
        {props.selectedTurn?.trace.executionPlan ? (
          <section
            className="mc-next-threaded-execution-overview"
            aria-label="Current execution plan"
            aria-live="polite"
          >
            <div className="mc-next-threaded-execution-overview-head">
              <div>
                <span>Governed execution</span>
                <strong>Current plan and progress</strong>
              </div>
              <StatusChip tone={approvalsAreBlocking ? "warning" : (props.trust.runtimeTone ?? "muted")}>
                {approvalsAreBlocking ? "Waiting for approval" : headerStatus.runtimeRunSummary}
              </StatusChip>
            </div>
            <ChatExecutionPlanSummary plan={props.selectedTurn.trace.executionPlan} />
          </section>
        ) : null}
        {props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError ? (
          <section className="mc-next-threaded-history-banner" aria-live="polite">
            <div>
              <strong>Viewing history around search result</strong>
              <span>Sending is paused until you return to the latest conversation.</span>
            </div>
            <button type="button" className="mc-next-threaded-secondary" onClick={props.onReturnToLatest}>
              Return to latest
            </button>
          </section>
        ) : null}
        {props.sessionControlBanner ? <SessionControlBanner {...props.sessionControlBanner} /> : null}
        {props.sessionStatusPanel ? <ChatSessionStatusPanel panel={props.sessionStatusPanel} /> : null}
        {props.chatTimerPanel ? <ChatTimerPanel panel={props.chatTimerPanel} /> : null}
        {props.runVariablePanel ? <RunVariablePanel panel={props.runVariablePanel} /> : null}
        <div className="mc-next-threaded-thread-card">
          {props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError ? (
            <HistoricalConversationView props={props} />
          ) : (
            <ThreadedTimeline props={props} onOpenUniversalRunDetail={onOpenUniversalRunDetail} />
          )}
        </div>
        <div className="mc-next-threaded-composer-card">
          {props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError ? (
            <p className="mc-next-threaded-history-send-lock" role="status">
              Return to latest before sending or editing this conversation.
            </p>
          ) : null}
          <ThreadedComposer props={props} />
        </div>
      </section>

      {compactArtifactSheet && props.activeGeneratedArtifact ? (
        <Sheet open onOpenChange={(nextOpen) => !nextOpen && props.onCloseGeneratedArtifact?.()}>
          <SheetContent side="bottom" className="generated-artifact-sheet">
            <SheetHeader>
              <SheetTitle>{props.activeGeneratedArtifact.title}</SheetTitle>
              <SheetDescription>
                Generated {props.activeGeneratedArtifact.kind} artifact from{" "}
                {props.activeGeneratedArtifact.sourceSurface}.
              </SheetDescription>
            </SheetHeader>
            <GeneratedArtifactViewer artifact={props.activeGeneratedArtifact} compact />
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function HistoricalConversationView({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  if (props.historicalWindowLoading) {
    return <div className="mc-next-threaded-history-state">Loading the exact historical message…</div>;
  }
  if (props.historicalWindowError) {
    return (
      <div className="mc-next-threaded-history-state error" role="alert">
        Historical message could not be loaded. {props.historicalWindowError}
      </div>
    );
  }
  const window = props.historicalWindow;
  if (!window) return null;
  if (window.anchor.state === "unavailable") {
    return (
      <div className="mc-next-threaded-history-state" role="status">
        This result is no longer available because the message was deleted or compacted.
      </div>
    );
  }
  if (window.anchor.state === "identity_mismatch") {
    return (
      <div className="mc-next-threaded-history-state error" role="alert">
        The result identity no longer matches this conversation. No newer message was substituted.
      </div>
    );
  }
  return (
    <div className="mc-next-threaded-history-list" aria-label="Historical conversation window">
      {window.hasOlder && window.olderCursor ? (
        <button
          type="button"
          className="mc-next-threaded-history-page-button"
          disabled={props.historicalContinuationLoading !== null}
          onClick={() => props.onLoadHistoricalContinuation("older")}
        >
          {props.historicalContinuationLoading === "older" ? "Loading older…" : "Load older messages"}
        </button>
      ) : null}
      {props.historicalContinuationError ? (
        <p className="mc-next-threaded-history-page-error" role="alert">
          {props.historicalContinuationError}
        </p>
      ) : null}
      {window.items.map((entry) => (
        <article
          key={`${entry.message.messageId}:${entry.sequence}`}
          className={`mc-next-threaded-history-message role-${entry.message.role}${entry.isAnchor ? " anchor" : ""}`}
          aria-current={entry.isAnchor ? "true" : undefined}
          aria-label={entry.isAnchor ? "Exact search result" : `${entry.message.role} historical message`}
        >
          <header>
            <strong>
              {entry.message.role === "assistant" ? "Assistant" : entry.message.role === "user" ? "You" : "System"}
            </strong>
            <time dateTime={entry.message.timestamp}>{formatRelativeTime(entry.message.timestamp)}</time>
          </header>
          {entry.isAnchor ? <span className="mc-next-threaded-history-anchor-label">Exact search result</span> : null}
          <p>{entry.message.content}</p>
        </article>
      ))}
      {window.hasNewer && window.newerCursor ? (
        <button
          type="button"
          className="mc-next-threaded-history-page-button"
          disabled={props.historicalContinuationLoading !== null}
          onClick={() => props.onLoadHistoricalContinuation("newer")}
        >
          {props.historicalContinuationLoading === "newer" ? "Loading newer…" : "Load newer messages"}
        </button>
      ) : null}
    </div>
  );
}

export function getArchiveActionLabel(lifecycleStatus: string, pending: boolean) {
  if (pending) return lifecycleStatus === "archived" ? "Restoring..." : "Archiving...";
  return lifecycleStatus === "archived" ? "Restore" : "Archive";
}

type CodeWorkflowPanel = Extract<NonNullable<MissionThreadedRenderSurfaceInput["workflowPanel"]>, { kind: "code" }>;

function clampPaneWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
}

function useHorizontalPaneResize({
  direction,
  initialWidth,
  maxWidth,
  minWidth,
}: {
  direction: "left" | "right";
  initialWidth: number;
  maxWidth: number;
  minWidth: number;
}) {
  const [width, setWidth] = useState(initialWidth);
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const resizeBy = useCallback(
    (delta: number) => {
      setWidth((current) => clampPaneWidth(current + delta, minWidth, maxWidth));
    },
    [maxWidth, minWidth],
  );

  const reset = useCallback(() => {
    setWidth(initialWidth);
  }, [initialWidth]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || typeof window === "undefined" || window.innerWidth < 1024) {
        return;
      }
      dragStateRef.current = {
        pointerId: event.pointerId,
        startWidth: width,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
      event.preventDefault();
    },
    [width],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizeBy(-24);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        resizeBy(24);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setWidth(minWidth);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setWidth(maxWidth);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        reset();
      }
    },
    [maxWidth, minWidth, reset, resizeBy],
  );

  useEffect(() => {
    if (!dragging || typeof window === "undefined") {
      return undefined;
    }
    const eventTarget = window;

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      const deltaX = event.clientX - dragState.startX;
      const directedDelta = direction === "right" ? deltaX : -deltaX;
      setWidth(clampPaneWidth(dragState.startWidth + directedDelta, minWidth, maxWidth));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      dragStateRef.current = null;
      setDragging(false);
    };

    eventTarget.addEventListener("pointermove", handlePointerMove);
    eventTarget.addEventListener("pointerup", handlePointerUp);
    eventTarget.addEventListener("pointercancel", handlePointerUp);
    return () => {
      eventTarget.removeEventListener("pointermove", handlePointerMove);
      eventTarget.removeEventListener("pointerup", handlePointerUp);
      eventTarget.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [direction, dragging, maxWidth, minWidth]);

  return {
    dragging,
    handleKeyDown,
    handlePointerDown,
    reset,
    width,
  };
}

function PaneResizeHandle({
  ariaLabel,
  className,
  dragging,
  maxWidth,
  minWidth,
  onDoubleClick,
  onKeyDown,
  onPointerDown,
  width,
}: {
  ariaLabel: string;
  className: string;
  dragging: boolean;
  maxWidth: number;
  minWidth: number;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  width: number;
}) {
  return (
    <button
      type="button"
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={maxWidth}
      aria-valuemin={minWidth}
      aria-valuenow={Math.round(width)}
      className={`mc-next-threaded-resize-handle ${className}${dragging ? " dragging" : ""}`}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      title="Drag to resize. Double-click to reset."
    />
  );
}

function ThreadedPanelSwitcher({
  activePanel,
  onSelectPanel,
}: {
  activePanel: ThreadedUtilityPanelId | null;
  onSelectPanel: (panel: ThreadedUtilityPanelId) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return undefined;
    }
    const eventTarget = document;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && menuRef.current && !menuRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    eventTarget.addEventListener("mousedown", handlePointerDown);
    eventTarget.addEventListener("keydown", handleKeyDown);
    return () => {
      eventTarget.removeEventListener("mousedown", handlePointerDown);
      eventTarget.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="mc-next-threaded-panel-switcher" ref={menuRef}>
      <button
        type="button"
        className={`mc-next-threaded-secondary mc-next-threaded-panel-trigger${activePanel ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open right panel menu"
        onClick={() => setOpen((current) => !current)}
      >
        <PanelRight size={14} />
        <span>Panels</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="mc-next-threaded-panel-menu" role="menu" aria-label="Right panel menu">
          {UTILITY_PANEL_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={activePanel === item.id}
                className={`mc-next-threaded-panel-menu-item${activePanel === item.id ? " active" : ""}`}
                onClick={() => {
                  onSelectPanel(item.id);
                  setOpen(false);
                }}
              >
                <Icon size={14} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ThreadedUtilityPanel({
  activePanel,
  activeProps,
  contextDockProps,
  onClose,
  onOpenUniversalRunDetail,
  onOpenTasks,
  onSelectPanel,
  onSelectSession,
  surface,
  workflowPanel,
}: {
  activePanel: ThreadedUtilityPanelId;
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  contextDockProps: MissionThreadedRenderSurfaceInput["contextDockProps"];
  onClose: () => void;
  onOpenUniversalRunDetail?: (runId: string) => void;
  onOpenTasks?: () => void;
  onSelectPanel: (panel: ThreadedUtilityPanelId) => void;
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
  surface: ChatMode;
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const meta = UTILITY_PANEL_ITEMS.find((item) => item.id === activePanel) ?? UTILITY_PANEL_ITEMS[0]!;

  return (
    <div className="mc-next-utility-panel" data-mode={surface} data-panel={activePanel}>
      <div className="mc-next-utility-panel-head">
        <div>
          <p className="mc-next-panel-kicker">Work Record</p>
          <h3>{meta.label}</h3>
        </div>
        <button type="button" className="mc-next-panel-button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="mc-next-utility-panel-tabs" role="group" aria-label="Right drawer panels">
        {UTILITY_PANEL_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={activePanel === item.id}
              className={`mc-next-utility-panel-tab${activePanel === item.id ? " active" : ""}`}
              onClick={() => onSelectPanel(item.id)}
            >
              <Icon size={14} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      {activePanel === "preview" ? (
        <UtilityPreviewPanel activeProps={activeProps} />
      ) : activePanel === "diff" ? (
        <UtilityDiffPanel workflowPanel={workflowPanel} />
      ) : activePanel === "terminal" ? (
        <UtilityTerminalPanel workflowPanel={workflowPanel} />
      ) : activePanel === "files" ? (
        <UtilityFilesPanel workflowPanel={workflowPanel} />
      ) : activePanel === "background" ? (
        <UtilityBackgroundTasksPanel
          activeProps={activeProps}
          onOpenUniversalRunDetail={onOpenUniversalRunDetail}
          onOpenTasks={onOpenTasks}
          onSelectSession={onSelectSession}
        />
      ) : (
        <UtilityPlanPanel activeProps={activeProps} contextDockProps={contextDockProps} />
      )}
    </div>
  );
}

function UtilityPreviewPanel({ activeProps }: { activeProps: MissionThreadedActiveSessionSurfaceProps }) {
  const selectedTurn = activeProps.selectedTurn;
  const assistantPreview = formatUtilitySnippet(selectedTurn?.assistantMessage?.content);
  const userPreview = formatUtilitySnippet(selectedTurn?.userMessage?.content);
  const toolRuns = selectedTurn?.toolRuns ?? [];
  const citations = selectedTurn?.citations ?? [];
  const generatedArtifacts = selectedTurn?.generatedArtifacts ?? [];
  const threadTurnCount = activeProps.thread?.turns.length ?? 0;
  const sessionLabel = activeProps.selectedSessionId ? shortId(activeProps.selectedSessionId) : "New thread";

  if (activeProps.activeGeneratedArtifact) {
    return (
      <section className="mc-next-utility-card mc-next-work-record-card">
        <div className="mc-next-work-record-section-head">
          <div>
            <p className="mc-next-panel-kicker">Artifact preview</p>
            <h4>{activeProps.activeGeneratedArtifact.title}</h4>
          </div>
          {activeProps.onCloseGeneratedArtifact ? (
            <button type="button" className="mc-next-panel-button" onClick={activeProps.onCloseGeneratedArtifact}>
              Close
            </button>
          ) : null}
        </div>
        <GeneratedArtifactViewer artifact={activeProps.activeGeneratedArtifact} compact />
      </section>
    );
  }

  return (
    <section className="mc-next-utility-card mc-next-work-record-card">
      <div className="mc-next-work-record-hero">
        <div className="mc-next-utility-empty-icon">
          <FileText size={18} />
        </div>
        <div>
          <p className="mc-next-panel-kicker">Preview and launch</p>
          <h4>Work Record</h4>
          <p>Artifacts, citations, approvals, and recent tool events stay inspectable without crowding the chat.</p>
        </div>
      </div>
      <div className="mc-next-work-record-metrics" aria-label="Thread record summary">
        <div>
          <span>Session</span>
          <strong>{sessionLabel}</strong>
        </div>
        <div>
          <span>Turns</span>
          <strong>{threadTurnCount}</strong>
        </div>
        <div>
          <span>Approvals</span>
          <strong>{activeProps.approvalsCount}</strong>
        </div>
      </div>
      {selectedTurn ? (
        <>
          <div className="mc-next-work-record-section">
            <div className="mc-next-work-record-section-head">
              <div>
                <p className="mc-next-panel-kicker">Selected turn</p>
                <h5>{shortId(selectedTurn.turnId)}</h5>
              </div>
              <StatusChip tone={selectedTurn.trace.status === "completed" ? "success" : "muted"}>
                {selectedTurn.trace.status}
              </StatusChip>
            </div>
            <p className="mc-next-work-record-snippet">
              <strong>User:</strong> {userPreview}
            </p>
            <p className="mc-next-work-record-snippet">
              <strong>Assistant:</strong> {assistantPreview}
            </p>
          </div>
          <div className="mc-next-work-record-section">
            <div className="mc-next-work-record-section-head">
              <h5>Artifacts and citations</h5>
              <div className="mc-next-utility-chip-row">
                <StatusChip tone={generatedArtifacts.length > 0 ? "success" : "muted"}>
                  {generatedArtifacts.length} artifact{generatedArtifacts.length === 1 ? "" : "s"}
                </StatusChip>
                <StatusChip tone={citations.length > 0 ? "success" : "muted"}>
                  {citations.length} citation{citations.length === 1 ? "" : "s"}
                </StatusChip>
              </div>
            </div>
            {generatedArtifacts.length > 0 ? (
              <ul className="mc-next-work-record-list">
                {generatedArtifacts.slice(0, 4).map((artifact) => (
                  <li key={artifact.artifactId}>
                    <span>{artifact.title}</span>
                    <strong>{artifact.kind}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No generated artifacts are attached to this turn.</p>
            )}
            {citations.length > 0 ? (
              <ul className="mc-next-work-record-list">
                {citations.slice(0, 3).map((citation) => (
                  <li key={citation.citationId}>
                    <span>{citation.title ?? citation.url}</span>
                    <strong>{citation.sourceType ?? "source"}</strong>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="mc-next-work-record-section">
            <div className="mc-next-work-record-section-head">
              <h5>Recent tool events</h5>
              <StatusChip tone={toolRuns.length > 0 ? "warning" : "muted"}>
                {toolRuns.length} event{toolRuns.length === 1 ? "" : "s"}
              </StatusChip>
            </div>
            {toolRuns.length > 0 ? (
              <ul className="mc-next-work-record-list">
                {toolRuns.slice(0, 5).map((toolRun) => (
                  <li key={toolRun.toolRunId}>
                    <span>{toolRun.toolName}</span>
                    <strong>{toolRun.status}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No tool events are recorded on the selected turn.</p>
            )}
          </div>
        </>
      ) : (
        <p>Select a turn or open a generated artifact to preview the thread record here.</p>
      )}
      <div className="mc-next-work-record-actions">
        {selectedTurn ? (
          <>
            <button
              type="button"
              className="mc-next-panel-button"
              disabled={generatedArtifacts.length === 0}
              onClick={() => activeProps.onOpenGeneratedArtifact(selectedTurn.turnId)}
            >
              Open artifact
            </button>
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={() => activeProps.onOpenRunDetails(selectedTurn.turnId)}
            >
              Trace turn
            </button>
          </>
        ) : null}
        {activeProps.approvalsCount > 0 ? (
          <button type="button" className="mc-next-panel-button" onClick={activeProps.onOpenApprovals}>
            Review approvals
          </button>
        ) : null}
        {activeProps.onExportRunBundle ? (
          <button type="button" className="mc-next-panel-button" onClick={activeProps.onExportRunBundle}>
            Export proof
          </button>
        ) : null}
        <button type="button" className="mc-next-panel-link" onClick={activeProps.onOpenLibraryArtifacts}>
          Library
        </button>
        <button type="button" className="mc-next-panel-link" onClick={activeProps.onOpenOpsRuntime}>
          Ops
        </button>
      </div>
    </section>
  );
}

function UtilityDiffPanel({ workflowPanel }: { workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"] }) {
  const codePanel = getCodeWorkflowPanel(workflowPanel);
  const diff = codePanel?.props.diff;
  const selectedFileDiff = codePanel?.props.selectedFileDiff;
  const changedFiles = codePanel?.props.workbenchTree?.changedFiles ?? diff?.changedFiles ?? [];
  const diffText =
    diff?.diff ||
    [selectedFileDiff?.originalContent, selectedFileDiff?.modifiedContent].filter(Boolean).join("\n\n---\n\n");

  return (
    <section className="mc-next-utility-card">
      <h4>Repo diff</h4>
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={changedFiles.length > 0 ? "warning" : "muted"}>{changedFiles.length} changed</StatusChip>
        {diff?.summary ? (
          <StatusChip tone="muted">
            +{diff.summary.additions} / -{diff.summary.deletions}
          </StatusChip>
        ) : null}
      </div>
      {changedFiles.length > 0 ? (
        <ul className="mc-next-utility-list">
          {changedFiles.slice(0, 12).map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      ) : (
        <p>No worktree diff is open for this session.</p>
      )}
      {diffText ? <pre className="mc-next-utility-pre">{formatUtilitySnippet(diffText, 2400)}</pre> : null}
    </section>
  );
}

function UtilityTerminalPanel({
  workflowPanel,
}: {
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const codePanel = getCodeWorkflowPanel(workflowPanel);
  const output = codePanel?.props.output;
  const helperRuns = output?.helperRuns ?? [];
  const terminalText = formatUtilitySnippet(output?.output, 2400);

  return (
    <section className="mc-next-utility-card">
      <h4>Run log</h4>
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={helperRuns.length > 0 ? "success" : "muted"}>
          {helperRuns.length} command record{helperRuns.length === 1 ? "" : "s"}
        </StatusChip>
        <StatusChip tone="muted">{codePanel?.props.workbenchState?.validationStatus ?? "validation idle"}</StatusChip>
      </div>
      {output?.output ? <pre className="mc-next-utility-pre terminal">{terminalText}</pre> : <p>No run output yet.</p>}
      {helperRuns.length > 0 ? (
        <ul className="mc-next-utility-list">
          {helperRuns.slice(0, 5).map((run) => (
            <li key={run.runId}>
              {run.language ?? "command"} · {run.status ?? "recorded"}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function UtilityFilesPanel({ workflowPanel }: { workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"] }) {
  const codePanel = getCodeWorkflowPanel(workflowPanel);
  const files = (codePanel?.props.workbenchTree?.items ?? []).filter((item) => item.kind === "file");
  const hasDirtyDraft = Boolean(codePanel?.props.hasDirtyDraft);
  const selectedPath = codePanel?.props.selectedFile?.path;

  return (
    <section className="mc-next-utility-card">
      <h4>Workbench files</h4>
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={files.length > 0 ? "success" : "muted"}>{files.length} files</StatusChip>
        {hasDirtyDraft ? <StatusChip tone="warning">Unsaved draft</StatusChip> : null}
      </div>
      {files.length > 0 ? (
        <ul className="mc-next-utility-file-list">
          {files.slice(0, 28).map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={`mc-next-panel-button${selectedPath === file.path ? " active" : ""}`}
                disabled={hasDirtyDraft && selectedPath !== file.path}
                onClick={() => codePanel?.props.onSelectFile(file.path)}
              >
                <span>{file.path}</span>
                {file.changed ? <span>changed</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No workbench files are loaded yet.</p>
      )}
    </section>
  );
}

function UtilityBackgroundTasksPanel({
  activeProps,
  onOpenUniversalRunDetail,
  onOpenTasks,
  onSelectSession,
}: {
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  onOpenUniversalRunDetail?: (runId: string) => void;
  onOpenTasks?: () => void;
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
}) {
  return (
    <DurableBackgroundTaskRail
      parentRunId={activeProps.selectedTurn?.trace.durable?.runId}
      workspaceId={activeProps.workspaceId}
      sessionId={activeProps.selectedSessionId}
      turnId={activeProps.selectedTurn?.turnId}
      queuedCount={activeProps.queuedCount}
      streamStatus={activeProps.streamStatus}
      queueLabels={activeProps.queueItems.map((item) => item.label)}
      onOpenApprovals={activeProps.onOpenApprovals}
      onOpenTasks={onOpenTasks}
      onOpenSemanticLink={(link, relatedLinks) => {
        if (link.kind === "durable_run") {
          onOpenUniversalRunDetail?.(link.id);
          return;
        }
        if (link.kind === "chat_session") {
          onSelectSession(link.id);
          return;
        }
        if (link.kind === "chat_turn") {
          const childSession = relatedLinks.find((candidate) => candidate.kind === "chat_session");
          if (childSession) onSelectSession(childSession.id, { turnId: link.id });
          else activeProps.onOpenRunDetails(link.id);
          return;
        }
        if (link.kind === "approval") activeProps.onOpenApprovals();
        if (link.kind === "task") onOpenTasks?.();
      }}
    />
  );
}

function UtilityPlanPanel({
  activeProps,
  contextDockProps,
}: {
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  contextDockProps: MissionThreadedRenderSurfaceInput["contextDockProps"];
}) {
  const planningEnabled = activeProps.planningMode === "advisory";

  return (
    <section className="mc-next-utility-card">
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={planningEnabled ? "success" : "muted"}>
          {planningEnabled ? "Planning on" : "Planning off"}
        </StatusChip>
        <StatusChip tone="muted">{contextDockProps?.routePreflight?.selectionSource ?? "route pending"}</StatusChip>
        <StatusChip tone={activeProps.routeBoundaryAckRequired ? "warning" : "muted"}>
          {activeProps.routeBoundaryAckRequired ? "boundary acknowledgement needed" : "route clear"}
        </StatusChip>
      </div>
      <h4>{activeProps.pinnedGoal ?? "Current plan"}</h4>
      <p>
        {activeProps.routePreflight?.degradedReason ?? activeProps.routePreflight?.blockedReason ?? activeProps.summary}
      </p>
      <div className="mc-next-utility-actions">
        <button type="button" className="mc-next-panel-button" onClick={activeProps.onTogglePlanningMode}>
          {planningEnabled ? "Turn planning off" : "Turn planning on"}
        </button>
        <button type="button" className="mc-next-panel-button" onClick={activeProps.onReviewRunDetails}>
          Review run details
        </button>
      </div>
    </section>
  );
}

function getCodeWorkflowPanel(
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"],
): CodeWorkflowPanel | null {
  return workflowPanel?.kind === "code" ? workflowPanel : null;
}

function formatUtilitySnippet(value?: string | null, maxLength = 1200): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "No content yet.";
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trimEnd()}\n...`;
}

function ThreadEmptyState({
  surface,
  helper,
  input,
  dropTarget,
}: {
  surface: ChatMode;
  helper: string;
  input: MissionThreadedRenderSurfaceInput;
  dropTarget: MissionThreadedDropTargetProps;
}) {
  void surface;
  const Icon = MODE_META.chat.icon;
  const guidance = EMPTY_STATE_GUIDANCE.chat;
  return (
    <section
      className={`mc-next-threaded-empty mc-next-threaded-dropzone${dropTarget.isDragActive ? " drop-active" : ""}`}
      onDragEnter={dropTarget.onDragEnter}
      onDragOver={dropTarget.onDragOver}
      onDragLeave={dropTarget.onDragLeave}
      onDrop={dropTarget.onDrop}
    >
      {dropTarget.isDragActive ? (
        <div className="mc-next-threaded-drop-overlay">Drop files to start a thread with attachments</div>
      ) : null}
      <div className="mc-next-threaded-empty-icon">
        <Icon size={22} />
      </div>
      <p className="mc-next-threaded-empty-kicker">{input.emptyStateProps.workspaceName}</p>
      <h2>{guidance.title}</h2>
      <p>{guidance.body}</p>
      <p className="mc-next-threaded-empty-support">{helper}</p>
      <div className="mc-next-threaded-empty-guidance" aria-label="Chat starting points">
        {guidance.cards.map((card) => (
          <div key={card.title} className="mc-next-threaded-empty-card">
            <strong>{card.title}</strong>
            <span>{card.body}</span>
          </div>
        ))}
      </div>
      <div className="mc-next-threaded-empty-facts" aria-label="Workspace readiness">
        <span>
          <strong>{input.emptyStateProps.sessionCount}</strong>
          <span>Sessions</span>
        </span>
        <span>
          <strong>{input.emptyStateProps.projectCount}</strong>
          <span>Projects</span>
        </span>
        <span>
          <strong>{input.emptyStateProps.approvalsCount}</strong>
          <span>Approvals</span>
        </span>
      </div>
      <div className="mc-next-threaded-empty-actions">
        <button type="button" className="mc-next-threaded-primary" onClick={input.emptyStateProps.onCreateSession}>
          {guidance.startLabel}
        </button>
        {input.emptyStateProps.onOpenStartHere ? (
          <button
            type="button"
            className="mc-next-threaded-secondary mc-next-threaded-start-here"
            onClick={input.emptyStateProps.onOpenStartHere}
          >
            {guidance.startHereLabel}
          </button>
        ) : null}
        <button type="button" className="mc-next-threaded-secondary" onClick={dropTarget.onAttachFiles}>
          Attach files
        </button>
        {input.emptyStateProps.approvalsCount > 0 ? (
          <button
            type="button"
            className="mc-next-threaded-secondary"
            onClick={() => input.emptyStateProps.onOpenApprovals()}
          >
            Approvals ({input.emptyStateProps.approvalsCount})
          </button>
        ) : null}
      </div>
    </section>
  );
}

type SessionGroupItem = {
  sessionId: string;
  title?: string | null;
  updatedAt?: string;
  projectName?: string | null;
  folderName?: string | null;
  tags?: string[];
  channel?: string | null;
  account?: string | null;
  mode?: ChatMode | null;
  pinned?: boolean;
  lifecycleStatus?: ChatSessionRecord["lifecycleStatus"];
  tokenTotal?: number;
  costUsdTotal?: number;
  pinnedGoal?: string;
  generatedArtifacts?: ChatSessionRecord["generatedArtifacts"];
  delegationParent?: ChatSessionRecord["delegationParent"];
  searchHits?: ChatSessionSearchHitRecord[];
};

function SessionGroup({
  title,
  items,
  count,
  selectedSessionId,
  onSelectSession,
  renderSessionLabel,
  nestedChildrenByParentId,
  orphanDelegatedItems = [],
  emptyCopy = "No sessions in this lane yet.",
}: {
  title: string;
  items: SessionGroupItem[];
  count?: number;
  selectedSessionId: string | null;
  onSelectSession: (
    sessionId: string,
    options?: { turnId?: string | null; searchHit?: ChatSessionSearchHitRecord },
  ) => void;
  renderSessionLabel: (sessionId: string) => string;
  nestedChildrenByParentId?: Record<string, SessionGroupItem[]>;
  orphanDelegatedItems?: SessionGroupItem[];
  emptyCopy?: string;
}) {
  const [collapsedParents, setCollapsedParents] = useState<Record<string, boolean>>({});
  const selectedParentId = useMemo(() => {
    if (!selectedSessionId || !nestedChildrenByParentId) {
      return null;
    }
    return (
      Object.entries(nestedChildrenByParentId).find(([, children]) =>
        children.some((child) => child.sessionId === selectedSessionId),
      )?.[0] ?? null
    );
  }, [nestedChildrenByParentId, selectedSessionId]);
  useEffect(() => {
    if (!nestedChildrenByParentId) {
      return;
    }
    setCollapsedParents((current) => {
      let changed = false;
      const next = { ...current };
      for (const parentId of Object.keys(nestedChildrenByParentId)) {
        if (next[parentId] === undefined) {
          next[parentId] = true;
          changed = true;
        }
        if (parentId === selectedParentId && next[parentId]) {
          next[parentId] = false;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [nestedChildrenByParentId, selectedParentId]);
  const hasVisibleItems = items.length > 0 || orphanDelegatedItems.length > 0;

  return (
    <section className="mc-next-threaded-session-group" aria-label={title}>
      <div className="mc-next-threaded-group-head">
        <h3>{title}</h3>
        <span aria-hidden="true">{count ?? items.length}</span>
      </div>
      {hasVisibleItems ? (
        <div className="mc-next-threaded-session-list">
          {items.map((item) => {
            const children = nestedChildrenByParentId?.[item.sessionId] ?? [];
            const collapsed = collapsedParents[item.sessionId] ?? children.length > 0;
            return (
              <div key={item.sessionId} className="mc-next-threaded-session-tree-node">
                <SessionRow
                  item={item}
                  selectedSessionId={selectedSessionId}
                  onSelectSession={onSelectSession}
                  renderSessionLabel={renderSessionLabel}
                  childCount={children.length}
                  collapsed={collapsed}
                  onToggleChildren={
                    children.length > 0
                      ? () =>
                          setCollapsedParents((current) => ({
                            ...current,
                            [item.sessionId]: !collapsed,
                          }))
                      : undefined
                  }
                />
                {children.length > 0 && !collapsed ? (
                  <div className="mc-next-threaded-session-children">
                    {children.map((child) => (
                      <SessionRow
                        key={child.sessionId}
                        item={child}
                        selectedSessionId={selectedSessionId}
                        onSelectSession={onSelectSession}
                        renderSessionLabel={renderSessionLabel}
                        nested
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {orphanDelegatedItems.length > 0 ? (
            <div className="mc-next-threaded-orphan-delegates">
              <div className="mc-next-threaded-orphan-delegates-head">
                <span>Delegated tasks</span>
                <span>{orphanDelegatedItems.length}</span>
              </div>
              {orphanDelegatedItems.map((child) => (
                <SessionRow
                  key={child.sessionId}
                  item={child}
                  selectedSessionId={selectedSessionId}
                  onSelectSession={onSelectSession}
                  renderSessionLabel={renderSessionLabel}
                  nested
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mc-next-threaded-empty-copy">{emptyCopy}</p>
      )}
    </section>
  );
}

function SessionRow({
  item,
  selectedSessionId,
  onSelectSession,
  renderSessionLabel,
  childCount = 0,
  collapsed = false,
  onToggleChildren,
  nested = false,
}: {
  item: SessionGroupItem;
  selectedSessionId: string | null;
  onSelectSession: (
    sessionId: string,
    options?: { turnId?: string | null; searchHit?: ChatSessionSearchHitRecord },
  ) => void;
  renderSessionLabel: (sessionId: string) => string;
  childCount?: number;
  collapsed?: boolean;
  onToggleChildren?: () => void;
  nested?: boolean;
}) {
  const label = item.title?.trim() || renderSessionLabel(item.sessionId);
  const mode: ChatMode = "chat";
  const delegatedLabel = item.delegationParent?.label?.trim() || item.delegationParent?.role?.trim();
  const meta = delegatedLabel
    ? `Delegated task · ${delegatedLabel}`
    : item.projectName?.trim() ||
      item.folderName?.trim() ||
      item.channel?.trim() ||
      item.account?.trim() ||
      "Workspace session";
  const updatedAtLabel = formatRelativeTime(item.updatedAt);
  const metadataChips = getSessionMetadataChips(item);

  return (
    <div className={`mc-next-threaded-session-row-shell${nested ? " nested" : ""}`}>
      <button
        type="button"
        className={`mc-next-threaded-session-row mode-${mode}${selectedSessionId === item.sessionId ? " active" : ""}`}
        onClick={() => onSelectSession(item.sessionId)}
        title={label}
      >
        <div className="mc-next-threaded-session-row-main">
          <div className="mc-next-threaded-session-row-copy">
            <span className="mc-next-threaded-mode-label mode-chat">Chat</span>
            <div className="mc-next-threaded-session-titleline">
              <strong>{label}</strong>
              <time className="mc-next-threaded-session-time" dateTime={item.updatedAt}>
                {updatedAtLabel}
              </time>
            </div>
            <span title={meta}>{meta}</span>
            {metadataChips.length > 0 ? (
              <div className="mc-next-threaded-session-meta-chips" aria-label="Session metadata">
                {metadataChips.map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </button>
      {item.searchHits && item.searchHits.length > 0 ? (
        <div className="mc-next-threaded-search-hits" aria-label={`Search results in ${label}`}>
          {item.searchHits.map((hit) => (
            <button
              key={`${hit.messageId}:${hit.sequence}`}
              type="button"
              className="mc-next-threaded-search-hit"
              onClick={() => onSelectSession(item.sessionId, { searchHit: hit })}
              aria-label="Open exact search result"
            >
              <span>Message match</span>
              <mark>{hit.excerpt}</mark>
            </button>
          ))}
        </div>
      ) : null}
      {onToggleChildren ? (
        <button
          type="button"
          className="mc-next-threaded-session-toggle"
          onClick={onToggleChildren}
          aria-label={collapsed ? "Expand delegated chats" : "Collapse delegated chats"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand delegated chats" : "Collapse delegated chats"}
        >
          <span>{childCount}</span>
          <ChevronRight size={14} className={collapsed ? "" : "open"} />
        </button>
      ) : null}
    </div>
  );
}

function getSessionMetadataChips(item: SessionGroupItem): string[] {
  const chips: string[] = [];
  if (item.pinned) {
    chips.push("Pinned");
  }
  if (item.lifecycleStatus === "archived") {
    chips.push("Archived");
  }
  if (item.pinnedGoal?.trim()) {
    chips.push("Goal");
  }
  if (item.tags?.length) {
    chips.push(...item.tags.slice(0, 2));
  }
  if ((item.generatedArtifacts?.length ?? 0) > 0) {
    chips.push(`${item.generatedArtifacts!.length} artifact${item.generatedArtifacts!.length === 1 ? "" : "s"}`);
  }
  if ((item.tokenTotal ?? 0) > 0) {
    chips.push(formatCompactSessionNumber(item.tokenTotal!, "token"));
  }
  if ((item.costUsdTotal ?? 0) > 0) {
    chips.push(formatCompactUsd(item.costUsdTotal!));
  }
  return chips.slice(0, 4);
}

function formatCompactSessionNumber(value: number, unit: string): string {
  return `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)} ${unit}${
    value === 1 ? "" : "s"
  }`;
}

function formatCompactUsd(value: number): string {
  if (value < 0.01) {
    return "<$0.01";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

function FilterChip({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`mc-next-threaded-filter${active ? " active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function formatRelativeTime(value?: string): string {
  if (!value) {
    return "Recent";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "Recent";
  }
  const deltaMinutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}
