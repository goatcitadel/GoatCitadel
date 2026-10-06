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

export type ProcessSignalSender = (pid: number, signal: NodeJS.Signals | 0) => void;

export type ProcessGroupStopOutcome = "exited" | "killed";

/**
 * True while any member of process group `pgid` survives. A negative pid addresses the whole
 * group and signal 0 only checks deliverability, so the probe keeps succeeding after the group
 * leader exits for as long as a descendant that stayed in the group is alive.
 */
export function isProcessGroupAlive(pgid: number, sendSignal: ProcessSignalSender = sendProcessSignal): boolean {
  try {
    sendSignal(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but is not ours to signal; it is not evidence that it exited.
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/**
 * Stop a POSIX child spawned with `detached: true` through its whole process group: SIGTERM,
 * wait up to `graceMs` for every member to exit, then SIGKILL the group if anything survives.
 *
 * Escalation follows group liveness, never leader liveness. The supervised gateway runs as
 * `pnpm exec tsx src/main.ts`, so the leader is the pnpm wrapper, which exits on SIGTERM at once
 * while tsx and the real gateway stay in its group. A leader-only check skipped SIGKILL whenever
 * the gateway's own shutdown hung, orphaning it with the supervisor's inherited stdio still open.
 */
export async function terminateProcessGroup(options: {
  pgid: number;
  graceMs: number;
  pollMs: number;
  /** Fallback when the group refuses a signal: deliver it to the leader process alone. */
  signalLeader: (signal: NodeJS.Signals) => void;
  sendSignal?: ProcessSignalSender;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ProcessGroupStopOutcome> {
  const sendSignal = options.sendSignal ?? sendProcessSignal;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      sendSignal(-options.pgid, signal);
    } catch {
      options.signalLeader(signal);
    }
  };

  signalGroup("SIGTERM");
  const deadline = now() + options.graceMs;
  while (isProcessGroupAlive(options.pgid, sendSignal)) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      signalGroup("SIGKILL");
      return "killed";
    }
    await sleep(Math.min(options.pollMs, remainingMs));
  }
  return "exited";
}

function sendProcessSignal(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldUseWorkspaceTypeScriptGraph(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env.GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH) || isTruthyEnv(env.GOATCITADEL_DEV_TS7);
}

/**
 * Resolve the spawn shape for the supervisor's reference build.
 *
 * Two paths:
 * - **Workspace TS7 graph runner** (`scripts/typescript/run-ts7-workspace.mjs`):
 *   validates the gateway project group through the shared compiler lane. Opt in via
 *   `GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH=1`; the older `GOATCITADEL_DEV_TS7=1`
 *   remains a compatibility alias.
 * - **Package `tsc -b`**: prefers a direct Node entrypoint when available; otherwise
 *   falls back to `pnpm exec tsc` through a shell-free Corepack entrypoint so workspace
 *   paths are never parsed as command text by `cmd.exe` or a POSIX shell.
 */
export function resolveReferenceBuildSpawn(opts: {
  gatewayDir: string;
  repoRoot: string;
  useWorkspaceGraph: boolean;
  platform: NodeJS.Platform;
  nodeExecutable?: string;
  fileExists?: (targetPath: string) => boolean;
}): { command: string; args: string[]; cwd: string; description: string; shell: false } {
  const nodeExecutable = opts.nodeExecutable ?? process.execPath;
  if (opts.useWorkspaceGraph) {
    return {
      command: nodeExecutable,
      args: [
        path.join(opts.repoRoot, "scripts", "typescript", "run-ts7-workspace.mjs"),
        "--mode",
        "build",
        "--group",
        "gateway",
      ],
      cwd: opts.repoRoot,
      description: "TS7 workspace graph reference build",
      shell: false,
    };
  }

  const directTsc = resolvePackageBinEntry(opts.repoRoot, "typescript-7", "tsc", opts.fileExists ?? fs.existsSync);
  if (directTsc) {
    return {
      command: nodeExecutable,
      args: [directTsc, "-b", "tsconfig.json", "--pretty", "false"],
      cwd: opts.gatewayDir,
      description: "tsc -b (direct TypeScript 7)",
      shell: false,
    };
  }

  const pnpm = resolvePnpmExecSpawn(opts.platform, nodeExecutable, opts.fileExists ?? fs.existsSync);
  return {
    command: pnpm.command,
    args: [...pnpm.argsPrefix, "tsc", "-b", "tsconfig.json", "--pretty", "false"],
    cwd: opts.gatewayDir,
    description: pnpm.description,
    shell: false,
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolvePackageBinEntry(
  repoRoot: string,
  packageName: string,
  binName: string,
  fileExists: (targetPath: string) => boolean,
): string | undefined {
  try {
    const req = createRequire(`${repoRoot}/`);
    const packageJsonPath = req.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { bin?: unknown };
    const binPath = resolvePackageBinPath(path.dirname(packageJsonPath), packageJson.bin, binName);
    if (!binPath || !fileExists(binPath)) {
      return undefined;
    }
    return binPath;
  } catch {
    return undefined;
  }
}

function resolvePackageBinPath(packageRoot: string, binField: unknown, binName: string): string | undefined {
  let relativeBinPath: unknown;
  if (typeof binField === "string") {
    relativeBinPath = binField;
  } else if (binField && typeof binField === "object") {
    relativeBinPath = (binField as Record<string, unknown>)[binName];
  }
  if (typeof relativeBinPath !== "string" || path.isAbsolute(relativeBinPath)) {
    return undefined;
  }
  const resolved = path.resolve(packageRoot, relativeBinPath);
  const relativeToPackage = path.relative(packageRoot, resolved);
  if (relativeToPackage.startsWith("..") || path.isAbsolute(relativeToPackage)) {
    return undefined;
  }
  return resolved;
}

function resolvePnpmExecSpawn(
  platform: NodeJS.Platform,
  nodeExecutable: string,
  fileExists: (targetPath: string) => boolean,
): { command: string; argsPrefix: string[]; description: string } {
  if (platform !== "win32") {
    return { command: "pnpm", argsPrefix: ["exec"], description: "tsc -b (pnpm exec)" };
  }

  const corepackEntrypoint = path.win32.join(
    path.win32.dirname(nodeExecutable),
    "node_modules",
    "corepack",
    "dist",
    "corepack.js",
  );
  if (fileExists(corepackEntrypoint)) {
    return {
      command: nodeExecutable,
      argsPrefix: [corepackEntrypoint, "pnpm", "exec"],
      description: "tsc -b (corepack pnpm exec)",
    };
  }

  throw new Error(
    "Unable to resolve a shell-free pnpm entrypoint for the Windows reference build. " +
      "Install Node with Corepack enabled or install workspace dependencies so tsc can be resolved.",
  );
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
