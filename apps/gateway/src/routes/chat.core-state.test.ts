import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import { registerChatMessageRoutes } from "./chat.messages.js";
let app: FastifyInstance;
const thread = vi.fn(); const binding = vi.fn(); const prefs = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  thread.mockResolvedValue({ sessionId: "s1", turns: [] });
  binding.mockResolvedValue({ sessionId: "s1", transport: "llm" });
  prefs.mockResolvedValue({ sessionId: "s1", revision: 7 });
  app = Fastify();
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers["x-test-denied"]) return reply.code(401).send({ error: "Operator access required" });
  });
  app.addHook("onRequest", async request => {
    if (request.headers["x-test-purpose"]) {
      request.authActorSource = "companion"; request.authPrincipalPurpose = "session_control_client";
      request.authCompanionSessionId = "companion-1";
    }
  });
  app.decorate("services", { chatMessages: { getChatThread: thread }, chatSessions: { getChatSessionBinding: binding }, chatSupport: { getChatSessionPrefs: prefs } } as never);
  registerChatMessageRoutes(app);
});
afterEach(async () => { await app.close(); });
it("combines existing canonical owners in one private operator read", async () => {
  const result = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/s1/core-state" });
  expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("private, no-store");
  expect(result.json()).toEqual({ sessionId: "s1", thread: { sessionId: "s1", turns: [] }, binding: { sessionId: "s1", transport: "llm" }, prefs: { sessionId: "s1", revision: 7 } });
  expect(thread).toHaveBeenCalledExactlyOnceWith("s1", { includeDecisionTrace: false });
  expect(binding).toHaveBeenCalledExactlyOnceWith("s1"); expect(prefs).toHaveBeenCalledExactlyOnceWith("s1");
});
it("preserves refreshes that deliberately exclude the transcript and nullable binding", async () => {
  binding.mockResolvedValue(null);
  const result = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/s1/core-state?includeThread=false" });
  expect(result.statusCode).toBe(200); expect(result.json()).not.toHaveProperty("thread"); expect(result.json().binding).toBeNull(); expect(thread).not.toHaveBeenCalled();
});
it.each(["?includeThread=maybe", "?unrecognized=true"])("rejects invalid input before reads: %s", async query => {
  const result = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/s1/core-state" + query });
  expect(result.statusCode).toBe(400); expect(thread).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled(); expect(prefs).not.toHaveBeenCalled();
});
it.each([{ "x-test-denied": "1" }, { "x-test-purpose": "1" }])("does not expose preferences through denied or purpose-bound access", async headers => {
  const result = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/s1/core-state", headers });
  expect([401, 403]).toContain(result.statusCode); expect(thread).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled(); expect(prefs).not.toHaveBeenCalled();
});
it("reports a missing canonical conversation explicitly", async () => {
  thread.mockRejectedValue(new NotFoundError({ entity: "chat session", id: "s1" }));
  const result = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/s1/core-state" }); expect(result.statusCode).toBe(404); expect(result.json()).not.toHaveProperty("thread");
});
it("preserves a failed owner without returning a partial successful core or leaking errors", async () => {
  prefs.mockRejectedValue(new Error("Bearer synthetic-private-fixture"));
  const result = await app.inject({ method: "GET", url: "/api/v1/chat/sessions/s1/core-state" }); expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: "Internal server error" });
});
