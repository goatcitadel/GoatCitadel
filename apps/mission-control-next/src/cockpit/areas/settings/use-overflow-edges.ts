import { useEffect, useState, type RefObject } from "react";

/**
 * Tracks which sides of a sideways-scrolling row hide content, for the `cockpit-overflow-fade` edge cue. The row is
 * found inside `host` by `selector`, so a Radix list keeps its own element, role and accessible name.
 */
export function useOverflowEdges(host: RefObject<HTMLElement | null>, selector: string, key: unknown) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = host.current?.querySelector<HTMLElement>(selector);
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
  }, [host, selector, key]);
  return edges;
}
