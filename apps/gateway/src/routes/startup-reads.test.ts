import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startupReadRoutes } from "./startup-reads.js";
import { withRouteAccess } from "./route-access.js";
import { registerChatMessagingRoutes } from "./chat.messaging.js";
let app: FastifyInstance;
const reads = vi.fn();
const row = (path: string, correlationId = "row-one") => ({ path, correlationId, originSurface: "chat" });
const url = (items: unknown) => "/api/v1/startup-reads?" + new URLSearchParams({ reads: JSON.stringify(items) });
beforeEach(async () => {
  reads.mockReset();
  app = Fastify();
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers.authorization !== "Bearer test-operator")
      return reply.code(401).send({ error: "Operator access required" });
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-purpose"]) {
      request.authActorSource = "companion";
      request.authPrincipalPurpose = "session_control_client";
      request.authCompanionSessionId = "client-1";
    }
  });
  app.get("/api/v1/settings", withRouteAccess(app, "operator"), async (request, reply) => {
    reads({
      address: request.ip,
      peer: request.raw.socket.remoteAddress,
      authorization: request.headers.authorization,
      correlation: request.headers["x-goatcitadel-correlation-id"],
      origin: request.headers.origin,
      host: request.headers.host,
    });
    reply.header("set-cookie", "custody=test-cookie; HttpOnly");
    return { revision: 3 };
  });
  app.get("/api/v1/approvals/:id", withRouteAccess(app, "operator"), async (request, reply) => {
    reads(request.params);
    return reply.code(404).send({ error: "Record missing" });
  });
  await app.register(startupReadRoutes);
});
afterEach(async () => {
  await app.close();
});
it("preserves caller peer, original guards, cookie custody and individual record outcomes", async () => {
  const response = await app.inject({
    method: "GET",
    url: url([row("/api/v1/settings"), row("/api/v1/approvals/missing", "row-two")]),
    remoteAddress: "203.0.113.8",
    headers: {
      authorization: "Bearer test-operator",
      origin: "http://trusted-ui.example",
      host: "gateway.example:8787",
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers["set-cookie"]).toEqual(["custody=test-cookie; HttpOnly"]);
  const body = response.json();
  expect(body.items.map((item: { status: number }) => item.status)).toEqual([200, 404]);
  expect(JSON.parse(body.items[0].bodyText)).toEqual({ revision: 3 });
  expect(JSON.parse(body.items[1].bodyText)).toEqual({ error: "Record missing" });
  expect(JSON.stringify(body)).not.toContain("test-cookie");
  expect(reads).toHaveBeenCalledWith(
    expect.objectContaining({
      address: "203.0.113.8",
      peer: "203.0.113.8",
      authorization: "Bearer test-operator",
      correlation: "row-one",
      origin: "http://trusted-ui.example",
      host: "gateway.example:8787",
    }),
  );
});
it.each([{}, { authorization: "Bearer test-operator", "x-test-purpose": "session_control_client" }])(
  "rejects unauthorized or purpose-restricted callers before dispatch",
  async (headers) => {
    const response = await app.inject({ method: "GET", url: url([row("/api/v1/settings")]), headers });
    expect([401, 403]).toContain(response.statusCode);
    expect(reads).not.toHaveBeenCalled();
  },
);
it.each([
  [],
  {},
  Array.from({ length: 17 }, () => row("/api/v1/settings")),
  [row("https://elsewhere.example/api/v1/settings")],
  [row("/api/v1/secrets")],
  [row("/api/v1/settings?token=forbidden")],
  [row("/api/v1/chat/sessions/s1/send")],
  [{ ...row("/api/v1/settings"), method: "POST" }],
  [row("/api/v1/settings", "bad\r\nheader")],
  [row("/api/v1/settings#fragment")],
])("rejects unsupported batch shapes and paths before reads: %j", async (items) => {
  const response = await app.inject({
    method: "GET",
    url: url(items),
    headers: { authorization: "Bearer test-operator" },
  });
  expect(response.statusCode).toBe(400);
  expect(reads).not.toHaveBeenCalled();
});

it("batches Messaging through its original scoped reader with equivalent private responses", async () => {
  await app.close();
  app = Fastify();
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers.authorization !== "Bearer test-operator")
      return reply.code(401).send({ error: "Operator access required" });
  });
  const listChatMessaging = vi.fn(async (input: { workspaceId?: string; actor?: string }) => ({
    workspaceId: input.workspaceId ?? "default",
    channels: [
      {
        connectionId: "connection-one",
        channelKey: "telegram",
        label: "Telegram",
        status: "on",
        conversations: [
          {
            sessionId: "conversation-one",
            title: "Fixture conversation",
            kind: "direct",
            own: true,
            lastActivityAt: "2026-11-04T00:00:00.000Z",
            lastReadAt: "2026-11-03T00:00:00.000Z",
            newMessageCount: input.actor === JSON.stringify(["token", "operator-a"]) ? 7 : 0,
          },
        ],
      },
    ],
  }));
  app.decorate("services", { chatSessions: { listChatMessaging } } as never);
  app.addHook("onRequest", async (request) => {
    request.authActorSource = "token";
    request.authActorId = "operator-a";
    if (request.headers["x-test-purpose"]) {
      request.authActorSource = "companion";
      request.authPrincipalPurpose = "session_control_client";
      request.authCompanionSessionId = "client-1";
    }
  });
  registerChatMessagingRoutes(app);
  await app.register(startupReadRoutes);
  const headers = { authorization: "Bearer test-operator" };
  const paths = ["/api/v1/chat/messaging?workspaceId=workspace-a", "/api/v1/chat/messaging?workspaceId=workspace-b"];
  const direct = await Promise.all(paths.map((path) => app.inject({ method: "GET", url: path, headers })));
  listChatMessaging.mockClear();
  const response = await app.inject({ method: "GET", url: url(paths.map((path) => row(path))), headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  const items = response.json().items;
  expect(items.map((item: { status: number }) => item.status)).toEqual([200, 200]);
  expect(items.map((item: { bodyText: string }) => JSON.parse(item.bodyText))).toEqual(
    direct.map((result) => result.json()),
  );
  expect(
    items.every((item: { headers: Record<string, string> }) => item.headers["cache-control"] === "private, no-store"),
  ).toBe(true);
  expect(listChatMessaging.mock.calls.map(([input]) => input)).toEqual([
    { workspaceId: "workspace-a", actor: JSON.stringify(["token", "operator-a"]) },
    { workspaceId: "workspace-b", actor: JSON.stringify(["token", "operator-a"]) },
  ]);
  expect(items[0].bodyText).toContain('"newMessageCount":7');
  for (const invalidHeaders of [{}, { ...headers, "x-test-purpose": "session_control_client" }]) {
    listChatMessaging.mockClear();
    const denied = await app.inject({ method: "GET", url: url([row(paths[0]!)]), headers: invalidHeaders });
    expect([401, 403]).toContain(denied.statusCode);
    expect(listChatMessaging).not.toHaveBeenCalled();
  }
  const invalid = await app.inject({ method: "GET", url: url([row("/api/v1/chat/messaging/private")]), headers });
  expect(invalid.statusCode).toBe(400);
  const forgedReader = await app.inject({
    method: "GET",
    url: url([row("/api/v1/chat/messaging?workspaceId=workspace-a&actor=operator-b")]),
    headers,
  });
  expect(forgedReader.statusCode).toBe(400);
});
