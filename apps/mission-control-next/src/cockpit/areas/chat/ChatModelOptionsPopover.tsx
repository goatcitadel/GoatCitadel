import { Root, Anchor, Portal, Content, Close } from "@radix-ui/react-popover";
import { useMemo, type RefObject } from "react";
import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import type { ChatModelOptionsControls as Controls } from "./ChatComposerControls";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { GUIDED_THINKING_LEVELS } from "../../../features/native-routes/settings/sections/guided-model-setup-support";

/** Every effort stays selectable while the catalog records no reasoning metadata; the Gateway still gates the send. */
const ALL_THINKING_LEVELS: readonly Controls["currentThinkingLevel"][] = GUIDED_THINKING_LEVELS.map(
  (option) => option.value,
);

export function ChatModelOptionsPopover({
  open,
  onOpenChange,
  trigger,
  contentRef,
  contentId,
  ownsFocus,
  canRestore,
  isCurrent,
  onOutside,
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
  onOutside: () => void;
  props: Controls;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
}) {
  const supported = reasoningEfforts?.length
    ? [
        ...new Set<Controls["currentThinkingLevel"]>([
          ...reasoningEfforts.map(
            (effort) =>
              (
                ({
                  none: "off",
                  low: "minimal",
                  medium: "standard",
                  high: "extended",
                  xhigh: "deep",
                  max: "max",
                  ultra: "ultra",
                }) as const
              )[effort],
          ),
        ]),
      ]
    : null;
  const thinkingLevels = supported ?? ALL_THINKING_LEVELS;
  const selectedProvider = props.providerOptions.find((provider) => provider.providerId === props.selectedProviderId);
  const disabled = props.historicalReadOnly || props.sending;
  const modelOptions = (
    <>
      <label className="flex items-center gap-1">
        Provider
        <select
          aria-label="Provider"
          value={props.selectedProviderId ?? ""}
          disabled={disabled || props.modelSwitchDisabled}
          onChange={(event) => {
            if (event.target.value) props.onRequestProviderChange(event.target.value);
          }}
          className="max-w-32 rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-full"
        >
          <option value="">Choose</option>
          {props.selectedProviderId && !selectedProvider ? (
            <option value={props.selectedProviderId}>{props.selectedProviderId} · current, catalog unavailable</option>
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
          value={props.selectedModel ?? ""}
          disabled={disabled || props.modelSwitchDisabled || !selectedProvider}
          onChange={(event) => {
            if (event.target.value) props.onRequestModelChange(event.target.value);
          }}
          className="max-w-36 rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-full"
        >
          <option value="">Choose</option>
          {props.selectedModel && !selectedProvider?.models.includes(props.selectedModel) ? (
            <option value={props.selectedModel}>{props.selectedModel} · current, unverified</option>
          ) : null}
          {selectedProvider?.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Effort
        <select
          aria-label="Thinking effort"
          value={props.currentThinkingLevel}
          disabled={disabled}
          onChange={(event) => {
            const level = event.target.value as Controls["currentThinkingLevel"];
            if (thinkingLevels.includes(level)) props.onSetThinkingLevel(level);
          }}
          className="rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11"
        >
          {supported && !supported.includes(props.currentThinkingLevel) ? (
            <option value={props.currentThinkingLevel} disabled>
              {humanizeToken(props.currentThinkingLevel)} · current, unsupported by this model
            </option>
          ) : null}
          {thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {humanizeToken(level)}
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
        aria-label="Open personality settings"
        onClick={props.onOpenPersonalitiesSettings}
        disabled={!props.onOpenPersonalitiesSettings}
        className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-line-strong max-sm:min-h-11"
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
  return (
    <Root open={open} onOpenChange={onOpenChange}>
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
          className="z-50 w-80 max-w-full space-y-3 rounded-lg border border-line bg-overlay p-3 text-xs text-fg shadow-overlay"
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
          onOpenAutoFocus={(event) => {
            if (!ownsFocus()) event.preventDefault();
          }}
          onInteractOutside={() => onOutside()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (canRestore() && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
          }}
        >
          <h3 className="text-sm font-semibold">Model and reasoning</h3>
          <div className="flex flex-wrap items-center gap-3">{modelOptions}</div>
          <p className="text-fg-muted">Effort support depends on the selected model.</p>
          <Close className="min-h-9 rounded-md border border-line px-3" type="button">
            Done
          </Close>
        </Content>
      </Portal>
    </Root>
  );
}
