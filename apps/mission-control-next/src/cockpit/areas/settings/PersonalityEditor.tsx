import type { PersonalityPresetCategory } from "@goatcitadel/contracts";
import { useId } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  useDraftLeaveDialogState,
  type DraftLeaveDialogProps,
} from "../../../features/native-routes/library/DraftLeaveDialog";
import { usePersonalityEditor } from "../../../features/native-routes/settings/use-personality-editor";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type Controller = ReturnType<typeof usePersonalityEditor>;
const categories: PersonalityPresetCategory[] = [
  "core",
  "critical",
  "execution",
  "social",
  "thinking",
  "flavor",
  "chaos",
];
const fieldClass =
  "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-60";

export function PersonalityEditor({ control }: { control: Controller }) {
  const labelId = useId();
  const c = control,
    selected = c.selectedPersonality;
  const fieldDisabled = c.editorLocked || c.locked || !c.available;
  const conflict = c.editor.hasRemoteChanges || c.hasCatalogConflict;
  const removed = c.editorMode === "selected" && !selected;
  return (
    <>
      <Dialog
        open={c.editorOpen}
        onOpenChange={(open) => {
          if (!open) c.closeEditor();
        }}
        title={c.editorMode === "new" ? "New custom personality" : "Edit saved personality"}
        description="Edit the saved Work voice and framing. Policy, approvals, tools, privacy and memory rules remain authoritative."
      >
        <div className="space-y-3" aria-label="Personality editor">
          {c.isDirty ? (
            <p role="status" className="text-sm text-status-waiting">
              Unsaved personality draft
            </p>
          ) : null}
          {c.notice ? (
            <p role={c.notice.tone === "error" ? "alert" : "status"} className="text-sm text-fg-secondary">
              {c.notice.message}
            </p>
          ) : null}
          {c.mutation.uncertain ? (
            <p role="alert" className="text-sm text-status-waiting">
              {c.mutation.uncertain}
            </p>
          ) : null}
          {removed ? (
            <p role="status" className="text-sm text-status-waiting">
              The selected personality was removed. Your unsaved draft is retained for review.
            </p>
          ) : null}
          {c.editorLocked && selected ? (
            <p className="text-sm text-fg-secondary">This personality cannot be edited.</p>
          ) : null}
          {conflict ? (
            <div className="space-y-2 rounded-md border border-line p-3 text-sm text-fg-secondary">
              <p role="status">The personality catalog changed. Your draft is preserved.</p>
              <details>
                <summary className="cursor-pointer">Current saved personality</summary>
                <dl className="mt-2 space-y-2">
                  {selected
                    ? (
                        [
                          "id",
                          "label",
                          "category",
                          "description",
                          "tone",
                          "style",
                          "systemOverlay",
                          "safetyNotes",
                        ] as const
                      ).map((key) => (
                        <div key={key}>
                          <dt className="font-medium">{key}</dt>
                          <dd className="whitespace-pre-wrap wrap-anywhere">
                            {Array.isArray(selected[key]) ? selected[key].join("\n") : selected[key]}
                          </dd>
                        </div>
                      ))
                    : c.data?.items.map((item) => (
                        <div key={item.id}>
                          <dt>{item.label}</dt>
                          <dd>{item.description}</dd>
                        </div>
                      ))}
                </dl>
              </details>
              <Button
                size="sm"
                disabled={
                  c.locked || !c.available || (c.hasCatalogConflict && c.data?.revision === c.catalogConflict?.revision)
                }
                onClick={() => {
                  c.editor.rebaseToCurrent();
                  c.setCatalogConflict(null);
                }}
              >
                Apply draft to current personality
              </Button>
              <Button size="sm" disabled={c.loading} onClick={() => void c.reload()}>
                Reload latest catalog
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {(["id", "label", "tone", "style"] as const).map((key) => (
              <label key={key} className="text-sm text-fg-secondary">
                <span id={`${labelId}-${key}`}>{key === "id" ? "ID" : key.charAt(0).toUpperCase() + key.slice(1)}</span>
                <input
                  aria-labelledby={`${labelId}-${key}`}
                  className={fieldClass}
                  value={c.draft[key]}
                  disabled={fieldDisabled || (key === "id" && c.editingBuiltin)}
                  onChange={(event) => c.updateDraft(key, event.target.value)}
                />
              </label>
            ))}
            <label className="text-sm text-fg-secondary">
              <span id={`${labelId}-category`}>Category</span>
              <select
                aria-labelledby={`${labelId}-category`}
                className={fieldClass}
                value={c.draft.category}
                disabled={fieldDisabled}
                onChange={(event) => c.updateDraft("category", event.target.value as PersonalityPresetCategory)}
              >
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category.charAt(0).toUpperCase() + category.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(["description", "systemOverlay", "safetyNotes"] as const).map((key) => (
            <label key={key} className="block text-sm text-fg-secondary">
              <span id={`${labelId}-${key}`}>
                {key === "description" ? "Description" : key === "systemOverlay" ? "System overlay" : "Safety notes"}
              </span>
              <textarea
                aria-labelledby={`${labelId}-${key}`}
                className={fieldClass}
                rows={key === "systemOverlay" ? 5 : 3}
                value={c.draft[key]}
                disabled={fieldDisabled}
                onChange={(event) => c.updateDraft(key, event.target.value)}
              />
            </label>
          ))}
          <p className="text-xs text-fg-muted">
            Safety notes use one entry per line. Empty notes restore the Gateway's standard safety notes.
            {c.editingBuiltin ? " Empty built-in fields use shipped values." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!c.canSave || conflict || c.revisionUnavailable}
              onClick={() => void c.savePersonality()}
            >
              {c.saving ? "Saving personality…" : c.editorMode === "new" ? "Create personality" : "Save edits"}
            </Button>
            {c.editorMode === "selected" && selected && selected.id !== "default" ? (
              <Button
                variant={selected.builtin ? "secondary" : "danger"}
                disabled={c.locked || !c.available || (selected.builtin && !selected.modified)}
                onClick={() =>
                  c.setPendingRemove({
                    id: selected.id,
                    label: selected.label,
                    builtin: selected.builtin,
                    expectedRevision: c.data!.revision,
                  })
                }
              >
                {selected.builtin ? "Reset built-in" : "Remove custom"}
              </Button>
            ) : null}
            <Button onClick={c.closeEditor}>Close editor</Button>
          </div>
        </div>
      </Dialog>
      <PersonalityDraftLeave {...c.leave.dialogProps} />
      <ConfirmModal
        open={c.pendingRemove !== null}
        title={c.pendingRemove?.builtin ? "Reset built-in personality?" : "Remove custom personality?"}
        danger={!c.pendingRemove?.builtin}
        pending={c.removePending}
        confirmDisabled={!c.available || c.locked || c.data?.revision !== c.pendingRemove?.expectedRevision}
        message={`${c.pendingRemove?.builtin ? `Reset ${c.pendingRemove.label} to the shipped preset? Local edits will be removed.` : `Remove ${c.pendingRemove?.label ?? "this personality"}? This cannot be undone.`} If it is the global Work default, the Gateway clears that default.`}
        confirmLabel={c.pendingRemove?.builtin ? "Reset personality" : "Remove personality"}
        onCancel={() => {
          if (!c.removePending) c.setPendingRemove(null);
        }}
        onConfirm={() => void c.removeOrResetPersonality()}
      />
    </>
  );
}

function PersonalityDraftLeave(props: DraftLeaveDialogProps) {
  const state = useDraftLeaveDialogState(props);
  return (
    <Dialog
      open={props.open}
      title="Unsaved changes"
      description={state.description}
      onOpenChange={(open) => {
        if (!open && !state.saving) props.onCancel();
      }}
    >
      {state.error ? (
        <p role="alert" className="mb-3 text-sm text-status-failed">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state.canSave ? (
          <Button disabled={state.saving} onClick={() => void state.saveAndContinue()}>
            Save and continue
          </Button>
        ) : null}
        {state.canKeep ? (
          <Button disabled={state.saving} onClick={props.onContinue}>
            Keep draft and close
          </Button>
        ) : null}
        <Button variant="danger" disabled={state.saving} onClick={state.discard}>
          Discard changes
        </Button>
        <Button disabled={state.saving} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
