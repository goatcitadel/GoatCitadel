import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatChangePlanRoutes } from "./chat.change-plans.js";

const plan = {
  planId: "plan-1",
  sessionId: "session-1",
  requesterActorId: "operator-test",
  kind: "session_model" as const,
  scope: "current_chat" as const,
  status: "awaiting_confirmation" as const,
  revision: 1,
  expectedTargetRevision: 3,
  request: { kind: "session_model" as const, providerId: "openai", model: "gpt-5", thinkingLevel: "extended" as const },
  title: "Use GPT-5 in this chat",
  summary: "Switch only this conversation to OpenAI / GPT-5.",
  expiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

describe("chat change-plan routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function createApp(overrides: Record<string, unknown> = {}) {
    const chatSupport = {
      createChatChangePlan: vi.fn(async () => plan),
      listChatChangePlans: vi.fn(async () => [plan]),
      confirmChatChangePlan: vi.fn(async () => ({ ...plan, status: "applied", revision: 2 })),
      cancelChatChangePlan: vi.fn(async () => ({ ...plan, status: "cancelled", revision: 2 })),
      ...overrides,
    };
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorate("services", { chatSupport } as never);
    registerChatChangePlanRoutes(app);
    return chatSupport;
  }

  it("accepts a bounded model request, server-stamps its actor, and never receives arbitrary settings", async () => {
    const chatSupport = createApp();

    const created = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/change-plans",
      payload: { kind: "session_model", providerId: "openai", model: "gpt-5", thinkingLevel: "extended" },
    });
    expect(created.statusCode).toBe(201);
    expect(chatSupport.createChatChangePlan).toHaveBeenCalledWith("session-1", {
      requesterActorId: "operator-test",
      request: { kind: "session_model", providerId: "openai", model: "gpt-5", thinkingLevel: "extended" },
    });

    const rejected = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/change-plans",
      payload: { kind: "session_model", model: "gpt-5", rawSettings: { apiKey: "do-not-store" } },
    });
    expect(rejected.statusCode).toBe(400);
    expect(chatSupport.createChatChangePlan).toHaveBeenCalledTimes(1);
  });

  it("awaits the plan list and forwards revision-fenced confirmation and cancellation", async () => {
    const chatSupport = createApp();

    const listed = await app!.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/session-1/change-plans?limit=12",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [plan] });
    expect(chatSupport.listChatChangePlans).toHaveBeenCalledWith("session-1", 12);

    const confirmed = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/change-plans/plan-1/confirm",
      payload: { expectedRevision: 1 },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(chatSupport.confirmChatChangePlan).toHaveBeenCalledWith("session-1", "plan-1", 1);

    const cancelled = await app!.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/session-1/change-plans/plan-1/cancel",
      payload: { expectedRevision: 1 },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(chatSupport.cancelChatChangePlan).toHaveBeenCalledWith("session-1", "plan-1", 1);
  });
});
