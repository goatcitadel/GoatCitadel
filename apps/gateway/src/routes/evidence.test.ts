import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { evidenceRoutes } from "./evidence.js";

describe("evidence routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function buildApp(evidence: Record<string, unknown>): FastifyInstance {
    const built = Fastify();
    built.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    built.decorate("services", { evidence } as never);
    return built;
  }

  it("lists evidence envelopes through route services", async () => {
    const listEnvelopes = vi.fn(() => [
      {
        id: "evidence-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
    ]);
    app = buildApp({
      listEnvelopes,
    });
    await app.register(evidenceRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/evidence/envelopes?sessionId=session-1&turnId=turn-1&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: "evidence-1",
          sessionId: "session-1",
          turnId: "turn-1",
        },
      ],
    });
    expect(listEnvelopes).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      limit: 25,
    });
  });

  it("validates list query before delegating", async () => {
    const listEnvelopes = vi.fn();
    app = buildApp({
      listEnvelopes,
    });
    await app.register(evidenceRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/evidence/envelopes?limit=0",
    });

    expect(response.statusCode).toBe(400);
    expect(listEnvelopes).not.toHaveBeenCalled();
  });
});
