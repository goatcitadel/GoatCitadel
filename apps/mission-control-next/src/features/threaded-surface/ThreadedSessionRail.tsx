import type { ReactNode, Ref } from "react";
import { FolderPlus, MessageSquareText, Search, X } from "lucide-react";
import { SidebarChatPortal } from "@next/app/UnifiedSidebar";
import type {
  MissionThreadedRenderSurfaceInput,
  groupDelegatedSessionsForRail,
} from "@goatcitadel/threaded-surface-core";
import { SessionGroup } from "./ThreadedSessionGroup";

export function ThreadedSessionRail({
  input,
  railPanelRef,
  railCloseButtonRef,
  railDrawerOpen,
  embeddedRail,
  railDrawerLayout,
  railOpen,
  closeSessionRail,
  handleCreateSessionFromRail,
  handleArchiveWorkspace,
  missionSessionGroups,
  externalSessionGroups,
  onSelectMissionSession,
  onSelectExternalSession,
}: {
  input: MissionThreadedRenderSurfaceInput;
  railPanelRef: Ref<HTMLElement>;
  railCloseButtonRef: Ref<HTMLButtonElement>;
  railDrawerOpen: boolean;
  embeddedRail: boolean;
  railDrawerLayout: boolean;
  railOpen: boolean;
  closeSessionRail: () => void;
  handleCreateSessionFromRail: () => void;
  handleArchiveWorkspace: () => void;
  missionSessionGroups: ReturnType<typeof groupDelegatedSessionsForRail>;
  externalSessionGroups: ReturnType<typeof groupDelegatedSessionsForRail>;
  onSelectMissionSession: MissionThreadedRenderSurfaceInput["sessionRail"]["onSelectSession"];
  onSelectExternalSession: MissionThreadedRenderSurfaceInput["sessionRail"]["onSelectSession"];
}) {
  return (
    <SidebarChatPortal>
      <aside
        id="mc-next-threaded-session-rail"
        ref={railPanelRef}
        className={`mc-next-threaded-rail${railDrawerOpen ? " open" : ""}`}
        role={!embeddedRail && railDrawerLayout ? "dialog" : "complementary"}
        aria-label="Threads"
        aria-modal={!embeddedRail && railDrawerLayout ? true : undefined}
        tabIndex={railDrawerLayout ? -1 : undefined}
        aria-hidden={!railOpen}
        inert={!railOpen}
        hidden={!railDrawerLayout && !railOpen}
      >
        <div className="mc-next-threaded-rail-head">
          <div>
            <p>Threads</p>
            <h2>{input.sessionRail.summaryTitle}</h2>
            <span>Conversation, planning, and build threads stay connected by project.</span>
          </div>
          <button
            ref={railCloseButtonRef}
            type="button"
            className="mc-next-threaded-menu-button"
            onClick={() => closeSessionRail()}
            aria-label="Close session rail"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mc-next-threaded-rail-actions">
          <button type="button" className="mc-next-threaded-primary" onClick={handleCreateSessionFromRail}>
            <MessageSquareText size={16} />
            <span>New chat</span>
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
          onSelectSession={onSelectMissionSession}
          renderSessionLabel={input.sessionRail.renderSessionLabel}
          nestedChildrenByParentId={missionSessionGroups.delegatedChildrenByParentId}
          orphanDelegatedItems={missionSessionGroups.orphanDelegatedSessions}
        />
        <SessionGroup
          title="External bindings"
          items={externalSessionGroups.topLevelSessions}
          count={externalSessionGroups.topLevelSessions.length}
          selectedSessionId={input.sessionRail.selectedSessionId}
          onSelectSession={onSelectExternalSession}
          renderSessionLabel={input.sessionRail.renderSessionLabel}
          nestedChildrenByParentId={externalSessionGroups.delegatedChildrenByParentId}
          orphanDelegatedItems={externalSessionGroups.orphanDelegatedSessions}
          emptyCopy="External bindings show up here when a thread is linked out."
        />
      </aside>
    </SidebarChatPortal>
  );
}

function FilterChip({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`mc-next-threaded-filter${active ? " active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}
