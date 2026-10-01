import { useId, useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useCitadelVaultEditor } from "../../../features/native-routes/library/use-citadel-vault-editor";
import { useDraftLeaveDialogState } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { Dialog } from "../../ui/Dialog";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

const inputClass = "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg";
export function CitadelVaultSettings({ citadelId }: { citadelId: string }) {
  const editor = useCitadelVaultEditor(citadelId),
    { vault, selectedSecret } = editor;
  const id = useId(),
    [search, setSearch] = useState(""),
    [limit, setLimit] = useState(50);
  const leave = useDraftLeaveDialogState(editor.leave.dialogProps);
  const filtered = editor.items.filter((item) => item.secretName.toLowerCase().includes(search.toLowerCase()));
  const currentReview = editor.reviewRequired ? (
    <section aria-label="Current Vault review" className="space-y-2 rounded-md border border-status-waiting p-3">
      <p className="text-sm text-fg-secondary">
        The Vault changed. Review its current names and update times before retrying. Your draft is retained.
      </p>
      <p className="text-xs text-fg-muted">
        {vault.snapshot?.items.length ?? "Unavailable"} stored names ·{" "}
        {vault.snapshot?.record?.lifecycleStatus ?? "No Citadel profile"}
      </p>
      <ul className="space-y-1 text-sm text-fg-secondary">
        {vault.snapshot?.items.slice(0, 50).map((item) => (
          <li key={item.secretId} className="break-all">
            {item.secretName} · Updated {item.updatedAt}
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        disabled={
          vault.loading || vault.locked || !vault.snapshot || vault.snapshot.record?.lifecycleStatus === "archived"
        }
        onClick={editor.acceptReview}
      >
        Use current Vault review
      </Button>
    </section>
  ) : null;
  return (
    <section id="citadel-vault" aria-label="Citadel Vault" className="space-y-4">
      <header className="space-y-1">
        <h3 className="font-display text-md font-semibold text-fg">Vault</h3>
        <p className="text-sm text-fg-secondary">
          Secrets for {vault.snapshot?.record?.name ?? "the selected Citadel"}. The Gateway seals values with a Citadel
          key held in the OS keychain. Names and update times are listed here.
        </p>
        <p className="text-xs text-fg-muted">
          Secret input stays in this app session until saved or discarded. This does not configure a provider or grant a
          tool access to the secret.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={vault.loading || editor.busy} onClick={() => void editor.refresh()}>
          Refresh Vault metadata
        </Button>
        <Button size="sm" disabled={!vault.snapshot || vault.locked || vault.loading} onClick={editor.openForm}>
          Store secret{editor.secretDraft.isDirty ? " · Unsaved" : ""}
        </Button>
      </div>
      {vault.loading ? (
        <p role="status" className="text-sm text-fg-secondary">
          Loading Vault metadata…
        </p>
      ) : null}
      {vault.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {vault.error}
        </p>
      ) : null}
      {vault.snapshot?.record?.lifecycleStatus === "archived" ? (
        <p className="text-sm text-status-waiting">Restore this Citadel before changing its Vault.</p>
      ) : null}
      {!editor.formOpen ? currentReview : null}
      {vault.snapshot ? (
        <>
          <label htmlFor={`${id}-search`} className="block text-sm text-fg-secondary">
            Find a stored secret
            <input
              id={`${id}-search`}
              className={inputClass}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(50);
              }}
            />
          </label>
          <p className="text-xs text-fg-muted">
            Showing {Math.min(limit, filtered.length)} of {filtered.length} matching names.
          </p>
          {!filtered.length ? (
            <p className="text-sm text-fg-muted">
              {editor.items.length ? "No matching secret names." : "No secrets stored."}
            </p>
          ) : (
            <ul className="divide-y divide-line-subtle rounded-md border border-line">
              {filtered.slice(0, limit).map((item) => (
                <li key={item.secretId} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="break-all text-sm font-semibold text-fg">{item.secretName}</p>
                    <p className="text-xs text-fg-muted">Updated {item.updatedAt}</p>
                  </div>
                  <Button size="sm" onClick={() => editor.inspect(item.secretId)}>
                    Inspect {item.secretName}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((value) => value + 50)}>
              Show more secret names
            </Button>
          ) : null}
        </>
      ) : null}
      <Sheet
        sideOnDesktop
        open={editor.formOpen}
        onOpenChange={(open) => {
          if (!open) editor.closeDetails();
        }}
        title="Store a secret"
      >
        <div className="space-y-3">
          {currentReview}
          {vault.error ? (
            <p role="alert" className="text-sm text-status-failed">
              {vault.error}
            </p>
          ) : null}
          <label htmlFor={`${id}-name`} className="block text-sm text-fg-secondary">
            Secret name
            <input
              id={`${id}-name`}
              className={inputClass}
              value={editor.draft.name}
              autoComplete="off"
              maxLength={200}
              onChange={(event) => editor.setDraft((value) => ({ ...value, name: event.target.value }))}
            />
          </label>
          <label htmlFor={`${id}-value`} className="block text-sm text-fg-secondary">
            Secret value
            <input
              id={`${id}-value`}
              type="password"
              className={inputClass}
              value={editor.draft.value}
              autoComplete="new-password"
              onChange={(event) => editor.setDraft((value) => ({ ...value, value: event.target.value }))}
            />
          </label>
          <p className="text-xs text-fg-muted">
            The value is sent only to the Vault owner when you seal and store. Replacing an existing name requires
            confirmation.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!editor.canStore || !editor.draft.name.trim() || !editor.draft.value}
              onClick={() => void editor.store()}
            >
              {editor.busy ? "Sealing…" : "Seal & store"}
            </Button>
            <Button onClick={editor.closeDetails}>Close secret editor</Button>
          </div>
        </div>
      </Sheet>
      <Sheet
        sideOnDesktop
        open={Boolean(selectedSecret)}
        onOpenChange={(open) => {
          if (!open) editor.closeDetails();
        }}
        title={selectedSecret?.secretName ?? "Secret"}
      >
        {selectedSecret ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              Explicit reveals show the current value temporarily. It hides after 30 seconds, on refresh, or when this
              inspection closes.
            </p>
            <dl className="space-y-1 text-xs text-fg-muted">
              <dt>Secret ID</dt>
              <dd>
                <code className="break-all font-mono">{selectedSecret.secretId}</code>
              </dd>
              <dt>Created</dt>
              <dd>{selectedSecret.createdAt}</dd>
              <dt>Updated</dt>
              <dd>{selectedSecret.updatedAt}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={vault.loading}
                onClick={() =>
                  editor.revealed[selectedSecret.secretId] === undefined
                    ? void editor.reveal(selectedSecret.secretId)
                    : editor.clearReveals()
                }
              >
                {editor.revealed[selectedSecret.secretId] === undefined ? "Reveal secret" : "Hide secret"}
              </Button>
              <Button variant="danger" disabled={!vault.ready || editor.reviewRequired} onClick={editor.reviewDelete}>
                Delete secret
              </Button>
            </div>
            {editor.revealed[selectedSecret.secretId] !== undefined ? (
              <code className="block whitespace-pre-wrap break-all rounded-md bg-sunken p-3 font-mono text-sm text-fg">
                {editor.revealed[selectedSecret.secretId]}
              </code>
            ) : null}
            {editor.revealErrors[selectedSecret.secretId] ? (
              <p role="alert" className="text-sm text-status-failed">
                {editor.revealErrors[selectedSecret.secretId]}
              </p>
            ) : null}
          </div>
        ) : null}
      </Sheet>
      <ConfirmModal
        open={editor.pendingStore !== null}
        pending={editor.busy}
        danger
        title="Replace secret?"
        message={`Replace "${editor.pendingStore?.draft.name.trim()}" with the value you entered? The previous value cannot be recovered.`}
        confirmLabel="Replace secret"
        onCancel={editor.cancelStore}
        onConfirm={() => {
          if (editor.pendingStore) void editor.save(editor.pendingStore.draft, editor.pendingStore.revision);
        }}
      />
      <ConfirmModal
        open={editor.pendingDelete !== null}
        pending={editor.busy}
        danger
        title="Delete secret?"
        message={`Permanently remove "${editor.pendingDelete?.name}" from the selected Citadel? This cannot be undone.`}
        confirmLabel="Delete"
        onCancel={editor.cancelDelete}
        onConfirm={() => void editor.remove()}
      />
      <Dialog
        open={editor.leave.dialogProps.open}
        title="Unsaved changes"
        description={leave.description}
        onOpenChange={(open) => {
          if (!open && !leave.saving) editor.leave.dialogProps.onCancel();
        }}
      >
        {leave.error ? (
          <p role="alert" className="text-sm text-status-failed">
            {leave.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {leave.canKeep ? (
            <Button disabled={leave.saving} onClick={editor.leave.dialogProps.onContinue}>
              Keep draft and close
            </Button>
          ) : null}
          {leave.canSave ? (
            <Button disabled={leave.saving} onClick={() => void leave.saveAndContinue()}>
              Save and continue
            </Button>
          ) : null}
          <Button variant="danger" disabled={leave.saving} onClick={leave.discard}>
            Discard changes
          </Button>
          <Button disabled={leave.saving} onClick={editor.leave.dialogProps.onCancel}>
            Cancel
          </Button>
        </div>
      </Dialog>
      <ClassicOwnerLink href="/library/citadel-vault?shell=classic" scope={citadelId} label="Detailed Vault controls" />
      <p className="text-xs text-fg-muted">
        Per-Chamber keys and key rotation are not available here. Keychain unavailability blocks sealing and reveal; no
        plaintext fallback is used.
      </p>
    </section>
  );
}
