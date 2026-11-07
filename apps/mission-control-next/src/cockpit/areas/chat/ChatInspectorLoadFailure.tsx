import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import { useLayoutEffect, useRef, useState } from "react";
import { readCockpitHistory } from "../../app/cockpit-history";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type ReloadReview = { history: string; url: string; trigger: HTMLButtonElement };

export function ChatInspectorLoadFailure({ current }: { current: () => boolean }) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const activeReview = useRef<ReloadReview | undefined>(undefined);
  const returnFocus = useRef<ReloadReview | undefined>(undefined);
  const [review, setReview] = useState<ReloadReview>();
  const currentReview = (saved: ReloadReview) =>
    current() && readCockpitHistory() === saved.history && window.location.href === saved.url;
  useLayoutEffect(
    () => () => {
      activeReview.current = undefined;
      returnFocus.current = undefined;
    },
    [],
  );
  const closeReview = (saved: ReloadReview | undefined) => {
    if (!saved || activeReview.current !== saved) return;
    activeReview.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
  };
  const openReview = (trigger: HTMLButtonElement) => {
    if (!current() || activeReview.current) return;
    const saved = { history: readCockpitHistory(), url: window.location.href, trigger };
    activeReview.current = saved;
    returnFocus.current = saved;
    setReview(saved);
  };
  const reload = (saved: ReloadReview | undefined) => {
    if (hasUnsettledChatContextMutation()) return;
    if (!saved || activeReview.current !== saved || !currentReview(saved)) return;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
    window.location.reload();
  };
  return (
    <>
      <Button size="sm" onClick={(event) => openReview(event.currentTarget)}>
        Reload app
      </Button>
      <Dialog
        open={Boolean(review && currentReview(review))}
        title="Reload app?"
        onOpenChange={(open) => {
          if (!open) closeReview(review);
        }}
        description="Reloading keeps the recorded conversation. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (review && activeReview.current === review && currentReview(review))
            cancelButton.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const saved = returnFocus.current;
          returnFocus.current = undefined;
          if (
            saved &&
            currentReview(saved) &&
            saved.trigger.isConnected &&
            (document.activeElement === document.body || document.activeElement === saved.trigger)
          )
            saved.trigger.focus({ preventScroll: true });
        }}
      >
        <div className="flex justify-end gap-2">
          <Button ref={cancelButton} onClick={() => closeReview(review)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={hasUnsettledChatContextMutation() || !review || !currentReview(review)}
            title={hasUnsettledChatContextMutation() ? CHAT_CONTEXT_RELOAD_NOTE : undefined}
            onClick={() => reload(review)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
    </>
  );
}
