import type { ReactNode } from "react";
import { Command, Library, Paperclip } from "lucide-react";
import { ChatComposerModeOptions } from "./ChatComposerControls";
import { ChatMediaControls } from "./ChatMediaControls";
import { sourcesChipLabel } from "./ChatSourcesChip";
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

export function ChatComposerPlusMenuContent({
  props,
  sources,
  channelConversation,
  act,
}: {
  props: ComposerProps;
  sources: ComposerSources;
  channelConversation: boolean;
  act: (action: () => void, handOff?: boolean) => void;
}) {
  const disabled = props.historicalReadOnly || props.sending;
  const sourceControls = props.externalSourceControls;
  return (
    <>
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
    </>
  );
}
