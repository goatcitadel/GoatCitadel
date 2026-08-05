import { randomUUID } from "node:crypto";

export type SharedHostLifecycleState = "starting" | "accepting" | "draining" | "quiesced" | "closing" | "closed";

export type SharedHostWorkKind = "api" | "agent" | "worker" | "cron";
export type SharedHostDrainMode = "pause" | "force";

export const SHARED_HOST_DRAIN_ENABLED_ENV = "GOATCITADEL_SHARED_HOST_DRAIN_ENABLED";
export const SHARED_HOST_DRAIN_TIMEOUT_MS_ENV = "GOATCITADEL_SHARED_HOST_DRAIN_TIMEOUT_MS";
export const DEFAULT_SHARED_HOST_DRAIN_TIMEOUT_MS = 30_000;
export const MIN_SHARED_HOST_DRAIN_TIMEOUT_MS = 10;
export const MAX_SHARED_HOST_DRAIN_TIMEOUT_MS = 300_000;

export interface SharedHostLifecycleSnapshot {
  version: "shared_host.lifecycle.v1";
  enabled: boolean;
  mode: "local_always_available" | "shared_host";
  state: SharedHostLifecycleState;
  admission: "open" | "closed";
  readiness: "starting" | "ready" | "degraded" | "draining" | "quiesced" | "closing" | "closed";
  activeCount: number;
  activeByKind: Record<SharedHostWorkKind, number>;
  drain?: {
    mode: SharedHostDrainMode;
    reason: string;
    actorId: string;
    initiatedAt: string;
    deadlineAt: string;
    timedOut: boolean;
    forcedOutstandingCount: number;
  };
  evidence: {
    state: "pending" | "healthy" | "degraded";
    pendingCount: number;
    failedCount: number;
    lastFailureAt?: string;
    lastFailure?: string;
  };
  lastTransitionAt: string;
}

export interface SharedHostLifecycleEvent {
  eventId: string;
  eventType: "shared_host.lifecycle.transition" | "shared_host.lifecycle.drain_timeout";
  occurredAt: string;
  from: SharedHostLifecycleState;
  to: SharedHostLifecycleState;
  snapshot: SharedHostLifecycleSnapshot;
}

export interface SharedHostWorkReservation {
  readonly reservationId: string;
  readonly kind: SharedHostWorkKind;
  readonly admittedAt: string;
  readonly signal: AbortSignal;
  release(): void;
}

export type SharedHostAdmissionResult =
  | { admitted: true; reservation: SharedHostWorkReservation }
  | { admitted: false; state: SharedHostLifecycleState; retryable: boolean; reason: string };

export interface SharedHostDrainRequest {
  mode: SharedHostDrainMode;
  timeoutMs?: number;
  reason: string;
  actorId: string;
}

export interface SharedHostDrainResult {
  outcome: "quiesced" | "timed_out" | "closing" | "already_closed";
  snapshot: SharedHostLifecycleSnapshot;
}

export interface SharedHostLifecycleAdmissionPort {
  tryReserve(kind: SharedHostWorkKind, reservationId?: string): SharedHostAdmissionResult;
  snapshot(): SharedHostLifecycleSnapshot;
}

export class SharedHostDrainDisabledError extends Error {
  public readonly code = "SHARED_HOST_DRAIN_DISABLED";

  public constructor() {
    super(
      `Shared-host drain is disabled. Set ${SHARED_HOST_DRAIN_ENABLED_ENV}=true to opt in; local mode remains always available.`,
    );
    this.name = "SharedHostDrainDisabledError";
  }
}

export class SharedHostAdmissionClosedError extends Error {
  public readonly code = "SHARED_HOST_ADMISSION_CLOSED";

  public constructor(
    public readonly lifecycleState: SharedHostLifecycleState,
    message: string,
  ) {
    super(message);
    this.name = "SharedHostAdmissionClosedError";
  }
}

interface ActiveReservation {
  reservationId: string;
  kind: SharedHostWorkKind;
  admittedAt: string;
  controller: AbortController;
}

export interface SharedHostLifecycleOptions {
  enabled: boolean;
  now?: () => Date;
  onEvent?: (event: SharedHostLifecycleEvent) => void | Promise<void>;
}

interface FailedLifecycleSignal {
  event: SharedHostLifecycleEvent;
  error: unknown;
  failedAt: string;
}

const EMPTY_ACTIVE_BY_KIND: Record<SharedHostWorkKind, number> = {
  api: 0,
  agent: 0,
  worker: 0,
  cron: 0,
};

export class SharedHostLifecycleService implements SharedHostLifecycleAdmissionPort {
  private state: SharedHostLifecycleState = "starting";
  private readonly active = new Map<string, ActiveReservation>();
  private readonly quiescenceWaiters = new Set<() => void>();
  private readonly pendingSignals = new Set<Promise<void>>();
  private readonly failedSignals = new Map<string, FailedLifecycleSignal>();
  private readonly now: () => Date;
  private readonly onEvent?: SharedHostLifecycleOptions["onEvent"];
  private lastTransitionAt: string;
  private drainState: SharedHostLifecycleSnapshot["drain"];

  public constructor(private readonly options: SharedHostLifecycleOptions) {
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
    this.lastTransitionAt = this.timestamp();
  }

  public get enabled(): boolean {
    return this.options.enabled;
  }

  public markAccepting(): SharedHostLifecycleSnapshot {
    if (this.state === "accepting") return this.snapshot();
    this.transition("accepting");
    return this.snapshot();
  }

  /**
   * Truthful cleanup for a build that fails before the host ever opens
   * admission. This is the only exceptional starting -> closing branch.
   */
  public abortStartup(): SharedHostLifecycleSnapshot {
    if (this.state === "closed") return this.snapshot();
    if (this.state !== "starting") {
      throw new Error(`Cannot abort shared-host startup after lifecycle reached ${this.state}.`);
    }
    this.transition("closing");
    return this.snapshot();
  }

  public tryReserve(kind: SharedHostWorkKind, reservationId: string = randomUUID()): SharedHostAdmissionResult {
    if (!this.options.enabled) {
      return { admitted: true, reservation: createNoopReservation(kind, reservationId, this.timestamp()) };
    }
    if (this.state !== "accepting") {
      return {
        admitted: false,
        state: this.state,
        retryable: this.state === "draining" || this.state === "quiesced",
        reason: `Shared-host admission is closed while the gateway is ${this.state}.`,
      };
    }
    if (this.active.has(reservationId)) {
      throw new Error(`Shared-host reservation id is already active: ${reservationId}`);
    }
    const active: ActiveReservation = {
      reservationId,
      kind,
      admittedAt: this.timestamp(),
      controller: new AbortController(),
    };
    this.active.set(reservationId, active);
    let released = false;
    return {
      admitted: true,
      reservation: {
        reservationId,
        kind,
        admittedAt: active.admittedAt,
        signal: active.controller.signal,
        release: () => {
          if (released) return;
          released = true;
          this.releaseReservation(reservationId);
        },
      },
    };
  }

  public async drain(input: SharedHostDrainRequest): Promise<SharedHostDrainResult> {
    if (!this.options.enabled) throw new SharedHostDrainDisabledError();
    if (this.state === "closed") return { outcome: "already_closed", snapshot: this.snapshot() };
    if (this.state === "starting") {
      throw new Error("Shared-host drain cannot begin before admission reaches accepting state.");
    }
    if (this.state === "accepting") {
      const initiatedAt = this.timestamp();
      const timeoutMs = normalizeSharedHostDrainTimeoutMs(input.timeoutMs);
      this.drainState = {
        mode: input.mode,
        reason: normalizeRequired(input.reason, "reason"),
        actorId: normalizeRequired(input.actorId, "actorId"),
        initiatedAt,
        deadlineAt: new Date(Date.parse(initiatedAt) + timeoutMs).toISOString(),
        timedOut: false,
        forcedOutstandingCount: 0,
      };
      this.transition("draining");
    } else if (this.drainState && input.mode === "force") {
      this.drainState = { ...this.drainState, mode: "force" };
    }

    if (this.state === "quiesced") {
      if (input.mode === "force") {
        this.transition("closing");
        await this.flushSignals();
        return { outcome: "closing", snapshot: this.snapshot() };
      }
      await this.flushSignals();
      return { outcome: "quiesced", snapshot: this.snapshot() };
    }
    if (this.state === "closing") {
      await this.flushSignals();
      return { outcome: "closing", snapshot: this.snapshot() };
    }

    const deadlineAt = Date.parse(this.drainState?.deadlineAt ?? this.timestamp());
    const drained = this.active.size === 0 || (await this.waitForZero(Math.max(0, deadlineAt - this.now().getTime())));
    if (drained) {
      this.ensureQuiescedAfterDrain();
      if (input.mode === "force") this.transition("closing");
      await this.flushSignals();
      return { outcome: input.mode === "force" ? "closing" : "quiesced", snapshot: this.snapshot() };
    }

    this.drainState = {
      ...this.drainState!,
      timedOut: true,
      forcedOutstandingCount: input.mode === "force" ? this.active.size : 0,
    };
    this.emitEvent("shared_host.lifecycle.drain_timeout", this.state, this.state);
    if (input.mode === "force") {
      const reason = new Error("Shared-host force drain timed out; admitted work must stop and recover durably.");
      // Commit the terminal lifecycle edge before broadcasting cancellation.
      // Abort listeners may release synchronously; they must never be able to
      // insert a quiesced transition into the force-timeout path.
      this.transition("closing");
      for (const reservation of this.active.values()) {
        if (!reservation.controller.signal.aborted) reservation.controller.abort(reason);
      }
      await this.flushSignals();
      return { outcome: "closing", snapshot: this.snapshot() };
    }
    await this.flushSignals();
    return { outcome: "timed_out", snapshot: this.snapshot() };
  }

  public markClosing(): SharedHostLifecycleSnapshot {
    if (this.state === "closed" || this.state === "closing") return this.snapshot();
    if (this.state === "starting") {
      this.transition("closing");
      return this.snapshot();
    }
    if (this.active.size > 0 && !(this.drainState?.timedOut && this.drainState.forcedOutstandingCount > 0)) {
      throw new Error("Cannot mark the shared host closing while admitted work is active; use bounded force drain.");
    }
    if (this.state === "accepting") {
      this.drainState = {
        mode: "force",
        reason: "gateway_close",
        actorId: "gateway",
        initiatedAt: this.timestamp(),
        deadlineAt: this.timestamp(),
        timedOut: this.active.size > 0,
        forcedOutstandingCount: this.active.size,
      };
      this.transition("draining");
    }
    if (this.state === "draining") {
      if (this.active.size === 0) {
        this.transition("quiesced");
      } else if (this.drainState?.mode === "force" && this.drainState.timedOut) {
        this.transition("closing");
      } else {
        throw new Error("Cannot mark the shared host closing from draining while admitted work is active.");
      }
    }
    if (this.state === "quiesced") this.transition("closing");
    return this.snapshot();
  }

  public markClosed(): SharedHostLifecycleSnapshot {
    if (this.state === "closed") return this.snapshot();
    this.markClosing();
    this.transition("closed");
    return this.snapshot();
  }

  public snapshot(): SharedHostLifecycleSnapshot {
    const activeByKind = { ...EMPTY_ACTIVE_BY_KIND };
    for (const reservation of this.active.values()) activeByKind[reservation.kind] += 1;
    return {
      version: "shared_host.lifecycle.v1",
      enabled: this.options.enabled,
      mode: this.options.enabled ? "shared_host" : "local_always_available",
      state: this.state,
      admission: !this.options.enabled || this.state === "accepting" ? "open" : "closed",
      readiness: lifecycleReadiness(this.state, this.pendingSignals.size, this.failedSignals.size),
      activeCount: this.active.size,
      activeByKind,
      ...(this.drainState ? { drain: { ...this.drainState } } : {}),
      evidence: this.evidenceSnapshot(),
      lastTransitionAt: this.lastTransitionAt,
    };
  }

  public async flushSignals(): Promise<void> {
    if (this.pendingSignals.size > 0) await Promise.all([...this.pendingSignals]);
    if (this.failedSignals.size > 0) {
      throw new AggregateError(
        [...this.failedSignals.values()].map((failure) => failure.error),
        "One or more shared-host lifecycle evidence signals failed.",
      );
    }
  }

  /** Retry only failed evidence deliveries, preserving their stable event ids. */
  public async replayFailedSignals(): Promise<void> {
    if (!this.onEvent || this.failedSignals.size === 0) return;
    const failures = [...this.failedSignals.values()];
    await Promise.all(
      failures.map(async ({ event }) => {
        try {
          await this.onEvent?.(event);
          this.failedSignals.delete(event.eventId);
        } catch (error) {
          this.failedSignals.set(event.eventId, { event, error, failedAt: this.timestamp() });
        }
      }),
    );
    await this.flushSignals();
  }

  private releaseReservation(reservationId: string): void {
    if (!this.active.delete(reservationId)) return;
    if (this.active.size === 0) {
      for (const resolve of this.quiescenceWaiters) resolve();
      this.quiescenceWaiters.clear();
      if (this.state === "draining") this.transition("quiesced");
    }
  }

  private ensureQuiescedAfterDrain(): void {
    if (this.state === "draining") {
      this.transition("quiesced");
      return;
    }
    if (this.state !== "quiesced") throw new Error(`Unexpected shared-host drain state: ${this.state}`);
  }

  private waitForZero(timeoutMs: number): Promise<boolean> {
    if (this.active.size === 0) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.quiescenceWaiters.delete(onZero);
        resolve(value);
      };
      const onZero = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.quiescenceWaiters.add(onZero);
    });
  }

  private transition(next: SharedHostLifecycleState): void {
    if (this.state === next) return;
    if (next === "quiesced" && this.active.size !== 0) {
      throw new Error(`Shared-host lifecycle cannot enter quiesced with ${this.active.size} active reservations.`);
    }
    assertTransition(this.state, next);
    const previous = this.state;
    this.state = next;
    this.lastTransitionAt = this.timestamp();
    this.emitEvent("shared_host.lifecycle.transition", previous, next);
  }

  private emitEvent(
    eventType: SharedHostLifecycleEvent["eventType"],
    from: SharedHostLifecycleState,
    to: SharedHostLifecycleState,
  ): void {
    // Local-disabled mode is intentionally always available and must not gain
    // a startup dependency on shared-host evidence infrastructure.
    if (!this.options.enabled || !this.onEvent) return;
    const occurredAt = this.timestamp();
    const event = { eventId: randomUUID(), eventType, occurredAt, from, to, snapshot: this.snapshot() };
    const signal = Promise.resolve()
      .then(() => this.onEvent?.(event))
      .then(() => {
        this.failedSignals.delete(event.eventId);
      })
      .catch((error: unknown) => {
        this.failedSignals.set(event.eventId, { event, error, failedAt: this.timestamp() });
      });
    this.pendingSignals.add(signal);
    void signal.then(
      () => this.pendingSignals.delete(signal),
      () => this.pendingSignals.delete(signal),
    );
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private evidenceSnapshot(): SharedHostLifecycleSnapshot["evidence"] {
    const latestFailure = [...this.failedSignals.values()].sort((left, right) =>
      right.failedAt.localeCompare(left.failedAt),
    )[0];
    return {
      state: this.failedSignals.size > 0 ? "degraded" : this.pendingSignals.size > 0 ? "pending" : "healthy",
      pendingCount: this.pendingSignals.size,
      failedCount: this.failedSignals.size,
      ...(latestFailure
        ? {
            lastFailureAt: latestFailure.failedAt,
            lastFailure: normalizeFailureMessage(latestFailure.error),
          }
        : {}),
    };
  }
}

export function resolveSharedHostLifecycleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env[SHARED_HOST_DRAIN_ENABLED_ENV]?.trim() ?? "");
}

export function resolveSharedHostDrainTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SHARED_HOST_DRAIN_TIMEOUT_MS_ENV]?.trim();
  return normalizeSharedHostDrainTimeoutMs(raw ? Number(raw) : undefined);
}

export function normalizeSharedHostDrainTimeoutMs(value?: number): number {
  const normalized = value ?? DEFAULT_SHARED_HOST_DRAIN_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < MIN_SHARED_HOST_DRAIN_TIMEOUT_MS ||
    normalized > MAX_SHARED_HOST_DRAIN_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be an integer from ${MIN_SHARED_HOST_DRAIN_TIMEOUT_MS} through ${MAX_SHARED_HOST_DRAIN_TIMEOUT_MS}.`,
    );
  }
  return normalized;
}

function createNoopReservation(
  kind: SharedHostWorkKind,
  reservationId: string,
  admittedAt: string,
): SharedHostWorkReservation {
  return {
    reservationId,
    kind,
    admittedAt,
    signal: new AbortController().signal,
    release: () => undefined,
  };
}

function lifecycleReadiness(
  state: SharedHostLifecycleState,
  pendingSignalCount: number,
  failedSignalCount: number,
): SharedHostLifecycleSnapshot["readiness"] {
  if (state === "accepting") {
    if (failedSignalCount > 0) return "degraded";
    if (pendingSignalCount > 0) return "starting";
    return "ready";
  }
  return state;
}

function assertTransition(from: SharedHostLifecycleState, to: SharedHostLifecycleState): void {
  const allowed: Record<SharedHostLifecycleState, readonly SharedHostLifecycleState[]> = {
    starting: ["accepting", "closing"],
    accepting: ["draining"],
    draining: ["quiesced", "closing"],
    quiesced: ["closing"],
    closing: ["closed"],
    closed: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`Invalid shared-host lifecycle transition: ${from} -> ${to}`);
}

function normalizeFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}
