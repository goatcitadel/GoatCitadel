import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  NotFoundError,
  ServiceUnavailableError,
  type CapabilitySkillsResponse,
  type CapabilitySkillUsageResponse,
} from "@goatcitadel/contracts";
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

const LIST_URL = "/api/v1/capabilities/skills";
const DETAIL_URL = "/api/v1/capabilities/skills/detail";

const LIST: CapabilitySkillsResponse = {
  workspaceId: "default",
  items: [
    {
      skillId: "bundled:research",
      name: "research",
      description: "Research with citations.",
      category: "research",
      origin: "built_in",
      state: "on",
      callable: true,
      revision: 2,
      pinned: false,
      lifecycleState: "trusted",
      tags: [],
      hiddenInWorkspace: false,
    },
  ],
  candidatesWaiting: 1,
  operatorApprovalSkip: false,
  issues: [],
  generatedAt: "2026-10-28T00:00:00.000Z",
};

describe("capability skills list and detail routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(skills: Record<string, unknown> | undefined) {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorate("services", (skills ? { capabilitySkills: { usage: { read: vi.fn() }, skills } } : {}) as never);
    await app.register(capabilitySkillsRoutes);
    return app;
  }

  it("returns the list with no-store", async () => {
    const list = vi.fn(async () => LIST);
    const server = await build({ list, detail: vi.fn() });

    const response = await server.inject({ method: "GET", url: `${LIST_URL}?workspaceId=default` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(LIST);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-ratelimit-limit"]).toBe("60");
    expect(list).toHaveBeenCalledWith("default");
  });

  it("returns one skill's details with no-store", async () => {
    const detail = vi.fn(async () => ({
      skillId: "bundled:research",
      instructionBody: "# Research",
      keywords: [],
      declaredTools: [],
      requires: [],
    }));
    const server = await build({ list: vi.fn(), detail });

    const response = await server.inject({
      method: "GET",
      url: `${DETAIL_URL}?workspaceId=default&skillId=${encodeURIComponent("bundled:research")}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ skillId: "bundled:research", instructionBody: "# Research" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-ratelimit-limit"]).toBe("60");
    expect(detail).toHaveBeenCalledWith("default", "bundled:research");
  });

  it("returns 404 for an unknown skill's details", async () => {
    const detail = vi.fn(async () => {
      throw new NotFoundError({ entity: "Skill", id: "extra:missing" });
    });
    const server = await build({ list: vi.fn(), detail });

    const response = await server.inject({
      method: "GET",
      url: `${DETAIL_URL}?workspaceId=default&skillId=${encodeURIComponent("extra:missing")}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects unknown query fields", async () => {
    const list = vi.fn(async () => LIST);
    const detail = vi.fn();
    const server = await build({ list, detail });

    for (const url of [
      `${LIST_URL}?workspaceId=default&kind=skill`,
      `${LIST_URL}`,
      `${DETAIL_URL}?workspaceId=default&skillId=bundled%3Aresearch&full=true`,
      `${DETAIL_URL}?workspaceId=default`,
      `${DETAIL_URL}?workspaceId=default&skillId=${"x".repeat(301)}`,
      `${LIST_URL}?workspaceId=${"w".repeat(201)}`,
    ]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it("answers 503 with plain wording when the skills can't be read", async () => {
    const list = vi.fn(async () => {
      throw new ServiceUnavailableError("Skills can't be read right now.");
    });
    const server = await build({ list, detail: vi.fn() });

    const response = await server.inject({ method: "GET", url: `${LIST_URL}?workspaceId=default` });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Skills can't be read right now.");
  });

  it("answers 503 when the skills list is not composed", async () => {
    const server = await build(undefined);

    const list = await server.inject({ method: "GET", url: `${LIST_URL}?workspaceId=default` });
    const detail = await server.inject({ method: "GET", url: `${DETAIL_URL}?workspaceId=default&skillId=a` });

    expect(list.statusCode).toBe(503);
    expect(detail.statusCode).toBe(503);
  });
});
