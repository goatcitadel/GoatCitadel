import { CHAT_MODE_PRESETS, type ChatMode, type ChatSessionRecord } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { FieldHelp } from "../../components/FieldHelp";
import { ChatSessionRail } from "../../components/chat/ChatSessionRail";

export function ChatSessionSidebar(props: {
  sending: boolean;
  creatingSessionMode: ChatMode | null;
  showProjectCreate: boolean;
  search: string;
  projectName: string;
  projectPath: string;
  selectedProjectId: string;
  missionSessions: Array<ChatSessionRecord & { projectName?: string | null }>;
  externalSessions: Array<ChatSessionRecord & { channel?: string | null; account?: string | null }>;
  selectedSessionId: string | null;
  onCreateSession: (mode: ChatMode) => void;
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
    sending,
    creatingSessionMode,
    showProjectCreate,
    search,
    projectName,
    projectPath,
    selectedProjectId,
    missionSessions,
    externalSessions,
    selectedSessionId,
    onCreateSession,
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
      <div className="chat-v11-left-head">
        <div className="chat-v11-left-actions">
          <div className="chat-v11-row-actions">
            {(["chat", "cowork", "code"] as const).map((mode) => (
              <ActionButton
                key={mode}
                label={`New ${CHAT_MODE_PRESETS[mode].label}`}
                variant={mode === "chat" ? "primary" : mode === "cowork" ? "secondary" : "tertiary"}
                pending={creatingSessionMode === mode}
                disabled={sending || Boolean(creatingSessionMode)}
                onClick={() => onCreateSession(mode)}
              />
            ))}
          </div>
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
