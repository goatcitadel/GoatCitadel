// Adapted from hermes-agent's summarize-command (https://github.com/nousresearch/hermes-agent, MIT,
// Copyright (c) 2025 Nous Research), itself after condensed-milk-pi's command dispatcher. Display only: the full
// command stays reachable in the run's details.

/** Setup and plumbing words that are never the command someone cares about. */
const SILENT_HEADS = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "true", "false", ":"]);
/** Output plumbing piped after the real command (`cmd 2>&1 | tail -20`). */
const PIPE_TAIL_HEADS = new Set(["head", "tail", "wc", "sort", "uniq"]);

const basename = (head: string): string => head.split(/[\\/]/).pop() || head;

/** Splits on quotes-aware whitespace. */
function splitWords(segment: string): string[] {
  const words: string[] = [];
  let buffer = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      buffer += ch;
      if (ch === quote && segment[i - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
    } else if (/\s/.test(ch)) {
      if (buffer) words.push(buffer);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return buffer ? [...words, buffer] : words;
}

function stripPipeTail(segment: string): string {
  const words = splitWords(segment);
  const cut = words.findIndex((word, i) => word === "|" && PIPE_TAIL_HEADS.has(basename(words[i + 1] ?? "")));
  return (cut < 0 ? words : words.slice(0, cut)).join(" ").trim();
}

/** Splits on top-level `&&`, `||`, `;` and newlines (not pipes: a pipe is usually the segment's own plumbing). */
function splitCompoundCommand(input: string): string[] {
  const segments: string[] = [];
  let buffer = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      buffer += ch;
      if (ch === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    const operator = input.startsWith("&&", i) || input.startsWith("||", i) ? 2 : ch === ";" || ch === "\n" ? 1 : 0;
    if (operator) {
      segments.push(buffer);
      buffer = "";
      i += operator - 1;
      continue;
    }
    buffer += ch;
  }
  return [...segments, buffer].map((segment) => stripPipeTail(segment.trim())).filter(Boolean);
}

/** Drops redirects (`> out.txt`, `2>&1`) and leading `FOO=bar` assignments. */
function cleanSegment(segment: string): string {
  const words = splitWords(segment);
  const kept: string[] = [];
  let leading = true;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (/^\d*(?:>>?|<)$/.test(word)) {
      i += 1;
      continue;
    }
    if (/^\d*(?:>&|<&)\d+$/.test(word)) continue;
    if (leading && /^[A-Za-z_]\w*=/.test(word)) continue;
    leading = false;
    kept.push(word);
  }
  return kept.join(" ").trim();
}

/** Banner and exit-status echoes are plumbing; an ordinary `echo $VALUE` may be the real output, so it stays. */
function isBoundaryEcho(segment: string): boolean {
  const words = splitWords(segment);
  return (
    basename(words[0] ?? "") === "echo" && /-{2,}|_exit=|(?:^|\s|=)\$[?{]|PIPESTATUS/.test(words.slice(1).join(" "))
  );
}

/**
 * The command that matters out of an agent's wrapped shell line: `cd app && FOO=1 pnpm test 2>&1 | tail -20` reads
 * as `pnpm test`. Several real commands read as the first plus a count ("pnpm lint + 2 commands").
 */
export function summarizeShellCommand(raw: string): string {
  const original = raw.trim();
  if (!original) return "";
  const segments = splitCompoundCommand(original);
  if (segments.length <= 1) return cleanSegment(segments[0] ?? original) || original;
  const core = segments
    .map(cleanSegment)
    .filter(
      (segment) => segment && !SILENT_HEADS.has(basename(splitWords(segment)[0] ?? "")) && !isBoundaryEcho(segment),
    );
  if (core.length === 0) return original;
  if (core.length === 1) return core[0]!;
  return `${core[0]} + ${core.length - 1} ${core.length === 2 ? "command" : "commands"}`;
}
