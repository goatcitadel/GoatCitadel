import { useEffect, useRef, useState } from "react";
import { isModifiedClick } from "../lib/modified-click";

export interface OverflowTab {
  id: string;
  label: string;
  href: string;
}

/**
 * One row of view tabs that never wraps or clips silently (DESIGN.md › Page anatomy): it scrolls sideways, the hidden
 * side fades out so the operator can tell more tabs exist, and the current tab is kept in view. The tabs stay links at
 * every width, so the current view is always a real, named link.
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
  }, [tabs.length]);
  useEffect(() => {
    row.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
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
