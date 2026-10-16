import type { IntegrationConnection } from "@goatcitadel/contracts";
import { isExplicitTrue } from "@goatcitadel/gateway-core";
import {
  ChannelStreamAuthError,
  type ChannelStreamAdapter,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";
import { readServerSentEvents } from "./stream-line-reader.js";

/**
 * Signal inbound over the signal-cli HTTP daemon event stream
 * (`signal-cli daemon --http`, `GET {baseUrl}/api/v1/events`, Server-Sent Events).
 *
 * Each SSE `data` is a JSON-RPC `receive` notification carrying one envelope.
 * signal-cli acknowledges messages to the Signal server itself and does not
 * replay events to a subscriber that was not connected: messages that arrive
 * while this stream is down are lost upstream. The source+timestamp key only
 * dedupes a redelivered envelope.
 */

export interface SignalStreamAdapterDeps {
  /** Plain fetch with the session signal; the stream is long-lived, so no request timeout. */
  fetch: typeof fetch;
  isUrlAllowlisted(url: string): boolean;
}

type JsonRecord = Record<string, unknown>;

function readString(config: JsonRecord, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function baseUrlOf(config: JsonRecord): string | undefined {
  return readString(config, "baseUrl") ?? readString(config, "bridgeUrl");
}

function accountOf(config: JsonRecord): string | undefined {
  return readString(config, "accountId") ?? readString(config, "account");
}

function buildEventsUrl(baseUrl: string, account: string | undefined): string {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/events`;
  return account ? `${url}?account=${encodeURIComponent(account)}` : url;
}

/** Accepts the JSON-RPC notification shape; a bare `{ envelope }` payload is treated the same. */
function receivePayloadOf(data: unknown): JsonRecord | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  if (record.method !== undefined) {
    return record.method === "receive" ? asRecord(record.params) : undefined;
  }
  return record;
}

export function createSignalStreamAdapter(deps: SignalStreamAdapterDeps): ChannelStreamAdapter {
  async function handleReceive(ctx: ChannelStreamRunContext, payload: JsonRecord): Promise<void> {
    const envelope = asRecord(payload.envelope);
    if (!envelope) return;
    // syncMessage is our own sent message echoed back; receipts and typing carry no text.
    if (envelope.syncMessage || envelope.receiptMessage || envelope.typingMessage) return;
    const dataMessage = asRecord(envelope.dataMessage);
    const content = typeof dataMessage?.message === "string" ? dataMessage.message : "";
    if (!dataMessage || content.trim().length === 0) return;

    const sourceNumber = str(envelope.sourceNumber);
    const sourceUuid = str(envelope.sourceUuid);
    const source = sourceUuid ?? sourceNumber ?? str(envelope.source);
    const rawTimestamp = dataMessage.timestamp ?? envelope.timestamp;
    const timestamp = typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) ? rawTimestamp : undefined;
    if (!source || timestamp === undefined) return;

    const ownAccounts = [accountOf(ctx.connection.config), str(payload.account)].filter(Boolean);
    if (ownAccounts.some((own) => own === sourceNumber || own === sourceUuid || own === source)) return;

    const groupId = str(asRecord(dataMessage.groupInfo)?.groupId);
    const connectionId = ctx.connection.connectionId;
    const room = groupId ? `group:${groupId}` : undefined;
    await ctx.emit({
      idempotencyKey: `signal:${connectionId}:${source}:${timestamp}`,
      eventType: "signal-receive",
      bindingTarget: room ?? source,
      message: {
        eventId: `${source}:${timestamp}`,
        account: connectionId,
        actorId: source,
        actorType: "user",
        displayName: str(envelope.sourceName),
        content,
        room,
        peer: groupId ? undefined : source,
        // timestamp identifies the message for later react/unsend calls.
        metadata: { sourceNumber, sourceUuid, timestamp, groupId },
      },
    });
  }

  return {
    channelKey: "signal",
    isInboundEnabled(connection: IntegrationConnection): boolean {
      const config = connection.config;
      return isExplicitTrue(config.receiveEvents) && Boolean(baseUrlOf(config));
    },
    async run(ctx: ChannelStreamRunContext): Promise<void> {
      const config = ctx.connection.config;
      const baseUrl = baseUrlOf(config);
      if (!baseUrl) {
        throw new ChannelStreamAuthError("Signal bridge URL is required");
      }
      const url = buildEventsUrl(baseUrl, accountOf(config));
      if (!deps.isUrlAllowlisted(url)) {
        throw new ChannelStreamAuthError("Signal bridge host is not in the outbound allowlist");
      }
      const response = await deps.fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: ctx.signal,
        // A redirect could leave the allowlisted host; surface it as an error instead.
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new ChannelStreamAuthError(`Signal bridge rejected the event subscription (${response.status})`);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Signal event stream request failed (${response.status})`);
      }
      ctx.markReady();
      for await (const event of readServerSentEvents(response.body, { signal: ctx.signal })) {
        const payload = receivePayloadOf(parseJson(event.data));
        if (!payload) {
          ctx.diagnostic("event_unparseable", "Skipped an unparseable or non-receive Signal event.");
          continue;
        }
        await handleReceive(ctx, payload);
      }
    },
  };
}
