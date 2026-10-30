import type { Dispatch, RefObject, SetStateAction } from "react";
import { FolderPlus, Pencil, Save } from "lucide-react";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { NativeCard } from "../NativeRoutePageLayout";
import { NativeButton } from "../primitives";

export type ProjectDraft = { name: string; workspacePath: string; description: string };

type ProjectEditorCardProps = {
  editor: "create" | "edit";
  routedProject: ChatProjectRecord | null;
  createDraft: ProjectDraft;
  setCreateDraft: Dispatch<SetStateAction<ProjectDraft>>;
  editDraft: ProjectDraft;
  setEditDraft: Dispatch<SetStateAction<ProjectDraft>>;
  projectActionBusy: string | null;
  createProjectNameRef: RefObject<HTMLInputElement | null>;
  onCreate: () => void;
  onSave: () => void;
};

export function ProjectEditorCard({
  editor,
  routedProject,
  createDraft,
  setCreateDraft,
  editDraft,
  setEditDraft,
  projectActionBusy,
  createProjectNameRef,
  onCreate,
  onSave,
}: ProjectEditorCardProps) {
  return (
    <NativeCard
      className="mc-next-project-controls-card"
      title={editor === "create" ? "Create project" : "Project details"}
      subtitle={
        routedProject
          ? "Create a new project or rename the selected one. Pin and archive live on each card."
          : "Create a project here, or select one from the list to open its threads and edit its details."
      }
      density="compact"
      scrollBody
      bodyMaxHeight="min(70vh, 42rem)"
    >
      <div className="mc-next-project-controls">
        {editor === "create" ? (
          <section className="mc-next-project-control-section">
            <div className="mc-next-project-control-heading">
              <FolderPlus size={16} />
              <strong>Create project</strong>
            </div>
            <label className="mc-next-settings-field">
              <span>Name</span>
              <input
                aria-label="New project name"
                ref={createProjectNameRef}
                className="mc-next-settings-input"
                value={createDraft.name}
                onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Release readiness"
              />
            </label>
            <label className="mc-next-settings-field">
              <span>Workspace path</span>
              <input
                aria-label="New project workspace path"
                className="mc-next-settings-input"
                value={createDraft.workspacePath}
                onChange={(event) => setCreateDraft((current) => ({ ...current, workspacePath: event.target.value }))}
                placeholder="Local project path"
              />
            </label>
            <label className="mc-next-settings-field">
              <span>Description</span>
              <textarea
                aria-label="New project description"
                className="mc-next-settings-textarea"
                value={createDraft.description}
                onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder="What this project is for."
              />
            </label>
            <NativeButton
              aria-label="Create project from form"
              disabled={projectActionBusy === "create"}
              onClick={onCreate}
            >
              <FolderPlus size={16} />
              {projectActionBusy === "create" ? "Creating..." : "Create project"}
            </NativeButton>
          </section>
        ) : null}

        {routedProject && editor === "edit" ? (
          <section className="mc-next-project-control-section">
            <div className="mc-next-project-control-heading">
              <Pencil size={16} />
              <strong>Edit selected</strong>
            </div>
            <label className="mc-next-settings-field">
              <span>Name</span>
              <input
                className="mc-next-settings-input"
                aria-label="Edit project name"
                value={editDraft.name}
                onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="mc-next-settings-field">
              <span>Workspace path</span>
              <input
                className="mc-next-settings-input"
                aria-label="Edit project workspace path"
                value={editDraft.workspacePath}
                onChange={(event) => setEditDraft((current) => ({ ...current, workspacePath: event.target.value }))}
              />
            </label>
            <label className="mc-next-settings-field">
              <span>Description</span>
              <textarea
                className="mc-next-settings-textarea"
                aria-label="Edit project description"
                value={editDraft.description}
                onChange={(event) => setEditDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </label>
            <div className="mc-next-settings-button-row">
              <NativeButton disabled={projectActionBusy === "save"} onClick={onSave}>
                <Save size={16} />
                {projectActionBusy === "save" ? "Saving..." : "Save project"}
              </NativeButton>
            </div>
            <p className="mc-next-settings-field-note">
              Revision {routedProject.revision} fences concurrent edits. Pin or archive {routedProject.name} from the
              card glyphs in the projects list.
            </p>
          </section>
        ) : null}
      </div>
    </NativeCard>
  );
}
