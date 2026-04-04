import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";

export interface GCComboboxOption {
  value: string;
  label: string;
}

interface GCComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: GCComboboxOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

export function GCCombobox({
  value,
  onChange,
  options,
  placeholder = "Search...",
  disabled = false,
  className,
  ...rest
}: GCComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const selectedLabel = useMemo(() => {
    return options.find((option) => option.value === value)?.label ?? value ?? "";
  }, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return options.slice(0, 100);
    }
    return options
      .filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(q))
      .slice(0, 100);
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlightedIndex(-1);
      return;
    }

    const selectedIndex = filtered.findIndex((option) => option.value === value);
    setHighlightedIndex((current) => {
      if (current >= 0 && current < filtered.length) {
        return current;
      }
      if (selectedIndex >= 0) {
        return selectedIndex;
      }
      return filtered.length > 0 ? 0 : -1;
    });
  }, [filtered, open, value]);

  const commitSelection = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => {
        if (filtered.length === 0) {
          return -1;
        }
        return current >= filtered.length - 1 ? 0 : current + 1;
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => {
        if (filtered.length === 0) {
          return -1;
        }
        return current <= 0 ? filtered.length - 1 : current - 1;
      });
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setHighlightedIndex(filtered.length > 0 ? 0 : -1);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(filtered.length > 0 ? filtered.length - 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
        event.preventDefault();
        commitSelection(filtered[highlightedIndex]!.value);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`gc-combobox-trigger${className ? ` ${className}` : ""}`}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onKeyDown={handleTriggerKeyDown}
          {...rest}
        >
          <span>{selectedLabel || placeholder}</span>
          <span aria-hidden>▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="gc-combobox-content"
          sideOffset={6}
          align="start"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <input
            ref={inputRef}
            className="gc-combobox-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={highlightedIndex >= 0 ? `${listboxId}-option-${filtered[highlightedIndex]!.value}` : undefined}
          />
          <ul className="gc-combobox-list" id={listboxId} role="listbox" aria-label="Options">
            {filtered.length === 0 ? (
              <li className="gc-combobox-empty">No matches.</li>
            ) : filtered.map((option, index) => (
              <li key={option.value}>
                <button
                  type="button"
                  id={`${listboxId}-option-${option.value}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={`gc-combobox-option${highlightedIndex === index || option.value === value ? " active" : ""}`}
                  tabIndex={-1}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => {
                    commitSelection(option.value);
                  }}
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
