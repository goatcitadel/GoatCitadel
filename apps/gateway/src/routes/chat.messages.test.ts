import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { chatRoutes } from "./chat.js";

describe("chat message routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists chat messages with cursor and limit", async () => {
    const rawMessages = [
      {
        messageId: "m1",
        sessionId: "sess-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "User supplied Authorization: Bearer user-owned-secret",
        timestamp: "2026-03-05T01:00:00.000Z",
      },
      {
        messageId: "m2",
        sessionId: "sess-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Tool returned Authorization: Bearer assistant-leaked-secret",
        timestamp: "2026-03-05T01:00:01.000Z",
      },
    ] as const;
    const listChatMessages = vi.fn(async () => rawMessages);
    app = Fastify();
    app.decorate("services", { chatMessages: { listChatMessages } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/messages?limit=10&cursor=m2",
    });
    expect(response.statusCode).toBe(200);
    expect(listChatMessages).toHaveBeenCalledWith("sess-1", 10, "m2");
    expect(response.json()).toMatchObject({
      items: [
        {
          messageId: "m1",
          sessionId: "sess-1",
          content: "User supplied Authorization: Bearer user-owned-secret",
        },
        {
          messageId: "m2",
          sessionId: "sess-1",
          content: "Tool returned Authorization: [REDACTED]",
        },
      ],
    });
    expect(rawMessages[1].content).toContain("assistant-leaked-secret");
  });

  it("requests compact decision trace hydration only when explicitly included", async () => {
    const getChatThread = vi.fn(async () => ({
      sessionId: "sess-1",
      turns: [],
    }));
    app = Fastify();
    app.decorate("services", { chatMessages: { getChatThread } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/thread?includeDecisionTrace=true",
    });

    expect(response.statusCode).toBe(200);
    expect(getChatThread).toHaveBeenCalledWith("sess-1", { includeDecisionTrace: true });
  });

  it("rejects invalid decision trace include flags without loading the thread", async () => {
    const getChatThread = vi.fn();
    app = Fastify();
    app.decorate("services", { chatMessages: { getChatThread } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/thread?includeDecisionTrace=yes",
    });

    expect(response.statusCode).toBe(400);
    expect(getChatThread).not.toHaveBeenCalled();
    expect(response.json().error.fieldErrors).toHaveProperty("includeDecisionTrace");
  });

  it("returns migration guidance for the removed POST /messages write path", async () => {
    const sendChatMessage = vi.fn();
    app = Fastify();
    app.decorate("services", { chatMessages: { sendChatMessage } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/messages",
      payload: {
        content: "Hello",
      },
    });
    expect(response.statusCode).toBe(410);
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("POST /messages has been removed"),
    });
  });

  it("returns validation error for missing content", async () => {
    const sendChatMessage = vi.fn();
    app = Fastify();
    app.decorate("services", { chatMessages: { sendChatMessage } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/messages",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it("preflights routes and requires a fresh route decision before agent sends", async () => {
    const routeDecision = {
      action: "send" as const,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestedProviderId: "openai",
      requestedModel: "gpt-5.4",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4",
      selectionSource: "manual" as const,
      fallbackPolicy: "off" as const,
      fallbackResult: "not_applicable" as const,
      runtimeReachability: "not_checked" as const,
      runtimeClass: "cloud" as const,
      fingerprint: "route-fingerprint",
    };
    const routePreflight = vi.fn(async () => ({ decision: routeDecision }));
    const agentSendChatMessage = vi.fn(async () => ({
      sessionId: "sess-1",
      turnId: "turn-1",
      assistantMessage: { messageId: "assistant-1", content: "ok" },
    }));
    app = Fastify();
    app.decorate("services", { chatMessages: { routePreflight, agentSendChatMessage } } as never);
    await app.register(chatRoutes);

    const preflight = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/route-preflight",
      payload: { action: "send", providerId: "openai", model: "gpt-5.4", mode: "chat" },
    });
    expect(preflight.statusCode).toBe(200);
    expect(routePreflight).toHaveBeenCalledWith("sess-1", {
      action: "send",
      providerId: "openai",
      model: "gpt-5.4",
      mode: "chat",
    });

    const missingDecision = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: { content: "hello", providerId: "openai", model: "gpt-5.4" },
    });
    expect(missingDecision.statusCode).toBe(409);
    expect(agentSendChatMessage).not.toHaveBeenCalled();

    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision,
      },
    });
    expect(sent.statusCode).toBe(200);
    expect(agentSendChatMessage).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
      }),
    );
  });

  it("rejects stale, mismatched, blocked, and changed route decisions", async () => {
    const baseDecision = {
      action: "send" as const,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4",
      selectionSource: "global" as const,
      fallbackPolicy: "off" as const,
      fallbackResult: "not_applicable" as const,
      runtimeReachability: "not_checked" as const,
      runtimeClass: "cloud" as const,
      fingerprint: "accepted",
    };
    const routePreflight = vi
      .fn()
      .mockResolvedValueOnce({ decision: { ...baseDecision, fingerprint: "new" } })
      .mockResolvedValueOnce({ decision: baseDecision, blockedReason: "No model configured" });
    const agentSendChatMessage = vi.fn();
    app = Fastify();
    app.decorate("services", { chatMessages: { routePreflight, agentSendChatMessage } } as never);
    await app.register(chatRoutes);

    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: { ...baseDecision, expiresAt: new Date(Date.now() - 1000).toISOString() },
      },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.reason).toBe("route_decision_expired");

    const effectiveMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
        routeDecision: baseDecision,
      },
    });
    expect(effectiveMismatch.statusCode).toBe(409);
    expect(effectiveMismatch.json().error.reason).toBe("route_effective_mismatch");

    const fingerprintMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: baseDecision,
      },
    });
    expect(fingerprintMismatch.statusCode).toBe(409);
    expect(fingerprintMismatch.json().error.reason).toBe("route_fingerprint_mismatch");

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: baseDecision,
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.reason).toBe("route_blocked");
    expect(agentSendChatMessage).not.toHaveBeenCalled();
  });
});
