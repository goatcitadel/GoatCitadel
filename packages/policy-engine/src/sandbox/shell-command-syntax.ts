/**
 * shell.exec and shell.exec_background run one program with its arguments
 * (execFile semantics); they never start a shell. A command written as a shell
 * script would spawn its first word as a program name and fail with ENOENT, or
 * pass operators such as `|` to the program as literal arguments. This check
 * names the shell construct so the caller can fail before approval and dispatch.
 */
export interface ShellScriptSyntaxFinding {
  construct: string;
}

const LEADING_SHELL_VARIABLE = /^\$[A-Za-z_{][\w:{}]*\s*(?:=|$|\s)/u;
const LEADING_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

export function detectShellScriptSyntax(command: string): ShellScriptSyntaxFinding | undefined {
  const input = command.trim();
  if (LEADING_SHELL_VARIABLE.test(input)) {
    return { construct: "a shell variable as the first word (for example $dir=...)" };
  }
  if (LEADING_ENV_ASSIGNMENT.test(input)) {
    return { construct: "an inline environment assignment as the first word (NAME=value)" };
  }
  if (/^&(?:\s|$)/u.test(input)) {
    return { construct: "the PowerShell call operator (&)" };
  }
  return scanUnquotedOperators(input);
}

export function formatShellScriptSyntaxError(toolName: string, finding: ShellScriptSyntaxFinding): string {
  return [
    `${toolName} runs one program with its arguments and does not start a shell, so ${finding.construct} cannot work.`,
    "Call the program directly (for example: msedge --headless --print-to-pdf=out.pdf page.html),",
    'or run the script through an explicit shell: pwsh -NoProfile -Command "<script>" on Windows, sh -c "<script>" elsewhere.',
    "For a long script, write it to a file with fs.write first and run it through its interpreter: pwsh -NoProfile -File script.ps1 or sh script.sh.",
  ].join(" ");
}

/** Walks the command with the same quote and escape rules as the shell.exec tokenizer. */
function scanUnquotedOperators(input: string): ShellScriptSyntaxFinding | undefined {
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = next === '"' || next === "'" || next === "\\" || /\s/u.test(next);
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    const finding = unquotedOperatorAt(char, next, input[index - 1] ?? "");
    if (finding) return finding;
  }
  return undefined;
}

function unquotedOperatorAt(char: string, next: string, previous: string): ShellScriptSyntaxFinding | undefined {
  switch (char) {
    case "\n":
    case "\r":
      return { construct: "a multi-line script" };
    case ";":
      return { construct: "a command separator (;)" };
    case "|":
      return { construct: next === "|" ? "command chaining (||)" : "a pipe (|)" };
    case "&":
      if (next === "&") return { construct: "command chaining (&&)" };
      return /\s/u.test(previous) && (next === "" || /\s/u.test(next))
        ? { construct: "a background or call operator (&)" }
        : undefined;
    case ">":
    case "<":
      return { construct: "output or input redirection (> or <)" };
    case "$":
      if (next === "(") return { construct: "command substitution ($(...))" };
      // Unquoted $NAME or ${NAME} would reach the program as literal text, never the variable's value.
      return /[A-Za-z_{]/u.test(next) ? { construct: "a shell variable reference ($NAME)" } : undefined;
    default:
      return undefined;
  }
}
