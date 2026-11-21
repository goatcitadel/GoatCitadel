import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerChatContinuationRoutes } from "./chat.continuations.js";
it("views are read only, renewals require exact hash and authenticated operator identity", async () => {
  const app = Fastify(),
    inspect = vi.fn(async () => ({ status: "blocked" })),
    prepare = vi.fn(async () => ({ status: "review_required" }));
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers.authorization !== "Bearer fixture") return reply.code(401).send({ error: "Unauthorized" });
    request.authActorId = "fixture-operator";
  });
  app.decorate("services", {
    chatAssistantSupport: { inspectChatContinuation: inspect, prepareChatContinuation: prepare },
  } as never);
  registerChatContinuationRoutes(app);
  const url = "/api/v1/chat/sessions/s/continuations",
    body = { workspaceId: "w", approvalId: "a", reason: "approval_expired" };
  try {
    expect((await app.inject({ url: `${url}?${new URLSearchParams(body)}` })).statusCode).toBe(401);
    const headers = { authorization: "Bearer fixture" };
    expect((await app.inject({ url: `${url}?${new URLSearchParams(body)}`, headers })).statusCode).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    expect((await app.inject({ url, method: "POST", headers, payload: body })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url,
          method: "POST",
          headers,
          payload: { ...body, expectedSourceHash: "a".repeat(64), actorId: "spoof" },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({
      url,
      method: "POST",
      headers,
      payload: { ...body, expectedSourceHash: "a".repeat(64) },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(prepare).toHaveBeenLastCalledWith({
      ...body,
      sessionId: "s",
      expectedSourceHash: "a".repeat(64),
      actorId: "fixture-operator",
    });
  } finally {
    await app.close();
  }
});
