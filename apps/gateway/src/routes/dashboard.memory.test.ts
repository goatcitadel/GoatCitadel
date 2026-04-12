import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard memory file route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("passes the requested memory directory through to the gateway", async () => {
    const listMemoryFiles = vi.fn(async () => [
      { relativePath: "memory/notes.md", size: 12, modifiedAt: "2026-04-12T00:00:00.000Z" },
    ]);

    app = Fastify();
    app.decorate("gateway", {
      listMemoryFiles,
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/files?dir=memory",
    });

    expect(response.statusCode).toBe(200);
    expect(listMemoryFiles).toHaveBeenCalledWith("memory");
    expect(response.json()).toEqual({
      items: [{ relativePath: "memory/notes.md", size: 12, modifiedAt: "2026-04-12T00:00:00.000Z" }],
    });
  });
});
