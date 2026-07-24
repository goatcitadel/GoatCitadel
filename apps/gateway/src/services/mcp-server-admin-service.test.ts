import { describe, expect, it, vi } from "vitest";
import type { McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import {
  completeMcpOAuth,
  connectMcpServer,
  createMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  resolveConnectedMcpTools,
  startMcpOAuth,
  updateMcpServer,
  updateMcpServerPolicy,
  type McpServerAdminHost,
} from "./mcp-server-admin-service.js";

describe("mcp-server-admin-service", () => {
  it("creates stdio server records with normalized policy and emits realtime", () => {
    const host = createHost();

    const created = createMcpServer(host, {
      label: "  Local filesystem  ",
      transport: "stdio",
      command: "  npx  ",
      args: ["  -y  ", "", " @modelcontextprotocol/server-filesystem "],
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "strict",
        allowedToolPatterns: [" fs.* ", " "],
        blockedToolPatterns: [" shell.exec "],
        notes: "  operator reviewed  ",
      },
    });

    expect(created).toMatchObject({
      label: "Local filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      authType: "none",
      enabled: true,
      category: "development",
      trustTier: "restricted",
      costTier: "unknown",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "strict",
        allowedToolPatterns: ["fs.*"],
        blockedToolPatterns: ["shell.exec"],
        notes: "operator reviewed",
      },
      status: "disconnected",
    });
    expect(host.servers[0]).toEqual(created);
    expect(host.writeMcpServers).toHaveBeenCalledWith([created]);
    expect(host.publishRealtime).toHaveBeenCalledWith("system", "mcp", {
      type: "mcp_server_created",
      serverId: created.serverId,
      transport: "stdio",
    });
  });

  it("rejects unsupported remote auth before mutating storage", () => {
    const host = createHost();

    expect(() =>
      createMcpServer(host, {
        label: "Remote OAuth",
        transport: "http",
        url: "https://remote.example/mcp",
        authType: "oauth2",
      }),
    ).toThrow("MCP transport http requires local stdio");
    expect(host.writeMcpServers).not.toHaveBeenCalled();
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects caller-created internal goatcitadel MCP server URLs before mutating storage", () => {
    const host = createHost({ servers: [createServer({ serverId: "server-1" })] });

    expect(() =>
      createMcpServer(host, {
        label: "Forged approval inbox",
        transport: "http",
        url: "goatcitadel://approval-inbox",
      }),
    ).toThrow("Internal goatcitadel:// MCP servers are Gateway-owned");
    expect(() =>
      updateMcpServer(host, "server-1", {
        url: "goatcitadel://durable-tasks",
      }),
    ).toThrow("Internal goatcitadel:// MCP servers are Gateway-owned");

    expect(host.servers).toEqual([expect.objectContaining({ serverId: "server-1" })]);
    expect(host.servers[0]).not.toHaveProperty("url");
    expect(host.writeMcpServers).not.toHaveBeenCalled();
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("creates supported remote server records with explicit token env policy", () => {
    const host = createHost();

    const created = createMcpServer(host, {
      label: "Remote SSE",
      transport: "sse",
      url: "https://remote.example/mcp",
      authType: "token",
      policy: {
        allowedEnvKeys: ["REMOTE_MCP_TOKEN", "invalid=value"],
      },
    });

    expect(created).toMatchObject({
      label: "Remote SSE",
      transport: "sse",
      url: "https://remote.example/mcp",
      authType: "token",
      policy: {
        allowedEnvKeys: ["REMOTE_MCP_TOKEN"],
      },
    });
    expect(host.writeMcpServers).toHaveBeenCalledWith([created]);
  });

  it("updates server fields and merges policy without replacing existing defaults", () => {
    const existing = createServer({
      serverId: "server-1",
      policy: {
        requireFirstToolApproval: false,
        redactionMode: "basic",
        allowedToolPatterns: ["docs.*"],
        blockedToolPatterns: [],
        notes: "existing",
      },
    });
    const host = createHost({ servers: [existing] });

    const updated = updateMcpServer(host, "server-1", {
      label: "  ",
      command: "  ",
      args: ["  inspect  ", ""],
      authType: "token",
      enabled: false,
      category: "research",
      trustTier: "trusted",
      costTier: "free",
      verifiedAt: "2026-05-14T10:00:00.000Z",
      policy: {
        requireFirstToolApproval: true,
        blockedToolPatterns: ["secret.*"],
      },
    });

    expect(updated).toMatchObject({
      serverId: "server-1",
      label: "MCP server",
      command: undefined,
      args: ["inspect"],
      authType: "token",
      enabled: false,
      category: "research",
      trustTier: "trusted",
      costTier: "free",
      verifiedAt: "2026-05-14T10:00:00.000Z",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic",
        allowedToolPatterns: ["docs.*"],
        blockedToolPatterns: ["secret.*"],
        notes: "existing",
      },
    });
    expect(host.servers).toEqual([updated]);

    const policyUpdated = updateMcpServerPolicy(host, "server-1", {
      redactionMode: "off",
      allowedToolPatterns: ["tools.search"],
    });
    expect(policyUpdated.policy).toMatchObject({
      requireFirstToolApproval: true,
      redactionMode: "off",
      allowedToolPatterns: ["tools.search"],
      blockedToolPatterns: ["secret.*"],
    });
    expect(() => updateMcpServer(host, "missing", { label: "Nope" })).toThrow("Unknown MCP server: missing");
  });

  it("connects servers, replaces their tools, and records connected status", async () => {
    const host = createHost({
      servers: [createServer({ serverId: "server-1" })],
      tools: [createTool("server-1", "old.tool"), createTool("server-other", "other.tool")],
      resolveConnectedMcpTools: vi.fn(async (_server, existing) => [createTool("server-1", `new.${existing.length}`)]),
    });

    const connected = await connectMcpServer(host, "server-1");

    expect(host.resolveConnectedMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "server-1", status: "connecting" }),
      [expect.objectContaining({ toolName: "old.tool" })],
    );
    expect(host.writeMcpTools).toHaveBeenCalledWith([
      expect.objectContaining({ serverId: "server-other", toolName: "other.tool" }),
      expect.objectContaining({ serverId: "server-1", toolName: "new.1" }),
    ]);
    expect(connected).toMatchObject({
      serverId: "server-1",
      status: "connected",
      lastError: undefined,
    });
    expect(connected.lastConnectedAt).toBeDefined();
    expect(host.patchMcpServerState).toHaveBeenNthCalledWith(1, "server-1", {
      status: "connecting",
      lastError: undefined,
    });
    expect(host.patchMcpServerState).toHaveBeenLastCalledWith(
      "server-1",
      expect.objectContaining({ status: "connected", lastError: undefined }),
    );

    expect(disconnectMcpServer(host, "server-1")).toMatchObject({
      serverId: "server-1",
      status: "disconnected",
    });
  });

  it("refuses to connect unsupported remote auth before mutating connection state", async () => {
    const remote = createServer({
      serverId: "remote-1",
      transport: "http",
      command: undefined,
      args: undefined,
      url: "https://remote.example.test/mcp",
      authType: "oauth2",
      status: "disconnected",
    });
    const host = createHost({ servers: [remote] });

    await expect(connectMcpServer(host, "remote-1")).rejects.toThrow("MCP transport http requires local stdio");

    expect(host.servers[0]).toEqual(remote);
    expect(host.patchMcpServerState).not.toHaveBeenCalled();
    expect(host.resolveConnectedMcpTools).not.toHaveBeenCalled();
    expect(host.writeMcpTools).not.toHaveBeenCalled();
  });

  it("refuses to connect a requester-scoped server and never mutates shared state (HX-415)", async () => {
    const scoped = createServer({
      serverId: "scoped-1",
      transport: "http",
      command: undefined,
      args: undefined,
      url: undefined,
      authType: "none",
      connectionMode: "requester_scoped",
      configurationRevision: 1,
      status: "disconnected",
    });
    const host = createHost({ servers: [scoped] });

    await expect(connectMcpServer(host, "scoped-1")).rejects.toThrow(/authenticated requester context/i);

    // No shared server status/tool/error state is written for a requester-scoped server.
    expect(host.patchMcpServerState).not.toHaveBeenCalled();
    expect(host.resolveConnectedMcpTools).not.toHaveBeenCalled();
    expect(host.writeMcpTools).not.toHaveBeenCalled();
  });

  it("never discovers or infers tools for a requester-scoped server (HX-415)", async () => {
    const scoped = createServer({
      serverId: "scoped-2",
      transport: "http",
      command: undefined,
      args: undefined,
      url: undefined,
      authType: "none",
      connectionMode: "requester_scoped",
      configurationRevision: 1,
    });

    const tools = await resolveConnectedMcpTools(
      { networkAllowlist: [], resolveOAuthAccessToken: async () => undefined },
      scoped,
      [createTool("scoped-2", "prior.tool")],
    );

    // No inferred/static tool fallback for a requester-scoped server.
    expect(tools).toEqual([]);
  });

  it("persists connection errors before rethrowing", async () => {
    const host = createHost({
      servers: [createServer({ serverId: "server-1" })],
      resolveConnectedMcpTools: vi.fn(async () => {
        throw new Error("handshake failed");
      }),
    });

    await expect(connectMcpServer(host, "server-1")).rejects.toThrow("handshake failed");

    expect(host.servers[0]).toMatchObject({
      serverId: "server-1",
      status: "error",
      lastError: "handshake failed",
    });
    expect(host.writeMcpTools).not.toHaveBeenCalled();
    expect(host.patchMcpServerState).toHaveBeenLastCalledWith("server-1", {
      status: "error",
      lastError: "handshake failed",
    });
  });

  it("stores OAuth handshake state and completes it through the connect path", async () => {
    const host = createHost({
      servers: [
        createServer({
          serverId: "server-1",
          authType: "oauth2",
          url: "https://mcp.example/events",
          oauth: {
            authorizationUrl: "https://mcp.example/oauth/authorize",
            tokenUrl: "https://mcp.example/oauth/token",
          },
        }),
      ],
      resolveConnectedMcpTools: vi.fn(async () => []),
      exchangeMcpOAuthCode: vi.fn(async (_server, code, authRow) => ({
        ...authRow,
        accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
        refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
        oauthState: undefined,
        updatedAt: "2026-06-02T00:00:00.000Z",
        lastCodePreview: code.slice(0, 8),
      })),
    });

    const started = startMcpOAuth(host, "server-1");

    expect(started.authorizeUrl).toContain("https://mcp.example/oauth/authorize");
    expect(started.authorizeUrl).toContain(`state=${encodeURIComponent(started.state)}`);
    expect(started.authorizeUrl).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fapi%2Fv1%2Fmcp%2Foauth%2Fcallback",
    );
    expect(host.authState["server-1"]).toMatchObject({
      oauthState: started.state,
    });
    expect(host.writeMcpAuthState).toHaveBeenCalledWith(host.authState);

    await expect(completeMcpOAuth(host, "server-1", "secret-code")).rejects.toThrow(
      "OAuth state is required to complete this handshake.",
    );
    await expect(completeMcpOAuth(host, "server-1", "secret-code", "wrong-state")).rejects.toThrow(
      "OAuth state mismatch.",
    );

    const connected = await completeMcpOAuth(host, "server-1", "secret-code", started.state);

    expect(connected.status).toBe("connected");
    expect(host.authState["server-1"]).toMatchObject({
      accessTokenRef: "keychain:goatcitadel:mcp:server-1:access-token",
      refreshTokenRef: "keychain:goatcitadel:mcp:server-1:refresh-token",
      oauthState: undefined,
      lastCodePreview: "secret-c",
    });
    await expect(completeMcpOAuth(host, "server-1", "secret-code", started.state)).rejects.toThrow(
      "No OAuth handshake in progress for this server.",
    );
    await expect(completeMcpOAuth(createHost(), "missing", "code")).rejects.toThrow(
      "No OAuth handshake in progress for this server.",
    );
  });

  it("deletes servers, tools, approval inbox entries, and emits realtime only when present", () => {
    const host = createHost({
      servers: [createServer({ serverId: "server-1" }), createServer({ serverId: "server-2" })],
      tools: [createTool("server-1", "server.one"), createTool("server-2", "server.two")],
    });

    expect(deleteMcpServer(host, "missing")).toEqual({ deleted: false });
    expect(host.writeMcpServers).not.toHaveBeenCalled();

    expect(deleteMcpServer(host, "server-1")).toEqual({ deleted: true });

    expect(host.servers.map((server) => server.serverId)).toEqual(["server-2"]);
    expect(host.tools.map((tool) => tool.toolName)).toEqual(["server.two"]);
    expect(host.storage.approvalInbox.deleteByReceiver).toHaveBeenCalledWith("mcp", "server-1");
    expect(host.publishRealtime).toHaveBeenCalledWith("system", "mcp", {
      type: "mcp_server_deleted",
      serverId: "server-1",
    });
  });
});

function createHost(input?: {
  servers?: McpServerRecord[];
  tools?: McpToolRecord[];
  authState?: Record<string, { oauthState?: string; updatedAt: string }>;
  resolveConnectedMcpTools?: McpServerAdminHost["resolveConnectedMcpTools"];
  exchangeMcpOAuthCode?: McpServerAdminHost["exchangeMcpOAuthCode"];
}): McpServerAdminHost & {
  servers: McpServerRecord[];
  tools: McpToolRecord[];
  authState: Record<string, { oauthState?: string; updatedAt: string }>;
  writeMcpServers: ReturnType<typeof vi.fn>;
  writeMcpTools: ReturnType<typeof vi.fn>;
  writeMcpAuthState: ReturnType<typeof vi.fn>;
  patchMcpServerState: ReturnType<typeof vi.fn>;
  requireMcpServer: ReturnType<typeof vi.fn>;
  resolveConnectedMcpTools: ReturnType<typeof vi.fn>;
  exchangeMcpOAuthCode: ReturnType<typeof vi.fn>;
  publishRealtime: ReturnType<typeof vi.fn>;
} {
  const host = {
    servers: input?.servers ? [...input.servers] : [],
    tools: input?.tools ? [...input.tools] : [],
    authState: input?.authState ? { ...input.authState } : {},
    storage: {
      approvalInbox: {
        deleteByReceiver: vi.fn(),
      },
    },
    readMcpServers: vi.fn(() => host.servers),
    writeMcpServers: vi.fn((servers: McpServerRecord[]) => {
      host.servers = [...servers];
    }),
    patchMcpServerState: vi.fn((serverId: string, patch: Partial<McpServerRecord>) => {
      let updated: McpServerRecord | undefined;
      host.servers = host.servers.map((server) => {
        if (server.serverId !== serverId) {
          return server;
        }
        updated = {
          ...server,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        return updated;
      });
      if (!updated) {
        throw new Error(`Unknown MCP server: ${serverId}`);
      }
      return updated;
    }),
    readMcpTools: vi.fn(() => host.tools),
    writeMcpTools: vi.fn((tools: McpToolRecord[]) => {
      host.tools = [...tools];
    }),
    resolveConnectedMcpTools: vi.fn(input?.resolveConnectedMcpTools ?? (async () => [])),
    requireMcpServer: vi.fn((serverId: string) => {
      const server = host.servers.find((item) => item.serverId === serverId);
      if (!server) {
        throw new Error(`Unknown MCP server: ${serverId}`);
      }
      return server;
    }),
    readMcpAuthState: vi.fn(() => host.authState),
    writeMcpAuthState: vi.fn((state: Record<string, { oauthState?: string; updatedAt: string }>) => {
      host.authState = state;
    }),
    exchangeMcpOAuthCode: vi.fn(input?.exchangeMcpOAuthCode),
    publishRealtime: vi.fn(),
  };
  return host;
}

function createServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "server-1",
    label: "MCP server",
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    authType: "none",
    enabled: true,
    status: "disconnected",
    category: "development",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function createTool(serverId: string, toolName: string): McpToolRecord {
  return {
    serverId,
    toolName,
    description: `${toolName} description`,
    inputSchema: { type: "object" },
    enabled: true,
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}
