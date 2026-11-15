import fs from "node:fs";
import path from "node:path";

export function resolvePnpmCommandForPlatform(
  appDir: string,
  platform: NodeJS.Platform,
): { cmd: string; prefix: string[] } {
  const baseDir = path.dirname(appDir);
  const localCandidates =
    platform === "win32"
      ? [path.join(baseDir, "bin", "pnpm.cmd"), path.join(baseDir, "bin", "pnpm.ps1")]
      : [path.join(baseDir, "bin", "pnpm")];

  for (const candidate of localCandidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (candidate.endsWith(".ps1")) {
      return {
        cmd: "powershell.exe",
        prefix: ["-ExecutionPolicy", "Bypass", "-File", candidate],
      };
    }
    return {
      cmd: candidate,
      prefix: [],
    };
  }

  return platform === "win32" ? { cmd: "pnpm.cmd", prefix: [] } : { cmd: "pnpm", prefix: [] };
}

export function buildWindowsCommand(parts: string[]): string {
  return parts.map((value) => quoteWindowsCommandArg(value)).join(" ");
}

export function quoteWindowsCommandArg(value: string): string {
  assertSafeWindowsCommandArg(value);
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value}"`;
}

function assertSafeWindowsCommandArg(value: string): void {
  if (/["%\r\n\0]/.test(value)) {
    throw new Error(
      "Windows shell command arguments must not contain embedded quotes, percent expansions, or control characters.",
    );
  }
}

export function clampOption<const T extends readonly string[]>(
  value: string,
  options: T,
  fallback: T[number],
): T[number] {
  return (options.find((option) => option === value) ?? fallback) as T[number];
}

export function parseCommaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function safeHostnameFromUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

/** True when the operator closed a prompt (Ctrl+C or Esc); the wizard then exits without an error. */
export function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

const URL_PROMPT_MESSAGE = "Enter a full address that starts with http:// or https://.";

export function validateHttpUrl(value: string): true | string {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? true : URL_PROMPT_MESSAGE;
  } catch {
    return URL_PROMPT_MESSAGE;
  }
}

export function validateRequired(label: string): (value: string) => true | string {
  return (value: string) => (value.trim().length > 0 ? true : `Enter ${label}.`);
}

/**
 * True when the chosen provider reads its key from a named variable, no key was
 * typed for it and that variable is unset or blank, so Chat could not answer.
 */
export function providerKeyMissing(input: { apiKey: string; apiKeyEnv: string; env: NodeJS.ProcessEnv }): boolean {
  if (input.apiKey.trim().length > 0) {
    return false;
  }
  const variable = input.apiKeyEnv.trim();
  if (!variable) {
    return false;
  }
  return (input.env[variable] ?? "").trim().length === 0;
}

/** Replaces every occurrence of a secret in text so an error line can be printed safely. */
export function redactSecret(text: string, secret: string): string {
  const value = secret.trim();
  return value ? text.split(value).join("[hidden]") : text;
}

export type ProviderKeyStatus =
  | { kind: "not_needed" }
  | { kind: "typed_saved" }
  | { kind: "typed_not_saved" }
  | { kind: "gateway"; source: "inline" | "env" | "keychain" }
  | { kind: "environment" }
  | { kind: "missing" };

/** Where the chosen provider's key comes from, in the order an operator would reason about it. */
export function resolveProviderKeyStatus(input: {
  apiKey: string;
  keySaved: boolean;
  apiKeyEnv: string;
  env: NodeJS.ProcessEnv;
  existing?: { hasApiKey?: boolean; apiKeySource?: string };
  /** The provider's endpoint is on this machine; the Gateway treats that as ready without a key. */
  localEndpoint?: boolean;
}): ProviderKeyStatus {
  if (input.apiKey.trim().length > 0) {
    return input.keySaved ? { kind: "typed_saved" } : { kind: "typed_not_saved" };
  }
  const source = input.existing?.apiKeySource;
  if (input.existing?.hasApiKey && (source === "inline" || source === "env" || source === "keychain")) {
    return { kind: "gateway", source };
  }
  if (input.apiKeyEnv.trim().length === 0) {
    return { kind: "not_needed" };
  }
  if (!providerKeyMissing({ apiKey: "", apiKeyEnv: input.apiKeyEnv, env: input.env })) {
    return { kind: "environment" };
  }
  return input.localEndpoint ? { kind: "not_needed" } : { kind: "missing" };
}

/** A short plain reason for a failed key save: no route, status line or response body. */
export function describeKeySaveFailure(error: unknown): string {
  const status = /failed \((\d{3})\)/.exec(error instanceof Error ? error.message : "")?.[1];
  if (status === "503" || status === "501") {
    return "no secure storage is available on this computer";
  }
  if (status) {
    return "the Gateway refused it";
  }
  if (error instanceof TypeError) {
    return "the Gateway could not be reached";
  }
  return "something went wrong while saving it";
}
