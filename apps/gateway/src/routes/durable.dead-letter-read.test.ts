import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
import { durableRoutes } from "./durable.js";

function buildApp(durable: Record<string, unknown>, requireOperatorAuth = vi.fn(async () => undefined)) {
  const app = Fastify();
  app.decorate("requireOperatorAuth", requireOperatorAuth as never);
  app.decorate("services", { durable } as never);
  return { app, requireOperatorAuth };
}

describe("durable dead-letter read by id", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reads one stopped run's dead letter, operator-only like the list", async () => {
    const deadLetter = {
      deadLetterId: "dead-1",
      runId: "run-1",
      reason: "worker lost",
      createdAt: "2026-10-05T00:00:00Z",
    };
    const getDeadLetter = vi.fn(async (id: string) => {
      if (id !== "dead-1") throw new NotFoundError({ entity: "Durable dead letter", id });
      return deadLetter;
    });
    const built = buildApp({ getDeadLetter });
    app = built.app;
    await app.register(durableRoutes);

    const found = await app.inject({ method: "GET", url: "/api/v1/durable/dead-letters/dead-1" });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ deadLetterId: "dead-1", runId: "run-1" });
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "GET", url: "/api/v1/durable/dead-letters/missing" })).statusCode).toBe(404);
  });

  it("rejects an unauthenticated read the same way the list does", async () => {
    const getDeadLetter = vi.fn();
    const listDeadLetters = vi.fn(() => []);
    const requireOperatorAuth = vi.fn(
      async (_request: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) =>
        reply.code(401).send({ error: "Unauthorized" }),
    );
    const built = buildApp({ getDeadLetter, listDeadLetters }, requireOperatorAuth);
    app = built.app;
    await app.register(durableRoutes);
    expect((await app.inject({ method: "GET", url: "/api/v1/durable/dead-letters/dead-1" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/durable/dead-letters" })).statusCode).toBe(401);
    expect(getDeadLetter).not.toHaveBeenCalled();
  });
});
