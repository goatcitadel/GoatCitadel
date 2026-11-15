import { useEffect, useRef } from "react";
import { lastCockpitNavigationReplaced } from "./cockpit-history";

const MODAL_LAYER = '[role="dialog"],[aria-modal="true"]';
/** A closing layer hands focus back to what opened it a tick later; wait that out before judging where focus is. */
const SETTLE_MS = 60;
const GIVE_UP_MS = 3000;

const inModalLayer = () => document.activeElement?.closest(MODAL_LAYER) != null;

function focusPage(): void {
  const main = document.getElementById("main-content");
  if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
}

/**
 * A new area is a new page: bring keyboard and screen reader focus to it. Not for a replaced address (a redirect or a
 * page tidying its own address is not the operator going somewhere), not while a dialog or sheet still holds focus (it
 * is moved once that layer has closed, if focus has fallen outside the page), and never when focus is already inside
 * the page, such as a composer that focused itself.
 */
export function useFocusPageOnAreaChange(area: string): void {
  const previous = useRef(area);
  useEffect(() => {
    if (previous.current === area) return;
    previous.current = area;
    if (lastCockpitNavigationReplaced()) return;
    if (!inModalLayer()) {
      focusPage();
      return;
    }
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (inModalLayer()) return;
      clearTimeout(settle);
      settle = setTimeout(() => {
        observer.disconnect();
        if (!inModalLayer()) focusPage();
      }, SETTLE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const giveUp = setTimeout(() => observer.disconnect(), GIVE_UP_MS);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
      clearTimeout(giveUp);
    };
  }, [area]);
}
