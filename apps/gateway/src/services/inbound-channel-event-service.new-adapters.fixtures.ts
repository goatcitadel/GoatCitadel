// Test-only fixtures: build DurableInboundChannelAcceptInput values from the REAL
// ntfy / Mattermost / Signal / Matrix adapter output and the real Google Chat normalizer,
// mirroring exactly what the stream runtime and the Google Chat route hand to the
// durable acceptance boundary (acceptance input is secret-free).
import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { DurableInboundChannelAcceptInput } from "./channel-inbound-dispatch.js";
import type { ChannelStreamEvent, ChannelStreamRunContext } from "./channel-stream-runtime-service.js";
import {
  createMattermostStreamAdapter,
  type MattermostWebSocketLike,
} from "./channel-stream-adapters/mattermost-stream-adapter.js";
import { createMatrixStreamAdapter } from "./channel-stream-adapters/matrix-stream-adapter.js";
import { createNtfyStreamAdapter } from "./channel-stream-adapters/ntfy-stream-adapter.js";
import { createSignalStreamAdapter } from "./channel-stream-adapters/signal-stream-adapter.js";
import { normalizeGoogleChatEvent } from "./google-chat-webhook.js";

export interface NewAdapterCase {
  name: string;
  input: DurableInboundChannelAcceptInput;
  expectedKey: string;
}

function connection(key: string, connectionId: string, config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId,
    revision: "r1",
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label: key,
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

function recordingCtx(conn: IntegrationConnection, emitted: ChannelStreamEvent[]): ChannelStreamRunContext {
  return {
    connection: conn,
    signal: new AbortController().signal,
    cursor: undefined,
    markReady: () => undefined,
    touch: () => undefined,
    emit: async (event: ChannelStreamEvent) => {
      emitted.push(event);
    },
    diagnostic: () => undefined,
  } as ChannelStreamRunContext;
}

/** Same mapping as channel-stream-runtime-registry's dispatch, minus the secret-bearing access config. */
function toAcceptInput(conn: IntegrationConnection, event: ChannelStreamEvent): DurableInboundChannelAcceptInput {
  return {
    channel: conn.key,
    connectionId: conn.connectionId,
    idempotencyKey: event.idempotencyKey,
    eventType: event.eventType,
    bindingTarget: event.bindingTarget,
    acceptedConnectionRevision: conn.revision,
    message: event.message,
    dispatchKind: "agent_turn",
  };
}

function streamBody(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

class FakeWebSocket implements MattermostWebSocketLike {
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(): void {}
  close(): void {}
  private fire(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void {
    this.fire("open");
  }
  push(payload: unknown): void {
    this.fire("message", { data: JSON.stringify(payload) });
  }
  end(): void {
    this.fire("close");
  }
}

async function buildNtfy(): Promise<NewAdapterCase> {
  const conn = connection("ntfy", "conn-ntfy", {
    baseUrl: "https://ntfy.example.test",
    topic: "ops",
    tokenEnv: "NTFY_TOKEN",
    inboundStreamEnabled: true,
  });
  const line = {
    id: "msg1",
    time: 1760000000,
    event: "message",
    topic: "ops",
    title: "Deploy",
    message: "ship it",
    tags: ["rocket"],
  };
  const adapter = createNtfyStreamAdapter({
    fetch: (async () => streamBody([`${JSON.stringify(line)}\n`])) as unknown as typeof fetch,
    resolveSecret: () => "secret-token",
    isUrlAllowlisted: () => true,
  });
  const emitted: ChannelStreamEvent[] = [];
  await adapter.run(recordingCtx(conn, emitted));
  return { name: "ntfy", input: toAcceptInput(conn, emitted[0]!), expectedKey: "ntfy:conn-ntfy:msg1" };
}

async function buildMattermost(): Promise<NewAdapterCase> {
  const conn = connection("mattermost", "conn-mm", {
    serverUrl: "https://chat.example.test",
    botTokenEnv: "MATTERMOST_BOT_TOKEN",
    defaultChannel: "town-square",
    inboundStreamEnabled: true,
  });
  const sockets: FakeWebSocket[] = [];
  const adapter = createMattermostStreamAdapter({
    fetch: (async () =>
      new Response(JSON.stringify({ id: "bot-user-id" }), { status: 200 })) as unknown as typeof fetch,
    resolveSecret: () => "bot-secret",
    isUrlAllowlisted: () => true,
    createWebSocket: (url: string) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const emitted: ChannelStreamEvent[] = [];
  const run = adapter.run(recordingCtx(conn, emitted));
  while (sockets.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  const socket = sockets[0]!;
  socket.open();
  socket.push({
    event: "posted",
    seq: 7,
    data: {
      channel_type: "O",
      channel_name: "town-square",
      sender_name: "@alice",
      team_id: "team1",
      post: JSON.stringify({
        id: "post1",
        channel_id: "chan1",
        user_id: "user1",
        root_id: "",
        type: "",
        message: "hello bot",
      }),
    },
  });
  socket.end();
  await run;
  return { name: "mattermost", input: toAcceptInput(conn, emitted[0]!), expectedKey: "mattermost:conn-mm:post1" };
}

async function buildSignal(): Promise<NewAdapterCase> {
  const conn = connection("signal", "conn-signal", {
    baseUrl: "http://127.0.0.1:8080",
    accountId: "+15550000000",
    defaultRecipient: "+15557654321",
    receiveEvents: true,
  });
  const notification = {
    jsonrpc: "2.0",
    method: "receive",
    params: {
      account: "+15550000000",
      envelope: {
        source: "+15551112222",
        sourceNumber: "+15551112222",
        sourceUuid: "a1b2c3d4-0000-4000-8000-000000000001",
        sourceName: "Alice",
        timestamp: 1760000000000,
        dataMessage: { timestamp: 1760000000001, message: "hello goat" },
      },
    },
  };
  const adapter = createSignalStreamAdapter({
    fetch: (async () =>
      streamBody([`event: receive\ndata: ${JSON.stringify(notification)}\n\n`])) as unknown as typeof fetch,
    isUrlAllowlisted: () => true,
  });
  const emitted: ChannelStreamEvent[] = [];
  await adapter.run(recordingCtx(conn, emitted));
  return {
    name: "signal",
    input: toAcceptInput(conn, emitted[0]!),
    expectedKey: "signal:conn-signal:a1b2c3d4-0000-4000-8000-000000000001:1760000000001",
  };
}

async function buildMatrix(): Promise<NewAdapterCase> {
  const conn = connection("matrix", "conn-matrix", {
    homeserverUrl: "https://matrix.example.test",
    accessTokenEnv: "MATRIX_ACCESS_TOKEN",
    inboundStreamEnabled: true,
  });
  const controller = new AbortController();
  const message = {
    type: "m.room.message",
    event_id: "$evt1",
    sender: "@alice:example.test",
    origin_server_ts: 1760000000000,
    content: { msgtype: "m.text", body: "hello bot" },
  };
  let polled = false;
  const adapter = createMatrixStreamAdapter({
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("/account/whoami")) return reply({ user_id: "@bot:example.test" });
      if (url.includes("timeout=0")) return reply({ next_batch: "prime-1" });
      if (polled) {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      polled = true;
      return reply({
        next_batch: "s2",
        rooms: { join: { "!room:example.test": { timeline: { events: [message] } } } },
      });
    }) as unknown as typeof fetch,
    resolveSecret: () => "matrix-secret",
    isUrlAllowlisted: () => true,
    cursorStore: { read: async () => undefined, write: async () => undefined },
    longPollTimeoutMs: 1000,
  });
  const emitted: ChannelStreamEvent[] = [];
  await adapter.run({ ...recordingCtx(conn, emitted), signal: controller.signal });
  return { name: "matrix", input: toAcceptInput(conn, emitted[0]!), expectedKey: "matrix:conn-matrix:$evt1" };
}

function buildGoogleChat(): NewAdapterCase {
  const connectionId = "conn-gchat";
  const parsed = normalizeGoogleChatEvent({
    connectionId,
    payload: {
      type: "MESSAGE",
      eventTime: "2026-10-16T00:00:00Z",
      message: {
        name: "spaces/S/messages/M",
        text: "hello",
        sender: { name: "users/123", displayName: "Ada", email: "ada@example.com", type: "HUMAN" },
        space: { name: "spaces/S" },
        thread: { name: "spaces/S/threads/T" },
      },
      space: { name: "spaces/S", type: "ROOM" },
    },
  });
  if (parsed.kind !== "message") throw new Error(`Google Chat fixture was ignored: ${parsed.reason}`);
  return {
    name: "google-chat",
    expectedKey: `google-chat:${connectionId}:spaces/S/messages/M`,
    input: {
      channel: "google-chat",
      connectionId,
      idempotencyKey: `google-chat:${connectionId}:${parsed.eventId}`,
      eventType: "MESSAGE",
      bindingTarget: parsed.space,
      acceptedConnectionRevision: "rev-1",
      dispatchKind: "agent_turn",
      message: {
        eventId: parsed.eventId,
        account: connectionId,
        room: parsed.space,
        threadId: parsed.threadName,
        actorId: parsed.actorId,
        displayName: parsed.displayName,
        content: parsed.content,
        metadata: parsed.metadata,
      },
      responseOptions: { deliveryReplyToMessageId: parsed.threadName ?? parsed.eventId },
    },
  };
}

export async function buildNewAdapterCases(): Promise<NewAdapterCase[]> {
  return [await buildNtfy(), await buildMattermost(), await buildSignal(), await buildMatrix(), buildGoogleChat()];
}
