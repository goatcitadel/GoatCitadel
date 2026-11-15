import { redactSecretText } from "@goatcitadel/contracts/secret-redaction";

const LINE_LIMIT = 160;
const SHELL_TOOLS = new Set(["shell.exec", "shell.exec_background"]);

function text(value: unknown): string | undefined {
  // Redacted before anything is cut, so a secret that spans lines or the cut never shows in part.
  return typeof value === "string" && value.trim() ? redactSecretText(value).value : undefined;
}

/** Model-written text becomes one plain line: control and invisible characters turn into single spaces. */
function plainLine(value: string): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return flat.length > LINE_LIMIT ? `${flat.slice(0, LINE_LIMIT - 1)}…` : flat;
}

function withLabel(label: string, value: string): string | undefined {
  const line = plainLine(value);
  if (!line) return undefined;
  const full = `${label}: ${line}`;
  return full.length > LINE_LIMIT ? `${full.slice(0, LINE_LIMIT - 1)}…` : full;
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
 * The one line a Chat approval card shows for what the action touches: its file, address, command or code. The
 * words come from tool arguments a model wrote, so they are shown as plain text on a single line. The first match wins.
 */
export function approvalTargetLine(
  kind: string | undefined,
  preview: Record<string, unknown> | undefined,
): string | undefined {
  if (!preview) return undefined;
  const path = text(preview.path);
  if (path) return withLabel("Path", path);
  const target = text(preview.target);
  if (target) {
    const address = addressOf(target);
    return address ? withLabel("Target", address) : undefined;
  }
  const command = text(preview.command);
  if (command && typeof preview.toolName === "string" && SHELL_TOOLS.has(preview.toolName)) {
    return withLabel("Command", command.trim().split(/\r?\n/u)[0]!);
  }
  const code = text(preview.codePreview);
  if (kind === "code_mode.run" && code) return withLabel("Code", code);
  return undefined;
}
