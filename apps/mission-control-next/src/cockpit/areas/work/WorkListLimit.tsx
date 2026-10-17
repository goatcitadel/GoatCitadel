import { useState } from "react";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";

/**
 * WK-10: a capped list says how much of it is shown and offers the rest. `from: "end"` keeps the latest items (a run
 * timeline), `from: "start"` the first ones (a newest-first activity feed).
 */
export function useListLimit<T>(items: readonly T[], limit: number, from: "start" | "end") {
  const [showAll, setShowAll] = useState(false);
  const capped = items.length > limit;
  const visible = !capped || showAll ? items : from === "end" ? items.slice(-limit) : items.slice(0, limit);
  return { visible, total: items.length, capped, showAll, toggle: () => setShowAll((value) => !value) };
}

/** "Showing the latest 12 of 40 events" with a Show all / Show fewer toggle that keeps focus on itself. */
export function ListLimitFooter({
  limit,
  noun,
  nounPlural,
  latest,
}: {
  limit: ReturnType<typeof useListLimit<unknown>>;
  noun: string;
  nounPlural: string;
  latest: boolean;
}) {
  if (!limit.capped) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      {limit.showAll
        ? `Showing all ${plural(limit.total, noun, nounPlural)}.`
        : `Showing the ${latest ? "latest" : "first"} ${limit.visible.length} of ${plural(limit.total, noun, nounPlural)}.`}
      <Button size="sm" variant="secondary" onClick={limit.toggle}>
        {limit.showAll ? "Show fewer" : `Show all ${limit.total}`}
      </Button>
    </p>
  );
}
