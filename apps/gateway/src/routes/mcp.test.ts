import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { MCP_APPROVAL_INBOX_URL } from "../services/mcp-approval-inbox.js";
import { mcpRoutes } from "./mcp.js";

describe("mcp routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("passes agentId and approval metadata through /mcp/invoke", async () => {
    const invokeMcpTool = vi.fn(async () => ({
      ok: false,
      approvalRequired: true,
      approvalId: "approval-123",
      policyReason: "approval required by risk gate",
      reasonCodes: ["allowed"],
      error: "MCP invoke requires approval.",
    }));

    app = Fastify();
    app.decorate("services", {
      mcp: {
        invokeMcpTool,
        listMcpServers: vi.fn(),
        createMcpServer: vi.fn(),
        updateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        connectMcpServer: vi.fn(),
        disconnectMcpServer: vi.fn(),
        startMcpOAuth: vi.fn(),
        completeMcpOAuth: vi.fn(),
        listMcpTools: vi.fn(),
        updateMcpServerPolicy: vi.fn(),
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: {
        serverId: "srv-1",
        toolName: "tool.echo",
        agentId: "operator",
        sessionId: "sess-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(invokeMcpTool).toHaveBeenCalledWith({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "operator",
      sessionId: "sess-1",
    });
    expect(response.json()).toMatchObject({
      ok: false,
      approvalRequired: true,
      approvalId: "approval-123",
    });
  });

  it("awaits async MCP connect responses", async () => {
    const connectMcpServer = vi.fn(async () => ({
      serverId: "srv-1",
      label: "Playwright",
      transport: "stdio",
      authType: "none",
      enabled: true,
      status: "connected",
      category: "browser",
      trustTier: "restricted",
      costTier: "unknown",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic",
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    }));

    app = Fastify();
    app.decorate("services", {
      mcp: {
        invokeMcpTool: vi.fn(),
        listMcpServers: vi.fn(),
        createMcpServer: vi.fn(),
        updateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        connectMcpServer,
        disconnectMcpServer: vi.fn(),
        startMcpOAuth: vi.fn(),
        completeMcpOAuth: vi.fn(),
        listMcpTools: vi.fn(),
        updateMcpServerPolicy: vi.fn(),
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/connect",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(connectMcpServer).toHaveBeenCalledWith("srv-1");
    expect(response.json()).toMatchObject({
      serverId: "srv-1",
      status: "connected",
    });
  });

  it("returns 400 when async MCP connect fails", async () => {
    const connectMcpServer = vi.fn(async () => {
      throw new Error("MCP connection probe failed.");
    });

    app = Fastify();
    app.decorate("services", {
      mcp: {
        invokeMcpTool: vi.fn(),
        listMcpServers: vi.fn(),
        createMcpServer: vi.fn(),
        updateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        connectMcpServer,
        disconnectMcpServer: vi.fn(),
        startMcpOAuth: vi.fn(),
        completeMcpOAuth: vi.fn(),
        listMcpTools: vi.fn(),
        updateMcpServerPolicy: vi.fn(),
        listMcpTemplates: vi.fn(),
        listMcpTemplateDiscovery: vi.fn(),
        runMcpServerHealthCheck: vi.fn(),
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/connect",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "MCP connection probe failed.",
    });
  });

  it("returns 404 for health-check on unknown MCP server", async () => {
    const runMcpServerHealthCheck = vi.fn(() => {
      throw new Error("Unknown MCP server srv-missing.");
    });

    app = Fastify();
    app.decorate("services", {
      mcp: {
        invokeMcpTool: vi.fn(),
        listMcpServers: vi.fn(),
        createMcpServer: vi.fn(),
        updateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        connectMcpServer: vi.fn(),
        disconnectMcpServer: vi.fn(),
        startMcpOAuth: vi.fn(),
        completeMcpOAuth: vi.fn(),
        listMcpTools: vi.fn(),
        updateMcpServerPolicy: vi.fn(),
        listMcpTemplates: vi.fn(),
        listMcpTemplateDiscovery: vi.fn(),
        runMcpServerHealthCheck,
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-missing/health-check",
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "Unknown MCP server srv-missing.",
    });
  });

  it("returns 409 for health-check on server with non-404 error", async () => {
    const runMcpServerHealthCheck = vi.fn(() => {
      throw new Error("Feature connectorDiagnosticsV1Enabled is not enabled.");
    });

    app = Fastify();
    app.decorate("services", {
      mcp: {
        invokeMcpTool: vi.fn(),
        listMcpServers: vi.fn(),
        createMcpServer: vi.fn(),
        updateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        connectMcpServer: vi.fn(),
        disconnectMcpServer: vi.fn(),
        startMcpOAuth: vi.fn(),
        completeMcpOAuth: vi.fn(),
        listMcpTools: vi.fn(),
        updateMcpServerPolicy: vi.fn(),
        listMcpTemplates: vi.fn(),
        listMcpTemplateDiscovery: vi.fn(),
        runMcpServerHealthCheck,
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/health-check",
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Feature connectorDiagnosticsV1Enabled is not enabled.",
    });
  });

  it("rejects generic remote MCP server creation in the 1.0 runtime-invokable surface", async () => {
    const createMcpServer = vi.fn();

    app = Fastify();
    app.decorate("services", {
      mcp: {
        invokeMcpTool: vi.fn(),
        listMcpServers: vi.fn(),
        createMcpServer,
        updateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        connectMcpServer: vi.fn(),
        disconnectMcpServer: vi.fn(),
        startMcpOAuth: vi.fn(),
        completeMcpOAuth: vi.fn(),
        listMcpTools: vi.fn(),
        updateMcpServerPolicy: vi.fn(),
        listMcpTemplates: vi.fn(),
        listMcpTemplateDiscovery: vi.fn(),
        runMcpServerHealthCheck: vi.fn(),
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      payload: {
        label: "Remote GitHub MCP",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("not part of the 1.0 runtime-invokable surface"),
    });
    expect(createMcpServer).not.toHaveBeenCalled();
  });

  it("allows the built-in Approval Inbox template even though it uses an internal http transport", async () => {
    const createMcpServer = vi.fn((input) => ({
      serverId: "srv-approval-inbox",
      authType: "none",
      enabled: true,
      status: "connected",
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
      ...input,
    }));

    app = Fastify();
    app.decorate("services", {
      mcp: {
        invokeMcpTool: vi.fn(),
        listMcpServers: vi.fn(),
        createMcpServer,
        updateMcpServer: vi.fn(),
        deleteMcpServer: vi.fn(),
        connectMcpServer: vi.fn(),
        disconnectMcpServer: vi.fn(),
        startMcpOAuth: vi.fn(),
        completeMcpOAuth: vi.fn(),
        listMcpTools: vi.fn(),
        updateMcpServerPolicy: vi.fn(),
        listMcpTemplates: vi.fn(),
        listMcpTemplateDiscovery: vi.fn(),
        runMcpServerHealthCheck: vi.fn(),
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      payload: {
        label: "Approval Inbox",
        transport: "http",
        url: MCP_APPROVAL_INBOX_URL,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Approval Inbox",
        transport: "http",
        url: MCP_APPROVAL_INBOX_URL,
      }),
    );
  });
});
