import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
import { costsRoutes } from "./costs.js";

describe("costs routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  async function createApp(
    services: Record<string, unknown>,
    options: { authorized?: boolean } = {},
  ): Promise<FastifyInstance> {
    const next = Fastify();
    next.decorate("services", services as never);
    next.decorateRequest("authActorId", "anonymous");
    next.decorateRequest("authActorSource", "none");
    next.decorate("requireOperatorAuth", async (request: { authActorId: string; authActorSource: string }, reply) => {
      if (options.authorized === false) return reply.code(403).send({ error: "Operator authentication required." });
      request.authActorId = "operator-test";
      request.authActorSource = "token";
    });
    await next.register(costsRoutes);
    return next;
  }

  it("returns provider daily series alongside aggregate cost summary", async () => {
    const services = {
      costs: {
        costSummary: vi.fn(async () => [
          {
            key: "2026-02-23",
            tokenInput: 20,
            tokenOutput: 10,
            tokenCachedInput: 0,
            tokenTotal: 30,
            costUsd: 4,
            metricAvailability: {
              inputTokensComplete: true,
              outputTokensComplete: true,
              cachedInputTokensComplete: true,
              costUsdComplete: true,
            },
          },
        ]),
        costDailySeries: vi.fn(async () => [
          {
            isoDate: "2026-02-23",
            shortLabel: "02-23",
            costUsd: 4,
            tokenInput: 20,
            tokenOutput: 10,
            tokenCachedInput: 0,
            tokenTotal: 30,
            metricAvailability: {
              inputTokensComplete: true,
              outputTokensComplete: true,
              cachedInputTokensComplete: true,
              costUsdComplete: true,
            },
            segments: [
              {
                providerKey: "openai",
                label: "OpenAI",
                tokenInput: 20,
                tokenOutput: 10,
                tokenCachedInput: 0,
                tokenTotal: 30,
                costUsd: 4,
                models: ["gpt-5"],
                metricAvailability: {
                  inputTokensComplete: true,
                  outputTokensComplete: true,
                  cachedInputTokensComplete: true,
                  costUsdComplete: true,
                },
              },
            ],
          },
        ]),
        costUsageAvailability: vi.fn(async () => ({
          trackedEvents: 1,
          unknownEvents: 0,
          totalAgentEvents: 1,
          metricAvailability: {
            inputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
            outputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
            cachedInputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
            costUsd: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
          },
        })),
      },
    };
    app = await createApp(services);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/costs/summary?scope=day&from=2026-02-20T00:00:00.000Z&to=2026-02-26T23:59:59.999Z",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "day",
      dailySeries: [
        {
          isoDate: "2026-02-23",
          metricAvailability: { costUsdComplete: true },
          segments: [
            {
              providerKey: "openai",
              costUsd: 4,
              models: ["gpt-5"],
              metricAvailability: { costUsdComplete: true },
            },
          ],
        },
      ],
      usageAvailability: {
        trackedEvents: 1,
        unknownEvents: 0,
        totalAgentEvents: 1,
        metricAvailability: {
          costUsd: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
        },
      },
    });
    expect(services.costs.costSummary).toHaveBeenCalledWith(
      "day",
      "2026-02-20T00:00:00.000Z",
      "2026-02-26T23:59:59.999Z",
    );
    expect(services.costs.costDailySeries).toHaveBeenCalledWith("2026-02-20T00:00:00.000Z", "2026-02-26T23:59:59.999Z");
  });

  it("rejects invalid cost summary scope before touching services", async () => {
    const services = {
      costs: {
        costSummary: vi.fn(),
        costDailySeries: vi.fn(),
        costUsageAvailability: vi.fn(),
      },
    };
    app = await createApp(services);

    const response = await app.inject({ method: "GET", url: "/api/v1/costs/summary?scope=month" });

    expect(response.statusCode).toBe(400);
    expect(services.costs.costSummary).not.toHaveBeenCalled();
    expect(services.costs.costDailySeries).not.toHaveBeenCalled();
  });

  it("lists canonical attempts only through the workspace-scoped operator route", async () => {
    const services = {
      costs: {
        listModelUsageEvents: vi.fn(async () => ({ items: [], summary: { attemptCount: 0 } })),
      },
    };
    app = await createApp(services);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/model-usage?sessionId=session-a&availability=unknown&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(services.costs.listModelUsageEvents).toHaveBeenCalledWith("workspace-a", {
      sessionId: "session-a",
      availability: "unknown",
      limit: 25,
    });
  });

  it("rejects alternate workspace scope in model-usage list queries", async () => {
    const services = { costs: { listModelUsageEvents: vi.fn() } };
    app = await createApp(services);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ops/workspaces/workspace-a/model-usage?workspaceId=workspace-b",
    });

    expect(response.statusCode).toBe(400);
    expect(services.costs.listModelUsageEvents).not.toHaveBeenCalled();
  });

  it("blocks model-usage list and detail reads without operator authorization", async () => {
    const services = {
      costs: {
        listModelUsageEvents: vi.fn(),
        getModelUsageEvent: vi.fn(),
      },
    };
    app = await createApp(services, { authorized: false });

    for (const url of [
      "/api/v1/ops/workspaces/workspace-a/model-usage",
      "/api/v1/ops/workspaces/workspace-a/model-usage/usage-1",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(403);
    }

    expect(services.costs.listModelUsageEvents).not.toHaveBeenCalled();
    expect(services.costs.getModelUsageEvent).not.toHaveBeenCalled();
  });

  it("authors reconciliation identity from operator auth", async () => {
    const record = {
      eventId: "usage-1",
      workspaceId: "workspace-a",
      dispatchReconciliation: "confirmed_not_dispatched",
    };
    const services = { costs: { reconcileModelUsageDispatch: vi.fn(async () => record) } };
    app = await createApp(services);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/model-usage/usage-1/reconcile",
      payload: {
        reconciliation: "confirmed_not_dispatched",
        evidence: "Provider request log confirms no transport dispatch.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(services.costs.reconcileModelUsageDispatch).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      eventId: "usage-1",
      reconciliation: "confirmed_not_dispatched",
      evidence: "Provider request log confirms no transport dispatch.",
      actorId: "operator-test",
    });
  });

  it("blocks model-usage reconciliation without operator authorization", async () => {
    const services = { costs: { reconcileModelUsageDispatch: vi.fn() } };
    app = await createApp(services, { authorized: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/model-usage/usage-1/reconcile",
      payload: {
        reconciliation: "confirmed_not_dispatched",
        evidence: "Provider request log confirms no transport dispatch.",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(services.costs.reconcileModelUsageDispatch).not.toHaveBeenCalled();
  });

  it("returns non-disclosing not-found for foreign-workspace reconciliation", async () => {
    const services = {
      costs: {
        reconcileModelUsageDispatch: vi
          .fn()
          .mockRejectedValue(new NotFoundError({ entity: "model usage event", id: "usage-1" })),
      },
    };
    app = await createApp(services);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/model-usage/usage-1/reconcile",
      payload: {
        reconciliation: "confirmed_not_dispatched",
        evidence: "Provider request log confirms no transport dispatch.",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("workspace-b");
  });

  it.each(["actorId", "workspaceId", "eventId"])("rejects injected reconciliation identity field %s", async (field) => {
    const services = { costs: { reconcileModelUsageDispatch: vi.fn() } };
    app = await createApp(services);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ops/workspaces/workspace-a/model-usage/usage-1/reconcile",
      payload: {
        reconciliation: "confirmed_not_dispatched",
        evidence: "Provider request log confirms no transport dispatch.",
        [field]: "attacker-controlled",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(services.costs.reconcileModelUsageDispatch).not.toHaveBeenCalled();
  });
});
