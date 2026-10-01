import { useEffect, useRef, useState } from "react";
import { GCModal } from "@goatcitadel/mission-control-shared/components/ui/GCModal";
import { NativeButton } from "../primitives";
import {
  describeDirtySections,
  discardDirtySections,
  getDirtySectionActions,
  getDirtySectionKeys,
  withDraftLeaveDecision,
} from "./use-form-dirty";

export type DraftLeaveDialogProps = {
  open: boolean;
  keys: readonly string[];
  onContinue: () => void;
  onCancel: () => void;
  onDiscard?: () => void;
  /** Optional lifetime of the exact reviewed navigation; draft owners retain save authority. */
  isCurrent?: () => boolean;
};

export function useDraftLeaveDialogState({ open, keys, onContinue, onDiscard, isCurrent }: DraftLeaveDialogProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveAttempt = useRef<object | null>(null);
  useEffect(() => {
    if (!open) setError(null);
  }, [open]);
  const actions = keys.map(getDirtySectionActions);
  const canKeep = keys.length > 0 && actions.every((action) => action?.keepDraft);
  const canSave = keys.length > 0 && actions.every((action) => action?.onSave);
  async function saveAndContinue() {
    if (saveAttempt.current || isCurrent?.() === false) return;
    const attempt = {};
    saveAttempt.current = attempt;
    setSaving(true);
    setError(null);
    try {
      for (const action of actions) {
        if (isCurrent?.() === false) return;
        const saved = await action?.onSave?.();
        if (isCurrent?.() === false) return;
        if (!saved) {
          setError("Changes were not saved. Your draft is still available in the editor.");
          return;
        }
      }
      if (isCurrent?.() !== false) onContinue();
    } catch (cause) {
      if (isCurrent?.() !== false)
        setError(cause instanceof Error ? cause.message : "Unable to save. Your draft is preserved.");
    } finally {
      if (saveAttempt.current === attempt) {
        saveAttempt.current = null;
        setSaving(false);
      }
    }
  }
  const discard = () => {
    if (isCurrent?.() === false) return;
    if (onDiscard) onDiscard();
    else {
      discardDirtySections(keys);
      if (isCurrent?.() !== false) onContinue();
    }
  };
  return {
    saving,
    error,
    setError,
    canKeep,
    canSave,
    saveAndContinue,
    discard,
    description: `You have unsaved changes in ${describeDirtySections(keys) || "this editor"}.`,
  };
}

export function DraftLeaveDialog(props: DraftLeaveDialogProps) {
  const { open, onContinue, onCancel } = props;
  const { saving, error, setError, canKeep, canSave, saveAndContinue, discard, description } =
    useDraftLeaveDialogState(props);
  return (
    <GCModal
      open={open}
      title="Unsaved changes"
      description={description}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          onCancel();
        }
      }}
      dismissDisabled={saving}
      cancelLabel="Cancel"
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="mc-next-settings-button-row">
        {canSave ? (
          <NativeButton disabled={saving} onClick={() => void saveAndContinue()}>
            {saving ? "Saving..." : "Save and continue"}
          </NativeButton>
        ) : null}
        {canKeep ? (
          <NativeButton variant="outline" disabled={saving} onClick={onContinue}>
            Keep draft and close
          </NativeButton>
        ) : null}
        <NativeButton variant="destructive" disabled={saving} onClick={discard}>
          Discard changes
        </NativeButton>
      </div>
    </GCModal>
  );
}

export function useDraftLeave() {
  const [pending, setPending] = useState<{ keys: readonly string[]; proceed: () => void } | null>(null);
  const dialogProps: DraftLeaveDialogProps = {
    open: pending !== null,
    keys: pending?.keys ?? [],
    onCancel: () => setPending(null),
    onDiscard: () => {
      if (pending) {
        discardDirtySections(pending.keys);
        withDraftLeaveDecision(pending.keys, pending.proceed);
      }
      setPending(null);
    },
    onContinue: () => {
      if (pending) withDraftLeaveDecision(pending.keys, pending.proceed);
      setPending(null);
    },
  };
  return {
    request: (proceed: () => void, keys: readonly string[] = getDirtySectionKeys()) => {
      const dirty = keys.filter((key) => getDirtySectionKeys().includes(key));
      if (!dirty.length) proceed();
      else setPending({ keys: dirty, proceed });
    },
    dialogProps,
    dialog: <DraftLeaveDialog {...dialogProps} />,
  };
}
