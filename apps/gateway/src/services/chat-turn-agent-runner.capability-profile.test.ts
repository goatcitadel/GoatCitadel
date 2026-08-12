import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type CapabilityCatalogEntry,
  type CapabilityCatalogSnapshotRecord,
  type ChatCompletionRequest,
  type ChatTurnCapabilityProfileRecord,
  type SkillLifecycleRecord,
  type ToolCatalogEntry,
} from "@goatcitadel/contracts";
import { sealChatTurnCapabilityProfile } from "@goatcitadel/storage";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";
import { buildToolRuntimeOwnerBinding } from "./tool-runtime-interposition.js";

const MESH_PUBLICATION_BINDING = {
  nodeId: "node-a",
  publisherGeneration: 3,
  manifestSha256: "d".repeat(64),
  entrySha256: "e".repeat(64),
  activationId: `mesh-activation-${"f".repeat(48)}`,
  activationRevision: 2,
  publicationLeaseFencingToken: 5,
  permissionEnvelopeSha256: "a".repeat(64),
  effectPosture: "read_only" as const,
  healthGeneration: 4,
};

const MESH_DISPATCH_RECEIPT = {
  invocationId: `mesh-invocation-${"a".repeat(48)}`,
  capabilityId: "browser.search",
  nodeId: "node-a",
  activationId: MESH_PUBLICATION_BINDING.activationId,
  activationRevision: MESH_PUBLICATION_BINDING.activationRevision,
  publisherGeneration: MESH_PUBLICATION_BINDING.publisherGeneration,
  publicationLeaseFencingToken: MESH_PUBLICATION_BINDING.publicationLeaseFencingToken,
  inputSha256: "b".repeat(64),
  deadlineAt: "2026-07-23T00:00:00.000Z",
};

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

const EXPLORER_READ_DEFINITION = {
  type: "function",
  function: {
    name: "fs_read",
    description: "Read one file inside the approved delegated scope.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const EXPLORER_READ_CAPABILITY: CapabilityCatalogEntry = {
  capabilityId: "tool:fs.read",
  kind: "tool",
  category: "built_in",
  title: "Read file",
  summary: "Read one approved workspace file.",
  callable: true,
  toolName: "fs.read",
};

function buildExplorerProfile(): {
  profile: ChatTurnCapabilityProfileRecord;
  snapshot: CapabilityCatalogSnapshotRecord;
} {
  const snapshot: CapabilityCatalogSnapshotRecord = {
    snapshotId: "snapshot-explorer-read-only",
    inspectableEntries: [EXPLORER_READ_CAPABILITY],
    callableEntries: [EXPLORER_READ_CAPABILITY],
    createdAt: "2026-08-12T00:00:00.000Z",
  };
  const profile = sealChatTurnCapabilityProfile({
    profileId: "chat-capability-profile-explorer-read-only",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: "turn-explorer-read-only",
      sessionId: "session-explorer-read-only",
      workspaceId: "workspace-frozen",
      citadelId: "citadel-frozen",
      operatorId: "operator-frozen",
      authActorId: "operator-frozen",
      authActorSource: "token",
    },
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: snapshot.snapshotId,
      inspectableHash: digest(snapshot.inspectableEntries),
      callableHash: digest(snapshot.callableEntries),
      inspectableCount: 1,
      callableCount: 1,
    },
    selection: {
      contentHash: digest("Inspect the approved file."),
      effectiveProviderId: "provider-a",
      effectiveModel: "model-a",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "workspace-frozen",
        sessionId: "session-explorer-read-only",
        contextManifestRef: `chat-memory-scope:${"d".repeat(64)}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "off",
      toolAutonomy: "safe_auto",
      tools: [
        {
          canonicalName: "fs.read",
          modelName: "fs_read",
          definitionHash: digest(EXPLORER_READ_DEFINITION),
          providerDefinition: EXPLORER_READ_DEFINITION,
        },
      ],
      modelNameAllowMap: [{ modelName: "fs_read", canonicalName: "fs.read" }],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: {
        profileId: "read-only-workspace-explorer",
        approvalMode: "bypass",
        profileHash: "e".repeat(64),
      },
      policyDecisions: [{ toolName: "fs.read", allowed: true, requiresApproval: false, reasonCodes: ["frozen_allow"] }],
      authReadiness: [
        { kind: "provider", ref: "provider-a", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "channel-frozen", status: "ready", reasonCodes: [] },
        { kind: "tool", ref: "fs.read", status: "ready", reasonCodes: [] },
      ],
      approval: { mode: "bypass", selectedToolCount: 1, toolsRequiringApproval: [], approvalGranted: false },
    },
    preflightFingerprint: "f".repeat(64),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  return { profile, snapshot };
}

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
  options: { requiresApproval?: boolean; trustedSkill?: boolean; heartbeat?: boolean; meshTool?: boolean } = {},
): ChatTurnCapabilityProfileRecord {
  const requiresApproval = options.requiresApproval ?? false;
  const heartbeat = options.heartbeat ?? false;
  const snapshot = buildCatalogSnapshot(options.trustedSkill);
  return sealChatTurnCapabilityProfile({
    profileId: "chat-capability-profile-turn-frozen",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: "turn-frozen",
      sessionId: "session-frozen",
      workspaceId: "workspace-frozen",
      citadelId: "citadel-frozen",
      ...(heartbeat ? { durableRunId: "run-heartbeat" } : {}),
      operatorId: heartbeat ? "system-heartbeat" : "operator-frozen",
      authActorId: heartbeat ? "system-heartbeat" : "operator-frozen",
      authActorSource: heartbeat ? "none" : "token",
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
          ...(options.meshTool
            ? {
                runtimeOwner: buildToolRuntimeOwnerBinding("builtin"),
                meshPublication: MESH_PUBLICATION_BINDING,
              }
            : {}),
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
        profileId: heartbeat ? "heartbeat-restricted" : "safe",
        approvalMode: heartbeat ? "bypass" : "approve_all",
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
        mode: heartbeat ? "bypass" : "approve_all",
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

function buildHeartbeatInput(profile: ChatTurnCapabilityProfileRecord) {
  return {
    ...buildInput(profile),
    operatorId: "system-heartbeat",
    authActorId: "system-heartbeat",
    authActorSource: "none" as const,
    permissionProfileId: "heartbeat-restricted",
    policyRunId: "run-heartbeat",
    serverOnlyPosture: {
      kind: "system_heartbeat" as const,
      actorId: "system-heartbeat" as const,
      operation: "chat_system_heartbeat" as const,
      occurrenceId: "heartbeat-occurrence-1",
      claimSha256: "a".repeat(64),
      durableRunId: "run-heartbeat",
    },
  };
}

describe("ChatTurnAgentRunner frozen capability profiles", () => {
  it("executes an explorer provider read under safe_auto while ignoring an unfrozen tool call", async () => {
    const { profile, snapshot } = buildExplorerProfile();
    const storage = createMockStorage() as ReturnType<typeof createMockStorage> & {
      capabilityCatalogSnapshots: { get(snapshotId: string): CapabilityCatalogSnapshotRecord };
      skillLifecycle: { list(): SkillLifecycleRecord[] };
    };
    storage.capabilityCatalogSnapshots = {
      get: vi.fn((snapshotId: string) => {
        expect(snapshotId).toBe(snapshot.snapshotId);
        return snapshot;
      }),
    };
    storage.skillLifecycle = { list: vi.fn(() => []) };
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("fs.read", { path: "apps/gateway/package.json" }))
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "Read-only inspection complete." } }],
      });
    const invokeTool = vi.fn(async (request) => ({
      outcome: "executed" as const,
      policyReason: "allowed",
      auditEventId: "audit-explorer-read",
      result: { path: request.args.path, content: "{}" },
    }));
    const toolCatalog: ToolCatalogEntry[] = [
      {
        toolName: "fs.read",
        category: "filesystem",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Read one approved file.",
        argSchema: EXPLORER_READ_DEFINITION.function.parameters,
        examples: [],
        pack: "core",
      },
      {
        toolName: "session.status",
        category: "ops",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Inspect session state.",
        argSchema: { type: "object", properties: {}, additionalProperties: false },
        examples: [],
        pack: "core",
      },
    ];
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => toolCatalog,
      listCapabilityCatalog: () => [EXPLORER_READ_CAPABILITY],
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });

    const result = await runner.run({
      sessionId: "session-explorer-read-only",
      turnId: "turn-explorer-read-only",
      userMessageId: "message-explorer-read-only",
      content: "Inspect the approved file.",
      mode: "chat",
      providerId: "provider-a",
      model: "model-a",
      webMode: "off",
      memoryMode: "off",
      retrievalMode: "standard",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "off",
      toolAutonomy: "safe_auto",
      operatorId: "operator-frozen",
      authActorId: "operator-frozen",
      authActorSource: "token",
      permissionProfileId: "read-only-workspace-explorer",
      historyMessages: [{ role: "user", content: "Inspect the approved file." }],
      capabilityProfile: profile,
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "fs.read" }));
    expect(createChatCompletion).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(createChatCompletion.mock.calls[0]?.[0].tools)).toContain("fs_read");
    expect(JSON.stringify(createChatCompletion.mock.calls[0]?.[0].tools)).not.toContain("session_status");
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "fs.read", status: "executed" })]),
    );
  });

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

  it("terminates a still-valid mesh-published callable on the M3-pending rejection before any dispatch", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "The mesh tool is blocked." } }],
      });
    const invokeTool = vi.fn();
    const resolveMeshCapabilityPreDispatchBlock = vi.fn(() => "mesh_capability_dispatch_unready" as const);
    const profile = buildProfile({ meshTool: true });
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      resolveMeshCapabilityPreDispatchBlock,
    });

    const result = await runner.run(buildInput(profile));

    // The gate re-verified against the frozen snapshot with the profile's workspace.
    expect(resolveMeshCapabilityPreDispatchBlock).toHaveBeenCalledWith({
      workspaceId: "workspace-frozen",
      binding: MESH_PUBLICATION_BINDING,
    });
    // Fail-closed BEFORE any remote path: no executor dispatch of any kind.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "browser.search",
          status: "blocked",
          error: expect.stringContaining("mesh_capability_dispatch_unready"),
        }),
      ]),
    );
  });

  it("blocks a drifted mesh binding with the content-free drift reason and fails closed without the gate", async () => {
    const invokeTool = vi.fn();
    const profile = buildProfile({ meshTool: true });
    const buildRunner = (
      resolveMeshCapabilityPreDispatchBlock?: () =>
        | "mesh_capability_binding_drift"
        | "mesh_capability_dispatch_unready",
    ) =>
      new ChatTurnAgentRunner({
        storage: createProfileStorage(profile) as never,
        listToolCatalog: () => createToolCatalog(["browser.search"]),
        listCapabilityCatalog: () => liveCallableCatalog(profile),
        createChatCompletion: vi
          .fn()
          .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
          .mockResolvedValueOnce({
            model: "model-a",
            choices: [{ index: 0, message: { role: "assistant", content: "Blocked." } }],
          }),
        invokeTool,
        evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        ...(resolveMeshCapabilityPreDispatchBlock ? { resolveMeshCapabilityPreDispatchBlock } : {}),
      });

    const drifted = await buildRunner(() => "mesh_capability_binding_drift").run(buildInput(profile));
    expect(drifted.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "blocked",
          error: expect.stringContaining("mesh_capability_binding_drift"),
        }),
      ]),
    );

    // Absent composition keeps the mesh callable fail-closed (M3-pending).
    const unwired = await buildRunner(undefined).run(buildInput(profile));
    expect(unwired.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "blocked",
          error: expect.stringContaining("mesh_capability_dispatch_unready"),
        }),
      ]),
    );
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("dispatches an admitted mesh-published callable through the generation-fenced runtime (M3)", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "The mesh tool ran." } }],
      });
    const invokeTool = vi.fn();
    const dispatchMeshCapabilityInvocation = vi.fn(async (_input: unknown, options: { executionFence: () => void }) => {
      // The invocation owner fires the durable fence exactly once at the
      // envelope append; the mock mirrors that discipline.
      options.executionFence();
      return {
        invocationId: `mesh-invocation-${"a".repeat(48)}`,
        disposition: "succeeded" as const,
        settled: true,
        deliveryUncertain: false,
        manualReconciliationRequired: false,
        output: { status: "ok" },
        receipt: MESH_DISPATCH_RECEIPT,
      };
    });
    const profile = buildProfile({ meshTool: true });
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      resolveMeshCapabilityPreDispatchBlock: vi.fn(() => "mesh_capability_dispatch_unready" as const),
      dispatchMeshCapabilityInvocation,
    });

    const result = await runner.run(buildInput(profile));

    // The admitted invocation executed ONLY through the mesh runtime.
    expect(invokeTool).not.toHaveBeenCalled();
    expect(dispatchMeshCapabilityInvocation).toHaveBeenCalledTimes(1);
    expect(dispatchMeshCapabilityInvocation).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-frozen",
        binding: MESH_PUBLICATION_BINDING,
        capabilityId: "browser.search",
        args: { query: "release notes" },
        toolRunId: expect.any(String),
        sessionId: "session-frozen",
        turnId: "turn-frozen",
        executionProfileSha256: "f".repeat(64),
      },
      { executionFence: expect.any(Function), signal: expect.any(AbortSignal) },
    );
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "browser.search",
          status: "executed",
          result: expect.objectContaining({
            status: "ok",
            meshInvocation: expect.objectContaining({
              invocationId: `mesh-invocation-${"a".repeat(48)}`,
              disposition: "succeeded",
              settled: true,
            }),
          }),
        }),
      ]),
    );
  });

  it("still blocks a drifted mesh binding first even when the dispatch runtime is composed", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "Blocked." } }],
      });
    const invokeTool = vi.fn();
    const dispatchMeshCapabilityInvocation = vi.fn();
    const profile = buildProfile({ meshTool: true });
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      resolveMeshCapabilityPreDispatchBlock: vi.fn(() => "mesh_capability_binding_drift" as const),
      dispatchMeshCapabilityInvocation,
    });

    const result = await runner.run(buildInput(profile));

    expect(dispatchMeshCapabilityInvocation).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "blocked",
          error: expect.stringContaining("mesh_capability_binding_drift"),
        }),
      ]),
    );
  });

  it("keeps an approval-gated mesh callable fail-closed instead of bypassing the approval", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "Deferred." } }],
      });
    const invokeTool = vi.fn();
    const dispatchMeshCapabilityInvocation = vi.fn();
    const profile = buildProfile({ meshTool: true, requiresApproval: true });
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: true, reasonCodes: [] })),
      resolveMeshCapabilityPreDispatchBlock: vi.fn(() => "mesh_capability_dispatch_unready" as const),
      dispatchMeshCapabilityInvocation,
    });

    const result = await runner.run(buildInput(profile));

    expect(dispatchMeshCapabilityInvocation).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "blocked",
          error: expect.stringContaining("mesh_capability_approval_dispatch_deferred"),
        }),
      ]),
    );
  });

  it("settles unknown mesh delivery as failed with manual reconciliation and no automatic replay", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "release notes" }))
      .mockResolvedValueOnce({
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: "The delivery is unknown." } }],
      });
    const invokeTool = vi.fn();
    const dispatchMeshCapabilityInvocation = vi.fn(
      async (_input: unknown, options: { executionFence: () => Promise<void> }) => {
        await options.executionFence();
        return {
          invocationId: `mesh-invocation-${"b".repeat(48)}`,
          disposition: "unknown" as const,
          settled: true,
          deliveryUncertain: true,
          manualReconciliationRequired: true,
          errorCode: "mesh_capability_dispatch_deadline_expired",
          receipt: MESH_DISPATCH_RECEIPT,
        };
      },
    );
    const profile = buildProfile({ meshTool: true });
    const runner = new ChatTurnAgentRunner({
      storage: createProfileStorage(profile) as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      resolveMeshCapabilityPreDispatchBlock: vi.fn(() => "mesh_capability_dispatch_unready" as const),
      dispatchMeshCapabilityInvocation,
    });

    const result = await runner.run(buildInput(profile));

    // Exactly ONE dispatch: an unknown delivery is never auto-replayed.
    expect(dispatchMeshCapabilityInvocation).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "browser.search",
          status: "failed",
          error: expect.stringContaining("mesh_capability_dispatch_deadline_expired"),
          failureGuidance: expect.stringContaining("reconcile"),
          effectDisposition: "unknown",
          effectOutcomeKind: "uncertain",
        }),
      ]),
    );
  });

  it("forbids mesh dispatch under the exact system-heartbeat posture even when composed", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "heartbeat status" }));
    const invokeTool = vi.fn();
    const dispatchMeshCapabilityInvocation = vi.fn();
    const profile = buildProfile({ meshTool: true, heartbeat: true });
    const storage = createProfileStorage(profile);
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      resolveMeshCapabilityPreDispatchBlock: vi.fn(() => "mesh_capability_dispatch_unready" as const),
      dispatchMeshCapabilityInvocation,
    });

    await expect(runner.run(buildHeartbeatInput(profile))).rejects.toMatchObject({
      name: "SystemHeartbeatToolInvocationBlockedError",
    });
    expect(dispatchMeshCapabilityInvocation).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("terminally blocks exact system-heartbeat approval drift before invocation or tool-row creation", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "heartbeat status" }));
    const invokeTool = vi.fn();
    const profile = buildProfile({ heartbeat: true });
    const storage = createProfileStorage(profile);
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi
        .fn()
        .mockReturnValueOnce({ allowed: true, requiresApproval: false, reasonCodes: ["heartbeat_allow"] })
        .mockReturnValue({
          allowed: true,
          requiresApproval: true,
          reasonCodes: ["risk_posture_drift"],
        }),
    });

    await expect(runner.run(buildHeartbeatInput(profile))).rejects.toMatchObject({
      name: "SystemHeartbeatToolInvocationBlockedError",
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(storage.chatToolRuns.listByTurn("turn-frozen")).toEqual([]);
  });

  it("omits approval-requiring tools from the exact system-heartbeat provider catalog", async () => {
    const completionRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      completionRequests.push(request);
      return {
        model: "model-a",
        choices: [{ index: 0, message: { role: "assistant", content: '{"notify":false}' } }],
      };
    });
    const invokeTool = vi.fn();
    const profile = buildProfile({ heartbeat: true });
    const storage = createProfileStorage(profile);
    const runner = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      listCapabilityCatalog: () => liveCallableCatalog(profile),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({
        allowed: true,
        requiresApproval: true,
        reasonCodes: ["risk_posture_drift"],
      })),
    });

    const result = await runner.run(buildHeartbeatInput(profile));

    expect(completionRequests[0]?.tools).toBeUndefined();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(storage.chatToolRuns.listByTurn("turn-frozen")).toEqual([]);
    expect(result.turnTrace.status).toBe("running");
    expect(result.turnTrace).not.toHaveProperty("completion");
    expect(result.turnTrace).not.toHaveProperty("finishedAt");
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
