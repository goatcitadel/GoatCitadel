import { useState } from "react";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";

type Dock = NonNullable<MissionThreadedRenderSurfaceInput["contextDockProps"]>;
type OrganizationDock = Pick<
  Dock,
  "folderName" | "tagsValue" | "onFolderNameChange" | "onTagsValueChange" | "sessionControlPending" | "selectedSession"
> & {
  /** Resolves true or false with the save's own outcome; a rejection is a failure. */
  onSaveOrganization: () => Promise<boolean | void>;
};
type Outcome = "saved" | "failed";

const INPUT = "block w-full rounded-md border border-line-control bg-canvas p-2 text-md sm:text-sm";

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
 * Folder and tags for the selected conversation. The outcome comes from the save itself: true or false from the
 * action, or a rejection. Only an action that still resolves without a result falls back to comparing the saved
 * conversation with the draft. Failure details stay in the conversation's error notice.
 */
export function ChatOrganizationForm({ dock }: { dock: OrganizationDock }) {
  const [settled, setSettled] = useState<Outcome | "unreported" | null>(null);
  const saving = dock.sessionControlPending === "organization";
  const outcome: Outcome | null =
    !settled || saving ? null : settled === "unreported" ? (savedMatchesDraft(dock) ? "saved" : "failed") : settled;
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSettled(null);
        void dock.onSaveOrganization().then(
          (result) => setSettled(result === true ? "saved" : result === false ? "failed" : "unreported"),
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
