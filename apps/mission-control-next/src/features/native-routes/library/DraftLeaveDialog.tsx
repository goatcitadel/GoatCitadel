import { useEffect, useState } from "react";
import { GCModal } from "@goatcitadel/mission-control-shared/components/ui/GCModal";
import { NativeButton } from "../primitives";
import { describeDirtySections, discardDirtySections, getDirtySectionActions, getDirtySectionKeys, withDraftLeaveDecision } from "./use-form-dirty";

export function DraftLeaveDialog({ open, keys, onContinue, onCancel, onDiscard }: {
  open: boolean; keys: readonly string[]; onContinue: () => void; onCancel: () => void; onDiscard?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open) setError(null); }, [open]);
  const actions = keys.map(getDirtySectionActions);
  const canKeep = keys.length > 0 && actions.every((action) => action?.keepDraft);
  const canSave = keys.length > 0 && actions.every((action) => action?.onSave);
  async function saveAndContinue() {
    setSaving(true); setError(null);
    try {
      for (const action of actions) {
        if (!(await action?.onSave?.())) { setError("Changes were not saved. Your draft is still available in the editor."); return; }
      }
      onContinue();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save. Your draft is preserved."); }
    finally { setSaving(false); }
  }
  return <GCModal open={open} title="Unsaved changes" description={`You have unsaved changes in ${describeDirtySections(keys) || "this editor"}.`}
    onOpenChange={(next) => { if (!next) { setError(null); onCancel(); } }} dismissDisabled={saving} cancelLabel="Cancel">
    {error ? <p role="alert">{error}</p> : null}
    <div className="mc-next-settings-button-row">
      {canSave ? <NativeButton disabled={saving} onClick={() => void saveAndContinue()}>{saving ? "Saving..." : "Save and continue"}</NativeButton> : null}
      {canKeep ? <NativeButton variant="outline" disabled={saving} onClick={onContinue}>Keep draft and close</NativeButton> : null}
      <NativeButton variant="destructive" disabled={saving} onClick={() => { if (onDiscard) onDiscard(); else { discardDirtySections(keys); onContinue(); } }}>Discard changes</NativeButton>
    </div>
  </GCModal>;
}

export function useDraftLeave() {
  const [pending, setPending] = useState<{ keys: readonly string[]; proceed: () => void } | null>(null);
  return {
    request: (proceed: () => void, keys: readonly string[] = getDirtySectionKeys()) => {
      const dirty = keys.filter((key) => getDirtySectionKeys().includes(key));
      if (!dirty.length) proceed(); else setPending({ keys: dirty, proceed });
    },
    dialog: <DraftLeaveDialog open={pending !== null} keys={pending?.keys ?? []} onCancel={() => setPending(null)} onDiscard={() => { if (pending) { discardDirtySections(pending.keys); withDraftLeaveDecision(pending.keys, pending.proceed); } setPending(null); }} onContinue={() => { if (pending) withDraftLeaveDecision(pending.keys, pending.proceed); setPending(null); }} />,
  };
}
