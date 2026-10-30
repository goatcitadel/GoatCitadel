/**
 * Chat reads math only between `$$` signs, so a price such as "$5 and $10" stays text. Models also write `\(x\)`,
 * `\[x\]` and `$x$`; this turns those into the `$$` form, one line at a time. A single `$x$` counts only the way
 * Pandoc reads it: the opening `$` has a character right after it, the closing `$` has one right before it and no
 * digit or letter after it, and nothing between them is another `$`. Callers pass prose only, never code.
 */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("$") && !text.includes("\\")) return text;
  return text.split("\n").map(normalizeMathLine).join("\n");
}

/** A line holding only an opening or closing display bracket, as in a multi-line `\[` … `\]` block. */
const LONE_DISPLAY_BRACKET = /^(\s*)\\[[\]](\s*)$/u;
/** A whole line that is one `\[x\]` display formula. */
const WHOLE_LINE_DISPLAY = /^(\s*)\\\[(.+)\\\](\s*)$/u;
const BRACKET_PAIR = /\\\[(.+?)\\\]|\\\((.+?)\\\)/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
/** Marks a shielded code span (see stripHtmlNoise); math never runs across one. */
const SHIELD = "\u0000";

function normalizeMathLine(line: string): string {
  const lone = LONE_DISPLAY_BRACKET.exec(line);
  if (lone) return `${lone[1]}$$${lone[2]}`;
  const whole = WHOLE_LINE_DISPLAY.exec(line);
  if (whole && !whole[2]!.includes("\\]")) {
    const indent = whole[1]!;
    return `${indent}$$\n${indent}${whole[2]!.trim()}\n${indent}$$`;
  }
  const bracketed = line.includes("\\") ? line.replace(BRACKET_PAIR, replaceBracketPair) : line;
  return bracketed.includes("$") ? normalizeSingleDollars(bracketed) : bracketed;
}

function replaceBracketPair(match: string, display: string | undefined, inline: string | undefined): string {
  const tex = (display ?? inline ?? "").trim();
  return tex && !tex.includes(SHIELD) && !tex.includes("$$") ? `$$${tex}$$` : match;
}

function normalizeSingleDollars(line: string): string {
  let out = "";
  let at = 0;
  while (at < line.length) {
    const char = line[at]!;
    if (char === "\\") {
      out += line.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (char !== "$") {
      out += char;
      at += 1;
      continue;
    }
    if (line[at + 1] === "$") {
      // Already `$$` math: copy it through untouched, closer included.
      const close = line.indexOf("$$", at + 2);
      const end = close < 0 ? line.length : close + 2;
      out += line.slice(at, end);
      at = end;
      continue;
    }
    const close = singleDollarCloser(line, at);
    if (close < 0) {
      out += char;
      at += 1;
      continue;
    }
    out += `$$${line.slice(at + 1, close)}$$`;
    at = close + 1;
  }
  return out;
}

/** Where the `$` opened at `open` closes, or -1 when it is a plain dollar sign. */
function singleDollarCloser(line: string, open: number): number {
  const before = line[open - 1];
  const after = line[open + 1];
  if (after === undefined || /\s/u.test(after) || (before !== undefined && WORD_CHARACTER.test(before))) return -1;
  for (let at = open + 1; at < line.length; at += 1) {
    const char = line[at]!;
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === SHIELD) return -1;
    if (char !== "$") continue;
    const closes =
      line[at + 1] !== "$" &&
      !/\s/u.test(line[at - 1]!) &&
      (line[at + 1] === undefined || !WORD_CHARACTER.test(line[at + 1]!));
    // The first `$` after the opener decides: a dollar sign that cannot close means the opener was a price.
    return closes ? at : -1;
  }
  return -1;
}
