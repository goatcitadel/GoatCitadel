import { NTFY_OUTBOUND_MARKER_TAG, type IntegrationConnection } from "@goatcitadel/contracts";
import {
  ChannelStreamAuthError,
  type ChannelStreamAdapter,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";
import type { ChannelSecretOwner } from "../channel-secret-resolution.js";
import { readStreamLines } from "./stream-line-reader.js";

/**
 * ntfy inbound over the topic's persistent JSON stream
 * (`GET {baseUrl}/{topic}/json`, one JSON object per line).
 *
 * ntfy carries no sender identity, so the topic itself is the sender. The token
 * only gates reading; anyone able to publish to the topic can start turns, so the
 * operator must restrict the topic's write access. Inbound is enabled only when a
 * token is configured. The cursor is in memory: messages published while the
 * gateway is down or restarting are skipped (no since= after a restart).
 */

export const NTFY_IDLE_TIMEOUT_MS = 120_000;

export interface NtfyStreamAdapterDeps {
  /** Plain fetch with the session signal; the stream is long-lived, so no request timeout. */
  fetch: typeof fetch;
  resolveSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string | undefined,
    owner: ChannelSecretOwner,
  ): string | undefined;
  isUrlAllowlisted(url: string): boolean;
}

interface NtfyStreamMessage {
  id?: unknown;
  time?: unknown;
  event?: unknown;
  topic?: unknown;
  title?: unknown;
  message?: unknown;
  tags?: unknown;
  priority?: unknown;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isOptedIn(config: Record<string, unknown>): boolean {
  const flag = config.inboundStreamEnabled;
  return flag === true || (typeof flag === "string" && flag.trim().toLowerCase() === "true");
}

function subscribeTopicOf(config: Record<string, unknown>): string | undefined {
  return readString(config, "subscribeTopic") ?? readString(config, "topic") ?? readString(config, "defaultTopic");
}

function buildStreamUrl(baseUrl: string, topic: string, cursor: string | undefined): string {
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(topic)}/json`;
  return cursor ? `${url}?since=${encodeURIComponent(cursor)}` : url;
}

function parseLine(line: string): NtfyStreamMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as NtfyStreamMessage) : undefined;
  } catch {
    return undefined;
  }
}

function tagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
}

export function createNtfyStreamAdapter(deps: NtfyStreamAdapterDeps): ChannelStreamAdapter {
  async function handleMessage(ctx: ChannelStreamRunContext, msg: NtfyStreamMessage, topic: string): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    const text = typeof msg.message === "string" ? msg.message : "";
    if (!id || text.trim().length === 0) return;
    const tags = tagsOf(msg.tags);
    if (tags.includes(NTFY_OUTBOUND_MARKER_TAG)) return;
    const title = typeof msg.title === "string" && msg.title.length > 0 ? msg.title : undefined;
    const connectionId = ctx.connection.connectionId;
    await ctx.emit(
      {
        idempotencyKey: `ntfy:${connectionId}:${id}`,
        eventType: "ntfy-message",
        bindingTarget: topic,
        message: {
          eventId: id,
          account: connectionId,
          room: topic,
          actorId: `ntfy-topic:${topic}`,
          actorType: "user",
          content: (title ? `${title}\n` : "") + text,
          metadata: { topic, title, tags, priority: msg.priority, time: msg.time },
        },
      },
      id,
    );
  }

  return {
    channelKey: "ntfy",
    // ntfy sends a keepalive event about every 45s; two missed keepalives means a dead connection.
    idleTimeoutMs: NTFY_IDLE_TIMEOUT_MS,
    isInboundEnabled(connection: IntegrationConnection): boolean {
      const config = connection.config;
      return (
        isOptedIn(config) &&
        Boolean(readString(config, "baseUrl")) &&
        Boolean(subscribeTopicOf(config)) &&
        Boolean(readString(config, "token") ?? readString(config, "tokenEnv"))
      );
    },
    async run(ctx: ChannelStreamRunContext): Promise<void> {
      const config = ctx.connection.config;
      const baseUrl = readString(config, "baseUrl");
      const topic = subscribeTopicOf(config);
      if (!baseUrl || !topic) {
        throw new ChannelStreamAuthError("ntfy base URL and subscribe topic are required");
      }
      const url = buildStreamUrl(baseUrl, topic, ctx.cursor);
      if (!deps.isUrlAllowlisted(url)) {
        throw new ChannelStreamAuthError("ntfy host is not in the outbound allowlist");
      }
      const token = deps.resolveSecret(config, "token", "tokenEnv", "channel.ntfy", ctx.connection);
      if (!token) {
        throw new ChannelStreamAuthError("ntfy token could not be resolved");
      }
      const response = await deps.fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/x-ndjson" },
        signal: ctx.signal,
        // A redirect could leave the allowlisted host; surface it as an error instead.
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new ChannelStreamAuthError(`ntfy rejected the subscription token (${response.status})`);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`ntfy stream request failed (${response.status})`);
      }
      for await (const line of readStreamLines(response.body, { signal: ctx.signal, onActivity: ctx.touch })) {
        if (line.trim().length === 0) continue;
        const msg = parseLine(line);
        if (!msg) {
          ctx.diagnostic("line_unparseable", "Skipped an unparseable ntfy stream line.");
          continue;
        }
        if (msg.event === "open") {
          ctx.markReady();
        } else if (msg.event === "message") {
          await handleMessage(ctx, msg, topic);
        }
      }
    },
  };
}
