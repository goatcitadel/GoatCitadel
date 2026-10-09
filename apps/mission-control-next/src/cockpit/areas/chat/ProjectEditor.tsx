import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useRef, useState } from "react";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { createChatProject, updateChatProject } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Callout } from "../../ui/Callout";
import { UnattributedDraftRecovery } from "../work/UnattributedDraftRecovery";

const fields = (project?: ChatProjectRecord) => ({
  name: project?.name ?? "",
  workspacePath: project?.workspacePath ?? "",
  description: project?.description ?? "",
  color: project?.color ?? "",
});
export function ProjectEditor({
  project,
  workspaceId,
  citadelId,
  onSaved,
  onClose,
  refresh,
  available,
}: {
  project?: ChatProjectRecord;
  workspaceId: string;
  citadelId?: string;
  available: boolean;
  onSaved: (project: ChatProjectRecord) => void;
  onClose: () => void;
  refresh: () => Promise<unknown>;
}) {
  const access = useProjectAccess(JSON.stringify([citadelId, workspaceId, project?.projectId ?? "create"]));
  const draft = useSessionDraft(
    JSON.stringify(["cockpit-project", getGatewayApiBaseUrl(), citadelId, workspaceId, project?.projectId ?? "create"]),
    fields(project),
    project?.revision,
    { label: project?.name ?? "New project", available },
  );
  const leave = useDraftLeave();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function save() {
    if (
      !access.current() ||
      pending.current ||
      !available ||
      draft.hasRemoteChanges ||
      (project && project.lifecycleStatus !== "active")
    )
      return;
    const submitted = draft.value;
    if (!submitted.name.trim() || !submitted.workspacePath.trim()) {
      setError("Project name and workspace path are required.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const input = {
        citadelId,
        workspaceId,
        name: submitted.name.trim(),
        workspacePath: submitted.workspacePath.trim(),
        description: submitted.description.trim(),
        color: project ? submitted.color.trim() : submitted.color.trim() || undefined,
      };
      const result = project
        ? await updateChatProject(project.projectId, { ...input, expectedRevision: draft.baseRevision as number })
        : await createChatProject(input);
      if (!access.current()) return;
      if (result.workspaceId !== workspaceId || (project && result.projectId !== project.projectId))
        throw new Error("The response did not confirm this project. Refresh before retrying.");
      const clean = draft.acceptSaved(
        project ? fields(result) : fields(),
        project ? result.revision : undefined,
        submitted,
      );
      await refresh();
      if (access.current() && clean) onSaved(result);
    } catch (cause) {
      if (!access.current()) return;
      setError(
        `${describeApiError(cause).summary} Your draft is preserved. Refresh the canonical project before retrying.`,
      );
      await refresh();
    } finally {
      if (access.current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section
      aria-label={project ? "Edit project" : "Create project"}
      className="grid w-full min-w-0 max-w-full grid-cols-1 gap-3 break-words rounded-lg border border-line p-4"
    >
      <h2 className="font-display text-lg">{project ? "Edit project" : "Create project"}</h2>
      <p className="text-sm text-fg-secondary">
        Workspace {workspaceId}. Project context and its workspace path apply to future work; existing conversation
        history remains retained.
      </p>
      <UnattributedDraftRecovery editor={draft} />
      {error ? <Callout tone="error">{error}</Callout> : null}
      {!available ? (
        <Callout tone="warning">Current project access is unavailable. Your draft is retained.</Callout>
      ) : null}
      {draft.hasRemoteChanges ? (
        <Callout tone="warning">
          <p>
            This project changed elsewhere. Your draft is preserved. Current saved project: {project?.name};{" "}
            {project?.workspacePath}; {project?.description || "No description"}; color {project?.color || "not set"}.
          </p>
          <TechnicalDetails>
            <p>
              Saved revision {project?.revision} · Draft revision {draft.baseRevision}
            </p>
          </TechnicalDetails>
          <Button className="h-auto max-w-full whitespace-normal py-2 text-left" onClick={draft.rebaseToCurrent}>
            Use current revision with my draft
          </Button>
        </Callout>
      ) : null}
      {(
        [
          { key: "name", label: "Project name" },
          { key: "workspacePath", label: "Workspace path" },
          { key: "description", label: "Project description" },
          { key: "color", label: "Project color" },
        ] as const
      ).map((field) => (
        <Field key={field.key} label={field.label}>
          {(props) => (
            <input
              {...props}
              className="w-full min-w-0 rounded-md border border-line bg-raised p-2 text-fg"
              value={draft.value[field.key]}
              disabled={busy}
              onChange={(event) => draft.setValue((current) => ({ ...current, [field.key]: event.target.value }))}
            />
          )}
        </Field>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || !available || draft.hasRemoteChanges} onClick={() => void save()}>
          {busy ? "Saving project…" : project ? "Save project" : "Create project"}
        </Button>
        <Button disabled={busy} onClick={() => leave.request(onClose)}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={draft.discard}>
          Discard project changes
        </Button>
      </div>
      {leave.dialog}
    </section>
  );
}
