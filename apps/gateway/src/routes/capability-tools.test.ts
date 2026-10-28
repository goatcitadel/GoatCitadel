import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { CapabilityToolsResponse, CapabilityToolUsageResponse } from "@goatcitadel/contracts";
import { capabilityToolsRoutes } from "./capability-tools.js";

const TOOLS_RESPONSE: CapabilityToolsResponse = {
  workspaceId: "default",
  groups: [
    {
      groupId: "files",
      label: "Files",
      description: "Read, search, write, move and delete files in your folders.",
      state: "on",
      risk: "danger",
      tools: [{ toolName: "fs.read", description: "Read a file", risk: "safe", asks: "runs_freely" }],
      blockedToolCount: 0,
    },
  ],
  settingsRevision: 7,
  issues: [],
  generatedAt: "2026-10-27T00:00:00.000Z",
};

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

describe("capability tool groups route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(services: Record<string, unknown>) {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    app.decorate("services", services as never);
    // The auth plugin sets these on every request; the route hands them to the list as the actor.
    app.addHook("onRequest", async (request) => {
      request.authActorId = "operator-1";
      request.authActorSource = "token";
    });
    await app.register(capabilityToolsRoutes);
    return app;
  }

  it("returns the groups for a workspace with no-store", async () => {
    const list = vi.fn(async () => TOOLS_RESPONSE);
    const server = await build({ capabilityTools: { list } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools?workspaceId=default" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(TOOLS_RESPONSE);
    expect(response.headers["cache-control"]).toBe("no-store");
    // The probes run as the caller, so the operator's own permission profile applies.
    expect(list).toHaveBeenCalledWith("default", {
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
    });
  });

  it("rejects unknown query fields", async () => {
    const list = vi.fn(async () => TOOLS_RESPONSE);
    const server = await build({ capabilityTools: { list } });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/capabilities/tools?workspaceId=default&refresh=true",
    });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ["no workspace", "/api/v1/capabilities/tools"],
    ["an empty workspace", "/api/v1/capabilities/tools?workspaceId="],
    ["a workspace id over 200 characters", `/api/v1/capabilities/tools?workspaceId=${"w".repeat(201)}`],
  ])("rejects %s", async (_name, url) => {
    const list = vi.fn(async () => TOOLS_RESPONSE);
    const server = await build({ capabilityTools: { list } });

    const response = await server.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps the 60 per minute limit", async () => {
    const server = await build({ capabilityTools: { list: vi.fn(async () => TOOLS_RESPONSE) } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools?workspaceId=default" });

    expect(response.headers["x-ratelimit-limit"]).toBe("60");
  });

  it("answers 503 in plain words when the list is not composed", async () => {
    const server = await build({});

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools?workspaceId=default" });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Tool groups can't be listed right now.");
    expect(response.body).not.toContain("composed");
  });

  it("accepts a 200-character workspaceId", async () => {
    const list = vi.fn(async () => TOOLS_RESPONSE);
    const server = await build({ capabilityTools: { list } });
    const workspaceId = "w".repeat(200);

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/capabilities/tools?workspaceId=${workspaceId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(workspaceId, expect.any(Object));
  });

  it("never echoes the real error when the list fails", async () => {
    const list = vi.fn(async () => {
      throw new Error("database is locked at C:\\data\\goatcitadel.sqlite");
    });
    const server = await build({ capabilityTools: { list } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/tools?workspaceId=default" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sqlite");
  });
});
