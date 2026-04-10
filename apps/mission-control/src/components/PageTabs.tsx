import { useEffect, useMemo, useState } from "react";
import { GCSelect } from "./ui/GCSelect";

interface PageTabItem {
  id: string;
  label: string;
}

interface PageTabsProps {
  items: PageTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  vertical?: boolean;
  className?: string;
}

function readCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(max-width: 767px)").matches;
}

export function PageTabs({ items, activeId, onSelect, vertical = false, className }: PageTabsProps) {
  const [compactViewport, setCompactViewport] = useState(() => readCompactViewport());
  const options = useMemo(() => items.map((item) => ({ value: item.id, label: item.label })), [items]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateViewport = (event?: MediaQueryListEvent) => {
      setCompactViewport(event?.matches ?? mediaQuery.matches);
    };

    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  if (vertical && compactViewport) {
    return (
      <nav className={`page-tabs page-tabs-compact${className ? ` ${className}` : ""}`} aria-label="Section tabs">
        <GCSelect
          value={activeId}
          onChange={onSelect}
          options={options}
          className="page-tabs-select"
          aria-label="Section tabs"
        />
      </nav>
    );
  }

  return (
    <nav className={`page-tabs${vertical ? " page-tabs-vertical" : ""}${className ? ` ${className}` : ""}`} aria-label="Section tabs">
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`page-tab gc-nav-pill${item.id === activeId ? " active" : ""}`}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
