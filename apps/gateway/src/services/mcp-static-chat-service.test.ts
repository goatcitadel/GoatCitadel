import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CapabilityCatalogEntry, McpServerRecord } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { McpServerStore } from "./mcp-server-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { McpStaticEnvironmentService } from "./mcp-static-environment-service.js";
import { McpStaticChatService, type McpStaticChatServiceOptions } from "./mcp-static-chat-service.js";
import { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";
import type { StdioClient } from "./mcp-runtime.js";
import {
  resolveChatTurnCapabilityProfile,
  type ChatTurnCapabilityProfileResolveInput,
} from "./chat-turn-capability-profile-service.js";
import { buildMcpRequesterScopedTurnContextFromCapabilityProfile } from "./mcp-requester-resolution-service.js";
import { resolveNativeMcpChatToolBinding } from "./gateway/native-mcp-chat-binding.js";
import { assertChatCapabilityBindingsCurrent } from "./chat-capability-current-binding.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("freezes real discovery into an immutable Chat profile and executes the exact dotted native target", async () => {
  const f = await fixture();
  const profile = await f.freeze();
  const tool = profile.selection.tools[0]!;
  expect(tool.mcpStaticBinding).toMatchObject({
    serverId: "static.with.dots",
    nativeToolName: "echo.value",
    mode: "static",
  });
  expect(tool.mcpRequesterResolution).toBeUndefined();
  expect(tool.modelName).toMatch(/^mcp_s_[a-f0-9]{56}$/u);
  expect(JSON.stringify(profile)).not.toContain(f.env.MCP_STATIC_TOKEN);
  expect(JSON.stringify(profile)).not.toContain(f.url);
  const handle = buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile)!;
  const binding = await resolveNativeMcpChatToolBinding(
    f.storage,
    {
      agentId: "assistant",
      toolName: tool.canonicalName,
      sessionId: profile.identity.sessionId,
      workspaceId: profile.identity.workspaceId,
      turnId: profile.identity.turnId,
      policyContext: { authActorId: "actor", authActorSource: "token" },
    },
    handle,
  );
  expect(binding?.staticBinding).toEqual(tool.mcpStaticBinding);
  await assertChatCapabilityBindingsCurrent(profile, f.storage, f.live, (current, name) =>
    f.service.revalidateTool(current, name),
  );
  const args = { value: "test value", serverId: "caller-controlled", toolName: "caller-controlled" };
  const mark = vi.fn(async () => {
    f.methods.push("effect-boundary");
  });
  const result = await f.invoke(profile, args, mark);
  expect(result.ok, result.error).toBe(true);
  expect(mark).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual([{ name: "echo.value", arguments: args }]);
  expect(f.methods.slice(-3)).toEqual(["tools/list", "effect-boundary", "tools/call"]);
  expect(JSON.stringify(result)).not.toContain(f.env.MCP_STATIC_TOKEN);
  expect(JSON.stringify(result)).toContain("[REDACTED]");
  expect(result.error).toBeUndefined();
  expect(result.contentItems).toEqual([{ type: "text", text: "fixture output [REDACTED]" }]);
  expect(f.listContexts).toEqual([
    { workspaceId: "default", sessionId: "session" },
    { workspaceId: "default", sessionId: "session" },
  ]);
});

it("rebuilds invocation authority from the durable profile after the owner restarts", async () => {
  const f = await fixture();
  const profile = await f.freeze();
  f.service = new McpStaticChatService(f.options);
  const result = await f.invoke(profile);
  expect(result.ok, result.error).toBe(true);
  expect(f.calls).toHaveLength(1);
});

it.each(["schema", "credential", "revocation", "scope", "configuration", "shared capability", "disconnected"] as const)(
  "rejects changed %s without reaching tools/call or its effect boundary",
  async (change) => {
    const f = await fixture();
    const profile = await f.freeze();
    if (change === "schema") f.tool.inputSchema.properties.value.type = "number";
    if (change === "credential") f.env.MCP_STATIC_TOKEN = "changed-fixture-token";
    if (change === "revocation") f.revoked = true;
    if (change === "scope") f.allowed = false;
    if (change === "shared capability") f.live = [];
    if (change === "disconnected") await f.store.patchServerState("static.with.dots", { status: "disconnected" });
    if (change === "configuration") {
      const servers = await f.store.readServers();
      await f.store.writeServers(
        servers.map((server) =>
          server.serverId === "static.with.dots"
            ? { ...server, policy: { ...server.policy, blockedToolPatterns: ["echo.*"] } }
            : server,
        ),
        servers,
      );
    }
    const mark = vi.fn(async () => {});
    const result = await f.invoke(profile, {}, mark);
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.externalOutcome).toBeUndefined();
    expect(mark).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  },
);

it("rechecks credentials after tools/list and rejects a forged context before transport", async () => {
  const f = await fixture();
  const profile = await f.freeze();
  const mark = vi.fn(async () => {});
  const handle = buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile)!;
  const before = f.methods.length;
  const forged = await f.service.invoke(
    {
      server: await f.store.requireServer("static.with.dots"),
      toolName: "echo.value",
      mcpRequesterTurnContext: { ...handle },
    },
    { effectDispatch: mark },
  );
  expect(forged.failurePhase).toBe("pre_dispatch");
  expect(f.methods).toHaveLength(before);
  f.onList = () => {
    f.env.MCP_STATIC_TOKEN = "changed-during-list-fixture";
  };
  const result = await f.invoke(profile, {}, mark);
  expect(result.failurePhase).toBe("pre_dispatch");
  expect(mark).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

it.each(["credential", "revocation"] as const)("rechecks %s after the asynchronous effect marker", async (change) => {
  const f = await fixture();
  const profile = await f.freeze();
  const mark = vi.fn(async () => {
    if (change === "credential") f.env.MCP_STATIC_TOKEN = "changed-during-effect-marker";
    else f.revoked = true;
  });
  const result = await f.invoke(profile, {}, mark);
  expect(mark).toHaveBeenCalledOnce();
  expect(f.calls).toEqual([]);
  expect(result).toMatchObject({
    ok: false,
    failurePhase: "post_dispatch",
    externalOutcome: "unknown_after_send",
    manualReconciliationRequired: true,
  });
});

it("retains a lost tool response as unknown without automatic redispatch", async () => {
  const f = await fixture();
  const profile = await f.freeze();
  f.dropToolReply = true;
  const mark = vi.fn(async () => {});
  const result = await f.invoke(profile, {}, mark);
  expect(mark).toHaveBeenCalledOnce();
  expect(f.calls).toHaveLength(1);
  expect(result).toMatchObject({
    ok: false,
    failurePhase: "post_dispatch",
    externalOutcome: "unknown_after_send",
    manualReconciliationRequired: true,
  });
  expect(result.retryCount).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(f.env.MCP_STATIC_TOKEN);
});

it.each(["credential", "duplicate"] as const)("withholds a catalog containing %s output", async (defect) => {
  const f = await fixture();
  if (defect === "credential") f.tool.description = `Echo ${f.env.MCP_STATIC_TOKEN}`;
  else f.duplicate = true;
  const profile = await f.freeze();
  expect(profile.selection.tools).toEqual([]);
  expect(f.options.onDiscoveryUnavailable).toHaveBeenCalledExactlyOnceWith("static.with.dots", expect.any(String));
  expect(JSON.stringify(profile)).not.toContain(f.env.MCP_STATIC_TOKEN);
});

it("skips metadata discovery for a manual turn", async () => {
  const f = await fixture();
  const profile = await f.freeze({ toolAutonomy: "manual" });
  expect(profile.selection.tools).toEqual([]);
  expect(f.methods).toEqual([]);
});

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "gc-static-mcp-chat-"));
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: path.join(directory, "gateway.sqlite"),
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
  const store = new McpServerStore({
    systemSettings: storage.systemSettings,
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
  });
  const secrets = new Map<string, string>();
  const env = { MCP_STATIC_TOKEN: "private-static-mcp-fixture-token" };
  const environment = new McpStaticEnvironmentService({
    registry: store,
    env,
    secretStore: {
      isWriteCustodySafe: () => true,
      getSecret: (account) => secrets.get(account),
      setSecret: (account, value) => {
        secrets.set(account, value);
      },
      deleteSecret: (account) => {
        secrets.delete(account);
      },
    },
  });
  const pool = new McpStdioSessionPool<StdioClient>();
  const tool = {
    name: "echo.value",
    description: "Echo a fixture value.",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  };
  const shared: CapabilityCatalogEntry = {
    capabilityId: "tool:mcp.invoke",
    kind: "tool",
    category: "built_in",
    title: "MCP",
    summary: "Governed MCP tools.",
    callable: true,
    toolName: "mcp.invoke",
  };
  const f = {
    storage,
    store,
    env,
    tool,
    methods: [] as string[],
    calls: [] as unknown[],
    listContexts: [] as unknown[],
    revoked: false,
    allowed: true,
    duplicate: false,
    dropToolReply: false,
    onList: () => {},
    live: [shared],
    service: undefined as unknown as McpStaticChatService,
    options: undefined as unknown as McpStaticChatServiceOptions,
    url: "",
    freeze: async (patch: Partial<ChatTurnCapabilityProfileResolveInput> = {}) => {
      const result = await resolveChatTurnCapabilityProfile(
        {
          storage,
          listCapabilityCatalog: async () => f.live,
          resolveToolPolicyContext: async () => ({
            authActorId: "actor",
            authActorSource: "token",
            permissionProfileId: "safe",
          }),
          getProviderReadiness: () => ({ configured: true, local: true }),
          discoverStaticMcpCatalogs: (hook) => f.service.discover(hook),
          assertStaticMcpCatalogCurrent: (snapshot, hook) => f.service.assertCatalogCurrent(snapshot, hook),
          resolveToolSchema: async (_input, native = []) => ({
            tools: native.map((entry) => entry.providerDefinition),
            modelToCanonical: new Map(native.map((entry) => [entry.modelName, entry.canonicalName])),
            canonicalToModel: new Map(native.map((entry) => [entry.canonicalName, entry.modelName])),
            policyDecisions: native.map((entry) => ({
              toolName: entry.canonicalName,
              allowed: true,
              requiresApproval: true,
              reasonCodes: [],
            })),
          }),
        },
        {
          sessionId: "session",
          turnId: "turn",
          workspaceId: "default",
          citadelId: "citadel",
          route: { channel: "chat", account: "default", peer: "fixture" },
          content: "Use the echo tool.",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          retrievalMode: "standard",
          thinkingLevel: "standard",
          speedMode: "standard",
          subagentPolicy: "off",
          toolAutonomy: "safe_auto",
          historyMessages: [],
          routeResolution: {
            effectiveProviderId: "fixture",
            effectiveModel: "fixture",
            fallbackPolicy: "off",
            runtimeClass: "local",
          },
          authActorId: "actor",
          authActorSource: "token",
          ...patch,
        },
      );
      await storage.capabilityCatalogSnapshots.create(result.catalogSnapshot);
      const profile = result.profile;
      const expectedTools =
        f.duplicate || f.tool.description.includes(env.MCP_STATIC_TOKEN) || patch.toolAutonomy === "manual" ? 0 : 1;
      expect(
        profile.selection.tools,
        JSON.stringify(vi.mocked(f.options.onDiscoveryUnavailable!).mock.calls),
      ).toHaveLength(expectedTools);
      await storage.chatSessionLifecycles.initialize({
        workspaceId: profile.identity.workspaceId,
        sessionId: profile.identity.sessionId,
        actorId: "actor",
        idempotencyKey: "fixture-initialize",
        correlationId: "fixture-initialize",
      });
      const { admission } = await storage.sessionMutationAdmissions.admit({
        workspaceId: profile.identity.workspaceId,
        sessionId: profile.identity.sessionId,
        turnId: profile.identity.turnId,
        runtimeOwnerId: "fixture-runtime",
        admissionKind: "turn_write",
        aggregateRevision: 1,
        controllerGeneration: 1,
        actorKind: "operator",
        actorId: "actor",
        operation: "chat.turn.execute",
        materialSha256: profile.hashes.profileHash,
        idempotencyKey: "fixture-admission",
        correlationId: "fixture-admission",
      });
      return storage.runImmediateTransaction(async () => {
        await storage.sessionMutationAdmissions.bindCapabilityProfile({
          admissionId: admission.admissionId,
          workspaceId: admission.workspaceId,
          sessionId: admission.sessionId,
          sessionIncarnationId: admission.sessionIncarnationId,
          turnId: admission.turnId!,
          profileId: profile.profileId,
          profileHash: profile.hashes.profileHash,
          createdAt: profile.createdAt,
          requestRuntimeClaim: {
            runtimeOwnerId: admission.runtimeOwnerId!,
            leaseRevision: admission.runtimeLeaseRevision!,
          },
        });
        return storage.chatTurnCapabilityProfiles.create(profile);
      });
    },
    invoke: async (
      profile: Awaited<ReturnType<typeof storage.chatTurnCapabilityProfiles.get>>,
      args: Record<string, unknown> = {},
      mark = async () => {},
    ) =>
      f.service.invoke(
        {
          server: await store.requireServer("static.with.dots"),
          toolName: "echo.value",
          arguments: args,
          mcpRequesterTurnContext: buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile),
        },
        { effectDispatch: mark },
      ),
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
        params?: { context?: unknown };
      };
      f.methods.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        f.listContexts.push(message.params?.context);
        f.onList();
      }
      if (message.method === "tools/call") {
        f.calls.push(message.params);
        if (f.dropToolReply) {
          response.destroy();
          return;
        }
      }
      const result =
        message.method === "tools/list"
          ? { tools: f.duplicate ? [tool, tool] : [tool] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: `fixture output ${env.MCP_STATIC_TOKEN}` }] }
            : {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  cleanups.push(async () => {
    pool.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await storage.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind loopback.");
  f.url = `http://127.0.0.1:${address.port}/mcp`;
  const record: McpServerRecord = {
    serverId: "static.with.dots",
    label: "Static MCP fixture",
    transport: "http",
    url: f.url,
    authType: "token",
    enabled: true,
    status: "connected",
    category: "development",
    trustTier: "restricted",
    costTier: "free",
    policy: normalizeMcpPolicy({ allowedEnvKeys: ["MCP_STATIC_TOKEN"] }),
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  await store.writeServers([record], []);
  await environment.enroll(await store.requireServer(record.serverId));
  f.options = {
    registry: store,
    environment,
    storage,
    assertMcpServerInScope: async () => {
      if (!f.allowed) throw new Error("Scope revoked.");
    },
    readAuthConnectionState: async () => ({ revoked: f.revoked }),
    listCallableCapabilities: async () => f.live,
    resolveOAuthAccessToken: async () => undefined,
    getNetworkAllowlist: () => [new URL(f.url).host],
    packageRoot: path.join(directory, "reviewed-packages"),
    stdioPool: pool,
    onDiscoveryUnavailable: vi.fn(),
  };
  f.service = new McpStaticChatService(f.options);
  return f;
}
