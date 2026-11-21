import { Root, Anchor, Portal, Content, Close } from "@radix-ui/react-popover";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import type { ChatModelOptionsControls as Controls } from "./ChatComposerControls";
import { useProviderLabelLookup } from "../../data/use-model-label";
import { presentThinkingLevel } from "./chat-vocabulary";
import { PLAN_HELP, REVIEW_HELP } from "./chat-optional-vocabulary";
import { useChatModelLabels } from "./use-chat-model-labels";
import {
  GUIDED_THINKING_LEVELS,
  clampGuidedThinkingLevel,
} from "../../../features/native-routes/settings/sections/guided-model-setup-support";

/** Every effort stays selectable while the catalog records no reasoning metadata; the Gateway still gates the send. */
const ALL_THINKING_LEVELS: readonly Controls["currentThinkingLevel"][] = GUIDED_THINKING_LEVELS.map(
  (option) => option.value,
);

/** What the operator has picked in the open popover and not yet sent. Nothing is sent until the popover closes. */
interface ModelDraft {
  providerId?: string;
  model?: string;
  thinkingLevel?: Controls["currentThinkingLevel"];
}

const THINKING_LEVEL_FOR_EFFORT: Readonly<Record<ChatCompletionReasoningEffort, Controls["currentThinkingLevel"]>> = {
  none: "off",
  low: "minimal",
  medium: "standard",
  high: "extended",
  xhigh: "deep",
  max: "max",
  ultra: "ultra",
};

/** The levels a list of efforts allows, or null when no list is known (every level stays offered, marked unverified). */
function levelsForEfforts(efforts: readonly ChatCompletionReasoningEffort[] | undefined) {
  return efforts?.length ? [...new Set(efforts.map((effort) => THINKING_LEVEL_FOR_EFFORT[effort]))] : null;
}

/** The model a provider starts with when it is picked: its default when it lists it, else its first. */
function startingModel(provider: Controls["providerOptions"][number] | undefined): string {
  if (!provider) return "";
  return provider.defaultModel && provider.models.includes(provider.defaultModel)
    ? provider.defaultModel
    : (provider.models[0] ?? "");
}

export function ChatModelOptionsPopover({
  open,
  onOpenChange,
  trigger,
  contentRef,
  contentId,
  ownsFocus,
  canRestore,
  isCurrent,
  skipReturnFocus,
  props,
  reasoningEfforts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  contentId: string;
  ownsFocus: () => boolean;
  canRestore: () => boolean;
  isCurrent: () => boolean;
  skipReturnFocus: () => void;
  props: Controls;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
}) {
  // A pick is collected here and sent as one change when the popover closes, so arrowing through a select applies
  // nothing on the way and one deliberate choice makes one change.
  const [draft, setDraft] = useState<ModelDraft>({});
  const [dismissedForNavigation, setDismissedForNavigation] = useState(false);
  // Escape and departure to Settings close without sending what was picked.
  const cancelled = useRef(false);
  useEffect(() => {
    if (open) {
      cancelled.current = false;
      setDraft({});
      setDismissedForNavigation(false);
    }
  }, [open]);
  const shownProviderId = draft.providerId ?? props.selectedProviderId;
  const shownModel = draft.model ?? props.selectedModel;
  // The effort choices belong to the model that would be sent: the one in use reads the list the Chat already holds;
  // a held model reads the catalog for that model, and an unknown one is shown as unverified, never as the other
  // model's list.
  const heldAnotherModel = shownProviderId !== props.selectedProviderId || shownModel !== props.selectedModel;
  const supported = levelsForEfforts(
    heldAnotherModel
      ? shownProviderId && shownModel
        ? props.reasoningEffortsFor?.(shownProviderId, shownModel)
        : undefined
      : reasoningEfforts,
  );
  const thinkingLevels = supported ?? ALL_THINKING_LEVELS;
  // An effort the held model does not offer is replaced by the nearest one it does, so Done never sends an invalid pair.
  const pickedThinkingLevel = draft.thinkingLevel ?? props.currentThinkingLevel;
  const shownThinkingLevel =
    heldAnotherModel && supported ? clampGuidedThinkingLevel(pickedThinkingLevel, supported) : pickedThinkingLevel;
  const selectedProvider = props.providerOptions.find((provider) => provider.providerId === shownProviderId);
  const commitDraft = () => {
    const providerId =
      draft.providerId !== undefined && draft.providerId !== (props.selectedProviderId ?? "")
        ? draft.providerId
        : undefined;
    const model =
      draft.model !== undefined && (providerId !== undefined || draft.model !== (props.selectedModel ?? ""))
        ? draft.model
        : undefined;
    const thinkingLevel = shownThinkingLevel !== props.currentThinkingLevel ? shownThinkingLevel : undefined;
    setDraft({});
    if (providerId === undefined && model === undefined && thinkingLevel === undefined) return;
    if (props.onRequestModelChoice) {
      props.onRequestModelChoice({
        ...(providerId !== undefined ? { providerId } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      });
      return;
    }
    // A host without the combined callback gets the same choice one field at a time.
    if (providerId !== undefined) props.onRequestProviderChange(providerId);
    else if (model !== undefined) props.onRequestModelChange(model);
    if (providerId !== undefined && model !== undefined && model !== startingModel(selectedProvider))
      props.onRequestModelChange(model);
    if (thinkingLevel !== undefined) props.onSetThinkingLevel(thinkingLevel);
  };
  const disabled = props.historicalReadOnly || props.sending;
  const providerLabel = useProviderLabelLookup(open && Boolean(shownProviderId) && !selectedProvider);
  const modelLabel = useChatModelLabels(shownProviderId ?? undefined, open);
  const modelOptions = (
    <>
      <label className="flex items-center gap-1">
        Provider
        <select
          aria-label="Provider"
          value={shownProviderId ?? ""}
          disabled={disabled || props.modelSwitchDisabled}
          onChange={(event) => {
            const providerId = event.target.value;
            if (!providerId) return;
            const next = props.providerOptions.find((provider) => provider.providerId === providerId);
            setDraft((current) => ({ ...current, providerId, model: startingModel(next) }));
          }}
          className="max-w-32 rounded-md border border-line-control bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-full"
        >
          <option value="">Choose</option>
          {shownProviderId && !selectedProvider ? (
            <option value={shownProviderId}>
              {providerLabel(shownProviderId) ?? "Current provider"} · catalog unavailable
            </option>
          ) : null}
          {props.providerOptions.map((provider) => (
            <option key={provider.providerId} value={provider.providerId} disabled={provider.disabled}>
              {provider.label}
              {provider.availabilityLabel ? ` · ${provider.availabilityLabel}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Model
        <select
          aria-label="Model"
          value={shownModel ?? ""}
          disabled={disabled || props.modelSwitchDisabled || !selectedProvider}
          onChange={(event) => {
            const model = event.target.value;
            if (model) setDraft((current) => ({ ...current, model }));
          }}
          className="max-w-36 rounded-md border border-line-control bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-full"
        >
          <option value="">Choose</option>
          {shownModel && !selectedProvider?.models.includes(shownModel) ? (
            <option value={shownModel}>{modelLabel(shownModel)} · current, unverified</option>
          ) : null}
          {selectedProvider?.models.map((model) => (
            <option key={model} value={model}>
              {modelLabel(model)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Effort
        <select
          aria-label="Effort"
          value={shownThinkingLevel}
          disabled={disabled}
          onChange={(event) => {
            const level = event.target.value as Controls["currentThinkingLevel"];
            if (thinkingLevels.includes(level)) setDraft((current) => ({ ...current, thinkingLevel: level }));
          }}
          className="rounded-md border border-line-control bg-canvas px-1 py-1 text-fg max-sm:min-h-11"
        >
          {supported && !supported.includes(shownThinkingLevel) ? (
            <option value={shownThinkingLevel} disabled>
              {presentThinkingLevel(shownThinkingLevel)} · current, unsupported by this model
            </option>
          ) : null}
          {thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {presentThinkingLevel(level)}
            </option>
          ))}
        </select>
        {!supported ? (
          <span className="text-fg-muted" title="The model catalog lists no reasoning efforts for this model.">
            · support unverified
          </span>
        ) : null}
      </label>
      <button
        type="button"
        aria-label={`${props.activePersonality?.name ?? "Personality"} · Open personality settings`}
        onClick={() => {
          cancelled.current = true;
          setDismissedForNavigation(true);
          skipReturnFocus();
          onOpenChange(false);
          props.onOpenPersonalitiesSettings?.();
        }}
        disabled={!props.onOpenPersonalitiesSettings}
        className="rounded-md border border-line-control px-2 py-1 text-fg-secondary hover:border-line-strong max-sm:min-h-11"
      >
        {props.activePersonality?.name ?? "Personality"}
      </button>
      {selectedProvider?.contextWindowTokens ? (
        <span className="ml-auto">
          {new Intl.NumberFormat().format(selectedProvider.contextWindowTokens)} token context limit
        </span>
      ) : null}
    </>
  );
  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => trigger.current?.getBoundingClientRect() ?? new DOMRect(),
        get contextElement() {
          return trigger.current ?? undefined;
        },
      },
    }),
    [trigger],
  );
  // The route can hide the Chat anchor before the popover's exit animation finishes.
  if (dismissedForNavigation) return null;

  return (
    <Root
      open={open}
      onOpenChange={(next) => {
        // Done and outside interactions send the collected choice unless this opening was cancelled.
        if (!next && isCurrent() && !cancelled.current) commitDraft();
        onOpenChange(next);
      }}
    >
      <Anchor virtualRef={anchor} />
      <Portal>
        <Content
          id={contentId}
          ref={(element) => {
            contentRef.current = element;
          }}
          side="top"
          align="start"
          sideOffset={8}
          className="z-60 w-80 max-w-full space-y-3 rounded-lg border border-line bg-overlay p-3 text-xs text-fg shadow-overlay"
          onClickCapture={(event) => {
            if (!isCurrent()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onChangeCapture={(event) => {
            if (!isCurrent()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDownCapture={(event) => {
            if (!isCurrent()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onPointerDownCapture={(event) => {
            if (!isCurrent()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onEscapeKeyDown={() => {
            cancelled.current = true;
          }}
          onOpenAutoFocus={(event) => {
            if (!ownsFocus()) event.preventDefault();
          }}
          onInteractOutside={() => skipReturnFocus()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (canRestore() && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
          }}
        >
          <h3 className="text-sm font-semibold">Model and reasoning</h3>
          <div className="flex flex-wrap items-center gap-3">{modelOptions}</div>
          <p className="text-fg-muted">Effort support depends on the selected model.</p>
          <p className="text-fg-muted">Your choice applies when you press Done or click outside. Escape cancels it.</p>
          {/* The composer's mode toggles explain themselves here in visible text, not only in a tooltip (CH-R07). */}
          <dl className="space-y-1 border-t border-line-subtle pt-2 text-fg-secondary">
            <div>
              <dt className="inline font-medium text-fg">Plan first: </dt>
              <dd className="inline">{PLAN_HELP}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-fg">Review answer: </dt>
              <dd className="inline">{REVIEW_HELP}</dd>
            </div>
          </dl>
          <Close className="min-h-9 rounded-md border border-line px-3" type="button">
            Done
          </Close>
        </Content>
      </Portal>
    </Root>
  );
}
