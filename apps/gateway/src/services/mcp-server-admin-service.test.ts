import { describe, expect, it, vi } from "vitest";
import { ValidationError, type McpServerRecord, type McpToolRecord } from "@goatcitadel/contracts";
import { compensatePackMcpServer, packMcpConfigurationHash } from "./capability-pack-mcp-owner.js";
import {
  completeMcpOAuth,
  connectMcpServer,
  createMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  releaseMcpServerFromPlugin,
  resolveConnectedMcpTools,
  startMcpOAuth,
  updateMcpServer,
  updateMcpServerPolicy,
  type McpServerAdminHost,
} from "./mcp-server-admin-service.js";
import { mcpServerRevision } from "./mcp-server-revision.js";

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
    const created = await createMcpServer(
      host,
      {
        label: "Pack fixture",
        transport: "stdio",
        command: "node",
        args: ["fixture.js"],
        enabled: false,
      },
      `pack-${"1".repeat(40)}`,
      "plan-1",
    );
    const input = {
      planId: "plan-1",
      serverId: created.serverId,
      mode: "created" as const,
      configurationHash: packMcpConfigurationHash(created),
    };
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
    await compensatePackMcpServer(host, {
      planId: "enable-plan",
      serverId: original.serverId,
      mode: "enabled",
      configurationHash: packMcpConfigurationHash(original),
    });
    expect(host.servers).toHaveLength(1);
    expect(host.servers[0]).toMatchObject({
      enabled: false,
      command: original.command,
      packChange: { created: false },
    });
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

  // R50: the write owner records a change to what asks first, once the write has committed.
  describe("what asks first", () => {
    const AUDIT_EVENT = "mcp_server_approval_posture_changed";
    it("records a change once, after the commit callback and before the sessions close, with the saved value as from", async () => {
      const existing = createServer({
        connectionRevision: "a".repeat(64),
        policy: { ...createServer().policy, approvalPosture: "reads_free" },
      });
      const host = createHost({ servers: [existing] });
      replaceConnection(host);
      const order: string[] = [];
      host.captureMcpServerSessionCloser = () => () => {
        order.push("close sessions");
      };
      host.appendApprovalsAudit.mockImplementation(async () => {
        order.push("audit");
      });

      await updateMcpServerPolicy(
        host,
        "server-1",
        { approvalPosture: "everything_asks" },
        {
          expectedRevision: mcpServerRevision(existing),
          onCommitted: async () => {
            order.push("committed");
          },
          actorId: "token:ab12",
        },
      );

      expect(host.appendApprovalsAudit).toHaveBeenCalledExactlyOnceWith({
        event: AUDIT_EVENT,
        serverId: "server-1",
        from: "reads_free",
        to: "everything_asks",
        actorId: "token:ab12",
      });
      expect(order).toEqual(["committed", "audit", "close sessions"]);
    });

    it("records a first choice as from null, and a full edit that sets it the same way", async () => {
      const host = createHost({ servers: [createServer()] });

      await updateMcpServerPolicy(host, "server-1", { approvalPosture: "reads_free" }, undefined);
      await updateMcpServer(host, "server-1", { policy: { approvalPosture: "nothing_asks" } as never });

      expect(host.appendApprovalsAudit).toHaveBeenNthCalledWith(1, {
        event: AUDIT_EVENT,
        serverId: "server-1",
        from: null,
        to: "reads_free",
        actorId: "operator",
      });
      expect(host.appendApprovalsAudit).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ from: "reads_free", to: "nothing_asks" }),
      );
      expect(host.appendApprovalsAudit).toHaveBeenCalledTimes(2);
    });

    it("records nothing for the same value, another field, or an edit with no policy", async () => {
      const existing = createServer({ policy: { ...createServer().policy, approvalPosture: "reads_free" } });
      const host = createHost({ servers: [existing] });

      await updateMcpServerPolicy(host, "server-1", { approvalPosture: "reads_free" });
      await updateMcpServerPolicy(host, "server-1", { redactionMode: "off" });
      await updateMcpServer(host, "server-1", { enabled: false });

      expect(host.appendApprovalsAudit).not.toHaveBeenCalled();
    });

    it("records nothing when the write does not commit", async () => {
      const existing = createServer();
      const host = createHost({ servers: [existing] });
      const onCommitted = vi.fn();
      host.writeMcpServers.mockRejectedValueOnce(new Error("The MCP configuration changed."));

      await expect(
        updateMcpServerPolicy(
          host,
          "server-1",
          { approvalPosture: "reads_free" },
          { expectedRevision: mcpServerRevision(existing), onCommitted, actorId: "token:ab12" },
        ),
      ).rejects.toThrow("The MCP configuration changed.");
      await expect(
        updateMcpServerPolicy(
          host,
          "server-1",
          { approvalPosture: "reads_free" },
          { expectedRevision: "0".repeat(64), onCommitted },
        ),
      ).rejects.toThrow();

      expect(onCommitted).not.toHaveBeenCalled();
      expect(host.appendApprovalsAudit).not.toHaveBeenCalled();
    });

    it("reports a failed audit as a committed change, still reaching the commit callback first and closing the server's sessions", async () => {
      const existing = createServer({ connectionRevision: "a".repeat(64) });
      const host = createHost({ servers: [existing] });
      replaceConnection(host);
      const onCommitted = vi.fn();
      const closeSessions = vi.fn();
      host.captureMcpServerSessionCloser = () => closeSessions;
      host.appendApprovalsAudit.mockRejectedValueOnce(new Error("audit store is down"));

      await expect(
        updateMcpServerPolicy(
          host,
          "server-1",
          { approvalPosture: "reads_free" },
          { expectedRevision: mcpServerRevision(existing), onCommitted },
        ),
      ).rejects.toMatchObject({ message: "audit store is down", mutationCommitted: true });
      expect(onCommitted).toHaveBeenCalledTimes(1);
      // The edit replaced the connection, so sessions on the old one still close even though the audit write failed.
      expect(closeSessions).toHaveBeenCalledTimes(1);
    });

    it("reports a failed audit without closing sessions the edit left connected", async () => {
      const existing = createServer({ connectionRevision: "a".repeat(64) });
      const host = createHost({ servers: [existing] });
      keepConnection(host);
      const closeSessions = vi.fn();
      host.captureMcpServerSessionCloser = () => closeSessions;
      host.appendApprovalsAudit.mockRejectedValueOnce(new Error("audit store is down"));

      await expect(
        updateMcpServerPolicy(
          host,
          "server-1",
          { approvalPosture: "reads_free" },
          { expectedRevision: mcpServerRevision(existing) },
        ),
      ).rejects.toMatchObject({ message: "audit store is down", mutationCommitted: true });
      expect(closeSessions).not.toHaveBeenCalled();
    });
  });

  // R55: the live sessions belong to the connection, so they close only when the write replaced it.
  describe("live sessions of an edited server", () => {
    const connection = "a".repeat(64);
    const stage = (existing: McpServerRecord) => {
      const host = createHost({ servers: [existing] });
      const closeSessions = vi.fn();
      host.captureMcpServerSessionCloser = () => closeSessions;
      return { host, closeSessions };
    };
    it("stay open when the write kept the connection version, and the change is still audited", async () => {
      const existing = createServer({ status: "connected", connectionRevision: connection });
      const { host, closeSessions } = stage(existing);
      keepConnection(host);

      const saved = await updateMcpServerPolicy(
        host,
        "server-1",
        { approvalPosture: "reads_free" },
        { expectedRevision: mcpServerRevision(existing), actorId: "token:ab12" },
      );

      expect(saved.connectionRevision).toBe(connection);
      expect(closeSessions).not.toHaveBeenCalled();
      expect(host.appendApprovalsAudit).toHaveBeenCalledExactlyOnceWith({
        event: "mcp_server_approval_posture_changed",
        serverId: "server-1",
        from: null,
        to: "reads_free",
        actorId: "token:ab12",
      });
    });

    it("close once when the write replaced the connection version", async () => {
      const existing = createServer({ status: "connected", connectionRevision: connection });
      const { host, closeSessions } = stage(existing);
      replaceConnection(host);

      await updateMcpServer(host, "server-1", { args: ["other.mjs"] }, undefined, {
        expectedRevision: mcpServerRevision(existing),
      });

      expect(closeSessions).toHaveBeenCalledTimes(1);
    });

    it("close when the server never had a connection version and the write gave it one", async () => {
      const existing = createServer({ status: "connected" });
      const { host, closeSessions } = stage(existing);
      replaceConnection(host);

      await updateMcpServer(host, "server-1", { enabled: false });

      expect(closeSessions).toHaveBeenCalledTimes(1);
    });

    it("close when a connection field changes in the same edit as the setting", async () => {
      const existing = createServer({ status: "connected", connectionRevision: connection });
      const { host, closeSessions } = stage(existing);
      replaceConnection(host);

      await updateMcpServer(host, "server-1", {
        args: ["other.mjs"],
        policy: { approvalPosture: "reads_free" } as never,
      });

      expect(closeSessions).toHaveBeenCalledTimes(1);
    });
  });

  // The lock on money connectors is checked against the record as it would be saved.
  describe("a connector that can move money", () => {
    const REFUSAL = "This connector can move money, so changes can't be set to run on their own.";
    const PAYPAL_URL = "https://mcp.paypal.com/sse";
    const nothingAsks = { ...createServer().policy, approvalPosture: "nothing_asks" as const };

    it("can't be pointed at, or renamed to, a money vendor while it keeps Nothing asks", async () => {
      const docs = createServer({
        label: "Docs",
        transport: "http",
        command: undefined,
        args: undefined,
        url: "https://docs.example/mcp",
        policy: nothingAsks,
      });
      const host = createHost({ servers: [docs] });

      await expect(updateMcpServer(host, "server-1", { url: PAYPAL_URL })).rejects.toThrow(REFUSAL);
      await expect(updateMcpServer(host, "server-1", { label: "PayPal" })).rejects.toBeInstanceOf(ValidationError);
      await expect(updateMcpServer(host, "server-1", { label: "Team wallet", url: PAYPAL_URL })).rejects.toThrow(
        REFUSAL,
      );
      // The edit-by-policy route is the same function underneath.
      expect(host.writeMcpServers).not.toHaveBeenCalled();
      expect(host.servers).toEqual([docs]);
    });

    it("can still be pointed at a money vendor once the edit also stops asking for nothing, and ordinary edits still save", async () => {
      const docs = createServer({
        label: "Docs",
        transport: "http",
        command: undefined,
        args: undefined,
        url: "https://docs.example/mcp",
        policy: nothingAsks,
      });
      const host = createHost({ servers: [docs] });

      await expect(updateMcpServer(host, "server-1", { label: "Docs two" })).resolves.toMatchObject({
        label: "Docs two",
        policy: { approvalPosture: "nothing_asks" },
      });
      await expect(
        updateMcpServer(host, "server-1", { url: PAYPAL_URL, policy: { approvalPosture: "reads_free" } as never }),
      ).resolves.toMatchObject({ url: PAYPAL_URL, policy: { approvalPosture: "reads_free" } });
    });

    it("keeps unrelated edits possible when a record already holds Nothing asks (saved earlier, or re-marked since)", async () => {
      const wallet = createServer({
        label: "Team wallet",
        transport: "sse",
        command: undefined,
        args: undefined,
        url: PAYPAL_URL,
        policy: nothingAsks,
      });
      const host = createHost({ servers: [wallet] });

      await expect(updateMcpServer(host, "server-1", { enabled: false })).resolves.toMatchObject({ enabled: false });
      await expect(updateMcpServer(host, "server-1", { label: "Wallet" })).resolves.toMatchObject({ label: "Wallet" });
      // Asking for it again is still refused.
      await expect(
        updateMcpServer(host, "server-1", { policy: { approvalPosture: "nothing_asks" } as never }),
      ).rejects.toThrow(REFUSAL);
    });
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
    expect(host.patchMcpServerState).toHaveBeenNthCalledWith(
      1,
      "server-1",
      {
        status: "connecting",
        lastError: undefined,
      },
      expect.objectContaining({ serverId: "server-1" }),
    );
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
    expect(host.patchMcpServerState).toHaveBeenLastCalledWith(
      "server-1",
      {
        status: "error",
        lastError: "handshake failed",
      },
      expect.objectContaining({ serverId: "server-1", status: "connecting" }),
    );
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
    expect(host.writeMcpAuthState).toHaveBeenCalledWith({
      server: host.servers[0],
      expected: undefined,
      next: host.authState["server-1"],
    });

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
      const host = createHost({
        servers: [
          createServer({
            serverId: "server-1",
            authType: "oauth2",
            oauth: {
              authorizationUrl: "https://example.invalid/authorize",
              tokenUrl: "https://example.invalid/token",
              clientIdEnv: "MCP_ENVIRONMENT_CLIENT_ID",
            },
          }),
        ],
      });
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

  it.each(["auth-type", "token-url"])("rejects changed %s during OAuth environment preparation", async (drift) => {
    const server = createServer({
      authType: "oauth2",
      oauth: {
        authorizationUrl: "https://example.invalid/authorize",
        tokenUrl: "https://example.invalid/token",
      },
    });
    const host = createHost({ servers: [server] });
    host.prepareMcpStaticEnvironment = vi.fn(async () =>
      drift === "auth-type"
        ? { ...server, authType: "none" as const }
        : { ...server, oauth: { ...server.oauth, tokenUrl: undefined } },
    );
    host.resolveMcpOAuthClientId = vi.fn(async () => "unused-client");
    await expect(startMcpOAuth(host, server.serverId)).rejects.toThrow("configuration changed");
    expect(host.resolveMcpOAuthClientId).not.toHaveBeenCalled();
    expect(host.readMcpAuthState).not.toHaveBeenCalled();
    expect(host.writeMcpAuthState).not.toHaveBeenCalled();
  });

  it("refuses editing or removing a plugin's connector, and still switches it and signs it in", async () => {
    const pluginOwner = { pluginId: "meeting-tools", name: "Meeting tools", installPlanId: "plan-install-1" };
    const pass = { pluginId: pluginOwner.pluginId, installPlanId: pluginOwner.installPlanId };
    const refusal = {
      name: "PluginOwnedError",
      code: "PLUGIN_OWNED",
      httpStatus: 409,
      message: "From Meeting tools. Uninstall it to remove this.",
      details: { pluginId: "meeting-tools" },
    };
    // A plain create never marks a server; only the plugin service's trailing option does.
    const creating = createHost();
    const plain = await createMcpServer(creating, { label: "Plain", transport: "stdio", command: "node" });
    expect(plain.pluginOwner).toBeUndefined();
    const created = await createMcpServer(
      creating,
      { label: "Plugin tool", transport: "stdio", command: "node", enabled: false },
      undefined,
      undefined,
      undefined,
      pluginOwner,
    );
    expect(created).toMatchObject({ enabled: false, pluginOwner });
    expect(creating.servers.find((server) => server.serverId === created.serverId)?.pluginOwner).toEqual(pluginOwner);

    const serverId = "plugin-server";
    const host = createHost({
      servers: [
        createServer({ serverId: "plain-server" }),
        createServer({
          serverId,
          label: "Linear",
          authType: "oauth2",
          url: "https://mcp.example/events",
          oauth: { authorizationUrl: "https://mcp.example/authorize", tokenUrl: "https://mcp.example/token" },
          enabled: false,
          pluginOwner,
        }),
      ],
      resolveConnectedMcpTools: vi.fn(async () => []),
      exchangeMcpOAuthCode: vi.fn(async (_server, _code, authRow) => ({
        ...authRow,
        accessTokenRef: "keychain:goatcitadel:mcp:plugin-server:access-token",
        oauthState: undefined,
        updatedAt: "2026-10-31T00:00:00.000Z",
      })),
    });
    const saved = () => host.servers.find((server) => server.serverId === serverId)!;
    const writes = () => host.writeMcpServers.mock.calls.length;
    const before = writes();

    for (const attempt of [
      () => updateMcpServer(host, serverId, { label: "Renamed" }),
      () => updateMcpServer(host, serverId, { enabled: true, url: "https://mcp.example/other" }),
      () => updateMcpServer(host, serverId, { label: "Renamed" }, { planId: "pack-plan", phase: "apply" }),
      () => updateMcpServerPolicy(host, serverId, { approvalPosture: "everything_asks" }),
      () => updateMcpServer(host, serverId, { label: "Renamed" }, undefined, undefined, { ...pass, pluginId: "other" }),
      () =>
        updateMcpServer(host, serverId, { label: "Renamed" }, undefined, undefined, { ...pass, installPlanId: "x" }),
      () => deleteMcpServer(host, serverId),
      () => deleteMcpServer(host, serverId, { expectedRevision: mcpServerRevision(saved()) }),
    ]) {
      await expect(attempt()).rejects.toMatchObject(refusal);
    }
    expect(writes()).toBe(before);
    expect(saved()).toMatchObject({ label: "Linear", pluginOwner });

    // Switching it on and off is not an edit, with or without the reviewed revision the route sends along.
    const on = await updateMcpServer(host, serverId, { enabled: true });
    expect(on).toMatchObject({ enabled: true, pluginOwner });
    const reviewed = { enabled: false, expectedRevision: mcpServerRevision(on) };
    const off = await updateMcpServer(host, serverId, reviewed, undefined, {
      expectedRevision: reviewed.expectedRevision,
    });
    expect(off).toMatchObject({ enabled: false, pluginOwner });

    // Signing in, connecting and disconnecting stay allowed.
    const started = await startMcpOAuth(host, serverId);
    await completeMcpOAuth(host, serverId, "plugin-code", started.state);
    expect(host.exchangeMcpOAuthCode).toHaveBeenCalledTimes(1);
    await expect(disconnectMcpServer(host, serverId)).resolves.toMatchObject({ status: "disconnected" });
    await expect(connectMcpServer(host, serverId)).resolves.toMatchObject({ status: "connected" });

    // The plugin service's own pass edits and removes it.
    const edited = await updateMcpServerPolicy(host, serverId, { approvalPosture: "everything_asks" }, undefined, pass);
    expect(edited).toMatchObject({ policy: { approvalPosture: "everything_asks" }, pluginOwner });
    await expect(deleteMcpServer(host, serverId, undefined, pass)).resolves.toEqual({ deleted: true });
    expect(host.servers.map((server) => server.serverId)).toEqual(["plain-server"]);
    // Removing a server nobody added is unchanged.
    await expect(deleteMcpServer(host, "plain-server")).resolves.toEqual({ deleted: true });
  });

  it("hands a plugin's connector to the operator only with that plugin's own pass, changing nothing else", async () => {
    const pluginOwner = { pluginId: "meeting-tools", name: "Meeting tools", installPlanId: "plan-install-1" };
    const pass = { pluginId: pluginOwner.pluginId, installPlanId: pluginOwner.installPlanId };
    const serverId = "plugin-server";
    const host = createHost({
      servers: [createServer({ serverId, label: "Linear", enabled: true, pluginOwner })],
    });
    const saved = () => host.servers.find((server) => server.serverId === serverId)!;
    const before = saved();
    const writes = host.writeMcpServers.mock.calls.length;

    for (const wrongPass of [undefined, { ...pass, pluginId: "other" }, { ...pass, installPlanId: "x" }]) {
      await expect(releaseMcpServerFromPlugin(host, serverId, wrongPass as never)).rejects.toMatchObject({
        name: "PluginOwnedError",
        httpStatus: 409,
      });
    }
    expect(host.writeMcpServers.mock.calls.length).toBe(writes);
    expect(saved()).toEqual(before);

    const released = await releaseMcpServerFromPlugin(host, serverId, pass);

    expect(released.pluginOwner).toBeUndefined();
    const { pluginOwner: _mark, updatedAt: _updatedAt, ...unchanged } = before;
    expect(saved()).toMatchObject(unchanged);
    expect(saved()).not.toHaveProperty("pluginOwner");
    // Now the operator's own: a plain edit and a plain delete go through.
    await expect(updateMcpServer(host, serverId, { label: "Renamed" })).resolves.toMatchObject({ label: "Renamed" });
    await expect(deleteMcpServer(host, serverId)).resolves.toEqual({ deleted: true });
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
  appendApprovalsAudit: ReturnType<typeof vi.fn>;
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
    patchMcpServerState: vi.fn(
      async (serverId: string, patch: Partial<McpServerRecord>, _expected?: McpServerRecord) => {
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
      },
    ),
    readMcpTools: vi.fn(async () => host.tools),
    completeMcpServerConnection: vi.fn(async (server: McpServerRecord, tools: McpToolRecord[]) => {
      await host.writeMcpTools([...host.tools.filter((tool) => tool.serverId !== server.serverId), ...tools]);
      return host.patchMcpServerState(
        server.serverId,
        { status: "connected", lastConnectedAt: new Date().toISOString(), lastError: undefined },
        server,
      );
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
    exchangeMcpOAuthCode: vi.fn(
      async (...args: Parameters<NonNullable<McpServerAdminHost["exchangeMcpOAuthCode"]>>) => {
        const next = await input?.exchangeMcpOAuthCode?.(...args);
        if (!next) throw new Error("OAuth exchange fixture is unavailable.");
        host.authState[args[0].serverId] = next;
        return next;
      },
    ),
    publishRealtime: vi.fn(),
    appendApprovalsAudit: vi.fn(async () => undefined),
  };
  return host;
}

/**
 * The fake host doesn't make the store's decision, so a test says which connection the next write left behind:
 * the saved one (keepConnection) or a new one, as when the store disconnected the server (replaceConnection).
 */
function keepConnection(host: ReturnType<typeof createHost>): void {
  host.writeMcpServers.mockImplementationOnce(async (servers: McpServerRecord[]) => {
    host.servers = [...servers];
    return host.servers;
  });
}

function replaceConnection(host: ReturnType<typeof createHost>): void {
  host.writeMcpServers.mockImplementationOnce(async (servers: McpServerRecord[]) => {
    host.servers = servers.map((server) => ({ ...server, connectionRevision: "d".repeat(64) }));
    return host.servers;
  });
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
