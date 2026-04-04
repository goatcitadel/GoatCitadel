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
  const railHint = mode === "chat"
    ? "Keep the rail quiet: jump between conversations fast, but let the active thread do most of the work."
    : mode === "cowork"
      ? "Use the rail like an operations queue: move between live runs, orchestration threads, and the next workflow to steer."
      : "Use the rail like an implementation queue: keep project-bound sessions tight and jump straight into the active code thread.";
  const projectHint = mode === "chat"
    ? "Projects are optional here. Stay lightweight unless the conversation needs a more durable workspace."
    : mode === "cowork"
      ? "Projects help keep orchestration work grouped by objective, but you can still steer ad hoc runs from the queue."
      : "Projects matter more in Code because binding execution to a workspace improves precision and artifact handling.";

  return (
    <aside className={`panel panel-soft panel-pad-default chat-v11-left mode-${mode}`}>
      <div className="chat-v11-workspace-summary">
        <div className="chat-v11-workspace-copy">
          <p className="chat-v11-workspace-kicker">{surfaceConfig.shellEyebrow}</p>
          <h3>{summaryTitle}</h3>
          <p className="chat-v11-muted">{summaryCopy}</p>
          <p className="chat-v11-rail-posture">{railHint}</p>
        </div>
        <div className="chat-v11-summary-grid">
          {workspaceSummaryCards.map((item) => (
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
            className="chat-v11-project-toggle chat-v11-session-launch active"
            disabled={creatingSession}
            onClick={onCreateSession}
          >
            {creatingSession ? `Starting ${surfaceConfig.label.toLowerCase()}...` : mode === "code" ? "Start code session" : `New ${surfaceConfig.label.toLowerCase()} session`}
          </button>
          <button
            type="button"
            className={`chat-v11-project-toggle${showProjectCreate ? " active" : ""}`}
            onClick={onToggleProjectCreate}
          >
            {showProjectCreate ? "Hide project form" : "New project"}
          </button>
        </div>
        <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Find a chat..." />
      </div>
      <FieldHelp>{mode === "code" ? "Code sessions stay local-first and become safer once a project binding is in place. External chats can write back only when a binding is configured." : "Mission chats stay local. External chats can write back only when a binding is configured."}</FieldHelp>
      <div className="chat-v11-filter-row">
        <button type="button" className={historyView === "active" ? "active" : ""} onClick={() => onHistoryViewChange("active")}>Active</button>
        <button type="button" className={historyView === "archived" ? "active" : ""} onClick={() => onHistoryViewChange("archived")}>Archived</button>
        {archiveWorkspaceEnabled && onArchiveWorkspace ? (
          <button type="button" className="danger" disabled={archiveWorkspacePending} onClick={onArchiveWorkspace}>
            {archiveWorkspacePending ? "Archiving..." : "Archive workspace chats"}
          </button>
        ) : null}
      </div>
      <FieldHelp>Normal history defaults to active chats. Archived chats stay out of the default rail until you switch to the archived view.</FieldHelp>
      {showProjectCreate ? (
        <div className="chat-v11-project-create">
          <input value={projectName} onChange={(event) => onProjectNameChange(event.target.value)} placeholder="New project name" />
          <input value={projectPath} onChange={(event) => onProjectPathChange(event.target.value)} placeholder="Project path (optional)" />
          <p className="chat-v11-muted">{projectHint}</p>
          <button type="button" onClick={onCreateProject}>Create project</button>
        </div>
      ) : null}
      <div className="chat-v11-filter-row">
        <button type="button" className={selectedProjectId === "all" ? "active" : ""} onClick={() => onSelectProjectId("all")}>All projects</button>
        <button type="button" className={selectedProjectId === "none" ? "active" : ""} onClick={() => onSelectProjectId("none")}>Unassigned</button>
      </div>
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
