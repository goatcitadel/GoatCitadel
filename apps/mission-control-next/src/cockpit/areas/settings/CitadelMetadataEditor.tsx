import { useId } from "react";
import { Button } from "../../ui/Button";
import type { useCitadelEditor } from "../../../features/native-routes/settings/use-citadel-editor";
import { CITADEL_KINDS } from "../../../features/native-routes/settings/citadel-editor-binding";
import { CHECKING_FOR_CHANGES } from "../../../features/native-routes/settings/use-directory-lifecycle";
import type { CitadelRecord } from "@goatcitadel/contracts";
const inputClass = "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg";

export function CitadelMetadataEditor({
  editor,
  mode,
  selected,
  available,
  checking = false,
  onClose,
}: {
  editor: ReturnType<typeof useCitadelEditor>;
  mode: "create" | "edit";
  selected: CitadelRecord | null;
  available: boolean;
  /** The directory is refreshing, so saving waits for it. */
  checking?: boolean;
  onClose: () => void;
}) {
  const id = useId(),
    draft = mode === "create" ? editor.createDraft : editor.editDraft;
  return (
    <section aria-label="Citadel metadata editor" className="space-y-3 rounded-md border border-line bg-sunken p-3">
      <h4 className="text-sm font-semibold text-fg">{mode === "create" ? "New Citadel" : "Edit Citadel metadata"}</h4>
      {mode === "edit" ? (
        <dl className="space-y-1 text-xs text-fg-muted">
          <dt>Citadel ID</dt>
          <dd className="break-all font-mono">{selected?.citadelId ?? "Unavailable"}</dd>
          <dt>Saved revision</dt>
          <dd className="break-all font-mono">{selected?.revision ?? "Unavailable"}</dd>
        </dl>
      ) : null}
      {mode === "edit" && (draft.hasRemoteChanges || editor.hasConflict) ? (
        <div role="status" className="space-y-2 text-sm text-status-waiting">
          <p>
            The Citadel changed. Current name: {selected?.name ?? "Unavailable"}. Description:{" "}
            {selected?.description || "None"}. Review the saved profile before applying your retained draft.
          </p>
          <Button size="sm" disabled={!available || !editor.canRebase} onClick={editor.rebase}>
            Apply draft to current Citadel
          </Button>
        </div>
      ) : null}
      <div>
        <label htmlFor={`${id}-name`} className="text-sm text-fg-secondary">
          {mode === "create" ? "New Citadel name" : "Citadel name"}
        </label>
        <input
          id={`${id}-name`}
          className={inputClass}
          value={draft.value.name}
          disabled={editor.locked}
          onChange={(event) => draft.setValue((value) => ({ ...value, name: event.target.value }))}
        />
      </div>
      <div>
        <label htmlFor={`${id}-slug`} className="text-sm text-fg-secondary">
          Citadel slug
        </label>
        <input
          id={`${id}-slug`}
          className={inputClass}
          value={draft.value.slug}
          disabled={editor.locked}
          onChange={(event) => draft.setValue((value) => ({ ...value, slug: event.target.value }))}
        />
      </div>
      <div>
        <label htmlFor={`${id}-kind`} className="text-sm text-fg-secondary">
          Citadel kind
        </label>
        <select
          id={`${id}-kind`}
          className={inputClass}
          value={draft.value.kind}
          disabled={editor.locked}
          onChange={(event) =>
            draft.setValue((value) => ({ ...value, kind: event.target.value as CitadelRecord["kind"] }))
          }
        >
          {CITADEL_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-description`} className="text-sm text-fg-secondary">
          Citadel description
        </label>
        <textarea
          id={`${id}-description`}
          className={inputClass}
          rows={3}
          value={draft.value.description}
          disabled={editor.locked}
          onChange={(event) => draft.setValue((value) => ({ ...value, description: event.target.value }))}
        />
      </div>
      <p className="text-xs text-fg-muted">
        Blank slug uses the name. The Gateway normalizes slugs and enforces uniqueness. Drafts stay in this app session.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={
            !available ||
            editor.locked ||
            !draft.value.name.trim() ||
            draft.hasRemoteChanges ||
            (mode === "edit" && (!selected || editor.hasConflict || !draft.isDirty))
          }
          onClick={() => void (mode === "create" ? editor.create() : editor.save())}
        >
          {mode === "create" ? "Create Citadel" : "Save Citadel metadata"}
        </Button>
        <Button onClick={onClose}>Close Citadel editor{draft.isDirty ? " and keep draft" : ""}</Button>
        {checking ? (
          <span role="status" className="self-center text-xs text-fg-muted">
            {CHECKING_FOR_CHANGES}
          </span>
        ) : null}
      </div>
    </section>
  );
}
