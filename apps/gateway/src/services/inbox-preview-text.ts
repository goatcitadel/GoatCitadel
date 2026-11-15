/*
 * What an Inbox row says about a shell command or a code run it asks to approve. The row never shows the command's
 * arguments or the code's text: a model wrote them, they can carry a credential in forms no filter lists completely, and
 * partly hiding a shell line can hide its tail. The row names the kind of thing (the program, how many lines) and the
 * approval detail shows the full text. Nothing here uses a regular expression on that text: each scan is bounded.
 */

/** The most of a command or code text counted for lines; a longer text is said to be very long. */
const MAX_COUNTED_TEXT = 10_000;
/** The most of a command's start read for its program name. */
const MAX_PROGRAM_SCAN = 256;
const MAX_PROGRAM_NAME = 24;

const SPACE = 32;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

function isWhitespace(code: number): boolean {
  return code <= SPACE;
}

function isLineBreak(code: number): boolean {
  return code === LINE_FEED || code === CARRIAGE_RETURN || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
}

function isProgramCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 46 || // .
    code === 95 || // _
    code === 43 || // +
    code === 45 || // -
    code === 47 || // /
    code === 92 // backslash
  );
}

/** How many non-empty lines the text has, or "long" when it is longer than the counted part. */
function countLines(text: string): number | "long" {
  if (text.length > MAX_COUNTED_TEXT) return "long";
  let lines = 0;
  let lineHasText = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isLineBreak(code)) {
      if (lineHasText) lines += 1;
      lineHasText = false;
    } else if (!isWhitespace(code)) {
      lineHasText = true;
    }
  }
  return lineHasText ? lines + 1 : lines;
}

/**
 * The program a command starts with: its first word, when that word is plain letters, digits and . _ + - / and
 * backslash, read from the first 256 characters only. A word with a quote, a dollar sign or an equals sign (a quoted
 * path, a variable, an assignment that may hold a password) names no program. Any directory is dropped.
 */
function programName(command: string): string | undefined {
  const limit = Math.min(command.length, MAX_PROGRAM_SCAN);
  let start = 0;
  while (start < limit && isWhitespace(command.charCodeAt(start))) start += 1;
  let end = start;
  while (end < limit && !isWhitespace(command.charCodeAt(end))) end += 1;
  // A word that was still going when the scan stopped is not a program name.
  if (end === start || (end === limit && command.length > limit)) return undefined;
  const token = command.slice(start, end);
  if (token.charCodeAt(0) === 45) return undefined;
  for (let index = 0; index < token.length; index += 1) {
    if (!isProgramCharacter(token.charCodeAt(index))) return undefined;
  }
  const name = token.slice(Math.max(token.lastIndexOf("/"), token.lastIndexOf(String.fromCharCode(92))) + 1);
  return name && name.length <= MAX_PROGRAM_NAME ? name : undefined;
}

/** The summary of a shell command approval, or undefined when the command holds no text. */
export function shellCommandSummary(command: string): string | undefined {
  const lines = countLines(command);
  if (lines === 0) return undefined;
  const program = programName(command);
  const count = lines === 1 ? "" : lines === "long" ? ", very long" : `, ${lines} lines`;
  return `Command${program ? `: ${program}` : ""}${count} (open it to see the full command)`;
}

/** The summary of a code run approval, or undefined when the code holds no text. */
export function codeRunSummary(code: string): string | undefined {
  const lines = countLines(code);
  if (lines === 0) return undefined;
  const count = lines === "long" ? "very long" : lines === 1 ? "1 line" : `${lines} lines`;
  return `Code to run, ${count} (open it to see the code)`;
}
