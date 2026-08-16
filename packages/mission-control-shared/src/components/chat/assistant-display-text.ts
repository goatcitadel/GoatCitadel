import type { ChatCitationRecord, MemoryCitationProvenance, MemoryRetrievalMatchSignals } from "@goatcitadel/contracts";

const RAW_HTML_BLOCK_RE = /<(script|style|svg|math|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const RAW_HTML_TAG_RE = /<\/?[A-Za-z][^>\n]{0,1000}>/g;
const RAW_HTML_DANGLING_TAG_RE = /<[A-Za-z][^<\n]{0,1000}$/gm;
const HTML_LINE_BREAK_RE = /<\s*br\s*\/?>/gi;
const HTML_BLOCK_BREAK_RE =
  /<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;
const HTML_COMMENT_STRIP_MAX_PASSES = 20;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  apos: "'",
};

export function normalizeAssistantDisplayText(content: string): string {
  const decoded = decodeJsonUnicodeEscapes(content);
  return stripHtmlNoiseOutsideCode(decoded);
}

export function normalizeCitationDisplayText(content: string | undefined | null): string | undefined {
  if (!content) {
    return undefined;
  }
  const normalized = stripHtmlNoiseOutsideCode(decodeJsonUnicodeEscapes(content));
  return normalized.trim() || undefined;
}

export function isMemoryCitation(citation: ChatCitationRecord): boolean {
  return (
    citation.sourceType === "memory" || citation.url?.startsWith("memory://") === true || Boolean(citation.provenance)
  );
}

export function formatMemoryRetrievalStrategy(value: MemoryCitationProvenance["retrievalStrategy"]): string | null {
  switch (value) {
    case "semantic_vector":
      return "semantic vector";
    case "semantic_hints":
      return "semantic hints";
    case "lexical_recency":
      return "lexical/recency";
    default:
      return null;
  }
}

export function formatMemoryScore(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : null;
}

export function formatMemorySignals(signals: MemoryRetrievalMatchSignals | undefined): string | null {
  if (!signals) {
    return null;
  }
  return [
    ["total", signals.totalScore],
    ["lexical", signals.lexicalScore],
    ["vector", signals.semanticVectorScore],
    ["hint", signals.semanticHintScore],
    ["recency", signals.recencyScore],
    ["diversity", signals.diversityScore],
  ]
    .map(([label, value]) => {
      const score = typeof value === "number" ? formatMemoryScore(value) : null;
      return score ? `${label} ${score}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export function formatMemoryCitationMeta(provenance: MemoryCitationProvenance | undefined): string | null {
  if (!provenance) {
    return null;
  }
  return [
    formatMemoryRetrievalStrategy(provenance.retrievalStrategy),
    readNonEmptyString(provenance.relationScope),
    readNonEmptyString(provenance.freshness),
    provenance.sourceTimestamp ? `source ${provenance.sourceTimestamp}` : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" · ");
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function decodeJsonUnicodeEscapes(content: string): string {
  if (!/\\u[0-9a-fA-F]{4}/.test(content)) {
    return content;
  }
  return content.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function stripHtmlNoiseOutsideCode(content: string): string {
  const parts = splitMarkdownFenceSegments(content);
  const normalized = parts
    .map((part) => (part.kind === "code" ? part.value : stripHtmlNoise(part.value)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized || !looksLikeHtml(content)) {
    return normalized;
  }
  return "HTML-only content omitted.";
}

function stripHtmlNoise(content: string): string {
  return stripRawHtmlComments(decodeBasicHtmlEntities(content))
    .replace(RAW_HTML_BLOCK_RE, " ")
    .replace(HTML_LINE_BREAK_RE, "\n")
    .replace(HTML_BLOCK_BREAK_RE, "\n")
    .replace(RAW_HTML_TAG_RE, "")
    .replace(RAW_HTML_DANGLING_TAG_RE, "")
    .split("\n")
    .map(preserveMarkdownIndentation)
    .join("\n");
}

type MarkdownFenceSegment = { kind: "text" | "code"; value: string };

function splitMarkdownFenceSegments(content: string): MarkdownFenceSegment[] {
  const segments: MarkdownFenceSegment[] = [];
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  let textStart = 0;
  let codeStart = -1;
  let lineStart = 0;

  for (let index = 0; index <= content.length; index += 1) {
    const hasLineBreak = index < content.length && content[index] === "\n";
    const atLineEnd = index === content.length || hasLineBreak;
    if (!atLineEnd) {
      continue;
    }
    const line = content.slice(lineStart, index);
    if (!inFence) {
      const opening = matchMarkdownFenceOpening(line);
      if (opening) {
        const lineEnd = index + (hasLineBreak ? 1 : 0);
        if (lineStart > textStart) {
          segments.push({ kind: "text", value: content.slice(textStart, lineStart) });
        }
        codeStart = lineStart;
        if (hasSameLineFenceClose(line, opening.char, opening.length, opening.start + opening.length)) {
          segments.push({ kind: "code", value: content.slice(codeStart, lineEnd) });
          textStart = lineEnd;
          codeStart = -1;
        } else {
          inFence = true;
          fenceChar = opening.char;
          fenceLength = opening.length;
        }
      }
    } else if (fenceChar && matchMarkdownFenceClosing(line, fenceChar, fenceLength)) {
      const lineEnd = index + (hasLineBreak ? 1 : 0);
      segments.push({ kind: "code", value: content.slice(codeStart, lineEnd) });
      textStart = lineEnd;
      codeStart = -1;
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
    lineStart = index + 1;
  }

  if (inFence && codeStart >= 0) {
    segments.push({ kind: "code", value: content.slice(codeStart) });
    textStart = content.length;
  }
  if (textStart < content.length) {
    segments.push({ kind: "text", value: content.slice(textStart) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value: "" }];
}

function matchMarkdownFenceOpening(line: string): { char: "`" | "~"; length: number; start: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[2]!;
  return { char: marker[0] as "`" | "~", length: marker.length, start: match[1]!.length };
}

function matchMarkdownFenceClosing(line: string, fenceChar: "`" | "~", fenceLength: number): boolean {
  // Char-wise equivalent of /^ {0,3}<marker run of >= fenceLength>\s*$/ --
  // this runs once per line inside every fence, so it must not compile a
  // RegExp per call.
  let index = 0;
  while (index < 3 && line[index] === " ") {
    index += 1;
  }
  let run = 0;
  while (line[index + run] === fenceChar) {
    run += 1;
  }
  if (run < fenceLength) {
    return false;
  }
  return line.slice(index + run).trim().length === 0;
}

function hasSameLineFenceClose(line: string, fenceChar: "`" | "~", fenceLength: number, searchStart: number): boolean {
  for (let index = searchStart; index <= line.length - fenceLength; index += 1) {
    if (line[index] !== fenceChar) {
      continue;
    }
    let markerLength = 0;
    while (line[index + markerLength] === fenceChar) {
      markerLength += 1;
    }
    if (markerLength >= fenceLength && line.slice(index + markerLength).trim().length === 0) {
      return true;
    }
    index += Math.max(0, markerLength - 1);
  }
  return false;
}

function preserveMarkdownIndentation(line: string): string {
  const indent = /^[ \t\f\v]*/.exec(line)?.[0] ?? "";
  const rest = line
    .slice(indent.length)
    .replace(/[ \t\f\v]{2,}/g, " ")
    .trimEnd();
  return `${indent}${rest}`;
}

function stripRawHtmlComments(content: string): string {
  let output = content;
  for (let pass = 0; pass < HTML_COMMENT_STRIP_MAX_PASSES; pass += 1) {
    const next = stripRawHtmlCommentsOnce(output);
    if (next === output) {
      return next;
    }
    output = next;
  }
  return output;
}

function stripRawHtmlCommentsOnce(content: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf("<!--", cursor);
    if (start === -1) {
      output += content.slice(cursor);
      break;
    }
    output += content.slice(cursor, start);
    const end = content.indexOf("-->", start + 4);
    if (end === -1) {
      const residualClose = content.indexOf(">", start + 4);
      if (residualClose !== -1 && residualClose - start <= 8) {
        cursor = residualClose + 1;
        continue;
      }
      break;
    }
    cursor = end + 3;
  }
  return output;
}

function decodeBasicHtmlEntities(content: string): string {
  return content.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (match, entity: string) => {
    const named = HTML_ENTITIES[entity.toLowerCase()];
    if (named !== undefined) {
      return named;
    }
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const value = Number.parseInt(entity.slice(2), 16);
      return decodeCodePoint(value) ?? match;
    }
    if (entity.startsWith("#")) {
      const value = Number.parseInt(entity.slice(1), 10);
      return decodeCodePoint(value) ?? match;
    }
    return match;
  });
}

function decodeCodePoint(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return undefined;
  }
}

function looksLikeHtml(content: string): boolean {
  return (content.includes("<!--") && content.includes("-->")) || /<\/?[A-Za-z][^>\n]{0,1000}>/.test(content);
}

// ---------------------------------------------------------------------------
// Incremental streaming normalization
//
// `normalizeAssistantDisplayText` re-runs the full strip pipeline over the
// entire accumulated message on every streaming flush (~60/s), which is O(n)
// per token and O(n^2) cumulative over a long answer — and it sits UPSTREAM of
// the renderer's O(delta) `splitIncremental` engine, defeating it. The engine
// below mirrors that engine's carried-state approach: it finalizes the
// normalized output for completed, append-immutable regions of the input and
// re-normalizes only the still-mutable tail on each push.
//
// Equivalence guarantee: `normalizeAssistantDisplayTextIncremental` returns a
// value byte-identical to `normalizeAssistantDisplayText(content)` for every
// prefix of the stream. Safety rests on which regions are append-immutable:
//   * Only whole, newline-terminated lines are ever consumed. None of the
//     pipeline's tokens (`\uXXXX` escapes, HTML entities, `<!--`, `-->`,
//     single tags, fence markers) can span a newline, so a completed line's
//     decoding and tokenization never change under append.
//   * A completed fence segment (opened AND closed) is normalized whole; its
//     bytes are final and `stripHtmlNoise` runs per segment from scratch, so
//     the result is exact by construction.
//   * Within the still-growing final text segment, a prefix is finalized only
//     while it contains NO `<!--` and NO raw-HTML block-element opener
//     (`<script|style|svg|math|canvas`). Those are the only constructs whose
//     match can extend forward across lines and retroactively re-interpret
//     earlier text (comment stripping and RAW_HTML_BLOCK_RE); with none
//     present, `stripHtmlNoise` distributes over the cut. When one appears,
//     finalization simply stops until the segment completes — equivalence is
//     preserved and only the perf win degrades to the from-scratch cost.
//   * The trailing `\n{3,}` collapse is per-maximal-run, so collapsing within
//     each finalized piece and again across each seam (including the final
//     assembly seam) reproduces the global collapse; `.trim()` and the
//     HTML-only fallback are applied to the assembled value per push and
//     never baked into carried state.
// If a push is not a pure append of the previous content, the engine resets
// and rescans from scratch, so it can never diverge.
// ---------------------------------------------------------------------------

const TEXT_FINALIZE_BLOCKER_RE = /<(?:script|style|svg|math|canvas)\b|<!--/i;

export interface IncrementalDisplayTextState {
  /** Full raw content seen on the previous push; used to detect non-append deltas. */
  raw: string;
  /** Decoded prefix bookkeeping: decoded[0, consumedEnd) has been normalized into `completedOut`. */
  consumedEnd: number;
  /** Fence-scan position (>= consumedEnd): completed lines before this are classified. */
  fenceScanEnd: number;
  /** Fence state at `fenceScanEnd`. */
  inFence: boolean;
  fenceChar: "`" | "~" | null;
  fenceLength: number;
  /** True when the growing text segment contains a construct that blocks prefix finalization. */
  textBlocked: boolean;
  /** Normalized output for decoded[0, consumedEnd), internally `\n{3,}`-collapsed, untrimmed. */
  completedOut: string;
  /** looksLikeHtml component flags over decoded[0, consumedEnd) (monotone under append). */
  seenCommentOpen: boolean;
  seenCommentClose: boolean;
  seenTag: boolean;
  /** Index the most recent push began its line walk from (perf instrumentation). */
  lastWalkStart: number;
}

export function createIncrementalDisplayTextState(): IncrementalDisplayTextState {
  return {
    raw: "",
    consumedEnd: 0,
    fenceScanEnd: 0,
    inFence: false,
    fenceChar: null,
    fenceLength: 0,
    textBlocked: false,
    completedOut: "",
    seenCommentOpen: false,
    seenCommentClose: false,
    seenTag: false,
    lastWalkStart: 0,
  };
}

function resetIncrementalDisplayTextState(state: IncrementalDisplayTextState): void {
  state.consumedEnd = 0;
  state.fenceScanEnd = 0;
  state.inFence = false;
  state.fenceChar = null;
  state.fenceLength = 0;
  state.textBlocked = false;
  state.completedOut = "";
  state.seenCommentOpen = false;
  state.seenCommentClose = false;
  state.seenTag = false;
  state.lastWalkStart = 0;
}

function countTrailingNewlines(value: string): number {
  let count = 0;
  while (count < value.length && value[value.length - 1 - count] === "\n") {
    count += 1;
  }
  return count;
}

function countLeadingNewlines(value: string): number {
  let count = 0;
  while (count < value.length && value[count] === "\n") {
    count += 1;
  }
  return count;
}

/** Joins two internally-collapsed pieces, collapsing the `\n` run that spans the seam. */
function joinCollapsed(left: string, right: string): string {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const trailing = countTrailingNewlines(left);
  const leading = countLeadingNewlines(right);
  if (trailing + leading >= 3) {
    return `${left.slice(0, left.length - trailing)}\n\n${right.slice(leading)}`;
  }
  return left + right;
}

function collapseNewlineRuns(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n");
}

function noteLooksLikeHtmlSignals(state: IncrementalDisplayTextState, piece: string): void {
  state.seenCommentOpen = state.seenCommentOpen || piece.includes("<!--");
  state.seenCommentClose = state.seenCommentClose || piece.includes("-->");
  state.seenTag = state.seenTag || /<\/?[A-Za-z][^>\n]{0,1000}>/.test(piece);
}

/** Consumes decoded[state.consumedEnd, end) as one already-safe piece of normalized output. */
function consumePiece(state: IncrementalDisplayTextState, decoded: string, end: number, kind: "text" | "code"): void {
  const piece = decoded.slice(state.consumedEnd, end);
  if (piece) {
    const normalized = kind === "code" ? piece : stripHtmlNoise(piece);
    state.completedOut = joinCollapsed(state.completedOut, collapseNewlineRuns(normalized));
    noteLooksLikeHtmlSignals(state, piece);
  }
  state.consumedEnd = end;
}

/**
 * Advance the carried normalization state with the latest accumulated raw
 * `content` and return the same value as `normalizeAssistantDisplayText`.
 * Mutates `state` in place.
 */
export function normalizeAssistantDisplayTextIncremental(state: IncrementalDisplayTextState, content: string): string {
  if (content.length < state.raw.length || !content.startsWith(state.raw)) {
    resetIncrementalDisplayTextState(state);
  }
  state.raw = content;
  // Decoding is whole-string (escape tokens never span the completed-line
  // boundary, so the decoded prefix before `consumedEnd` is append-stable and
  // carried indices stay valid). The no-escape fast path returns `content`
  // itself without allocating.
  const decoded = decodeJsonUnicodeEscapes(content);
  state.lastWalkStart = state.fenceScanEnd;

  // Walk newly completed lines, consuming append-immutable regions.
  let lineStart = state.fenceScanEnd;
  for (
    let newlineIndex = decoded.indexOf("\n", lineStart);
    newlineIndex !== -1;
    newlineIndex = decoded.indexOf("\n", lineStart)
  ) {
    const line = decoded.slice(lineStart, newlineIndex);
    const lineEnd = newlineIndex + 1;
    if (!state.inFence) {
      const opening = matchMarkdownFenceOpening(line);
      if (opening) {
        // The pending text region before the fence is now a completed
        // segment: normalize it whole (openers inside it are fine — the
        // segment's bytes are final and stripHtmlNoise runs per segment).
        consumePiece(state, decoded, lineStart, "text");
        state.textBlocked = false;
        if (hasSameLineFenceClose(line, opening.char, opening.length, opening.start + opening.length)) {
          consumePiece(state, decoded, lineEnd, "code");
        } else {
          state.inFence = true;
          state.fenceChar = opening.char;
          state.fenceLength = opening.length;
        }
      } else if (!state.textBlocked && TEXT_FINALIZE_BLOCKER_RE.test(line)) {
        state.textBlocked = true;
      }
    } else if (state.fenceChar && matchMarkdownFenceClosing(line, state.fenceChar, state.fenceLength)) {
      consumePiece(state, decoded, lineEnd, "code");
      state.inFence = false;
      state.fenceChar = null;
      state.fenceLength = 0;
    }
    lineStart = lineEnd;
  }
  state.fenceScanEnd = lineStart;

  // Outside a fence and unblocked, every completed line scanned so far is a
  // safe, opener-free text prefix: finalize it in one batch.
  if (!state.inFence && !state.textBlocked && state.fenceScanEnd > state.consumedEnd) {
    consumePiece(state, decoded, state.fenceScanEnd, "text");
  }

  // Re-normalize the still-mutable tail from scratch each push. Its leading
  // segment boundary matches the from-scratch scan: an open fence's opening
  // line and any finalization-blocking text both stay inside the tail.
  const tail = decoded.slice(state.consumedEnd);
  let tailOut = "";
  if (tail) {
    tailOut = collapseNewlineRuns(
      splitMarkdownFenceSegments(tail)
        .map((part) => (part.kind === "code" ? part.value : stripHtmlNoise(part.value)))
        .join(""),
    );
  }
  const assembled = joinCollapsed(state.completedOut, tailOut).trim();
  if (assembled) {
    return assembled;
  }
  const commentPair =
    (state.seenCommentOpen || tail.includes("<!--")) && (state.seenCommentClose || tail.includes("-->"));
  const anyTag = state.seenTag || /<\/?[A-Za-z][^>\n]{0,1000}>/.test(tail);
  return commentPair || anyTag ? "HTML-only content omitted." : "";
}
