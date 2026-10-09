import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { knowledgeRoutes } from "./knowledge.js";
it("requires operator auth and exact result scope before reaching the read owner", async () => {
  const app = Fastify();
  const knowledgeApprovalResult = vi.fn(async () => ({
    approvalId: "a",
    state: "completed",
    message: "Original result",
    result: { items: [] },
  }));
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
  app.decorate("services", { knowledge: { knowledgeApprovalResult } } as never);
  await app.register(knowledgeRoutes);
  try {
    const url = "/api/v1/knowledge/approvals/a/result?workspaceId=one&sessionId=s&toolName=embeddings.query";
    expect((await app.inject({ url })).statusCode).toBe(403);
    expect(knowledgeApprovalResult).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          url: "/api/v1/knowledge/approvals/a/result?workspaceId=one",
          headers: { authorization: "Bearer fixture" },
        })
      ).statusCode,
    ).toBe(400);
    expect(knowledgeApprovalResult).not.toHaveBeenCalled();
    const response = await app.inject({ url, headers: { authorization: "Bearer fixture" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(knowledgeApprovalResult).toHaveBeenCalledExactlyOnceWith("a", {
      workspaceId: "one",
      sessionId: "s",
      toolName: "embeddings.query",
    });
  } finally {
    await app.close();
  }
});
