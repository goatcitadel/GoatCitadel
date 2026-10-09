import { Button } from "../../ui/Button";
export function UnattributedDraftRecovery({
  editor,
}: {
  editor: { hasUnattributedDraft: boolean; isDirty: boolean; recoverUnattributedDraft: () => void };
}) {
  if (!editor.hasUnattributedDraft) return null;
  return (
    <section
      aria-label="Unattributed draft recovery"
      className="space-y-2 rounded-md border border-line p-3 text-sm text-fg-secondary"
    >
      <p>
        An earlier draft has no verified caller attribution. Its bytes are preserved separately. Recover it only if this
        is your input; this does not save it to the Gateway.
      </p>
      <Button disabled={editor.isDirty} onClick={editor.recoverUnattributedDraft}>
        This is my draft — recover input
      </Button>
      {editor.isDirty ? <p>Review or discard your current draft before recovering earlier input.</p> : null}
    </section>
  );
}
