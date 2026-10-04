import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { isImeEnter } from "./ime";

type PaletteProps = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  "commandSuggestions" | "commandIndex" | "composerPalette" | "onApplyDraftCommand" | "composerRef"
>;

export function ChatComposerPalette({ props }: { props: PaletteProps }) {
  const palette = props.composerPalette;
  if (!palette?.globalOpen && props.commandSuggestions.length === 0) return null;
  const choose = (index: number) => {
    const item = props.commandSuggestions[index];
    if (!item) return;
    if (palette?.enabled) palette.onSelect(item);
    else props.onApplyDraftCommand(item.applyValue);
    props.composerRef.current?.focus();
  };
  return (
    <div className="mb-2 max-h-56 overflow-y-auto rounded-md border border-line bg-overlay p-2 shadow-overlay">
      {palette?.globalOpen ? (
        <label className="block text-xs text-fg-muted">
          Find a command, model, file, or variable
          <input
            autoFocus
            value={palette.query}
            onChange={(event) => palette.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                palette.onClose();
                props.composerRef.current?.focus();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                palette.onIndexChange(Math.min(props.commandIndex + 1, props.commandSuggestions.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                palette.onIndexChange(Math.max(0, props.commandIndex - 1));
              }
              if (event.key === "Enter") {
                if (isImeEnter(event)) return;
                event.preventDefault();
                choose(props.commandIndex);
              }
            }}
            className="mt-1 h-9 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg"
          />
        </label>
      ) : null}
      {palette?.loading ? (
        <p role="status" className="p-2 text-xs text-fg-muted">
          Searching…
        </p>
      ) : null}
      <div role="listbox" aria-label="Composer suggestions" className="mt-1 grid gap-0.5">
        {props.commandSuggestions.map((item, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === props.commandIndex}
            key={item.key}
            onMouseEnter={() => palette?.onIndexChange(index)}
            onClick={() => choose(index)}
            className="flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken aria-[selected=true]:bg-sunken"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{item.command}</span>
              <span className="block truncate text-xs text-fg-muted">{item.description}</span>
            </span>
            {item.availabilityLabel ? (
              <span className="shrink-0 text-xs text-fg-muted">{item.availabilityLabel}</span>
            ) : null}
          </button>
        ))}
      </div>
      {!palette?.loading && props.commandSuggestions.length === 0 ? (
        <p className="p-2 text-xs text-fg-muted">No matching options.</p>
      ) : null}
    </div>
  );
}
