import { forwardRef, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/Popover";

export interface CategoryOption {
  id: string;
  label: string;
}

const DEFAULT_VISIBLE_COUNT = 3;
const DEFAULT_LABEL = "Categories";

const CategoryChip = forwardRef<HTMLButtonElement, { label: string; pressed?: boolean; onClick: () => void }>(
  function CategoryChip({ label, pressed, onClick }, ref) {
    return (
      <Button
        ref={ref}
        size="sm"
        aria-pressed={pressed}
        onClick={onClick}
        className="rounded-full aria-pressed:border-accent aria-pressed:bg-sunken"
      >
        {/* The check keeps the selected state readable without colour. */}
        {pressed ? <Check aria-hidden="true" className="size-3.5" /> : null}
        {label}
      </Button>
    );
  },
);

/**
 * Category buttons for a Capabilities list. "All" comes first, then the first `visibleCount` options (default 3); the
 * rest go under a "+N" button that opens a small panel. A selected option always stays in the row, so the operator can
 * see and clear what is filtering the list.
 *
 * It is controlled. An empty `selected` means "All", and so does selecting every option: `onChange` reports `[]`
 * instead of the full list, and a `selected` that holds every option is shown as "All". Ids that are not options are
 * ignored, and the selection is reported in option order.
 */
export function CategoryFilter({
  options,
  selected,
  onChange,
  visibleCount = DEFAULT_VISIBLE_COUNT,
  label = DEFAULT_LABEL,
}: {
  options: readonly CategoryOption[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  visibleCount?: number;
  /** What the buttons choose, as the group's accessible name. A list with two groups names each one. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const allChip = useRef<HTMLButtonElement>(null);
  const rowChips = useRef(new Map<string, HTMLButtonElement>());
  const overflowButton = useRef<HTMLButtonElement>(null);
  // The option the operator just changed, so focus can follow it when it moves between the row and the panel.
  const refocus = useRef<string | null>(null);

  const chosen = options.filter((option) => selected.includes(option.id)).map((option) => option.id);
  const active = chosen.length === options.length ? [] : chosen;
  const visible = options.filter((option, index) => index < visibleCount || active.includes(option.id));
  const hidden = options.filter((option) => !visible.includes(option));

  const toggle = (id: string) => {
    refocus.current = id;
    const next = active.includes(id)
      ? active.filter((activeId) => activeId !== id)
      : options.filter((option) => option.id === id || active.includes(option.id)).map((option) => option.id);
    onChange(next.length === options.length ? [] : next);
  };
  const pickHidden = (id: string) => {
    // The picked option now shows in the row, and focus goes there (see the effect below). Nothing here stops the
    // panel's usual step of returning focus to "+N" on close. That step is skipped only because the effect below runs
    // while the panel's dismissable layer is still mounted: its focus-outside listener sees the focus move and Radix
    // then leaves focus alone. This depends on the pinned radix-ui version's internals, which is why the focus tests
    // wait for the close step to run before checking where focus ended up.
    setOpen(false);
    toggle(id);
  };

  // Runs after the render that moved the option, so the chip it landed on exists. If the option left the row (or the
  // "+N" button went away), focus falls back to "+N", then to "All", and is never dropped to the page.
  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    (rowChips.current.get(id) ?? overflowButton.current ?? allChip.current)?.focus();
  });

  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <CategoryChip ref={allChip} label="All" pressed={active.length === 0} onClick={() => onChange([])} />
      {visible.map((option) => (
        <CategoryChip
          key={option.id}
          ref={(element) => {
            if (element) rowChips.current.set(option.id, element);
            else rowChips.current.delete(option.id);
          }}
          label={option.label}
          pressed={active.includes(option.id)}
          onClick={() => toggle(option.id)}
        />
      ))}
      {hidden.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              ref={overflowButton}
              size="sm"
              aria-label={`+${plural(hidden.length, "more category", "more categories")}`}
              className="rounded-full"
            >
              +{hidden.length}
            </Button>
          </PopoverTrigger>
          <PopoverContent aria-label="More categories">
            <div className="flex flex-wrap gap-1.5">
              {hidden.map((option) => (
                <CategoryChip key={option.id} label={option.label} onClick={() => pickHidden(option.id)} />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
