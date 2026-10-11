import type { RecordView } from "../../data/record-view";

const NOUNS = { tasks: "Tasks", runs: "Runs" } as const;
const SINGULAR = { tasks: "task", runs: "run" } as const;

/** "1 task", "0 runs", "2 tasks". */
function countedNoun(count: number, noun: keyof typeof SINGULAR): string {
  return `${count} ${count === 1 ? SINGULAR[noun] : noun}`;
}

/**
 * A Work column's count line. The last good count stays through a background refetch ("checking") or a failed one
 * ("stale"); only the first read in flight says "loading", and no answer at all says "unavailable".
 */
export function workColumnStatus(view: RecordView<unknown>, count: number | undefined, noun: "tasks" | "runs"): string {
  if (count !== undefined) {
    const suffix = view.phase === "error" ? " (stale)" : view.phase === "checking" ? " (checking)" : "";
    return `${countedNoun(count, noun)}${suffix}`;
  }
  return view.phase === "loading" ? `${NOUNS[noun]} loading` : `${NOUNS[noun]} unavailable`;
}
