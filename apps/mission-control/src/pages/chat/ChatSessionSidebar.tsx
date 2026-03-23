import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { FieldHelp } from "../../components/FieldHelp";
import { ChatSessionRail } from "../../components/chat/ChatSessionRail";

export function ChatSessionSidebar(props: {
  showProjectCreate: boolean;
  search: string;
  projectName: string;
  projectPath: string;
  selectedProjectId: string;
  missionSessions: Array<ChatSessionRecord & { projectName?: string | null }>;
  externalSessions: Array<ChatSessionRecord & { channel?: string | null; account?: string | null }>;
  selectedSessionId: string | null;
  summaryTitle: string;
  summaryCopy: string;
  workspaceSummaryCards: Array<{ label: string; value: string }>;
  onToggleProjectCreate: () => void;
  onSearchChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onProjectPathChange: (value: string) => void;
  onCreateProject: () => void;
  onSelectProjectId: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  renderSessionLabel: (sessionId: string) => string;
}) {
  const {
    showProjectCreate,
    search,
    projectName,
    projectPath,
    selectedProjectId,
    missionSessions,
    externalSessions,
    selectedSessionId,
    summaryTitle,
    summaryCopy,
    workspaceSummaryCards,
    onToggleProjectCreate,
    onSearchChange,
    onProjectNameChange,
    onProjectPathChange,
    onCreateProject,
    onSelectProjectId,
    onSelectSession,
    renderSessionLabel,
  } = props;

  return (
    <aside className="panel panel-soft panel-pad-default chat-v11-left">
      <div className="chat-v11-workspace-summary">
        <div className="chat-v11-workspace-copy">
          <p className="chat-v11-workspace-kicker">Workspace</p>
          <h3>{summaryTitle}</h3>
          <p className="chat-v11-muted">{summaryCopy}</p>
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
            className={`chat-v11-project-toggle${showProjectCreate ? " active" : ""}`}
            onClick={onToggleProjectCreate}
          >
            {showProjectCreate ? "Hide project form" : "New project"}
          </button>
        </div>
        <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Find a chat..." />
      </div>
      <FieldHelp>Mission chats stay local. External chats can write back only when a binding is configured.</FieldHelp>
      {showProjectCreate ? (
        <div className="chat-v11-project-create">
          <input value={projectName} onChange={(event) => onProjectNameChange(event.target.value)} placeholder="New project name" />
          <input value={projectPath} onChange={(event) => onProjectPathChange(event.target.value)} placeholder="Project path (optional)" />
          <p className="chat-v11-muted">
            Project creation is optional. Stay in <strong>Chat</strong> for quick work, or use <strong>Code</strong> when you are ready to bind implementation to a project.
          </p>
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
      />
    </aside>
  );
}
