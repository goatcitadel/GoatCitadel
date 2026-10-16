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
        An earlier draft was found, but this browser can't confirm who wrote it. It is kept separately. Recover it only
        if it is your input; recovering does not save it.
      </p>
      <Button disabled={editor.isDirty} onClick={editor.recoverUnattributedDraft}>
        This is my draft — recover input
      </Button>
      {editor.isDirty ? <p>Review or discard your current draft before recovering earlier input.</p> : null}
    </section>
  );
}
