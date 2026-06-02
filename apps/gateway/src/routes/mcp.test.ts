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
        workspaceId: "workspace-1",
        autonomousActivation: true,
        estimatedCostUsd: 0.25,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(invokeMcpTool).toHaveBeenCalledWith({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "operator",
      sessionId: "sess-1",
      workspaceId: "workspace-1",
      autonomousActivation: true,
      estimatedCostUsd: 0.25,
      policyContext: expect.objectContaining({
        operatorId: "operator",
        authActorId: "operator",
        workspaceId: "workspace-1",
        sessionId: "sess-1",
        surface: "mcp",
      }),
      consentContext: {
        operatorId: "operator",
        source: "ui",
        reason: "mcp.invoke",
      },
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

  it("rejects unsupported OAuth remote MCP server creation before token resolution is promoted", async () => {
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
        authType: "oauth2",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("requires local stdio"),
    });
    expect(createMcpServer).not.toHaveBeenCalled();
  });

  it("allows supported remote MCP server creation through the runtime bridge boundary", async () => {
    const createMcpServer = vi.fn((input) => ({
      serverId: "srv-remote",
      enabled: true,
      status: "disconnected",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
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
        label: "Remote Learn MCP",
        transport: "http",
        url: "https://learn.microsoft.com/api/mcp",
        authType: "none",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Remote Learn MCP",
        transport: "http",
        url: "https://learn.microsoft.com/api/mcp",
        authType: "none",
      }),
    );
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

  it("serves a read-only remote MCP preview with supported remote transports callable", async () => {
    const service = await registerMcpService({
      listMcpServers: vi.fn(() => [
        {
          serverId: "srv-http",
          label: "Remote HTTP",
          transport: "http",
          url: "https://mcp.example.test/sse",
          authType: "token",
          enabled: true,
          status: "connected",
          category: "research",
          trustTier: "restricted",
          costTier: "unknown",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "strict",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
            allowedEnvKeys: ["REMOTE_MCP_TOKEN"],
            notes: "preview only",
          },
          createdAt: "2026-05-30T00:00:00.000Z",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          serverId: "srv-approval-inbox-quarantined",
          label: "Approval Inbox Quarantined",
          transport: "http",
          url: MCP_APPROVAL_INBOX_URL,
          authType: "none",
          enabled: true,
          status: "connected",
          category: "orchestration",
          trustTier: "quarantined",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
            notes: "trust review required",
          },
          createdAt: "2026-05-30T00:00:00.000Z",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ]),
      listMcpTemplates: vi.fn(() => [
        {
          templateId: "remote-template",
          label: "Remote template",
          description: "Remote MCP template",
          transport: "sse",
          url: "https://mcp.example.test/events",
          authType: "oauth2",
          category: "research",
          trustTier: "restricted",
          costTier: "unknown",
          enabledByDefault: false,
          installed: false,
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "strict",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
      ]),
    });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/remote-preview",
    });

    expect(response.statusCode).toBe(200);
    expect(service.listMcpServers).toHaveBeenCalledWith();
    expect(service.listMcpTemplates).toHaveBeenCalledWith();
    expect(response.json()).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      experimentalRemoteRecordsAllowed: false,
      runtimeSupport: "remote_http_sse_bridge",
      summary: {
        remoteServers: 2,
        remoteTemplates: 1,
        runtimeSupported: 1,
        blocked: 2,
        configuredOnly: 0,
        notCallable: 2,
        experimentalRecords: 0,
        quarantined: 1,
        needsAuth: 1,
      },
      items: [
        expect.objectContaining({
          label: "Approval Inbox Quarantined",
          posture: "blocked",
          callableState: "not_callable",
          invocationState: "quarantined",
          runtimePath: "internal_approval_inbox",
          transportRuntimeSupported: true,
          runtimeSupported: false,
          blockers: [expect.stringContaining("quarantined")],
        }),
        expect.objectContaining({
          label: "Remote HTTP",
          posture: "runtime_supported",
          callableState: "runtime_invokable",
          invocationState: "runtime_invokable",
          runtimePath: "generic_remote_http_sse",
          transportRuntimeSupported: true,
          runtimeSupported: true,
          operatorNextAction: expect.stringContaining("governed MCP runtime path"),
          blockers: [],
        }),
        expect.objectContaining({
          label: "Remote template",
          posture: "blocked",
          callableState: "not_callable",
          invocationState: "blocked",
          createAllowed: false,
          authReadiness: "missing_oauth_config",
          operatorNextAction: expect.stringContaining("OAuth authorizationUrl"),
        }),
      ],
    });
  });

  it("keeps experimental remote MCP records non-callable in the preview", async () => {
    const previous = process.env.GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS;
    process.env.GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS = "true";
    try {
      await registerMcpService({
        listMcpServers: vi.fn(() => []),
        listMcpTemplates: vi.fn(() => [
          {
            templateId: "remote-template",
            label: "Experimental remote template",
            description: "Remote MCP template",
            transport: "http",
            url: "https://mcp.example.test/events",
            authType: "token",
            category: "research",
            trustTier: "restricted",
            costTier: "unknown",
            enabledByDefault: false,
            installed: false,
            policy: {
              requireFirstToolApproval: true,
              redactionMode: "strict",
              allowedToolPatterns: [],
              blockedToolPatterns: [],
            },
          },
        ]),
      });

      const response = await app!.inject({
        method: "GET",
        url: "/api/v1/mcp/remote-preview",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        experimentalRemoteRecordsAllowed: true,
        runtimeSupport: "experimental_records_only",
        summary: {
          runtimeSupported: 0,
          notCallable: 1,
          experimentalRecords: 1,
          needsAuth: 0,
        },
        items: [
          expect.objectContaining({
            label: "Experimental remote template",
            posture: "experimental_record_allowed",
            callableState: "not_callable",
            invocationState: "experimental_record_only",
            createAllowed: true,
            transportRuntimeSupported: false,
            runtimeSupported: false,
            operatorNextAction: expect.stringContaining("experimental record only"),
          }),
        ],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS;
      } else {
        process.env.GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS = previous;
      }
    }
  });

  it("serves a read-only MCP server-mode manifest from the callable capability catalog", async () => {
    const mcp = createMcpService();
    const listCapabilityCatalog = vi.fn((scope: "inspectable" | "callable") =>
      scope === "inspectable"
        ? [
            {
              capabilityId: "tool:fs.read",
              kind: "tool",
              category: "built_in",
              title: "Read file",
              summary: "Read a file through Gateway policy.",
              callable: true,
              toolName: "fs.read",
              wrapperVisibility: { readOnly: true, deterministic: true, codeModeAllowed: true },
            },
            {
              capabilityId: "candidate:unsafe",
              kind: "candidate_skill",
              category: "self_generated",
              title: "Unsafe candidate",
              summary: "Inspectable only.",
              callable: false,
            },
          ]
        : [
            {
              capabilityId: "tool:fs.read",
              kind: "tool",
              category: "built_in",
              title: "Read file",
              summary: "Read a file through Gateway policy.",
              callable: true,
              toolName: "fs.read",
              wrapperVisibility: { readOnly: true, deterministic: true, codeModeAllowed: true },
            },
          ],
    );

    app = Fastify();
    app.decorate("services", {
      mcp,
      capabilities: {
        listCapabilityCatalog,
      },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/mcp/server-mode/manifest",
    });

    expect(response.statusCode).toBe(200);
    expect(listCapabilityCatalog).toHaveBeenCalledWith("inspectable");
    expect(listCapabilityCatalog).toHaveBeenCalledWith("callable");
    expect(response.json()).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      status: "preview",
      protocol: "mcp",
      runtimeSupport: "manifest_only",
      runtime: {
        callPreview: {
          supported: false,
          endpoint: "/api/v1/mcp/server-mode/call",
          requiresGatewayAuth: true,
          readOnlyOnly: true,
          requiredCallContext: ["agentId", "sessionId"],
        },
        stdio: {
          supported: true,
          command: "goatcitadel",
          args: ["mcp-server"],
          requiresGatewayAuth: true,
          gatewayEndpoint: "/api/v1/mcp/server-mode/manifest",
        },
      },
      launch: {
        supported: true,
        command: "goatcitadel",
        args: ["mcp-server"],
        reason: expect.stringContaining("stdio MCP protocol proxy"),
      },
      summary: {
        inspectableCapabilities: 2,
        gatewayCallableCapabilities: 1,
        exportedToolDescriptors: 1,
        blockedDescriptors: 0,
      },
      tools: [
        expect.objectContaining({
          name: "goatcitadel.fs.read",
          capabilityId: "tool:fs.read",
          gatewayCallable: true,
          serverModeState: "descriptor_only",
          blockers: [expect.stringContaining("tools/call is not available")],
          annotations: expect.objectContaining({
            readOnlyHint: true,
            destructiveHint: false,
          }),
        }),
      ],
      governance: expect.arrayContaining([
        expect.stringContaining("read-only"),
        expect.stringContaining("Gateway-owned"),
      ]),
      limitations: expect.arrayContaining([expect.stringContaining("Gateway-backed proxy")]),
      evidence: {
        catalogScope: "callable",
        catalogSnapshot: [{ capabilityId: "tool:fs.read", kind: "tool", callable: true }],
      },
    });
  });

  it("routes MCP server-mode call preview through Gateway tool invocation for eligible read-only descriptors", async () => {
    const invokeTool = vi.fn(async () => ({
      outcome: "executed",
      policyReason: "allowed by test profile",
      auditEventId: "audit-1",
      result: { content: "ok" },
    }));
    const resolveToolPolicyContext = vi.fn(() => ({
      operatorId: "operator",
      authActorId: "operator",
      surface: "mcp",
      sessionId: "session-1",
    }));
    const listCapabilityCatalog = vi.fn((scope: "inspectable" | "callable") =>
      scope === "inspectable"
        ? [
            {
              capabilityId: "tool:fs.read",
              kind: "tool",
              category: "built_in",
              title: "Read file",
              summary: "Read a file through Gateway policy.",
              callable: true,
              toolName: "fs.read",
              wrapperVisibility: { readOnly: true, deterministic: true, codeModeAllowed: true },
            },
          ]
        : [
            {
              capabilityId: "tool:fs.read",
              kind: "tool",
              category: "built_in",
              title: "Read file",
              summary: "Read a file through Gateway policy.",
              callable: true,
              toolName: "fs.read",
              wrapperVisibility: { readOnly: true, deterministic: true, codeModeAllowed: true },
            },
          ],
    );

    app = Fastify();
    app.decorate("services", {
      mcp: createMcpService(),
      capabilities: { listCapabilityCatalog },
      tools: { resolveToolPolicyContext },
      toolsInvoke: { invokeTool },
    } as never);
    await app.register(mcpRoutes);

    const manifest = await app.inject({ method: "GET", url: "/api/v1/mcp/server-mode/manifest" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({
      runtimeSupport: "stdio_proxy",
      runtime: {
        callPreview: { supported: true },
        stdio: {
          supported: true,
          command: "goatcitadel",
          args: ["mcp-server"],
          requiresGatewayAuth: true,
        },
      },
      launch: { supported: true },
      tools: [expect.objectContaining({ name: "goatcitadel.fs.read", serverModeState: "call_preview" })],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/server-mode/call",
      payload: {
        descriptorName: "goatcitadel.fs.read",
        args: { path: "README.md" },
        agentId: "agent-1",
        sessionId: "session-1",
        workspaceId: "default",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveToolPolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        authActorId: "operator",
        workspaceId: "default",
        sessionId: "session-1",
        surface: "mcp",
      }),
    );
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "fs.read",
        args: { path: "README.md" },
        agentId: "agent-1",
        sessionId: "session-1",
        workspaceId: "default",
        surface: "mcp",
        externalRuntime: true,
        sourceAttribution: [
          expect.objectContaining({
            sourceType: "mcp",
            sourceRef: "mcp_server_mode_preview",
          }),
        ],
        consentContext: expect.objectContaining({
          operatorId: "operator",
          source: "agent",
          reason: "mcp.server-mode.call-preview",
        }),
      }),
    );
    expect(response.json()).toMatchObject({
      readOnly: true,
      mutationSemantics: "governed_tool_invocation",
      descriptorName: "goatcitadel.fs.read",
      capabilityId: "tool:fs.read",
      toolName: "fs.read",
      outcome: "executed",
      policyReason: "allowed by test profile",
      auditEventId: "audit-1",
      result: { content: "ok" },
      evidence: {
        serverModeState: "call_preview",
        gatewayCallable: true,
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
  });

  it("blocks MCP server-mode call preview for open-world or non-tool descriptors", async () => {
    app = Fastify();
    app.decorate("services", {
      mcp: createMcpService(),
      capabilities: {
        listCapabilityCatalog: vi.fn(() => [
          {
            capabilityId: "tool:web.search",
            kind: "tool",
            category: "built_in",
            title: "Web Search",
            summary: "Search the web.",
            callable: true,
            toolName: "web.search",
            wrapperVisibility: { readOnly: true, deterministic: false, codeModeAllowed: false },
          },
        ]),
      },
      tools: { resolveToolPolicyContext: vi.fn(() => ({})) },
      toolsInvoke: { invokeTool: vi.fn() },
    } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/server-mode/call",
      payload: {
        descriptorName: "goatcitadel.web.search",
        args: { q: "goatcitadel" },
        agentId: "agent-1",
        sessionId: "session-1",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringContaining("read-only, closed-world"),
      evidence: {
        serverModeState: "descriptor_only",
        openWorldHint: true,
      },
    });
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
