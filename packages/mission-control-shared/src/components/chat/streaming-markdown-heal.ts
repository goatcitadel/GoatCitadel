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
  // A link still arriving: its words for now.
  block = block.replace(/\[([^\]\n]*)\]\([^)\s]*$/, "$1").replace(/\[([^\]\n]*)$/, "$1");
  // Inside closed `code` nothing counts; an open one gets closed.
  const masked = block.replace(/`[^`\n]*`/g, (code) => "x".repeat(code.length));
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
