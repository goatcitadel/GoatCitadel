/* eslint-disable max-lines -- ThreadedSurfacePage coordinates chat/cowork/code layout, composer chrome, timeline, drawer, and workflow panels while decomposition lands (plan W3.1 in local decomposition notes). */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedDropTargetProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { groupDelegatedSessionsForRail } from "@goatcitadel/threaded-surface-core";
import { StatusChip } from "../native-routes/primitives";
import { ChatModelPicker } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@goatcitadel/mission-control-shared/components/ui";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { ThreadedComposer } from "./ThreadedComposer";
import { ThreadedBtwSideChatPanel } from "./ThreadedBtwSideChatPanel";
import { ThreadedContextDrawer } from "./ThreadedContextDrawer";
import { ThreadedTimeline } from "./ThreadedTimeline";
import { ThreadedWorkflowPanel } from "./ThreadedWorkflowPanel";
import "./styles/rail.css";
import "./styles/header.css";
import "./styles/timeline-frame.css";
import "./styles/visual-regression.css";
import "./styles/side-panels.css";
import "./styles/timeline.css";
import "./styles/composer.css";
import "./styles/mobile.css";
import "./styles/btw-side-chat.css";

const MODE_META: Record<ChatMode, { label: string; icon: typeof MessageSquareText; helper: string }> = {
  chat: {
    label: "Chat",
    icon: MessageSquareText,
    helper: "Fast conversation, attachments, and lightweight help.",
  },
  cowork: {
    label: "Cowork",
    icon: Workflow,
    helper: "Delegation-first work with visible orchestration and checkpoints.",
  },
  code: {
    label: "Code",
    icon: Code2,
    helper: "Implementation-focused thread with workbench and code-mode tools.",
  },
};

type ThreadedUtilityPanelId = "preview" | "diff" | "terminal" | "files" | "background" | "plan";
type ThreadedUtilityPanelMeta = { id: ThreadedUtilityPanelId; label: string; icon: typeof PanelRight };

const UTILITY_PANEL_ITEMS: ThreadedUtilityPanelMeta[] = [
  { id: "preview", label: "Preview", icon: Play },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "terminal", label: "Run log", icon: Terminal },
  { id: "files", label: "Files", icon: Folder },
  { id: "background", label: "Background tasks", icon: Eye },
  { id: "plan", label: "Plan", icon: ListChecks },
];

const PANE_WIDTHS = {
  rail: { initial: 204, min: 164, max: 360 },
  workbench: { initial: 560, min: 320, max: 840 },
  context: { initial: 320, min: 224, max: 520 },
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
  onOpenUniversalRunDetail,
}: {
  surface: ChatMode;
  input: MissionThreadedRenderSurfaceInput;
  permissionState?: ThreadedPermissionState;
  onOpenUniversalRunDetail?: (runId: string) => void;
}) {
  const railDrawerLayout = useMediaQuery("(max-width: 1023px)");
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
  const activeProps = input.activeSessionSurfaceProps;
  const [activeUtilityPanel, setActiveUtilityPanel] = useState<ThreadedUtilityPanelId | null>(null);
  const dockOpen = Boolean((input.dockOpen || activeUtilityPanel) && activeProps);
  const workflowPanel = input.workflowPanel;
  const activeMode = activeProps?.mode ?? surface;
  const modeMeta = MODE_META[activeMode];
  const [codeWorkbenchOpen, setCodeWorkbenchOpen] = useState(true);
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
  const handleDockOpenChange = (next: boolean) => {
    setActiveUtilityPanel(null);
    input.onDockOpenChange(next);
  };
  const handleSelectUtilityPanel = (panel: ThreadedUtilityPanelId) => {
    setActiveUtilityPanel(panel);
    input.onDockOpenChange(true);
  };
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

  return (
    <div
      className="mc-next-threaded-surface unified"
      data-mode={surface}
      data-active-mode={activeMode}
      data-area={surface}
      style={rootStyle}
    >
      <button
        type="button"
        className={`mc-next-threaded-scrim${railDrawerOpen ? " open" : ""}`}
        aria-hidden={!railDrawerOpen}
        tabIndex={railDrawerOpen ? 0 : -1}
        onClick={() => input.onSessionRailOpenChange(false)}
      />

      <aside
        className={`mc-next-threaded-rail${railDrawerOpen ? " open" : ""}`}
        aria-label="Sessions"
        aria-hidden={railDrawerLayout && !railOpen}
        inert={railDrawerLayout && !railOpen}
      >
        <div className="mc-next-threaded-rail-head">
          <div>
            <p>Sessions</p>
            <h2>{input.sessionRail.summaryTitle}</h2>
            <span>Chat, Cowork, and Code threads stay connected by project.</span>
          </div>
          <button
            type="button"
            className="mc-next-threaded-menu-button"
            onClick={() => input.onSessionRailOpenChange(false)}
            aria-label="Close session rail"
          >
            <PanelRight size={16} />
          </button>
        </div>

        <div className="mc-next-threaded-rail-actions">
          <button type="button" className="mc-next-threaded-primary" onClick={input.sessionRail.onCreateSession}>
            <MessageSquareText size={16} />
            <span>New session</span>
          </button>
          <button
            type="button"
            className={`mc-next-threaded-secondary${input.sessionRail.showProjectCreate ? " active" : ""}`}
            onClick={input.sessionRail.onToggleProjectCreate}
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
            placeholder="Search sessions"
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
            {input.sessionRail.archiveWorkspacePending ? "Archiving..." : "Archive workspace chats"}
          </button>
        ) : null}

        <SessionGroup
          title="Mission"
          items={missionSessionGroups.topLevelSessions}
          count={missionSessionGroups.topLevelSessions.length}
          selectedSessionId={input.sessionRail.selectedSessionId}
          onSelectSession={input.sessionRail.onSelectSession}
          renderSessionLabel={input.sessionRail.renderSessionLabel}
          nestedChildrenByParentId={missionSessionGroups.delegatedChildrenByParentId}
          orphanDelegatedItems={missionSessionGroups.orphanDelegatedSessions}
        />
        <SessionGroup
          title="External"
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

      <section className={stageLayoutClass} style={stageStyle}>
        <div className="mc-next-threaded-primary-column">
          <input
            ref={input.dropTargetProps.fileInputRef}
            type="file"
            multiple
            className="mc-next-hidden-file"
            onChange={(event) => input.dropTargetProps.onUploadFiles(event.target.files)}
          />
          <div className="mc-next-threaded-mobile-bar">
            <button
              type="button"
              className="mc-next-threaded-menu-button"
              onClick={() => input.onSessionRailOpenChange(true)}
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
                <span>{codeWorkbenchOpen ? "Hide editor" : "Code editor"}</span>
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
              ariaLabel={`Resize ${workflowPanel.kind === "code" ? "code workbench" : "cowork panel"}`}
              className="panel"
              dragging={workbenchPane.dragging}
              maxWidth={PANE_WIDTHS.workbench.max}
              minWidth={PANE_WIDTHS.workbench.min}
              onDoubleClick={workbenchPane.reset}
              onKeyDown={workbenchPane.handleKeyDown}
              onPointerDown={workbenchPane.handlePointerDown}
              width={workbenchPane.width}
            />
            <ThreadedWorkflowPanel panel={workflowPanel} />
          </aside>
        ) : null}

        {dockOpen && input.contextDockProps ? (
          <aside className={`mc-next-threaded-context-panel${activeUtilityPanel ? " utility" : ""}`}>
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
                onOpenTasks={input.emptyStateProps?.onOpenTasks}
                onSelectPanel={setActiveUtilityPanel}
                surface={activeMode}
                workflowPanel={workflowPanel}
              />
            ) : (
              <ThreadedContextDrawer
                surface={activeMode}
                props={input.contextDockProps}
                permissionSummary={formatThreadedPermissionSummary(permissionState)}
                permissionOverrideActive={Boolean(permissionState?.localOperatorOverrideId)}
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
  surface,
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
  const actions = useMemo(() => {
    const list: Array<{ label: string; onClick: () => void }> = [];
    if (surface === "chat") {
      list.push({ label: "Continue in Cowork", onClick: () => props.onNavigateSurface("cowork") });
      list.push({ label: "Open in Code", onClick: () => props.onNavigateSurface("code") });
    } else if (surface === "cowork") {
      list.push({ label: "Open in Code", onClick: () => props.onNavigateSurface("code") });
      list.push({ label: "Back to Chat", onClick: () => props.onNavigateSurface("chat") });
    } else {
      list.push({ label: "Open in Cowork", onClick: () => props.onNavigateSurface("cowork") });
      list.push({ label: "Back to Chat", onClick: () => props.onNavigateSurface("chat") });
    }
    return list;
  }, [props, surface]);

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
          <p>{MODE_META[surface].label}</p>
          <h1>{props.sessionTitle}</h1>
          <span>{props.summary}</span>
        </div>

        <div className="mc-next-threaded-header-meta">
          <div className="mc-next-threaded-chip-row">
            <StatusChip tone={props.trust.gatewayTone}>{props.trust.gatewayLabel}</StatusChip>
            <StatusChip tone="muted">{props.trust.approvalsSummary}</StatusChip>
            <StatusChip tone={props.trust.runtimeTone ?? "muted"}>{props.trust.runtimeSummary}</StatusChip>
            {props.trust.fallbackSummary ? (
              <StatusChip tone={props.trust.fallbackTone ?? "warning"}>{props.trust.fallbackSummary}</StatusChip>
            ) : null}
          </div>
          <div className="mc-next-threaded-chip-row">
            <StatusChip tone="muted">{props.trust.providerModelSummary}</StatusChip>
            <StatusChip tone={permissionState?.localOperatorOverrideId ? "warning" : "muted"}>
              {formatThreadedPermissionSummary(permissionState)}
            </StatusChip>
            {props.trust.selectionSourceSummary ? (
              <StatusChip tone="muted">{props.trust.selectionSourceSummary}</StatusChip>
            ) : null}
            {props.trust.runStateSummary ? <StatusChip tone="muted">{props.trust.runStateSummary}</StatusChip> : null}
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
          <div className="mc-next-threaded-action-row">
            {actions.map((action) => (
              <button key={action.label} type="button" className="mc-next-threaded-secondary" onClick={action.onClick}>
                {action.label}
              </button>
            ))}
            {onToggleCodeWorkbench ? (
              <button type="button" className="mc-next-threaded-secondary" onClick={onToggleCodeWorkbench}>
                {codeWorkbenchOpen ? "Hide editor" : "Code editor"}
              </button>
            ) : null}
            {props.onExportRunBundle ? (
              <button type="button" className="mc-next-threaded-secondary" onClick={props.onExportRunBundle}>
                Export run bundle
              </button>
            ) : null}
            {props.approvalsCount > 0 ? (
              <button type="button" className="mc-next-threaded-secondary" onClick={props.onOpenApprovals}>
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
        <div className="mc-next-threaded-thread-card">
          <ThreadedTimeline props={props} onOpenUniversalRunDetail={onOpenUniversalRunDetail} />
        </div>
        <div className="mc-next-threaded-composer-card">
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

export function getArchiveActionLabel(lifecycleStatus: string, pending: boolean) {
  if (pending) return lifecycleStatus === "archived" ? "Restoring..." : "Archiving...";
  return lifecycleStatus === "archived" ? "Restore" : "Archive";
}

type CodeWorkflowPanel = Extract<NonNullable<MissionThreadedRenderSurfaceInput["workflowPanel"]>, { kind: "code" }>;
type CoworkWorkflowPanel = Extract<NonNullable<MissionThreadedRenderSurfaceInput["workflowPanel"]>, { kind: "cowork" }>;

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

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
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
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && menuRef.current && !menuRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
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
        <div className="mc-next-threaded-panel-menu" role="menu">
          {UTILITY_PANEL_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
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
  onOpenTasks,
  onSelectPanel,
  surface,
  workflowPanel,
}: {
  activePanel: ThreadedUtilityPanelId;
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  contextDockProps: MissionThreadedRenderSurfaceInput["contextDockProps"];
  onClose: () => void;
  onOpenTasks?: () => void;
  onSelectPanel: (panel: ThreadedUtilityPanelId) => void;
  surface: ChatMode;
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const meta = UTILITY_PANEL_ITEMS.find((item) => item.id === activePanel) ?? UTILITY_PANEL_ITEMS[0]!;

  return (
    <div className="mc-next-utility-panel" data-mode={surface} data-panel={activePanel}>
      <div className="mc-next-utility-panel-head">
        <div>
          <p className="mc-next-panel-kicker">Right drawer</p>
          <h3>{meta.label}</h3>
        </div>
        <button type="button" className="mc-next-panel-button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="mc-next-utility-panel-tabs">
        {UTILITY_PANEL_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
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
          onOpenTasks={onOpenTasks}
          workflowPanel={workflowPanel}
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

  if (activeProps.activeGeneratedArtifact) {
    return (
      <section className="mc-next-utility-card">
        <GeneratedArtifactViewer artifact={activeProps.activeGeneratedArtifact} compact />
      </section>
    );
  }

  return (
    <section className="mc-next-utility-card">
      <div className="mc-next-utility-empty-icon">
        <FileText size={18} />
      </div>
      <h4>{selectedTurn ? "Selected turn preview" : "No preview selected"}</h4>
      {selectedTurn ? (
        <>
          <p className="mc-next-panel-kicker">User</p>
          <p>{userPreview}</p>
          <p className="mc-next-panel-kicker">Assistant</p>
          <p>{assistantPreview}</p>
        </>
      ) : (
        <p>Select a turn or open a generated artifact to preview it here.</p>
      )}
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
  onOpenTasks,
  workflowPanel,
}: {
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  onOpenTasks?: () => void;
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const coworkPanel = getCoworkWorkflowPanel(workflowPanel);
  const blockers = coworkPanel?.props.viewModel.blockers ?? [];

  return (
    <section className="mc-next-utility-card">
      <h4>Background work</h4>
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={activeProps.queuedCount > 0 ? "warning" : "muted"}>
          {activeProps.queuedCount} queued
        </StatusChip>
        <StatusChip tone={activeProps.streamStatus === "streaming" ? "success" : "muted"}>
          {activeProps.streamStatus}
        </StatusChip>
        {blockers.length > 0 ? <StatusChip tone="warning">{blockers.length} blockers</StatusChip> : null}
      </div>
      {activeProps.queueItems.length > 0 ? (
        <ul className="mc-next-utility-list">
          {activeProps.queueItems.slice(0, 8).map((item) => (
            <li key={item.id}>{item.label}</li>
          ))}
        </ul>
      ) : (
        <p>No queued background work is waiting on this thread.</p>
      )}
      {coworkPanel?.props.viewModel.runMap.objective ? <p>{coworkPanel.props.viewModel.runMap.objective}</p> : null}
      {onOpenTasks ? (
        <button type="button" className="mc-next-panel-button" onClick={onOpenTasks}>
          Open task board
        </button>
      ) : null}
    </section>
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

function getCoworkWorkflowPanel(
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"],
): CoworkWorkflowPanel | null {
  return workflowPanel?.kind === "cowork" ? workflowPanel : null;
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
  const Icon = MODE_META[surface].icon;
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
      <h2>No active {MODE_META[surface].label.toLowerCase()} thread</h2>
      <p>{helper}</p>
      <p>{input.emptyStateProps.workspaceName}</p>
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
          Start {MODE_META[surface].label.toLowerCase()}
        </button>
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
        {surface === "chat"
          ? [
              <button
                key="open-cowork"
                type="button"
                className="mc-next-threaded-secondary"
                onClick={input.emptyStateProps.onOpenCowork}
              >
                Open Cowork
              </button>,
              <button
                key="open-code"
                type="button"
                className="mc-next-threaded-secondary"
                onClick={input.emptyStateProps.onOpenCode}
              >
                Open Code
              </button>,
            ]
          : null}
      </div>
    </section>
  );
}

type SessionGroupItem = {
  sessionId: string;
  title?: string | null;
  updatedAt?: string;
  projectName?: string | null;
  channel?: string | null;
  mode?: ChatMode | null;
  delegationParent?: ChatSessionRecord["delegationParent"];
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
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
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
    <section className="mc-next-threaded-session-group">
      <div className="mc-next-threaded-group-head">
        <h3>{title}</h3>
        <span>{count ?? items.length}</span>
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
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
  renderSessionLabel: (sessionId: string) => string;
  childCount?: number;
  collapsed?: boolean;
  onToggleChildren?: () => void;
  nested?: boolean;
}) {
  const label = item.title?.trim() || renderSessionLabel(item.sessionId);
  const mode = item.mode ?? "chat";
  const delegatedLabel = item.delegationParent?.label?.trim() || item.delegationParent?.role?.trim();
  const meta = delegatedLabel
    ? `Delegated task · ${delegatedLabel}`
    : item.projectName?.trim() || item.channel?.trim() || "Workspace session";
  const updatedAtLabel = formatRelativeTime(item.updatedAt);

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
            <span className={`mc-next-threaded-mode-label mode-${mode}`}>{MODE_META[mode].label}</span>
            <strong>{label}</strong>
            <span title={meta}>{meta}</span>
          </div>
          <time className="mc-next-threaded-session-time" dateTime={item.updatedAt}>
            {updatedAtLabel}
          </time>
        </div>
      </button>
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
