import { redactSecretText } from "./secret-redaction.js";

const LINE_LIMIT = 160;
const CUT_NOTE = " (cut short)";
// A command is read no further than this for its program name. The card's review summary shows the rest.
const COMMAND_HEAD = 400;
const PROGRAM_TOKEN_LIMIT = 200;
const PROGRAM_NAME_LIMIT = 40;
// Other targets are read no further than this, so a very long value never costs more than a bounded pass.
const TARGET_READ_LIMIT = 20_000;
const SHELL_TOOLS = new Set(["shell.exec", "shell.exec_background"]);
// Characters that show nothing but can pad a line so a harmful tail falls past the cut: default-ignorable code points
// (zero-width, joiners, variation selectors, soft hyphen, the combining grapheme joiner) plus the blank fillers.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u2800\u115F\u1160\u3164\uFFA0]+/gu;
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029\u0085]/u;
// Every pattern in this file is a single character class with one quantifier, so none can backtrack on a long input.
const PROGRAM_TOKEN = /^[A-Za-z0-9._/\\-]+$/u;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** One line of model-written text as plain words: every space or control character one space. */
function cleanLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Z}]+/gu, " ").trim();
}

/** The text without its invisible characters, so a secret padded with them is whole again for the redactor. */
function withoutInvisible(value: string): string {
  return value.replace(INVISIBLE, "");
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(LINE_BREAK)
    .map(cleanLine)
    .filter((line) => line.length > 0);
}

function codePoints(value: string, limit: number): string {
  let out = "";
  let count = 0;
  for (const point of value) {
    if (count >= limit) break;
    out += point;
    count += 1;
  }
  return out;
}

const length = (value: string): number => Array.from(value).length;

/** The label and line, cut so the whole stays within the limit, and the cut said in words. */
function withLabel(label: string, line: string, note = ""): string | undefined {
  if (!line) return undefined;
  const whole = `${label}: ${line}`;
  if (length(whole) + note.length <= LINE_LIMIT) return `${whole}${note}`;
  const room = LINE_LIMIT - note.length - CUT_NOTE.length - 1;
  return `${codePoints(whole, Math.max(room, 0)).trimEnd()}…${CUT_NOTE}${note}`;
}

function moreLines(count: number): string {
  return count > 0 ? ` (and ${count} more ${count === 1 ? "line" : "lines"})` : "";
}

function addressOf(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.host ? `${url.protocol}//${url.host}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The program a shell command starts with, only when its first token is a plain program name or path. Anything else
 * (an assignment, a quote, a variable, a flag) names no program, so nothing of it is shown.
 */
function programOf(command: string): string | undefined {
  const head = command.slice(0, COMMAND_HEAD);
  const firstLine = head
    .split(LINE_BREAK)
    .map((line) => cleanLine(withoutInvisible(line)))
    .find((line) => line);
  const token = firstLine?.split(" ", 1)[0];
  if (!token || token.length >= PROGRAM_TOKEN_LIMIT || token.startsWith("-") || !PROGRAM_TOKEN.test(token))
    return undefined;
  // A token cut by the head limit is not a whole name.
  if (head.length === COMMAND_HEAD && token === firstLine && command.length > COMMAND_HEAD) return undefined;
  const name = token.slice(Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\")) + 1);
  if (!name || redactSecretText(name).redactionCount > 0) return undefined;
  return name.slice(0, PROGRAM_NAME_LIMIT);
}

/** A shell command's heading never shows its arguments: they may carry a credential, and the review summary shows them. */
function commandHeading(command: string): string | undefined {
  const lineCount = nonEmptyLines(command).length;
  if (lineCount === 0) return undefined;
  const program = programOf(command);
  const detail = lineCount > 1 ? `${lineCount} lines, details below` : "details below";
  return program ? `Command: ${program} (${detail})` : `Command (${detail})`;
}

/** Redacted after the invisible characters are removed, and before anything is cut. */
function firstLineOf(value: string): { line: string; more: number } | undefined {
  const lines = nonEmptyLines(redactSecretText(withoutInvisible(value.slice(0, TARGET_READ_LIMIT))).value);
  return lines.length ? { line: lines[0]!, more: lines.length - 1 } : undefined;
}

/**
 * The one line a Chat approval card shows for what the action touches: its file, address, command or code. The
 * words come from tool arguments a model wrote, so they are shown as plain text on a single line, and a cut or a
 * hidden part is said in words. The first match wins.
 */
export function approvalTargetLine(
  kind: string | undefined,
  preview: Record<string, unknown> | undefined,
): string | undefined {
  if (!preview) return undefined;
  const path = text(preview.path);
  if (path) {
    const flat = nonEmptyLines(redactSecretText(withoutInvisible(path.slice(0, TARGET_READ_LIMIT))).value).join(" ");
    return withLabel("Path", flat);
  }
  const target = text(preview.target);
  if (target) {
    const address = addressOf(target.slice(0, TARGET_READ_LIMIT));
    return address ? withLabel("Target", address) : undefined;
  }
  const command = text(preview.command);
  if (command && typeof preview.toolName === "string" && SHELL_TOOLS.has(preview.toolName)) {
    return commandHeading(command);
  }
  const code = text(preview.codePreview);
  if (kind === "code_mode.run" && code) {
    const first = firstLineOf(code);
    return first ? withLabel("Code", first.line, moreLines(first.more)) : undefined;
  }
  return undefined;
}
