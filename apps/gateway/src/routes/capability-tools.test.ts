import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { CapabilityToolUsageResponse } from "@goatcitadel/contracts";
import { capabilityToolsRoutes } from "./capability-tools.js";

const RESPONSE: CapabilityToolUsageResponse = {
  since: "2025-10-27T00:00:00.000Z",
  generatedAt: "2026-10-27T00:00:00.000Z",
  tools: [{ toolName: "fs.read", calls: 3, lastCalledAt: "2026-10-20T00:00:00.000Z" }],
  groups: [{ groupId: "files", calls: 3, lastCalledAt: "2026-10-20T00:00:00.000Z" }],
  mostUsed: { kind: "essentials", groupIds: ["files", "web_search", "memory", "browser"] },
};

describe("capability tools route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(services: Record<string, unknown>) {
    app = Fastify();
    app.decorate("services", services as never);
    await app.register(capabilityToolsRoutes);
    return app;
  }

  it("returns the usage counts without storing them", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityToolUsage: { read } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools/usage" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RESPONSE);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(read).toHaveBeenCalledWith({ refresh: false });
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("reads with refresh=%s", async (value, refresh) => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityToolUsage: { read } });

    const response = await server.inject({ method: "GET", url: `/api/v1/capabilities/tools/usage?refresh=${value}` });

    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith({ refresh });
  });

  it("answers 503 when the counts can't be read", async () => {
    const read = vi.fn(async () => {
      throw new Error("database is locked at C:\\data\\goatcitadel.sqlite");
    });
    const server = await build({ capabilityToolUsage: { read } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools/usage" });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Tool call counts can't be read right now.");
    // The real reason stays in the log; the answer carries plain wording only.
    expect(response.body).not.toContain("sqlite");
  });

  it("answers 503 when the usage service is not composed", async () => {
    const server = await build({});

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools/usage" });

    expect(response.statusCode).toBe(503);
  });

  it("rejects unknown query fields", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityToolUsage: { read } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools/usage?window=30" });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a refresh value that isn't true or false", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityToolUsage: { read } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools/usage?refresh=yes" });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});
