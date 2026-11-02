import { useEffect, useId, useRef, type MutableRefObject } from "react";
import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import { SlidersHorizontal } from "lucide-react";
import { useDeferredOverlay } from "../../ui/deferred-overlay-owner";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { useModelLabel } from "../../data/use-model-label";
import { presentPreflightReason } from "./chat-model-reason";
import { presentThinkingLevel } from "./chat-vocabulary";
import type { Controls } from "./ChatComposerControls";

type ModelPopover = typeof import("./ChatModelOptionsPopover");
let modelPopoverLoad: Promise<ModelPopover> | undefined;

const loadModelPopover = () =>
  (modelPopoverLoad ??= import("./ChatModelOptionsPopover").catch((cause) => {
    modelPopoverLoad = undefined;
    throw cause;
  }));

/** Opens the model options popover from outside its button, such as a notice's "Choose another model". */
export type ModelOptionsRequest = MutableRefObject<(() => void) | null>;

/** True when the next message runs on the chosen model with nothing adjusted, so the chip itself says it all. */
export function routeMatchesSelection(
  props: Pick<Controls, "routePreflight" | "selectedProviderId" | "selectedModel">,
) {
  const route = props.routePreflight;
  if (!route?.effectiveModel || route.degradedReason || route.normalizationReason) return false;
  if (route.selectionSource === "citadel_ward_route_local") return false;
  return (
    route.effectiveModel === props.selectedModel &&
    (!route.effectiveProviderId || route.effectiveProviderId === props.selectedProviderId)
  );
}

/**
 * The model chip: model and effort at a glance, opening the deferred model and reasoning popover. It also owns the
 * popover's loading status and the reload review used when the popover's code fails to load.
 */
export function ChatModelOptionsButton({
  props,
  reasoningEfforts,
  scopeKey = "",
  requestRef,
  className = "",
}: {
  props: Controls;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
  scopeKey?: string;
  requestRef?: ModelOptionsRequest;
  className?: string;
}) {
  const options = useDeferredOverlay({ scopeKey, load: loadModelPopover });
  const contentId = useId();
  const reloadCancel = useRef<HTMLButtonElement>(null);
  const ModelPopover = options.runtime?.ChatModelOptionsPopover;
  const modelLabel = useModelLabel(
    props.selectedProviderId,
    props.selectedModel ?? undefined,
    Boolean(props.selectedModel),
  );
  const request = options.request;
  useEffect(() => {
    if (!requestRef) return;
    requestRef.current = () => request(true);
    return () => {
      requestRef.current = null;
    };
  }, [requestRef, request]);
  const optionsSummary = [
    props.selectedModel ? modelLabel : "Choose model",
    presentThinkingLevel(props.currentThinkingLevel),
  ].join(" · ");
  // When the route matches the chip, the "Will use" line is folded away and its reason moves to the chip's tooltip.
  const routeTitle =
    props.routePreflight && routeMatchesSelection(props) ? presentPreflightReason(props.routePreflight) : undefined;
  return (
    <>
      <button
        ref={(element) => {
          options.trigger.current = element;
        }}
        type="button"
        title={routeTitle}
        aria-label={`${optionsSummary} · Model and reasoning options`}
        aria-haspopup="dialog"
        aria-expanded={options.open}
        aria-controls={options.open ? contentId : undefined}
        aria-busy={options.loading || undefined}
        data-state={options.open ? "open" : "closed"}
        onClick={() => options.request(!options.open)}
        className={`inline-flex min-h-9 min-w-0 max-w-64 items-center gap-2 max-sm:max-w-full max-sm:basis-1/2 max-sm:flex-1 rounded-md border border-line-control px-2 text-left text-fg-secondary hover:border-line-strong max-sm:min-h-11 ${className}`}
      >
        <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{optionsSummary}</span>
      </button>
      {options.loading || options.failure ? (
        <span ref={options.status} role="status" className="text-xs text-fg-muted">
          {options.failure ? (
            <>
              {"Model options could not load. "}
              <Button
                size="sm"
                className="cockpit-deferred-recovery-control min-h-8 max-sm:min-h-11"
                onClick={(event) => options.requestReload(event.currentTarget)}
              >
                Reload app
              </Button>
            </>
          ) : (
            "Loading model options…"
          )}{" "}
          <button
            type="button"
            className="cockpit-deferred-recovery-control min-h-8 px-2 max-sm:min-h-11"
            onClick={() => options.close(true)}
          >
            Cancel model options
          </button>
        </span>
      ) : null}
      {ModelPopover ? (
        <ModelPopover
          props={props}
          reasoningEfforts={reasoningEfforts}
          open={options.open}
          onOpenChange={(open) => options.request(open)}
          trigger={options.trigger}
          contentRef={options.content}
          contentId={contentId}
          ownsFocus={() =>
            Boolean(
              options.intent.current &&
              options.isCurrent(options.intent.current.owner) &&
              options.ownsFocus(options.intent.current),
            )
          }
          isCurrent={options.isCurrent}
          onOutside={() => {
            if (options.intent.current) options.intent.current.restore = false;
          }}
          canRestore={() =>
            Boolean(
              options.intent.current &&
              options.isCurrent(options.intent.current.owner) &&
              options.intent.current.restore &&
              options.ownsFocus(options.intent.current),
            )
          }
        />
      ) : null}
      <Dialog
        open={Boolean(options.reloadReview && options.reloadCurrent(options.reloadReview))}
        onOpenChange={(open) => {
          if (!open) options.cancelReload(options.reloadReview);
        }}
        title="Reload app?"
        description="Reloading keeps the recorded conversation. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (options.reloadReview && options.reloadCurrent(options.reloadReview))
            reloadCancel.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          options.restoreReloadFocus();
        }}
      >
        <div ref={options.registerRecoveryHost} className="flex justify-end gap-2">
          <Button ref={reloadCancel} onClick={() => options.cancelReload(options.reloadReview)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!options.reloadReview || !options.reloadCurrent(options.reloadReview)}
            onClick={() => options.confirmReload(options.reloadReview)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
    </>
  );
}
