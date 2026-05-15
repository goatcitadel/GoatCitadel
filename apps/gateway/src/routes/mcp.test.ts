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

  function createMcpService(overrides: Record<string, unknown> = {}) {
    return {
      invokeMcpTool: vi.fn(async (input: Record<string, unknown>) => ({
        ok: true,
        ...input,
      })),
      listMcpServers: vi.fn(() => [{ serverId: "srv-1", label: "Playwright" }]),
      listMcpTemplates: vi.fn(() => [{ templateId: "approval-inbox", label: "Approval Inbox" }]),
      listMcpTemplateDiscovery: vi.fn(() => [{ templateId: "filesystem", category: "development" }]),
      createMcpServer: vi.fn((input: Record<string, unknown>) => ({
        serverId: "srv-created",
        ...input,
      })),
      updateMcpServer: vi.fn((serverId: string, input: Record<string, unknown>) => ({
        serverId,
        ...input,
      })),
      deleteMcpServer: vi.fn((serverId: string) => ({ deleted: true, serverId })),
      connectMcpServer: vi.fn(async (serverId: string) => ({ serverId, status: "connected" })),
      disconnectMcpServer: vi.fn((serverId: string) => ({ serverId, status: "disconnected" })),
      startMcpOAuth: vi.fn((serverId: string) => ({ serverId, authorizationUrl: "https://example.test/oauth" })),
      completeMcpOAuth: vi.fn(async (serverId: string, code: string, state?: string) => ({
        serverId,
        code,
        state,
        status: "connected",
      })),
      listMcpTools: vi.fn((serverId: string) => [{ serverId, toolName: "tool.echo" }]),
      updateMcpServerPolicy: vi.fn((serverId: string, policy: Record<string, unknown>) => ({
        serverId,
        policy,
      })),
      runMcpServerHealthCheck: vi.fn((serverId: string) => ({ serverId, ok: true })),
      ...overrides,
    };
  }

  async function registerMcpService(overrides: Record<string, unknown> = {}) {
    const service = createMcpService(overrides);
    app = Fastify();
    app.decorate("services", { mcp: service } as never);
    await app.register(mcpRoutes);
    return service;
  }

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

  it("serves MCP server, template, and discovery read routes", async () => {
    const service = await registerMcpService();

    const serversResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/servers",
    });
    const templatesResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/templates",
    });
    const discoveryResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/templates/discovery",
    });

    expect(serversResponse.statusCode).toBe(200);
    expect(templatesResponse.statusCode).toBe(200);
    expect(discoveryResponse.statusCode).toBe(200);
    expect(service.listMcpServers).toHaveBeenCalledWith();
    expect(service.listMcpTemplates).toHaveBeenCalledWith();
    expect(service.listMcpTemplateDiscovery).toHaveBeenCalledWith();
    expect(serversResponse.json()).toEqual({ items: [{ serverId: "srv-1", label: "Playwright" }] });
    expect(templatesResponse.json()).toEqual({ items: [{ templateId: "approval-inbox", label: "Approval Inbox" }] });
    expect(discoveryResponse.json()).toEqual({ items: [{ templateId: "filesystem", category: "development" }] });
  });

  it("maps MCP template discovery conflicts to 409", async () => {
    await registerMcpService({
      listMcpTemplateDiscovery: vi.fn(() => {
        throw new Error("discovery disabled");
      }),
    });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/templates/discovery",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "discovery disabled" });
  });

  it("updates, deletes, disconnects, and OAuth-completes MCP servers", async () => {
    const service = await registerMcpService();

    const updateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/mcp/servers/srv-1",
      payload: {
        label: "Updated MCP",
        enabled: false,
      },
    });
    const deleteResponse = await app!.inject({
      method: "DELETE",
      url: "/api/v1/mcp/servers/srv-1",
    });
    const disconnectResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/disconnect",
    });
    const oauthStartResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/oauth/start",
    });
    const oauthCompleteResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/oauth/complete",
      payload: {
        code: "oauth-code",
        state: "oauth-state",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(deleteResponse.statusCode).toBe(200);
    expect(disconnectResponse.statusCode).toBe(200);
    expect(oauthStartResponse.statusCode).toBe(200);
    expect(oauthCompleteResponse.statusCode).toBe(200);
    expect(service.updateMcpServer).toHaveBeenCalledWith("srv-1", {
      label: "Updated MCP",
      enabled: false,
    });
    expect(service.deleteMcpServer).toHaveBeenCalledWith("srv-1");
    expect(service.disconnectMcpServer).toHaveBeenCalledWith("srv-1");
    expect(service.startMcpOAuth).toHaveBeenCalledWith("srv-1");
    expect(service.completeMcpOAuth).toHaveBeenCalledWith("srv-1", "oauth-code", "oauth-state");
    expect(oauthCompleteResponse.json()).toMatchObject({
      serverId: "srv-1",
      state: "oauth-state",
      status: "connected",
    });
  });

  it("lists tools and updates policy for one MCP server", async () => {
    const service = await registerMcpService();

    const toolsResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/servers/srv-1/tools",
    });
    const policyResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/mcp/servers/srv-1/policy",
      payload: {
        requireFirstToolApproval: true,
        redactionMode: "strict",
        allowedToolPatterns: ["tool.*"],
      },
    });

    expect(toolsResponse.statusCode).toBe(200);
    expect(policyResponse.statusCode).toBe(200);
    expect(service.listMcpTools).toHaveBeenCalledWith("srv-1");
    expect(service.updateMcpServerPolicy).toHaveBeenCalledWith("srv-1", {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: ["tool.*"],
    });
    expect(toolsResponse.json()).toEqual({ items: [{ serverId: "srv-1", toolName: "tool.echo" }] });
    expect(policyResponse.json()).toMatchObject({
      serverId: "srv-1",
      policy: {
        redactionMode: "strict",
      },
    });
  });

  it("maps MCP service failures to their route error status", async () => {
    await registerMcpService({
      updateMcpServer: vi.fn(() => {
        throw new Error("update failed");
      }),
      disconnectMcpServer: vi.fn(() => {
        throw new Error("disconnect failed");
      }),
      startMcpOAuth: vi.fn(() => {
        throw new Error("oauth disabled");
      }),
      completeMcpOAuth: vi.fn(async () => {
        throw new Error("oauth rejected");
      }),
      listMcpTools: vi.fn(() => {
        throw new Error("tools missing");
      }),
      updateMcpServerPolicy: vi.fn(() => {
        throw new Error("policy missing");
      }),
    });

    const updateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/mcp/servers/srv-1",
      payload: {
        label: "Updated MCP",
      },
    });
    const disconnectResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/disconnect",
    });
    const oauthStartResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/oauth/start",
    });
    const oauthCompleteResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/oauth/complete",
      payload: {
        code: "oauth-code",
      },
    });
    const toolsResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/servers/srv-1/tools",
    });
    const policyResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/mcp/servers/srv-1/policy",
      payload: {
        requireFirstToolApproval: true,
      },
    });

    expect(updateResponse.statusCode).toBe(400);
    expect(disconnectResponse.statusCode).toBe(400);
    expect(oauthStartResponse.statusCode).toBe(400);
    expect(oauthCompleteResponse.statusCode).toBe(400);
    expect(toolsResponse.statusCode).toBe(404);
    expect(policyResponse.statusCode).toBe(404);
    expect(updateResponse.json()).toEqual({ error: "update failed" });
    expect(toolsResponse.json()).toEqual({ error: "tools missing" });
  });

  it("rejects malformed MCP route inputs before calling services", async () => {
    const service = await registerMcpService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      payload: {
        label: "",
        transport: "stdio",
      },
    });
    const updateResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/mcp/servers/",
      payload: {
        label: "Updated",
      },
    });
    const oauthCompleteResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/servers/srv-1/oauth/complete",
      payload: {},
    });
    const invokeResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: {
        serverId: "",
        toolName: "",
      },
    });
    const policyResponse = await app!.inject({
      method: "PATCH",
      url: "/api/v1/mcp/servers/srv-1/policy",
      payload: {
        redactionMode: "maximum",
      },
    });

    expect(createResponse.statusCode).toBe(400);
    expect(updateResponse.statusCode).toBe(400);
    expect(oauthCompleteResponse.statusCode).toBe(400);
    expect(invokeResponse.statusCode).toBe(400);
    expect(policyResponse.statusCode).toBe(400);
    expect(service.createMcpServer).not.toHaveBeenCalled();
    expect(service.completeMcpOAuth).not.toHaveBeenCalled();
    expect(service.invokeMcpTool).not.toHaveBeenCalled();
    expect(service.updateMcpServerPolicy).not.toHaveBeenCalled();
  });
});
