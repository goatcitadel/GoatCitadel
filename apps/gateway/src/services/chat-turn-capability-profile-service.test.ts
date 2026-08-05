import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  canonicalJsonString,
  deriveHookPhase,
  TOOL_EFFECT_CLASSIFICATION_VERSION,
  type CapabilityCatalogEntry,
  type HookRecord,
  type HookTrigger,
  type McpRequesterResolutionBinding,
  type McpRequesterResolutionBindingMaterial,
  type ToolPolicyActorContext,
  type WorkPassportRecord,
} from "@goatcitadel/contracts";
import { verifyChatTurnCapabilityProfile } from "@goatcitadel/storage";
import {
  resolveChatTurnCapabilityProfile,
  type ChatTurnCapabilityProfileResolveDeps,
  type ChatTurnCapabilityProfileResolveInput,
} from "./chat-turn-capability-profile-service.js";
import { buildToolRuntimeOwnerBinding } from "./tool-runtime-interposition.js";

const TOOL_ENTRY: CapabilityCatalogEntry = {
  capabilityId: "tool:browser.search",
  kind: "tool",
  category: "built_in",
  title: "Browser search",
  summary: "Search public sources.",
  callable: true,
  toolName: "browser.search",
};

const SKILL_ENTRY: CapabilityCatalogEntry = {
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

const INSPECTABLE_ONLY: CapabilityCatalogEntry = {
  capabilityId: "skill:candidate",
  kind: "skill",
  category: "community_imported",
  title: "Candidate",
  summary: "Not active.",
  callable: false,
  skillId: "candidate",
  lifecycleState: "candidate",
};

const PROVIDER_TOOL = {
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

const REQUESTER_MCP_ENTRY: CapabilityCatalogEntry = {
  ...TOOL_ENTRY,
  capabilityId: "tool:mcp.tenant-mcp.search",
  title: "Tenant MCP search",
  toolName: "mcp.tenant-mcp.search",
};

const REQUESTER_MCP_PROVIDER_TOOL = {
  ...PROVIDER_TOOL,
  function: {
    ...PROVIDER_TOOL.function,
    name: "mcp_tenant_mcp_search",
  },
};

function sealRequesterMcpBinding(material: McpRequesterResolutionBindingMaterial): McpRequesterResolutionBinding {
  return {
    ...material,
    bindingSha256: createHash("sha256").update(canonicalJsonString(material)).digest("hex"),
  };
}

function configureRequesterMcp(deps: ChatTurnCapabilityProfileResolveDeps) {
  deps.listCapabilityCatalog = vi.fn(() => [REQUESTER_MCP_ENTRY]);
  deps.resolveToolSchema = vi.fn(async () => ({
    tools: [REQUESTER_MCP_PROVIDER_TOOL],
    modelToCanonical: new Map([["mcp_tenant_mcp_search", "mcp.tenant-mcp.search"]]),
    canonicalToModel: new Map([["mcp.tenant-mcp.search", "mcp_tenant_mcp_search"]]),
    policyDecisions: [
      {
        toolName: "mcp.tenant-mcp.search",
        allowed: true,
        requiresApproval: true,
        reasonCodes: ["permission_profile_requires_approval"],
      },
    ],
  }));
  const resolver = vi.fn(
    (input: Parameters<NonNullable<ChatTurnCapabilityProfileResolveDeps["resolveMcpRequesterResolutionBinding"]>>[0]) =>
      sealRequesterMcpBinding({
        schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
        mode: "requester_scoped",
        serverId: "tenant-mcp",
        toolName: input.canonicalToolName,
        resolverId: "gateway.tenant-mcp",
        resolverVersion: "1.2.3",
        resolverConfigGeneration: 4,
        requesterScopeSha256: input.requesterScopeSha256 ?? "0".repeat(64),
        serverConfigRevision: 7,
        serverConfigSha256: "b".repeat(64),
        transportPolicySha256: "c".repeat(64),
        callableCatalogSnapshotId: input.catalogSnapshotId,
        callableCatalogSha256: input.callableCatalogSha256,
      }),
  );
  deps.resolveMcpRequesterResolutionBinding = resolver;
  return resolver;
}

function buildInput(): ChatTurnCapabilityProfileResolveInput {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceId: "workspace-1",
    citadelId: "citadel-1",
    route: { channel: "chat", account: "default", peer: "private-peer" },
    content: "Search the repository release notes.",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "auto_when_useful",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: "Search the repository release notes." }],
    routeResolution: {
      requestedProviderId: "provider-a",
      requestedModel: "model-a",
      effectiveProviderId: "provider-a",
      effectiveModel: "model-a",
      fallbackTarget: { providerId: "provider-b", model: "model-b" },
      fallbackPolicy: "armed",
      runtimeClass: "cloud",
    },
    operatorId: "operator-1",
    authActorId: "operator-1",
    authActorSource: "token",
    permissionProfileId: "safe",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}

function buildDeps() {
  const inspectable = [TOOL_ENTRY, SKILL_ENTRY, INSPECTABLE_ONLY];
  const callable = [TOOL_ENTRY, SKILL_ENTRY];
  const listCapabilityCatalog = vi.fn((scope: "inspectable" | "callable") =>
    scope === "inspectable" ? inspectable : callable,
  );
  const resolveToolSchema = vi.fn(async () => ({
    tools: [PROVIDER_TOOL],
    modelToCanonical: new Map([["browser_search", "browser.search"]]),
    canonicalToModel: new Map([["browser.search", "browser_search"]]),
    policyDecisions: [
      {
        toolName: "browser.search",
        allowed: true,
        requiresApproval: true,
        reasonCodes: ["permission_profile_requires_approval"],
        matchedGrantId: "grant-1",
      },
    ],
  }));
  const policyContext: ToolPolicyActorContext = {
    operatorId: "operator-1",
    authActorId: "operator-1",
    authActorSource: "token",
    permissionProfileId: "safe",
    workspaceId: "workspace-1",
    sessionId: "session-1",
  };
  const deps = {
    storage: {
      workspaceHooks: {
        listByTrigger: vi.fn(() => []),
      },
      toolGrants: {
        listActive: vi.fn((scope: string, scopeRef: string) =>
          scope === "global" && scopeRef === "global"
            ? [
                {
                  grantId: "grant-1",
                  toolPattern: "browser.search",
                  decision: "allow",
                  scope: "global",
                  scopeRef: "global",
                  grantType: "persistent",
                },
              ]
            : [],
        ),
      },
      skillLifecycle: {
        list: vi.fn(() => [
          {
            skillId: "repo-review",
            category: "optional",
            lifecycleState: "trusted",
            trustLabel: "Trusted",
            provenance: {
              source: "git",
              sourceRef: "skill://repo-review",
              sourceProvider: "github",
              commitSha: "0123456789abcdef0123456789abcdef01234567",
              contentIntegrity: {
                manifestVersion: "goatcitadel.skill-tree.v1",
                treeSha256: "a".repeat(64),
                fileCount: 3,
                totalBytes: 1024,
                verified: true,
              },
            },
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        ]),
      },
    },
    listCapabilityCatalog,
    resolveToolSchema,
    resolveToolPolicyContext: vi.fn(() => policyContext),
    getProviderReadiness: vi.fn(() => ({ configured: true, local: false })),
  } as unknown as ChatTurnCapabilityProfileResolveDeps;
  return { deps, inspectable, callable, listCapabilityCatalog, resolveToolSchema, policyContext };
}

function hookRecord(trigger: HookTrigger, url = `https://hooks.example.test/${trigger}`): HookRecord {
  return {
    hookId: `hook-${trigger}`,
    workspaceId: "workspace-1",
    label: trigger,
    trigger,
    phase: deriveHookPhase(trigger),
    mode: "observe",
    enabled: true,
    priority: 100,
    timeoutMs: 5_000,
    failPolicy: "closed",
    action: { type: "webhook", webhook: { url, secret: "never-project-this-secret" } },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

function configureSafeRead(deps: ChatTurnCapabilityProfileResolveDeps): void {
  const safeEntry: CapabilityCatalogEntry = {
    ...TOOL_ENTRY,
    capabilityId: "tool:time.now",
    toolName: "time.now",
    title: "Current time",
    effectPotential: {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      potential: "none",
      sourceKind: "builtin",
      reason: "trusted_builtin_safe_read",
    },
  };
  deps.listCapabilityCatalog = vi.fn(() => [safeEntry]);
  deps.resolveToolSchema = vi.fn(async () => ({
    tools: [
      {
        ...PROVIDER_TOOL,
        function: { ...PROVIDER_TOOL.function, name: "time_now", description: "Read current time." },
      },
    ],
    modelToCanonical: new Map([["time_now", "time.now"]]),
    canonicalToModel: new Map([["time.now", "time_now"]]),
    policyDecisions: [{ toolName: "time.now", allowed: true, requiresApproval: false, reasonCodes: [] }],
  }));
}

describe("resolveChatTurnCapabilityProfile", () => {
  it("freezes the Work Passport into preview, selection, and integrity verification", async () => {
    const { deps } = buildDeps();
    const workPassport: WorkPassportRecord = {
      passportId: "work-passport-test",
      schemaVersion: "work.passport.v1",
      classificationMode: "deterministic_local_v1",
      baseline: { configured: true, roleLabel: "Engineer", primaryDomains: ["engineering"], revision: 2 },
      taskSignals: [{ domain: "legal", strength: "medium", reasons: ["legal and contract cues"] }],
      boundary: "cross_domain",
      consequence: "high",
      review: {
        posture: "domain_expert_required",
        reason: "Consequential work in a high-stakes domain.",
        requirements: ["Obtain accountable domain review."],
      },
      evidenceRequirements: ["Cite current primary sources."],
      actionPosture: "approval_before_external_action",
      limitations: ["Not an occupation or competence assessment."],
      operatorCorrectionAllowed: true,
    };
    deps.classifyWorkPassport = vi.fn(() => workPassport);

    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

    expect(resolution.profile.selection.workPassport).toEqual(workPassport);
    expect(resolution.preview.workPassport).toEqual(workPassport);
    expect(() => verifyChatTurnCapabilityProfile(resolution.profile)).not.toThrow();
    const tampered = structuredClone(resolution.profile);
    if (tampered.selection.workPassport) tampered.selection.workPassport.boundary = "within_baseline";
    expect(() => verifyChatTurnCapabilityProfile(tampered)).toThrow(/selectionHash verification/);
  });

  it("freezes the exact canonical callable set, effective route, provenance, policy, and readiness", async () => {
    const { deps, inspectable, callable, listCapabilityCatalog, resolveToolSchema } = buildDeps();
    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

    verifyChatTurnCapabilityProfile(resolution.profile);
    expect(listCapabilityCatalog.mock.calls).toEqual([["inspectable"], ["callable"]]);
    expect(resolution.catalogSnapshot.inspectableEntries).toEqual(
      [...inspectable].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
    );
    expect(resolution.catalogSnapshot.callableEntries).toEqual(
      [...callable].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
    );
    expect(resolution.profile.selection).toMatchObject({
      effectiveProviderId: "provider-a",
      effectiveModel: "model-a",
      allowedFallbacks: [],
      tools: [expect.objectContaining({ canonicalName: "browser.search", modelName: "browser_search" })],
      trustedSkills: [
        expect.objectContaining({
          skillId: "repo-review",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          treeSha256: "a".repeat(64),
        }),
      ],
    });
    expect(resolution.profile.source).toEqual({
      channel: "chat",
      account: "default",
      bindingTargetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(resolution.profile)).not.toContain("private-peer");
    expect(resolution.profile.governance.activeGrants.map((grant) => grant.grantId)).toEqual(["grant-1"]);
    expect(resolution.profile.governance.authReadiness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "provider", ref: "provider-a", status: "ready" }),
        expect.objectContaining({ kind: "channel", status: "ready" }),
        expect.objectContaining({ kind: "tool", ref: "browser.search", status: "unknown" }),
        expect.objectContaining({ kind: "skill", ref: "repo-review", status: "ready" }),
      ]),
    );
    expect(resolution.preview.fallbackCount).toBe(0);
    expect(resolveToolSchema).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "provider-a", model: "model-a" }),
    );
  });

  it("binds activated skill instruction receipts into profile and compaction-relevant selection hashes", async () => {
    const { deps } = buildDeps();
    deps.resolveActivatedSkills = vi.fn(({ trustedSkills }) => [
      {
        capabilityId: trustedSkills[0]!.capabilityId,
        skillId: trustedSkills[0]!.skillId,
        confidence: 0.96,
        reasons: ["routing_keyword"],
        treeSha256: trustedSkills[0]!.treeSha256!,
        instructionSha256: "b".repeat(64),
        instructionBytes: 4096,
        modules: [{ name: "main", relativePath: "SKILL.md", sha256: "c".repeat(64), bytes: 4096 }],
      },
    ]);
    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

    expect(resolution.profile.selection.activatedSkills).toEqual([
      expect.objectContaining({ skillId: "repo-review", instructionSha256: "b".repeat(64) }),
    ]);
    const tampered = structuredClone(resolution.profile);
    tampered.selection.activatedSkills![0]!.instructionSha256 = "d".repeat(64);
    expect(() => verifyChatTurnCapabilityProfile(tampered)).toThrow(/selectionHash verification/);
  });

  it("uses a server-owned policy context verbatim and produces deterministic admission fingerprints", async () => {
    const first = buildDeps();
    const input = buildInput();
    input.policyContext = first.policyContext;
    const firstResolution = await resolveChatTurnCapabilityProfile(first.deps, input);
    const secondResolution = await resolveChatTurnCapabilityProfile(first.deps, { ...input });

    expect(first.deps.resolveToolPolicyContext).not.toHaveBeenCalled();
    expect(firstResolution.profile.preflightFingerprint).toBe(secondResolution.profile.preflightFingerprint);
    expect(firstResolution.profile.hashes.profileHash).toBe(secondResolution.profile.hashes.profileHash);
  });

  it("fails closed when callable catalog truth or resolved tool selection drifts", async () => {
    const catalogDrift = buildDeps();
    catalogDrift.deps.listCapabilityCatalog = vi.fn((scope) =>
      scope === "inspectable" ? [TOOL_ENTRY] : [{ ...TOOL_ENTRY, summary: "mutated" }],
    );
    await expect(resolveChatTurnCapabilityProfile(catalogDrift.deps, buildInput())).rejects.toThrow(
      /not an exact canonical inspectable entry/,
    );

    const toolDrift = buildDeps();
    toolDrift.deps.resolveToolSchema = vi.fn(async () => ({
      tools: [PROVIDER_TOOL],
      modelToCanonical: new Map([["browser_search", "new.tool"]]),
      canonicalToModel: new Map([["new.tool", "browser_search"]]),
      policyDecisions: [{ toolName: "new.tool", allowed: true, requiresApproval: false, reasonCodes: [] }],
    }));
    await expect(resolveChatTurnCapabilityProfile(toolDrift.deps, buildInput())).rejects.toThrow(
      /outside the canonical callable catalog/,
    );

    const collision = buildDeps();
    const collidingTool = { ...TOOL_ENTRY, capabilityId: "tool:browser.search.alias" };
    collision.deps.listCapabilityCatalog = vi.fn((scope) =>
      scope === "inspectable" ? [TOOL_ENTRY, collidingTool] : [TOOL_ENTRY, collidingTool],
    );
    await expect(resolveChatTurnCapabilityProfile(collision.deps, buildInput())).rejects.toThrow(/tool-name collision/);
  });

  it("fails closed when a callable skill lacks active, exact lifecycle provenance", async () => {
    const missing = buildDeps();
    missing.deps.storage.skillLifecycle.list = vi.fn(() => []);
    await expect(resolveChatTurnCapabilityProfile(missing.deps, buildInput())).rejects.toThrow(
      /missing an active trusted lifecycle binding/,
    );

    const inactive = buildDeps();
    const [inactiveRow] = inactive.deps.storage.skillLifecycle.list();
    inactive.deps.storage.skillLifecycle.list = vi.fn(() => [{ ...inactiveRow!, lifecycleState: "candidate" }]);
    await expect(resolveChatTurnCapabilityProfile(inactive.deps, buildInput())).rejects.toThrow(
      /missing an active trusted lifecycle binding/,
    );

    const drifted = buildDeps();
    const [driftedRow] = drifted.deps.storage.skillLifecycle.list();
    const driftedContentIntegrity = driftedRow?.provenance?.contentIntegrity;
    if (!driftedContentIntegrity) throw new Error("Expected a content-integrity fixture.");
    drifted.deps.storage.skillLifecycle.list = vi.fn(() => [
      {
        ...driftedRow!,
        provenance: {
          ...driftedRow!.provenance,
          contentIntegrity: {
            ...driftedContentIntegrity,
            verified: false,
          },
        },
      },
    ]);
    await expect(resolveChatTurnCapabilityProfile(drifted.deps, buildInput())).rejects.toThrow(
      /failed exact-byte integrity verification/,
    );

    const missingBytes = buildDeps();
    const [missingBytesRow] = missingBytes.deps.storage.skillLifecycle.list();
    missingBytes.deps.storage.skillLifecycle.list = vi.fn(() => [
      {
        ...missingBytesRow!,
        provenance: {
          ...missingBytesRow!.provenance,
          contentIntegrity: undefined,
        },
      },
    ]);
    await expect(resolveChatTurnCapabilityProfile(missingBytes.deps, buildInput())).rejects.toThrow(
      /failed exact-byte integrity verification/,
    );
  });

  it("changes the preflight fingerprint when the canonical callable set changes", async () => {
    const initial = buildDeps();
    const first = await resolveChatTurnCapabilityProfile(initial.deps, buildInput());
    const changed = buildDeps();
    const newSkill = {
      ...SKILL_ENTRY,
      capabilityId: "skill:newly-enabled",
      skillId: "newly-enabled",
      title: "Newly enabled",
    };
    changed.deps.listCapabilityCatalog = vi.fn((scope) =>
      scope === "inspectable"
        ? [TOOL_ENTRY, SKILL_ENTRY, newSkill, INSPECTABLE_ONLY]
        : [TOOL_ENTRY, SKILL_ENTRY, newSkill],
    );
    const [existingLifecycle] = changed.deps.storage.skillLifecycle.list();
    const existingContentIntegrity = existingLifecycle?.provenance?.contentIntegrity;
    if (!existingContentIntegrity) throw new Error("Expected a content-integrity fixture.");
    changed.deps.storage.skillLifecycle.list = vi.fn(() => [
      existingLifecycle!,
      {
        ...existingLifecycle!,
        skillId: "newly-enabled",
        provenance: {
          ...existingLifecycle!.provenance,
          sourceRef: "skill://newly-enabled",
          contentIntegrity: {
            ...existingContentIntegrity,
            treeSha256: "b".repeat(64),
          },
        },
      },
    ]);
    const second = await resolveChatTurnCapabilityProfile(changed.deps, buildInput());

    expect(second.profile.preflightFingerprint).not.toBe(first.profile.preflightFingerprint);
    expect(second.profile.catalog.callableHash).not.toBe(first.profile.catalog.callableHash);
  });

  it.each(["tool.call.before", "tool.call.after", "tool.call.error", "after_tool_call"] as const)(
    "freezes %s into the same effect-interposition binding and escalates a safe read",
    async (trigger) => {
      const { deps } = buildDeps();
      configureSafeRead(deps);
      const hook = hookRecord(trigger);
      deps.storage.workspaceHooks.listByTrigger = vi.fn((_workspaceId, listedTrigger) =>
        listedTrigger === trigger ? [hook] : [],
      );

      const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

      verifyChatTurnCapabilityProfile(resolution.profile);
      expect(resolution.profile.catalog).toMatchObject({
        runtimeInterpositionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        toolCallBeforeHookCount: 1,
      });
      expect(resolution.profile.selection.tools[0]).toMatchObject({
        canonicalName: "time.now",
        effectPotential: {
          potential: "unknown",
          sourceKind: "remote",
          reason: "remote_runtime_may_cross_boundary",
        },
      });
      expect(JSON.stringify(resolution.profile)).not.toContain("never-project-this-secret");
      expect(JSON.stringify(resolution.profile)).not.toContain(hook.action.webhook.url);
    },
  );

  it("changes the frozen binding when a hook action changes at the same timestamp", async () => {
    const first = buildDeps();
    configureSafeRead(first.deps);
    first.deps.storage.workspaceHooks.listByTrigger = vi.fn((_workspaceId, trigger) =>
      trigger === "tool.call.after" ? [hookRecord(trigger, "https://hooks.example.test/first")] : [],
    );
    const second = buildDeps();
    configureSafeRead(second.deps);
    second.deps.storage.workspaceHooks.listByTrigger = vi.fn((_workspaceId, trigger) =>
      trigger === "tool.call.after" ? [hookRecord(trigger, "https://hooks.example.test/second")] : [],
    );

    const firstResolution = await resolveChatTurnCapabilityProfile(first.deps, buildInput());
    const secondResolution = await resolveChatTurnCapabilityProfile(second.deps, buildInput());

    expect(secondResolution.profile.catalog.runtimeInterpositionHash).not.toBe(
      firstResolution.profile.catalog.runtimeInterpositionHash,
    );
    expect(secondResolution.profile.preflightFingerprint).not.toBe(firstResolution.profile.preflightFingerprint);
  });

  it("freezes an active plugin runtime owner and treats even a safe read as unknown", async () => {
    const { deps } = buildDeps();
    configureSafeRead(deps);
    const owner = buildToolRuntimeOwnerBinding("plugin", {
      pluginId: "plugin-clock",
      generation: 3,
      handlerHash: "a".repeat(64),
    });
    deps.resolveToolRuntimeOwnerBinding = vi.fn(() => owner);

    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

    expect(resolution.profile.selection.tools[0]).toMatchObject({
      canonicalName: "time.now",
      runtimeOwner: owner,
      effectPotential: {
        potential: "unknown",
        sourceKind: "plugin",
        reason: "plugin_runtime_untrusted",
      },
    });
  });

  it("freezes a secret-free requester-scoped MCP binding into the exact callable profile", async () => {
    const { deps } = buildDeps();
    const resolver = configureRequesterMcp(deps);

    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

    verifyChatTurnCapabilityProfile(resolution.profile);
    const binding = resolution.profile.selection.tools[0]?.mcpRequesterResolution;
    expect(binding).toMatchObject({
      mode: "requester_scoped",
      serverId: "tenant-mcp",
      toolName: "mcp.tenant-mcp.search",
      callableCatalogSnapshotId: resolution.profile.catalog.snapshotId,
      callableCatalogSha256: resolution.profile.catalog.callableHash,
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "chat-capability-profile-turn-1",
        authActorId: "operator-1",
        authActorSource: "token",
        requesterScopeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    );
    const serialized = JSON.stringify(resolution.profile);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("never-store-this");

    const tampered = structuredClone(resolution.profile);
    tampered.selection.tools[0]!.mcpRequesterResolution!.resolverConfigGeneration += 1;
    expect(() => verifyChatTurnCapabilityProfile(tampered)).toThrow(/requester binding hash is invalid/);
  });

  it("rejects requester-scoped MCP without authenticated requester authority", async () => {
    const { deps, policyContext } = buildDeps();
    configureRequesterMcp(deps);
    deps.resolveToolPolicyContext = vi.fn(() => ({
      ...policyContext,
      authActorId: undefined,
      authActorSource: "none",
    }));

    await expect(resolveChatTurnCapabilityProfile(deps, buildInput())).rejects.toThrow(
      /lacks authenticated requester authority/,
    );
  });

  it("does not invoke the requester-binding seam for non-MCP tools", async () => {
    const { deps } = buildDeps();
    const resolver = vi.fn(() => {
      throw new Error("non-MCP tools must not reach the requester-binding seam");
    });
    deps.resolveMcpRequesterResolutionBinding = resolver;

    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

    expect(resolution.profile.selection.tools[0]?.canonicalName).toBe("browser.search");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("copies and freezes an asynchronously returned binding before profile admission", async () => {
    const { deps } = buildDeps();
    const resolver = configureRequesterMcp(deps);
    const implementation = resolver.getMockImplementation()!;
    resolver.mockImplementation(async (input) => {
      await Promise.resolve();
      return implementation(input);
    });

    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());
    const issued = await resolver.mock.results[0]!.value;
    issued.resolverId = "mutated-after-resolution";

    const admitted = resolution.profile.selection.tools[0]!.mcpRequesterResolution!;
    expect(admitted.resolverId).toBe("gateway.tenant-mcp");
    expect(Object.isFrozen(admitted)).toBe(true);
    verifyChatTurnCapabilityProfile(resolution.profile);
  });
});

const MESH_CAPABILITY_ID = "mesh:node-a:tool:project.status";

const MESH_PROJECTION = {
  nodeId: "node-a",
  admissionGeneration: 1,
  publisherGeneration: 3,
  manifestSha256: "d".repeat(64),
  entrySha256: "e".repeat(64),
  localId: "project.status",
  capabilityKind: "tool" as const,
  status: "active" as const,
  reasons: ["activation_live"],
  effectPosture: "read_only" as const,
};

const MESH_TOOL_ENTRY: CapabilityCatalogEntry = {
  capabilityId: MESH_CAPABILITY_ID,
  kind: "mesh_tool",
  category: "mesh_published",
  title: "Project status",
  summary: "Mesh tool published by node node-a.",
  callable: true,
  trustLabel: "Mesh activated",
  mesh: MESH_PROJECTION,
};

const MESH_BINDING = {
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

function configureMeshTool(deps: ChatTurnCapabilityProfileResolveDeps) {
  deps.listCapabilityCatalog = vi.fn(() => [MESH_TOOL_ENTRY]);
  deps.resolveToolSchema = vi.fn(async () => ({
    tools: [
      {
        ...PROVIDER_TOOL,
        function: { ...PROVIDER_TOOL.function, name: "mesh_node_a_project_status" },
      },
    ],
    modelToCanonical: new Map([["mesh_node_a_project_status", MESH_CAPABILITY_ID]]),
    canonicalToModel: new Map([[MESH_CAPABILITY_ID, "mesh_node_a_project_status"]]),
    policyDecisions: [
      {
        toolName: MESH_CAPABILITY_ID,
        allowed: true,
        requiresApproval: true,
        reasonCodes: ["permission_profile_requires_approval"],
      },
    ],
  }));
  const resolver = vi.fn(() => ({ ...MESH_BINDING }));
  deps.resolveMeshPublicationBinding = resolver;
  return resolver;
}

describe("resolveChatTurnCapabilityProfile mesh publication binding", () => {
  it("freezes the packet's exact activation snapshot for a mesh-published callable", async () => {
    const { deps } = buildDeps();
    const resolver = configureMeshTool(deps);

    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());

    expect(resolver).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      capabilityId: MESH_CAPABILITY_ID,
      entrySha256: MESH_PROJECTION.entrySha256,
      manifestSha256: MESH_PROJECTION.manifestSha256,
      publisherGeneration: MESH_PROJECTION.publisherGeneration,
    });
    const tool = resolution.profile.selection.tools[0]!;
    expect(tool.canonicalName).toBe(MESH_CAPABILITY_ID);
    expect(tool.meshPublication).toEqual(MESH_BINDING);
    expect(Object.isFrozen(tool.meshPublication)).toBe(true);
    expect(tool.runtimeOwner?.kind).toBe("builtin");
    // Remote execution keeps the conservative recovery upper bound.
    expect(tool.effectPotential).toMatchObject({ potential: "unknown", sourceKind: "remote" });
    verifyChatTurnCapabilityProfile(resolution.profile);
  });

  it("fails the profile freeze closed when the activation no longer revalidates", async () => {
    const { deps } = buildDeps();
    const resolver = configureMeshTool(deps);
    resolver.mockImplementation(() => undefined as never);

    await expect(resolveChatTurnCapabilityProfile(deps, buildInput())).rejects.toThrow(/mesh_capability_freeze_drift/u);
  });

  it("fails the profile freeze closed when the freeze seam is not composed", async () => {
    const { deps } = buildDeps();
    configureMeshTool(deps);
    deps.resolveMeshPublicationBinding = undefined;

    await expect(resolveChatTurnCapabilityProfile(deps, buildInput())).rejects.toThrow(/mesh_capability_freeze_drift/u);
  });

  it("fails the profile freeze closed when the verified binding diverges from the exact catalog entry", async () => {
    const { deps } = buildDeps();
    const resolver = configureMeshTool(deps);
    resolver.mockImplementation(() => ({ ...MESH_BINDING, entrySha256: "9".repeat(64) }));

    await expect(resolveChatTurnCapabilityProfile(deps, buildInput())).rejects.toThrow(/mesh_capability_freeze_drift/u);
  });

  it("never treats a mesh skill descriptor as a trusted skill or callable tool", async () => {
    const { deps } = buildDeps();
    const meshSkillEntry: CapabilityCatalogEntry = {
      capabilityId: "mesh:node-a:skill:project.guide",
      kind: "mesh_skill",
      category: "mesh_published",
      title: "Project guide",
      summary: "Published skill descriptor.",
      callable: false,
      reviewWarning: "Inspectable only.",
      mesh: { ...MESH_PROJECTION, capabilityKind: "skill", status: "review_required", reasons: [] },
    };
    deps.listCapabilityCatalog = vi.fn((scope: "inspectable" | "callable") =>
      scope === "inspectable" ? [MESH_TOOL_ENTRY, meshSkillEntry] : [MESH_TOOL_ENTRY],
    );
    configureMeshTool(deps).mockImplementation(() => ({ ...MESH_BINDING }));
    deps.listCapabilityCatalog = vi.fn((scope: "inspectable" | "callable") =>
      scope === "inspectable" ? [MESH_TOOL_ENTRY, meshSkillEntry] : [MESH_TOOL_ENTRY],
    );

    const resolution = await resolveChatTurnCapabilityProfile(deps, buildInput());
    expect(resolution.profile.selection.trustedSkills).toEqual([]);
    expect(resolution.profile.selection.tools).toHaveLength(1);
    verifyChatTurnCapabilityProfile(resolution.profile);
  });
});
