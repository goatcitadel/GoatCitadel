import { useEffect, useRef, useState } from "react";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { isModifiedClick } from "../lib/modified-click";

export interface OverflowTab {
  id: string;
  label: string;
  href: string;
}

/** A strip this long cannot fit a phone, so on a phone it becomes a section picker. */
export const PICKER_MIN_TABS = 6;

/**
 * One row of view tabs that never wraps or clips silently (DESIGN.md › Page anatomy): it scrolls sideways, the hidden
 * side fades out so the operator can tell more tabs exist, and the current tab is kept in view. The tabs stay links at
 * every width except a phone with many tabs, where a native picker bound to the same routes replaces the strip.
 */
export function OverflowTabs({
  label,
  tabs,
  current,
  navigate,
}: {
  label: string;
  tabs: readonly OverflowTab[];
  current: string;
  navigate: (href: string) => void;
}) {
  const phone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  const picker = phone && tabs.length >= PICKER_MIN_TABS;
  const row = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = row.current;
    if (!element) return undefined;
    const measure = () =>
      setEdges({
        start: element.scrollLeft > 1,
        end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [tabs.length, picker]);
  useEffect(() => {
    row.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current, picker]);
  if (picker) {
    const selected = tabs.find((tab) => tab.id === current);
    return (
      <nav aria-label={label} className="cockpit-area-tabs-picker">
        <select
          aria-label={`${label}: choose a section`}
          value={selected?.href ?? ""}
          onChange={(event) => navigate(event.target.value)}
          className="h-11 w-full rounded-md border border-line-control bg-canvas px-2 text-md text-fg"
        >
          {selected ? null : <option value="">Choose a section</option>}
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.href}>
              {tab.label}
            </option>
          ))}
        </select>
      </nav>
    );
  }
  return (
    <nav
      ref={row}
      aria-label={label}
      data-overflow-start={edges.start || undefined}
      data-overflow-end={edges.end || undefined}
      className="cockpit-area-tabs cockpit-overflow-fade flex gap-1 overflow-x-auto border-b border-line-subtle"
    >
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          aria-current={current === tab.id ? "page" : undefined}
          onClick={(event) => {
            if (isModifiedClick(event)) return;
            event.preventDefault();
            navigate(tab.href);
          }}
          className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg"
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
