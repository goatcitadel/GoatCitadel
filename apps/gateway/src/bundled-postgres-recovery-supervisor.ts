export interface BundledPostgresRecoveryLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface BundledPostgresRecoverySupervisorOptions {
  readonly getHealth: () => Promise<{ reachable: boolean }>;
  readonly recover: () => Promise<void>;
  readonly logger: BundledPostgresRecoveryLogger;
  readonly probeIntervalMs?: number;
  readonly maxRetryDelayMs?: number;
}

const DEFAULT_PROBE_INTERVAL_MS = 5_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * Keeps a configured bundled Postgres runtime available after an unexpected
 * process or container stop. It deliberately owns only the recovery loop: the
 * caller retains normal startup and shutdown ownership of the runtime handle.
 */
export class BundledPostgresRecoverySupervisor {
  private readonly probeIntervalMs: number;
  private readonly maxRetryDelayMs: number;
  private started = false;
  private stopped = false;
  private consecutiveRecoveryFailures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeRun: Promise<void> | undefined;

  public constructor(private readonly options: BundledPostgresRecoverySupervisorOptions) {
    this.probeIntervalMs = requirePositiveDelay(options.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS);
    this.maxRetryDelayMs = Math.max(
      this.probeIntervalMs,
      requirePositiveDelay(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS),
    );
  }

  public start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(this.probeIntervalMs);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  public async checkNow(): Promise<void> {
    if (this.stopped || this.activeRun) return;
    const run = this.runCheck();
    this.activeRun = run;
    try {
      await run;
    } finally {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    }
  }

  private async runCheck(): Promise<void> {
    let healthy = false;
    let failure: unknown;
    try {
      healthy = (await this.options.getHealth()).reachable;
    } catch (error) {
      failure = error;
    }

    if (healthy) {
      this.consecutiveRecoveryFailures = 0;
      this.schedule(this.probeIntervalMs);
      return;
    }

    if (this.stopped) return;
    const reason = failure ? describeError(failure) : "database health check reported unreachable";
    this.options.logger.warn({ reason }, "bundled Postgres is unavailable; starting automatic recovery");

    try {
      await this.options.recover();
      if (this.stopped) return;
      const recovered = await this.options.getHealth();
      if (!recovered.reachable) {
        throw new Error("bundled Postgres remains unreachable after recovery");
      }
      this.consecutiveRecoveryFailures = 0;
      this.options.logger.info({}, "bundled Postgres automatic recovery completed");
      this.schedule(this.probeIntervalMs);
    } catch (error) {
      if (this.stopped) return;
      this.consecutiveRecoveryFailures += 1;
      const retryDelayMs = this.retryDelayMs();
      this.options.logger.warn(
        {
          attempt: this.consecutiveRecoveryFailures,
          retryDelayMs,
          error: describeError(error),
        },
        "bundled Postgres automatic recovery failed; retrying",
      );
      this.schedule(retryDelayMs);
    }
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.checkNow();
    }, delayMs);
    this.timer.unref();
  }

  private retryDelayMs(): number {
    const exponent = Math.min(this.consecutiveRecoveryFailures - 1, 8);
    return Math.min(this.maxRetryDelayMs, this.probeIntervalMs * 2 ** exponent);
  }
}

function requirePositiveDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
