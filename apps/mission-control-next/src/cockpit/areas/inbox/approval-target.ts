import { redactSecretText } from "@goatcitadel/contracts/secret-redaction";

const LINE_LIMIT = 160;
const CUT_NOTE = " (cut short)";
const SHELL_TOOLS = new Set(["shell.exec", "shell.exec_background"]);
// Characters that show nothing but can pad a line so a harmful tail falls past the cut: default-ignorable code points
// (zero-width, joiners, variation selectors, soft hyphen, the combining grapheme joiner) plus the blank fillers.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u2800\u115F\u1160\u3164\uFFA0]+/gu;
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029\u0085]/u;

function text(value: unknown): string | undefined {
  // Redacted before anything is cut, so a secret that spans lines or the cut never shows in part.
  return typeof value === "string" && value.trim() ? redactSecretText(value).value : undefined;
}

/** One line of model-written text as plain words: nothing invisible, every space or control character one space. */
function cleanLine(value: string): string {
  return value
    .replace(INVISIBLE, "")
    .replace(/[\p{Cc}\p{Cf}\p{Z}]+/gu, " ")
    .trim();
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(LINE_BREAK)
    .map(cleanLine)
    .filter((line) => line.length > 0);
}

/** The label and line, cut so the whole stays within the limit, and the cut said in words. */
function withLabel(label: string, line: string, note = ""): string | undefined {
  if (!line) return undefined;
  const whole = `${label}: ${line}`;
  if (whole.length + note.length <= LINE_LIMIT) return `${whole}${note}`;
  const room = LINE_LIMIT - note.length - CUT_NOTE.length - 1;
  return `${whole.slice(0, Math.max(room, 0)).trimEnd()}…${CUT_NOTE}${note}`;
}

function addressOf(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.host ? `${url.protocol}//${url.host}` : undefined;
  } catch {
    return undefined;
  }
}

// Credential forms the shared redactor does not recognise. A command that carries one never shows its arguments in
// the heading; the review summary below the heading shows the same text. Each check is a single linear pass.
const CREDENTIAL_MARKERS: readonly RegExp[] = [
  /(?:^|\s)(?:--user[=\s]\s*|-u\s*)\S*:/u,
  /(?:^|\s)--(?:password|pass|token|secret|body)(?=$|[\s=-])/iu,
  /(?:^|[\s;&|])[A-Za-z0-9_]*(?:PASS|PWD|SECRET|TOKEN|KEY)[A-Za-z0-9_]*=\S/iu,
];
const PASSWORD_FLAG_PROGRAMS = /\b(?:mysql|mysqldump|mariadb|sshpass|docker\s+login)\b/iu;
const PASSWORD_FLAG = /(?:^|\s)-p/u;

function carriesCredential(command: string): boolean {
  return (
    CREDENTIAL_MARKERS.some((marker) => marker.test(command)) ||
    (PASSWORD_FLAG_PROGRAMS.test(command) && PASSWORD_FLAG.test(command))
  );
}

function commandLine(command: string): string | undefined {
  const lines = nonEmptyLines(command);
  if (lines.length === 0) return undefined;
  if (carriesCredential(lines.join(" "))) {
    const word = lines[0]!.split(" ").find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
    return `Command: ${(word ?? "command").slice(0, 40)} (details below)`;
  }
  const more = lines.length - 1;
  const note = more > 0 ? ` (and ${more} more ${more === 1 ? "line" : "lines"})` : "";
  return withLabel("Command", lines[0]!, note);
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
  if (path) return withLabel("Path", nonEmptyLines(path).join(" "));
  const target = text(preview.target);
  if (target) {
    const address = addressOf(target);
    return address ? withLabel("Target", address) : undefined;
  }
  const command = text(preview.command);
  if (command && typeof preview.toolName === "string" && SHELL_TOOLS.has(preview.toolName)) {
    return commandLine(command);
  }
  const code = text(preview.codePreview);
  if (kind === "code_mode.run" && code) return withLabel("Code", nonEmptyLines(code).join(" "));
  return undefined;
}
