import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

function createGatewayHarness(overrides: Record<string, unknown> = {}) {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  Object.assign(gateway, overrides);
  return gateway;
}

function createValidation(sourceRef = "local:skill") {
  return {
    valid: true,
    riskLevel: "medium",
    inferredSkillName: "Filesystem Reviewer",
    candidate: {
      sourceProvider: "local",
      sourceRef,
      sourceType: "directory",
    },
  };
}

describe("GatewayService loop44 facade behavior", () => {
  it("delegates skill source reads and emits validation/install lifecycle events", async () => {
    const validation = createValidation("local:skill");
    const gateway = createGatewayHarness({
      config: {
        rootDir: "F:/repo",
      },
      skillImportService: {
        listSources: vi.fn(async (query: string, limit: number) => ({ query, limit, sources: ["local"] })),
        lookupSources: vi.fn(async (queryOrUrl: string, limit: number) => ({ queryOrUrl, limit, matches: ["match"] })),
        listHistory: vi.fn((limit: number) => [{ limit, sourceRef: "local:skill" }]),
        validateImport: vi.fn(async () => validation),
        installImport: vi.fn(async () => ({
          validation,
          installedPath: "F:/repo/skills/extra/fs-reviewer",
          sourceManifestPath: "F:/repo/skills/extra/fs-reviewer/goat-skill.json",
        })),
      },
      recordSkillImportEvent: vi.fn(),
      publishRealtime: vi.fn(),
      reloadSkills: vi.fn(async () => [
        {
          skillId: "skill-fs-reviewer",
          source: "extra",
          dir: "F:/repo/skills/extra/fs-reviewer",
        },
      ]),
      setSkillState: vi.fn(),
    });

    await expect(GatewayService.prototype.listSkillSources.call(gateway, "fs", 3)).resolves.toEqual({
      query: "fs",
      limit: 3,
      sources: ["local"],
    });
    await expect(
      GatewayService.prototype.lookupSkillSources.call(gateway, "https://example.test/skill", 4),
    ).resolves.toEqual({
      queryOrUrl: "https://example.test/skill",
      limit: 4,
      matches: ["match"],
    });
    expect(GatewayService.prototype.listSkillImportHistory.call(gateway, 2)).toEqual([
      { limit: 2, sourceRef: "local:skill" },
    ]);

    await expect(
      GatewayService.prototype.validateSkillImport.call(gateway, {
        sourceRef: "local:skill",
        sourceProvider: "local",
      }),
    ).resolves.toBe(validation);
    expect(gateway.recordSkillImportEvent).toHaveBeenCalledWith(validation, "import_validated");
    expect(gateway.publishRealtime).toHaveBeenCalledWith("system", "skills", {
      type: "skill_import_validated",
      sourceProvider: "local",
      sourceRef: "local:skill",
      valid: true,
      riskLevel: "medium",
      skillName: "Filesystem Reviewer",
    });

    await expect(
      GatewayService.prototype.installSkillImport.call(gateway, {
        sourceRef: "local:skill",
        force: true,
      }),
    ).resolves.toMatchObject({
      validation,
      installedSkillId: "skill-fs-reviewer",
    });
    expect(gateway.reloadSkills).toHaveBeenCalledTimes(1);
    expect(gateway.setSkillState).toHaveBeenCalledWith(
      "skill-fs-reviewer",
      "disabled",
      "Imported skill starts disabled by default.",
    );
    expect(gateway.recordSkillImportEvent).toHaveBeenCalledWith(validation, "import_installed");
    expect(gateway.publishRealtime).toHaveBeenCalledWith("system", "skills", {
      type: "skill_import_installed",
      sourceProvider: "local",
      sourceRef: "local:skill",
      riskLevel: "medium",
      skillName: "Filesystem Reviewer",
      skillId: "skill-fs-reviewer",
      installedPath: "skills/extra/fs-reviewer",
    });
  });

  it("normalizes MCP inventory, tools, and fallback approvals from persisted settings", () => {
    const settings = new Map<string, unknown>();
    settings.set("mcp_servers_v1", [
      {
        serverId: "server-2",
        label: "Zeta",
        transport: "stdio",
        command: "node",
        args: ["zeta.js"],
        status: "connected",
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
      undefined,
    ]);
    settings.set("mcp_tools_v1", [
      { serverId: "server-2", toolName: "zeta.write", description: "Write" },
      { serverId: "server-2", toolName: "alpha.read", description: "Read" },
      { serverId: "", toolName: "ignored" },
    ]);
    settings.set("mcp_tool_first_approval_v1", {
      "server-2": ["alpha.read"],
    });
    const gateway = createGatewayHarness({
      storage: {
        systemSettings: {
          get: vi.fn((key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined)),
          set: vi.fn((key: string, value: unknown) => settings.set(key, value)),
        },
      },
    });

    expect(GatewayService.prototype.listMcpServers.call(gateway)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "goatcitadel-internal-approval-inbox",
          url: "goatcitadel://approval-inbox",
          status: "connected",
        }),
        expect.objectContaining({
          serverId: "goatcitadel-internal-durable-tasks",
          url: "goatcitadel://durable-tasks",
          status: "connected",
        }),
        expect.objectContaining({
          serverId: "server-2",
          category: "development",
          trustTier: "restricted",
          costTier: "unknown",
          policy: expect.objectContaining({
            requireFirstToolApproval: false,
            redactionMode: "basic",
          }),
        }),
      ]),
    );
    expect(GatewayService.prototype.listMcpTools.call(gateway, "server-2")).toEqual([
      { serverId: "server-2", toolName: "alpha.read", description: "Read" },
      { serverId: "server-2", toolName: "zeta.write", description: "Write" },
    ]);
    expect(GatewayService.prototype.listMcpBrowserFallbackTargets.call(gateway)).toEqual([]);
    expect((GatewayService.prototype as any).isMcpToolApproved.call(gateway, "server-2", "alpha.read")).toBe(true);
    expect((GatewayService.prototype as any).isMcpToolApproved.call(gateway, "server-2", "zeta.write")).toBe(false);

    const patched = GatewayService.prototype.patchMcpServerState.call(gateway, "server-2", {
      status: "error",
      lastConnectedAt: undefined,
      lastError: "spawn failed",
    });
    expect(patched).toMatchObject({
      serverId: "server-2",
      status: "error",
      lastConnectedAt: undefined,
      lastError: "spawn failed",
    });
    expect(settings.get("mcp_servers_v1")).toEqual([
      expect.objectContaining({
        serverId: "server-2",
        status: "error",
        lastError: "spawn failed",
      }),
    ]);
    expect(() => GatewayService.prototype.requireMcpServer.call(gateway, "missing")).toThrow("Unknown MCP server");
  });

  it("projects queued channel delivery outcomes for sent and failed runtime records", async () => {
    const gateway = createGatewayHarness({
      storage: {
        integrationConnections: {
          get: vi.fn(() => ({ key: "discord" })),
        },
      },
      channelDeliveryRuntimeService: {
        enqueue: vi
          .fn()
          .mockReturnValueOnce({
            deliveryId: "sent-1",
            status: "sent",
            channelKey: "discord",
            target: "room-a",
            providerMessageId: "provider-1",
            createdAt: "2026-05-15T00:00:00.000Z",
            updatedAt: "2026-05-15T00:00:01.000Z",
          })
          .mockReturnValueOnce({
            deliveryId: "failed-1",
            status: "failed",
            deliveryStatus: "failed",
            channelKey: "discord",
            target: "room-b",
            error: "provider denied",
            createdAt: "2026-05-15T00:00:02.000Z",
            updatedAt: "2026-05-15T00:00:03.000Z",
          }),
      },
      scheduleChannelDeliveryDrain: vi.fn(),
    });

    await expect(
      GatewayService.prototype.commsSend.call(gateway, {
        connectionId: "conn-1",
        target: "room-a",
        message: "hello",
      }),
    ).resolves.toEqual({
      deliveryId: "sent-1",
      status: "sent",
      deliveryStatus: "sent",
      channelKey: "discord",
      target: "room-a",
      providerMessageId: "provider-1",
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
    });
    await expect(
      GatewayService.prototype.commsSend.call(gateway, {
        connectionId: "conn-1",
        target: "room-b",
        message: "hello",
      }),
    ).resolves.toEqual({
      deliveryId: "failed-1",
      status: "failed",
      deliveryStatus: "failed",
      channelKey: "discord",
      target: "room-b",
      error: "provider denied",
      fallbackReason: "provider denied",
      createdAt: "2026-05-15T00:00:02.000Z",
      updatedAt: "2026-05-15T00:00:03.000Z",
    });
    expect(gateway.scheduleChannelDeliveryDrain).toHaveBeenCalledTimes(2);
  });

  it("maps LLM secret/config/model facades and filters fallback targets", async () => {
    const runtime = {
      activeProviderId: "openai",
      activeModel: "gpt-5",
      providers: [
        { providerId: "openai", defaultModel: "gpt-4.1-mini", hasApiKey: true },
        { providerId: "moonshot", defaultModel: "kimi-k2", hasApiKey: true },
        { providerId: "anthropic", defaultModel: "claude-sonnet", hasApiKey: false },
      ],
    };
    const gateway = createGatewayHarness({
      llmService: {
        getProviderSecretStatus: vi.fn(() => ({
          providerId: "openai",
          hasApiKey: true,
          apiKeySource: "env",
        })),
        getRuntimeConfig: vi.fn(() => runtime),
        listModels: vi.fn(async (providerId: string) => [{ providerId, model: "gpt-5" }]),
      },
    });

    expect(GatewayService.prototype.getProviderSecretStatus.call(gateway, "openai")).toEqual({
      providerId: "openai",
      hasSecret: true,
      source: "env",
    });
    expect(GatewayService.prototype.getLlmConfig.call(gateway)).toBe(runtime);
    expect(gateway.llmService.getRuntimeConfig).toHaveBeenCalledWith({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    await expect(GatewayService.prototype.listLlmModels.call(gateway, "openai")).resolves.toEqual([
      { providerId: "openai", model: "gpt-5" },
    ]);
    expect(GatewayService.prototype.resolveFallbackTargets.call(gateway, runtime, "openai", "gpt-5")).toEqual([
      { providerId: "moonshot", model: "kimi-k2" },
    ]);
    expect(
      GatewayService.prototype.resolveFallbackTargets.call(
        gateway,
        {
          ...runtime,
          activeModel: "gpt-4.1-mini",
        },
        "openai",
        "gpt-5",
      ),
    ).toEqual([
      { providerId: "openai", model: "gpt-4.1-mini" },
      { providerId: "moonshot", model: "kimi-k2" },
    ]);
    expect(
      GatewayService.prototype.resolveFallbackTargets.call(
        gateway,
        {
          ...runtime,
          activeProviderId: "anthropic",
          activeModel: "claude-sonnet",
        },
        "openai",
        "gpt-5",
      ),
    ).toEqual([{ providerId: "moonshot", model: "kimi-k2" }]);
  });
});
