import { useLayoutEffect, useRef } from "react";
import { COCKPIT_LOCATION_EVENT } from "./cockpit-back-guard";

// App-session view state only. Key includes installation, caller, scope and exact URL.
// How long a started navigation may take to replace this page before the page is taken to be staying.
const NAVIGATION_WAIT_MS = 600;
const positions = new Map<string, number>();
export function useCockpitScroll(key: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const target = positions.get(key) ?? 0;
    let restoring = true;
    // Set once navigation starts: the next page may clamp this shared scroller before React swaps it in.
    let leaving = false;
    const restore = () => {
      if (restoring) element.scrollTop = target;
    };
    restore();
    // Lazy area content may arrive after the first layout. Stop restoring on operator input.
    const observer = new MutationObserver(restore);
    observer.observe(element, { childList: true, subtree: true });
    const interact = () => {
      leaving = false;
      restoring = false;
      observer.disconnect();
    };
    const remember = () => {
      if (leaving) return;
      if (!restoring || element.scrollTop === target) positions.set(key, element.scrollTop);
    };
    // Both fire before React renders the next page, so this is the last honest position of this one (U-GL-049).
    // A navigation that never happens (a swallowed Back, a sheet that closes) leaves this page mounted under the same
    // key, so after the wait below the page counts as current again and keeps saving its position.
    let stay: ReturnType<typeof setTimeout> | undefined;
    const leave = () => {
      remember();
      leaving = true;
      clearTimeout(stay);
      stay = setTimeout(() => {
        leaving = false;
      }, NAVIGATION_WAIT_MS);
    };
    window.addEventListener(COCKPIT_LOCATION_EVENT, leave);
    window.addEventListener("popstate", leave);
    element.addEventListener("wheel", interact, { passive: true });
    element.addEventListener("touchstart", interact, { passive: true });
    element.addEventListener("pointerdown", interact);
    element.addEventListener("keydown", interact);
    element.addEventListener("scroll", remember, { passive: true });
    return () => {
      clearTimeout(stay);
      observer.disconnect();
      element.removeEventListener("wheel", interact);
      element.removeEventListener("touchstart", interact);
      element.removeEventListener("pointerdown", interact);
      element.removeEventListener("keydown", interact);
      element.removeEventListener("scroll", remember);
      window.removeEventListener(COCKPIT_LOCATION_EVENT, leave);
      window.removeEventListener("popstate", leave);
    };
  }, [key]);
  return ref;
}
