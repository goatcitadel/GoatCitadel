import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { GCSelect } from "./ui/GCSelect";
import { Button } from "./ui/button";

interface PageTabItem {
  id: string;
  label: string;
}

interface PageTabsProps {
  items: PageTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  tier: "space" | "page" | "section";
  vertical?: boolean;
  className?: string;
  ariaLabel?: string;
}

function readCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(max-width: 767px)").matches;
}

function defaultAriaLabelForTier(tier: PageTabsProps["tier"]): string {
  if (tier === "space") {
    return "Space navigation";
  }
  if (tier === "page") {
    return "Page navigation";
  }
  return "Section navigation";
}

export function PageTabs({ items, activeId, onSelect, tier, vertical = false, className, ariaLabel }: PageTabsProps) {
  const [compactViewport, setCompactViewport] = useState(() => readCompactViewport());
  const options = useMemo(() => items.map((item) => ({ value: item.id, label: item.label })), [items]);
  const navLabel = ariaLabel ?? defaultAriaLabelForTier(tier);

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
      <nav className={`page-tabs page-tabs-compact${className ? ` ${className}` : ""}`} aria-label={navLabel}>
        <GCSelect
          value={activeId}
          onChange={onSelect}
          options={options}
          className="page-tabs-select"
          aria-label={navLabel}
        />
      </nav>
    );
  }

  return (
    <nav
      aria-label={navLabel}
      className={cn("page-tabs mc-page-tabs", `page-tabs-tier-${tier}`, vertical && "page-tabs-vertical", className)}
    >
      <div
        role="tablist"
        className={cn("mc-page-tabs-list", vertical ? "flex-col items-stretch" : "flex-wrap justify-start")}
      >
        {items.map((item) => (
          <Button
            key={item.id}
            type="button"
            role="tab"
            variant={item.id === activeId ? "default" : "ghost"}
            aria-selected={item.id === activeId}
            className={cn(
              "page-tab gc-nav-button mc-page-tab",
              `gc-nav-tier-${tier}`,
              item.id === activeId && "active",
            )}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
    </nav>
  );
}
