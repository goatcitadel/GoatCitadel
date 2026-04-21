import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import { FieldHelp } from "../../components/FieldHelp";
import { ChatSessionRail } from "../../components/chat/ChatSessionRail";
import { getMissionControlSurfaceConfig } from "./surface-config";

function formatSummaryCount(value: string, label: string) {
  const lowerLabel = label.toLowerCase();
  if (value === "1" && lowerLabel.endsWith("s")) {
    return `${value} ${lowerLabel.slice(0, -1)}`;
  }
  return `${value} ${lowerLabel}`;
}

export function ChatSessionSidebar(props: {
  mode: ChatMode;
  showProjectCreate: boolean;
  creatingSession: boolean;
  search: string;
  projectName: string;
  projectPath: string;
  historyView: "active" | "archived";
  selectedProjectId: string;
  availableFolders: Array<{ folderId: string; name: string; count: number }>;
  selectedFolderId: string;
  selectedTag: string | null;
  missionSessions: Array<ChatSessionRecord & { projectName?: string | null }>;
  externalSessions: Array<ChatSessionRecord & { channel?: string | null; account?: string | null }>;
  selectedSessionId: string | null;
  summaryTitle: string;
  summaryCopy: string;
  workspaceSummaryCards: Array<{ label: string; value: string }>;
  archiveWorkspaceEnabled?: boolean;
  archiveWorkspacePending?: boolean;
  onToggleProjectCreate: () => void;
  onCreateSession: () => void;
  onSearchChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onProjectPathChange: (value: string) => void;
  onCreateProject: () => void;
  onHistoryViewChange: (view: "active" | "archived") => void;
  onArchiveWorkspace?: () => void;
  onSelectProjectId: (projectId: string) => void;
  onSelectFolderId: (folderId: string) => void;
  onSelectTag: (tag: string | null) => void;
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
  renderSessionLabel: (sessionId: string) => string;
}) {
  const {
    mode,
    showProjectCreate,
    creatingSession,
    search,
    projectName,
    projectPath,
    historyView,
    selectedProjectId,
    availableFolders,
    selectedFolderId,
    selectedTag,
    missionSessions,
    externalSessions,
    selectedSessionId,
    summaryTitle,
    summaryCopy,
    workspaceSummaryCards,
    archiveWorkspaceEnabled = false,
    archiveWorkspacePending = false,
    onToggleProjectCreate,
    onCreateSession,
    onSearchChange,
    onProjectNameChange,
    onProjectPathChange,
    onCreateProject,
    onHistoryViewChange,
    onArchiveWorkspace,
    onSelectProjectId,
    onSelectFolderId,
    onSelectTag,
    onSelectSession,
    renderSessionLabel,
  } = props;
  const surfaceConfig = getMissionControlSurfaceConfig(mode);
  const projectHint =
    mode === "chat"
      ? "Projects are optional here. Stay lightweight unless the conversation needs a more durable workspace."
      : mode === "cowork"
        ? "Projects help keep orchestration grouped by objective."
        : "Project binding keeps code sessions precise and repo-aware.";
  const visibleSummaryCards = mode === "chat" ? workspaceSummaryCards : workspaceSummaryCards.slice(0, 2);
  const workspaceSummaryLine =
    mode === "chat" ? visibleSummaryCards.map((item) => formatSummaryCount(item.value, item.label)).join(" • ") : null;
  const totalConversationCount = missionSessions.length + externalSessions.length;

  return (
    <aside className={`panel panel-soft panel-pad-default chat-v11-left mode-${mode}`}>
      <div className="chat-v11-workspace-summary">
        <div className="chat-v11-workspace-copy">
          <h3>{summaryTitle}</h3>
          {mode === "chat" ? <p className="chat-v11-muted">{summaryCopy}</p> : null}
        </div>
        {workspaceSummaryLine ? (
          <p className="chat-v11-summary-line">{workspaceSummaryLine}</p>
        ) : (
          <div className="chat-v11-summary-grid">
            {visibleSummaryCards.map((item) => (
              <div key={item.label} className="chat-v11-summary-card">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chat-v11-left-head">
        <div className="chat-v11-left-actions">
          <button
            type="button"
            className="gc-button chat-v11-project-toggle chat-v11-session-launch active"
            disabled={creatingSession}
            onClick={onCreateSession}
          >
            {creatingSession
              ? `Starting ${surfaceConfig.label.toLowerCase()}...`
              : mode === "code"
                ? "Start code session"
                : mode === "chat"
                  ? "Start chat"
                  : `Start ${surfaceConfig.label.toLowerCase()} session`}
          </button>
          <button
            type="button"
            className={[
              "gc-nav-button",
              "gc-nav-tier-chip",
              `chat-v11-project-toggle${showProjectCreate ? " active" : ""}`,
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={onToggleProjectCreate}
          >
            {showProjectCreate ? "Hide project form" : "Project"}
          </button>
        </div>
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search conversations"
        />
      </div>
      <p className="chat-v11-rail-posture">
        {totalConversationCount === 0
          ? "No conversations yet. Start a fresh session or bind one to a project."
          : `${totalConversationCount} conversation${totalConversationCount === 1 ? "" : "s"} across mission and external threads.`}
      </p>
      {mode === "chat" ? (
        <FieldHelp>Mission chats stay local unless a bound integration is explicitly in play.</FieldHelp>
      ) : null}
      <div className="chat-v11-filter-row chat-v11-filter-row-compact">
        <button
          type="button"
          className={["gc-button", historyView === "active" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => onHistoryViewChange("active")}
        >
          Active
        </button>
        <button
          type="button"
          className={["gc-button", historyView === "archived" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => onHistoryViewChange("archived")}
        >
          Archived
        </button>
        <button
          type="button"
          className={["gc-button", selectedProjectId === "all" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => onSelectProjectId("all")}
        >
          All projects
        </button>
        <button
          type="button"
          className={["gc-button", selectedProjectId === "none" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => onSelectProjectId("none")}
        >
          Unassigned
        </button>
        <button
          type="button"
          className={["gc-button", selectedFolderId === "all" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => onSelectFolderId("all")}
        >
          All folders
        </button>
        <button
          type="button"
          className={["gc-button", selectedFolderId === "none" ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => onSelectFolderId("none")}
        >
          No folder
        </button>
        {archiveWorkspaceEnabled && onArchiveWorkspace ? (
          <button
            type="button"
            className="gc-button danger"
            disabled={archiveWorkspacePending}
            onClick={onArchiveWorkspace}
          >
            {archiveWorkspacePending ? "Archiving..." : "Archive workspace chats"}
          </button>
        ) : null}
      </div>
      {availableFolders.length > 0 ? (
        <div className="chat-v11-filter-row chat-v11-filter-row-compact">
          {availableFolders.map((folder) => (
            <button
              key={folder.folderId}
              type="button"
              className={["gc-nav-button", selectedFolderId === folder.folderId ? "active" : ""]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectFolderId(folder.folderId)}
            >
              {folder.name} ({folder.count})
            </button>
          ))}
          {selectedTag ? (
            <button type="button" className="gc-nav-button active" onClick={() => onSelectTag(null)}>
              Tag: #{selectedTag} ×
            </button>
          ) : null}
        </div>
      ) : selectedTag ? (
        <div className="chat-v11-filter-row chat-v11-filter-row-compact">
          <button type="button" className="gc-nav-button active" onClick={() => onSelectTag(null)}>
            Tag: #{selectedTag} ×
          </button>
        </div>
      ) : null}
      {showProjectCreate ? (
        <div className="chat-v11-project-create">
          <input
            value={projectName}
            onChange={(event) => onProjectNameChange(event.target.value)}
            placeholder="New project name"
          />
          <input
            value={projectPath}
            onChange={(event) => onProjectPathChange(event.target.value)}
            placeholder="Project path (optional)"
          />
          <p className="chat-v11-muted">{projectHint}</p>
          <button type="button" onClick={onCreateProject} className="gc-button">
            Create project
          </button>
        </div>
      ) : null}
      <ChatSessionRail
        missionSessions={missionSessions}
        externalSessions={externalSessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelectSession}
        selectedTag={selectedTag}
        onSelectTag={onSelectTag}
        renderSessionLabel={renderSessionLabel}
        mode={mode}
      />
    </aside>
  );
}
