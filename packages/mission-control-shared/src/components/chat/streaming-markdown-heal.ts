// Adapted from hob's healMarkdown (https://github.com/FrigadeHQ/hob, MIT, Copyright (c) 2026 Frigade).

type MarkerState = { bold: boolean; italic: boolean; lastLength: number; lastAtEnd: boolean };

function markerState(masked: string, pattern: RegExp): MarkerState {
  const state: MarkerState = { bold: false, italic: false, lastLength: 0, lastAtEnd: false };
  for (const match of masked.matchAll(pattern)) {
    const at = match.index ?? 0;
    const length = match[0].length;
    const before = masked[at - 1];
    const after = masked[at + length];
    // "2 * 3" or a "* " bullet: a marker with space on both sides is not formatting.
    if ((before === undefined || /\s/.test(before)) && (after === undefined || /\s/.test(after))) continue;
    if (length >= 2) state.bold = !state.bold;
    if (length % 2) state.italic = !state.italic;
    state.lastLength = length;
    state.lastAtEnd = at + length === masked.length;
  }
  return state;
}

const PARTIAL_LINK_WITH_URL = /\[([^\]\n]*)\]\([^)\s]*$/;
const PARTIAL_LINK_TEXT = /\[([^\]\n]*)$/;

const backtickRunAt = (text: string, at: number): number => {
  let end = at;
  while (text[end] === "`") end += 1;
  return end - at;
};

type InlineCodeScan = {
  /** The block with every closed code span blanked out to the same length, so offsets still line up. */
  masked: string;
  /** Where a code span still waiting for its closer opens, or -1. */
  openAt: number;
  /** How many backticks opened it; CommonMark closes a span only with a run of the same length. */
  openRun: number;
};

/** Finds inline code the CommonMark way: a run of N backticks is closed only by the next run of exactly N. */
function scanInlineCode(block: string): InlineCodeScan {
  let masked = "";
  let at = 0;
  while (at < block.length) {
    if (block[at] !== "`") {
      masked += block[at];
      at += 1;
      continue;
    }
    const run = backtickRunAt(block, at);
    let close = at + run;
    while (close < block.length) {
      if (block[close] !== "`") {
        close += 1;
        continue;
      }
      const closeRun = backtickRunAt(block, close);
      if (closeRun === run) break;
      close += closeRun;
    }
    // While streaming, an unmatched opener is a span whose closer has not arrived yet.
    if (close >= block.length) return { masked: masked + block.slice(at), openAt: at, openRun: run };
    masked += "x".repeat(close + run - at);
    at = close + run;
  }
  return { masked, openAt: -1, openRun: 0 };
}

/** The block with all inline code blanked out, including a span still open at the end. */
function maskAllInlineCode(block: string): string {
  const { masked, openAt } = scanInlineCode(block);
  return openAt < 0 ? masked : masked.slice(0, openAt) + "x".repeat(masked.length - openAt);
}

/** A link still arriving, shown as its words. The match is found outside code, then cut from the real text. */
function unwrapPartialLink(block: string, pattern: RegExp): string {
  const match = pattern.exec(maskAllInlineCode(block));
  if (!match) return block;
  const textStart = match.index + 1;
  return block.slice(0, match.index) + block.slice(textStart, textStart + match[1]!.length);
}

/**
 * The still-arriving end of a streamed reply, made whole for display only: an open **bold**, *italic*, ~~strike~~
 * or `code` is closed for now, a marker with nothing after it yet is hidden, and a link still arriving shows its
 * words. Without this, "**" shows as text until its closer arrives and the line then jumps to bold. Formatting does
 * not run across paragraphs, so only the last one is touched. Callers skip a tail that ends inside a code block.
 */
export function healStreamingMarkdownTail(text: string): string {
  const cut = text.lastIndexOf("\n\n") + 1;
  const head = text.slice(0, cut);
  let block = text.slice(cut);
  // A marker with nothing after it yet ("Next up: **", "Run ``").
  block = block.replace(/(^|\s)(\*{1,3}|~~|`+)$/, "$1");
  // A link still arriving: its words for now. Never inside code ("`arr[`" keeps its bracket).
  block = unwrapPartialLink(unwrapPartialLink(block, PARTIAL_LINK_WITH_URL), PARTIAL_LINK_TEXT);
  // Inside closed `code` nothing counts; an open one gets a closer of its own length (a space first if the code
  // ends in a backtick, which would otherwise lengthen the closing run).
  const { masked, openAt, openRun } = scanInlineCode(block);
  if (openAt >= 0) return `${head}${block}${block.endsWith("`") ? " " : ""}${"`".repeat(openRun)}`;
  const star = markerState(masked, /\*+/g);
  const strike = markerState(masked, /~~/g).bold;
  // Half of a closing ** has arrived: finish it.
  if (star.bold && star.italic && star.lastAtEnd && star.lastLength === 1) return `${head}${block}*`;
  const close = `${star.italic ? "*" : ""}${star.bold ? "**" : ""}${strike ? "~~" : ""}`;
  if (!close) return head + block;
  // The closer goes before trailing spaces: "**very **" would not count as closed.
  const trail = /\s*$/.exec(block)![0];
  return `${head}${block.slice(0, block.length - trail.length)}${close}${trail}`;
}
