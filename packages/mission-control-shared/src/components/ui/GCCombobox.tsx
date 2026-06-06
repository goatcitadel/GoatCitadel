import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronsUpDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

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
      .map((option) => ({ option, score: scoreFuzzyOption(option, q) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.option.label.localeCompare(right.option.label);
      })
      .map((entry) => entry.option)
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

  const highlightedOption =
    highlightedIndex >= 0 && highlightedIndex < filtered.length ? filtered[highlightedIndex] : undefined;

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
      if (highlightedOption) {
        event.preventDefault();
        commitSelection(highlightedOption.value);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("gc-combobox-trigger mc-gc-combobox-trigger justify-between", className)}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onKeyDown={handleTriggerKeyDown}
          {...rest}
        >
          <span>{selectedLabel || placeholder}</span>
          <ChevronsUpDownIcon className="size-4 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="gc-combobox-content mc-gc-combobox-content p-0"
        side="bottom"
        sideOffset={6}
        align="start"
        collisionPadding={12}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <Command className="rounded-lg border-0 bg-transparent p-0" shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            className="gc-combobox-input"
            value={query}
            onValueChange={setQuery}
            onKeyDown={handleInputKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={highlightedOption ? `${listboxId}-option-${highlightedOption.value}` : undefined}
          />
          <CommandList
            className="gc-combobox-list mc-gc-combobox-list"
            id={listboxId}
            role="listbox"
            aria-label="Options"
          >
            <CommandEmpty className="gc-combobox-empty">No matches.</CommandEmpty>
            <CommandGroup>
              {filtered.map((option, index) => (
                <CommandItem
                  key={option.value}
                  id={`${listboxId}-option-${option.value}`}
                  value={`${option.label} ${option.value}`}
                  role="option"
                  aria-selected={option.value === value}
                  data-checked={option.value === value}
                  className={cn(
                    "gc-combobox-option mc-gc-combobox-option",
                    (highlightedIndex === index || option.value === value) && "active",
                  )}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onSelect={() => {
                    commitSelection(option.value);
                  }}
                >
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function scoreFuzzyOption(option: GCComboboxOption, query: string): number {
  const haystack = `${option.label} ${option.value}`.toLowerCase();
  const compactHaystack = haystack.replace(/[^a-z0-9]+/g, "");
  const compactQuery = query.replace(/[^a-z0-9]+/g, "");
  if (!compactQuery) {
    return 1;
  }
  if (haystack === query || compactHaystack === compactQuery) {
    return 100;
  }
  if (haystack.startsWith(query) || compactHaystack.startsWith(compactQuery)) {
    return 80;
  }
  if (haystack.includes(query) || compactHaystack.includes(compactQuery)) {
    return 60;
  }
  const queryParts = query.split(/[^a-z0-9]+/).filter(Boolean);
  if (queryParts.length > 1) {
    return /\s/.test(query) && queryParts.every((part) => haystack.includes(part) || compactHaystack.includes(part))
      ? 55
      : 0;
  }
  const acronym = haystack
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
  if (acronym.startsWith(compactQuery)) {
    return 50;
  }
  if (/[^a-z0-9]/.test(query)) {
    return 0;
  }
  return scoreOrderedCharacters(compactHaystack, compactQuery);
}

function scoreOrderedCharacters(haystack: string, query: string): number {
  let cursor = 0;
  let gapPenalty = 0;
  for (const char of query) {
    const next = haystack.indexOf(char, cursor);
    if (next < 0) {
      return 0;
    }
    gapPenalty += Math.max(0, next - cursor);
    cursor = next + 1;
  }
  return Math.max(1, 40 - gapPenalty);
}
