import { useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeButton } from "../primitives";

interface MemoryBatchToolbarProps {
  count: number;
  maxCount: number;
  canMutate: boolean;
  busy: boolean;
  forgetBusy: boolean;
  onForget: () => Promise<unknown>;
  onPin: (pinned: boolean) => void;
  onClear: () => void;
}

/**
 * Multi-select action bar for the Memory items list (Task 13). MemoryRoutePage
 * mounts this only while at least one row checkbox is selected. It owns the
 * "forget" confirm step locally — mirroring the page's own single-item forget
 * flow — while pin/unpin fire immediately, matching the Kanban bulk toolbar
 * precedent (ops/KanbanRoutePage.tsx), which has no destructive action to gate.
 * Selection-clear-on-success stays with the caller (MemoryRoutePage), which
 * only clears `batchSelected` when the hook verb resolves truthy.
 */
export function MemoryBatchToolbar({
  count,
  maxCount,
  canMutate,
  busy,
  forgetBusy,
  onForget,
  onPin,
  onClear,
}: MemoryBatchToolbarProps) {
  const [pendingForget, setPendingForget] = useState(false);
  // Over-limit selections disable the batch verbs up front so the operator
  // learns about the cap here, not from a post-confirm hook rejection. The
  // hook keeps its own >max guard as the backstop.
  const overLimit = count > maxCount;
  const disabled = !canMutate || busy || overLimit;

  return (
    <>
      <div className="mc-next-runtime-actions" role="toolbar" aria-label="Memory batch actions">
        <span aria-live="polite">
          {`${count} selected`}
          {overLimit ? ` — batch actions are limited to ${maxCount} items at a time` : null}
        </span>
        <NativeButton variant="destructive" disabled={disabled} onClick={() => setPendingForget(true)}>
          Forget selected
        </NativeButton>
        <NativeButton variant="default" disabled={disabled} onClick={() => onPin(true)}>
          Pin selected
        </NativeButton>
        <NativeButton variant="outline" disabled={disabled} onClick={() => onPin(false)}>
          Unpin selected
        </NativeButton>
        <NativeButton variant="secondary" disabled={busy} onClick={onClear}>
          Clear selection
        </NativeButton>
      </div>
      <ConfirmModal
        open={pendingForget}
        title={`Request approval to forget ${count} memory item(s)?`}
        message="Nothing is forgotten yet: this creates one memory.lifecycle approval, and after it is approved the batch applies atomically — either all are forgotten or none are."
        confirmLabel="Request approval"
        danger
        pending={forgetBusy}
        disableDismiss={forgetBusy}
        onCancel={() => setPendingForget(false)}
        onConfirm={() => {
          setPendingForget(false);
          void onForget();
        }}
      />
    </>
  );
}
