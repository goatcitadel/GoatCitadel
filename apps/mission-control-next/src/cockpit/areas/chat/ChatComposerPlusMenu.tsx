import { useRef, useState, type ReactNode } from "react";
import { Command, Library, Paperclip, Plus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/Popover";
import { ChatComposerModeOptions, WEB_MODES } from "./ChatComposerControls";
import { ChatMediaControls } from "./ChatMediaControls";
import { ChatSourcesChip, sourcesChipLabel } from "./ChatSourcesChip";
import type { ComposerSources } from "./ChatComposerTools";
import type { ComposerProps } from "./ChatTextComposer.types";

const ROW =
  "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fg hover:bg-sunken disabled:cursor-not-allowed disabled:text-fg-muted max-sm:min-h-11";

function PanelRow({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={ROW} disabled={disabled} onClick={onClick}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-xs text-fg-muted">{hint}</span> : null}
    </button>
  );
}

/**
 * The composer's + button. Everything that adds to the next message or changes how it runs sits behind it: files,
 * read-only sources, commands and context, Plan first, Web search, Review answer, and voice and images. The model chip
 * and Send stay on the row; a mode that is not at its default shows as a pill beside the + (`ChatComposerModePills`).
 */
export function ChatComposerPlusMenu({
  props,
  sources,
  channelConversation,
}: {
  props: ComposerProps;
  sources: ComposerSources;
  /** A channel conversation takes no files, sources or modes from here; only commands remain. */
  channelConversation: boolean;
}) {
  const [open, setOpen] = useState(false);
  // An action that moves focus elsewhere (the command palette, the sources form) keeps it there on close.
  const handedOff = useRef(false);
  const disabled = props.historicalReadOnly || props.sending;
  const act = (action: () => void, handOff = false) => {
    handedOff.current = handOff;
    setOpen(false);
    action();
  };
  const sourceControls = props.externalSourceControls;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="Add and options"
        title="Add files, sources and commands; set modes"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-line-control text-fg-secondary hover:border-fg hover:text-fg data-[state=open]:border-accent max-sm:size-11"
      >
        <Plus aria-hidden="true" className="size-5" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        aria-label="Add and options"
        className="w-80 space-y-2 text-xs text-fg-secondary"
        onCloseAutoFocus={(event) => {
          if (handedOff.current) event.preventDefault();
          handedOff.current = false;
        }}
      >
        <div className="space-y-0.5">
          {channelConversation ? null : (
            <>
              <PanelRow
                icon={<Paperclip aria-hidden="true" className="size-4 shrink-0" />}
                label="Attach files"
                disabled={disabled}
                onClick={() => act(props.onAttachFiles)}
              />
              {sourceControls ? (
                <PanelRow
                  icon={<Library aria-hidden="true" className="size-4 shrink-0" />}
                  label={sourcesChipLabel(sourceControls)}
                  onClick={() => act(sources.onToggle, true)}
                />
              ) : null}
            </>
          )}
          <PanelRow
            icon={<Command aria-hidden="true" className="size-4 shrink-0" />}
            label="Commands and context"
            hint="/ @ $"
            disabled={!props.composerPalette?.enabled}
            onClick={() => act(() => props.composerPalette?.onOpen(), true)}
          />
        </div>
        {channelConversation ? null : (
          <>
            <div
              role="group"
              aria-label="Modes"
              className="cockpit-chat-controls flex flex-wrap items-center gap-2 border-t border-line-subtle pt-2"
            >
              <ChatComposerModeOptions props={props} disabled={disabled} />
            </div>
            <div className="border-t border-line-subtle pt-1">
              <ChatMediaControls props={props} />
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

const PILL =
  "inline-flex min-h-7 items-center gap-1 rounded-full border border-accent bg-sunken py-0.5 pl-2.5 pr-1 text-xs text-fg max-sm:min-h-9";

function ModePill({
  label,
  removeLabel,
  disabled,
  onRemove,
}: {
  label: string;
  removeLabel: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <span className={PILL}>
      {label}
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        disabled={disabled}
        onClick={onRemove}
        className="inline-flex size-5 items-center justify-center rounded-full text-fg-secondary hover:bg-raised hover:text-fg disabled:opacity-60"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * What is switched on for the next message, beside the +: Plan first, a web mode other than Auto, Review answer, and
 * attached sources. Each pill turns its mode back off; the full controls live in the + panel.
 */
export function ChatComposerModePills({ props, sources }: { props: ComposerProps; sources: ComposerSources }) {
  const disabled = props.historicalReadOnly || props.sending;
  const webLabel =
    props.currentWebMode === "quick"
      ? "Quick (retired)"
      : WEB_MODES.find((mode) => mode.value === props.currentWebMode)?.label;
  const sourceControls = props.externalSourceControls;
  return (
    <>
      {props.planningMode === "advisory" ? (
        <ModePill
          label="Plan first"
          removeLabel="Turn off Plan first"
          disabled={disabled}
          onRemove={props.onTogglePlanningMode}
        />
      ) : null}
      {props.currentWebMode !== "auto" && webLabel && props.onSetWebMode ? (
        <ModePill
          label={`Web: ${webLabel}`}
          removeLabel="Set web search back to Auto"
          disabled={disabled}
          onRemove={() => props.onSetWebMode?.("auto")}
        />
      ) : null}
      {props.currentReviewDepth !== "off" ? (
        <ModePill
          label="Review answer"
          removeLabel="Turn off Review answer"
          disabled={disabled}
          onRemove={props.onToggleReviewMode}
        />
      ) : null}
      {sourceControls && sourceControls.attachments.length > 0 ? (
        <ChatSourcesChip
          controls={sourceControls}
          open={sources.open}
          panelId={sources.panelId}
          onToggle={sources.onToggle}
        />
      ) : null}
    </>
  );
}
