import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { IngestChannelMessageInput } from "./channel-inbound-dispatch.js";

/**
 * Generic persistent inbound stream runtime for channels that deliver events
 * over a long-lived connection (SSE, JSON lines, WebSocket) instead of a
 * webhook. Adapters own the wire protocol; this service owns lifecycle:
 * one runner per opted-in connection, backoff reconnects, restart on
 * connection revision change, and operator-visible status.
 */

export interface ChannelStreamEvent {
  /** Deterministic: `${channelKey}:${connectionId}:${providerEventId}` — never arrival time or a body hash with volatile fields. */
  idempotencyKey: string;
  eventType: string;
  bindingTarget?: string;
  message: IngestChannelMessageInput;
}

export interface ChannelStreamRunContext {
  connection: IntegrationConnection;
  signal: AbortSignal;
  /** Last provider cursor this process saw for the connection (in memory; undefined after restart). */
  readonly cursor: string | undefined;
  markReady(): void;
  /** Resolves only after durable acceptance (or a gate drop); the cursor advances only after this resolves. */
  emit(event: ChannelStreamEvent, cursor?: string): Promise<void>;
  diagnostic(event: string, message: string, context?: Record<string, unknown>): void;
}

/** 401/403: stop retrying until the next sync() sees a new connection revision. */
export class ChannelStreamAuthError extends Error {}

export interface ChannelStreamAdapter {
  channelKey: string;
  /** True only when the connection opted into inbound and has what the stream needs. */
  isInboundEnabled(connection: IntegrationConnection): boolean;
  /** Runs one stream session; resolves when the server ends it, rejects on error. Must honor ctx.signal. */
  run(ctx: ChannelStreamRunContext): Promise<void>;
}

export interface ChannelStreamRuntimeStatus {
  connectionId: string;
  channelKey: string;
  ready: boolean;
  lastReadyAt?: string;
  lastInboundAt?: string;
  lastReconnectAt?: string;
  lastError?: string;
  stoppedReason?: "auth_failed" | "disabled" | "closed";
}

export interface ChannelStreamRuntimeDeps {
  listConnections(): Promise<IntegrationConnection[]>;
  adapters: readonly ChannelStreamAdapter[];
  dispatch(connection: IntegrationConnection, event: ChannelStreamEvent): Promise<unknown>;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  backoff?: { initialMs: number; maxMs: number };
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
}

interface Runner {
  revisionKey: string;
  controller: AbortController;
  task: Promise<void>;
  stopped: boolean;
}

const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 60_000 };
const MAX_ERROR_LENGTH = 300;

function revisionKeyOf(connection: IntegrationConnection): string {
  return `${connection.updatedAt}:${connection.revision ?? ""}`;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ChannelStreamRuntimeService {
  private readonly listConnections: ChannelStreamRuntimeDeps["listConnections"];
  private readonly adapters: readonly ChannelStreamAdapter[];
  private readonly dispatch: ChannelStreamRuntimeDeps["dispatch"];
  private readonly recordDiagnostic: ChannelStreamRuntimeDeps["recordDevDiagnostic"];
  private readonly backoff: { initialMs: number; maxMs: number };
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => Date;
  private readonly runners = new Map<string, Runner>();
  private readonly statuses = new Map<string, ChannelStreamRuntimeStatus>();
  /** Superseded or removed runners whose sessions may still be settling. */
  private readonly retiring = new Set<Promise<void>>();
  private syncChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(deps: ChannelStreamRuntimeDeps) {
    this.listConnections = deps.listConnections;
    this.adapters = deps.adapters;
    this.dispatch = deps.dispatch;
    this.recordDiagnostic = deps.recordDevDiagnostic;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.sleep = deps.sleep ?? abortableSleep;
    this.now = deps.now ?? (() => new Date());
  }

  get activeRunnerCount(): number {
    let count = 0;
    for (const runner of this.runners.values()) {
      if (!runner.stopped) count += 1;
    }
    return count;
  }

  getStatus(connectionId: string): ChannelStreamRuntimeStatus | undefined {
    const status = this.statuses.get(connectionId);
    return status ? { ...status } : undefined;
  }

  sync(): Promise<void> {
    const next = this.syncChain.then(() => this.syncNow());
    this.syncChain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.syncChain;
    const runners = [...this.runners.entries()];
    for (const [connectionId, runner] of runners) {
      runner.controller.abort();
      this.markStopped(connectionId, "closed");
    }
    await Promise.allSettled([...runners.map(([, runner]) => runner.task), ...this.retiring]);
    this.runners.clear();
  }

  private async syncNow(): Promise<void> {
    if (this.closed) return;
    let connections: IntegrationConnection[];
    try {
      connections = await this.listConnections();
    } catch (error) {
      this.safeDiagnostic({
        level: "warn",
        category: "channels",
        event: "stream.sync_failed",
        message: `Channel stream sync could not list connections: ${describeError(error)}`,
      });
      return;
    }
    if (this.closed) return;

    const wanted = new Map<string, { connection: IntegrationConnection; adapter: ChannelStreamAdapter }>();
    for (const connection of connections) {
      const adapter = this.adapters.find((candidate) => candidate.channelKey === connection.key);
      if (!adapter || !connection.enabled || connection.status !== "connected") continue;
      let optedIn = false;
      try {
        optedIn = adapter.isInboundEnabled(connection);
      } catch (error) {
        this.safeDiagnostic({
          level: "warn",
          category: "channels",
          event: `${adapter.channelKey}.stream.config_check_failed`,
          message: `Channel stream inbound check failed: ${describeError(error)}`,
          context: { connectionId: connection.connectionId },
        });
      }
      if (optedIn) {
        wanted.set(connection.connectionId, { connection, adapter });
      }
    }

    const superseded = new Map<string, Runner>();
    for (const [connectionId, runner] of [...this.runners.entries()]) {
      const target = wanted.get(connectionId);
      if (target && runner.revisionKey === revisionKeyOf(target.connection)) {
        continue;
      }
      runner.controller.abort();
      this.runners.delete(connectionId);
      this.retire(runner);
      superseded.set(connectionId, runner);
      if (!target) {
        this.markStopped(connectionId, "disabled");
      }
    }

    for (const [connectionId, { connection, adapter }] of wanted) {
      if (!this.runners.has(connectionId)) {
        this.startRunner(connection, adapter, superseded.get(connectionId));
      }
    }
  }

  private startRunner(connection: IntegrationConnection, adapter: ChannelStreamAdapter, previous?: Runner): void {
    const controller = new AbortController();
    const runner: Runner = {
      revisionKey: revisionKeyOf(connection),
      controller,
      stopped: false,
      task: Promise.resolve(),
    };
    this.statuses.set(connection.connectionId, {
      connectionId: connection.connectionId,
      channelKey: adapter.channelKey,
      ready: false,
    });
    this.runners.set(connection.connectionId, runner);
    // Never overlap two sessions for one connection: wait for the superseded session to settle first.
    const gate = previous ? previous.task : Promise.resolve();
    runner.task = gate.then(() => this.runLoop(connection, adapter, runner)).catch(() => undefined);
  }

  private retire(runner: Runner): void {
    const settled = runner.task.then(
      () => undefined,
      () => undefined,
    );
    this.retiring.add(settled);
    void settled.then(() => this.retiring.delete(settled));
  }

  private safeDiagnostic(input: Parameters<ChannelStreamRuntimeDeps["recordDevDiagnostic"]>[0]): void {
    try {
      this.recordDiagnostic(input);
    } catch {
      // Diagnostics must never break the runtime.
    }
  }

  private async runLoop(
    connection: IntegrationConnection,
    adapter: ChannelStreamAdapter,
    runner: Runner,
  ): Promise<void> {
    const { controller } = runner;
    const { connectionId } = connection;
    const channelKey = adapter.channelKey;
    let failures = 0;
    let cursor: string | undefined;
    const update = (patch: Partial<ChannelStreamRuntimeStatus>) => {
      if (this.runners.get(connectionId) !== runner && !this.closed) return;
      const current = this.statuses.get(connectionId);
      if (current) this.statuses.set(connectionId, { ...current, ...patch });
    };
    const diagnostic = (
      level: "info" | "warn" | "error",
      event: string,
      message: string,
      context?: Record<string, unknown>,
    ) => {
      this.safeDiagnostic({
        level,
        category: "channels",
        event: `${channelKey}.stream.${event}`,
        message,
        context: { connectionId, ...context },
      });
    };
    const ctx: ChannelStreamRunContext = {
      connection,
      signal: controller.signal,
      get cursor() {
        return cursor;
      },
      markReady: () => {
        if (controller.signal.aborted) return;
        update({ ready: true, lastReadyAt: this.now().toISOString() });
        diagnostic("info", "connected", "Channel stream connected.");
      },
      emit: async (event, nextCursor) => {
        if (controller.signal.aborted) {
          throw new Error("Channel stream session is closed.");
        }
        try {
          await this.dispatch(connection, event);
        } catch (error) {
          update({ lastError: describeError(error) });
          throw error;
        }
        if (nextCursor !== undefined) cursor = nextCursor;
        failures = 0;
        update({ lastInboundAt: this.now().toISOString() });
      },
      diagnostic: (event, message, context) => {
        diagnostic("info", event, message, context);
      },
    };

    while (!controller.signal.aborted) {
      try {
        await adapter.run(ctx);
        failures += 1;
      } catch (error) {
        if (controller.signal.aborted) break;
        if (error instanceof ChannelStreamAuthError) {
          runner.stopped = true;
          update({ ready: false, lastError: describeError(error), stoppedReason: "auth_failed" });
          diagnostic("error", "auth_failed", `Channel stream authentication failed: ${describeError(error)}`);
          return;
        }
        failures += 1;
        update({ lastError: describeError(error) });
      }
      if (controller.signal.aborted) break;
      update({ ready: false });
      const delay = Math.min(this.backoff.initialMs * 2 ** Math.max(0, failures - 1), this.backoff.maxMs);
      diagnostic("warn", "reconnecting", `Channel stream ended; reconnecting in ${delay}ms.`, { delayMs: delay });
      await this.sleep(delay, controller.signal).catch(() => undefined);
      update({ lastReconnectAt: this.now().toISOString() });
    }
    runner.stopped = true;
    diagnostic("info", "stopped", "Channel stream stopped.");
  }

  private markStopped(connectionId: string, reason: "disabled" | "closed"): void {
    const current = this.statuses.get(connectionId);
    if (current) {
      this.statuses.set(connectionId, { ...current, ready: false, stoppedReason: reason });
    }
  }
}
