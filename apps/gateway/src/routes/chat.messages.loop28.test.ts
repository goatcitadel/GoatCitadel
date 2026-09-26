import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { chatRoutes } from "./chat.js";

describe("chat message route-decision tails", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("replays session-selected provider preferences before retrying a turn", async () => {
    const decision = routeDecision({
      action: "retry",
      turnId: "turn-1",
      selectionSource: "session",
      requestedProviderId: "anthropic",
      requestedModel: "claude-sonnet-4-6",
      effectiveProviderId: "anthropic",
      effectiveModel: "claude-sonnet-4-6",
      fingerprint: "session-route",
    });
    const routePreflight = vi.fn(async () => ({ decision }));
    const retryChatTurn = vi.fn(async () => ({ turnId: "retry-1", status: "queued" }));
    app = buildApp({ routePreflight, retryChatTurn });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-1/retry",
      payload: {
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
        routeDecision: decision,
        prefsOverride: {
          mode: "cowork",
          webMode: "deep",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(routePreflight).toHaveBeenCalledWith("sess-1", {
      action: "retry",
      turnId: "turn-1",
      providerId: undefined,
      model: undefined,
      mode: undefined,
      webMode: undefined,
      thinkingLevel: undefined,
      speedMode: undefined,
      subagentPolicy: undefined,
      prefsOverride: {
        mode: "chat",
        webMode: "deep",
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });
    expect(retryChatTurn).toHaveBeenCalledWith(
      "sess-1",
      "turn-1",
      expect.objectContaining({
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
      }),
      undefined,
    );
  });

  it("replays manual selections before editing a turn", async () => {
    const decision = routeDecision({
      action: "edit",
      turnId: "turn-2",
      selectionSource: "manual",
      requestedProviderId: "openai",
      requestedModel: "gpt-5.4",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4",
      fingerprint: "manual-route",
    });
    const routePreflight = vi.fn(async () => ({ decision }));
    const editChatTurn = vi.fn(async () => ({ turnId: "turn-2", status: "queued" }));
    app = buildApp({ routePreflight, editChatTurn });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-2/edit",
      payload: {
        content: "edited",
        providerId: "openai",
        model: "gpt-5.4",
        mode: "code",
        webMode: "off",
        thinkingLevel: "minimal",
        speedMode: "fast",
        subagentPolicy: "off",
        routeDecision: decision,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(routePreflight).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        action: "edit",
        turnId: "turn-2",
        content: "edited",
        providerId: "openai",
        model: "gpt-5.4",
        mode: "chat",
        webMode: "off",
        thinkingLevel: "minimal",
        speedMode: "fast",
        subagentPolicy: "off",
        prefsOverride: undefined,
      }),
    );
    expect(editChatTurn).toHaveBeenCalledWith(
      "sess-1",
      "turn-2",
      expect.objectContaining({ content: "edited" }),
      undefined,
    );
  });

  it("preserves permission profile, override, and policy linkage through turn entry routes", async () => {
    const governance = {
      permissionProfileId: "profile-release",
      localOperatorOverrideId: "override-release",
      policyRunId: "run-release",
      policyTaskId: "task-release",
    };
    const sendDecision = routeDecision({ action: "send", fingerprint: "send-governed" });
    const retryDecision = routeDecision({ action: "retry", turnId: "turn-1", fingerprint: "retry-governed" });
    const editDecision = routeDecision({ action: "edit", turnId: "turn-2", fingerprint: "edit-governed" });
    const routePreflight = vi.fn(async (_sessionId: string, input: { action: string; turnId?: string }) => {
      if (input.action === "retry") {
        return { decision: retryDecision };
      }
      if (input.action === "edit") {
        return { decision: editDecision };
      }
      return { decision: sendDecision };
    });
    const agentSendChatMessage = vi.fn(async () => ({ turnId: "turn-send", status: "queued" }));
    const agentSendChatMessageStream = vi.fn(async function* () {
      yield { type: "status", message: "queued" };
    });
    const retryChatTurn = vi.fn(async () => ({ turnId: "turn-retry", status: "queued" }));
    const editChatTurn = vi.fn(async () => ({ turnId: "turn-edit", status: "queued" }));
    const assertCallerPolicyScope = vi.fn(async () => undefined);
    app = buildApp(
      {
        routePreflight,
        agentSendChatMessage,
        agentSendChatMessageStream,
        retryChatTurn,
        editChatTurn,
      },
      { assertCallerPolicyScope },
    );

    const send = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "send governed",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: sendDecision,
        ...governance,
      },
    });
    expect(send.statusCode).toBe(200);

    const stream = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send/stream",
      payload: {
        content: "stream governed",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: sendDecision,
        ...governance,
      },
    });
    expect(stream.statusCode).toBe(200);

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-1/retry",
      payload: {
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: retryDecision,
        ...governance,
      },
    });
    expect(retry.statusCode).toBe(200);

    const edit = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-2/edit",
      payload: {
        content: "edit governed",
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: editDecision,
        ...governance,
      },
    });
    expect(edit.statusCode).toBe(200);

    expect(agentSendChatMessage).toHaveBeenCalledWith("sess-1", expect.objectContaining(governance), undefined);
    expect(agentSendChatMessageStream).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining(governance),
      expect.anything(),
      expect.objectContaining({ markCommitted: expect.any(Function) }),
      undefined,
    );
    expect(retryChatTurn).toHaveBeenCalledWith("sess-1", "turn-1", expect.objectContaining(governance), undefined);
    expect(editChatTurn).toHaveBeenCalledWith("sess-1", "turn-2", expect.objectContaining(governance), undefined);
    expect(assertCallerPolicyScope).toHaveBeenCalledTimes(4);
    for (const call of assertCallerPolicyScope.mock.calls as unknown[][]) {
      expect(call).toEqual(["sess-1", { policyRunId: "run-release", policyTaskId: "task-release" }]);
    }
  });

  it("rejects policy ids that do not belong to the session before any turn entry route acts", async () => {
    const services = {
      routePreflight: vi.fn(),
      agentSendChatMessage: vi.fn(),
      agentSendChatMessageStream: vi.fn(),
      retryChatTurn: vi.fn(),
      retryChatTurnStream: vi.fn(),
      editChatTurn: vi.fn(),
      editChatTurnStream: vi.fn(),
    };
    const assertCallerPolicyScope = vi.fn(async () => {
      throw new ConflictError({ message: "policyRunId foreign-run does not belong to Chat session sess-1." });
    });
    app = buildApp(services, { assertCallerPolicyScope });
    const foreign = { policyRunId: "foreign-run", policyTaskId: "foreign-task" };

    for (const [url, payload] of [
      ["/api/v1/chat/sessions/sess-1/agent-send", { content: "hi", ...foreign }],
      ["/api/v1/chat/sessions/sess-1/agent-send/stream", { content: "hi", ...foreign }],
      ["/api/v1/chat/sessions/sess-1/route-preflight", { action: "send", content: "hi", ...foreign }],
      ["/api/v1/chat/sessions/sess-1/turns/turn-1/retry", { ...foreign }],
      ["/api/v1/chat/sessions/sess-1/turns/turn-1/retry/stream", { ...foreign }],
      ["/api/v1/chat/sessions/sess-1/turns/turn-1/edit", { content: "edited", ...foreign }],
      ["/api/v1/chat/sessions/sess-1/turns/turn-1/edit/stream", { content: "edited", ...foreign }],
    ] as const) {
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode, url).toBe(409);
      expect(response.json()).toMatchObject({
        error: "policyRunId foreign-run does not belong to Chat session sess-1.",
      });
    }

    expect(assertCallerPolicyScope).toHaveBeenCalledTimes(7);
    for (const service of Object.values(services)) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it("rejects action, turn, invalid expiry, and route-preflight failures before mutating", async () => {
    const routePreflight = vi.fn(async () => {
      throw new Error("preflight unavailable");
    });
    const retryChatTurn = vi.fn();
    app = buildApp({ routePreflight, retryChatTurn });

    const actionMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-1/retry",
      payload: {
        routeDecision: routeDecision({ action: "send", fingerprint: "wrong-action" }),
      },
    });
    expect(actionMismatch.statusCode).toBe(409);
    expect(actionMismatch.json().error.reason).toBe("route_action_mismatch");

    const turnMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-1/retry",
      payload: {
        routeDecision: routeDecision({ action: "retry", turnId: "turn-2", fingerprint: "wrong-turn" }),
      },
    });
    expect(turnMismatch.statusCode).toBe(409);
    expect(turnMismatch.json().error.reason).toBe("route_action_mismatch");

    const invalidExpiry = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-1/retry",
      payload: {
        routeDecision: {
          ...routeDecision({ action: "retry", turnId: "turn-1", fingerprint: "invalid-expiry" }),
          expiresAt: "not-a-date",
        },
      },
    });
    expect(invalidExpiry.statusCode).toBe(400);

    const failedPreflight = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-1/retry",
      payload: {
        providerId: "openai",
        model: "gpt-5.4",
        routeDecision: routeDecision({ action: "retry", turnId: "turn-1", fingerprint: "preflight-error" }),
      },
    });
    expect(failedPreflight.statusCode).toBe(400);
    expect(failedPreflight.json().error).toBe("Chat write failed. Check gateway diagnostics and retry.");
    expect(retryChatTurn).not.toHaveBeenCalled();
  });
});

function buildApp(
  chatMessages: Record<string, unknown>,
  chatSupport: Record<string, unknown> = { assertCallerPolicyScope: vi.fn(async () => undefined) },
): FastifyInstance {
  const next = Fastify();
  next.decorate("requireOperatorAuth", async () => undefined);
  next.decorate("services", { chatMessages, chatSupport } as never);
  void next.register(chatRoutes);
  return next;
}

function routeDecision(overrides: Record<string, unknown> = {}) {
  return {
    ...routeDecisionShape(),
    ...overrides,
  };
}

function routeDecisionShape() {
  return {
    action: "send" as const,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
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
}
