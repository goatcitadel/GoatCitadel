import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { CapabilitySkillUsageResponse } from "@goatcitadel/contracts";
import { capabilitySkillsRoutes } from "./capability-skills.js";

const USAGE_URL = "/api/v1/capabilities/skills/usage";

const RESPONSE: CapabilitySkillUsageResponse = {
  since: "2025-10-28T00:00:00.000Z",
  generatedAt: "2026-10-28T00:00:00.000Z",
  skills: [{ skillId: "research", uses: 3, lastUsedAt: "2026-10-20T00:00:00.000Z" }],
};

describe("capability skills usage route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(services: Record<string, unknown>) {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorate("services", services as never);
    await app.register(capabilitySkillsRoutes);
    return app;
  }

  it("returns the use counts without storing them", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: USAGE_URL });

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
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: `${USAGE_URL}?refresh=${value}` });

    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith({ refresh });
  });

  it("answers 503 when uses can't be read", async () => {
    const read = vi.fn(async () => {
      throw new Error("database is locked at C:\\data\\goatcitadel.sqlite");
    });
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: USAGE_URL });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skill use counts can't be read right now.");
    // The real reason stays in the log; the answer carries plain wording only, and no counts.
    expect(response.body).not.toContain("sqlite");
    expect(response.body).not.toContain("skills");
  });

  it("answers 503 when the usage service is not composed", async () => {
    const server = await build({});

    const response = await server.inject({ method: "GET", url: USAGE_URL });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skill use counts can't be read right now.");
  });

  it("rejects unknown query fields", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: `${USAGE_URL}?window=30` });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a refresh value that isn't true or false", async () => {
    const read = vi.fn(async () => RESPONSE);
    const server = await build({ capabilitySkills: { usage: { read } } });

    const response = await server.inject({ method: "GET", url: `${USAGE_URL}?refresh=yes` });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("sets the 30 a minute limit", async () => {
    const server = await build({ capabilitySkills: { usage: { read: vi.fn(async () => RESPONSE) } } });

    const response = await server.inject({ method: "GET", url: USAGE_URL });

    expect(response.headers["x-ratelimit-limit"]).toBe("30");
  });
});
