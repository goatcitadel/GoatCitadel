import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { ChannelStreamCursorStore } from "../channel-stream-cursor-store.js";
import { ChannelStreamAuthError, type ChannelStreamRunContext } from "../channel-stream-runtime-service.js";
import { createTelegramStreamAdapter, type TelegramStreamAdapterDeps } from "./telegram-stream-adapter.js";

const KEY = "123:abc";
const BOT_ID = "123";

function connection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    revision: "r1",
    catalogId: "channel.telegram",
    kind: "channel",
    key: "telegram",
    label: "Telegram",
    enabled: true,
    status: "connected",
    config: { botTokenEnv: "TELEGRAM_BOT_TOKEN", receiveMode: "poll", ...config },
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function updates(...result: unknown[]): Response {
  return json({ ok: true, result });
}

function textUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: { message_id: updateId, from: { id: 777, is_bot: false }, chat: { id: 777, type: "private" }, text: "hi" },
  };
}

/** A command whose text must never reach a diagnostic. */
function commandUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 777, is_bot: false },
      chat: { id: 777, type: "private" },
      text: "/approve secret-words",
    },
  };
}

/** Per-connection cursors; every connection starts from `initial` until it writes its own. */
function memoryStore(initial?: { cursor: string; scope?: string }) {
  const values = new Map<string, { cursor: string; scope?: string }>();
  const writes: Array<{ channelKey: string; connectionId: string; cursor: string; scope?: string }> = [];
  const store: ChannelStreamCursorStore = {
    read: async (_channelKey, connectionId) => values.get(connectionId) ?? initial,
    write: async (channelKey, connectionId, next) => {
      values.set(connectionId, next);
      writes.push({ channelKey, connectionId, ...next });
    },
  };
  return { store, writes, current: (connectionId = "conn-1") => values.get(connectionId) ?? initial };
}

interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signalAborted: boolean;
}

interface HarnessOptions {
  /** Responses for long polls, in order; after they run out the session aborts. */
  polls?: Array<() => Response | Promise<Response>>;
  /** Answers each long poll by offset instead of `polls`; undefined ends the session. */
  respond?: (offset: string) => Response | undefined;
  probe?: () => Response;
  reply?: () => Response | Promise<Response>;
  token?: string | undefined;
  allowlisted?: boolean;
  store?: ReturnType<typeof memoryStore>;
  /** `endSession` aborts the session, as the runtime does when the handler changes the connection. */
  processUpdate?: (connectionId: string, update: unknown, endSession: () => void) => Promise<unknown>;
}

function harness(options: HarnessOptions = {}) {
  // Each ctx() is a new session with its own signal, as the runtime gives each run.
  let controller = new AbortController();
  const pollQueue = [...(options.polls ?? [])];
  const calls: RecordedCall[] = [];
  const events: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signalAborted: init?.signal?.aborted ?? false,
    });
    if (url.pathname.endsWith("/getUpdates")) {
      if (url.searchParams.get("offset") === "-1") return options.probe ? options.probe() : updates();
      const response = options.respond
        ? options.respond(url.searchParams.get("offset") ?? "")
        : await pollQueue.shift()?.();
      if (!response) {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return response;
    }
    return options.reply ? await options.reply() : json({ ok: true, result: {} });
  });
  const cursor = options.store ?? memoryStore();
  const store: ChannelStreamCursorStore = {
    read: (channelKey, connectionId) => cursor.store.read(channelKey, connectionId),
    write: async (channelKey, connectionId, value) => {
      events.push(`write:${value.cursor}`);
      await cursor.store.write(channelKey, connectionId, value);
    },
  };
  const processUpdate = vi.fn(async (connectionId: string, update: unknown) => {
    events.push(`process:${(update as { update_id: number }).update_id}`);
    return options.processUpdate ? options.processUpdate(connectionId, update, () => controller.abort()) : undefined;
  });
  const deps: TelegramStreamAdapterDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    resolveSecret: vi.fn(() => ("token" in options ? options.token : KEY)),
    isUrlAllowlisted: vi.fn(() => options.allowlisted ?? true),
    cursorStore: store,
    processUpdate,
  };
  const adapter = createTelegramStreamAdapter(deps);
  const markReady = vi.fn();
  const touch = vi.fn();
  const diagnostic = vi.fn();
  const handled: Array<string | undefined> = [];
  function ctx(config?: Record<string, unknown>, connectionId = "conn-1"): ChannelStreamRunContext {
    controller = new AbortController();
    return {
      connection: { ...connection(config), connectionId },
      signal: controller.signal,
      cursor: undefined,
      markReady,
      touch,
      emit: vi.fn(async () => {
        throw new Error("the Telegram adapter must not emit");
      }),
      handle: async (work: () => Promise<unknown>, nextCursor?: string) => {
        handled.push(nextCursor);
        await work();
      },
      diagnostic,
    };
  }
  const getUpdatesCalls = () => calls.filter((call) => call.url.pathname.endsWith("/getUpdates"));
  return {
    adapter,
    deps,
    fetchMock,
    calls,
    getUpdatesCalls,
    events,
    handled,
    processUpdate,
    markReady,
    diagnostic,
    ctx,
    cursor,
  };
}

describe("telegram stream adapter", () => {
  it("runs only for connections that poll", () => {
    const { adapter } = harness();
    expect(adapter.channelKey).toBe("telegram");
    expect(adapter.idleTimeoutMs).toBe(60_000);
    expect(adapter.isInboundEnabled(connection({ receiveMode: "poll" }))).toBe(true);
    expect(adapter.isInboundEnabled(connection({ receiveMode: "off" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ receiveMode: "webhook" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ receiveMode: undefined, webhookSecret: "s" }))).toBe(false);
  });

  it("skips the waiting setup messages on its first start", async () => {
    const h = harness({ probe: () => updates(textUpdate(7)), polls: [() => updates()] });
    await h.adapter.run(h.ctx());

    const [probe, firstPoll] = h.getUpdatesCalls();
    expect(probe!.url.origin + probe!.url.pathname).toBe(`https://api.telegram.org/bot${KEY}/getUpdates`);
    expect(probe!.url.searchParams.get("offset")).toBe("-1");
    expect(probe!.url.searchParams.get("limit")).toBe("1");
    expect(probe!.url.searchParams.get("timeout")).toBe("0");
    expect(h.processUpdate).not.toHaveBeenCalled();
    expect(h.cursor.current()).toEqual({ cursor: "8", scope: BOT_ID });
    expect(h.cursor.writes[0]).toMatchObject({ channelKey: "telegram", connectionId: "conn-1" });
    expect(firstPoll!.url.searchParams.get("offset")).toBe("8");
    expect(firstPoll!.url.searchParams.get("timeout")).toBe("25");
    expect(firstPoll!.url.searchParams.get("limit")).toBe("100");
    expect(JSON.parse(firstPoll!.url.searchParams.get("allowed_updates")!)).toEqual([
      "message",
      "channel_post",
      "callback_query",
    ]);
    expect(h.markReady).toHaveBeenCalledTimes(1);
  });

  it("skips only once", async () => {
    const store = memoryStore();
    const first = harness({ store, probe: () => updates() });
    await first.adapter.run(first.ctx());
    expect(store.current()).toEqual({ cursor: "0", scope: BOT_ID });

    const second = harness({ store, polls: [() => updates()] });
    await second.adapter.run(second.ctx());
    const offsets = second.getUpdatesCalls().map((call) => call.url.searchParams.get("offset"));
    expect(offsets).not.toContain("-1");
    expect(offsets[0]).toBe("0");
    expect(second.getUpdatesCalls()[0]!.url.searchParams.get("timeout")).toBe("25");
  });

  it("resumes from its cursor for the same bot and starts fresh for another bot", async () => {
    const sameBot = harness({ store: memoryStore({ cursor: "50", scope: BOT_ID }), polls: [() => updates()] });
    await sameBot.adapter.run(sameBot.ctx());
    const sameOffsets = sameBot.getUpdatesCalls().map((call) => call.url.searchParams.get("offset"));
    expect(sameOffsets[0]).toBe("50");
    expect(sameOffsets).not.toContain("-1");

    const otherStore = memoryStore({ cursor: "50", scope: BOT_ID });
    const otherBot = harness({ store: otherStore, token: "999:xyz", probe: () => updates(textUpdate(3)) });
    await otherBot.adapter.run(otherBot.ctx());
    expect(otherBot.getUpdatesCalls()[0]!.url.searchParams.get("offset")).toBe("-1");
    expect(otherBot.processUpdate).not.toHaveBeenCalled();
    expect(otherStore.current()).toEqual({ cursor: "4", scope: "999" });
  });

  it("handles each update in order, then advances the cursor", async () => {
    const store = memoryStore({ cursor: "10", scope: BOT_ID });
    const h = harness({ store, polls: [() => updates(textUpdate(10), textUpdate(11))] });
    await h.adapter.run(h.ctx());

    expect(h.processUpdate.mock.calls).toEqual([
      ["conn-1", textUpdate(10)],
      ["conn-1", textUpdate(11)],
    ]);
    expect(h.handled).toEqual(["11", "12"]);
    expect(h.events).toEqual(["process:10", "write:11", "process:11", "write:12"]);
    expect(store.current()).toEqual({ cursor: "12", scope: BOT_ID });
    expect(h.getUpdatesCalls()[1]!.url.searchParams.get("offset")).toBe("12");
  });

  it("skips an update that fails 8 times and keeps receiving", async () => {
    const store = memoryStore({ cursor: "10", scope: BOT_ID });
    const h = harness({
      store,
      respond: (offset) =>
        offset === "10"
          ? updates(commandUpdate(10), textUpdate(11))
          : offset === "11"
            ? updates(textUpdate(11))
            : undefined,
      processUpdate: async (_connectionId, update) => {
        if ((update as { update_id: number }).update_id === 10) {
          throw new Error("Inbound command was denied by sender policy: sender_not_allowlisted");
        }
        return undefined;
      },
    });

    // Each run is a new session with a new ctx, as the runtime's backoff retries would be.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await expect(h.adapter.run(h.ctx())).rejects.toThrow("denied by sender policy");
    }
    expect(h.diagnostic).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    const handledBefore = h.handled.length;

    await expect(h.adapter.run(h.ctx())).resolves.toBeUndefined();

    expect(h.diagnostic).toHaveBeenCalledTimes(1);
    expect(h.diagnostic).toHaveBeenCalledWith(
      "update_skipped",
      "Skipped a Telegram update GoatCitadel couldn't handle after 8 tries.",
      { updateId: 10 },
      "warn",
    );
    const reported = JSON.stringify(h.diagnostic.mock.calls);
    expect(reported).not.toContain(KEY);
    expect(reported).not.toContain("secret-words");
    expect(reported).not.toContain("sender policy");
    expect(store.writes.map((write) => write.cursor)).toEqual(["11", "12"]);
    // The skip is not inbound activity: only update 11 went through handle on the last run.
    expect(h.handled.slice(handledBefore)).toEqual(["12"]);
    const attemptsAt10 = h.processUpdate.mock.calls.filter(
      ([, update]) => (update as { update_id: number }).update_id === 10,
    );
    expect(attemptsAt10).toHaveLength(8);
    expect(h.processUpdate).toHaveBeenLastCalledWith("conn-1", textUpdate(11));
    expect(store.current()).toEqual({ cursor: "12", scope: BOT_ID });
  });

  it("a success clears the failure count", async () => {
    const store = memoryStore({ cursor: "10", scope: BOT_ID });
    let failuresLeft = 7;
    const h = harness({
      store,
      respond: (offset) => (offset === "10" ? updates(commandUpdate(10)) : undefined),
      processUpdate: async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("store down");
        }
        return undefined;
      },
    });
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await expect(h.adapter.run(h.ctx())).rejects.toThrow("store down");
    }
    await expect(h.adapter.run(h.ctx())).resolves.toBeUndefined();
    expect(store.current()).toEqual({ cursor: "11", scope: BOT_ID });

    // The same update arrives again (say its offset write was lost): its failures count from zero, not from 7.
    await store.store.write("telegram", "conn-1", { cursor: "10", scope: BOT_ID });
    failuresLeft = 7;
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await expect(h.adapter.run(h.ctx())).rejects.toThrow("store down");
    }
    await expect(h.adapter.run(h.ctx())).resolves.toBeUndefined();

    expect(h.diagnostic).not.toHaveBeenCalled();
    expect(h.processUpdate).toHaveBeenCalledTimes(16);
    expect(store.current()).toEqual({ cursor: "11", scope: BOT_ID });
  });

  it("counts failures per connection", async () => {
    const store = memoryStore({ cursor: "10", scope: BOT_ID });
    const h = harness({
      store,
      respond: (offset) => (offset === "10" ? updates(commandUpdate(10)) : undefined),
      processUpdate: async (connectionId) => {
        if (connectionId === "conn-1") throw new Error("denied");
        return undefined;
      },
    });
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await expect(h.adapter.run(h.ctx())).rejects.toThrow("denied");
    }

    // Another connection's update 10 is its own: conn-1's eight failures do not skip it.
    await expect(h.adapter.run(h.ctx(undefined, "conn-2"))).resolves.toBeUndefined();
    expect(h.processUpdate).toHaveBeenLastCalledWith("conn-2", commandUpdate(10));
    expect(h.diagnostic).not.toHaveBeenCalled();
    expect(store.current("conn-2")).toEqual({ cursor: "11", scope: BOT_ID });

    // And conn-2's success leaves conn-1's count alone: conn-1 now skips its update 10.
    await expect(h.adapter.run(h.ctx())).resolves.toBeUndefined();
    expect(h.diagnostic).toHaveBeenCalledTimes(1);
    expect(h.diagnostic.mock.calls[0]![2]).toEqual({ updateId: 10 });
    expect(store.current("conn-1")).toEqual({ cursor: "11", scope: BOT_ID });
    expect(h.processUpdate.mock.calls.filter(([connectionId]) => connectionId === "conn-1")).toHaveLength(8);
  });

  it("sends the reply the handler returns", async () => {
    const reply = { method: "sendMessage", chat_id: 1, text: "hi" };
    const sent = harness({
      store: memoryStore({ cursor: "10", scope: BOT_ID }),
      polls: [() => updates(textUpdate(10))],
      processUpdate: async () => reply,
    });
    await sent.adapter.run(sent.ctx());
    const post = sent.calls.find((call) => call.method === "POST");
    expect(post?.url.href).toBe(`https://api.telegram.org/bot${KEY}/sendMessage`);
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(post?.body).toEqual({ chat_id: 1, text: "hi" });
    expect(sent.diagnostic).not.toHaveBeenCalled();

    for (const failure of [
      () => json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400),
      () => Promise.reject(new Error(`request to https://api.telegram.org/bot${KEY}/sendMessage failed`)),
    ]) {
      const store = memoryStore({ cursor: "10", scope: BOT_ID });
      const failed = harness({
        store,
        polls: [() => updates(textUpdate(10))],
        processUpdate: async () => reply,
        reply: failure,
      });
      await failed.adapter.run(failed.ctx());
      expect(failed.diagnostic).toHaveBeenCalledTimes(1);
      expect(failed.diagnostic.mock.calls[0]![0]).toBe("reply_failed");
      expect(failed.diagnostic.mock.calls[0]![2]).toMatchObject({ method: "sendMessage" });
      const reported = JSON.stringify(failed.diagnostic.mock.calls);
      expect(reported).not.toContain(KEY);
      expect(reported).not.toContain("chat not found");
      expect(store.current()).toEqual({ cursor: "11", scope: BOT_ID });
    }
  });

  it("still sends the reply when handling the update restarts the session", async () => {
    // A pairing request saves the pending code on the connection; the new revision restarts the runner
    // while the update is still being handled, and the code must still reach the sender.
    const store = memoryStore({ cursor: "10", scope: BOT_ID });
    const h = harness({
      store,
      polls: [() => updates(textUpdate(10), textUpdate(11))],
      processUpdate: async (_connectionId, _update, endSession) => {
        endSession();
        return { method: "sendMessage", chat_id: 777, text: "Pairing code: X" };
      },
    });
    await expect(h.adapter.run(h.ctx())).resolves.toBeUndefined();

    const post = h.calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({ chat_id: 777, text: "Pairing code: X" });
    expect(post?.signalAborted).toBe(false);
    expect(h.diagnostic).not.toHaveBeenCalled();
    // The handled update is stored; the rest of the batch is left to the next session.
    expect(h.processUpdate).toHaveBeenCalledTimes(1);
    expect(store.current()).toEqual({ cursor: "11", scope: BOT_ID });
  });

  it("stops on a rejected key and reports another reader", async () => {
    const rejected = harness({
      store: memoryStore({ cursor: "10", scope: BOT_ID }),
      polls: [() => json({ ok: false, error_code: 401, description: "Unauthorized" }, 401)],
    });
    await expect(rejected.adapter.run(rejected.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);

    const conflict = harness({
      store: memoryStore({ cursor: "10", scope: BOT_ID }),
      polls: [
        () =>
          json({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }, 409),
      ],
    });
    const error = await conflict.adapter.run(conflict.ctx()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelStreamAuthError);
    expect((error as Error).message).toBe(
      "Telegram says another app is reading this bot's messages, or the bot sends them to a web address.",
    );

    const limited = harness({
      store: memoryStore({ cursor: "10", scope: BOT_ID }),
      polls: [() => json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 5" }, 429)],
    });
    await expect(limited.adapter.run(limited.ctx())).rejects.toThrow(/^Telegram returned HTTP 429\.$/);
  });

  it("stops when there is no usable bot key", async () => {
    const missing = harness({ token: undefined });
    const error = await missing.adapter.run(missing.ctx()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelStreamAuthError);
    expect((error as Error).message).toBe("Telegram has no bot key.");
    expect(missing.deps.resolveSecret).toHaveBeenCalledWith(
      expect.objectContaining({ receiveMode: "poll" }),
      "botToken",
      "botTokenEnv",
      "channel.telegram",
      // The stream reads the key as the connection that holds the config.
      missing.ctx().connection,
    );

    const malformed = harness({ token: "not-a-bot-key" });
    const malformedError = await malformed.adapter.run(malformed.ctx()).catch((caught: unknown) => caught);
    expect(malformedError).toBeInstanceOf(ChannelStreamAuthError);
    expect((malformedError as Error).message).not.toContain("not-a-bot-key");
    expect(missing.fetchMock).not.toHaveBeenCalled();
    expect(malformed.fetchMock).not.toHaveBeenCalled();
  });

  it("never puts the bot key in an error", async () => {
    const h = harness({
      store: memoryStore({ cursor: "10", scope: BOT_ID }),
      polls: [
        () => {
          throw new Error(`request to https://api.telegram.org/bot${KEY}/getUpdates failed, reason: ECONNRESET`);
        },
      ],
    });
    const error = await h.adapter.run(h.ctx()).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("GoatCitadel couldn't reach Telegram.");
    expect((error as Error).message).not.toContain(KEY);
    expect(JSON.stringify(h.diagnostic.mock.calls)).not.toContain(KEY);
  });

  it("refuses to poll when api.telegram.org isn't allowed", async () => {
    const h = harness({ allowlisted: false });
    await expect(h.adapter.run(h.ctx())).rejects.toThrow(
      new Error("GoatCitadel isn't allowed to reach api.telegram.org."),
    );
    expect(h.deps.isUrlAllowlisted).toHaveBeenCalledWith("https://api.telegram.org/");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("resolves quietly when the session is aborted mid long-poll", async () => {
    const h = harness({ store: memoryStore({ cursor: "10", scope: BOT_ID }) });
    await expect(h.adapter.run(h.ctx())).resolves.toBeUndefined();
  });
});
