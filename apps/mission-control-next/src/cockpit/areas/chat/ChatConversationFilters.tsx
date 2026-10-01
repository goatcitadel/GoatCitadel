import { useState } from "react";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";

export type ChatProjectFilterOption = { value: string; label: string };
type FilterRail = Pick<MissionThreadedSessionRailData,
  "availableFolders" | "selectedFolderId" | "onSelectFolderId" | "selectedProjectId" | "onSelectProjectId" | "search" | "onSearchChange"
>;

/** Presentation for the shared Chat controller's existing project, folder and search state. */
export function ChatConversationFilters({ rail, projectOptions = [] }: {
  rail: FilterRail;
  projectOptions?: readonly ChatProjectFilterOption[];
}) {
  const [foldersOpen, setFoldersOpen] = useState(true);
  const projectId = rail.selectedProjectId ?? "all";
  const folderId = rail.selectedFolderId ?? "all";
  const projects = projectOptions.filter((option) => option.value !== "all" && option.value !== "none");
  const missingProject = !["all", "none"].includes(projectId) && !projects.some((option) => option.value === projectId);
  const missingFolder = !["all", "none"].includes(folderId) && !rail.availableFolders.some((folder) => folder.folderId === folderId);
  return <div className="space-y-2">
    <label className="block text-xs text-fg-muted">Project
      <select aria-label="Filter by project" value={projectId} onChange={(event) => rail.onSelectProjectId(event.target.value)}
        className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg">
        <option value="all">All projects</option>
        <option value="none">Unassigned</option>
        {missingProject ? <option value={projectId}>Current project · unavailable in this catalog</option> : null}
        {projects.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    {rail.availableFolders.length || folderId !== "all" ? <details className="rounded-md border border-line-subtle bg-canvas" open={foldersOpen}
      onToggle={(event) => setFoldersOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer px-2 py-1.5 text-xs font-semibold text-fg-secondary">Folders</summary>
      <div className="grid max-h-40 gap-0.5 overflow-y-auto px-1 pb-1">
        <button type="button" aria-pressed={folderId === "all"} onClick={() => rail.onSelectFolderId("all")}
          className="rounded-md px-2 py-1 text-left text-xs text-fg-secondary hover:bg-sunken aria-[pressed=true]:bg-sunken aria-[pressed=true]:text-fg">All conversations</button>
        <button type="button" aria-pressed={folderId === "none"} onClick={() => rail.onSelectFolderId("none")}
          className="rounded-md px-2 py-1 text-left text-xs text-fg-secondary hover:bg-sunken aria-[pressed=true]:bg-sunken">No folder</button>
        {missingFolder ? <p className="px-2 py-1 text-xs text-fg-muted">The selected folder has no conversations in these results. Choose All conversations to clear it.</p> : null}
        {rail.availableFolders.map((folder) => <button key={folder.folderId} type="button" aria-pressed={folderId === folder.folderId}
          onClick={() => rail.onSelectFolderId(folder.folderId)}
          className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs text-fg-secondary hover:bg-sunken aria-[pressed=true]:bg-sunken aria-[pressed=true]:text-fg">
          <span className="truncate">{folder.name}</span><span className="tabular-nums text-fg-muted">{folder.count}</span>
        </button>)}
      </div>
    </details> : null}
    <label className="block text-xs text-fg-muted">Search
      <input aria-label="Search conversations" value={rail.search} onChange={(event) => rail.onSearchChange(event.target.value)} placeholder="Find a thread"
        className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg" />
    </label>
  </div>;
}
