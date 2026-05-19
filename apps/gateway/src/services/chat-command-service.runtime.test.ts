import { describe, expect, it, vi } from "vitest";
import { parseChatCommand, type ChatCommandDependencies } from "./chat-command-service.js";

function createDeps(): ChatCommandDependencies {
  let prefs = {
    sessionId: "session-1",
    mode: "chat",
    planningMode: "off",
    providerId: "primary",
    model: "primary-model",
    webMode: "off",
    memoryMode: "auto",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "off",
    toolAutonomy: "manual",
    proactiveMode: "off",
    retrievalMode: "standard",
    reflectionMode: "off",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };

  return {
    storage: {
      chatSessionMeta: {
        ensure: vi.fn(() => ({ workspaceId: "default" })),
      },
      chatSessionProjects: {
        get: vi.fn(() => ({ projectId: "proj-1" })),
      },
    },
    getSession: vi.fn(() => ({ sessionId: "session-1" })),
    getChatSessionPrefs: vi.fn(() => prefs),
    updateChatSessionPrefs: vi.fn((_sessionId: string, patch: Record<string, unknown>) => {
      prefs = { ...prefs, ...patch };
      return prefs;
    }),
    updateChatSessionProactivePolicy: vi.fn((_sessionId: string, patch: Record<string, unknown>) => {
      prefs = { ...prefs, ...patch };
      return { mode: (patch.proactiveMode ?? prefs.proactiveMode) as never };
    }),
    createChatSession: vi.fn(() => ({
      sessionId: "session-new",
      title: "Next",
      workspaceId: "default",
    })),
    assignChatSessionProject: vi.fn((_sessionId: string, projectId?: string) => ({ projectId })),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId ?? "default"),
    getMemoryMaintenanceStatus: vi.fn(() => ({
      policy: {
        enabled: true,
        runMode: "incremental",
        timingStrategy: "scheduled",
        executionTarget: "local",
        unavailableModelPolicy: "skip",
        timeZone: "America/Los_Angeles",
        schedule: { frequency: "daily", hour: 9, minute: 30 },
      },
      state: { changedSessionCount: 2 },
      lastRun: { status: "completed", updatedAt: "2026-05-14T00:00:00.000Z" },
      nextDueAt: "2026-05-15T16:30:00.000Z",
    })),
    getSettings: vi.fn(() => ({ llm: { activeProviderId: "primary", activeModel: "primary-model" } })),
    runMemoryMaintenanceNow: vi.fn(() => ({ runId: "dream-1" })),
    runChatResearch: vi.fn(async (_sessionId: string, input: { query: string }) => ({
      summary: `Research: ${input.query}`,
      citations: [],
    })),
    runChatDelegation: vi.fn(async (_sessionId: string, input: { roles: string[] }) => ({
      runId: "delegate-1",
      steps: input.roles.map((role, index) => ({ stepId: `step-${index}`, role, index })),
    })),
    scorePromptPackLatestRunByCode: vi.fn(async () => ({ overrideVerdict: "pass" })),
    runPromptPackFromChat: vi.fn(async () => [{ testCode: "TEST-001" }]),
    listSkills: vi.fn(() => [{ skillId: "skill-a", state: "enabled", note: "ready" }]),
    listChatSessions: vi.fn(() => []),
    listMemoryItems: vi.fn(() => []),
    setSkillState: vi.fn((skillId: string, state: string) => ({ skillId, state })),
    listSkillSources: vi.fn(async () => ({
      items: [
        {
          name: "Research Skill",
          sourceProvider: "catalog",
          installability: "installable",
          matchReason: "keyword match",
          sourceUrl: "https://example.com/skill",
        },
      ],
    })),
    lookupSkillSources: vi.fn(async () => ({
      bestMatch: {
        name: "Research Skill",
        sourceProvider: "catalog",
        matchReason: "best fit",
        installability: "installable",
        sourceUrl: "https://example.com/skill",
        installHint: "Use /skill install.",
      },
      items: [],
    })),
    validateSkillImport: vi.fn(async () => ({ valid: true, errors: [], inferredSkillName: "research-skill" })),
    installSkillImport: vi.fn(async () => ({ installedSkillId: "research-skill" })),
    listMcpServers: vi.fn(() => [{ serverId: "mcp-1", label: "Browser", status: "disconnected", enabled: true }]),
    listMcpTemplates: vi.fn(() => [
      {
        templateId: "browser",
        label: "Browser",
        description: "Browser tools",
        transport: "stdio",
        command: "browser",
        installed: false,
      },
    ]),
    connectMcpServer: vi.fn(async (serverId: string) => ({ serverId, status: "connected" })),
    disconnectMcpServer: vi.fn((serverId: string) => ({ serverId, status: "disconnected" })),
    createMcpServer: vi.fn((input) => ({ serverId: "mcp-new", status: "disconnected", ...input })),
    resolveChatToolApproval: vi.fn(async () => ({})),
    getPersonalityCatalog: vi.fn(() => ({ defaultPersonalityId: "default", items: [] })),
    setDefaultPersonality: vi.fn(),
    extractAndPersistLearnedMemory: vi.fn(),
    listChatSessionLearnedMemory: vi.fn(() => ({ items: [], conflicts: [] })),
    updateChatSessionLearnedMemory: vi.fn(),
  } as unknown as ChatCommandDependencies;
}

describe("chat command runtime dispatch", () => {
  it("dispatches preference, workflow, skill, mcp, project, and approval commands through deps", async () => {
    const deps = createDeps();

    const commands = [
      "/new Next",
      "/mode code",
      "/plan on",
      "/model backup/backup-model",
      "/web deep",
      "/memory on",
      "/dream",
      "/dream status",
      "/think deep",
      "/speed fast",
      "/subagents auto_when_useful",
      "/tool safe_auto",
      "/proactive suggest",
      "/retrieval layered",
      "/reflect on",
      "/research release blockers",
      "/delegate QA,Ops :: verify the release",
      "/pipeline triage :: sort the inbox",
      "/score TEST-001 2 2 2 2 2 strong",
      "/pack run TEST-001",
      "/skills",
      "/skill sleep skill-a",
      "/skill search research",
      "/skill lookup research",
      "/skill install https://example.com/skill",
      "/mcp",
      "/mcp connect mcp-1",
      "/mcp disconnect mcp-1",
      "/mcp templates browser",
      "/mcp add-template browser",
      "/project none",
      "/attach attachment-1",
      "/run research local-first ai",
      "/approve approval-1",
      "/deny approval-2",
    ];

    for (const command of commands) {
      const result = await parseChatCommand(deps, "session-1", command);
      expect(result.ok, command).toBe(true);
      expect(result.message, command).toBeTruthy();
    }

    expect(deps.updateChatSessionPrefs).toHaveBeenCalledWith("session-1", { mode: "code" });
    expect(deps.updateChatSessionPrefs).toHaveBeenCalledWith("session-1", {
      providerId: "backup",
      model: "backup-model",
    });
    expect(deps.updateChatSessionProactivePolicy).toHaveBeenCalledWith("session-1", { proactiveMode: "suggest" });
    expect(deps.runChatDelegation).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ objective: "verify the release", roles: ["qa", "ops"] }),
    );
    expect(deps.scorePromptPackLatestRunByCode).toHaveBeenCalledWith(
      expect.objectContaining({ testCode: "TEST-01", routingScore: 2 }),
    );
    expect(deps.resolveChatToolApproval).toHaveBeenCalledWith("session-1", "approval-1", "approve", {
      resolvedBy: "chat-command",
    });
    expect(deps.resolveChatToolApproval).toHaveBeenCalledWith("session-1", "approval-2", "reject", {
      resolvedBy: "chat-command",
    });
  });

  it("stamps approval slash commands with the request actor when provided", async () => {
    const deps = createDeps();

    await expect(
      parseChatCommand(deps, "session-1", "/approve approval-actor", { resolvedBy: "operator-test" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      parseChatCommand(deps, "session-1", "/deny approval-deny", { resolvedBy: "operator-test" }),
    ).resolves.toMatchObject({ ok: true });

    expect(deps.resolveChatToolApproval).toHaveBeenCalledWith("session-1", "approval-actor", "approve", {
      resolvedBy: "operator-test",
    });
    expect(deps.resolveChatToolApproval).toHaveBeenCalledWith("session-1", "approval-deny", "reject", {
      resolvedBy: "operator-test",
    });
  });

  it("uses channel /memory as lookup while preserving chat memory mode commands", async () => {
    const deps = createDeps();
    vi.mocked(deps.listChatSessionLearnedMemory).mockReturnValue({
      conflicts: [],
      items: [
        {
          itemId: "mem_deploy_123456",
          sessionId: "session-1",
          itemType: "project_context",
          content: "Deployment requires the signed installer proof lane.",
          confidence: 0.9,
          status: "active",
          redacted: false,
          createdAt: "2026-05-18T00:00:00.000Z",
          updatedAt: "2026-05-18T00:00:00.000Z",
        },
      ],
    });

    await expect(parseChatCommand(deps, "session-1", "/memory on")).resolves.toMatchObject({
      ok: true,
      message: "Memory mode set to on.",
    });
    await expect(
      parseChatCommand(deps, "session-1", "/memory installer", {
        source: "channel",
        channelContext: { platform: "discord", account: "conn-1", actorId: "user-1" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("[mem_depl] project_context"),
    });
  });

  it("renders compact channel recall results from scoped session search", async () => {
    const deps = createDeps();
    vi.mocked(deps.listChatSessions).mockReturnValue([
      {
        sessionId: "session-1",
        sessionKey: "discord:conn-1:room-1",
        workspaceId: "default",
        scope: "channel",
        includeInHistory: true,
        pinned: false,
        lifecycleStatus: "active",
        channel: "discord",
        account: "conn-1",
        updatedAt: "2026-05-18T00:00:00.000Z",
        lastActivityAt: "2026-05-18T00:00:00.000Z",
        tokenTotal: 0,
        costUsdTotal: 0,
        title: "Release session",
        searchHits: [
          {
            messageId: "msg_release_123456",
            excerpt: "Release proof used the installer workflow.",
            score: 10,
          },
        ],
      } as never,
    ]);

    await expect(
      parseChatCommand(deps, "session-1", "/recall installer workflow", {
        source: "channel",
        channelContext: { platform: "discord", account: "conn-1", actorId: "user-1" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("[msg_rele] Release session"),
    });
  });

  it("passes slash-command delegation through the caller governance context", async () => {
    const deps = createDeps();

    await expect(
      parseChatCommand(deps, "session-1", "/delegate QA,Ops :: verify the release", {
        resolvedBy: "operator-test",
        operatorId: "operator-test",
        authActorId: "operator-test",
        authActorSource: "loopback",
        policyRunId: "parent-run-1",
        policyTaskId: "parent-task-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(deps.runChatDelegation).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        objective: "verify the release",
        roles: ["qa", "ops"],
        policyRunId: "parent-run-1",
        policyTaskId: "parent-task-1",
        operatorId: "operator-test",
        authActorId: "operator-test",
        authActorSource: "loopback",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
      }),
    );
  });

  it("returns explicit usage failures for malformed commands", async () => {
    const deps = createDeps();

    await expect(parseChatCommand(deps, "session-1", "hello")).resolves.toMatchObject({
      ok: false,
      message: "Command must start with '/'.",
    });
    await expect(parseChatCommand(deps, "session-1", "/web maybe")).resolves.toMatchObject({
      ok: false,
      message: "Usage: /web auto|off|quick|deep",
    });
    await expect(parseChatCommand(deps, "session-1", "/unknown")).resolves.toMatchObject({
      ok: false,
      message: "Unknown command /unknown. Use /help.",
    });
  });
});
