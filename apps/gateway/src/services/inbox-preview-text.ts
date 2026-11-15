import { redactSecretText, SECRET_REDACTION_MARKER } from "@goatcitadel/contracts";
import { withoutControls } from "./plugin-plain-text.js";
import { redactLocalHomePaths } from "./user-facing-failure-text.js";

/** The most of a command's or code's first line an Inbox row names, counted in characters a reader sees. */
const MAX_PREVIEW_LINE = 180;
/** The most of a command the credential check reads; a longer command is treated as carrying one. */
const MAX_SCANNED_COMMAND = 4000;
/** The most of a command's first word a withheld row names. */
const MAX_FIRST_WORD = 40;
const WITHHELD_NOTE = "(open it to see the full command)";

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const SPACE_SEPARATORS = /\p{Zs}/gu;

const SECRET_FLAGS =
  /(?<![\w-])--(?:password|passwd|pass|token|secret|body|auth|apikey|api-key|key|credential|credentials)(?![\w-])/iu;
/** `-u` or `--user` whose value holds a colon: a `name:password` pair, quoted or not. */
const USER_WITH_PASSWORD = /(?<![\w-])(?:-u|--user)[\s"']*=?[\s"']*[^\s"']*:/iu;
const CREDENTIAL_COMMANDS = /sshpass|htpasswd|docker\s+login/iu;
const DATABASE_COMMANDS =
  /(?<![\w-])(?:mysql|mysqldump|mysqladmin|mariadb|mongo|mongosh|redis-cli|psql|pg_dump)(?:\.exe)?(?![\w-])/iu;
const PASSWORD_SHORT_FLAG = /(?<![\w-])-[pa]/iu;
const ASSIGNMENT_NAME = /(?<![\w.-])[A-Za-z_]\w*(?==)/gu;
const URL_USERINFO = /:\/\/[^\s/?#]*@/u;
const SENSITIVE_SEGMENTS = new Set([
  "PASS",
  "PASSWORD",
  "PASSWD",
  "PWD",
  "SECRET",
  "TOKEN",
  "KEY",
  "APIKEY",
  "AUTH",
  "CREDENTIAL",
  "CREDENTIALS",
  "PAT",
]);
const HARMLESS_LAST_SEGMENTS = new Set(["COUNT", "ID", "LEN", "LENGTH", "MAX", "MIN"]);
const SENSITIVE_ENDINGS = ["PASSWORD", "PASSWD", "PWD"];

function sensitiveAssignmentName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === "PWD") return false;
  const segments = upper.split("_");
  if (HARMLESS_LAST_SEGMENTS.has(segments[segments.length - 1]!)) return false;
  return (
    segments.some((segment) => SENSITIVE_SEGMENTS.has(segment)) || SENSITIVE_ENDINGS.some((end) => upper.endsWith(end))
  );
}

/**
 * Whether a shell command looks as if it carries a credential. It only answers yes or no and edits nothing: a row that
 * says yes withholds the command's arguments instead of masking them, because partially masking a shell line (deleting
 * the part that looks secret) can hide the rest of the command, and without a shell parser that cannot be made safe. The
 * full command is one click away in the approval detail, redacted as before. The check is liberal on purpose: a false yes
 * only withholds detail and says so, a false no would show a password. It reads every line of the text after the shared
 * redaction, scans at most 4000 characters, and answers yes for a longer text. Each test below is one simple scan.
 */
export function shellLineLooksSecret(text: string): boolean {
  if (text.length > MAX_SCANNED_COMMAND) return true;
  if (text.includes(SECRET_REDACTION_MARKER)) return true;
  if (
    SECRET_FLAGS.test(text) ||
    USER_WITH_PASSWORD.test(text) ||
    CREDENTIAL_COMMANDS.test(text) ||
    URL_USERINFO.test(text)
  )
    return true;
  if (DATABASE_COMMANDS.test(text) && PASSWORD_SHORT_FLAG.test(text)) return true;
  return [...text.matchAll(ASSIGNMENT_NAME)].some((match) => sensitiveAssignmentName(match[0]));
}

/** Text with invisible and format characters removed and every kind of space made a plain one. */
function visibleText(line: string): string {
  return withoutControls(line.replace(INVISIBLE, "").replace(SPACE_SEPARATORS, " "));
}

/** The first word of a command for a withheld row: no directory, no quotes, plain characters only, else nothing. */
function firstWord(line: string): string {
  const token = (line.split(" ")[0] ?? "").replace(/^["']+|["']+$/gu, "");
  const word = token.split(/[/\\]/u).pop() ?? "";
  return /^[\w.+-]+$/u.test(word) ? [...word].slice(0, MAX_FIRST_WORD).join("") : "";
}

function firstLinesOf(text: string): string[] {
  const breaks = new RegExp(`\r\n|[\r\n${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, "u");
  return redactLocalHomePaths(redactSecretText(text).value).split(breaks).map(visibleText).filter(Boolean);
}

/**
 * One safe line of text a model wrote as a command or as code: secrets and the home folder taken out first (so a cut
 * can never leave half a token), invisible characters removed (so they cannot push the rest of a command past the cut),
 * then the first non-empty line, capped, with whether it was cut and how many lines were left out. With `shell`, a
 * command that looks as if it carries a credential shows only its first word. Counted in code points, so the words that
 * say a line was cut or longer are never the part that is lost.
 */
export function previewLine(label: string, text: string, options: { shell?: boolean } = {}): string | undefined {
  const lines = firstLinesOf(text);
  const [first, ...rest] = lines;
  if (!first) return undefined;
  if (options.shell && (text.length > MAX_SCANNED_COMMAND || shellLineLooksSecret(lines.join(" ")))) {
    const word = firstWord(first);
    return `${label}:${word ? ` ${word}` : ""} ${WITHHELD_NOTE}`;
  }
  const characters = [...first];
  const cut = characters.length > MAX_PREVIEW_LINE;
  const line = cut ? `${characters.slice(0, MAX_PREVIEW_LINE).join("").trimEnd()} (cut short)` : first;
  const more = rest.length ? ` (and ${rest.length} more ${rest.length === 1 ? "line" : "lines"})` : "";
  return `${label}: ${line}${more}`;
}
