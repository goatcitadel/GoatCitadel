import path from "node:path";

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
