import type { IntegrationConnection } from "@goatcitadel/contracts";
import { isMatrixInboundEnabled } from "@goatcitadel/gateway-core";
import { readBoundedResponseJson } from "../bounded-response-reader.js";
import type { ChannelStreamCursorStore } from "../channel-stream-cursor-store.js";
import {
  ChannelStreamAuthError,
  type ChannelStreamAdapter,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";

/**
 * Matrix inbound over the client-server `/sync` long-poll.
 *
 * The `since` token is persisted in the cursor store (not in connection config) only after
 * every event of a batch was durably accepted, so a restart resumes where it left off and a
 * failed emit refetches the same batch (durable dedupe absorbs the overlap). The first run
 * with no token primes with a limit-0 sync and dispatches no history. A token stored for a
 * different account (whoami scope) is discarded.
 */

export const MATRIX_DEFAULT_LONG_POLL_TIMEOUT_MS = 30_000;
export const MATRIX_IDLE_GRACE_MS = 60_000;
const MATRIX_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MATRIX_REQUEST_SLACK_MS = 30_000;
const MATRIX_INBOUND_MSGTYPES: readonly string[] = ["m.text", "m.emote"];

const MATRIX_TIMELINE_LIMIT = 100;
const PRIMING_FILTER = JSON.stringify({
  room: { timeline: { limit: 0 }, state: { lazy_load_members: true, types: [] }, ephemeral: { types: [] } },
  presence: { types: [] },
  account_data: { types: [] },
});
const SYNC_FILTER = JSON.stringify({
  room: {
    timeline: { types: ["m.room.message", "m.room.encrypted"], limit: MATRIX_TIMELINE_LIMIT },
    state: { lazy_load_members: true },
    ephemeral: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
});

export interface MatrixStreamAdapterDeps {
  fetch: typeof fetch;
  resolveSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId?: string,
  ): string | undefined;
  isUrlAllowlisted(url: string): boolean;
  cursorStore: ChannelStreamCursorStore;
  longPollTimeoutMs?: number;
}

interface MatrixTimelineEvent {
  type?: unknown;
  event_id?: unknown;
  sender?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
}

interface MatrixSyncResponse {
  next_batch?: unknown;
  rooms?: { join?: Record<string, { timeline?: { events?: unknown; limited?: unknown } } | undefined> };
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** A non-auth HTTP failure; carries the Matrix errcode enum (never body text). */
class MatrixRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly errcode: string | undefined,
    label: string,
  ) {
    super(`Matrix ${label} request failed (${status}${errcode ? ` ${errcode}` : ""})`);
  }
}

function isRejectedSince(error: unknown): boolean {
  return (
    error instanceof MatrixRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429 &&
    error.status !== 408
  );
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createMatrixStreamAdapter(deps: MatrixStreamAdapterDeps): ChannelStreamAdapter {
  const longPollTimeoutMs = deps.longPollTimeoutMs ?? MATRIX_DEFAULT_LONG_POLL_TIMEOUT_MS;

  async function request<T>(
    ctx: ChannelStreamRunContext,
    base: string,
    path: string,
    token: string,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const url = `${base}${path}`;
    if (!deps.isUrlAllowlisted(url)) {
      throw new ChannelStreamAuthError("Matrix homeserver is not in the outbound allowlist");
    }
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    const response = await deps.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal,
      // A redirect could leave the allowlisted host; surface it as an error instead.
      redirect: "error",
    });
    let body: (T & { errcode?: unknown }) | undefined;
    try {
      body = await readBoundedResponseJson<T & { errcode?: unknown }>(response, {
        maxBytes: MATRIX_MAX_RESPONSE_BYTES,
        timeoutMs,
        label: `matrix-${label}`,
      });
    } catch (error) {
      if (response.ok) throw error;
      body = undefined;
    }
    const errcode = body && typeof body.errcode === "string" ? body.errcode : undefined;
    if (
      response.status === 401 ||
      response.status === 403 ||
      errcode === "M_UNKNOWN_TOKEN" ||
      errcode === "M_FORBIDDEN"
    ) {
      throw new ChannelStreamAuthError(`Matrix rejected the access token (${response.status})`);
    }
    if (!response.ok || !body) {
      throw new MatrixRequestError(
        response.status,
        errcode && /^M_[A-Z_]+$/.test(errcode) ? errcode : undefined,
        label,
      );
    }
    return body;
  }

  async function emitBatch(ctx: ChannelStreamRunContext, selfId: string, sync: MatrixSyncResponse): Promise<void> {
    const connectionId = ctx.connection.connectionId;
    let encryptedIgnored = 0;
    for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
      const events = room?.timeline?.events;
      if (!Array.isArray(events)) continue;
      for (const raw of events as MatrixTimelineEvent[]) {
        if (raw?.type === "m.room.encrypted") {
          encryptedIgnored += 1;
          continue;
        }
        if (!raw || raw.type !== "m.room.message") continue;
        if (typeof raw.event_id !== "string" || typeof raw.sender !== "string" || raw.sender === selfId) continue;
        const content = raw.content as
          | { msgtype?: unknown; body?: unknown; "m.relates_to"?: { rel_type?: unknown; event_id?: unknown } }
          | undefined;
        const msgtype = content?.msgtype;
        if (typeof msgtype !== "string" || !MATRIX_INBOUND_MSGTYPES.includes(msgtype)) continue;
        if (typeof content?.body !== "string" || content.body.trim().length === 0) continue;
        const relates = content["m.relates_to"];
        // An edit is a new event carrying m.replace; treating it as a message would start a second turn.
        if (relates?.rel_type === "m.replace") continue;
        const threadId =
          relates?.rel_type === "m.thread" && typeof relates.event_id === "string" ? relates.event_id : undefined;
        await ctx.emit({
          idempotencyKey: `matrix:${connectionId}:${raw.event_id}`,
          eventType: "matrix-room-message",
          bindingTarget: roomId,
          responseOptions: { deliveryReplyToMessageId: raw.event_id },
          message: {
            eventId: raw.event_id,
            account: connectionId,
            room: roomId,
            actorId: raw.sender,
            actorType: "user",
            content: content.body,
            threadId,
            metadata: { roomId, originServerTs: raw.origin_server_ts, msgtype },
          },
        });
      }
    }
    if (encryptedIgnored > 0) {
      ctx.diagnostic(
        "encrypted_event_ignored",
        "Matrix end-to-end encrypted events were ignored; use an unencrypted room.",
        { eventCount: encryptedIgnored },
      );
    }
  }

  return {
    channelKey: "matrix",
    // Each long-poll returns within longPollTimeoutMs even with no events; a grace period beyond that means a dead link.
    idleTimeoutMs: longPollTimeoutMs + MATRIX_IDLE_GRACE_MS,
    isInboundEnabled(connection: IntegrationConnection): boolean {
      return isMatrixInboundEnabled(connection.config);
    },
    async run(ctx: ChannelStreamRunContext): Promise<void> {
      const config = ctx.connection.config;
      const homeserver = readString(config, "homeserverUrl");
      if (!homeserver) throw new ChannelStreamAuthError("Matrix homeserver URL is required");
      const base = homeserver.replace(/\/+$/, "");
      const token = deps.resolveSecret(config, "accessToken", "accessTokenEnv", "channel.matrix");
      if (!token) throw new ChannelStreamAuthError("Matrix access token could not be resolved");
      const connectionId = ctx.connection.connectionId;
      const requestTimeoutMs = longPollTimeoutMs + MATRIX_REQUEST_SLACK_MS;

      try {
        const whoami = await request<{ user_id?: unknown }>(
          ctx,
          base,
          "/_matrix/client/v3/account/whoami",
          token,
          MATRIX_REQUEST_SLACK_MS,
          "whoami",
        );
        if (typeof whoami.user_id !== "string" || whoami.user_id.length === 0) {
          throw new Error("Matrix whoami returned no user_id");
        }
        const selfId = whoami.user_id;
        ctx.touch();

        let ready = false;
        const markReadyOnce = () => {
          if (ready) return;
          ready = true;
          ctx.markReady();
        };
        const prime = async (): Promise<string> => {
          const primed = await request<MatrixSyncResponse>(
            ctx,
            base,
            `/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(PRIMING_FILTER)}`,
            token,
            requestTimeoutMs,
            "priming-sync",
          );
          if (typeof primed.next_batch !== "string") throw new Error("Matrix priming sync returned no next_batch");
          await deps.cursorStore.write("matrix", connectionId, { cursor: primed.next_batch, scope: selfId });
          ctx.touch();
          markReadyOnce();
          return primed.next_batch;
        };

        const stored = await deps.cursorStore.read("matrix", connectionId);
        const resumeFrom = (stored && stored.scope === selfId ? stored.cursor : undefined) ?? ctx.cursor;
        let cursor = resumeFrom ?? (await prime());

        let reprimedSinceLastSuccess = false;
        while (!ctx.signal.aborted) {
          let sync: MatrixSyncResponse;
          try {
            sync = await request<MatrixSyncResponse>(
              ctx,
              base,
              `/_matrix/client/v3/sync?since=${encodeURIComponent(cursor)}&timeout=${longPollTimeoutMs}` +
                `&filter=${encodeURIComponent(SYNC_FILTER)}`,
              token,
              requestTimeoutMs,
              "sync",
            );
          } catch (error) {
            // Re-prime at most once until an incremental sync succeeds; a repeat rethrows so the runtime backs off.
            if (!isRejectedSince(error) || reprimedSinceLastSuccess) throw error;
            reprimedSinceLastSuccess = true;
            // A stale or invalid since token would otherwise wedge the connection on endless retries.
            ctx.diagnostic(
              "since_rejected",
              "Matrix rejected the stored sync token; re-primed. Messages in the gap were skipped.",
              undefined,
              "warn",
            );
            cursor = await prime();
            continue;
          }
          reprimedSinceLastSuccess = false;
          markReadyOnce();
          ctx.touch();
          const limitedRooms = Object.values(sync.rooms?.join ?? {}).filter(
            (room) => room?.timeline?.limited === true,
          ).length;
          if (limitedRooms > 0) {
            ctx.diagnostic(
              "timeline_limited",
              `Matrix returned a limited timeline for ${limitedRooms} room(s); older messages in the gap were skipped.`,
              { roomCount: limitedRooms },
              "warn",
            );
          }
          await emitBatch(ctx, selfId, sync);
          if (typeof sync.next_batch === "string" && sync.next_batch !== cursor) {
            // Only after every emit in the batch resolved.
            await deps.cursorStore.write("matrix", connectionId, { cursor: sync.next_batch, scope: selfId });
            cursor = sync.next_batch;
          }
        }
      } catch (error) {
        if (ctx.signal.aborted && isAbortLike(error)) return;
        throw error;
      }
    },
  };
}
