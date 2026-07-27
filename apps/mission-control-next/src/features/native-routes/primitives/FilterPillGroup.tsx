import { useCallback, useMemo, useRef, type KeyboardEvent } from "react";
import { FilterPill } from "./FilterPill";

export type FilterPillOption = {
  /** Stable identifier used to compare against the active value (e.g. "all", namespace string). */
  value: string;
  /** Label shown inside the pill. */
  label: string;
  /** Optional count rendered to the right of the label. */
  count?: number;
  /** Accessible label override. */
  ariaLabel?: string;
};

export type FilterPillGroupProps = {
  /** Accessible name for the tablist (e.g. "Memory namespace filter"). */
  label: string;
  /** Options to render as pills, left-to-right. */
  options: FilterPillOption[];
  /** Currently active option value. */
  value: string;
  /** Called with the next active value when an option is activated. */
  onChange: (value: string) => void;
  /** Optional id prefix applied to each pill (defaults to "filter-pill"). */
  idPrefix?: string;
};

/**
 * Tablist owner for a row of `FilterPill` toggles.
 * Implements the WAI-ARIA roving-tabindex pattern with Arrow Left/Right, Home, End.
 * Activation is automatic — moving focus to a pill selects it (matches the
 * "automatic" tab pattern used elsewhere in Mission Control Next).
 */
export function FilterPillGroup({ label, options, value, onChange, idPrefix = "filter-pill" }: FilterPillGroupProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeIndex = useMemo(() => {
    const index = options.findIndex((option) => option.value === value);
    return index >= 0 ? index : 0;
  }, [options, value]);

  const focusAt = useCallback(
    (index: number) => {
      if (options.length === 0) {
        return;
      }
      const wrapped = ((index % options.length) + options.length) % options.length;
      const next = options[wrapped];
      if (!next) {
        return;
      }
      onChange(next.value);
      // Defer focus so the new tabindex layout is committed first.
      queueMicrotask(() => {
        refs.current[wrapped]?.focus();
      });
    },
    [onChange, options],
  );

  const handleKeyDown = useCallback(
    (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          focusAt(index + 1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          focusAt(index - 1);
          break;
        case "Home":
          event.preventDefault();
          focusAt(0);
          break;
        case "End":
          event.preventDefault();
          focusAt(options.length - 1);
          break;
        default:
          break;
      }
    },
    [focusAt, options.length],
  );

  if (options.length === 0) {
    return null;
  }

  return (
    <div className="mc-next-filter-pill-scroller">
      <div className="mc-next-filter-pill-group" role="tablist" aria-label={label}>
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <FilterPill
              key={option.value}
              ref={(node) => {
                refs.current[index] = node;
              }}
              id={`${idPrefix}-${option.value}`}
              label={option.label}
              count={option.count}
              selected={selected}
              tabIndex={index === activeIndex ? 0 : -1}
              ariaLabel={option.ariaLabel}
              onSelect={() => onChange(option.value)}
              onKeyDown={handleKeyDown(index)}
            />
          );
        })}
      </div>
      <span className="mc-next-filter-pill-hint" aria-hidden="true">
        Swipe for more filters
      </span>
    </div>
  );
}
