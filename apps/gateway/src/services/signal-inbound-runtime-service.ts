import { logger } from "@goatcitadel/gateway-core";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  dispatchInboundWebhookMessage,
  getInboundBotLoopGuard,
  type IntegrationWebhookRouteLike,
} from "./channel-inbound-dispatch.js";
import type { ChannelBotLoopGuard } from "./channel-bot-loop-guard.js";

const log = logger.child("signal-inbound-runtime-service");

/**
 * Signal inbound poller (competitive-gap phase B1b).
 *
 * Signal is `bridge_dependent`: outbound sends already go through a local
 * signal-cli bridge (`POST {baseUrl}/api/v1/rpc`, JSON-RPC `send` — see
 * `signalSend` in packages/policy-engine/src/tool-executor.ts). Inbound is a
 * POLL loop against that same bridge rather than a public webhook, so no new
 * HTTP attack surface is opened.
 *
 * Tested bridge assumption: bbernhard/signal-cli-rest-api running in
 * `normal`/`native` (or json-rpc with receive fallback) mode, where
 * `GET {baseUrl}/v1/receive/{account}` drains and returns a JSON array of
 * envelope containers shaped like:
 *
 *   [{ "envelope": { "source": "+15551230000", "sourceNumber": "+15551230000",
 *        "sourceUuid": "…", "sourceName": "Alice", "timestamp": 1700000000000,
 *        "dataMessage": { "timestamp": 1700000000000, "message": "hi",
 *          "groupInfo": { "groupId": "…" } } }, "account": "+15559990000" }]
 *
 * The bridge base URL and account are reused from the same connection config
 * fields the outbound path reads (`baseUrl`/`bridgeUrl`, `accountId`/`account`).
 * Because the receive endpoint DRAINS the bridge queue, the in-memory dedupe
 * below only guards against bridges that re-serve envelopes; durable restart
 * dedupe additionally rides the ingest idempotency key.
 *
 * Every received message dispatches through `dispatchInboundWebhookMessage` —
 * the exact seam the Telegram/WhatsApp webhook routes use — so the default-deny
 * sender allowlist (`evaluateChannelInboundAccess`), the bot-loop guard, and
 * ingest idempotency apply IDENTICALLY to webhook channels.
 */

export const SIGNAL_INBOUND_DEFAULT_POLL_INTERVAL_SECONDS = 10;
export const SIGNAL_INBOUND_MIN_POLL_INTERVAL_SECONDS = 5;
export const SIGNAL_INBOUND_MAX_POLL_INTERVAL_SECONDS = 3_600;
/** Bridge-error backoff cap (~5 minutes). */
export const SIGNAL_INBOUND_MAX_BACKOFF_MS = 5 * 60_000;
/** Per-connection in-memory dedupe window (envelope keys). */
const MAX_TRACKED_ENVELOPE_KEYS = 2_048;

export type SignalInboundTimerHandle = unknown;

/** Injectable scheduler so tests never need real timers. */
export interface SignalInboundScheduler {
  schedule(callback: () => void, delayMs: number): SignalInboundTimerHandle;
  cancel(handle: SignalInboundTimerHandle): void;
}

const defaultScheduler: SignalInboundScheduler = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  cancel: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface SignalInboundBridgeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface SignalInboundRuntimeCallbacks {
  /** `signalInboundV1Enabled` feature flag. Checked on sync AND every tick. */
  isEnabled(): boolean;
  listConnections(): IntegrationConnection[];
  /**
   * Bridge fetch. Production wires the gateway's SSRF-guarded
   * `fetchWithDiagnosticsTimeout`, so the connection-config-supplied bridge URL
   * rides the same egress allowlist as outbound integration actions.
   */
  fetchBridge(url: string): Promise<SignalInboundBridgeResponse>;
  /** Same inbound seam webhook routes use — trust gate + loop guard + idempotency. */
  integrationWebhooks: IntegrationWebhookRouteLike;
  scheduler?: SignalInboundScheduler;
  loopGuard?: ChannelBotLoopGuard;
}

export interface SignalInboundSettings {
  baseUrl?: string;
  account?: string;
  inboundEnabled: boolean;
  pollIntervalSeconds: number;
}

export type SignalInboundEnvelope =
  | {
      kind: "message";
      actorId: string;
      sourceUuid?: string;
      displayName?: string;
      timestamp: number;
      content: string;
      groupId?: string;
    }
  | { kind: "ignored"; reason: string };

type PollerRecord = {
  connectionId: string;
  settings: SignalInboundSettings & { baseUrl: string; account: string };
  settingsKey: string;
  timer?: SignalInboundTimerHandle;
  backoffMs: number;
  stopped: boolean;
  seenKeys: Set<string>;
  seenOrder: string[];
};

export class SignalInboundRuntimeService {
  private readonly pollers = new Map<string, PollerRecord>();
  private readonly scheduler: SignalInboundScheduler;
  private closed = false;

  public constructor(private readonly callbacks: SignalInboundRuntimeCallbacks) {
    this.scheduler = callbacks.scheduler ?? defaultScheduler;
  }

  /**
   * Reconcile pollers with the current connection set. Called on gateway start
   * and whenever integration connections change. Flag off ⇒ everything stops
   * and nothing starts (byte-identical to the pre-flag runtime).
   */
  public sync(): void {
    if (this.closed) {
      return;
    }
    if (!this.callbacks.isEnabled()) {
      this.stopAllPollers();
      return;
    }
    const desired = new Map<string, PollerRecord["settings"]>();
    for (const connection of this.callbacks.listConnections()) {
      if (connection.kind !== "channel" || connection.key !== "signal") {
        continue;
      }
      // Mirror the webhook-route inbound kill switch: a disabled or
      // non-connected connection must not ingest inbound traffic.
      if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
        continue;
      }
      const settings = resolveSignalInboundSettings(connection.config);
      if (!settings.inboundEnabled) {
        continue;
      }
      if (!settings.baseUrl || !settings.account) {
        this.recordDiagnostic(
          "warn",
          "signal.inbound.misconfigured",
          "Signal inbound polling is enabled but unusable.",
          {
            connectionId: connection.connectionId,
            missing: !settings.baseUrl ? "baseUrl" : "accountId",
            hint: "Inbound polling needs both the bridge URL and the Signal account id (the receive endpoint is per-account).",
          },
        );
        continue;
      }
      desired.set(connection.connectionId, {
        ...settings,
        baseUrl: settings.baseUrl,
        account: settings.account,
      });
    }

    for (const [connectionId, poller] of [...this.pollers.entries()]) {
      const next = desired.get(connectionId);
      if (!next || buildSettingsKey(next) !== poller.settingsKey) {
        this.stopPoller(poller);
        this.pollers.delete(connectionId);
      }
    }

    for (const [connectionId, settings] of desired.entries()) {
      if (this.pollers.has(connectionId)) {
        continue;
      }
      const poller: PollerRecord = {
        connectionId,
        settings,
        settingsKey: buildSettingsKey(settings),
        backoffMs: 0,
        stopped: false,
        seenKeys: new Set(),
        seenOrder: [],
      };
      this.pollers.set(connectionId, poller);
      log.info("Signal inbound poller started.", {
        connectionId,
        pollIntervalSeconds: settings.pollIntervalSeconds,
      });
      this.scheduleNext(poller, settings.pollIntervalSeconds * 1_000);
    }
  }

  /** Halt all polling permanently (gateway shutdown). */
  public stop(): void {
    this.closed = true;
    this.stopAllPollers();
  }

  /** @internal exposed for tests */
  public get activePollerCount(): number {
    return this.pollers.size;
  }

  private stopAllPollers(): void {
    for (const poller of this.pollers.values()) {
      this.stopPoller(poller);
    }
    this.pollers.clear();
  }

  private stopPoller(poller: PollerRecord): void {
    poller.stopped = true;
    if (poller.timer !== undefined) {
      this.scheduler.cancel(poller.timer);
      poller.timer = undefined;
    }
  }

  private scheduleNext(poller: PollerRecord, delayMs: number): void {
    if (poller.stopped || this.closed) {
      return;
    }
    poller.timer = this.scheduler.schedule(() => {
      void this.runPollTick(poller);
    }, delayMs);
  }

  private async runPollTick(poller: PollerRecord): Promise<void> {
    if (poller.stopped || this.closed) {
      return;
    }
    if (!this.callbacks.isEnabled()) {
      // Kill switch flipped between ticks: halt immediately without waiting
      // for the next connection-change sync.
      this.stopPoller(poller);
      this.pollers.delete(poller.connectionId);
      return;
    }
    try {
      await this.pollOnce(poller);
      poller.backoffMs = 0;
      this.scheduleNext(poller, poller.settings.pollIntervalSeconds * 1_000);
    } catch (error) {
      poller.backoffMs = Math.min(
        poller.backoffMs > 0 ? poller.backoffMs * 2 : poller.settings.pollIntervalSeconds * 2_000,
        SIGNAL_INBOUND_MAX_BACKOFF_MS,
      );
      this.recordDiagnostic("warn", "signal.inbound.poll_failed", "Signal inbound poll against the bridge failed.", {
        connectionId: poller.connectionId,
        nextRetryMs: poller.backoffMs,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleNext(poller, poller.backoffMs);
    }
  }

  private async pollOnce(poller: PollerRecord): Promise<void> {
    const receiveUrl = `${poller.settings.baseUrl}/v1/receive/${encodeURIComponent(poller.settings.account)}`;
    const response = await this.callbacks.fetchBridge(receiveUrl);
    if (!response.ok) {
      throw new Error(`Signal bridge receive failed (${response.status})`);
    }
    const bodyText = await response.text();
    let parsed: unknown = [];
    if (bodyText.trim().length > 0) {
      try {
        parsed = JSON.parse(bodyText);
      } catch (error) {
        throw new Error("Signal bridge receive returned malformed JSON", { cause: error });
      }
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Signal bridge receive returned a non-array payload");
    }

    for (const entry of parsed) {
      const normalized = normalizeSignalInboundEnvelope(entry);
      if (normalized.kind === "ignored") {
        // Non-text envelopes (attachments, reactions, receipts, typing) are
        // intentionally out of scope for v1 — log and keep the loop alive.
        this.recordDiagnostic("info", "signal.inbound.envelope_ignored", "Ignored a non-text Signal envelope.", {
          connectionId: poller.connectionId,
          reason: normalized.reason,
        });
        continue;
      }
      const envelopeKey = `${normalized.actorId}:${normalized.timestamp}`;
      if (poller.seenKeys.has(envelopeKey)) {
        continue;
      }
      rememberEnvelopeKey(poller, envelopeKey);
      try {
        await this.dispatchEnvelope(poller, normalized);
      } catch (error) {
        // A single bad dispatch must never take down the poll loop.
        this.recordDiagnostic("warn", "signal.inbound.dispatch_failed", "Signal inbound dispatch failed.", {
          connectionId: poller.connectionId,
          actorId: normalized.actorId,
          envelopeTimestamp: normalized.timestamp,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async dispatchEnvelope(
    poller: PollerRecord,
    envelope: Extract<SignalInboundEnvelope, { kind: "message" }>,
  ): Promise<void> {
    // Refetch the connection so the trust gate always evaluates the CURRENT
    // config (allowlist edits apply without a poller restart) and so a
    // just-disabled connection stops ingesting mid-interval.
    const connection = this.callbacks.integrationWebhooks.getIntegrationConnection(poller.connectionId);
    if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
      return;
    }
    const room = envelope.groupId ? `group:${envelope.groupId}` : undefined;
    const bindingTarget = room ?? envelope.actorId;
    await dispatchInboundWebhookMessage(
      this.callbacks.integrationWebhooks,
      {
        channel: "signal",
        connectionId: poller.connectionId,
        // Durable dedupe across restarts rides the ingest idempotency key —
        // the same mechanism webhook channels use for provider retries.
        idempotencyKey: `signal:${poller.connectionId}:${envelope.actorId}:${envelope.timestamp}`,
        eventType: "message",
        bindingTarget,
        inboundAccessConfig: connection.config,
        message: {
          eventId: `signal:${envelope.actorId}:${envelope.timestamp}`,
          account: poller.settings.account,
          peer: room ? undefined : envelope.actorId,
          room,
          actorId: envelope.actorId,
          actorType: "user",
          displayName: envelope.displayName,
          content: envelope.content,
          metadata: compactMetadata({
            sourceUuid: envelope.sourceUuid,
            envelopeTimestamp: envelope.timestamp,
            groupId: envelope.groupId,
            transport: "poll",
          }),
        },
      },
      this.callbacks.loopGuard ?? getInboundBotLoopGuard(),
    );
  }

  private recordDiagnostic(
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    context: Record<string, unknown>,
  ): void {
    this.callbacks.integrationWebhooks.recordDevDiagnostic?.({
      level,
      category: "channels",
      event,
      message,
      context,
    });
  }
}

/** Resolve poll settings from a Signal connection config (outbound field reuse). */
export function resolveSignalInboundSettings(config: Record<string, unknown>): SignalInboundSettings {
  return {
    baseUrl: normalizeSignalBridgeBaseUrl(readString(config, "baseUrl") ?? readString(config, "bridgeUrl")),
    account: readString(config, "accountId") ?? readString(config, "account"),
    inboundEnabled: readBoolean(config, "inboundEnabled") === true,
    pollIntervalSeconds: clampPollIntervalSeconds(config.pollIntervalSeconds),
  };
}

/**
 * Normalize one entry of the bridge receive payload. Accepts both the
 * signal-cli-rest-api container shape (`{ envelope: {…}, account }`) and a
 * bare envelope object. Anything without a plain-text dataMessage is ignored.
 */
export function normalizeSignalInboundEnvelope(entry: unknown): SignalInboundEnvelope {
  const container = asRecord(entry);
  const envelope = asRecord(container.envelope ?? container);
  const actorId = asString(envelope.sourceNumber) ?? asString(envelope.source) ?? asString(envelope.sourceUuid);
  if (!actorId) {
    return { kind: "ignored", reason: "missing_sender" };
  }
  const dataMessage = asRecord(envelope.dataMessage);
  if (Object.keys(dataMessage).length === 0) {
    // Receipts, typing indicators, sync messages, etc.
    return { kind: "ignored", reason: "no_data_message" };
  }
  const content = asString(dataMessage.message);
  if (!content) {
    // Attachment-only, reaction, sticker, or remote-delete payloads — v1
    // handles plain text only.
    return { kind: "ignored", reason: "non_text_message" };
  }
  const timestamp = asFiniteNumber(dataMessage.timestamp) ?? asFiniteNumber(envelope.timestamp);
  if (timestamp === undefined) {
    return { kind: "ignored", reason: "missing_timestamp" };
  }
  const groupInfo = asRecord(dataMessage.groupInfo);
  return {
    kind: "message",
    actorId,
    sourceUuid: asString(envelope.sourceUuid),
    displayName: asString(envelope.sourceName),
    timestamp,
    content,
    groupId: asString(groupInfo.groupId),
  };
}

export function clampPollIntervalSeconds(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) {
    return SIGNAL_INBOUND_DEFAULT_POLL_INTERVAL_SECONDS;
  }
  const rounded = Math.round(parsed);
  return Math.min(
    Math.max(rounded, SIGNAL_INBOUND_MIN_POLL_INTERVAL_SECONDS),
    SIGNAL_INBOUND_MAX_POLL_INTERVAL_SECONDS,
  );
}

function normalizeSignalBridgeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function buildSettingsKey(settings: SignalInboundSettings): string {
  return `${settings.baseUrl}|${settings.account}|${settings.pollIntervalSeconds}`;
}

function rememberEnvelopeKey(poller: PollerRecord, key: string): void {
  poller.seenKeys.add(key);
  poller.seenOrder.push(key);
  while (poller.seenOrder.length > MAX_TRACKED_ENVELOPE_KEYS) {
    const oldest = poller.seenOrder.shift();
    if (oldest !== undefined) {
      poller.seenKeys.delete(oldest);
    }
  }
}

function compactMetadata(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  return asString(config[key]);
}

function readBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
