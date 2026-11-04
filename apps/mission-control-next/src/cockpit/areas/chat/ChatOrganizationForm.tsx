import { useState } from "react";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";

type Dock = NonNullable<MissionThreadedRenderSurfaceInput["contextDockProps"]>;
type OrganizationDock = Pick<
  Dock,
  "folderName" | "tagsValue" | "onFolderNameChange" | "onTagsValueChange" | "sessionControlPending" | "onSaveOrganization"
>;
type Outcome = "saved" | "failed";

const INPUT = "block w-full rounded-md border border-line-control bg-canvas p-2 text-md sm:text-sm";

/** Folder and tags for the selected conversation. Failure details stay in the conversation's error notice. */
export function ChatOrganizationForm({ dock }: { dock: OrganizationDock }) {
  const [settled, setSettled] = useState<Outcome | null>(null);
  const saving = dock.sessionControlPending === "organization";
  const outcome = saving ? null : settled;
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSettled(null);
        void dock.onSaveOrganization().then(
          (result) => setSettled(result ? "saved" : "failed"),
          () => setSettled("failed"),
        );
      }}
    >
      <Field label="Folder">
        {(field) => (
          <input
            {...field}
            className={INPUT}
            readOnly={saving}
            value={dock.folderName}
            onChange={(event) => {
              setSettled(null);
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
            readOnly={saving}
            value={dock.tagsValue}
            onChange={(event) => {
              setSettled(null);
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
