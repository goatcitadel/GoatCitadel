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
