import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { filesRoutes } from "./files.js";

describe("files route tails", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("maps HTML preview service failures through the shared route error shape", async () => {
    const downloadWorkspaceFile = vi.fn(async () => {
      throw new Error("preview failed");
    });
    app = buildApp({ downloadWorkspaceFile });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/files/preview?relativePath=pages/index.html",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    expect(downloadWorkspaceFile).toHaveBeenCalledWith("pages/index.html", {
      maxBytes: expect.any(Number),
    });
  });
});

function buildApp(files: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { files } as never);
  void next.register(filesRoutes);
  return next;
}
