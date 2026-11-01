/**
 * Readiness for the `claude-code-cli` provider means "the operator's Claude Code
 * CLI is present and signed in with a first-party subscription login". It is
 * probed with `claude auth status --json`; GoatCitadel never reads the credential.
 */

export interface ClaudeCodeCliReadinessResult {
  status: "ready" | "missing" | "invalid" | "unavailable";
  reasonCode: string;
  /** True once a status probe actually ran against the installed CLI. */
  liveVerified: boolean;
}

export interface ClaudeCodeCliStatusRun {
  (args: readonly string[]): Promise<{ exitCode: number | null; stdout: string }>;
}

/** Whether organization-managed Claude Code settings define hooks (which no user flag can disable). */
/** Managed settings GoatCitadel cannot override: hooks, or ("auto_memory") auto-memory forced on. */
export type ClaudeManagedHooksState = "none" | "active" | "unreadable" | "auto_memory";

export const CLAUDE_CLI_AUTH_STATUS_ARGS = ["auth", "status", "--json"] as const;
const DEFAULT_TTL_MS = 60_000;

export class ClaudeCodeCliReadiness {
  private readonly run: ClaudeCodeCliStatusRun;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { at: number; result: ClaudeCodeCliReadinessResult } | undefined;
  /** Bumped by invalidate(); a probe only writes the cache while its generation is still current. */
  private generation = 0;
  private inFlight: { gen: number; promise: Promise<ClaudeCodeCliReadinessResult> } | undefined;
  private last: ClaudeCodeCliReadinessResult | undefined;

  private readonly managedHooks: () => ClaudeManagedHooksState;

  public constructor(options: {
    run: ClaudeCodeCliStatusRun;
    now?: () => number;
    ttlMs?: number;
    managedHooks?: () => ClaudeManagedHooksState;
  }) {
    this.run = options.run;
    this.managedHooks = options.managedHooks ?? (() => "none");
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  public async check(): Promise<ClaudeCodeCliReadinessResult> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.result;
    if (this.inFlight) return await this.inFlight.promise;
    const gen = this.generation;
    const entry: { gen: number; promise: Promise<ClaudeCodeCliReadinessResult> } = {
      gen,
      promise: this.probe().then((result) => {
        if (gen === this.generation) {
          // A transient probe failure (slow cold start, spawn hiccup) must not block every turn for the TTL.
          this.cached = result.status === "unavailable" ? undefined : { at: this.now(), result };
          this.last = result;
        }
        return result;
      }),
    };
    this.inFlight = entry;
    try {
      return await entry.promise;
    } finally {
      if (this.inFlight === entry) this.inFlight = undefined;
    }
  }

  /** Last probed result without spawning anything; undefined until the first probe. */
  public peek(): ClaudeCodeCliReadinessResult | undefined {
    return this.last;
  }

  public invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.inFlight = undefined;
  }

  private async probe(): Promise<ClaudeCodeCliReadinessResult> {
    // Managed hooks run even with --safe-mode and disableAllHooks, outside GoatCitadel's approvals.
    // An unreadable managed file fails closed too.
    const managed = this.managedHooks();
    // Managed settings outrank --settings, so a managed auto-memory override cannot be undone per run.
    if (managed === "auto_memory") {
      return { status: "invalid", reasonCode: "claude_cli_managed_auto_memory", liveVerified: true };
    }
    if (managed !== "none") {
      return { status: "invalid", reasonCode: "claude_cli_managed_hooks_active", liveVerified: true };
    }
    let output: { exitCode: number | null; stdout: string };
    try {
      output = await this.run(CLAUDE_CLI_AUTH_STATUS_ARGS);
    } catch (error) {
      const reasonCode = readReasonCode(error) ?? "claude_cli_status_failed";
      return { status: "unavailable", reasonCode, liveVerified: false };
    }
    const parsed = parseStatus(output.stdout);
    if (!parsed) return { status: "unavailable", reasonCode: "claude_cli_status_unreadable", liveVerified: false };
    if (parsed.loggedIn !== true) {
      return { status: "missing", reasonCode: "claude_cli_logged_out", liveVerified: true };
    }
    const authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod.toLowerCase() : "";
    const apiProvider = typeof parsed.apiProvider === "string" ? parsed.apiProvider : "firstParty";
    if (apiProvider !== "firstParty" || /api[_\s-]?key|apikey|console/.test(authMethod)) {
      return { status: "invalid", reasonCode: "claude_cli_not_subscription_login", liveVerified: true };
    }
    return { status: "ready", reasonCode: "claude_cli_logged_in", liveVerified: true };
  }
}

function parseStatus(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readReasonCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
  return typeof reasonCode === "string" && /^claude_cli_[a-z_]+$/.test(reasonCode) ? reasonCode : undefined;
}

export interface ManagedSettingsFs {
  readFile(filePath: string): string | undefined;
  listDir(dirPath: string): string[];
}

/** Known managed-settings locations per platform (file plus its `managed-settings.d` drop-in dir). */
export function claudeManagedSettingsDirs(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "win32") {
    return [
      `${env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files"}\\ClaudeCode`,
      `${env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData"}\\ClaudeCode`,
    ];
  }
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode"];
  return ["/etc/claude-code"];
}

export function detectClaudeManagedHooks(
  dirs: readonly string[],
  fs: ManagedSettingsFs,
  separator = "/",
): ClaudeManagedHooksState {
  const files: string[] = [];
  for (const dir of dirs) {
    files.push(`${dir}${separator}managed-settings.json`);
    const dropIn = `${dir}${separator}managed-settings.d`;
    for (const name of fs
      .listDir(dropIn)
      .filter((entry) => entry.toLowerCase().endsWith(".json"))
      .sort()) {
      files.push(`${dropIn}${separator}${name}`);
    }
  }
  let autoMemoryForced = false;
  for (const file of files) {
    const text = fs.readFile(file);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return "unreadable";
    }
    const settings = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const hooks = settings.hooks;
    if (typeof hooks === "object" && hooks !== null && Object.keys(hooks).length > 0) return "active";
    if (forcesAutoMemory(settings)) autoMemoryForced = true;
  }
  return autoMemoryForced ? "auto_memory" : "none";
}

/** Managed `autoMemoryEnabled: true`, or a managed env that sets the auto-memory switch to anything but "1". */
function forcesAutoMemory(settings: Record<string, unknown>): boolean {
  if (settings.autoMemoryEnabled === true) return true;
  const env = settings.env;
  if (typeof env !== "object" || env === null) return false;
  const value = (env as Record<string, unknown>).CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  return value !== undefined && String(value) !== "1";
}
