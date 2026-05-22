import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const WATCHABLE_EXTENSIONS = new Set([".ts", ".tsx", ".json"]);
const IGNORED_WATCH_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

export function sanitizeSpawnOutput(value: string | Buffer | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text.slice(-1200) : undefined;
}

export function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type ReferenceBuildMode = "auto" | "always" | "skip";

export function resolveReferenceBuildMode(value: string | undefined): ReferenceBuildMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return "auto";
  }
  if (normalized === "always" || normalized === "force" || normalized === "1" || normalized === "true") {
    return "always";
  }
  if (normalized === "skip" || normalized === "never" || normalized === "0" || normalized === "false") {
    return "skip";
  }
  return "auto";
}

export function shouldBuildGatewayProjectReferences(input: {
  mode: ReferenceBuildMode;
  currentSignature: string;
  lastSuccessfulSignature?: string;
}): { build: boolean; reason: string } {
  if (input.mode === "always") {
    return { build: true, reason: "forced by reference build mode" };
  }
  if (input.mode === "skip") {
    return { build: false, reason: "forced by reference build mode" };
  }
  if (input.lastSuccessfulSignature !== undefined && input.lastSuccessfulSignature === input.currentSignature) {
    return { build: false, reason: "source signature unchanged since last successful reference build" };
  }
  return { build: true, reason: "source signature changed or not built yet" };
}

export function resolveGatewayHealthHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return "127.0.0.1";
  }
  return host;
}

export function shouldIgnoreWatchedEntryName(name: string): boolean {
  return IGNORED_WATCH_DIRECTORIES.has(name);
}

export function isWatchableSourceFile(filePath: string): boolean {
  return WATCHABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function formatSignatureEntry(repoRoot: string, targetPath: string, mtimeMs: number): string {
  const relative = path.relative(repoRoot, targetPath).replaceAll("\\", "/");
  return `${relative}:${mtimeMs}`;
}

export function pruneFailureTimestamps(failureTimestamps: number[], now: number, restartWindowMs: number): void {
  while (failureTimestamps.length > 0 && now - (failureTimestamps[0] ?? now) > restartWindowMs) {
    failureTimestamps.shift();
  }
}

export function buildGatewayStartCommandForPlatform(
  platform: NodeJS.Platform,
  comspec: string | undefined,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm exec tsx src/main.ts"],
    };
  }
  return {
    command: "pnpm",
    args: ["exec", "tsx", "src/main.ts"],
  };
}

export function shouldUseTs7(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GOATCITADEL_DEV_TS7?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Resolve the spawn shape for the supervisor's reference build.
 *
 * Two paths:
 * - **TS7 (`@typescript/native-preview` via `scripts/typescript/run-ts7-workspace.mjs`)**:
 *   the native compiler is ~3-10× faster than `tsc` on cold builds. Opt-in via
 *   `GOATCITADEL_DEV_TS7=1`.
 * - **Direct `node + tsc.js`**: skips both the `cmd.exe /d /s /c` wrapper and the
 *   `pnpm exec` boot, saving ~300ms per supervised restart on Windows. The fallback
 *   to the `cmd.exe` form is kept for environments where `typescript/bin/tsc` does
 *   not resolve (extremely unusual; only happens when the workspace install is
 *   broken in which case we want the louder error message anyway).
 */
export function resolveReferenceBuildSpawn(opts: {
  gatewayDir: string;
  repoRoot: string;
  useTs7: boolean;
  comspec: string | undefined;
  platform: NodeJS.Platform;
}): { command: string; args: string[]; cwd: string; description: string } {
  if (opts.useTs7) {
    return {
      command: process.execPath,
      args: [
        path.join(opts.repoRoot, "scripts", "typescript", "run-ts7-workspace.mjs"),
        "--mode",
        "build",
        "--group",
        "gateway",
      ],
      cwd: opts.repoRoot,
      description: "TS7 (tsgo) reference build",
    };
  }

  const directTsc = resolveTscEntry(opts.gatewayDir);
  if (directTsc) {
    return {
      command: process.execPath,
      args: [directTsc, "-b", "tsconfig.json", "--pretty", "false"],
      cwd: opts.gatewayDir,
      description: "tsc -b (direct)",
    };
  }

  if (opts.platform === "win32") {
    return {
      command: opts.comspec || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm exec tsc -b tsconfig.json --pretty false"],
      cwd: opts.gatewayDir,
      description: "tsc -b (pnpm exec)",
    };
  }
  return {
    command: "pnpm",
    args: ["exec", "tsc", "-b", "tsconfig.json", "--pretty", "false"],
    cwd: opts.gatewayDir,
    description: "tsc -b (pnpm exec)",
  };
}

function resolveTscEntry(gatewayDir: string): string | undefined {
  try {
    const req = createRequire(`${gatewayDir}/`);
    return req.resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
}

export function readReferenceSignatureCache(cacheFile: string): string | undefined {
  try {
    const raw = fs.readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw) as { signature?: unknown };
    return typeof parsed.signature === "string" ? parsed.signature : undefined;
  } catch {
    return undefined;
  }
}

export function writeReferenceSignatureCache(cacheFile: string, signature: string): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ signature, writtenAt: new Date().toISOString() })}\n`, "utf8");
  } catch {
    // Cache writes are best-effort; the next dev start will simply rebuild.
  }
}
