import { useState } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  hasPersonalityCatalog,
  PERSONALITY_DEFAULT_SCOPE,
} from "../../../features/native-routes/settings/use-personality-default";
import { usePersonalityEditor } from "../../../features/native-routes/settings/use-personality-editor";
import { PersonalityEditor } from "./PersonalityEditor";
import { Button } from "../../ui/Button";

export function PersonalitySettings() {
  const editor = usePersonalityEditor();
  const catalog = { data: editor.data ?? undefined, isError: Boolean(editor.error), isFetching: editor.loading,
    isLoading: editor.loading && !editor.data, error: new Error(editor.error ?? "Catalog unavailable"), refetch: editor.reload };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const data = catalog.data;
  const available = !catalog.isError && !catalog.isFetching && hasPersonalityCatalog(data);
  const action = editor.defaultSelection;
  const selected = data?.items.find((item) => item.id === (selectedId ?? data.defaultPersonalityId));
  const current = data?.items.find((item) => item.id === data.defaultPersonalityId);
  const ready = !catalog.isError && hasPersonalityCatalog(data);
  return (
    <section
      id="work-personality"
      aria-label="Work personality"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4"
    >
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Work personality</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Choose the saved voice and framing used as the global Work default. {PERSONALITY_DEFAULT_SCOPE}
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          Experimental. Personality instructions cannot override safety, privacy, memory, tools, or approvals.
        </p>
      </header>
      <Button size="sm" disabled={catalog.isFetching || action.pending} onClick={() => void catalog.refetch()}>
        Refresh personality catalog
      </Button>
      {catalog.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading personality catalog…
        </p>
      ) : null}
      {catalog.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Personality catalog unavailable: {describeApiError(catalog.error).summary}
        </p>
      ) : null}
      {!catalog.isLoading && !catalog.isError && !ready ? (
        <p role="alert" className="text-sm text-status-failed">
          The Gateway did not provide a reviewable personality catalog and revision.
        </p>
      ) : null}
      {ready ? (
        <>
          <p className="text-sm text-fg-secondary">Current global default: {current?.label}</p>
          <details className="text-xs text-fg-muted">
            <summary className="cursor-pointer">Catalog details</summary>
            <p className="mt-2">Catalog revision: <code className="break-all font-mono">{data.revision}</code></p>
          </details>
          <label className="block text-sm text-fg-secondary">
            Saved personality
            <select
              value={selectedId ?? data.defaultPersonalityId}
              disabled={!available || action.locked}
              onChange={(event) => setSelectedId(event.target.value)}
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg"
            >
              {selectedId && !selected ? (
                <option value={selectedId} disabled>
                  Previously selected personality is unavailable
                </option>
              ) : null}
              {data.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {item.builtin ? " · Built-in" : " · Custom"}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <div className="space-y-2 rounded-md border border-line-subtle bg-sunken p-3 text-sm text-fg-secondary">
              <p>{selected.description || "No description supplied by the owner."}</p>
              <dl className="grid gap-1">
                <dt className="font-medium text-fg">Tone</dt>
                <dd>{selected.tone || "Default voice"}</dd>
                <dt className="font-medium text-fg">Style</dt>
                <dd>{selected.style || "Default style"}</dd>
              </dl>
              <details>
                <summary className="cursor-pointer text-fg">Saved instructions and safety notes</summary>
                <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                  {selected.systemOverlay || "No personality overlay."}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {selected.safetyNotes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </details>
            </div>
          ) : (
            <p role="status" className="text-sm text-status-waiting">
              The selected personality is missing from the current catalog. Choose a current saved entry.
            </p>
          )}
          <Button
            variant="primary"
            disabled={!available || !selected || action.locked || selected.id === data.defaultPersonalityId}
            onClick={() => selected && action.requestReview(selected.id)}
          >
            Review global default
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!available || editor.locked} onClick={editor.beginCustomPersonality}>Add custom personality</Button>
            <Button size="sm" disabled={!available || !selected} onClick={() => selected && editor.personalityTransitionGuard.requestTransition({ kind: "select", id: selected.id })}>
              Edit selected personality
            </Button>
          </div>
          {catalog.isFetching ? (
            <p role="status" className="text-xs text-fg-muted">
              Refreshing saved personality evidence…
            </p>
          ) : null}
        </>
      ) : null}
      {action.notice ? (
        <p role={action.uncertain ? "alert" : "status"} className="text-sm text-fg-secondary">
          {action.notice}
        </p>
      ) : null}
      {action.pending ? (
        <p role="status" className="text-sm text-fg-secondary">
          Waiting for the Gateway to confirm the default change…
        </p>
      ) : null}
      {editor.notice && !editor.editorOpen ? <p role={editor.notice.tone === "error" ? "alert" : "status"} className="text-sm text-fg-secondary">{editor.notice.message}</p> : null}
      {editor.mutation.uncertain && !editor.editorOpen ? <p role="alert" className="text-sm text-status-waiting">{editor.mutation.uncertain}</p> : null}
      <PersonalityEditor control={editor} />
      <ConfirmModal
        open={action.review !== null}
        title="Change Work default?"
        message={`${
          action.review?.preset.id === "default"
            ? "Clear the global Work personality and use the default voice?"
            : `Use the saved instructions for ${action.review?.preset.label ?? "this personality"} as the global Work default?`
        } ${PERSONALITY_DEFAULT_SCOPE}`}
        confirmLabel="Apply reviewed default"
        cancelLabel="Keep current default"
        pending={action.pending}
        confirmDisabled={!action.reviewCurrent || action.locked}
        onCancel={action.cancel}
        onConfirm={() => void action.confirm()}
      />
    </section>
  );
}
