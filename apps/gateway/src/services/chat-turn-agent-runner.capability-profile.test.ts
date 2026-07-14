import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type CapabilityCatalogEntry,
  type CapabilityCatalogSnapshotRecord,
  type ChatCompletionRequest,
  type ChatTurnCapabilityProfileRecord,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import { sealChatTurnCapabilityProfile } from "@goatcitadel/storage";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "browser_search",
    description: "Search public sources.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const TOOL_CATALOG_ENTRY: CapabilityCatalogEntry = {
  capabilityId: "tool:browser.search",
  kind: "tool",
  category: "built_in",
  title: "Browser search",
  summary: "Search public sources.",
  callable: true,
  toolName: "browser.search",
};

const INSPECTABLE_ONLY_ENTRY: CapabilityCatalogEntry = {
  capabilityId: "skill:candidate",
  kind: "skill",
  category: "community_imported",
  title: "Candidate",
  summary: "Not callable.",
  callable: false,
  skillId: "candidate",
  lifecycleState: "candidate",
};

const TRUSTED_SKILL_ENTRY: CapabilityCatalogEntry = {
  capabilityId: "skill:repo-review",
  kind: "skill",
  category: "optional",
  title: "Repository review",
  summary: "Review a repository.",
  callable: true,
  skillId: "repo-review",
  lifecycleState: "trusted",
  trustLabel: "Trusted",
};

const TRUSTED_SKILL_LIFECYCLE: SkillLifecycleRecord = {
  skillId: "repo-review",
  category: "optional",
  lifecycleState: "trusted",
  trustLabel: "Trusted",
  provenance: {
    source: "managed",
    sourceRef: "skill://repo-review",
    sourceProvider: "goatcitadel",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    contentIntegrity: {
      manifestVersion: "goatcitadel.skill-tree.v1",
      treeSha256: "1".repeat(64),
      fileCount: 2,
      totalBytes: 512,
      verified: true,
    },
  },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

function buildCatalogSnapshot(includeTrustedSkill = false): CapabilityCatalogSnapshotRecord {
  const inspectableEntries = [
    TOOL_CATALOG_ENTRY,
    ...(includeTrustedSkill ? [TRUSTED_SKILL_ENTRY] : []),
    INSPECTABLE_ONLY_ENTRY,
  ].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const callableEntries = [TOOL_CATALOG_ENTRY, ...(includeTrustedSkill ? [TRUSTED_SKILL_ENTRY] : [])].sort(
    (left, right) => left.capabilityId.localeCompare(right.capabilityId),
  );
  return {
    snapshotId: "snapshot-frozen",
    inspectableEntries,
    callableEntries,
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}

function buildProfile(
  options: { requiresApproval?: boolean; trustedSkill?: boolean } = {},
): ChatTurnCapabilityProfileRecord {
  const requiresApproval = options.requiresApproval ?? false;
  const snapshot = buildCatalogSnapshot(options.trustedSkill);
  return sealChatTurnCapabilityProfile({
    profileId: "chat-capability-profile-turn-frozen",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: "turn-frozen",
      sessionId: "session-frozen",
      workspaceId: "workspace-frozen",
      citadelId: "citadel-frozen",
      operatorId: "operator-frozen",
      authActorId: "operator-frozen",
      authActorSource: "token",
    },
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: "snapshot-frozen",
      inspectableHash: digest(snapshot.inspectableEntries),
      callableHash: digest(snapshot.callableEntries),
      inspectableCount: snapshot.inspectableEntries.length,
      callableCount: snapshot.callableEntries.length,
    },
    selection: {
      contentHash: digest("Search public sources."),
      effectiveProviderId: "provider-a",
      effectiveModel: "model-a",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "auto",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "workspace-frozen",
        sessionId: "session-frozen",
        contextManifestRef: `chat-memory-scope:${"d".repeat(64)}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "auto_when_useful",
      toolAutonomy: "safe_auto",
      tools: [
        {
          canonicalName: "browser.search",
          modelName: "browser_search",
          definitionHash: digest(TOOL_DEFINITION),
          providerDefinition: TOOL_DEFINITION,
        },
      ],
      modelNameAllowMap: [{ modelName: "browser_search", canonicalName: "browser.search" }],
      trustedSkills: options.trustedSkill
        ? [
            {
              capabilityId: TRUSTED_SKILL_ENTRY.capabilityId,
              skillId: TRUSTED_SKILL_LIFECYCLE.skillId,
              category: TRUSTED_SKILL_LIFECYCLE.category,
              lifecycleState: "trusted",
              trustLabel: TRUSTED_SKILL_LIFECYCLE.trustLabel,
              source: TRUSTED_SKILL_LIFECYCLE.provenance?.source ?? "managed",
              sourceRef: TRUSTED_SKILL_LIFECYCLE.provenance?.sourceRef,
              sourceProvider: TRUSTED_SKILL_LIFECYCLE.provenance?.sourceProvider,
              commitSha: TRUSTED_SKILL_LIFECYCLE.provenance?.commitSha,
              contentIntegrityManifestVersion: "goatcitadel.skill-tree.v1",
              treeSha256: TRUSTED_SKILL_LIFECYCLE.provenance?.contentIntegrity?.treeSha256,
              contentFileCount: TRUSTED_SKILL_LIFECYCLE.provenance?.contentIntegrity?.fileCount,
              contentBytes: TRUSTED_SKILL_LIFECYCLE.provenance?.contentIntegrity?.totalBytes,
            },
          ]
        : [],
    },
    governance: {
      activeGrants: [],
      permission: {
        profileId: "safe",
        approvalMode: "approve_all",
        profileHash: "e".repeat(64),
      },
      policyDecisions: [
        {
          toolName: "browser.search",
          allowed: true,
          requiresApproval,
          reasonCodes: [requiresApproval ? "frozen_approval_required" : "frozen_allow"],
        },
      ],
      authReadiness: [
        { kind: "provider", ref: "provider-a", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "channel-frozen", status: "ready", reasonCodes: [] },
        { kind: "tool", ref: "browser.search", status: "unknown", reasonCodes: ["runtime_auth_check_required"] },
        ...(options.trustedSkill
          ? [{ kind: "skill" as const, ref: "repo-review", status: "ready" as const, reasonCodes: [] }]
          : []),
      ],
      approval: {
        mode: "approve_all",
        selectedToolCount: 1,
        toolsRequiringApproval: requiresApproval ? ["browser.search"] : [],
        approvalGranted: false,
      },
    },
    preflightFingerprint: "f".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
  });
}

function createProfileStorage(profile: ChatTurnCapabilityProfileRecord, lifecycleRows: SkillLifecycleRecord[] = []) {
  const storage = createMockStorage() as ReturnType<typeof createMockStorage> & {
    capabilityCatalogSnapshots: { get(snapshotId: string): CapabilityCatalogSnapshotRecord };
    skillLifecycle: { list(): SkillLifecycleRecord[] };
  };
  storage.capabilityCatalogSnapshots = {
    get: vi.fn((snapshotId: string) => {
      expect(snapshotId).toBe(profile.catalog.snapshotId);
      return buildCatalogSnapshot(profile.selection.trustedSkills.length > 0);
    }),
  };
  storage.skillLifecycle = { list: vi.fn(() => lifecycleRows) };
  return storage;
}

function liveCallableCatalog(profile: ChatTurnCapabilityProfileRecord): CapabilityCatalogEntry[] {
  return buildCatalogSnapshot(profile.selection.trustedSkills.length > 0).callableEntries;
}

function buildInput(profile: ChatTurnCapabilityProfileRecord) {
  return {
    sessionId: "session-frozen",
    turnId: "turn-frozen",
    userMessageId: "message-frozen",
    content: "Search public sources.",
    mode: "chat" as const,
    providerId: "provider-a",
    model: "model-a",
    webMode: "auto" as const,
    memoryMode: "off" as const,
    retrievalMode: "standard" as const,
    thinkingLevel: "standard" as const,
    speedMode: "standard" as const,
    subagentPolicy: "auto_when_useful" as const,
    toolAutonomy: "safe_auto" as const,
    operatorId: "operator-frozen",
    authActorId: "operator-frozen",
    authActorSource: "token" as const,
    permissionProfileId: "safe",
    historyMessages: [{ role: "user" as const, content: "Search public sources." }],
    capabilityProfile: profile,
  };
}

describe("ChatTurnAgentRunner frozen capability profiles", () => {
  it("sends only the frozen definitions even when live catalog/grants gain a new tool", async () => {
    const completionRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      completionRequests.push(request);
      return {
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "Done." } }],
      };
    });
    const invokeTool = vi.fn();
    const profile = buildProfile();
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      // shell.exec represents a tool/grant that appeared after admission.
      listToolCatalog: () => createToolCatalog(["browser.search", "shell.exec"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });

    await runner.run(buildInput(profile));

    expect(completionRequests).toHaveLength(1);
    expect(completionRequests[0]?.tools).toEqual([TOOL_DEFINITION]);
    expect(JSON.stringify(completionRequests[0]?.tools)).not.toContain("shell_exec");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("lets current deny-wins policy narrow a frozen allow before invocation", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "The search was blocked." } }],
      });
    const invokeTool = vi.fn();
    const profile = buildProfile();
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({
        allowed: false,
        requiresApproval: false,
        reasonCodes: ["current_deny"],
      })),
    });

    const result = await runner.run(buildInput(profile));

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "browser.search",
          status: "blocked",
          error: expect.stringContaining("Current deny-wins policy narrowed"),
        }),
      ]),
    );
  });

  it("never drops a frozen approval requirement when current policy becomes broader", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "Approval posture stayed frozen." } }],
      });
    const invokeTool = vi.fn();
    const profile = buildProfile({ requiresApproval: true });
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });

    const result = await runner.run(buildInput(profile));

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns[0]).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("broaden"),
    });
  });

  it.each([
    ["content", { content: "different content" }],
    ["memory mode", { memoryMode: "on" }],
    ["memory retrieval mode", { retrievalMode: "layered" }],
    ["permission profile", { permissionProfileId: "power" }],
    ["operator identity", { operatorId: "other-operator" }],
    ["tool autonomy", { toolAutonomy: "manual" }],
  ])("rejects execution-time %s drift before the provider boundary", async (label, patch) => {
    const createChatCompletion = vi.fn();
    const invokeTool = vi.fn();
    const profile = buildProfile();
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });

    await expect(runner.run({ ...buildInput(profile), ...patch } as never)).rejects.toThrow(
      `Capability profile ${label} does not match`,
    );
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("allows answered-prompt continuation content while validating the original admitted content", async () => {
    const createChatCompletion = vi.fn(async () => ({
      model: "model-a",
      choices: [{ index: 0, message: { role: "assistant", content: "Continued." } }],
    }));
    const profile = buildProfile();
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool: vi.fn(),
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });

    await expect(
      runner.run({
        ...buildInput(profile),
        content: "Search public sources.\n\nResume context from answered blocking prompts:\nUse the safe path.",
        capabilityProfileContent: "Search public sources.",
      }),
    ).resolves.toMatchObject({ assistantContent: "Continued." });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("refuses catalog collisions and inactive or exact-byte-drifted skills before the provider boundary", async () => {
    const profile = buildProfile({ trustedSkill: true });
    const createChatCompletion = vi.fn();
    const invokeTool = vi.fn();

    const corruptCatalogStorage = createProfileStorage(profile, [TRUSTED_SKILL_LIFECYCLE]);
    corruptCatalogStorage.capabilityCatalogSnapshots.get = vi.fn(() => ({
      ...buildCatalogSnapshot(true),
      callableEntries: [TRUSTED_SKILL_ENTRY],
    }));
    const corruptCatalogRunner = new ChatTurnAgentRunner({
      storage: corruptCatalogStorage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });
    await expect(corruptCatalogRunner.run(buildInput(profile))).rejects.toThrow(/immutable catalog snapshot/);

    const liveCollisionRunner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile, [TRUSTED_SKILL_LIFECYCLE]) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => [
        ...liveCallableCatalog(profile),
        { ...TOOL_CATALOG_ENTRY, capabilityId: "tool:browser.search.alias" },
      ],
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });
    await expect(liveCollisionRunner.run(buildInput(profile))).rejects.toThrow(/tool-name collision/);

    const disabledSkillRunner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile, [TRUSTED_SKILL_LIFECYCLE]) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => buildCatalogSnapshot(false).callableEntries,
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });
    await expect(disabledSkillRunner.run(buildInput(profile))).rejects.toThrow(
      /no longer in the current callable catalog/,
    );

    for (const lifecycle of [
      { ...TRUSTED_SKILL_LIFECYCLE, lifecycleState: "candidate" as const },
      {
        ...TRUSTED_SKILL_LIFECYCLE,
        provenance: {
          ...TRUSTED_SKILL_LIFECYCLE.provenance,
          contentIntegrity: {
            ...TRUSTED_SKILL_LIFECYCLE.provenance!.contentIntegrity!,
            treeSha256: "2".repeat(64),
          },
        },
      },
    ]) {
      const runner = new ChatTurnAgentRunner({
        storage: createProfileStorage(profile, [lifecycle as SkillLifecycleRecord]) as never,
        listToolCatalog: () => createToolCatalog(["browser.search"]),
        listCapabilityCatalog: () => liveCallableCatalog(profile),
        createChatCompletion,
        invokeTool,
        evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      });
      await expect(runner.run(buildInput(profile))).rejects.toThrow(/no longer callable|provenance has drifted/);
    }
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });
});
