import type { IntegrationConnection } from "@goatcitadel/contracts";
import { readTelegramReceiveMode } from "@goatcitadel/gateway-core";
import { readBoundedResponseJson } from "../bounded-response-reader.js";
import type { ChannelSecretOwner } from "../channel-secret-resolution.js";
import type { ChannelStreamCursorStore } from "../channel-stream-cursor-store.js";
import {
  ChannelStreamAuthError,
  type ChannelStreamAdapter,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";
import { readTelegramBotMethodCall, type TelegramBotMethodCall } from "../telegram-update-processor.js";

/**
 * Telegram inbound by long-polling the Bot API's `getUpdates`, so a connection needs no public web address.
 *
 * The next offset is stored in the cursor store, scoped to the bot id (the part of the key before `:`), after each
 * update is handled: a restart resumes there, and a key for another bot starts fresh. A first start with no stored
 * offset skips whatever is already waiting (the setup messages, including the `/start` code) instead of turning it
 * into AI turns. A reply the update handler returns is sent here, because a poll has no response to carry it.
 *
 * The bot key is part of every Bot API URL, so errors and diagnostics carry fixed messages only: never a URL, a
 * fetch error message or a response body.
 */

export const LONG_POLL_SECONDS = 25;
export const REQUEST_TIMEOUT_MS = 35_000;
/** Tries at one update before it is skipped, so one update that always fails cannot block every later one. */
export const MAX_UPDATE_ATTEMPTS = 8;
const IDLE_TIMEOUT_MS = 60_000;
const ALLOWED_UPDATES = ["message", "channel_post", "callback_query"];
const BOT_API_ORIGIN = "https://api.telegram.org/";
const UPDATES_PAGE_SIZE = 100;
const UPDATES_MAX_BYTES = 4 * 1024 * 1024;
const REPLY_MAX_BYTES = 256 * 1024;

const NO_KEY = "Telegram has no bot key.";
const MALFORMED_KEY = "The Telegram bot key isn't in the format Telegram uses.";
const REJECTED_KEY = "Telegram rejected the bot key.";
const ANOTHER_READER =
  "Telegram says another app is reading this bot's messages, or the bot sends them to a web address.";
const UNREACHABLE = "GoatCitadel couldn't reach Telegram.";
const NOT_ALLOWED = "GoatCitadel isn't allowed to reach api.telegram.org.";
const REPLY_FAILED = "GoatCitadel couldn't send its reply to Telegram.";
const UPDATE_SKIPPED = `Skipped a Telegram update GoatCitadel couldn't handle after ${MAX_UPDATE_ATTEMPTS} tries.`;

export interface TelegramStreamAdapterDeps {
  fetch: typeof fetch;
  resolveSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string | undefined,
    owner: ChannelSecretOwner,
  ): string | undefined;
  isUrlAllowlisted(urlValue: string): boolean;
  cursorStore: ChannelStreamCursorStore;
  /** Handles one update; its result is sent to Telegram when it is a Bot API call. */
  processUpdate(connectionId: string, update: unknown): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUpdateId(update: unknown): number | undefined {
  const id = isRecord(update) ? update.update_id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/** A failed call's body is never read: it is released unread so it cannot reach an error. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export function createTelegramStreamAdapter(deps: TelegramStreamAdapterDeps): ChannelStreamAdapter {
  // Failures of the update at the head of each connection's queue. Kept here, not per session, so the count
  // survives the session restarts the runtime's backoff makes between tries.
  const headFailures = new Map<string, { updateId: number; attempts: number }>();

  function recordHeadFailure(connectionId: string, updateId: number): void {
    const previous = headFailures.get(connectionId);
    const attempts = previous?.updateId === updateId ? previous.attempts + 1 : 1;
    headFailures.set(connectionId, { updateId, attempts });
  }

  function hasExhaustedAttempts(connectionId: string, updateId: number): boolean {
    const failures = headFailures.get(connectionId);
    return failures?.updateId === updateId && failures.attempts >= MAX_UPDATE_ATTEMPTS;
  }

  async function callBotApi(key: string, method: string, init: RequestInit & { signal: AbortSignal }) {
    try {
      // A redirect could carry the key to another host; surface it as an error instead.
      return await deps.fetch(`${BOT_API_ORIGIN}bot${key}/${method}`, { ...init, redirect: "error" });
    } catch {
      // The fetch error can quote the request URL, which holds the bot key.
      throw new Error(UNREACHABLE);
    }
  }

  async function getUpdates(
    ctx: ChannelStreamRunContext,
    key: string,
    params: Record<string, string>,
  ): Promise<unknown[]> {
    const response = await callBotApi(key, `getUpdates?${new URLSearchParams(params).toString()}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      discardBody(response);
      if (response.status === 401) throw new ChannelStreamAuthError(REJECTED_KEY);
      if (response.status === 409) throw new Error(ANOTHER_READER);
      throw new Error(`Telegram returned HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await readBoundedResponseJson(response, {
        maxBytes: UPDATES_MAX_BYTES,
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: "Telegram getUpdates",
      });
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (!isRecord(body) || body.ok !== true || !Array.isArray(body.result)) {
      throw new Error(`Telegram returned HTTP ${response.status}.`);
    }
    return body.result;
  }

  /**
   * Reply failures are reported, never thrown: the update itself was handled and its offset still advances.
   * The reply is bounded by its own timeout, not the session: handling an update can change the connection
   * (a pairing request saves its code), which restarts the session, and the sender must still get the reply,
   * as a webhook reply would reach them.
   */
  async function sendReply(ctx: ChannelStreamRunContext, key: string, call: TelegramBotMethodCall): Promise<void> {
    let failure: Record<string, unknown> | undefined;
    try {
      const response = await callBotApi(key, call.method, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(call.params),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        // Drained (bounded) so the connection is released; a 2xx means Telegram took the call.
        await readBoundedResponseJson(response, {
          maxBytes: REPLY_MAX_BYTES,
          timeoutMs: REQUEST_TIMEOUT_MS,
          label: "Telegram reply",
        }).catch(() => undefined);
      } else {
        discardBody(response);
        failure = { method: call.method, status: response.status };
      }
    } catch {
      failure = { method: call.method };
    }
    if (failure) ctx.diagnostic("reply_failed", REPLY_FAILED, failure, "warn");
  }

  /**
   * First start for this bot: `offset=-1` returns only the newest waiting update and drops the older ones; the
   * stored offset just past it confirms it on the next poll. "0" means nothing was waiting.
   */
  async function skipWaitingUpdates(
    ctx: ChannelStreamRunContext,
    key: string,
    saveOffset: (offset: string) => Promise<void>,
  ): Promise<string> {
    const waiting = await getUpdates(ctx, key, { offset: "-1", limit: "1", timeout: "0" });
    const ids = waiting.map(readUpdateId).filter((id): id is number => id !== undefined);
    const offset = ids.length > 0 ? String(Math.max(...ids) + 1) : "0";
    await saveOffset(offset);
    ctx.touch();
    return offset;
  }

  async function handleUpdate(ctx: ChannelStreamRunContext, key: string, update: unknown): Promise<void> {
    const reply = readTelegramBotMethodCall(await deps.processUpdate(ctx.connection.connectionId, update));
    if (reply) await sendReply(ctx, key, reply);
  }

  return {
    channelKey: "telegram",
    // Each long poll returns within LONG_POLL_SECONDS even with nothing new; silence past this means a dead link.
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    isInboundEnabled(connection: IntegrationConnection): boolean {
      return readTelegramReceiveMode(connection.config) === "poll";
    },
    async run(ctx: ChannelStreamRunContext): Promise<void> {
      const key = deps.resolveSecret(
        ctx.connection.config,
        "botToken",
        "botTokenEnv",
        ctx.connection.catalogId,
        ctx.connection,
      );
      if (!key) throw new ChannelStreamAuthError(NO_KEY);
      // The bot id scopes the stored offset; a key without one is never stored or sent.
      const botId = /^(\d+):\S+$/.exec(key)?.[1];
      if (!botId) throw new ChannelStreamAuthError(MALFORMED_KEY);
      if (!deps.isUrlAllowlisted(BOT_API_ORIGIN)) throw new Error(NOT_ALLOWED);
      const connectionId = ctx.connection.connectionId;
      const saveOffset = (offset: string) =>
        deps.cursorStore.write("telegram", connectionId, { cursor: offset, scope: botId });

      try {
        const stored = await deps.cursorStore.read("telegram", connectionId);
        let offset =
          stored && stored.scope === botId && /^\d+$/.test(stored.cursor)
            ? stored.cursor
            : await skipWaitingUpdates(ctx, key, saveOffset);
        ctx.markReady();
        while (!ctx.signal.aborted) {
          const batch = await getUpdates(ctx, key, {
            offset,
            limit: String(UPDATES_PAGE_SIZE),
            timeout: String(LONG_POLL_SECONDS),
            allowed_updates: JSON.stringify(ALLOWED_UPDATES),
          });
          ctx.touch();
          for (const update of batch) {
            if (ctx.signal.aborted) return;
            const updateId = readUpdateId(update);
            if (updateId === undefined) continue;
            const next = String(updateId + 1);
            if (hasExhaustedAttempts(connectionId, updateId)) {
              // Not inbound activity: no handle, only the diagnostic (the id alone) and the offset past it.
              ctx.diagnostic("update_skipped", UPDATE_SKIPPED, { updateId }, "warn");
              await saveOffset(next);
              headFailures.delete(connectionId);
              offset = next;
              continue;
            }
            try {
              await ctx.handle(() => handleUpdate(ctx, key, update), next);
            } catch (error) {
              recordHeadFailure(connectionId, updateId);
              throw error;
            }
            headFailures.delete(connectionId);
            await saveOffset(next);
            offset = next;
          }
        }
      } catch (error) {
        // An aborted session ends quietly; the runtime decides whether to reconnect.
        if (ctx.signal.aborted) return;
        throw error;
      }
    },
  };
}
