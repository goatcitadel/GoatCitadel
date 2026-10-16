import type { IntegrationConnection } from "@goatcitadel/contracts";
import { isExplicitTrue } from "@goatcitadel/gateway-core";
import {
  ChannelStreamAuthError,
  type ChannelStreamAdapter,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";

/**
 * Mattermost inbound over the bot's WebSocket (`/api/v4/websocket`).
 *
 * The bot authenticates the socket with an `authentication_challenge`, then
 * receives `posted` events for every channel it belongs to. There is no history
 * replay on reconnect: posts sent while disconnected (or backing off), or whose
 * durable acceptance fails, are lost. The post id only dedupes a redelivered event.
 */

/** The slice of the WebSocket API the adapter needs; the Node global satisfies it. */
export interface MattermostWebSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface MattermostStreamAdapterDeps {
  /** Plain fetch with the session signal; no request timeout. */
  fetch: typeof fetch;
  resolveSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId?: string,
  ): string | undefined;
  isUrlAllowlisted(url: string): boolean;
  createWebSocket(url: string): MattermostWebSocketLike;
}

interface MattermostFrame {
  event?: unknown;
  seq?: unknown;
  status?: unknown;
  data?: unknown;
}

interface MattermostPost {
  id?: unknown;
  channel_id?: unknown;
  user_id?: unknown;
  root_id?: unknown;
  type?: unknown;
  message?: unknown;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasToken(config: Record<string, unknown>): boolean {
  return ["botToken", "botTokenEnv", "token", "tokenEnv"].some((key) => Boolean(readString(config, key)));
}

function trimBase(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

function toWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function createMattermostStreamAdapter(deps: MattermostStreamAdapterDeps): ChannelStreamAdapter {
  function resolveToken(config: Record<string, unknown>): string | undefined {
    return (
      deps.resolveSecret(config, "botToken", "botTokenEnv", "channel.mattermost") ??
      deps.resolveSecret(config, "token", "tokenEnv", "channel.mattermost")
    );
  }

  async function fetchBotUserId(base: string, token: string, signal: AbortSignal): Promise<string> {
    const response = await deps.fetch(`${base}/api/v4/users/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal,
      // A redirect could leave the allowlisted host; surface it as an error instead.
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new ChannelStreamAuthError(`Mattermost rejected the bot token (${response.status})`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Mattermost users/me request failed (${response.status})`);
    }
    const body = asRecord(await response.json().catch(() => undefined));
    const id = str(body?.id);
    if (!id) throw new Error("Mattermost users/me response did not include a bot user id");
    return id;
  }

  async function handlePosted(ctx: ChannelStreamRunContext, frame: MattermostFrame, botUserId: string): Promise<void> {
    const data = asRecord(frame.data);
    const rawPost = str(data?.post);
    if (!data || !rawPost) return;
    const post = asRecord(parseJson(rawPost)) as MattermostPost | undefined;
    if (!post) {
      ctx.diagnostic("post_unparseable", "Skipped an unparseable Mattermost post payload.");
      return;
    }
    const id = str(post.id);
    const channelId = str(post.channel_id);
    const userId = str(post.user_id);
    const text = typeof post.message === "string" ? post.message : "";
    if (!id || !channelId || !userId || text.trim().length === 0) return;
    if (userId === botUserId) return;
    const type = str(post.type);
    if (type?.startsWith("system_")) return;
    const rootId = str(post.root_id);
    const channelType = str(data.channel_type);
    const senderName = str(data.sender_name)?.replace(/^@/, "");
    const connectionId = ctx.connection.connectionId;
    const seq = typeof frame.seq === "number" ? frame.seq : undefined;
    await ctx.emit(
      {
        idempotencyKey: `mattermost:${connectionId}:${id}`,
        eventType: "mattermost-posted",
        bindingTarget: channelId,
        message: {
          eventId: id,
          account: connectionId,
          ...(channelType === "D" ? { peer: userId } : {}),
          room: channelId,
          threadId: rootId,
          actorId: userId,
          actorType: "user",
          displayName: senderName,
          content: text,
          metadata: {
            channelType,
            channelName: str(data.channel_name),
            teamId: str(data.team_id),
            rootId,
          },
        },
      },
      seq === undefined ? undefined : String(seq),
    );
  }

  return {
    channelKey: "mattermost",
    isInboundEnabled(connection: IntegrationConnection): boolean {
      const config = connection.config;
      return (
        isExplicitTrue(config.inboundStreamEnabled) && Boolean(readString(config, "serverUrl")) && hasToken(config)
      );
    },
    async run(ctx: ChannelStreamRunContext): Promise<void> {
      const config = ctx.connection.config;
      const serverUrl = readString(config, "serverUrl");
      if (!serverUrl) throw new ChannelStreamAuthError("Mattermost server URL is required");
      const base = trimBase(serverUrl);
      const httpSocketUrl = `${base}/api/v4/websocket`;
      // Allowlists are http(s); check the socket endpoint in that form before any request.
      if (!deps.isUrlAllowlisted(httpSocketUrl) || !deps.isUrlAllowlisted(`${base}/api/v4/users/me`)) {
        throw new ChannelStreamAuthError("Mattermost host is not in the outbound allowlist");
      }
      const token = resolveToken(config);
      if (!token) throw new ChannelStreamAuthError("Mattermost bot token could not be resolved");
      const botUserId = await fetchBotUserId(base, token, ctx.signal);
      if (ctx.signal.aborted) return;

      await new Promise<void>((resolve, reject) => {
        const socket = deps.createWebSocket(toWebSocketUrl(httpSocketUrl));
        let settled = false;
        let chain: Promise<void> = Promise.resolve();
        let ready = false;
        const markReadyOnce = () => {
          if (ready) return;
          ready = true;
          ctx.markReady();
        };

        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          ctx.signal.removeEventListener("abort", onAbort);
          try {
            socket.close();
          } catch {
            // already closed
          }
          if (error === undefined) resolve();
          else reject(error);
        };
        // Serialize handlers so emit() order matches arrival order, then settle.
        const settleAfterDrain = (error?: unknown) => {
          void chain.then(
            () => finish(error),
            (drainError: unknown) => finish(error ?? drainError),
          );
        };
        const onAbort = () => finish();
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } }));
        });
        socket.addEventListener("message", (event) => {
          if (settled || typeof event.data !== "string") return;
          const frame = asRecord(parseJson(event.data)) as MattermostFrame | undefined;
          if (!frame) {
            ctx.diagnostic("frame_unparseable", "Skipped an unparseable Mattermost websocket frame.");
            return;
          }
          if (frame.status === "FAIL") {
            finish(new ChannelStreamAuthError("Mattermost rejected the websocket authentication challenge"));
            return;
          }
          if (frame.status === "OK" || frame.event === "hello") {
            markReadyOnce();
            return;
          }
          if (frame.event === "posted") {
            chain = chain.then(() => handlePosted(ctx, frame, botUserId));
            chain.catch((emitError: unknown) => finish(emitError));
          }
        });
        socket.addEventListener("close", () => settleAfterDrain());
        socket.addEventListener("error", () => settleAfterDrain(new Error("Mattermost websocket error")));
      });
    },
  };
}
