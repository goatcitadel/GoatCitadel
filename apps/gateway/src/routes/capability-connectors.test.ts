import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { CapabilityConnectorsResponse } from "@goatcitadel/contracts";
import { capabilityConnectorsRoutes } from "./capability-connectors.js";

const RESPONSE: CapabilityConnectorsResponse = {
  workspaceId: "default",
  items: [
    {
      id: "web-search:search.brave",
      name: "Brave Search",
      description: "Search the web with your Brave Search key.",
      kind: "built_in",
      source: "web_search",
      category: "search",
      state: "connected",
      reason: "ready",
      group: "connected",
      auth: "api_key",
      runsOnThisDevice: false,
      networkHosts: [],
      chat: { available: true },
      hiddenInWorkspace: false,
    },
  ],
  issues: [],
  generatedAt: "2026-10-25T00:00:00.000Z",
};

describe("capability connectors route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(services: Record<string, unknown>) {
    app = Fastify();
    app.decorate("services", services as never);
    await app.register(capabilityConnectorsRoutes);
    return app;
  }

  it("returns the connector list for a workspace", async () => {
    const list = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/connectors?workspaceId=default" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json()).toEqual(RESPONSE);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(list).toHaveBeenCalledWith("default");
  });

  it("rejects unknown query fields", async () => {
    const list = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/capabilities/connectors?workspaceId=default&live=1",
    });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing workspace id", "/api/v1/capabilities/connectors"],
    ["an empty workspace id", "/api/v1/capabilities/connectors?workspaceId="],
    ["an overlong workspace id", `/api/v1/capabilities/connectors?workspaceId=${"w".repeat(201)}`],
  ])("rejects %s", async (_label, url) => {
    const list = vi.fn(async () => RESPONSE);
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("answers 503 when the connector list is not composed", async () => {
    const server = await build({});

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/connectors?workspaceId=default" });

    expect(response.statusCode).toBe(503);
  });

  it("answers 500 without echoing an unexpected failure", async () => {
    const list = vi.fn(async () => {
      throw new Error("db password hunter2");
    });
    const server = await build({ capabilityConnectors: { list } });

    const response = await server.inject({ method: "GET", url: "/api/v1/capabilities/connectors?workspaceId=default" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("hunter2");
  });
});
