/** Fence languages that only ever mean "plain text"; any other tag (including markdown) stays code. */
const PROSE_FENCE_LANGUAGES = new Set(["text", "txt", "plain", "plaintext"]);
const MIN_PROSE_WORDS = 8;

/** Characters that ordinary sentences almost never use, but code, markup, tables and drawings do. */
const CODE_CHARACTERS = /[{}<>=\\|`\u2500-\u257f]/u;
/** A line that opens like a shell prompt, comment, quote or list marker drawn from code. */
const CODE_LINE_START = /^(?:\s{2,}|\t|\$ |# |#!|\/\/|--|>|\+-)/u;
/** A call such as `user.save()` or `run(task)`: a word glued to an opening parenthesis. */
const CALL_SYNTAX = /[\p{L}\p{N}_]\(/u;
/** Columns lined up with runs of spaces, as in a log or a plain-text table. */
const ALIGNED_COLUMNS = /\S {3,}\S/u;
/** A sentence end: a word, then a full stop, question or exclamation mark, then a space or the end. */
const SENTENCE_END = /\p{L}{2,}[.!?](?:\s|$)/u;

/**
 * Whether a fenced block holds ordinary sentences rather than code, so Chat can show it as wrapped text. Models
 * often fence an email or message draft so it is easy to copy. Only an untagged or plain-text fence qualifies, and
 * any sign of code keeps the block as code: a miss only costs a monospace box, a false hit would garble real code.
 */
export function isProseFence(language: string | undefined, text: string): boolean {
  if (language !== undefined && !PROSE_FENCE_LANGUAGES.has(language.toLowerCase())) return false;
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  if (CODE_CHARACTERS.test(text) || CALL_SYNTAX.test(text)) return false;
  if (lines.some((line) => CODE_LINE_START.test(line) || ALIGNED_COLUMNS.test(line))) return false;
  const words = text.match(/\p{L}+/gu) ?? [];
  return words.length >= MIN_PROSE_WORDS && SENTENCE_END.test(text);
}
