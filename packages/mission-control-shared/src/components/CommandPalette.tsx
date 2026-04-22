import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { appCopy, globalCopy } from "../content/copy";

export interface CommandPaletteItem {
  id: string;
  label: string;
  keywords?: string[];
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandPaletteItem[];
}

export function CommandPalette({ open, onClose, items }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const headingId = useId();
  const listboxId = useId();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(-1);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return items.slice(0, 12);
    }
    return items
      .filter((item) => {
        const haystack = [item.label, ...(item.keywords ?? [])].join(" ").toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 12);
  }, [items, query]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedIndex(-1);
      return;
    }
    setSelectedIndex((current) => {
      if (current < 0 || current >= filtered.length) {
        return 0;
      }
      return current;
    });
  }, [filtered]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      queueMicrotask(() => {
        inputRef.current?.focus();
      });
    }

    if (!open && wasOpenRef.current) {
      previouslyFocusedElementRef.current?.focus();
      previouslyFocusedElementRef.current = null;
    }

    wasOpenRef.current = open;
  }, [open]);

  const closePalette = () => {
    onClose();
  };

  const activateSelectedItem = () => {
    if (selectedIndex < 0 || selectedIndex >= filtered.length) {
      return;
    }
    filtered[selectedIndex]?.run();
    closePalette();
  };

  const focusableSelectors = [
    "input:not([disabled])",
    "button:not([disabled])",
    "[href]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(", ");

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusables = dialogRef.current
      ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelectors)).filter((element) => !element.hasAttribute("disabled"))
      : [];

    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (event.shiftKey) {
      if (!active || active === first || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (!active || active === last || !dialogRef.current?.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0 && (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      if (event.key === "Enter") {
        closePalette();
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setSelectedIndex((current) => Math.min(filtered.length - 1, Math.max(0, current + 1)));
        break;
      case "ArrowUp":
        event.preventDefault();
        setSelectedIndex((current) => Math.max(0, current <= 0 ? 0 : current - 1));
        break;
      case "Home":
        event.preventDefault();
        setSelectedIndex(filtered.length > 0 ? 0 : -1);
        break;
      case "End":
        event.preventDefault();
        setSelectedIndex(filtered.length > 0 ? filtered.length - 1 : -1);
        break;
      case "Enter":
        event.preventDefault();
        activateSelectedItem();
        break;
      case "Escape":
        event.preventDefault();
        closePalette();
        break;
      default:
        break;
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={closePalette}>
      <div
        ref={dialogRef}
        className="modal-card command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="command-palette-head">
          <div>
            <p className="command-palette-kicker">Command Center</p>
            <h3 id={headingId}>{appCopy.quickActionsButton.replace(" (Ctrl/Cmd+K)", "")}</h3>
          </div>
          <p className="command-palette-hint">Esc to close</p>
        </header>
        <div className="command-palette-search">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={globalCopy.commandPalette.placeholder}
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={selectedIndex >= 0 ? `${listboxId}-option-${filtered[selectedIndex]?.id}` : undefined}
          />
          <span className="command-palette-shortcut">Ctrl/Cmd + K</span>
        </div>
        <ul id={listboxId} className="command-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="command-palette-empty">No matching actions.</li>
          ) : filtered.map((item, index) => (
            <li key={item.id} className="command-palette-item">
              <button
                id={`${listboxId}-option-${item.id}`}
                type="button"
                className={["gc-button", (`command-palette-action${selectedIndex === index ? " active" : ""}`)].filter(Boolean).join(" ")}
                role="option"
                aria-selected={selectedIndex === index}
                onMouseEnter={() => setSelectedIndex(index)}
                onFocus={() => setSelectedIndex(index)}
                onClick={() => {
                  item.run();
                  closePalette();
                }}
              >
                <span>{item.label}</span>
                <span className="command-palette-go">↵</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
