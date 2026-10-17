import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { isMatrixInboundEnabled } from "@goatcitadel/gateway-core";
import { dispatchInboundWebhookMessage } from "../channel-inbound-dispatch.js";
import type { ChannelStreamCursorStore } from "../channel-stream-cursor-store.js";
import {
  ChannelStreamAuthError,
  ChannelStreamRuntimeService,
  type ChannelStreamEvent,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";
import { createMatrixStreamAdapter, type MatrixStreamAdapterDeps } from "./matrix-stream-adapter.js";

const HS = "https://matrix.example.test";
const SELF = "@bot:example.test";

function connection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: "conn-matrix",
    revision: "r1",
    catalogId: "channel.matrix",
    kind: "channel",
    key: "matrix",
    label: "Matrix",
    enabled: true,
    status: "connected",
    config: {
      homeserverUrl: HS,
      accessTokenEnv: "MATRIX_ACCESS_TOKEN",
      inboundStreamEnabled: true,
      ...config,
    },
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryStore(initial?: { cursor: string; scope?: string }) {
  let value = initial;
  const writes: Array<{ cursor: string; scope?: string }> = [];
  const store: ChannelStreamCursorStore = {
    read: async () => value,
    write: async (_channel, _id, next) => {
      value = next;
      writes.push(next);
    },
  };
  return { store, writes, current: () => value };
}

function msg(id: string, extra: Record<string, unknown> = {}, content: Record<string, unknown> = {}) {
  return {
    type: "m.room.message",
    event_id: id,
    sender: "@alice:example.test",
    origin_server_ts: 1760000000000,
    content: { msgtype: "m.text", body: `hello ${id}`, ...content },
    ...extra,
  };
}

function syncBody(nextBatch: string, events: unknown[], roomId = "!room:example.test") {
  return { next_batch: nextBatch, rooms: { join: { [roomId]: { timeline: { events } } } } };
}

interface HarnessOptions {
  /** Responses for non-priming sync calls, in order; after they run out the session aborts. */
  syncs?: Array<() => Response>;
  prime?: () => Response;
  whoami?: () => Response;
  allowlisted?: boolean;
  token?: string | undefined;
  store?: ReturnType<typeof memoryStore>;
  emitFailsAt?: number;
}

function harness(options: HarnessOptions = {}) {
  const controller = new AbortController();
  const syncQueue = [...(options.syncs ?? [])];
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/account/whoami")) return options.whoami ? options.whoami() : json({ user_id: SELF });
    if (url.includes("timeout=0")) return options.prime ? options.prime() : json({ next_batch: "prime-1" });
    const next = syncQueue.shift();
    if (!next) {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    return next();
  });
  const cursor = options.store ?? memoryStore();
  const deps: MatrixStreamAdapterDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    resolveSecret: vi.fn(() => ("token" in options ? options.token : "secret-token")),
    isUrlAllowlisted: vi.fn(() => options.allowlisted ?? true),
    cursorStore: cursor.store,
    longPollTimeoutMs: 1000,
  };
  const adapter = createMatrixStreamAdapter(deps);
  const emitted: ChannelStreamEvent[] = [];
  const markReady = vi.fn();
  const touch = vi.fn();
  const diagnostic = vi.fn();
  let emitCount = 0;
  function ctx(overrides: Partial<ChannelStreamRunContext> & { config?: Record<string, unknown> } = {}) {
    const { config, ...rest } = overrides;
    return {
      connection: connection(config),
      signal: controller.signal,
      cursor: undefined,
      markReady,
      touch,
      emit: async (event: ChannelStreamEvent) => {
        emitCount += 1;
        if (options.emitFailsAt === emitCount) throw new Error("durable accept failed");
        emitted.push(event);
      },
      diagnostic,
      ...rest,
    } as ChannelStreamRunContext;
  }
  return { adapter, deps, fetchMock, urls, emitted, markReady, touch, diagnostic, ctx, cursor, controller };
}

describe("matrix stream adapter", () => {
  it("is inbound-enabled only with the opt-in, homeserver and a token", () => {
    const { adapter } = harness();
    expect(adapter.channelKey).toBe("matrix");
    expect(adapter.isInboundEnabled(connection())).toBe(true);
    expect(adapter.isInboundEnabled(connection({ inboundStreamEnabled: false }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ homeserverUrl: "" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ accessTokenEnv: undefined }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ accessTokenEnv: undefined, accessToken: "keychain:x" }))).toBe(true);
    expect(isMatrixInboundEnabled({ inboundStreamEnabled: true, homeserverUrl: HS, accessToken: "t" })).toBe(true);
    expect(isMatrixInboundEnabled({ inboundStreamEnabled: "true", homeserverUrl: HS, accessToken: "t" })).toBe(false);
    expect(isMatrixInboundEnabled({ homeserverUrl: HS, accessToken: "t" })).toBe(false);
  });

  it("declares idleTimeoutMs as the long-poll timeout plus 60s", () => {
    expect(harness().adapter.idleTimeoutMs).toBe(61_000);
    expect(createMatrixStreamAdapter({ ...harness().deps, longPollTimeoutMs: undefined }).idleTimeoutMs).toBe(90_000);
  });

  it("primes with a limit-0 sync and dispatches no history when no cursor is stored", async () => {
    const h = harness({
      prime: () => json(syncBody("prime-1", [msg("$old")])),
      syncs: [() => json(syncBody("s2", []))],
    });
    await h.adapter.run(h.ctx());
    const primeUrl = new URL(h.urls[1]!);
    expect(primeUrl.pathname).toBe("/_matrix/client/v3/sync");
    expect(primeUrl.searchParams.get("timeout")).toBe("0");
    expect(primeUrl.searchParams.get("since")).toBeNull();
    expect(JSON.parse(primeUrl.searchParams.get("filter")!).room.timeline.limit).toBe(0);
    expect(h.emitted).toEqual([]);
    expect(h.cursor.writes[0]).toEqual({ cursor: "prime-1", scope: SELF });
    expect(h.markReady).toHaveBeenCalledTimes(1);
    expect(new URL(h.urls[2]!).searchParams.get("since")).toBe("prime-1");
  });

  it("resumes from the persisted since after a restart", async () => {
    const store = memoryStore({ cursor: "stored-9", scope: SELF });
    const first = harness({ store, syncs: [() => json(syncBody("stored-10", []))] });
    await first.adapter.run(first.ctx());
    const second = harness({ store, syncs: [() => json(syncBody("stored-11", []))] });
    await second.adapter.run(second.ctx());
    expect(new URL(first.urls[1]!).searchParams.get("since")).toBe("stored-9");
    expect(new URL(second.urls[1]!).searchParams.get("since")).toBe("stored-10");
    expect(second.urls.some((url) => url.includes("timeout=0"))).toBe(false);
    expect(new URL(second.urls[1]!).searchParams.get("timeout")).toBe("1000");
  });

  it("advances the persisted since only after every event in the batch is accepted", async () => {
    const store = memoryStore({ cursor: "old", scope: SELF });
    const h = harness({
      store,
      emitFailsAt: 2,
      syncs: [() => json(syncBody("new", [msg("$a"), msg("$b")]))],
    });
    await expect(h.adapter.run(h.ctx())).rejects.toThrow(/durable accept failed/);
    expect(h.emitted.map((e) => e.message.eventId)).toEqual(["$a"]);
    expect(store.current()).toEqual({ cursor: "old", scope: SELF });
    expect(store.writes).toEqual([]);
  });

  it("ignores the bot's own messages, m.notice, unsupported msgtypes and empty bodies", async () => {
    const h = harness({
      store: memoryStore({ cursor: "c", scope: SELF }),
      syncs: [
        () =>
          json(
            syncBody("n", [
              msg("$self", { sender: SELF }),
              msg("$notice", {}, { msgtype: "m.notice" }),
              msg("$image", {}, { msgtype: "m.image" }),
              msg("$empty", {}, { body: "  " }),
              msg("$state", { type: "m.room.member" }),
              msg("$emote", {}, { msgtype: "m.emote" }),
              msg("$ok"),
            ]),
          ),
      ],
    });
    await h.adapter.run(h.ctx());
    expect(h.emitted.map((e) => e.message.eventId)).toEqual(["$emote", "$ok"]);
  });

  it("emits the exact normalized event", async () => {
    const h = harness({
      store: memoryStore({ cursor: "c", scope: SELF }),
      syncs: [
        () =>
          json(
            syncBody("n", [
              msg("$e1", {}, { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } }),
              msg("$e2"),
            ]),
          ),
      ],
    });
    await h.adapter.run(h.ctx());
    expect(h.emitted[0]).toEqual({
      idempotencyKey: "matrix:conn-matrix:$e1",
      eventType: "matrix-room-message",
      bindingTarget: "!room:example.test",
      responseOptions: { deliveryReplyToMessageId: "$e1" },
      message: {
        eventId: "$e1",
        account: "conn-matrix",
        room: "!room:example.test",
        actorId: "@alice:example.test",
        actorType: "user",
        content: "hello $e1",
        threadId: "$root",
        metadata: { roomId: "!room:example.test", originServerTs: 1760000000000, msgtype: "m.text" },
      },
    });
    expect(h.emitted[1]?.message.threadId).toBeUndefined();
  });

  it("derives identical idempotency keys when the same batch is replayed in two sessions", async () => {
    const batch = () => json(syncBody("n", [msg("$dup")]));
    const first = harness({ store: memoryStore({ cursor: "c", scope: SELF }), syncs: [batch] });
    const second = harness({ store: memoryStore({ cursor: "c", scope: SELF }), syncs: [batch] });
    await first.adapter.run(first.ctx());
    await second.adapter.run(second.ctx());
    expect(first.emitted).toHaveLength(1);
    expect(first.emitted[0]).toEqual(second.emitted[0]);
  });

  it("discards a stored cursor whose whoami scope changed", async () => {
    const store = memoryStore({ cursor: "other-account", scope: "@someone-else:example.test" });
    const h = harness({ store, syncs: [() => json(syncBody("n", []))] });
    await h.adapter.run(h.ctx());
    expect(h.urls[1]).toContain("timeout=0");
    expect(h.urls.some((url) => url.includes("other-account"))).toBe(false);
    expect(store.writes[0]).toEqual({ cursor: "prime-1", scope: SELF });
  });

  it("uses the in-memory ctx cursor when nothing is stored", async () => {
    const h = harness({ syncs: [() => json(syncBody("n", []))] });
    await h.adapter.run(h.ctx({ cursor: "mem-1" }));
    expect(new URL(h.urls[1]!).searchParams.get("since")).toBe("mem-1");
  });

  it("sends bearer auth, refuses redirects and marks ready on the first sync", async () => {
    const h = harness({ store: memoryStore({ cursor: "c", scope: SELF }), syncs: [() => json(syncBody("n", []))] });
    await h.adapter.run(h.ctx());
    const init = h.fetchMock.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
    expect(init?.redirect).toBe("error");
    expect(h.markReady).toHaveBeenCalledTimes(1);
    expect(h.touch).toHaveBeenCalled();
  });

  it("throws ChannelStreamAuthError for 401 and M_UNKNOWN_TOKEN, and a plain error for other failures", async () => {
    const unauthorized = harness({ whoami: () => json({ errcode: "M_UNKNOWN_TOKEN", error: "x" }, 401) });
    await expect(unauthorized.adapter.run(unauthorized.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    const errcodeOnly = harness({
      store: memoryStore({ cursor: "c", scope: SELF }),
      syncs: [() => json({ errcode: "M_UNKNOWN_TOKEN" }, 200)],
    });
    await expect(errcodeOnly.adapter.run(errcodeOnly.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    const forbidden = harness({ whoami: () => new Response("nope", { status: 403 }) });
    await expect(forbidden.adapter.run(forbidden.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    const failing = harness({ whoami: () => json({ errcode: "M_UNKNOWN" }, 500) });
    const error = await failing.adapter.run(failing.ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelStreamAuthError);
  });

  it("throws ChannelStreamAuthError for a homeserver outside the allowlist, before any request", async () => {
    const h = harness({ allowlisted: false });
    await expect(h.adapter.run(h.ctx())).rejects.toThrow(/Matrix homeserver is not in the outbound allowlist/);
    await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("throws ChannelStreamAuthError when the token cannot be resolved", async () => {
    const h = harness({ token: undefined });
    await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("requests lean filters: priming drops state and ephemeral, incremental lazy-loads members with a timeline limit", async () => {
    const h = harness({ syncs: [() => json(syncBody("n", []))] });
    await h.adapter.run(h.ctx());
    const prime = JSON.parse(new URL(h.urls[1]!).searchParams.get("filter")!);
    expect(prime.room).toEqual({
      timeline: { limit: 0 },
      state: { lazy_load_members: true, types: [] },
      ephemeral: { types: [] },
    });
    const incremental = JSON.parse(new URL(h.urls[2]!).searchParams.get("filter")!);
    expect(incremental.room).toEqual({
      timeline: { types: ["m.room.message"], limit: 100 },
      state: { lazy_load_members: true },
      ephemeral: { types: [] },
    });
  });

  it("discards a rejected since token, re-primes, reports it and keeps going", async () => {
    const store = memoryStore({ cursor: "stale", scope: SELF });
    const h = harness({
      store,
      prime: () => json({ next_batch: "fresh" }),
      syncs: [
        () => json({ errcode: "M_UNKNOWN_POS", error: "Invalid stream token" }, 400),
        () => json(syncBody("after", [msg("$new")])),
      ],
    });
    await h.adapter.run(h.ctx());
    expect(h.diagnostic).toHaveBeenCalledWith(
      "matrix.stream.since_rejected",
      "Matrix rejected the stored sync token; re-primed. Messages in the gap were skipped.",
    );
    expect(store.writes[0]).toEqual({ cursor: "fresh", scope: SELF });
    expect(new URL(h.urls[3]!).searchParams.get("since")).toBe("fresh");
    expect(h.emitted.map((e) => e.message.eventId)).toEqual(["$new"]);
    expect(h.markReady).toHaveBeenCalledTimes(1);
  });

  it("does not re-prime on 429 or 5xx, and includes only the errcode in the error", async () => {
    for (const status of [429, 500]) {
      const h = harness({
        store: memoryStore({ cursor: "c", scope: SELF }),
        syncs: [() => json({ errcode: "M_LIMIT_EXCEEDED", error: "secret detail" }, status)],
      });
      const error = (await h.adapter.run(h.ctx()).catch((e: unknown) => e)) as Error;
      expect(error.message).toBe(`Matrix sync request failed (${status} M_LIMIT_EXCEEDED)`);
      expect(h.diagnostic).not.toHaveBeenCalled();
    }
  });

  it("reports limited timelines by room count only", async () => {
    const body = {
      next_batch: "n",
      rooms: {
        join: {
          "!a:x": { timeline: { limited: true, events: [] } },
          "!b:x": { timeline: { limited: false, events: [] } },
          "!c:x": { timeline: { limited: true, events: [] } },
        },
      },
    };
    const h = harness({ store: memoryStore({ cursor: "c", scope: SELF }), syncs: [() => json(body)] });
    await h.adapter.run(h.ctx());
    expect(h.diagnostic).toHaveBeenCalledWith("matrix.stream.timeline_limited", expect.not.stringContaining("!a:x"), {
      roomCount: 2,
    });
  });

  it("a persistent 4xx after re-priming rethrows instead of looping", async () => {
    const prime = vi.fn(() => json({ next_batch: "fresh" }));
    const h = harness({
      store: memoryStore({ cursor: "stale", scope: SELF }),
      prime,
      syncs: [
        () => json({ errcode: "M_UNKNOWN_POS" }, 400),
        () => json({ errcode: "M_UNKNOWN_POS" }, 400),
        () => json({ errcode: "M_UNKNOWN_POS" }, 400),
      ],
    });
    await expect(h.adapter.run(h.ctx())).rejects.toThrow(/Matrix sync request failed .400 M_UNKNOWN_POS/);
    expect(prime).toHaveBeenCalledTimes(1);
    expect(h.diagnostic).toHaveBeenCalledTimes(1);
  });

  it("re-primes again after an incremental sync succeeded in between", async () => {
    const prime = vi.fn(() => json({ next_batch: "fresh" }));
    const h = harness({
      store: memoryStore({ cursor: "stale", scope: SELF }),
      prime,
      syncs: [
        () => json({ errcode: "M_UNKNOWN_POS" }, 400),
        () => json(syncBody("ok", [])),
        () => json({ errcode: "M_UNKNOWN_POS" }, 400),
        () => json(syncBody("ok2", [])),
      ],
    });
    await h.adapter.run(h.ctx());
    expect(prime).toHaveBeenCalledTimes(2);
  });

  it("408 is rethrown, not re-primed", async () => {
    const prime = vi.fn(() => json({ next_batch: "fresh" }));
    const h = harness({
      store: memoryStore({ cursor: "c", scope: SELF }),
      prime,
      syncs: [() => json({ errcode: "M_UNKNOWN" }, 408)],
    });
    await expect(h.adapter.run(h.ctx())).rejects.toThrow(/request failed .408 /);
    expect(prime).not.toHaveBeenCalled();
  });

  it("resolves quietly when the session is aborted mid long-poll", async () => {
    const h = harness({ store: memoryStore({ cursor: "c", scope: SELF }) });
    await expect(h.adapter.run(h.ctx())).resolves.toBeUndefined();
  });

  it("never reaches durable acceptance for a sender missing from an allowlist (real dispatch gate)", async () => {
    const h = harness({
      store: memoryStore({ cursor: "c", scope: SELF }),
      syncs: [() => json(syncBody("n", [msg("$blocked")]))],
    });
    const acceptInboundChannelEvent = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const recordDevDiagnostic = vi.fn();
    const conn = connection({ inboundAccessMode: "allowlist", allowedSenders: ["@someone-else:example.test"] });
    const runtime = new ChannelStreamRuntimeService({
      listConnections: async () => [conn],
      adapters: [h.adapter],
      dispatch: (c, event) =>
        dispatchInboundWebhookMessage({ acceptInboundChannelEvent, recordDevDiagnostic } as never, {
          channel: c.key,
          connectionId: c.connectionId,
          idempotencyKey: event.idempotencyKey,
          eventType: event.eventType,
          bindingTarget: event.bindingTarget,
          inboundAccessConfig: c.config,
          acceptedConnectionRevision: c.revision,
          message: event.message,
        }),
      recordDevDiagnostic,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    await runtime.sync();
    await vi.waitFor(() =>
      expect(recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
      ),
    );
    await runtime.close();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });
});
