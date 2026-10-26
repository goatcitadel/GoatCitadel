import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError, type ChatMessagingOverview } from "@goatcitadel/contracts";
import { registerChatMessagingRoutes } from "./chat.messaging.js";

const overview: ChatMessagingOverview = {
  workspaceId: "default",
  channels: [
    {
      connectionId: "conn-1",
      channelKey: "telegram",
      label: "Telegram",
      status: "on",
      conversations: [
        {
          sessionId: "sess-1",
          title: "Sam Lee",
          kind: "direct",
          own: true,
          lastActivityAt: "2026-03-05T01:00:05.000Z",
          lastReadAt: "2026-03-05T01:00:02.000Z",
          newMessageCount: 2,
        },
      ],
    },
  ],
};

/** A token-authenticated operator, as the auth plugin would resolve one. */
const OPERATOR = { "x-test-source": "token", "x-test-actor": "operator-1" };
/** The reader identity that operator reads as (the same form the Inbox uses). */
const OPERATOR_IDENTITY = JSON.stringify(["token", "operator-1"]);

function buildApp(chatSessions: Record<string, unknown>): FastifyInstance {
  const app = Fastify();
  app.decorate("services", { chatSessions } as never);
  app.decorateRequest("authActorId", "");
  app.decorateRequest("authActorSource", "none");
  app.decorateRequest("authPrincipalPurpose", null);
  app.addHook("onRequest", async (request) => {
    const header = (name: string) => (typeof request.headers[name] === "string" ? String(request.headers[name]) : "");
    request.authActorId = header("x-test-actor");
    request.authActorSource = (header("x-test-source") || "none") as typeof request.authActorSource;
    request.authPrincipalPurpose = (header("x-test-purpose") || undefined) as typeof request.authPrincipalPurpose;
  });
  registerChatMessagingRoutes(app);
  return app;
}

describe("chat messaging routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("returns the messaging overview for the requested workspace and operator", async () => {
    const service = { listChatMessaging: vi.fn(async () => overview), markChatSessionRead: vi.fn() };
    app = buildApp(service);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/messaging?workspaceId=default",
      headers: OPERATOR,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(overview);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(service.listChatMessaging).toHaveBeenCalledWith({ workspaceId: "default", actor: OPERATOR_IDENTITY });
  });

  it("reads as the signed-in operator, or as the one local operator when nobody signs in", async () => {
    const service = { listChatMessaging: vi.fn(async () => overview), markChatSessionRead: vi.fn() };
    app = buildApp(service);
    const get = (headers: Record<string, string>) =>
      app!.inject({ method: "GET", url: "/api/v1/chat/messaging", headers });

    await get({ "x-test-source": "basic", "x-test-actor": "basic:sam" });
    expect(service.listChatMessaging).toHaveBeenLastCalledWith({
      workspaceId: undefined,
      actor: JSON.stringify(["basic", "basic:sam"]),
    });

    // Auth mode none (the shipped default) and a trusted loopback request have one operator: the local one.
    for (const headers of [
      {},
      { "x-test-source": "none", "x-test-actor": "auth:none" },
      { "x-test-source": "loopback", "x-test-actor": "loopback:127.0.0.1" },
      { "x-test-source": "loopback", "x-test-actor": "loopback:[::1]" },
    ]) {
      const response = await get(headers);
      expect(response.statusCode).toBe(200);
      expect(service.listChatMessaging).toHaveBeenLastCalledWith({ workspaceId: undefined, actor: "local-operator" });
    }

    // Any other caller (a companion, a paired device, a purpose-bound or anonymous token) has no identity here.
    for (const headers of [
      { "x-test-source": "token", "x-test-actor": "anonymous" },
      { "x-test-source": "token", "x-test-actor": "" },
      { "x-test-source": "device", "x-test-actor": "device:phone" },
      { "x-test-source": "companion", "x-test-actor": "companion:1" },
      { "x-test-source": "sse", "x-test-actor": "sse:abc" },
      { "x-test-source": "token", "x-test-actor": "operator-1", "x-test-purpose": "session_control_client" },
    ]) {
      const response = await get(headers);
      expect(response.statusCode).toBe(200);
      expect(service.listChatMessaging).toHaveBeenLastCalledWith({ workspaceId: undefined, actor: undefined });
    }
  });

  it("rejects a workspace id that is blank or malformed", async () => {
    const service = { listChatMessaging: vi.fn(), markChatSessionRead: vi.fn() };
    app = buildApp(service);

    for (const workspaceId of ["", "has space", "x".repeat(81)]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/chat/messaging?workspaceId=${encodeURIComponent(workspaceId)}`,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.listChatMessaging).not.toHaveBeenCalled();
  });

  it("redacts secret-shaped text in titles before they leave the gateway", async () => {
    const secretTitle = "Deploy keys sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const service = {
      listChatMessaging: vi.fn(async () => ({
        ...overview,
        channels: [
          {
            ...overview.channels[0]!,
            conversations: [{ ...overview.channels[0]!.conversations[0]!, title: secretTitle }],
          },
        ],
      })),
      markChatSessionRead: vi.fn(),
    };
    app = buildApp(service);

    const response = await app.inject({ method: "GET", url: "/api/v1/chat/messaging?workspaceId=default" });

    expect(response.statusCode).toBe(200);
    const title = response.json<ChatMessagingOverview>().channels[0]?.conversations[0]?.title ?? "";
    expect(title).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(title).toContain("Deploy keys");
  });

  it("records a read marker for the operator and answers with the marker that stands", async () => {
    const service = {
      listChatMessaging: vi.fn(),
      markChatSessionRead: vi.fn(async () => ({ sessionId: "sess-1", lastReadAt: "2026-03-05T01:00:05.000Z" })),
    };
    app = buildApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/read",
      headers: OPERATOR,
      payload: { readThrough: "2026-03-05T01:00:05.000Z" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: "sess-1", lastReadAt: "2026-03-05T01:00:05.000Z" });
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(service.markChatSessionRead).toHaveBeenCalledWith({
      sessionId: "sess-1",
      actor: OPERATOR_IDENTITY,
      readThrough: "2026-03-05T01:00:05.000Z",
    });
  });

  it("rejects a read request whose readThrough is not an ISO timestamp", async () => {
    const service = { listChatMessaging: vi.fn(), markChatSessionRead: vi.fn() };
    app = buildApp(service);

    for (const payload of [
      { readThrough: "yesterday" },
      { readThrough: "2026" },
      { readThrough: 5 },
      {},
      { readThrough: "" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/read",
        headers: OPERATOR,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.markChatSessionRead).not.toHaveBeenCalled();
  });

  it("answers 404 when the session is unknown", async () => {
    const service = {
      listChatMessaging: vi.fn(),
      markChatSessionRead: vi.fn(async () => {
        throw new NotFoundError({ entity: "Chat session", id: "sess-missing" });
      }),
    };
    app = buildApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-missing/read",
      headers: OPERATOR,
      payload: { readThrough: "2026-03-05T01:00:05.000Z" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("records read state for the local operator under auth mode none and on loopback", async () => {
    const service = {
      listChatMessaging: vi.fn(),
      markChatSessionRead: vi.fn(async () => ({ sessionId: "sess-1", lastReadAt: "2026-03-05T01:00:05.000Z" })),
    };
    app = buildApp(service);

    for (const headers of [
      {},
      { "x-test-source": "none", "x-test-actor": "auth:none" },
      { "x-test-source": "loopback", "x-test-actor": "loopback:127.0.0.1" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/read",
        headers,
        payload: { readThrough: "2026-03-05T01:00:05.000Z" },
      });
      expect(response.statusCode).toBe(200);
      expect(service.markChatSessionRead).toHaveBeenLastCalledWith({
        sessionId: "sess-1",
        actor: "local-operator",
        readThrough: "2026-03-05T01:00:05.000Z",
      });
    }
  });

  it("refuses to record read state when the request has no operator identity", async () => {
    const service = { listChatMessaging: vi.fn(), markChatSessionRead: vi.fn() };
    app = buildApp(service);

    // A companion, a paired device and a purpose-bound token are not the operator reading their conversations.
    for (const headers of [
      { "x-test-source": "companion", "x-test-actor": "companion:1" },
      { "x-test-source": "device", "x-test-actor": "device:phone" },
      { "x-test-source": "token", "x-test-actor": "anonymous" },
      { "x-test-source": "token", "x-test-actor": "operator-1", "x-test-purpose": "session_control_client" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/read",
        headers,
        payload: { readThrough: "2026-03-05T01:00:05.000Z" },
      });
      expect(response.statusCode).toBe(409);
    }
    expect(service.markChatSessionRead).not.toHaveBeenCalled();
  });
});
