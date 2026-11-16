import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { knowledgeRoutes } from "./knowledge.js";

async function build() {
  const app = Fastify();
  const knowledgeListDocuments = vi.fn(async () => ({ items: [], truncated: false }));
  app.decorate(
    "requireOperatorAuth",
    async (
      request: { headers: Record<string, unknown> },
      reply: { code: (status: number) => { send: (value: unknown) => unknown } },
    ) => {
      if (request.headers.authorization !== "Bearer fixture")
        return reply.code(403).send({ error: "operator required" });
    },
  );
  app.decorate("services", { knowledge: { knowledgeListDocuments } } as never);
  await app.register(knowledgeRoutes);
  return { app, knowledgeListDocuments };
}
const headers = { authorization: "Bearer fixture" };

it("lists Knowledge documents only for an operator and validates the query", async () => {
  const { app, knowledgeListDocuments } = await build();
  try {
    const url = "/api/v1/knowledge/documents";
    expect((await app.inject({ url })).statusCode).toBe(403);
    expect(knowledgeListDocuments).not.toHaveBeenCalled();
    expect((await app.inject({ url: `${url}?limit=0`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: `${url}?bogus=1`, headers })).statusCode).toBe(400);
    expect(knowledgeListDocuments).not.toHaveBeenCalled();
    const response = await app.inject({ url: `${url}?namespace=general`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ items: [], truncated: false });
    expect(knowledgeListDocuments).toHaveBeenCalledExactlyOnceWith({ namespace: "general", limit: 50 });
  } finally {
    await app.close();
  }
});
