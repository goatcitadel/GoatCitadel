import { compileBoundedRiskPattern, normalizeRiskText } from "./pattern-utils.js";

const MAX_COMMAND_CHARS = 32_768;
const MAX_TOKENS = 512;
const MAX_NESTING = 3;
const ALIASES: Record<string, string> = { "remove-item": "rm", ri: "rm", rd: "rmdir", erase: "del" };
const INDIRECT_COMMANDS = new Set([
  "invoke-expression",
  "iex",
  "start-process",
  "saps",
  "invoke-command",
  "icm",
  "set-alias",
  "new-alias",
  "sal",
  "nal",
  "call",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

interface Token {
  value: string;
  quoted: boolean;
}

/** Conservative literal-wrapper inspection, not a full shell parser or sandbox. */
export function inspectWindowsShellRisk(command: string, patterns: readonly string[], depth = 0): string | undefined {
  const executableMatch = command.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const executable = basename(executableMatch?.[1] ?? executableMatch?.[2] ?? executableMatch?.[3] ?? "");
  const powershell = /^(?:powershell|pwsh)(?:\.exe)?$/.test(executable);
  const cmd = /^(?:cmd)(?:\.exe)?$/.test(executable);
  if (!powershell && !cmd) return undefined;
  if (command.length > MAX_COMMAND_CHARS || depth >= MAX_NESTING) return "windows_shell_uninspectable";
  try {
    const words = tokenize(command, false);
    const flagIndex = words.findIndex(
      (token, index) =>
        index > 0 && (powershell ? /^(?:-command|-c|-encodedcommand|-enc)$/i : /^\/c$/i).test(token.value),
    );
    if (flagIndex < 0) return "windows_shell_uninspectable";
    const switches = powershell ? /^-(?:noprofile|nologo|noninteractive)$/i : /^\/(?:d|s|q)$/i;
    if (words.slice(1, flagIndex).some((token) => !switches.test(token.value))) {
      return "windows_shell_uninspectable";
    }
    const flag = words[flagIndex]!.value.toLowerCase();
    let script = words
      .slice(flagIndex + 1)
      .map((token) => token.value)
      .join(" ");
    if (powershell && /^(?:-encodedcommand|-enc)$/.test(flag)) {
      if (!/^[a-z0-9+/]+={0,2}$/i.test(script)) return "windows_shell_uninspectable";
      const bytes = Buffer.from(script, "base64");
      if (bytes.length % 2 !== 0 || bytes.toString("base64") !== script) return "windows_shell_uninspectable";
      script = bytes.toString("utf16le");
    }
    if (!script.trim() || script.length > MAX_COMMAND_CHARS) return "windows_shell_uninspectable";
    const scriptWords = tokenize(script, true);
    let segment: Token[] = [];
    const segments: Token[][] = [];
    for (const token of scriptWords) {
      if (!token.quoted && [";", "|", "&", "&&", "||"].includes(token.value)) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else segment.push(token);
    }
    if (segment.length) segments.push(segment);
    for (const tokens of segments) {
      const name = basename(tokens[0]?.value ?? "");
      if (/\.(?:ps1|cmd|bat)$/.test(name) || name === ".") return "windows_shell_uninspectable";
      if (INDIRECT_COMMANDS.has(name)) {
        if (/^(?:cmd|powershell|pwsh)(?:\.exe)?$/.test(name)) {
          const nested = tokens
            .map((token) => (token.quoted ? `"${token.value.replaceAll('"', '\\"')}"` : token.value))
            .join(" ");
          const risk = inspectWindowsShellRisk(nested, patterns, depth + 1);
          if (risk) return risk;
        } else return "windows_shell_indirect_execution";
      }
      const normalizedName = ALIASES[name] ?? name.replace(/\.exe$/, "");
      const surface = [normalizedName, ...tokens.slice(1).map((token) => token.value)].join(" ");
      for (const pattern of patterns) {
        const normalizedPattern = normalizeRiskText(pattern);
        const expectedCommand = normalizedPattern.split(/\s/)[0]?.toLowerCase();
        // Literal patterns inspect the command position, not quoted data passed to Write-Output.
        if (normalizedPattern.startsWith("*") || expectedCommand?.includes("*") || expectedCommand === normalizedName) {
          if (compileBoundedRiskPattern(normalizedPattern).test(surface)) return pattern;
        }
      }
    }
    return undefined;
  } catch {
    return "windows_shell_uninspectable";
  }
}

function basename(value: string): string {
  return (value.split(/[\\/]/).at(-1) ?? value).toLowerCase();
}

function tokenize(source: string, script: boolean): Token[] {
  const tokens: Token[] = [];
  let value = "";
  let quote = "";
  let quoted = false;
  const emit = () => {
    if (value || quoted) tokens.push({ value, quoted });
    value = "";
    quoted = false;
    if (tokens.length > MAX_TOKENS) throw new Error("token bound");
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) {
        if (source[index + 1] === quote) {
          value += char;
          index++;
        } else quote = "";
      } else {
        if (script && quote === '"' && /[$`!%]/.test(char)) throw new Error("expansion");
        value += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
    } else if (script && /[$`{}()<>!%^]/.test(char)) throw new Error("unsupported syntax");
    else if (/\s/.test(char)) {
      emit();
      if (script && /[\r\n]/.test(char)) tokens.push({ value: ";", quoted: false });
    } else if (script && /[;&|]/.test(char)) {
      emit();
      let operator = char;
      if (source[index + 1] === char && char !== ";") {
        operator += char;
        index++;
      }
      tokens.push({ value: operator, quoted: false });
    } else value += char;
  }
  if (quote) throw new Error("unclosed quote");
  emit();
  return tokens;
}
