import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { RecordView } from "../../data/record-view";

const NOUNS = { tasks: "Tasks", runs: "Runs" } as const;
const SINGULAR = { tasks: "task", runs: "run" } as const;

/** "1 task", "0 runs", "2 matching tasks". */
function countedNoun(count: number, noun: keyof typeof SINGULAR, matching: boolean): string {
  const prefix = matching ? "matching " : "";
  return plural(count, prefix + SINGULAR[noun], prefix + noun);
}

/**
 * A Work column's count line. It counts what the filters leave (WK-06); when the list under it is capped it says so
 * ("25 of 80 tasks shown"). The last good count stays through a background refetch ("checking") or a failed one
 * ("stale"); only the first read in flight says "loading", and no answer at all says "unavailable".
 */
export function workColumnStatus(
  view: RecordView<unknown>,
  count: number | undefined,
  noun: "tasks" | "runs",
  options: { shown?: number; matching?: boolean; partial?: boolean } = {},
): string {
  if (count !== undefined) {
    const suffix = view.phase === "error" ? " (stale)" : view.phase === "checking" ? " (checking)" : "";
    const { shown, matching = false, partial = false } = options;
    const counted = countedNoun(count, noun, matching);
    // More pages exist than have loaded, so the number is a floor, not a total.
    const label =
      shown !== undefined && shown < count
        ? `${shown} of ${partial ? "at least " : ""}${counted} shown`
        : partial
          ? `At least ${counted}`
          : counted;
    return `${label}${suffix}`;
  }
  return view.phase === "loading" ? `${NOUNS[noun]} loading` : `${NOUNS[noun]} unavailable`;
}
