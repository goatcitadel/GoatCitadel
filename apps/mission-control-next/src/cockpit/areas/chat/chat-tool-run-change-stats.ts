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

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Adds and removals in a unified diff. Each hunk header says how many old and new lines its body holds, so a body
 * line is counted even when it looks like a file header (a removed "-- note" is written "--- note"); lines outside
 * a hunk body (file headers, `diff`/`index` lines) are not counted.
 */
export function countUnifiedDiffChanges(diff: string): LineChangeStats {
  let added = 0;
  let removed = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of splitLines(diff)) {
    if (oldLeft <= 0 && newLeft <= 0) {
      const header = HUNK_HEADER.exec(line);
      if (header) {
        oldLeft = header[1] === undefined ? 1 : Number(header[1]);
        newLeft = header[2] === undefined ? 1 : Number(header[2]);
      }
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      added += 1;
      newLeft -= 1;
    } else if (line.startsWith("-")) {
      removed += 1;
      oldLeft -= 1;
    } else {
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return { added, removed };
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

/**
 * How long a finished call took. Undefined when it has not finished (a call waiting on approval has a finish time
 * for the pause, not for its work), when its times are not recorded, or when it waited on an approval: its recorded
 * span then includes the wait for the operator, which is not how long the call took.
 */
export function toolRunDuration(
  run: Pick<ChatToolRunRecord, "status" | "startedAt" | "finishedAt" | "approvalId">,
): string | undefined {
  if ((run.status !== "executed" && run.status !== "failed") || run.approvalId) return undefined;
  const started = Date.parse(run.startedAt);
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return undefined;
  return formatDuration(finished - started);
}
