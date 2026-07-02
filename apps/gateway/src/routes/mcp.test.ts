import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { MCP_APPROVAL_INBOX_URL } from "../services/mcp-approval-inbox.js";
import { MCP_ROUTE_ELICITATION_LIMITS, McpElicitationService } from "../services/mcp-elicitation-service.js";
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
      elicitations: new McpElicitationService(),
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
    await registerMcpRoutesForTest(app);
    return service;
  }

  // Registers the MCP routes behind a stand-in for the auth plugin: the
  // authenticated operator is taken from the `x-test-actor` header and stamped
  // onto `request.authActorId`, exactly as the real auth plugin does via
  // setAuthActor. This lets us exercise operator-scoped behavior on the HTTP
  // routes without pulling in the full auth stack.
  async function registerMcpServiceWithAuth(overrides: Record<string, unknown> = {}) {
    const service = createMcpService(overrides);
    app = Fastify();
    app.decorate("services", { mcp: service } as never);
    app.decorateRequest("authActorId", "anonymous");
    app.addHook("onRequest", async (request) => {
      const header = request.headers["x-test-actor"];
      const actorId = Array.isArray(header) ? header[0] : header;
      if (typeof actorId === "string" && actorId.trim()) {
        (request as { authActorId?: string }).authActorId = actorId.trim();
      }
    });
    await registerMcpRoutesForTest(app);
    return service;
  }

  async function registerMcpRoutesForTest(instance: FastifyInstance) {
    instance.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await instance.register(mcpRoutes);
  }

  it("fails closed when MCP routes are registered without operator auth", async () => {
    app = Fastify();
    app.decorate("services", { mcp: createMcpService() } as never);
    await app.register(mcpRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/mcp/servers",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "Operator authentication is not installed for this route.",
    });
  });

  it("creates and lists MCP elicitation requests with bounded audit and evidence metadata", async () => {
    await registerMcpService();

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Choose the deployment environment.",
        requestedSchema: {
          type: "object",
          properties: {
            environment: { type: "string", enum: ["staging", "production"] },
          },
          required: ["environment"],
        },
        owner: {
          operatorId: "operator-1",
          agentId: "agent-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          surface: "mcp",
        },
        source: {
          sourceType: "mcp_server",
          serverId: "srv-1",
          toolName: "deploy.plan",
          jsonRpcRequestId: 7,
          transport: "stdio",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json();
    expect(created).toMatchObject({
      method: "elicitation/create",
      status: "pending",
      prompt: {
        text: "Choose the deployment environment.",
        maxChars: MCP_ROUTE_ELICITATION_LIMITS.promptMaxChars,
        truncated: false,
      },
      requestedSchema: {
        maxBytes: MCP_ROUTE_ELICITATION_LIMITS.requestedSchemaMaxBytes,
        truncated: false,
      },
      protocol: {
        method: "elicitation/create",
        message: "Choose the deployment environment.",
      },
      owner: {
        operatorId: "operator-1",
        sessionId: "session-1",
        surface: "mcp",
      },
      source: {
        sourceType: "mcp_server",
        serverId: "srv-1",
        toolName: "deploy.plan",
        jsonRpcRequestId: 7,
        transport: "stdio",
      },
      policy: {
        sensitiveInformationAllowed: false,
        transportBoundary: "gateway_local_mcp",
        remoteTransportSupport: "unchanged",
      },
      audit: {
        reasonCodes: ["mcp_elicitation_created", "gateway_route_local_evidence"],
      },
      evidence: {
        status: "pending",
        owner: { operatorId: "operator-1" },
        source: { serverId: "srv-1" },
        statusHistory: [
          expect.objectContaining({
            status: "pending",
            auditEventId: expect.stringContaining("gateway:mcp:elicitation:"),
          }),
        ],
      },
    });
    expect(created.elicitationId).toEqual(expect.stringMatching(/^mcp-elicit-/));
    expect(created.audit.auditEventIds[0]).toContain(`${created.elicitationId}:created`);

    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/elicitations?status=pending&serverId=srv-1&sessionId=session-1",
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      items: [expect.objectContaining({ elicitationId: created.elicitationId, status: "pending" })],
    });
  });

  it("scopes the MCP elicitation HTTP list to the authenticated operator", async () => {
    await registerMcpServiceWithAuth();

    const createForActor = async (actorId: string, label: string) => {
      const created = await app!.inject({
        method: "POST",
        url: "/api/v1/mcp/elicitations",
        headers: { "x-test-actor": actorId },
        payload: {
          prompt: `Choose ${label}.`,
          requestedSchema: {
            type: "object",
            properties: { choice: { type: "string" } },
            required: ["choice"],
          },
        },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      // Owner operatorId is derived from the authenticated request, not the body.
      expect(body.owner.operatorId).toBe(actorId);
      return body.elicitationId as string;
    };

    const elicitationA = await createForActor("operator-a", "A");
    const elicitationB = await createForActor("operator-b", "B");

    // Operator A lists: only A's elicitation is visible; B's is excluded.
    const listAsA = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/elicitations",
      headers: { "x-test-actor": "operator-a" },
    });
    expect(listAsA.statusCode).toBe(200);
    const idsForA = (listAsA.json().items as Array<{ elicitationId: string }>).map((item) => item.elicitationId);
    expect(idsForA).toContain(elicitationA);
    expect(idsForA).not.toContain(elicitationB);

    // Symmetry check: operator B sees only B's elicitation.
    const listAsB = await app!.inject({
      method: "GET",
      url: "/api/v1/mcp/elicitations",
      headers: { "x-test-actor": "operator-b" },
    });
    expect(listAsB.statusCode).toBe(200);
    const idsForB = (listAsB.json().items as Array<{ elicitationId: string }>).map((item) => item.elicitationId);
    expect(idsForB).toContain(elicitationB);
    expect(idsForB).not.toContain(elicitationA);
  });

  it("truncates oversized MCP elicitation prompts and redacts secrets before storage", async () => {
    await registerMcpService();

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        message: `token=secret-token-value-1234567890 ${"x".repeat(MCP_ROUTE_ELICITATION_LIMITS.promptMaxChars + 128)}`,
        requestedSchema: {
          type: "object",
          properties: {
            answer: { type: "string" },
          },
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.prompt.truncated).toBe(true);
    expect(body.prompt.text).toContain("[REDACTED]");
    expect(body.prompt.text).toContain("[prompt truncated]");
    expect(body.prompt.text).not.toContain("secret-token-value");
    expect(body.prompt.charLength).toBeLessThanOrEqual(MCP_ROUTE_ELICITATION_LIMITS.promptMaxChars);
    expect(body.evidence.prompt).toMatchObject({
      truncated: true,
      redactedSecretCount: 1,
    });
  });

  it("rejects oversized MCP elicitation schemas without echoing secret-bearing bodies", async () => {
    await registerMcpService();

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Collect non-sensitive deployment metadata.",
        requestedSchema: {
          type: "object",
          properties: {
            notes: {
              type: "string",
              description: `token=secret-token-value-1234567890 ${"x".repeat(
                MCP_ROUTE_ELICITATION_LIMITS.requestedSchemaMaxBytes,
              )}`,
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: `MCP elicitation requestedSchema exceeded ${MCP_ROUTE_ELICITATION_LIMITS.requestedSchemaMaxBytes} bytes.`,
    });
    expect(response.body).not.toContain("secret-token-value");
  });

  it("records MCP elicitation response transitions and prevents duplicate resolution", async () => {
    await registerMcpService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Pick a safe rollout track.",
        requestedSchema: {
          type: "object",
          properties: {
            track: { type: "string", enum: ["canary", "hold"] },
          },
        },
        owner: { operatorId: "operator-1", sessionId: "session-response" },
      },
    });
    const created = createResponse.json();

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/mcp/elicitations/${created.elicitationId}/respond`,
      payload: {
        action: "accept",
        content: {
          track: "canary",
          note: "token=secret-token-value-1234567890",
        },
        owner: {
          operatorId: "operator-1",
          sessionId: "session-response",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const resolved = response.json();
    expect(resolved).toMatchObject({
      elicitationId: created.elicitationId,
      status: "accepted",
      response: {
        action: "accept",
        owner: {
          operatorId: "operator-1",
          sessionId: "session-response",
        },
        content: {
          value: {
            track: "canary",
            note: "token=[REDACTED]",
          },
          maxBytes: MCP_ROUTE_ELICITATION_LIMITS.responseContentMaxBytes,
          redactedSecretCount: 1,
        },
      },
      evidence: {
        status: "accepted",
        responseContent: {
          maxBytes: MCP_ROUTE_ELICITATION_LIMITS.responseContentMaxBytes,
          redactedSecretCount: 1,
        },
        statusHistory: [
          expect.objectContaining({ status: "pending" }),
          expect.objectContaining({ status: "accepted", previousStatus: "pending" }),
        ],
      },
      audit: {
        reasonCodes: expect.arrayContaining(["mcp_elicitation_responded", "mcp_elicitation_accept"]),
      },
    });
    expect(response.body).not.toContain("secret-token-value");

    const duplicate = await app!.inject({
      method: "POST",
      url: `/api/v1/mcp/elicitations/${created.elicitationId}/respond`,
      payload: {
        action: "decline",
        owner: { operatorId: "operator-1" },
      },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "MCP elicitation request has already been resolved." });
  });

  it("rejects MCP elicitation responses that try to rewrite owner scope", async () => {
    await registerMcpService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Pick a safe rollout track.",
        requestedSchema: {
          type: "object",
          properties: {
            track: { type: "string", enum: ["canary", "hold"] },
          },
        },
        owner: {
          operatorId: "operator-1",
          sessionId: "session-response",
          workspaceId: "workspace-1",
        },
      },
    });
    const created = createResponse.json();

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/mcp/elicitations/${created.elicitationId}/respond`,
      payload: {
        action: "accept",
        content: { track: "canary" },
        owner: {
          operatorId: "operator-2",
          sessionId: "session-response",
          workspaceId: "workspace-1",
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "MCP elicitation response owner operatorId must match the original request owner scope.",
    });
  });

  it("rejects MCP elicitation responses without caller owner scope", async () => {
    await registerMcpService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Pick a safe rollout track.",
        requestedSchema: {
          type: "object",
          properties: {
            track: { type: "string", enum: ["canary", "hold"] },
          },
        },
        owner: { operatorId: "operator-1" },
      },
    });
    const created = createResponse.json();

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/mcp/elicitations/${created.elicitationId}/respond`,
      payload: {
        action: "cancel",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "MCP elicitation response requires caller owner scope.",
    });
  });

  it("maps MCP elicitation decline and cancel actions to terminal statuses without response content", async () => {
    await registerMcpService();

    const declineCreate = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Can the server use this non-sensitive label?",
        requestedSchema: { type: "object", properties: { label: { type: "string" } } },
        owner: { operatorId: "operator-3" },
      },
    });
    const cancelCreate = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Continue this optional MCP workflow?",
        requestedSchema: { type: "object", properties: { continue: { type: "boolean" } } },
        owner: { operatorId: "operator-3" },
      },
    });

    const declined = await app!.inject({
      method: "POST",
      url: `/api/v1/mcp/elicitations/${declineCreate.json().elicitationId}/respond`,
      payload: { action: "decline", owner: { operatorId: "operator-3" } },
    });
    const cancelled = await app!.inject({
      method: "POST",
      url: `/api/v1/mcp/elicitations/${cancelCreate.json().elicitationId}/respond`,
      payload: { action: "cancel", owner: { operatorId: "operator-3" } },
    });

    expect(declined.statusCode).toBe(200);
    expect(cancelled.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({
      status: "declined",
      response: {
        action: "decline",
      },
    });
    expect(cancelled.json()).toMatchObject({
      status: "cancelled",
      response: {
        action: "cancel",
      },
    });
    expect(declined.json().response).not.toHaveProperty("content");
    expect(cancelled.json().response).not.toHaveProperty("content");
  });

  it("rejects oversized accepted MCP elicitation responses without echoing secret-bearing content", async () => {
    await registerMcpService();

    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/elicitations",
      payload: {
        prompt: "Provide a short non-sensitive value.",
        requestedSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
    const created = createResponse.json();

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/mcp/elicitations/${created.elicitationId}/respond`,
      payload: {
        action: "accept",
        content: {
          value: `token=secret-token-value-1234567890 ${"y".repeat(
            MCP_ROUTE_ELICITATION_LIMITS.responseContentMaxBytes,
          )}`,
        },
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: `MCP elicitation responseContent exceeded ${MCP_ROUTE_ELICITATION_LIMITS.responseContentMaxBytes} bytes.`,
    });
    expect(response.body).not.toContain("secret-token-value");
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
    await registerMcpRoutesForTest(app);

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

  it("fails closed and skips invokeMcpTool when the target MCP server needs re-auth", async () => {
    const service = await registerMcpService({
      listMcpServers: vi.fn(() => [
        {
          serverId: "srv-oauth",
          label: "Remote OAuth MCP",
          authType: "oauth2",
          authState: { authType: "oauth2", readiness: "needs_auth" },
        },
      ]),
    });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: { serverId: "srv-oauth", toolName: "remote.read", agentId: "operator" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("needs re-authentication"),
    });
    expect(service.invokeMcpTool).not.toHaveBeenCalled();
  });

  it("fails closed when the target MCP server's OAuth token is expired", async () => {
    const service = await registerMcpService({
      listMcpServers: vi.fn(() => [
        {
          serverId: "srv-oauth",
          label: "Remote OAuth MCP",
          authType: "oauth2",
          authState: { authType: "oauth2", readiness: "expired" },
        },
      ]),
    });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: { serverId: "srv-oauth", toolName: "remote.read" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("expired"),
    });
    expect(service.invokeMcpTool).not.toHaveBeenCalled();
  });

  it("invokes a ready MCP server through the auth gate", async () => {
    const service = await registerMcpService({
      listMcpServers: vi.fn(() => [
        {
          serverId: "srv-oauth",
          label: "Remote OAuth MCP",
          authType: "oauth2",
          authState: { authType: "oauth2", readiness: "ready" },
        },
      ]),
    });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: { serverId: "srv-oauth", toolName: "remote.read" },
    });

    expect(response.statusCode).toBe(200);
    expect(service.invokeMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-oauth", toolName: "remote.read" }),
    );
  });

  it("rejects an ambiguous bare tool name exposed by more than one connected MCP server", async () => {
    const connectedServer = (serverId: string, label: string) => ({
      serverId,
      label,
      authType: "none" as const,
      enabled: true,
      status: "connected" as const,
      trustTier: "restricted" as const,
    });
    const service = await registerMcpService({
      listMcpServers: vi.fn(() => [connectedServer("srv-a", "Server A"), connectedServer("srv-b", "Server B")]),
      listMcpTools: vi.fn((serverId: string) => [{ serverId, toolName: "read_file", enabled: true }]),
    });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: { serverId: "srv-a", toolName: "read_file" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("mcp__srv-a__read_file"),
    });
    expect(service.invokeMcpTool).not.toHaveBeenCalled();
  });

  it("resolves a namespaced mcp__<serverId>__<tool> name to its server and strips the prefix", async () => {
    const connectedServer = (serverId: string, label: string) => ({
      serverId,
      label,
      authType: "none" as const,
      enabled: true,
      status: "connected" as const,
      trustTier: "restricted" as const,
    });
    const service = await registerMcpService({
      listMcpServers: vi.fn(() => [connectedServer("srv-a", "Server A"), connectedServer("srv-b", "Server B")]),
      listMcpTools: vi.fn((serverId: string) => [{ serverId, toolName: "read_file", enabled: true }]),
    });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: { serverId: "ignored", toolName: "mcp__srv-b__read_file" },
    });

    expect(response.statusCode).toBe(200);
    expect(service.invokeMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-b", toolName: "read_file" }),
    );
  });

  it("returns 404 for a namespaced tool that targets an unknown MCP server", async () => {
    const service = await registerMcpService({
      listMcpServers: vi.fn(() => [{ serverId: "srv-a", label: "Server A" }]),
    });

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/mcp/invoke",
      payload: { serverId: "srv-a", toolName: "mcp__srv-missing__read_file" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("srv-missing"),
    });
    expect(service.invokeMcpTool).not.toHaveBeenCalled();
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
    await registerMcpRoutesForTest(app);

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
    await registerMcpRoutesForTest(app);

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
    await registerMcpRoutesForTest(app);

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
    await registerMcpRoutesForTest(app);

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
    await registerMcpRoutesForTest(app);

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
    await registerMcpRoutesForTest(app);

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

  it("rejects caller-created internal goatcitadel MCP servers", async () => {
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
    await registerMcpRoutesForTest(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      payload: {
        label: "Approval Inbox",
        transport: "http",
        url: MCP_APPROVAL_INBOX_URL,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Internal goatcitadel:// MCP servers are Gateway-owned and cannot be created or assigned by callers.",
    });
    expect(createMcpServer).not.toHaveBeenCalled();
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
    await registerMcpRoutesForTest(app);

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
    await registerMcpRoutesForTest(app);

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
    await registerMcpRoutesForTest(app);

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
