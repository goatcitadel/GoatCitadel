import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Tracks which sides of a sideways-scrolling row hide content, for the `cockpit-overflow-fade` edge cue. Put `ref` on
 * the scrolling row and `start`/`end` on its `data-overflow-start`/`data-overflow-end`. `deps` re-measure the row when
 * its contents change (a tab added or removed, a picker swapped for the strip); a 1 px tolerance ignores rounding.
 */
export function useScrollEdges<T extends HTMLElement>(
  deps: readonly unknown[],
): { ref: RefObject<T | null>; start: boolean; end: boolean } {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      // Scroll fires many times a second; an unchanged answer keeps the same state so nothing re-renders.
      setEdges((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
    // The caller names what changes the row; the ref itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ref, ...edges };
}
