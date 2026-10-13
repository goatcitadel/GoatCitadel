import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { mcpRoutes } from "./mcp.js";

it("keeps tested receipts behind the existing operator gate, checks current workspace, and derives actor from authentication", async () => {
  const app = Fastify();
  const read = vi.fn(async () => ({ state: "unverified" }));
  const workspace = vi.fn(async () => ({}));
  app.decorate("services", {
    mcp: { elicitations: {}, getMcpServerTestEvidence: read },
    workspaces: { getWorkspace: workspace },
  } as never);
  // Stand-in credential resolver; the real route must still call the shared operator gate.
  app.addHook("onRequest", async (request) => {
    request.authActorId = "authenticated-actor";
    request.authActorSource =
      request.headers["x-fixture-source"] === "companion"
        ? "companion"
        : request.headers.authorization
          ? "token"
          : "none";
  });
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.authActorSource !== "token") return reply.code(403).send({ error: "operator required" });
  });
  await app.register(mcpRoutes);
  const url = "/api/v1/mcp/servers/server/test-evidence?workspaceId=workspace";
  try {
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url, headers: { "x-fixture-source": "companion" } })).statusCode).toBe(
      403,
    );
    expect(read).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: "GET", url: `${url}&actorId=forged`, headers: { authorization: "fixture" } }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url, headers: { authorization: "fixture" } })).statusCode).toBe(200);
    expect(workspace).toHaveBeenCalledWith("workspace");
    expect(read).toHaveBeenCalledExactlyOnceWith("server", {
      workspaceId: "workspace",
      actorId: "authenticated-actor",
      actorSource: "token",
    });
  } finally {
    await app.close();
  }
});
