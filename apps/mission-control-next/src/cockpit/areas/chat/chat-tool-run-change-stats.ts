import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { extractUnifiedDiffFromToolRun } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-diff";
import { formatDuration } from "@goatcitadel/mission-control-shared/content/format";

export type LineChangeStats = { added: number; removed: number };

/** Above this many lines on either side, counting stops being exact and falls back to a cheaper estimate. */
const EXACT_DIFF_MAX_LINES = 400;

function splitLines(text: string): string[] {
  return text.length ? text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n") : [];
}

/** Length of the longest common subsequence of two line lists, in O(n·m) time and O(m) space. */
function commonLineCount(before: string[], after: string[]): number {
  let previous = new Array<number>(after.length + 1).fill(0);
  for (const line of before) {
    const current = new Array<number>(after.length + 1).fill(0);
    for (let j = 0; j < after.length; j += 1) {
      current[j + 1] = line === after[j] ? previous[j]! + 1 : Math.max(previous[j + 1]!, current[j]!);
    }
    previous = current;
  }
  return previous[after.length]!;
}

/** Lines added and removed going from `before` to `after`. Large texts are estimated from shared lines. */
export function countLineChanges(before: string, after: string): LineChangeStats {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let common: number;
  if (oldLines.length <= EXACT_DIFF_MAX_LINES && newLines.length <= EXACT_DIFF_MAX_LINES) {
    common = commonLineCount(oldLines, newLines);
  } else {
    const remaining = new Map<string, number>();
    for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
    common = newLines.filter((line) => {
      const left = remaining.get(line) ?? 0;
      if (left) remaining.set(line, left - 1);
      return left > 0;
    }).length;
  }
  return { added: newLines.length - common, removed: oldLines.length - common };
}

/** Adds and removals in a unified diff, file headers excluded. */
export function countUnifiedDiffChanges(diff: string): LineChangeStats {
  return splitLines(diff).reduce<LineChangeStats>(
    (stats, line) =>
      line.startsWith("+++ ") || line.startsWith("--- ")
        ? stats
        : line.startsWith("+")
          ? { ...stats, added: stats.added + 1 }
          : line.startsWith("-")
            ? { ...stats, removed: stats.removed + 1 }
            : stats,
    { added: 0, removed: 0 },
  );
}

/**
 * The lines a successful call changed: from a unified diff in its result, else from the old and new text an edit
 * sent. Undefined for a call that did not run, or when nothing records the change (a failed edit changed nothing).
 */
export function toolRunLineChanges(run: ChatToolRunRecord): LineChangeStats | undefined {
  if (run.status !== "executed") return undefined;
  const diff = extractUnifiedDiffFromToolRun(run);
  if (diff) return countUnifiedDiffChanges(diff);
  const oldText = run.args?.oldText;
  const newText = run.args?.newText;
  if (
    (run.toolName === "fs.patch" || run.toolName === "fs.write") &&
    typeof oldText === "string" &&
    typeof newText === "string"
  ) {
    return countLineChanges(oldText, newText);
  }
  return undefined;
}

/** How long a finished call took, or undefined when it has not finished or its times are not recorded. */
export function toolRunDuration(run: Pick<ChatToolRunRecord, "startedAt" | "finishedAt">): string | undefined {
  const started = Date.parse(run.startedAt);
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return undefined;
  return formatDuration(finished - started);
}
