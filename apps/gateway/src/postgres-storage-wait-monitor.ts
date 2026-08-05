import type { PostgresSyncWaitDiagnostic } from "@goatcitadel/storage";

const WINDOW_MS = 5 * 60_000;
const SLOW_WAIT_MS = 250;
const CRITICAL_WAIT_MS = 2_000;
const SLOW_EMIT_INTERVAL_MS = 30_000;
const CRITICAL_EMIT_INTERVAL_MS = 5_000;

interface TimedStorageWait extends PostgresSyncWaitDiagnostic {
  observedAtMs: number;
}

export interface StorageWaitPerformanceSnapshot {
  windowMs: number;
  count: number;
  slowCount: number;
  criticalCount: number;
  p95Ms: number;
  maxMs: number;
  latest?: {
    operationKind: string;
    transactionPosture: PostgresSyncWaitDiagnostic["transactionPosture"];
    sessionPosture: PostgresSyncWaitDiagnostic["sessionPosture"];
    outcome: PostgresSyncWaitDiagnostic["outcome"];
    durationMs: number;
  };
}

export interface PostgresStorageWaitMonitorOptions {
  now?: () => number;
  recordDiagnostic?: (input: {
    level: "warn" | "error";
    category: "storage";
    event: "postgres_sync_wait_slow" | "postgres_sync_wait_critical";
    message: string;
    durationMs: number;
    context: Record<string, unknown>;
  }) => void;
}

export class PostgresStorageWaitMonitor {
  private readonly waits: TimedStorageWait[] = [];
  private readonly now: () => number;
  private lastSlowEmitAt = Number.NEGATIVE_INFINITY;
  private lastCriticalEmitAt = Number.NEGATIVE_INFINITY;

  public constructor(private readonly options: PostgresStorageWaitMonitorOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  public observe(wait: PostgresSyncWaitDiagnostic): void {
    const observedAtMs = this.now();
    this.prune(observedAtMs);
    this.waits.push({ ...wait, observedAtMs });
    if (wait.durationMs < SLOW_WAIT_MS) {
      return;
    }

    const critical = wait.durationMs >= CRITICAL_WAIT_MS;
    const lastEmitAt = critical ? this.lastCriticalEmitAt : this.lastSlowEmitAt;
    const intervalMs = critical ? CRITICAL_EMIT_INTERVAL_MS : SLOW_EMIT_INTERVAL_MS;
    if (observedAtMs - lastEmitAt < intervalMs) {
      return;
    }
    if (critical) {
      this.lastCriticalEmitAt = observedAtMs;
    } else {
      this.lastSlowEmitAt = observedAtMs;
    }
    const snapshot = this.snapshot();
    try {
      this.options.recordDiagnostic?.({
        level: critical ? "error" : "warn",
        category: "storage",
        event: critical ? "postgres_sync_wait_critical" : "postgres_sync_wait_slow",
        message: critical
          ? "A PostgreSQL compatibility wait blocked the Gateway main thread for at least two seconds."
          : "A PostgreSQL compatibility wait exceeded the 250ms latency threshold.",
        durationMs: wait.durationMs,
        context: {
          operationKind: wait.operationKind,
          transactionPosture: wait.transactionPosture,
          sessionPosture: wait.sessionPosture,
          outcome: wait.outcome,
          rollingWindowMs: snapshot.windowMs,
          rollingCount: snapshot.count,
          rollingP95Ms: snapshot.p95Ms,
          rollingMaxMs: snapshot.maxMs,
        },
      });
    } catch {
      // Observability must never affect database behavior.
    }
  }

  public snapshot(): StorageWaitPerformanceSnapshot {
    const now = this.now();
    this.prune(now);
    const durations = this.waits.map((wait) => wait.durationMs).sort((left, right) => left - right);
    const p95Index = durations.length === 0 ? 0 : Math.max(0, Math.ceil(durations.length * 0.95) - 1);
    const latest = this.waits.at(-1);
    return {
      windowMs: WINDOW_MS,
      count: this.waits.length,
      slowCount: this.waits.filter((wait) => wait.durationMs >= SLOW_WAIT_MS).length,
      criticalCount: this.waits.filter((wait) => wait.durationMs >= CRITICAL_WAIT_MS).length,
      p95Ms: durations[p95Index] ?? 0,
      maxMs: durations.at(-1) ?? 0,
      ...(latest
        ? {
            latest: {
              operationKind: latest.operationKind,
              transactionPosture: latest.transactionPosture,
              sessionPosture: latest.sessionPosture,
              outcome: latest.outcome,
              durationMs: latest.durationMs,
            },
          }
        : {}),
    };
  }

  private prune(now: number): void {
    const oldestAllowed = now - WINDOW_MS;
    while ((this.waits[0]?.observedAtMs ?? now) < oldestAllowed) {
      this.waits.shift();
    }
  }
}

export const __postgresStorageWaitMonitorInternals = {
  CRITICAL_WAIT_MS,
  SLOW_WAIT_MS,
  WINDOW_MS,
};
