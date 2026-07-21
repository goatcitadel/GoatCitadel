import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
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

  it("scopes capability-profile inspection to the authenticated operator and workspace", async () => {
    const getChatTurnCapabilityProfile = vi
      .fn()
      .mockResolvedValueOnce({ state: "available", profile: { profileId: "profile-1" } })
      .mockRejectedValueOnce(new NotFoundError({ entity: "chat turn capability profile", id: "turn-1" }));
    app = Fastify();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { authActorId?: string }).authActorId = "operator-1";
    });
    app.decorate("services", { chatMessages: { getChatTurnCapabilityProfile } } as never);
    await app.register(chatRoutes);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/capability-profile?workspaceId=workspace-1",
    });
    expect(allowed.statusCode).toBe(200);
    expect(getChatTurnCapabilityProfile).toHaveBeenLastCalledWith("session-1", "turn-1", {
      workspaceId: "workspace-1",
      operatorId: "operator-1",
    });

    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/capability-profile?workspaceId=other-workspace",
    });
    expect(denied.statusCode).toBe(404);
    expect(JSON.stringify(denied.json())).not.toContain("profile-1");
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

  it("rejects malformed or duplicate routed context before either send path reaches Chat persistence", async () => {
    const agentSendChatMessage = vi.fn();
    const agentSendChatMessageStream = vi.fn();
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, agentSendChatMessageStream } } as never);
    await app.register(chatRoutes);

    const invalidContextRefs = [
      [],
      [{ kind: "url", ref: "https://example.test" }],
      [{ kind: "attachment", ref: " attachment-1" }],
      [{ kind: "attachment", ref: "attachment/../secret" }],
      [{ kind: "attachment", ref: "attachment\nsecret" }],
      [{ kind: "memory_item", ref: "memory-1", label: "line\nbreak" }],
      [{ kind: "attachment", ref: "attachment-1", unknown: true }],
      [
        { kind: "memory_item", ref: "memory-1" },
        { kind: "memory_item", ref: "memory-1" },
      ],
      Array.from({ length: 17 }, (_, index) => ({ kind: "attachment", ref: `attachment-${index}` })),
    ];
    for (const url of ["/api/v1/chat/sessions/sess-1/agent-send", "/api/v1/chat/sessions/sess-1/agent-send/stream"]) {
      for (const contextRefs of invalidContextRefs) {
        const response = await app.inject({
          method: "POST",
          url,
          payload: { content: "hello", contextRefs },
        });
        expect(response.statusCode).toBe(400);
      }
    }
    expect(agentSendChatMessage).not.toHaveBeenCalled();
    expect(agentSendChatMessageStream).not.toHaveBeenCalled();
  });

  it("admits only the exact model-council opt-in and preserves it for Chat execution", async () => {
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
      fingerprint: "model-council-route",
    };
    const routePreflight = vi.fn(async () => ({ decision: routeDecision }));
    const agentSendChatMessage = vi.fn(async () => ({
      sessionId: "sess-1",
      turnId: "turn-1",
      assistantMessage: { messageId: "assistant-1", content: "one answer" },
    }));
    const agentSendChatMessageStream = vi.fn();
    app = Fastify();
    app.decorate("services", {
      chatMessages: { routePreflight, agentSendChatMessage, agentSendChatMessageStream },
    } as never);
    await app.register(chatRoutes);

    for (const modelCouncil of [
      false,
      true,
      null,
      {},
      { enabled: false },
      { enabled: true, extra: true },
      { unknown: true },
    ]) {
      for (const url of ["/api/v1/chat/sessions/sess-1/agent-send", "/api/v1/chat/sessions/sess-1/agent-send/stream"]) {
        const response = await app.inject({
          method: "POST",
          url,
          payload: { content: "hello", modelCouncil },
        });
        expect(response.statusCode).toBe(400);
      }
    }

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision,
        modelCouncil: { enabled: true },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(agentSendChatMessage).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ modelCouncil: { enabled: true } }),
      undefined,
    );
    expect(agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(agentSendChatMessageStream).not.toHaveBeenCalled();
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
      capabilityCompactionDimensionHash: "a".repeat(64),
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
        routeDecision: expect.objectContaining({
          capabilityCompactionDimensionHash: "a".repeat(64),
        }),
      }),
      undefined,
    );
  });

  it("preserves max and ultra thinking levels through the governed Chat send boundary", async () => {
    const routeDecision = {
      action: "send" as const,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestedProviderId: "fireworks",
      requestedModel: "accounts/goat/models/reasoner",
      effectiveProviderId: "fireworks",
      effectiveModel: "accounts/goat/models/reasoner",
      selectionSource: "manual" as const,
      fallbackPolicy: "off" as const,
      fallbackResult: "not_applicable" as const,
      runtimeReachability: "not_checked" as const,
      runtimeClass: "cloud" as const,
      fingerprint: "reasoning-profile-route",
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

    for (const thinkingLevel of ["max", "ultra"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/agent-send",
        payload: {
          content: "think carefully",
          providerId: "fireworks",
          model: "accounts/goat/models/reasoner",
          thinkingLevel,
          routeDecision,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(agentSendChatMessage).toHaveBeenLastCalledWith(
        "sess-1",
        expect.objectContaining({ thinkingLevel }),
        undefined,
      );
    }

    expect(agentSendChatMessage).toHaveBeenCalledTimes(2);
  });

  it("accepts routed context only with the exact fresh route fingerprint", async () => {
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
      capabilityFingerprint: "pre-context-capabilities",
      fingerprint: "pre-context-route",
    };
    const routePreflight = vi
      .fn()
      .mockResolvedValueOnce({ decision: routeDecision })
      .mockResolvedValueOnce({
        decision: {
          ...routeDecision,
          capabilityFingerprint: "unrelated-capability-drift",
          fingerprint: "changed-capability-route",
        },
      });
    const agentSendChatMessage = vi.fn(async () => ({
      sessionId: "sess-1",
      turnId: "turn-1",
      assistantMessage: { messageId: "assistant-1", content: "ok" },
    }));
    app = Fastify();
    app.decorate("services", { chatMessages: { routePreflight, agentSendChatMessage } } as never);
    await app.register(chatRoutes);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
        contextRefs: [{ kind: "memory_item", ref: "memory-1" }],
        routeDecision,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(agentSendChatMessage).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ contextRefs: [{ kind: "memory_item", ref: "memory-1" }] }),
      undefined,
    );

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "hello",
        providerId: "openai",
        model: "gpt-5.4",
        contextRefs: [{ kind: "memory_item", ref: "memory-1" }],
        routeDecision,
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.reason).toBe("route_fingerprint_mismatch");
    expect(agentSendChatMessage).toHaveBeenCalledTimes(1);
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
