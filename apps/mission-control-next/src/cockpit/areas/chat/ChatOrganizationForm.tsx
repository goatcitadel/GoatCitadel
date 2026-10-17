import { useState } from "react";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";

type Dock = NonNullable<MissionThreadedRenderSurfaceInput["contextDockProps"]>;
type OrganizationDock = Pick<
  Dock,
  | "folderName"
  | "tagsValue"
  | "onFolderNameChange"
  | "onTagsValueChange"
  | "onSaveOrganization"
  | "sessionControlPending"
  | "selectedSession"
>;

const INPUT = "block w-full rounded-md border border-line-control bg-canvas p-2";

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** True when the saved conversation already carries this folder and these tags. */
function savedMatchesDraft(dock: OrganizationDock): boolean {
  const saved = dock.selectedSession.tags ?? [];
  const draft = parseTags(dock.tagsValue);
  return (
    (dock.selectedSession.folderName ?? "") === dock.folderName.trim() &&
    saved.length === draft.length &&
    saved.every((tag, index) => tag === draft[index])
  );
}

/**
 * Folder and tags for the selected conversation. The save action reports failures through the conversation's
 * error notice and resolves either way, so the outcome is read from the saved conversation itself.
 */
export function ChatOrganizationForm({ dock }: { dock: OrganizationDock }) {
  const [settled, setSettled] = useState(false);
  const saving = dock.sessionControlPending === "organization";
  const outcome = settled && !saving ? (savedMatchesDraft(dock) ? "saved" : "failed") : null;
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSettled(false);
        void dock.onSaveOrganization().then(
          () => setSettled(true),
          () => setSettled(true),
        );
      }}
    >
      <Field label="Folder">
        {(field) => (
          <input
            {...field}
            className={INPUT}
            value={dock.folderName}
            onChange={(event) => {
              setSettled(false);
              dock.onFolderNameChange(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Tags" help="Separate tags with commas.">
        {(field) => (
          <input
            {...field}
            className={INPUT}
            value={dock.tagsValue}
            onChange={(event) => {
              setSettled(false);
              dock.onTagsValueChange(event.target.value);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        loading={saving}
        loadingLabel="Saving…"
        disabled={Boolean(dock.sessionControlPending) && !saving}
      >
        Save folder and tags
      </Button>
      <p role="status" className={outcome === "failed" ? "text-status-failed" : "text-fg-muted"}>
        {outcome === "saved"
          ? "Folder and tags saved."
          : outcome === "failed"
            ? "Folder and tags weren’t saved. The reason is shown in the conversation; try again."
            : ""}
      </p>
    </form>
  );
}
