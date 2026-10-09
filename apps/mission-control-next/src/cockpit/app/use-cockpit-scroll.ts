import { useLayoutEffect, useRef } from "react";

// App-session view state only. Key includes installation, caller, scope and exact URL.
const positions = new Map<string, number>();
export function useCockpitScroll(key: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const target = positions.get(key) ?? 0;
    let restoring = true;
    const restore = () => {
      if (restoring) element.scrollTop = target;
    };
    restore();
    // Lazy area content may arrive after the first layout. Stop restoring on operator input.
    const observer = new MutationObserver(restore);
    observer.observe(element, { childList: true, subtree: true });
    const interact = () => {
      restoring = false;
      observer.disconnect();
    };
    const remember = () => {
      if (!restoring || element.scrollTop === target) positions.set(key, element.scrollTop);
    };
    element.addEventListener("wheel", interact, { passive: true });
    element.addEventListener("touchstart", interact, { passive: true });
    element.addEventListener("pointerdown", interact);
    element.addEventListener("keydown", interact);
    element.addEventListener("scroll", remember, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", interact);
      element.removeEventListener("touchstart", interact);
      element.removeEventListener("pointerdown", interact);
      element.removeEventListener("keydown", interact);
      element.removeEventListener("scroll", remember);
    };
  }, [key]);
  return ref;
}
