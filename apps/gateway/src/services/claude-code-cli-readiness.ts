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

export const CLAUDE_CLI_AUTH_STATUS_ARGS = ["auth", "status", "--json"] as const;
const DEFAULT_TTL_MS = 60_000;

export class ClaudeCodeCliReadiness {
  private readonly run: ClaudeCodeCliStatusRun;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { at: number; result: ClaudeCodeCliReadinessResult } | undefined;
  private inFlight: Promise<ClaudeCodeCliReadinessResult> | undefined;
  private last: ClaudeCodeCliReadinessResult | undefined;

  public constructor(options: { run: ClaudeCodeCliStatusRun; now?: () => number; ttlMs?: number }) {
    this.run = options.run;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  public async check(): Promise<ClaudeCodeCliReadinessResult> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.result;
    if (this.inFlight) return await this.inFlight;
    this.inFlight = this.probe().then((result) => {
      // A transient probe failure (slow cold start, spawn hiccup) must not block every turn for the TTL.
      this.cached = result.status === "unavailable" ? undefined : { at: this.now(), result };
      this.last = result;
      return result;
    });
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** Last probed result without spawning anything; undefined until the first probe. */
  public peek(): ClaudeCodeCliReadinessResult | undefined {
    return this.last;
  }

  public invalidate(): void {
    this.cached = undefined;
  }

  private async probe(): Promise<ClaudeCodeCliReadinessResult> {
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
