import { useEffect, useRef } from "react";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";

/**
 * Below the two-column width the schedule detail renders under the whole list, so choosing a schedule would show no
 * visible change. When the operator asks to review one, bring its detail into view and move focus to its heading once
 * that schedule's record is shown. Side-by-side layouts keep focus on the list.
 */
export function useRevealScheduleDetail(shownId: string | undefined) {
  const stacked = useMediaQuery(RESPONSIVE_QUERIES.belowDesktop);
  const detail = useRef<HTMLDivElement>(null);
  const requested = useRef<string | null>(null);
  const focusDetail = () => {
    const target = detail.current?.querySelector<HTMLElement>("h2[tabindex]") ?? detail.current;
    target?.scrollIntoView?.({ block: "start" });
    target?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!shownId || requested.current !== shownId) return;
    requested.current = null;
    if (stacked) focusDetail();
  });
  return {
    detail,
    reveal: (id: string) => {
      if (id !== shownId) requested.current = id;
      else if (stacked) focusDetail();
    },
  };
}
