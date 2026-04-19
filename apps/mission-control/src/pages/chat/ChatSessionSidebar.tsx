import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import { FieldHelp } from "../../components/FieldHelp";
import { ChatSessionRail } from "../../components/chat/ChatSessionRail";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function ChatSessionSidebar(props: {
  mode: ChatMode;
  showProjectCreate: boolean;
  creatingSession: boolean;
  search: string;
  projectName: string;
  projectPath: string;
  historyView: "active" | "archived";
  selectedProjectId: string;
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
  onSelectSession: (sessionId: string) => void;
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

  return (
    <aside className={`panel panel-soft panel-pad-default chat-v11-left mode-${mode}`}>
      <div className="chat-v11-workspace-summary">
        <div className="chat-v11-workspace-copy">
          <h3>{summaryTitle}</h3>
          {mode === "chat" ? <p className="chat-v11-muted">{summaryCopy}</p> : null}
        </div>
        <div className="chat-v11-summary-grid">
          {visibleSummaryCards.map((item) => (
            <div key={item.label} className="chat-v11-summary-card">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
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
                : `New ${surfaceConfig.label.toLowerCase()} session`}
          </button>
          <button
            type="button"
            className={["gc-button", `chat-v11-project-toggle${showProjectCreate ? " active" : ""}`]
              .filter(Boolean)
              .join(" ")}
            onClick={onToggleProjectCreate}
          >
            {showProjectCreate ? "Hide project form" : "New project"}
          </button>
        </div>
        <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Find a chat..." />
      </div>
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
        renderSessionLabel={renderSessionLabel}
        mode={mode}
      />
    </aside>
  );
}
