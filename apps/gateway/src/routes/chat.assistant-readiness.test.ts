import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import { registerChatAssistantReadinessRoutes } from "./chat.assistant-readiness.js";
it("requires operator access, binds the selected workspace and performs no mutation on a view", async () => {
  const app = Fastify(),
    read = vi.fn(async (sessionId: string, workspaceId?: string) => {
      if (workspaceId !== "A") throw new NotFoundError({ entity: "Chat session", id: sessionId });
      return { sessionId, workspaceId, items: [] };
    });
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers.authorization !== "Bearer fixture") return reply.code(401).send({ error: "Unauthorized" });
  });
  app.decorate("services", { chatAssistantSupport: { getAssistantReadiness: read } } as never);
  registerChatAssistantReadinessRoutes(app);
  try {
    expect((await app.inject({ url: "/api/v1/chat/sessions/s/assistant-readiness?workspaceId=A" })).statusCode).toBe(
      401,
    );
    expect(read).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          url: "/api/v1/chat/sessions/s/assistant-readiness?workspaceId=B",
          headers: { authorization: "Bearer fixture" },
        })
      ).statusCode,
    ).toBe(404);
    const result = await app.inject({
      url: "/api/v1/chat/sessions/s/assistant-readiness?workspaceId=A",
      headers: { authorization: "Bearer fixture" },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(read).toHaveBeenLastCalledWith("s", "A");
  } finally {
    await app.close();
  }
});
it("prepares only server-selected setup for the authenticated actor, rejecting caller authority and effects", async () => {
  const app = Fastify(),
    prepare = vi.fn(async () => ({ planId: "review" }));
  app.decorate("requireOperatorAuth", async (request) => {
    request.authActorId = "operator";
  });
  app.decorate("services", { chatAssistantSupport: { prepareAssistantSetup: prepare } } as never);
  registerChatAssistantReadinessRoutes(app);
  try {
    const body = {
        workspaceId: "A",
        itemId: "memory",
        expectedSourceHash: "a".repeat(64),
        operationId: "operation-1234567890",
      },
      url = "/api/v1/chat/sessions/s/assistant-readiness/setup";
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { ...body, actorId: "other", request: { kind: "arbitrary" } },
        })
      ).statusCode,
    ).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url, payload: body })).statusCode).toBe(201);
    expect(prepare).toHaveBeenCalledWith({ ...body, sessionId: "s" }, "operator");
  } finally {
    await app.close();
  }
});
it("uses the existing server-owned local actor under the operator access gate when auth is disabled", async () => {
  const app = Fastify(),
    prepare = vi.fn(async () => ({ planId: "review" }));
  app.decorate("requireOperatorAuth", async () => {});
  app.decorate("services", { chatAssistantSupport: { prepareAssistantSetup: prepare } } as never);
  registerChatAssistantReadinessRoutes(app);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/s/assistant-readiness/setup",
      payload: {
        workspaceId: "A",
        itemId: "memory",
        expectedSourceHash: "a".repeat(64),
        operationId: "operation-1234567890",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s", workspaceId: "A" }), "ip:127.0.0.1");
  } finally {
    await app.close();
  }
});
