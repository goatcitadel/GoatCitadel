import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { IntegrationDeliveryPostCommitError } from "../services/chat-turn-dispatch-service.js";
import { registerChatMessageRoutes } from "./chat.messages.js";

type MutationStatus = "pending" | "completed" | "failed";

class FakeMutationIdempotencyStore {
  private readonly rows = new Map<string, { payloadHash: string; status: MutationStatus }>();

  public claim(input: MutationKey & { payloadHash: string }) {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (!existing || existing.status === "failed") {
      this.rows.set(key, { payloadHash: input.payloadHash, status: "pending" });
      return { outcome: "claimed" as const, record: { status: "pending" } };
    }
    if (existing.payloadHash !== input.payloadHash) {
      return { outcome: "payload_mismatch" as const, record: existing };
    }
    return {
      outcome: existing.status === "pending" ? ("in_progress" as const) : ("duplicate" as const),
      record: existing,
    };
  }

  public markCompleted(input: MutationKey): void {
    this.updateStatus(input, "completed");
  }

  public markFailed(input: MutationKey): void {
    this.updateStatus(input, "failed");
  }

  private updateStatus(input: MutationKey, status: MutationStatus): void {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (existing) {
      this.rows.set(key, { ...existing, status });
    }
  }

  private toKey(input: MutationKey): string {
    return [input.method, input.routePath, input.idempotencyKey, input.actorScope ?? ""].join("|");
  }
}

interface MutationKey {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope?: string;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("non-stream Chat route commit truth", () => {
  it.each([
    {
      label: "send",
      methodName: "agentSendChatMessage",
      url: "/api/v1/chat/sessions/session-1/agent-send",
      payload: { content: "hello", routeDecision: routeDecision("send") },
    },
    {
      label: "retry",
      methodName: "retryChatTurn",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/retry",
      payload: { routeDecision: routeDecision("retry", "turn-1") },
    },
    {
      label: "edit",
      methodName: "editChatTurn",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/edit",
      payload: { content: "updated", routeDecision: routeDecision("edit", "turn-1") },
    },
    {
      label: "branch select",
      methodName: "selectChatBranchTurn",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/select",
      payload: {},
    },
    {
      label: "prompt response",
      methodName: "answerChatUserInputPrompt",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/user-input/prompt-1/respond",
      payload: { response: { kind: "text", text: "continue" } },
    },
    {
      label: "cancel",
      methodName: "cancelChatTurn",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/cancel",
      payload: {},
    },
  ])("keeps the $label idempotency key committed when response delivery fails", async (scenario) => {
    const mutation = vi.fn(async () => ({ turnId: "turn-1", status: "completed" }));
    const app = Fastify();
    apps.push(app);
    app.decorate("services", {
      chatMessages: {
        routePreflight: vi.fn(async () => ({ decision: { fingerprint: "route-fingerprint-1" } })),
        [scenario.methodName]: mutation,
      },
    } as never);
    await app.register(idempotencyHeaderPlugin, {
      mutationStore: new FakeMutationIdempotencyStore() as never,
    });
    registerChatMessageRoutes(app);
    let failResponse = true;
    app.addHook("onSend", async (request, reply, payload) => {
      if (failResponse && request.url === scenario.url && reply.statusCode < 400) {
        failResponse = false;
        throw new Error("response delivery unavailable");
      }
      return payload;
    });

    const request = {
      method: "POST" as const,
      url: scenario.url,
      headers: { "idempotency-key": `chat-${scenario.label}` },
      payload: scenario.payload,
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(409);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "send",
      methodName: "agentSendChatMessage",
      url: "/api/v1/chat/sessions/session-1/agent-send",
      payload: { content: "hello", routeDecision: routeDecision("send") },
    },
    {
      label: "retry",
      methodName: "retryChatTurn",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/retry",
      payload: { routeDecision: routeDecision("retry", "turn-1") },
    },
    {
      label: "edit",
      methodName: "editChatTurn",
      url: "/api/v1/chat/sessions/session-1/turns/turn-1/edit",
      payload: { content: "updated", routeDecision: routeDecision("edit", "turn-1") },
    },
  ])("does not repeat a $label whose integration delivery already committed", async (scenario) => {
    const mutation = vi.fn(async () => {
      throw new IntegrationDeliveryPostCommitError(
        "turn-1",
        {
          status: "sent",
          deliveryId: "delivery-1",
          providerMessageId: `grat_${"b".repeat(43)}`,
          idempotencyKey: "internal-delivery-key",
        },
        new Error("local bookkeeping unavailable"),
      );
    });
    const app = Fastify();
    apps.push(app);
    app.decorate("services", {
      chatMessages: {
        routePreflight: vi.fn(async () => ({ decision: { fingerprint: "route-fingerprint-1" } })),
        [scenario.methodName]: mutation,
      },
    } as never);
    await app.register(idempotencyHeaderPlugin, {
      mutationStore: new FakeMutationIdempotencyStore() as never,
    });
    registerChatMessageRoutes(app);

    const request = {
      method: "POST" as const,
      url: scenario.url,
      headers: { "idempotency-key": `chat-committed-${scenario.label}` },
      payload: scenario.payload,
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(first.json()).toMatchObject({
      code: "mutation_committed",
      retryable: false,
      turnId: "turn-1",
      deliveryEvidence: {
        status: "sent",
        deliveryId: "delivery-1",
        providerMessageId: "[REDACTED]",
      },
    });
    expect(first.json()).not.toHaveProperty("deliveryEvidence.idempotencyKey");
    expect(retry.statusCode).toBe(409);
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});

describe("streamed Chat route commit truth", () => {
  it.each(streamRouteScenarios)(
    "releases the $label idempotency claim when the source fails before its first canonical mutation",
    async (scenario) => {
      let attempts = 0;
      const mutation = vi.fn((...args: unknown[]) => {
        attempts += 1;
        const lifecycle = args.at(-1) as { markCommitted?: () => void } | undefined;
        return (async function* () {
          if (attempts === 1) {
            throw new Error("source failed before canonical mutation");
          }
          lifecycle?.markCommitted?.();
          yield {
            type: "done",
            sessionId: "session-1",
            turnId: "turn-2",
            messageId: "assistant-2",
          };
        })();
      });
      const app = await createStreamCommitTruthApp(scenario.methodName, mutation);
      const request = {
        method: "POST" as const,
        url: scenario.url,
        headers: { "idempotency-key": `chat-stream-precommit-${scenario.label}` },
        payload: scenario.payload,
      };

      const first = await app.inject(request);
      const retry = await app.inject(request);
      const replay = await app.inject(request);

      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('"type":"error"');
      expect(retry.statusCode).toBe(200);
      expect(retry.body).toContain('"type":"done"');
      expect(replay.statusCode).toBe(409);
      expect(mutation).toHaveBeenCalledTimes(2);
    },
  );

  it.each(streamRouteScenarios)(
    "keeps the $label idempotency claim committed when the source fails after commit but before yielding",
    async (scenario) => {
      let receivedLifecycle: { markCommitted?: () => void } | undefined;
      const mutation = vi.fn((...args: unknown[]) => {
        receivedLifecycle = args.at(-1) as { markCommitted?: () => void } | undefined;
        return (async function* () {
          receivedLifecycle?.markCommitted?.();
          yield* [];
          throw new Error("source failed after canonical mutation but before first yield");
        })();
      });
      const app = await createStreamCommitTruthApp(scenario.methodName, mutation);
      const request = {
        method: "POST" as const,
        url: scenario.url,
        headers: { "idempotency-key": `chat-stream-postcommit-${scenario.label}` },
        payload: scenario.payload,
      };

      const first = await app.inject(request);
      const replay = await app.inject(request);

      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('"type":"error"');
      expect(typeof receivedLifecycle?.markCommitted).toBe("function");
      expect(replay.statusCode).toBe(409);
      expect(mutation).toHaveBeenCalledTimes(1);
    },
  );
});

const streamRouteScenarios = [
  {
    label: "send stream",
    methodName: "agentSendChatMessageStream",
    url: "/api/v1/chat/sessions/session-1/agent-send/stream",
    payload: { content: "hello", routeDecision: routeDecision("send") },
  },
  {
    label: "retry stream",
    methodName: "retryChatTurnStream",
    url: "/api/v1/chat/sessions/session-1/turns/turn-1/retry/stream",
    payload: { routeDecision: routeDecision("retry", "turn-1") },
  },
  {
    label: "edit stream",
    methodName: "editChatTurnStream",
    url: "/api/v1/chat/sessions/session-1/turns/turn-1/edit/stream",
    payload: { content: "updated", routeDecision: routeDecision("edit", "turn-1") },
  },
] as const;

async function createStreamCommitTruthApp(
  methodName: (typeof streamRouteScenarios)[number]["methodName"],
  mutation: ReturnType<typeof vi.fn>,
): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  app.decorate("services", {
    chatMessages: {
      routePreflight: vi.fn(async () => ({ decision: { fingerprint: "route-fingerprint-1" } })),
      [methodName]: mutation,
    },
  } as never);
  await app.register(idempotencyHeaderPlugin, {
    mutationStore: new FakeMutationIdempotencyStore() as never,
  });
  registerChatMessageRoutes(app);
  return app;
}

function routeDecision(action: "send" | "retry" | "edit", turnId?: string) {
  return {
    action,
    ...(turnId ? { turnId } : {}),
    issuedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2099-07-10T00:05:00.000Z",
    selectionSource: "global",
    fallbackPolicy: "off",
    fallbackResult: "not_applicable",
    runtimeReachability: "not_checked",
    runtimeClass: "unknown",
    fingerprint: "route-fingerprint-1",
  };
}
