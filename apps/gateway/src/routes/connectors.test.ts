import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { connectorsRoutes } from "./connectors.js";

describe("connectors routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists connector records and forwards connectorType filters", async () => {
    const listConnectorRecords = vi.fn(() => ([
      {
        connectorId: "mcp:srv-1",
        connectorType: "mcp_server",
        label: "Approval Inbox",
        sourceId: "srv-1",
        status: "active",
        capabilities: [],
      },
    ]));
    app = Fastify();
    app.decorate("gateway", {
      listConnectorRecords,
    } as never);
    await app.register(connectorsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/connectors?connectorType=mcp_server",
    });

    expect(response.statusCode).toBe(200);
    expect(listConnectorRecords).toHaveBeenCalledWith("mcp_server");
    expect(response.json()).toMatchObject({
      items: [
        {
          connectorId: "mcp:srv-1",
          connectorType: "mcp_server",
        },
      ],
    });
  });
});
