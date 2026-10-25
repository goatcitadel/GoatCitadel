import { useEffect } from "react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { isImeEnter } from "./ime";

/** "Available" is the normal state of a row; only a row that differs (needs review, read-only…) carries a badge. */
const DEFAULT_AVAILABILITY = "Available";

type PaletteProps = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  "commandSuggestions" | "commandIndex" | "composerPalette" | "onApplyDraftCommand" | "composerRef"
>;

export function ChatComposerPalette({
  props,
  onSelect,
}: {
  props: PaletteProps;
  onSelect?: (item: PaletteProps["commandSuggestions"][number]) => void;
}) {
  const palette = props.composerPalette;
  const activeId = `cockpit-suggestion-${props.commandIndex}`;
  useEffect(() => {
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);
  // A search that is still running keeps the menu open, so the first "/" never looks like nothing happened.
  if (!palette?.globalOpen && !palette?.loading && props.commandSuggestions.length === 0) return null;
  const choose = (index: number) => {
    const item = props.commandSuggestions[index];
    if (!item) return;
    if (palette?.enabled) (onSelect ?? palette.onSelect)(item);
    else props.onApplyDraftCommand(item.applyValue);
    props.composerRef.current?.focus();
  };
  return (
    <div className="mb-2 rounded-md border border-line bg-overlay p-2">
      {palette?.globalOpen ? (
        <label className="block text-xs text-fg-muted">
          Find a command, model, file, or variable
          <input
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-controls="cockpit-composer-suggestions"
            aria-activedescendant={
              props.commandSuggestions[props.commandIndex] ? `cockpit-suggestion-${props.commandIndex}` : undefined
            }
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
            className="mt-1 h-9 w-full rounded-md border border-line-control bg-canvas px-2 text-md text-fg sm:text-sm"
          />
        </label>
      ) : null}
      {palette?.loading ? (
        <p role="status" className="p-2 text-xs text-fg-muted">
          Searching…
        </p>
      ) : null}
      <div
        id="cockpit-composer-suggestions"
        role="listbox"
        aria-label="Composer suggestions"
        // Rows are 3rem tall with a 2px gap, so five rows fit exactly and a scrolled list rests on a whole row.
        className="mt-1 grid max-h-62 snap-y snap-mandatory gap-0.5 overflow-y-auto"
      >
        {props.commandSuggestions.map((item, index) => (
          <button
            type="button"
            role="option"
            tabIndex={-1}
            id={`cockpit-suggestion-${index}`}
            aria-selected={index === props.commandIndex}
            key={item.key}
            onMouseEnter={() => palette?.onIndexChange(index)}
            // Focus stays on the combobox that owns the listbox; selection follows aria-activedescendant.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(index)}
            className="flex h-12 w-full snap-start items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken aria-[selected=true]:bg-sunken"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{item.command}</span>
              <span className="block truncate text-xs text-fg-muted">{item.description}</span>
            </span>
            {item.availabilityLabel && item.availabilityLabel !== DEFAULT_AVAILABILITY ? (
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
