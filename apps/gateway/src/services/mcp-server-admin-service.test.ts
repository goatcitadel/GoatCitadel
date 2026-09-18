import { describe, expect, it, vi } from "vitest";
import type { McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { compensatePackMcpServer, packMcpConfigurationHash } from "./capability-pack-mcp-owner.js";
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

const EMPTY_TOOLS_MCP_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "empty-tools", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") reply(message.id, { tools: [] });
});
`;

describe("mcp-server-admin-service", () => {
  it("binds compensation to the creating plan and current pack revision", async () => {
    const host = createHost();
    const created = await createMcpServer(host, {
      label: "Pack fixture", transport: "stdio", command: "node", args: ["fixture.js"], enabled: false,
    }, `pack-${"1".repeat(40)}`, "plan-1");
    const input = { planId: "plan-1", serverId: created.serverId, mode: "created" as const,
      configurationHash: packMcpConfigurationHash(created) };
    await expect(compensatePackMcpServer(host, { ...input, planId: "foreign" })).rejects.toThrow("preserved");
    await updateMcpServer(host, created.serverId, { enabled: true }, { planId: "plan-1", phase: "apply" });
    expect(host.servers[0]!.packChange).toMatchObject({ revision: 2, created: true });
    await compensatePackMcpServer(host, input);
    expect(host.servers[0]).toMatchObject({ enabled: false, packChange: { revision: 3, phase: "compensate" } });
    const writes = host.writeMcpServers.mock.calls.length;
    await compensatePackMcpServer(host, input);
    expect(host.writeMcpServers).toHaveBeenCalledTimes(writes);
    await updateMcpServer(host, created.serverId, { enabled: true });
    expect(host.servers[0]!.packChange).toBeUndefined();
    await expect(compensatePackMcpServer(host, input)).rejects.toThrow("preserved");
    expect(host.servers[0]!.enabled).toBe(true);
  });
  it("can reverse its enable action on an existing server while retaining the registration", async () => {
    const host = createHost({ servers: [createServer({ enabled: false })] });
    const original = host.servers[0]!;
    await updateMcpServer(host, original.serverId, { enabled: true }, { planId: "enable-plan", phase: "apply" });
    await compensatePackMcpServer(host, { planId: "enable-plan", serverId: original.serverId,
      mode: "enabled", configurationHash: packMcpConfigurationHash(original) });
    expect(host.servers).toHaveLength(1);
    expect(host.servers[0]).toMatchObject({ enabled: false, command: original.command, packChange: { created: false } });
  });
  it("creates stdio server records with normalized policy and emits realtime", async () => {
    const host = createHost();

    const created = await createMcpServer(host, {
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
    expect(host.writeMcpServers).toHaveBeenCalledWith([created], []);
    expect(host.publishRealtime).toHaveBeenCalledWith("system", "mcp", {
      type: "mcp_server_created",
      serverId: created.serverId,
      transport: "stdio",
    });
  });

  it("rejects unsupported remote auth before mutating storage", async () => {
    const host = createHost();

    await expect(
      createMcpServer(host, {
        label: "Remote OAuth",
        transport: "http",
        url: "https://remote.example/mcp",
        authType: "oauth2",
      }),
    ).rejects.toThrow("MCP transport http requires local stdio");
    expect(host.writeMcpServers).not.toHaveBeenCalled();
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects caller-created internal goatcitadel MCP server URLs before mutating storage", async () => {
    const host = createHost({ servers: [createServer({ serverId: "server-1" })] });

    await expect(
      createMcpServer(host, {
        label: "Forged approval inbox",
        transport: "http",
        url: "goatcitadel://approval-inbox",
      }),
    ).rejects.toThrow("Internal goatcitadel:// MCP servers are Gateway-owned");
    await expect(
      updateMcpServer(host, "server-1", {
        url: "goatcitadel://durable-tasks",
      }),
    ).rejects.toThrow("Internal goatcitadel:// MCP servers are Gateway-owned");

    expect(host.servers).toEqual([expect.objectContaining({ serverId: "server-1" })]);
    expect(host.servers[0]).not.toHaveProperty("url");
    expect(host.writeMcpServers).not.toHaveBeenCalled();
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("creates supported remote server records with explicit token env policy", async () => {
    const host = createHost();

    const created = await createMcpServer(host, {
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
    expect(host.writeMcpServers).toHaveBeenCalledWith([created], []);
  });

  it("updates server fields and merges policy without replacing existing defaults", async () => {
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

    const updated = await updateMcpServer(host, "server-1", {
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

    const policyUpdated = await updateMcpServerPolicy(host, "server-1", {
      redactionMode: "off",
      allowedToolPatterns: ["tools.search"],
    });
    expect(policyUpdated.policy).toMatchObject({
      requireFirstToolApproval: true,
      redactionMode: "off",
      allowedToolPatterns: ["tools.search"],
      blockedToolPatterns: ["secret.*"],
    });
    await expect(updateMcpServer(host, "missing", { label: "Nope" })).rejects.toThrow("Unknown MCP server: missing");
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
    }, expect.objectContaining({ serverId: "server-1" }));
    expect(host.patchMcpServerState).toHaveBeenLastCalledWith(
      "server-1",
      expect.objectContaining({ status: "connected", lastError: undefined }),
      expect.objectContaining({ serverId: "server-1", status: "connecting" }),
    );

    await expect(disconnectMcpServer(host, "server-1")).resolves.toMatchObject({
      serverId: "server-1",
      status: "disconnected",
    });
  });

  it("clears only the target server cache when live discovery returns an empty catalog", async () => {
    const host = createHost({
      servers: [createServer({ serverId: "server-1" })],
      tools: [createTool("server-1", "stale.tool"), createTool("server-other", "other.tool")],
      resolveConnectedMcpTools: vi.fn(async () => []),
    });

    const connected = await connectMcpServer(host, "server-1");

    expect(connected.status).toBe("connected");
    expect(host.writeMcpTools).toHaveBeenCalledWith([
      expect.objectContaining({ serverId: "server-other", toolName: "other.tool" }),
    ]);
    expect(host.tools).toEqual([expect.objectContaining({ serverId: "server-other", toolName: "other.tool" })]);
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

  it("keeps an authoritative empty stdio catalog empty even when CLI context names a browser", async () => {
    const server = createServer({
      label: "Generic local adapter",
      command: process.execPath,
      args: ["-e", EMPTY_TOOLS_MCP_SCRIPT, "--", "--agent-id", "verification-usability-browser"],
      category: "other",
    });

    const tools = await resolveConnectedMcpTools(
      { networkAllowlist: [], resolveOAuthAccessToken: async () => undefined },
      server,
      [createTool(server.serverId, "stale.tool")],
    );

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
    }, expect.objectContaining({ serverId: "server-1", status: "connecting" }));
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

    const started = await startMcpOAuth(host, "server-1");

    expect(started.authorizeUrl).toContain("https://mcp.example/oauth/authorize");
    expect(started.authorizeUrl).toContain(`state=${encodeURIComponent(started.state)}`);
    expect(started.authorizeUrl).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fapi%2Fv1%2Fmcp%2Foauth%2Fcallback",
    );
    expect(host.authState["server-1"]).toMatchObject({
      oauthState: started.state,
    });
    expect(host.writeMcpAuthState).toHaveBeenCalledWith({ server: host.servers[0], expected: undefined, next: host.authState["server-1"] });

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

  it("leaves shared connection state untouched when environment enrollment fails", async () => {
    const host = createHost({ servers: [createServer({ serverId: "server-1" })] });
    host.prepareMcpStaticEnvironment = vi.fn(async () => {
      throw new Error("environment enrollment failed");
    });
    await expect(connectMcpServer(host, "server-1")).rejects.toThrow("environment enrollment failed");
    expect(host.patchMcpServerState).not.toHaveBeenCalled();
    expect(host.resolveConnectedMcpTools).not.toHaveBeenCalled();
    expect(host.writeMcpTools).not.toHaveBeenCalled();
  });

  it("binds OAuth setup to the enrolled configuration without falling back to ambient client values", async () => {
    vi.stubEnv("MCP_ENVIRONMENT_CLIENT_ID", "ambient-client-must-not-be-used");
    try {
      const host = createHost({ servers: [createServer({
        serverId: "server-1",
        authType: "oauth2",
        oauth: {
          authorizationUrl: "https://example.invalid/authorize",
          tokenUrl: "https://example.invalid/token",
          clientIdEnv: "MCP_ENVIRONMENT_CLIENT_ID",
        },
      })] });
      const prepared = { ...host.servers[0]!, configurationBindingId: "00000000-0000-4000-8000-000000000001" };
      host.prepareMcpStaticEnvironment = vi.fn(async () => {
        host.servers = [prepared];
        return prepared;
      });
      host.resolveMcpOAuthClientId = vi.fn(async () => undefined);
      const started = await startMcpOAuth(host, "server-1");
      expect(new URL(started.authorizeUrl).searchParams.has("client_id")).toBe(false);
      expect(host.resolveMcpOAuthClientId).toHaveBeenCalledWith(prepared);
      expect(host.writeMcpAuthState).toHaveBeenCalledWith(expect.objectContaining({ server: prepared }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["auth-type", "token-url"])("rejects changed %s during OAuth environment preparation", async drift => {
    const server = createServer({ authType: "oauth2", oauth: {
      authorizationUrl: "https://example.invalid/authorize", tokenUrl: "https://example.invalid/token",
    } });
    const host = createHost({ servers: [server] });
    host.prepareMcpStaticEnvironment = vi.fn(async () => drift === "auth-type"
      ? { ...server, authType: "none" as const }
      : { ...server, oauth: { ...server.oauth, tokenUrl: undefined } });
    host.resolveMcpOAuthClientId = vi.fn(async () => "unused-client");
    await expect(startMcpOAuth(host, server.serverId)).rejects.toThrow("configuration changed");
    expect(host.resolveMcpOAuthClientId).not.toHaveBeenCalled();
    expect(host.readMcpAuthState).not.toHaveBeenCalled();
    expect(host.writeMcpAuthState).not.toHaveBeenCalled();
  });

  it("deletes servers, tools, approval inbox entries, and emits realtime only when present", async () => {
    const host = createHost({
      servers: [createServer({ serverId: "server-1" }), createServer({ serverId: "server-2" })],
      tools: [createTool("server-1", "server.one"), createTool("server-2", "server.two")],
    });

    await expect(deleteMcpServer(host, "missing")).resolves.toEqual({ deleted: false });
    expect(host.writeMcpServers).not.toHaveBeenCalled();

    await expect(deleteMcpServer(host, "server-1")).resolves.toEqual({ deleted: true });

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
        deleteByReceiver: vi.fn(async () => 0),
      },
    },
    readMcpServers: vi.fn(async () => host.servers),
    writeMcpServers: vi.fn(async (servers: McpServerRecord[]) => {
      const removed = host.servers.filter((server) => !servers.some((next) => next.serverId === server.serverId));
      for (const server of removed) delete host.authState[server.serverId];
      for (const server of removed) await host.storage.approvalInbox.deleteByReceiver("mcp", server.serverId);
      host.tools = host.tools.filter((tool) => !removed.some((server) => server.serverId === tool.serverId));
      host.servers = [...servers];
      return host.servers;
    }),
    patchMcpServerState: vi.fn(async (serverId: string, patch: Partial<McpServerRecord>, _expected?: McpServerRecord) => {
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
    readMcpTools: vi.fn(async () => host.tools),
    completeMcpServerConnection: vi.fn(async (server: McpServerRecord, tools: McpToolRecord[]) => {
      await host.writeMcpTools([...host.tools.filter(tool => tool.serverId !== server.serverId), ...tools]);
      return host.patchMcpServerState(server.serverId, { status: "connected", lastConnectedAt: new Date().toISOString(), lastError: undefined }, server);
    }),
    writeMcpTools: vi.fn(async (tools: McpToolRecord[]) => {
      host.tools = [...tools];
    }),
    resolveConnectedMcpTools: vi.fn(input?.resolveConnectedMcpTools ?? (async () => [])),
    requireMcpServer: vi.fn(async (serverId: string) => {
      const server = host.servers.find((item) => item.serverId === serverId);
      if (!server) {
        throw new Error(`Unknown MCP server: ${serverId}`);
      }
      return server;
    }),
    readMcpAuthState: vi.fn(async () => host.authState),
    writeMcpAuthState: vi.fn(async (update: Parameters<McpServerAdminHost["writeMcpAuthState"]>[0]) => {
      if (update.next) host.authState[update.server.serverId] = update.next;
      else delete host.authState[update.server.serverId];
    }),
    exchangeMcpOAuthCode: vi.fn(async (...args: Parameters<NonNullable<McpServerAdminHost["exchangeMcpOAuthCode"]>>) => {
      const next = await input?.exchangeMcpOAuthCode?.(...args);
      if (!next) throw new Error("OAuth exchange fixture is unavailable.");
      host.authState[args[0].serverId] = next;
      return next;
    }),
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
