import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerChatFollowThroughSetupRoutes } from "./chat.follow-through-setup.js";
it("reads setup without creating work, requires exact reviewed material, and supplies creator identity from auth only", async () => {
  const app = Fastify(),
    inspect = vi.fn(async () => ({ sourceHash: "a".repeat(64) })),
    create = vi.fn(async () => ({ jobId: "saved" }));
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers.authorization !== "Bearer fixture") return reply.code(401).send({ error: "Unauthorized" });
    request.authActorId = "fixture-operator";
  });
  app.decorate("services", {
    chatSupport: { inspectFollowThroughSetup: inspect, createFollowThroughSetup: create },
  } as never);
  registerChatFollowThroughSetupRoutes(app);
  const url = "/api/v1/chat/sessions/s/follow-through/setup",
    headers = { authorization: "Bearer fixture" };
  try {
    expect((await app.inject({ url: `${url}?workspaceId=w` })).statusCode).toBe(401);
    expect((await app.inject({ url: `${url}?workspaceId=w`, headers })).statusCode).toBe(200);
    expect(create).not.toHaveBeenCalled();
    const body = {
      workspaceId: "w",
      expectedSetupHash: "a".repeat(64),
      operationId: "operation-1234567890",
      purpose: "Inspect the result",
      permissionProfileId: "safe",
      trigger: { kind: "once", at: "2027-01-01T09:00:00.000Z", timezone: "UTC" },
      delivery: { kind: "conversation" },
    };
    expect(
      (await app.inject({ url, method: "POST", headers, payload: { ...body, actorId: "spoof" } })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url,
          method: "POST",
          headers,
          payload: { ...body, delivery: { kind: "channel", target: "arbitrary" } },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ url, method: "POST", headers, payload: body })).statusCode).toBe(201);
    expect(create).toHaveBeenCalledExactlyOnceWith({ ...body, sessionId: "s", actorId: "fixture-operator" });
  } finally {
    await app.close();
  }
});
