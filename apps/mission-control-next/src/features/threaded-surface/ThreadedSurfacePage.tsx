import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Code2, FolderPlus, Menu, MessageSquareText, PanelRight, Search, Workflow } from "lucide-react";
import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedDropTargetProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { groupDelegatedSessionsForRail } from "@goatcitadel/threaded-surface-core";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { ChatModelPicker } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
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
import { ThreadedContextDrawer } from "./ThreadedContextDrawer";
import { ThreadedTimeline } from "./ThreadedTimeline";
import { ThreadedWorkflowPanel } from "./ThreadedWorkflowPanel";
import "./threaded-surface.css";

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

export function ThreadedSurfacePage({
  surface,
  input,
}: {
  surface: ChatMode;
  input: MissionThreadedRenderSurfaceInput;
}) {
  const compactLayout = useMediaQuery("(max-width: 1180px)");
  const railOpen = input.sessionRailOpen;
  const dockOpen = input.dockOpen && Boolean(input.activeSessionSurfaceProps);
  const activeProps = input.activeSessionSurfaceProps;
  const workflowPanel = input.workflowPanel;
  const activeMode = activeProps?.mode ?? surface;
  const modeMeta = MODE_META[activeMode];
  const [codeWorkbenchOpen, setCodeWorkbenchOpen] = useState(true);
  const [postureFilter, setPostureFilter] = useState<ChatMode | "all">("all");
  const workflowPanelOpen = Boolean(workflowPanel && (workflowPanel.kind !== "code" || codeWorkbenchOpen));
  const filterSessionsByPosture = useMemo(
    () => (items: Array<ChatSessionRecord & { projectName?: string | null }>) =>
      postureFilter === "all" ? items : items.filter((item) => (item.mode ?? "chat") === postureFilter),
    [postureFilter],
  );
  const missionSessionGroups = useMemo(
    () => groupDelegatedSessionsForRail(filterSessionsByPosture(input.sessionRail.missionSessions)),
    [filterSessionsByPosture, input.sessionRail.missionSessions],
  );
  const externalSessionGroups = useMemo(
    () => groupDelegatedSessionsForRail(filterSessionsByPosture(input.sessionRail.externalSessions)),
    [filterSessionsByPosture, input.sessionRail.externalSessions],
  );
  const allSessionCount = input.sessionRail.missionSessions.length + input.sessionRail.externalSessions.length;
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
  const handleArchiveWorkspace = () => {
    if (
      !input.sessionRail.archiveWorkspaceEnabled ||
      input.sessionRail.archiveWorkspacePending ||
      !input.sessionRail.onConfirmArchiveWorkspace
    ) {
      return;
    }
    const count = input.sessionRail.archiveWorkspaceCount ?? 0;
    const message =
      count > 0
        ? `Archive ${count} active mission chats in this workspace? Archived chats leave the default history rail but stay recoverable from Archived view.`
        : "Archive active mission chats in this workspace?";
    if (typeof window !== "undefined" && !window.confirm(message)) {
      return;
    }
    input.sessionRail.onConfirmArchiveWorkspace();
  };

  return (
    <div className="mc-next-threaded-surface unified" data-mode={surface} data-active-mode={activeMode}>
      <button
        type="button"
        className={`mc-next-threaded-scrim${railOpen ? " open" : ""}`}
        aria-hidden={!railOpen}
        tabIndex={railOpen ? 0 : -1}
        onClick={() => input.onSessionRailOpenChange(false)}
      />

      <aside className={`mc-next-threaded-rail${railOpen ? " open" : ""}`}>
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

        <div className="mc-next-threaded-filters posture">
          <FilterChip active={postureFilter === "all"} onClick={() => setPostureFilter("all")}>
            All {allSessionCount}
          </FilterChip>
          {(Object.keys(MODE_META) as ChatMode[]).map((mode) => (
            <FilterChip key={mode} active={postureFilter === mode} onClick={() => setPostureFilter(mode)}>
              <span className={`mc-next-threaded-mode-dot mode-${mode}`} />
              {MODE_META[mode].label}
            </FilterChip>
          ))}
        </div>

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

      <section className={stageLayoutClass}>
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
                onClick={() => input.onDockOpenChange(!input.dockOpen)}
              >
                <PanelRight size={16} />
                <span>{input.dockOpen ? "Hide context" : "Context"}</span>
              </button>
            ) : null}
          </div>

          {activeProps ? (
            <ThreadConversationSurface
              surface={activeProps.mode}
              compactLayout={compactLayout}
              props={activeProps}
              dropTarget={input.dropTargetProps}
              onToggleDock={() => input.onDockOpenChange(!input.dockOpen)}
              codeWorkbenchOpen={codeWorkbenchOpen}
              onToggleCodeWorkbench={
                workflowPanel?.kind === "code" ? () => setCodeWorkbenchOpen((current) => !current) : undefined
              }
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
            <ThreadedWorkflowPanel panel={workflowPanel} />
          </aside>
        ) : null}

        {dockOpen && input.contextDockProps ? (
          <aside className="mc-next-threaded-context-panel">
            <ThreadedContextDrawer surface={activeMode} props={input.contextDockProps} />
          </aside>
        ) : null}
      </section>
    </div>
  );
}

function ThreadConversationSurface({
  surface,
  compactLayout,
  props,
  dropTarget,
  onToggleDock,
  codeWorkbenchOpen,
  onToggleCodeWorkbench,
}: {
  surface: ChatMode;
  compactLayout: boolean;
  props: MissionThreadedActiveSessionSurfaceProps;
  dropTarget: MissionThreadedDropTargetProps;
  onToggleDock: () => void;
  codeWorkbenchOpen: boolean;
  onToggleCodeWorkbench?: () => void;
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
            <button
              type="button"
              className="mc-next-threaded-secondary"
              disabled={props.sessionArchivePending}
              onClick={props.onToggleArchiveSession}
            >
              {getArchiveActionLabel(props.sessionLifecycleStatus, props.sessionArchivePending)}
            </button>
            <button type="button" className="mc-next-threaded-secondary" onClick={onToggleDock}>
              {props.dockOpen ? "Hide context" : "Show context"}
            </button>
          </div>
        </div>
      </header>

      <section className={`mc-next-threaded-conversation${compactLayout ? " compact" : ""}`}>
        <div className="mc-next-threaded-thread-card">
          <ThreadedTimeline props={props} />
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
      <div className="mc-next-threaded-empty-actions">
        <button type="button" className="mc-next-threaded-primary" onClick={input.emptyStateProps.onCreateSession}>
          Start {MODE_META[surface].label.toLowerCase()}
        </button>
        <button type="button" className="mc-next-threaded-secondary" onClick={dropTarget.onAttachFiles}>
          Attach files
        </button>
        {surface === "chat" ? (
          <>
            <button type="button" className="mc-next-threaded-secondary" onClick={input.emptyStateProps.onOpenCowork}>
              Open Cowork
            </button>
            <button type="button" className="mc-next-threaded-secondary" onClick={input.emptyStateProps.onOpenCode}>
              Open Code
            </button>
          </>
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
