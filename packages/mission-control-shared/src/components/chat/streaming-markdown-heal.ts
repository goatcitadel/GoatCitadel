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

/**
 * The block with inline code blanked out to the same length, so offsets still line up: every closed `code` span,
 * and with `includeOpen` the still-open one after an unmatched backtick too.
 */
function maskInlineCode(block: string, includeOpen: boolean): string {
  const masked = block.replace(/`[^`\n]*`/g, (code) => "x".repeat(code.length));
  const open = masked.lastIndexOf("`");
  if (!includeOpen || open < 0 || (masked.match(/`/g)?.length ?? 0) % 2 === 0) return masked;
  return masked.slice(0, open) + "x".repeat(masked.length - open);
}

/** A link still arriving, shown as its words. The match is found outside code, then cut from the real text. */
function unwrapPartialLink(block: string, pattern: RegExp): string {
  const match = pattern.exec(maskInlineCode(block, true));
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
  // A marker with nothing after it yet ("Next up: **").
  block = block.replace(/(^|\s)(\*{1,3}|~~|`)$/, "$1");
  // A link still arriving: its words for now. Never inside code ("`arr[`" keeps its bracket).
  block = unwrapPartialLink(unwrapPartialLink(block, PARTIAL_LINK_WITH_URL), PARTIAL_LINK_TEXT);
  // Inside closed `code` nothing counts; an open one gets closed.
  const masked = maskInlineCode(block, false);
  if ((masked.match(/`/g)?.length ?? 0) % 2) return `${head}${block}\``;
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
