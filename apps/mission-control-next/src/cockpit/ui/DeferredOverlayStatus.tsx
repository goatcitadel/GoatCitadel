import { useLayoutEffect, useRef } from "react";
import type { useDeferredOverlay } from "./deferred-overlay-owner";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export function DeferredOverlayStatus<Runtime>({
  state,
  name,
}: {
  state: ReturnType<typeof useDeferredOverlay<Runtime>>;
  name: "Menu" | "Panel";
}) {
  const reloadCancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!state.loading && !state.failure) return;
    const trigger = state.trigger.current,
      status = state.status.current;
    if (!trigger || !status) return;
    // Keep the pressed trigger and its sibling controls in place. The status
    // stays in DOM focus order while escaping clipped conversation scrollers.
    const position = () => {
      if (!trigger.isConnected || !status.isConnected) return;
      const anchor = trigger.getBoundingClientRect(),
        popup = status.getBoundingClientRect();
      const margin = 8,
        gap = 4,
        width = window.innerWidth,
        height = window.innerHeight;
      const left = Math.max(margin, Math.min(anchor.right - popup.width, width - popup.width - margin));
      const below = height - anchor.bottom - margin - gap,
        above = anchor.top - margin - gap;
      const top = below >= popup.height || below >= above ? anchor.bottom + gap : anchor.top - popup.height - gap;
      status.style.left = left + "px";
      status.style.top = Math.max(margin, Math.min(top, height - popup.height - margin)) + "px";
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(trigger);
    observer?.observe(status);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      observer?.disconnect();
    };
  }, [state.loading, state.failure, state.trigger, state.status]);
  return (
    <>
      {state.loading || state.failure ? (
        <span
          ref={state.status}
          className="fixed z-60 w-max cockpit-menu-status-viewport overflow-auto rounded-md border border-line bg-overlay p-2 text-xs text-fg-muted shadow-overlay"
          role="status"
        >
          {state.failure ? (
            <>
              {`${name} controls could not load. `}
              <Button
                size="sm"
                className="cockpit-deferred-recovery-control min-h-8 max-sm:min-h-11"
                onClick={(event) => state.requestReload(event.currentTarget)}
              >
                Reload app
              </Button>
            </>
          ) : (
            `Loading ${name.toLowerCase()} controls…`
          )}{" "}
          <button
            type="button"
            className="cockpit-deferred-recovery-control min-h-8 px-2 max-sm:min-h-11"
            onClick={() => state.close(true)}
          >
            Cancel {name.toLowerCase()}
          </button>
        </span>
      ) : null}
      <Dialog
        open={Boolean(state.reloadReview && state.reloadCurrent(state.reloadReview))}
        onOpenChange={(open) => {
          if (!open) state.cancelReload(state.reloadReview);
        }}
        title="Reload app?"
        description="Reloading keeps the recorded conversation. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (state.reloadReview && state.reloadCurrent(state.reloadReview))
            reloadCancel.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          state.restoreReloadFocus();
        }}
      >
        <div ref={state.registerRecoveryHost} className="flex justify-end gap-2">
          <Button ref={reloadCancel} onClick={() => state.cancelReload(state.reloadReview)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!state.reloadReview || !state.reloadCurrent(state.reloadReview)}
            onClick={() => state.confirmReload(state.reloadReview)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
    </>
  );
}
