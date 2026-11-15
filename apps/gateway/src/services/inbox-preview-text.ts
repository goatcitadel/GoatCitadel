import { redactSecretText, SECRET_REDACTION_MARKER } from "@goatcitadel/contracts";
import { bounded } from "./inbox-projection-model.js";
import { withoutControls } from "./plugin-plain-text.js";
import { redactLocalHomePaths } from "./user-facing-failure-text.js";

/** The most of a command's or code's first line an Inbox row names; the whole row is bounded again after the label. */
const MAX_PREVIEW_LINE = 180;
/** The most of a first line the credential mask reads; the visible part is far shorter, so a longer line is cut first. */
const MAX_MASK_INPUT = 2000;

const SECRET_FLAGS = new Set(["--body", "--password", "--pass", "--token", "--secret"]);
/** Commands whose `-p` carries a password. `glued` takes only `-pSECRET`; `both` also takes `-p SECRET`. */
const PASSWORD_SHORT_FLAG: Readonly<Record<string, "glued" | "both">> = {
  mysql: "glued",
  mysqldump: "glued",
  mysqladmin: "glued",
  mariadb: "glued",
  sshpass: "both",
  "docker login": "both",
};
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SENSITIVE_NAME = /PASS|PWD|SECRET|TOKEN|KEY/iu;
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const SPACE_SEPARATORS = /\p{Zs}/gu;

/**
 * Replaces the value that starts `prefixLength` characters into `tokens[index]` and returns the index after it. A value
 * opened with a quote runs on to the token that closes it.
 */
function maskValue(tokens: string[], index: number, prefixLength: number): number {
  const first = tokens[index] ?? "";
  const value = first.slice(prefixLength);
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : undefined;
  let last = index;
  if (quote && !(value.length > 1 && value.endsWith(quote))) {
    while (last + 1 < tokens.length && !tokens[last]!.endsWith(quote)) last += 1;
  }
  tokens[index] = `${first.slice(0, prefixLength)}${SECRET_REDACTION_MARKER}`;
  for (let drop = index + 1; drop <= last; drop += 1) tokens[drop] = "";
  return last + 1;
}

function commandWord(token: string): string {
  return (token.split(/[\\/]/u).pop() ?? token).toLowerCase();
}

/**
 * A best-effort mask for a one-line summary, not a guarantee: it hides the password forms the shared redaction does not
 * recognise in a shell command (`user:password` after -u, the value after -p for the commands where it is a password,
 * the value after --body, --password, --pass, --token or --secret, and the value of a NAME=value assignment whose name
 * holds PASS, PWD, SECRET, TOKEN or KEY). The approval detail shows the same redaction as before. It reads the line once,
 * token by token, so its time grows only with the length of the line.
 */
export function maskShellCredentials(line: string): string {
  const tokens = line.slice(0, MAX_MASK_INPUT).split(" ");
  let command: string | undefined;
  let atCommandStart = true;
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (COMMAND_SEPARATORS.has(token)) {
      atCommandStart = true;
      command = undefined;
      index += 1;
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 0 && ENV_NAME.test(token.slice(0, equals)) && SENSITIVE_NAME.test(token.slice(0, equals))) {
      index = token.length > equals + 1 ? maskValue(tokens, index, equals + 1) : index + 1;
      continue;
    }
    if (atCommandStart && token) {
      const isAssignment = equals > 0 && ENV_NAME.test(token.slice(0, equals));
      if (!isAssignment && lower !== "sudo") {
        command = commandWord(token);
        if (command === "docker" && commandWord(tokens[index + 1] ?? "") === "login") command = "docker login";
        atCommandStart = false;
      }
      index += 1;
      continue;
    }
    const shortFlag = command ? PASSWORD_SHORT_FLAG[command] : undefined;
    const flagName = lower.split("=", 1)[0]!;
    if (SECRET_FLAGS.has(flagName)) {
      if (lower.includes("=")) index = maskValue(tokens, index, flagName.length + 1);
      else if (index + 1 < tokens.length) index = maskValue(tokens, index + 1, 0);
      else index += 1;
    } else if (shortFlag && token === "-p" && shortFlag === "both" && index + 1 < tokens.length) {
      index = maskValue(tokens, index + 1, 0);
    } else if (shortFlag && token.length > 2 && token.startsWith("-p")) {
      index = maskValue(tokens, index, 2);
    } else if ((lower === "-u" || lower === "--user") && tokens[index + 1]?.includes(":")) {
      const next = tokens[index + 1]!;
      index = maskValue(tokens, index + 1, next.indexOf(":") + 1);
    } else if (lower.startsWith("--user=") && token.includes(":")) {
      index = maskValue(tokens, index, token.indexOf(":") + 1);
    } else if (lower.startsWith("-u") && !lower.startsWith("--") && token.length > 2 && token.includes(":")) {
      index = maskValue(tokens, index, token.indexOf(":") + 1);
    } else {
      index += 1;
    }
  }
  return tokens.filter((token) => token !== "").join(" ");
}

/** Text with invisible and format characters removed and every kind of space made a plain one. */
function visibleText(line: string): string {
  return withoutControls(line.replace(INVISIBLE, "").replace(SPACE_SEPARATORS, " "));
}

/**
 * One safe line of text a model wrote as a command or as code: secrets and the home folder taken out first (so a cut
 * can never leave half a token), invisible characters removed (so they cannot push the rest of a command past the cut),
 * then the first non-empty line, capped, with how many lines were left out and whether this one was cut.
 */
export function previewLine(label: string, text: string, options: { shell?: boolean } = {}): string | undefined {
  const lines = redactLocalHomePaths(redactSecretText(text).value)
    .split(/\r\n|[\r\n\u2028\u2029]/u)
    .map(visibleText)
    .filter(Boolean);
  const [rawFirst, ...rest] = lines;
  if (!rawFirst) return undefined;
  const redacted = redactSecretText(rawFirst).value;
  const first = options.shell ? maskShellCredentials(redacted) : redacted;
  const characters = [...first];
  const cut = characters.length > MAX_PREVIEW_LINE;
  const line = cut ? `${characters.slice(0, MAX_PREVIEW_LINE).join("").trimEnd()} (cut short)` : first;
  const more = rest.length ? ` (and ${rest.length} more ${rest.length === 1 ? "line" : "lines"})` : "";
  return bounded(`${label}: ${line}${more}`);
}
