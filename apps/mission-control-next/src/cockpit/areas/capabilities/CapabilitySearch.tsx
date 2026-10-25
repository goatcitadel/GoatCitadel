import { useId, type ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "../../lib/cn";
import { cockpitInputClass } from "../../ui/input-class";

/**
 * The search box every Capabilities tab shares. The current tab's name sits in the box as a small badge and is the
 * box's label (read as "Search <tab>"), and the tab's own buttons, such as "Add your own", sit to its right. The
 * placeholder comes from the tab, so it can suggest a real term from the operator's own data.
 */
export function CapabilitySearch({
  tabLabel,
  value,
  onChange,
  placeholder,
  actions,
}: {
  /** The current tab's name, for example "Connectors". */
  tabLabel: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** The tab's own buttons, shown to the right of the box. */
  actions?: ReactNode;
}) {
  const id = useId();
  return (
    <div role="search" className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-64">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
        />
        {/* A plain text box inside the search landmark: the native clear button of type=search would sit under the badge. */}
        <input
          id={id}
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          maxLength={200}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={cn(cockpitInputClass, "pl-9 pr-28 placeholder:text-fg-muted")}
        />
        <label
          htmlFor={id}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-line px-2 py-0.5 text-xs text-fg-secondary"
        >
          <span className="sr-only">Search </span>
          {tabLabel}
        </label>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
