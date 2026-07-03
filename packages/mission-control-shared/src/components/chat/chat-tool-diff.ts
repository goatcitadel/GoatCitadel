import type { ChatToolRunRecord } from "@goatcitadel/contracts";

/**
 * A candidate string qualifies as a unified diff only when it carries BOTH signals:
 *   (a) at least one hunk header (`@@ -x[,y] +a[,b] @@`)
 *   (b) a pair of file headers (`--- ` and `+++ ` lines)
 * Requiring both, rather than either alone, is what keeps a plain-text blob with a
 * stray "+ something" / "- something" line (changelog notes, markdown bullets, etc.)
 * from ever false-positiving into the diff renderer.
 */
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const OLD_FILE_HEADER_PATTERN = /^--- /m;
const NEW_FILE_HEADER_PATTERN = /^\+\+\+ /m;

/** Ordered so the first qualifying field wins when several are present on the same result. */
const DIFF_CANDIDATE_KEYS = ["patch", "diff", "unifiedDiff", "output"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQualifyingUnifiedDiff(candidate: string): boolean {
  return (
    HUNK_HEADER_PATTERN.test(candidate) &&
    OLD_FILE_HEADER_PATTERN.test(candidate) &&
    NEW_FILE_HEADER_PATTERN.test(candidate)
  );
}

/**
 * Examines the string-valued diff-shaped candidates on a tool run's result payload
 * (`patch`, `diff`, `unifiedDiff`, `output`, in that priority order) and returns the
 * first one that qualifies as a real unified diff, or `null` if none do (including
 * when `result` is absent or not a plain object — the contract types `result` as
 * `Record<string, unknown> | undefined`, but defends against a mistyped/widened value
 * at the boundary all the same).
 */
export function extractUnifiedDiffFromToolRun(run: ChatToolRunRecord): string | null {
  const result = run.result;
  if (!isRecord(result)) {
    return null;
  }
  for (const key of DIFF_CANDIDATE_KEYS) {
    const candidate = result[key];
    if (typeof candidate === "string" && isQualifyingUnifiedDiff(candidate)) {
      return candidate;
    }
  }
  return null;
}

export type UnifiedDiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  text: string;
}

const DEFAULT_MAX_LINES = 400;

/**
 * Classifies a single already-split diff line. Order matters: the meta prefixes
 * ("+++ ", "--- ", "diff ", "index ") are checked BEFORE the generic add/del
 * prefixes, so a new-file header line like "+++ b/file" is classified as `meta`
 * rather than `add` (and symmetrically for "--- a/file" vs `del`).
 */
function classifyUnifiedDiffLine(line: string): UnifiedDiffLineKind {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "meta";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "ctx";
}

/**
 * Splits a unified diff into classified, renderable lines, capped at `maxLines`
 * (default 400). `truncatedCount` reports how many additional lines were cut off
 * the end so the caller can show a "+N more lines" footer; it is 0 when the full
 * diff fits within the cap.
 */
export function parseUnifiedDiffLines(
  diff: string,
  maxLines: number = DEFAULT_MAX_LINES,
): { lines: UnifiedDiffLine[]; truncatedCount: number } {
  // CRLF-authored diffs (Windows-side git, CRLF artifacts) must not leak
  // stray \r into the rendered line text.
  const allLines = diff.split(/\r?\n/);
  const visibleLines = allLines.slice(0, maxLines).map((text) => ({ kind: classifyUnifiedDiffLine(text), text }));
  const truncatedCount = Math.max(0, allLines.length - visibleLines.length);
  return { lines: visibleLines, truncatedCount };
}
