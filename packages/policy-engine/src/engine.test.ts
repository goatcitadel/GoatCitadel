import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  PendingApprovalAction,
  PermissionProfileRecord,
  ToolInvokeRequest,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { HEARTBEAT_READ_ONLY_ALLOW, HEARTBEAT_RESTRICTED_PROFILE } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { ToolRegistry } from "./tool-registry.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function createStorageStub(): Storage & AsyncStorage {
  const findPendingApprovalAction = vi.fn(
    async (_approvalId?: string) => undefined as PendingApprovalAction | undefined,
  );
  const toolGrants = {
    list: vi.fn(
      async (_scope?: Parameters<Storage["toolGrants"]["list"]>[0], _scopeRef?: string, _limit?: number) =>
        [] as ReturnType<Storage["toolGrants"]["list"]>,
    ),
    listActive: vi.fn(async (scope: Parameters<Storage["toolGrants"]["list"]>[0], scopeRef?: string) =>
      (await toolGrants.list(scope, scopeRef, Number.MAX_SAFE_INTEGER))
        .filter((grant) => !grant.revokedAt)
        .filter((grant) => !grant.expiresAt || Date.parse(grant.expiresAt) > Date.now())
        .filter((grant) => typeof grant.usesRemaining !== "number" || grant.usesRemaining > 0),
    ),
    consumeOne: vi.fn(async () => true),
  };
  return {
    runImmediateTransaction: vi.fn(async <T>(work: () => T | Promise<T>): Promise<T> => await work()),
    approvals: {
      create: vi.fn(async (input) => ({
        approvalId: "approval-1",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-03-22T12:00:00.000Z",
        expiresAt: input.expiresAt ?? undefined,
        explanationStatus: "not_requested",
      })),
      createWithTtlDuration: vi.fn(async (input, ttlMs) => ({
        approvalId: "approval-1",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        explanationStatus: "not_requested",
      })),
      get: vi.fn(async (approvalId: string) => createApprovalRequest({ approvalId, status: "approved" })),
    },
    approvalEvents: {
      append: vi.fn(async () => undefined),
    },
    audit: {
      append: vi.fn(async () => undefined),
    },
    toolAccessDecisions: {
      record: vi.fn(async () => undefined),
      countToolCallsInLastHourInScope: vi.fn(async () => 0),
      countWritesInLastHourInScope: vi.fn(async () => 0),
    },
    toolGrants,
    pendingApprovalActions: {
      upsertPending: vi.fn(async () => undefined),
      find: findPendingApprovalAction,
      findFreshPending: vi.fn(async (approvalId: string, defaultTtlMs: number) => {
        const pending = await findPendingApprovalAction(approvalId);
        if (!pending || pending.resolutionStatus !== "pending") {
          return undefined;
        }
        const expiresAt = pending.expiresAt
          ? Date.parse(pending.expiresAt)
          : Date.parse(pending.createdAt) + defaultTtlMs;
        return Number.isFinite(expiresAt) && expiresAt > Date.now() ? pending : undefined;
      }),
      markResolved: vi.fn(async () => undefined),
    },
    db: {
      prepare: vi.fn(() => ({
        run: vi.fn(async () => undefined),
      })),
    },
  } as unknown as Storage & AsyncStorage;
}

function createApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "approval-1",
    kind: "tool",
    riskLevel: "caution",
    status: "approved",
    payload: {},
    preview: {},
    createdAt: "2026-03-21T00:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}

function createCustomAllowedRegistry(): ToolRegistry {
  return new ToolRegistry([
    {
      name: "custom.allowed",
      category: "ops",
      riskLevel: "safe",
      requiresApproval: false,
      description: "Registered custom test tool without an executor implementation.",
      pack: "core",
    },
  ]);
}

function createHeartbeatBoundaryRegistry(): ToolRegistry {
  return new ToolRegistry(
    [...HEARTBEAT_READ_ONLY_ALLOW, "browser.search", "synthetic.safe", "ordinary.safe"].map((name) => ({
      name,
      category: "ops" as const,
      riskLevel: "safe" as const,
      requiresApproval: false,
      description: `Registered policy-boundary test tool ${name}.`,
      pack: "core" as const,
      readOnly: true,
    })),
  );
}

const policyConfig: ToolPolicyConfig = {
  profiles: {
    danger: ["*"],
  },
  tools: {
    profile: "danger",
    approvalMode: "approve_risky",
    allow: [],
    deny: [],
  },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["localhost"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};
const host = (...parts: string[]): string => parts.join(".");
const EXAMPLE_HOST = host("example", "com");
const API_EXAMPLE_HOST = host("api", "example", "com");
const BLOCKED_EXAMPLE_HOST = host("blocked", "example");

describe("ToolPolicyEngine permission profile upper bound", () => {
  it("inspects policy without materializing a redundant access decision", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const request = {
      toolName: "time.now",
      agentId: "assistant",
      sessionId: "session-policy-inspection",
      args: {},
    };

    const inspected = await engine.inspectAccess(request);

    expect(storage.toolAccessDecisions.record).not.toHaveBeenCalled();
    const evaluated = await engine.evaluateAccess(request);
    expect(evaluated).toEqual(inspected);
    expect(storage.toolAccessDecisions.record).toHaveBeenCalledTimes(1);
    expect(storage.toolAccessDecisions.record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "time.now",
        sessionId: "session-policy-inspection",
        countsTowardLimits: false,
      }),
    );
  });

  it("executes the exact heartbeat read surface without materializing interactive approvals", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage, createHeartbeatBoundaryRegistry());

    for (const toolName of HEARTBEAT_READ_ONLY_ALLOW) {
      const result = await engine.invoke({
        toolName,
        args: {},
        agentId: "heartbeat",
        sessionId: "session-heartbeat",
        dryRun: true,
        policyContext: {
          permissionProfileId: HEARTBEAT_RESTRICTED_PROFILE.profileId,
          permissionProfile: HEARTBEAT_RESTRICTED_PROFILE,
        },
      });
      expect(result.outcome).toBe("executed");
    }

    expect(storage.approvals.create).not.toHaveBeenCalled();
    expect(storage.approvals.createWithTtlDuration).not.toHaveBeenCalled();
    expect(storage.pendingApprovalActions.upsertPending).not.toHaveBeenCalled();
    expect(storage.approvalEvents.append).not.toHaveBeenCalled();
  });

  it("blocks an exact heartbeat tool when a new Ward would otherwise create an interactive approval", async () => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "citadel-heartbeat"
            ? [
                {
                  wardId: "ward-heartbeat-review",
                  citadelId,
                  name: "Review heartbeat reads",
                  actionPattern: "time.now",
                  effect: "require_approval",
                  createdAt: "2026-07-15T00:00:00.000Z",
                },
              ]
            : [],
        ),
      },
    });
    const engine = new ToolPolicyEngine(policyConfig, storage, createHeartbeatBoundaryRegistry());

    const result = await engine.invoke({
      toolName: "time.now",
      args: {},
      agentId: "heartbeat",
      sessionId: "session-heartbeat",
      citadelId: "citadel-heartbeat",
      dryRun: true,
      policyContext: {
        permissionProfileId: HEARTBEAT_RESTRICTED_PROFILE.profileId,
        permissionProfile: HEARTBEAT_RESTRICTED_PROFILE,
      },
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      audit: {
        reasonCodes: expect.arrayContaining([
          "citadel_ward_requires_approval",
          "heartbeat_interactive_approval_forbidden",
        ]),
      },
    });
    expect(storage.toolAccessDecisions.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowed: false,
        requiresApproval: false,
        reasonCodes: expect.arrayContaining(["heartbeat_interactive_approval_forbidden"]),
      }),
    );
    expect(storage.approvals.create).not.toHaveBeenCalled();
    expect(storage.approvals.createWithTtlDuration).not.toHaveBeenCalled();
    expect(storage.pendingApprovalActions.upsertPending).not.toHaveBeenCalled();
    expect(storage.approvalEvents.append).not.toHaveBeenCalled();
  });

  it("keeps the heartbeat profile authoritative over broad config, agent allows, grants, and local override", async () => {
    const storage = createStorageStub();
    const allowAllGrant = {
      grantId: "grant-all",
      toolPattern: "*",
      decision: "allow",
      scope: "session",
      scopeRef: "session-heartbeat",
      grantType: "persistent",
      createdBy: "operator",
      createdAt: "2026-07-15T00:00:00.000Z",
    } as const;
    vi.mocked(storage.toolGrants.list).mockResolvedValue([allowAllGrant]);
    const config: ToolPolicyConfig = {
      ...policyConfig,
      tools: { ...policyConfig.tools, allow: ["*"] },
      agents: { heartbeat: { tools: { allow: ["*"] } } },
    };
    const engine = new ToolPolicyEngine(config, storage, createHeartbeatBoundaryRegistry());
    const localOperatorOverride = {
      overrideId: "override-heartbeat",
      label: "Cannot widen a profile",
      status: "active" as const,
      scope: "session" as const,
      scopeRef: "session-heartbeat",
      operatorId: "operator",
      reason: "Verify the active profile remains the upper bound.",
      createdBy: "operator",
      createdAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2999-07-15T00:00:00.000Z",
    };
    const evaluate = async (toolName: string) =>
      await engine.evaluateAccess({
        toolName,
        args: {},
        agentId: "heartbeat",
        sessionId: "session-heartbeat",
        policyContext: {
          permissionProfileId: HEARTBEAT_RESTRICTED_PROFILE.profileId,
          permissionProfile: HEARTBEAT_RESTRICTED_PROFILE,
          localOperatorOverrideId: localOperatorOverride.overrideId,
          localOperatorOverride,
        },
      });

    for (const toolName of HEARTBEAT_READ_ONLY_ALLOW) {
      await expect(evaluate(toolName)).resolves.toMatchObject({ allowed: true, requiresApproval: false });
    }
    for (const toolName of ["browser.search", "synthetic.safe"]) {
      await expect(evaluate(toolName)).resolves.toMatchObject({
        allowed: false,
        requiresApproval: false,
        reasonCodes: ["permission_profile_upper_bound"],
      });
    }
  });

  it("preserves scoped grants inside an ordinary profile without allowing them to escape it", async () => {
    const storage = createStorageStub();
    const allowAllGrant = {
      grantId: "grant-ordinary",
      toolPattern: "*",
      decision: "allow",
      scope: "session",
      scopeRef: "session-ordinary",
      grantType: "persistent",
      createdBy: "operator",
      createdAt: "2026-07-15T00:00:00.000Z",
    } as const;
    vi.mocked(storage.toolGrants.list).mockResolvedValue([allowAllGrant]);
    const profile = createPermissionProfile({ approvalMode: "approve_all", toolPatterns: ["ordinary.safe"] });
    const engine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, allow: ["*"] } },
      storage,
      createHeartbeatBoundaryRegistry(),
    );
    const evaluate = async (toolName: string) =>
      await engine.evaluateAccess({
        toolName,
        args: {},
        agentId: "ordinary",
        sessionId: "session-ordinary",
        policyContext: { permissionProfileId: profile.profileId, permissionProfile: profile },
      });

    await expect(evaluate("ordinary.safe")).resolves.toMatchObject({
      allowed: true,
      requiresApproval: false,
      matchedGrantId: "grant-ordinary",
    });
    await expect(evaluate("synthetic.safe")).resolves.toMatchObject({
      allowed: false,
      reasonCodes: ["permission_profile_upper_bound"],
    });
  });

  it("preserves additive global and scoped-grant semantics when no permission profile is active", async () => {
    const storage = createStorageStub();
    const allowGrant = {
      grantId: "grant-no-profile",
      toolPattern: "synthetic.safe",
      decision: "allow",
      scope: "session",
      scopeRef: "session-no-profile",
      grantType: "persistent",
      createdBy: "operator",
      createdAt: "2026-07-15T00:00:00.000Z",
    } as const;
    vi.mocked(storage.toolGrants.list).mockResolvedValue([allowGrant]);
    const engine = new ToolPolicyEngine(policyConfig, storage, createHeartbeatBoundaryRegistry());

    expect(
      await engine.evaluateAccess({
        toolName: "synthetic.safe",
        args: {},
        agentId: "ordinary",
        sessionId: "session-no-profile",
      }),
    ).toMatchObject({ allowed: true, requiresApproval: false, matchedGrantId: "grant-no-profile" });
  });
});

describe("ToolPolicyEngine grants", () => {
  it("passes grant list, create, and revoke operations through to storage", async () => {
    const storage = createStorageStub();
    const grant = {
      grantId: "grant-1",
      toolPattern: "fs.read",
      decision: "allow",
      scope: "session",
      scopeRef: "session",
      grantType: "persistent",
      createdBy: "test",
      createdAt: "2026-03-22T12:00:00.000Z",
    } as const;
    Object.assign(storage.toolGrants, {
      list: vi.fn(() => [grant]),
      create: vi.fn(() => grant),
      revoke: vi.fn(() => true),
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    expect(engine.listGrants("session", "session", 5)).toEqual([grant]);
    expect(engine.createGrant(grant)).toBe(grant);
    expect(engine.revokeGrant("grant-1", "operator-test")).toBe(true);
    expect(storage.toolGrants.list).toHaveBeenCalledWith("session", "session", 5);
    expect(storage.toolGrants.create).toHaveBeenCalledWith(grant);
    expect(storage.toolGrants.revoke).toHaveBeenCalledWith("grant-1", undefined, "operator-test");
  });

  it("uses active grant decision listing so older active denies still win", async () => {
    const storage = createStorageStub();
    const newerAllows = Array.from({ length: 500 }, (_, index) => ({
      grantId: `grant-allow-${index}`,
      toolPattern: "shell.exec",
      decision: "allow",
      scope: "session",
      scopeRef: "session",
      grantType: "persistent",
      createdBy: "test",
      createdAt: new Date(Date.UTC(2026, 2, 22, 12, 0, index + 1)).toISOString(),
    }));
    Object.assign(storage.toolGrants, {
      listActive: vi.fn(() => [
        ...newerAllows,
        {
          grantId: "grant-old-deny",
          toolPattern: "shell.exec",
          decision: "deny",
          scope: "session",
          scopeRef: "session",
          grantType: "persistent",
          createdBy: "test",
          createdAt: "2026-03-22T12:00:00.000Z",
        },
      ]),
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_deny"]);
    expect(evaluation.matchedGrantId).toBe("grant-old-deny");
  });

  it("uses uncapped fallback grant decision listing so older active denies still win", async () => {
    const storage = createStorageStub();
    const newerAllows = Array.from({ length: 500 }, (_, index) => ({
      grantId: `grant-allow-${index}`,
      toolPattern: "shell.exec",
      decision: "allow",
      scope: "session",
      scopeRef: "session",
      grantType: "persistent",
      createdBy: "test",
      createdAt: new Date(Date.UTC(2026, 2, 22, 12, 0, index + 1)).toISOString(),
    }));
    const grants = [
      ...newerAllows,
      {
        grantId: "grant-old-deny",
        toolPattern: "shell.exec",
        decision: "deny",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        createdBy: "test",
        createdAt: "2026-03-22T12:00:00.000Z",
      },
    ];
    Object.assign(storage.toolGrants, {
      list: vi.fn((scope: string, scopeRef: string, limit: number) =>
        scope === "session" && scopeRef === "session" ? grants.slice(0, limit) : [],
      ),
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_deny"]);
    expect(evaluation.matchedGrantId).toBe("grant-old-deny");
    expect(storage.toolGrants.list).toHaveBeenCalledWith("session", "session", Number.MAX_SAFE_INTEGER);
  });

  it("selects the first allow grant whose constraints match the request", async () => {
    const storage = createStorageStub();
    Object.assign(storage.toolGrants, {
      listActive: vi.fn(() => [
        {
          grantId: "grant-newer-other-host",
          toolPattern: "browser.navigate",
          decision: "allow",
          scope: "session",
          scopeRef: "session",
          grantType: "persistent",
          constraints: { allowedHosts: ["blocked.example"] },
          createdBy: "test",
          createdAt: "2026-03-22T12:01:00.000Z",
        },
        {
          grantId: "grant-older-matching-host",
          toolPattern: "browser.navigate",
          decision: "allow",
          scope: "session",
          scopeRef: "session",
          grantType: "persistent",
          constraints: { allowedHosts: [EXAMPLE_HOST] },
          createdBy: "test",
          createdAt: "2026-03-22T12:00:00.000Z",
        },
      ]),
    });
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        profiles: {
          minimal: [],
        },
        tools: {
          ...policyConfig.tools,
          profile: "minimal",
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST],
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "https://example.com/docs" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.matchedGrantId).toBe("grant-older-matching-host");
  });

  it("uses explicit allow grants to suppress repeat approval prompts for the granted tool", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation(async (scope, scopeRef) => {
      if (scope === "session" && scopeRef === "session") {
        return [
          {
            grantId: "grant-browser-search-session",
            toolPattern: "browser.search",
            decision: "allow",
            scope,
            scopeRef,
            grantType: "persistent",
            createdBy: "operator",
            createdAt: "2026-03-22T12:00:00.000Z",
          },
        ];
      }
      return [];
    });
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        profiles: {
          minimal: [],
        },
        tools: {
          ...policyConfig.tools,
          profile: "minimal",
          approvalMode: "approve_all",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["www.bing.com"],
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "browser.search",
      args: { query: "board game stores near 91303", engine: "google" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
    expect(evaluation.matchedGrantId).toBe("grant-browser-search-session");
    expect(evaluation.reasonCodes).not.toContain("approval_mode_all");
  });

  it("allows operator-enabled full public web access without opening private hosts", async () => {
    const engine = new ToolPolicyEngine(policyConfig, createStorageStub());

    expect(
      (
        await engine.evaluateAccess({
          toolName: "browser.navigate",
          args: { url: "https://example.com/docs" },
          agentId: "agent",
          sessionId: "session",
          policyContext: { fullWebAccess: true },
        })
      ).allowed,
    ).toBe(true);

    const privateEvaluation = await engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "http://127.0.0.1:3000" },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: true },
    });

    expect(privateEvaluation.allowed).toBe(false);
    expect(privateEvaluation.reasonCodes).toContain("structural_safety_block");
  });
});

describe("ToolPolicyEngine citadel scope", () => {
  it("honors a citadel-scoped deny grant when the request carries a citadelId", async () => {
    const storage = createStorageStub();
    Object.assign(storage.toolGrants, {
      listActive: vi.fn((scope: string, scopeRef: string) =>
        scope === "citadel" && scopeRef === "c1"
          ? [
              {
                grantId: "citadel-deny",
                toolPattern: "shell.exec",
                decision: "deny",
                scope: "citadel",
                scopeRef: "c1",
                grantType: "persistent",
                createdBy: "test",
                createdAt: "2026-03-22T12:00:00.000Z",
              },
            ]
          : [],
      ),
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_deny"]);
    expect(evaluation.matchedGrantId).toBe("citadel-deny");
  });

  it("does not consult citadel/chamber scope when the request carries no citadelId (dormant by default)", async () => {
    const storage = createStorageStub();
    const listActive = vi.fn((_scope: string, _scopeRef: string) => [] as unknown[]);
    Object.assign(storage.toolGrants, { listActive });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
    });

    const scopesQueried = listActive.mock.calls.map((call) => call[0]);
    expect(scopesQueried).not.toContain("citadel");
    expect(scopesQueried).not.toContain("chamber");
  });

  it("denies a tool when a Citadel Ward matches with deny (engine consults the Wards table)", async () => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "c1"
            ? [
                {
                  wardId: "w1",
                  citadelId: "c1",
                  name: "No shell",
                  actionPattern: "shell.*",
                  effect: "deny",
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hi" },
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("citadel_ward_deny");
  });

  it("keeps Citadel Ward approval requirements stronger than workspace allow grants", async () => {
    const storage = createStorageStub();
    const workspaceGrant = {
      grantId: "workspace-shell-allow",
      toolPattern: "shell.exec",
      decision: "allow",
      scope: "workspace",
      scopeRef: "engineering",
      grantType: "persistent",
      createdBy: "test",
      createdAt: "2026-03-22T12:00:00.000Z",
    } as const;
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "company"
            ? [
                {
                  wardId: "ward-shell-review",
                  citadelId: "company",
                  name: "Review shell",
                  actionPattern: "shell.*",
                  effect: "require_approval",
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    Object.assign(storage.toolGrants, {
      listActive: vi.fn((scope: string, scopeRef: string) =>
        scope === "workspace" && scopeRef === "engineering" ? [workspaceGrant] : [],
      ),
    });
    const engine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, approvalMode: "bypass" } },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hi" },
      agentId: "agent",
      sessionId: "session",
      citadelId: "company",
      workspaceId: "engineering",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.matchedGrantId).toBe("workspace-shell-allow");
    expect(evaluation.reasonCodes).toContain("citadel_ward_requires_approval");
  });

  it("surfaces the matched redact Ward effect on the ToolInvokeResult so downstream execution can scrub output", async () => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "company"
            ? [
                {
                  wardId: "ward-redact-session",
                  citadelId: "company",
                  name: "Redact session output",
                  actionPattern: "session.*",
                  effect: "redact",
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    const engine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, approvalMode: "bypass" } },
      storage,
    );

    // dryRun keeps this off the real executor while still exercising the post-ward
    // "executed" return path, which is where the surfaced wardEffect must appear.
    const result = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session",
      citadelId: "company",
      dryRun: true,
    });

    expect(result.outcome).toBe("executed");
    expect(result.wardEffect).toBe("redact");
  });

  it("leaves wardEffect undefined on the ToolInvokeResult when no Ward matches (regression)", async () => {
    const storage = createStorageStub();
    Object.assign(storage, { citadels: { listWards: vi.fn(() => []) } });
    const engine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, approvalMode: "bypass" } },
      storage,
    );

    const result = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session",
      citadelId: "company",
      dryRun: true,
    });

    expect(result.outcome).toBe("executed");
    expect(result.wardEffect).toBeUndefined();
  });

  it("keeps Citadel Ward approval requirements stronger than Code Mode preapproval", async () => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "company"
            ? [
                {
                  wardId: "ward-session-review",
                  citadelId: "company",
                  name: "Review session status",
                  actionPattern: "session.*",
                  effect: "require_approval",
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    const engine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, approvalMode: "approve_all" } },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "session.status",
      args: {},
      agentId: "code-mode:run-1",
      sessionId: "session",
      citadelId: "company",
      policyContext: {
        approvedCodeModeRunId: "run-1",
      },
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("approved_code_mode_run");
    expect(evaluation.reasonCodes).toContain("citadel_ward_requires_approval");
  });

  it("does not consult Citadel Wards when the request carries no citadelId", async () => {
    const storage = createStorageStub();
    const listWards = vi.fn(() => []);
    Object.assign(storage, { citadels: { listWards } });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hi" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(listWards).not.toHaveBeenCalled();
  });

  it("never treats workspaceId as a Citadel fallback (Wards stay unconsulted when only workspaceId is present)", async () => {
    // A request carrying a workspaceId but no citadelId is unscoped for Ward
    // purposes: Wards key on the real citadelId, never the workspaceId. The
    // gateway resolves the parent citadelId before invoke, so the engine never
    // has to guess one from the workspace.
    const storage = createStorageStub();
    const listWards = vi.fn(() => []);
    Object.assign(storage, { citadels: { listWards } });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hi" },
      agentId: "agent",
      sessionId: "session",
      workspaceId: "ws-1",
    });

    expect(listWards).not.toHaveBeenCalled();
  });

  // --- Review Finding 2 / slice 3.1a: surface the matched Ward effect on the
  // runtime result and audit the previously-silent effects via reason codes. ---
  const wardStorageFor = (effect: "require_dry_run" | "route_local" | "redact"): Storage & AsyncStorage => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "c1"
            ? [
                {
                  wardId: `w-${effect}`,
                  citadelId: "c1",
                  name: `Ward ${effect}`,
                  actionPattern: "custom.*",
                  effect,
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    return storage;
  };

  const recordedReasonCodesFor = (storage: Storage & AsyncStorage): string[] | undefined =>
    vi
      .mocked(storage.toolAccessDecisions.record)
      .mock.calls.find(([decision]) => decision.toolName === "custom.allowed")?.[0].reasonCodes;

  it("surfaces a require_dry_run Ward effect on the result and records citadel_ward_require_dry_run", async () => {
    const storage = wardStorageFor("require_dry_run");
    const engine = new ToolPolicyEngine(policyConfig, storage, createCustomAllowedRegistry());

    const evaluation = await engine.evaluateAccess({
      toolName: "custom.allowed",
      args: {},
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.wardEffect).toBe("require_dry_run");
    expect(evaluation.reasonCodes).toContain("citadel_ward_require_dry_run");
    expect(recordedReasonCodesFor(storage)).toContain("citadel_ward_require_dry_run");
  });

  it("surfaces a route_local Ward effect on the result without silently dropping it", async () => {
    const storage = wardStorageFor("route_local");
    const engine = new ToolPolicyEngine(policyConfig, storage, createCustomAllowedRegistry());

    const evaluation = await engine.evaluateAccess({
      toolName: "custom.allowed",
      args: {},
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.wardEffect).toBe("route_local");
    expect(evaluation.reasonCodes).toContain("citadel_ward_route_local");
    expect(recordedReasonCodesFor(storage)).toContain("citadel_ward_route_local");
  });

  it("surfaces a redact Ward effect on the result without silently dropping it", async () => {
    const storage = wardStorageFor("redact");
    const engine = new ToolPolicyEngine(policyConfig, storage, createCustomAllowedRegistry());

    const evaluation = await engine.evaluateAccess({
      toolName: "custom.allowed",
      args: {},
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.wardEffect).toBe("redact");
    expect(evaluation.reasonCodes).toContain("citadel_ward_redact");
    expect(recordedReasonCodesFor(storage)).toContain("citadel_ward_redact");
  });

  it("leaves a non-warded request with no wardEffect and no citadel_ward_* reason code", async () => {
    const storage = createStorageStub();
    const listWards = vi.fn(() => []);
    Object.assign(storage, { citadels: { listWards } });
    const engine = new ToolPolicyEngine(policyConfig, storage, createCustomAllowedRegistry());

    const evaluation = await engine.evaluateAccess({
      toolName: "custom.allowed",
      args: {},
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.wardEffect).toBeUndefined();
    expect(evaluation.reasonCodes.some((code) => code.startsWith("citadel_ward_"))).toBe(false);
    expect((recordedReasonCodesFor(storage) ?? []).some((code) => code.startsWith("citadel_ward_"))).toBe(false);
  });

  it("carries wardEffect on a deny-by-Ward result while preserving the existing deny behavior", async () => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "c1"
            ? [
                {
                  wardId: "w-deny",
                  citadelId: "c1",
                  name: "No shell",
                  actionPattern: "shell.*",
                  effect: "deny",
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hi" },
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("citadel_ward_deny");
    expect(evaluation.wardEffect).toBe("deny");
  });

  it("keeps require_approval Wards emitting citadel_ward_requires_approval and no silent-effect code", async () => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "c1"
            ? [
                {
                  wardId: "w-approve",
                  citadelId: "c1",
                  name: "Review shell",
                  actionPattern: "shell.*",
                  effect: "require_approval",
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hi" },
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("citadel_ward_requires_approval");
    expect(evaluation.reasonCodes).not.toContain("citadel_ward_require_approval");
    expect(evaluation.wardEffect).toBe("require_approval");
  });
});

describe("ToolPolicyEngine invocation coverage", () => {
  it("blocks an invoke whose resolved Citadel has a matching deny Ward (enforcement on the invoke path)", async () => {
    const storage = createStorageStub();
    Object.assign(storage, {
      citadels: {
        listWards: vi.fn((citadelId: string) =>
          citadelId === "c1"
            ? [
                {
                  wardId: "w1",
                  citadelId: "c1",
                  name: "No shell",
                  actionPattern: "shell.*",
                  effect: "deny",
                  createdAt: "t",
                },
              ]
            : [],
        ),
      },
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const result = await engine.invoke({
      toolName: "shell.exec",
      args: { command: "echo hi" },
      agentId: "agent",
      sessionId: "session",
      citadelId: "c1",
      dryRun: true,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain("denied by a Citadel Ward");
    const recordedDecision = vi
      .mocked(storage.toolAccessDecisions.record)
      .mock.calls.find(([decision]) => decision.toolName === "shell.exec")?.[0];
    expect(recordedDecision?.reasonCodes).toContain("citadel_ward_deny");
  });

  it("leaves an invoke resolving to a no-Ward Citadel (e.g. the default 'personal') unaffected", async () => {
    const storage = createStorageStub();
    const listWards = vi.fn((citadelId: string) =>
      citadelId === "c1"
        ? [
            {
              wardId: "w1",
              citadelId: "c1",
              name: "No shell",
              actionPattern: "shell.*",
              effect: "deny" as const,
              createdAt: "t",
            },
          ]
        : [],
    );
    Object.assign(storage, { citadels: { listWards } });
    const engine = new ToolPolicyEngine(policyConfig, storage, createCustomAllowedRegistry());

    const result = await engine.invoke({
      toolName: "custom.allowed",
      args: {},
      agentId: "agent",
      sessionId: "session",
      citadelId: "personal",
      dryRun: true,
    });

    // The default 'personal' Citadel has no Wards, so a request resolving to it
    // behaves exactly as before: the Wards table is consulted but yields nothing,
    // and the tool is not blocked by Ward enforcement.
    expect(listWards).toHaveBeenCalledWith("personal");
    expect(result.outcome).toBe("executed");
    const recordedDecision = vi
      .mocked(storage.toolAccessDecisions.record)
      .mock.calls.find(([decision]) => decision.toolName === "custom.allowed")?.[0];
    expect(recordedDecision?.reasonCodes ?? []).not.toContain("citadel_ward_deny");
  });

  it("lets approved Code Mode wrapper calls skip prompts without widening profile access", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const permissionProfile = createPermissionProfile({
      approvalMode: "approve_all",
      toolPatterns: ["session.status"],
    });

    const allowed = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "code-mode:run-1",
      sessionId: "session",
      dryRun: true,
      policyContext: {
        permissionProfileId: permissionProfile.profileId,
        permissionProfile,
        localOperatorOverrideId: "expired-override-id",
        approvedCodeModeRunId: "run-1",
      },
    });
    const blocked = await engine.invoke({
      toolName: "memory.read",
      args: {},
      agentId: "code-mode:run-1",
      sessionId: "session",
      dryRun: true,
      policyContext: {
        permissionProfileId: permissionProfile.profileId,
        permissionProfile,
        localOperatorOverrideId: "expired-override-id",
        approvedCodeModeRunId: "run-1",
      },
    });

    expect(allowed.outcome).toBe("executed");
    expect(allowed.policyReason).toContain("allowed by approved Code Mode run");
    const recordedDecision = vi
      .mocked(storage.toolAccessDecisions.record)
      .mock.calls.find(([decision]) => decision.toolName === "session.status")?.[0];
    expect(recordedDecision?.localOperatorOverrideId).toBeUndefined();
    expect(allowed.policyReason).not.toContain("Local Operator Override");
    expect(blocked).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: tool not available in resolved policy",
    });
  });

  it("routes direct approved invocations through one-shot pending action execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      const permissionProfile = createPermissionProfile({
        approvalMode: "approve_all",
        toolPatterns: ["session.status"],
      });
      const storedRequest: ToolInvokeRequest = {
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
        policyContext: {
          permissionProfileId: permissionProfile.profileId,
          permissionProfile,
        },
      };
      let pending = createPendingApprovalAction({
        approvalId: "apr-direct",
        expiresAt: "2026-03-21T00:10:00.000Z",
        request: storedRequest as unknown as Record<string, unknown>,
      });
      vi.mocked(storage.pendingApprovalActions.find).mockImplementation(async (approvalId: string) =>
        approvalId === "apr-direct" ? pending : undefined,
      );
      vi.mocked(storage.pendingApprovalActions.markResolved).mockImplementation(
        async (approvalId, resolutionStatus, result) => {
          expect(approvalId).toBe("apr-direct");
          pending = {
            ...pending,
            resolutionStatus,
            resolvedAt: new Date().toISOString(),
            result,
          };
          return pending;
        },
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);
      const directRequest: ToolInvokeRequest = {
        ...storedRequest,
        consentContext: {
          source: "ui",
          reason: "approval:apr-direct",
        },
      };

      const first = await engine.invoke(directRequest);
      const second = await engine.invoke(directRequest);

      expect(first).toMatchObject({
        outcome: "executed",
        policyReason: "allowed_via_approval:apr-direct",
        result: {
          sessionId: "session",
          status: "unavailable",
        },
      });
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
        "apr-direct",
        "executed",
        expect.objectContaining({
          outcome: "executed",
        }),
      );
      expect(second.outcome).toBe("approval_required");
      expect(second.policyReason).toBe("approval required by approval mode");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers direct approved external-runtime invocations to the runtime caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      const storedRequest: ToolInvokeRequest = {
        toolName: "mcp.invoke",
        args: { serverId: "srv-1", toolName: "tool.echo", arguments: { value: "hello" } },
        agentId: "agent",
        sessionId: "session",
        externalRuntime: true,
      };
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-direct-external",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: storedRequest as unknown as Record<string, unknown>,
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);

      const result = await engine.invoke({
        ...storedRequest,
        consentContext: {
          source: "ui",
          reason: "approval:apr-direct-external",
        },
      });

      expect(result).toMatchObject({
        outcome: "executed",
        policyReason: "allowed_via_approval:apr-direct-external",
        result: {
          externalRuntime: true,
          toolName: "mcp.invoke",
        },
      });
      expect(storage.pendingApprovalActions.markResolved).not.toHaveBeenCalled();
      expect(storage.approvalEvents.append).not.toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "apr-direct-external",
          eventType: "approved_action_executed",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a dry-run execution result without calling the tool executor", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const result = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(result).toMatchObject({
      outcome: "executed",
      result: {
        dryRun: true,
        toolName: "session.status",
      },
    });
    expect(result.internalResult).toMatchObject({
      outcome: "executed",
      result: {
        dryRun: true,
      },
    });
    expect(storage.toolAccessDecisions.record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "session.status",
        countsTowardLimits: false,
      }),
    );
  });

  it("records execution errors from tools that pass policy but fail at runtime", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["localhost"],
        },
      },
      storage,
      createCustomAllowedRegistry(),
    );

    const result = await engine.invoke({
      toolName: "custom.allowed",
      args: {},
      agentId: "agent",
      sessionId: "session",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain("Unsupported tool executor: custom.allowed");
    expect(result.internalResult).toMatchObject({
      outcome: "blocked",
      errorKind: "execution_error",
    });
  });

  it("reports an ambiguous HTTP mutation as executed with manual-reconciliation truth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://other.example/created" },
          }),
      ),
    );
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: { ...policyConfig.tools, approvalMode: "bypass" },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST, "other.example"],
        },
      },
      storage,
    );

    const result = await engine.invoke({
      toolName: "http.post",
      args: { url: "https://example.com/api", body: { action: "create" } },
      agentId: "agent",
      sessionId: "session-http-post-unknown",
    });

    expect(result).toMatchObject({
      outcome: "executed",
      policyReason: expect.stringContaining("execution outcome unknown"),
      result: {
        status: "failed",
        deliveryStatus: "manual_reconciliation_required",
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
      },
      internalResult: {
        outcome: "executed",
        result: expect.objectContaining({ externalOutcome: "unknown_after_send" }),
      },
    });
  });

  it("includes target and shell command details in approval previews", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST],
        },
      },
      storage,
    );

    await engine.invoke({
      toolName: "http.post",
      args: { url: "https://example.com/api", body: { query: "status" } },
      agentId: "agent",
      sessionId: "session",
      taskId: "task-http",
    });
    await engine.invoke({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
      taskId: "task-shell",
    });

    expect(storage.approvals.createWithTtlDuration).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          target: "https://example.com/api",
        }),
      }),
      15 * 60_000,
    );
    expect(storage.approvals.createWithTtlDuration).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          command: "echo hello",
        }),
      }),
      15 * 60_000,
    );
  });
});

describe("ToolPolicyEngine approval bypass safety", () => {
  it("still bypasses ordinary danger approvals when policy explicitly allows bypass mode", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "fs.write",
      args: {
        path: "./workspace/output.txt",
        content: "ok",
      },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.riskLevel).toBe("danger");
    expect(evaluation.requiresApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("approval_bypass_mode");
  });

  it("keeps outside-root reads approval-gated even when normal approvals are bypassed", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "fs.list",
      args: { path: "C:/Users/spurn/Desktop/Chrome Downloads" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("approval_bypass_mode");
    expect(evaluation.reasonCodes).toContain("outside_roots_read_requires_approval");
  });
});

describe("ToolPolicyEngine policy edge coverage", () => {
  it("reports explicit policy denies, unknown tools, and profile disallows", async () => {
    const denyStorage = createStorageStub();
    const denyEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          deny: ["session.status"],
        },
      },
      denyStorage,
    );

    expect(
      (
        await denyEngine.evaluateAccess({
          toolName: "session.status",
          args: {},
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["policy_deny"]);

    const emptyProfileConfig: ToolPolicyConfig = {
      ...policyConfig,
      profiles: {
        minimal: [],
      },
      tools: {
        ...policyConfig.tools,
        profile: "minimal",
        allow: [],
        deny: [],
      },
    };
    const unknownEngine = new ToolPolicyEngine(emptyProfileConfig, createStorageStub());
    expect(
      (
        await unknownEngine.evaluateAccess({
          toolName: "custom.unknown",
          args: {},
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["unknown_tool"]);

    const wildcardConfig: ToolPolicyConfig = {
      ...policyConfig,
      profiles: {
        danger: ["*"],
      },
      tools: {
        ...policyConfig.tools,
        profile: "danger",
        allow: ["*"],
        deny: [],
        approvalMode: "bypass",
      },
    };
    const wildcardEngine = new ToolPolicyEngine(wildcardConfig, createStorageStub());
    expect(
      (
        await wildcardEngine.evaluateAccess({
          toolName: "custom.unknown",
          args: {},
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["unknown_tool"]);

    expect(
      (
        await wildcardEngine.evaluateAccess({
          toolName: "custom.unknown",
          args: {},
          agentId: "agent",
          sessionId: "session",
          policyContext: {
            localOperatorOverrideId: "override-active",
            localOperatorOverride: {
              overrideId: "override-active",
              operatorId: "operator",
              scope: "operator",
              reason: "test active override unknown tool fail closed",
              status: "active",
              createdBy: "operator",
              createdAt: "2026-05-18T00:00:00.000Z",
              expiresAt: "2999-01-01T00:00:00.000Z",
            },
          },
        })
      ).reasonCodes,
    ).toEqual(["unknown_tool"]);

    const disallowEngine = new ToolPolicyEngine(emptyProfileConfig, createStorageStub());
    expect(
      (
        await disallowEngine.evaluateAccess({
          toolName: "session.status",
          args: {},
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["policy_disallow"]);
  });

  it("marks approve-all, nuclear, and risky shell requests for approval", async () => {
    const approveAllEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "approve_all",
        },
      },
      createStorageStub(),
    );
    expect(
      (
        await approveAllEngine.evaluateAccess({
          toolName: "session.status",
          args: {},
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toContain("approval_mode_all");

    const shellEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          riskyShellPatterns: ["rm -rf"],
        },
      },
      createStorageStub(),
    );
    expect(
      (
        await shellEngine.evaluateAccess({
          toolName: "shell.exec",
          args: { command: "rm -rf ./workspace/tmp" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toContain("shell_risky_requires_approval");

    const shellGlobEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          riskyShellPatterns: ["git clean *"],
        },
      },
      createStorageStub(),
    );
    const globEvaluation = await shellGlobEngine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "git clean -xfd ./workspace/tmp" },
      agentId: "agent",
      sessionId: "session",
    });
    expect(globEvaluation.requiresApproval).toBe(true);
    expect(globEvaluation.reasonCodes).toContain("shell_risky_requires_approval");

    // Generalized destructive-argument gate: a matching argument forces approval even
    // under a bypass approval mode (mirrors the shell-risk gate for arbitrary tools).
    const argEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: { ...policyConfig.tools, approvalMode: "bypass" },
        sandbox: {
          ...policyConfig.sandbox,
          riskyArgumentPatterns: [
            { toolNamePattern: "*", argumentPath: "command", valuePatterns: ["terraform destroy"] },
          ],
        },
      },
      createStorageStub(),
    );
    const argEvaluation = await argEngine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "terraform destroy --auto-approve" },
      agentId: "agent",
      sessionId: "session",
    });
    expect(argEvaluation.requiresApproval).toBe(true);
    expect(argEvaluation.reasonCodes).toContain("argument_risky_requires_approval");

    expect(
      (
        await shellEngine.evaluateAccess({
          toolName: "shell.exec",
          args: { command: "   " },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);
  });

  it("filters inactive grants before selecting the active scoped fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.toolGrants.list).mockImplementation(async (scope, scopeRef) => {
        if (scope === "session" && scopeRef === "session") {
          return [
            {
              grantId: "grant-revoked",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              revokedAt: "2026-03-21T00:00:00.000Z",
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
            {
              grantId: "grant-expired",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              expiresAt: "2026-03-21T00:01:00.000Z",
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
            {
              grantId: "grant-depleted",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              usesRemaining: 0,
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
          ];
        }
        if (scope === "global" && scopeRef === "global") {
          return [
            {
              grantId: "grant-global-active",
              toolPattern: "session.status",
              decision: "allow",
              scope,
              scopeRef,
              grantType: "persistent",
              createdBy: "test",
              createdAt: "2026-03-21T00:00:00.000Z",
            },
          ];
        }
        return [];
      });
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          profiles: {
            minimal: [],
          },
          tools: {
            ...policyConfig.tools,
            profile: "minimal",
          },
        },
        storage,
      );

      const evaluation = await engine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      });

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.matchedGrantId).toBe("grant-global-active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies read-path and grant candidate extraction edge cases", async () => {
    const docsEngine = new ToolPolicyEngine(policyConfig, createStorageStub());
    expect(
      (
        await docsEngine.evaluateAccess({
          toolName: "docs.ingest",
          args: { sourceType: "file", source: "F:/outside/project/spec.md", namespace: "docs" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      (
        await docsEngine.evaluateAccess({
          toolName: "fs.copy",
          args: { from: "F:/outside/project/spec.md", to: "./workspace/spec.md" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      (
        await docsEngine.evaluateAccess({
          toolName: "fs.copy",
          args: { from: "./workspace/spec.md", to: "F:/outside/project/spec.md" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      (
        await docsEngine.evaluateAccess({
          toolName: "fs.move",
          args: { from: "F:/outside/project/spec.md", to: "./workspace/spec.md" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      (
        await docsEngine.evaluateAccess({
          toolName: "browser.screenshot",
          args: { url: "http://localhost/app", outputPath: "F:/outside/project/shot.png" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      (
        await docsEngine.evaluateAccess({
          toolName: "browser.interact",
          args: {
            url: "http://localhost/app",
            outputPath: "F:/outside/project/interact.json",
            steps: [{ action: "click", selector: "button" }],
          },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["structural_safety_block"]);

    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-custom",
        toolPattern: "http.get",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          allowedHosts: [EXAMPLE_HOST],
          allowedPaths: ["./workspace"],
          referenceRoots: [
            {
              label: "ref",
              rootPath: "./reference",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const grantEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        profiles: {
          minimal: [],
        },
        tools: {
          ...policyConfig.tools,
          profile: "minimal",
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST],
        },
      },
      storage,
    );

    expect(
      // A real target on the grant's allowed host: structural safety passes and
      // the grant (allowedHosts + referenceRoots) resolves to allow. (An empty
      // http.get now fails structural safety for lacking a target.)
      (
        await grantEngine.evaluateAccess({
          toolName: "http.get",
          args: { url: `http://${EXAMPLE_HOST}/data` },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);
  });

  it("extracts outbound hosts for bypass-mode dry runs without auditing allowlisted targets", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST, "127.0.0.1:3002"],
        },
      },
      storage,
    );

    await engine.invoke({
      toolName: "http.get",
      args: { host: EXAMPLE_HOST },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    await engine.invoke({
      toolName: "docs.ingest",
      args: {
        sourceType: "url",
        source: "https://example.com/doc",
        namespace: "research",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3002",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    await engine.invoke({
      toolName: "browser.navigate",
      args: { url: "https://example.com/page" },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(storage.audit.append).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );
  });

  it("covers read modes, grant consumption, and host constraint variants", async () => {
    const rootsEngine = new ToolPolicyEngine(policyConfig, createStorageStub());
    expect(
      (
        await rootsEngine.evaluateAccess({
          toolName: "fs.read",
          args: { path: "./workspace/note.txt" },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);

    const fullDiskEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "full_disk",
        },
      },
      createStorageStub(),
    );
    expect(
      (
        await fullDiskEngine.evaluateAccess({
          toolName: "fs.read",
          args: { path: "F:/outside/note.txt" },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);

    const consumeStorage = createStorageStub();
    Object.assign(consumeStorage.toolGrants, {
      list: vi.fn(() => [
        {
          grantId: "grant-consume",
          toolPattern: "session.status",
          decision: "allow",
          scope: "session",
          scopeRef: "session",
          grantType: "temporary",
          usesRemaining: 1,
          createdBy: "test",
          createdAt: new Date().toISOString(),
        },
      ]),
      consumeOne: vi.fn(() => true),
    });
    const consumeEngine = new ToolPolicyEngine(policyConfig, consumeStorage);
    await consumeEngine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session",
    });
    expect(consumeStorage.toolGrants.consumeOne).toHaveBeenCalledWith("grant-consume");

    const externalRuntimeStorage = createStorageStub();
    Object.assign(externalRuntimeStorage.toolGrants, {
      list: vi.fn(() => [
        {
          grantId: "grant-external-runtime",
          toolPattern: "session.status",
          decision: "allow",
          scope: "session",
          scopeRef: "session",
          grantType: "one_time",
          usesRemaining: 1,
          createdBy: "test",
          createdAt: new Date().toISOString(),
        },
      ]),
      consumeOne: vi.fn(() => true),
    });
    const externalRuntimeEngine = new ToolPolicyEngine(policyConfig, externalRuntimeStorage);
    await expect(
      externalRuntimeEngine.invoke({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
        externalRuntime: true,
      }),
    ).resolves.toMatchObject({
      outcome: "executed",
      result: { externalRuntime: true, toolName: "session.status" },
    });
    expect(externalRuntimeStorage.toolGrants.consumeOne).toHaveBeenCalledWith("grant-external-runtime");
    expect(externalRuntimeStorage.toolAccessDecisions.record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "session.status",
        countsTowardLimits: true,
      }),
    );

    const spentGrantStorage = createStorageStub();
    Object.assign(spentGrantStorage.toolGrants, {
      list: vi.fn(() => [
        {
          grantId: "grant-spent-before-execute",
          toolPattern: "session.status",
          decision: "allow",
          scope: "session",
          scopeRef: "session",
          grantType: "one_time",
          usesRemaining: 1,
          createdBy: "test",
          createdAt: new Date().toISOString(),
        },
      ]),
      consumeOne: vi.fn(() => false),
    });
    const spentGrantEngine = new ToolPolicyEngine(policyConfig, spentGrantStorage);
    await expect(
      spentGrantEngine.invoke({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }),
    ).resolves.toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: one-time tool grant is no longer available",
    });
    expect(spentGrantStorage.audit.append).toHaveBeenCalledWith(
      "policy_blocks",
      expect.objectContaining({
        reason: "blocked: one-time tool grant is no longer available",
        details: expect.objectContaining({
          matchedGrantId: "grant-spent-before-execute",
        }),
      }),
    );

    const hostStorage = createStorageStub();
    const hostGrant = {
      grantId: "grant-host",
      toolPattern: "http.get",
      decision: "allow",
      scope: "session",
      scopeRef: "session",
      grantType: "persistent",
      createdBy: "test",
      createdAt: new Date().toISOString(),
    } as const;
    const hostEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [API_EXAMPLE_HOST],
        },
      },
      hostStorage,
    );

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([{ ...hostGrant, constraints: { allowedHosts: [""] } }]);
    expect(
      (
        await hostEngine.evaluateAccess({
          toolName: "http.get",
          args: { host: API_EXAMPLE_HOST },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([{ ...hostGrant, constraints: { allowedHosts: ["*"] } }]);
    expect(
      (
        await hostEngine.evaluateAccess({
          toolName: "http.get",
          args: { host: API_EXAMPLE_HOST },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([
      { ...hostGrant, constraints: { allowedHosts: [API_EXAMPLE_HOST] } },
    ]);
    expect(
      (
        await hostEngine.evaluateAccess({
          toolName: "http.get",
          args: { host: API_EXAMPLE_HOST },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([
      {
        ...hostGrant,
        grantId: "grant-browser-storage-host",
        toolPattern: "browser.storage.set",
        constraints: { allowedHosts: ["allowed.example"] },
      },
    ]);
    expect(
      (
        await hostEngine.evaluateAccess({
          toolName: "browser.storage.set",
          args: { origin: "https://blocked.example" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([
      {
        ...hostGrant,
        grantId: "grant-browser-cookie-host",
        toolPattern: "browser.cookies.set",
        constraints: { allowedHosts: ["allowed.example"] },
      },
    ]);
    expect(
      (
        await hostEngine.evaluateAccess({
          toolName: "browser.cookies.set",
          args: { cookies: [{ name: "sid", value: "1", domain: ".blocked.example" }] },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([
      {
        ...hostGrant,
        grantId: "grant-gmail-fixed-host",
        toolPattern: "gmail.read",
        constraints: { allowedHosts: ["other.example"] },
      },
    ]);
    expect(
      (
        await hostEngine.evaluateAccess({
          toolName: "gmail.read",
          args: { connectionId: "gmail-connection" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([
      {
        ...hostGrant,
        grantId: "grant-calendar-fixed-host",
        toolPattern: "calendar.list",
        constraints: { allowedHosts: ["www.googleapis.com"] },
      },
    ]);
    expect(
      (
        await hostEngine.evaluateAccess({
          toolName: "calendar.list",
          args: { connectionId: "calendar-connection" },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockResolvedValue([
      {
        ...hostGrant,
        toolPattern: "fs.read",
        constraints: {
          allowedPaths: [null as unknown as string],
        },
      },
    ]);
    expect(
      // fs.read is a genuine path-bearing tool: structural safety passes (the
      // path is within jail), so the malformed allowedPaths:[null] grant
      // constraint is what blocks. (http.get would now fail structural safety
      // first for lacking a url/host target — see the dedicated test below.)
      (
        await hostEngine.evaluateAccess({
          toolName: "fs.read",
          args: { path: "./workspace/note.txt" },
          agentId: "agent",
          sessionId: "session",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
  });

  it("denies a network tool that omits a url/host target instead of skipping the host check", async () => {
    // Policy-engine Low: validateStructuralSafety used to skip the host
    // allowlist when args.url/args.host were both empty, letting an http.* /
    // webhook.send call slip past with no resolvable destination. It must now
    // fail closed.
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: { ...policyConfig.tools, approvalMode: "bypass" },
        sandbox: { ...policyConfig.sandbox, networkAllowlist: ["*"] },
      },
      createStorageStub(),
    );

    for (const toolName of ["http.get", "http.post", "webhook.send"]) {
      const decision = await engine.evaluateAccess({
        toolName,
        args: {},
        agentId: "agent",
        sessionId: "session",
      });
      expect(decision.allowed, toolName).toBe(false);
      expect(decision.reasonCodes, toolName).toEqual(["structural_safety_block"]);
    }
  });

  it("covers unknown in-profile grants and approved action payload parsing", async () => {
    const customStorage = createStorageStub();
    vi.mocked(customStorage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-custom",
        toolPattern: "custom.allowed",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "ref",
              rootPath: "./reference",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const customEngine = new ToolPolicyEngine(policyConfig, customStorage);
    expect(
      (
        await customEngine.evaluateAccess({
          toolName: "custom.allowed",
          args: { path: "./reference/note.txt" },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(false);

    const registeredCustomEngine = new ToolPolicyEngine(policyConfig, customStorage, createCustomAllowedRegistry());
    expect(
      (
        await registeredCustomEngine.evaluateAccess({
          toolName: "custom.allowed",
          args: { path: "./reference/note.txt" },
          agentId: "agent",
          sessionId: "session",
        })
      ).allowed,
    ).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-context",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "session.status",
            args: {},
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              operatorId: "operator-1",
              source: "agent",
              reason: "initial request",
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);
      const result = await engine.executeApprovedAction("apr-context");
      expect(result).toMatchObject({
        outcome: "executed",
        result: {
          sessionId: "session",
          status: "unavailable",
        },
      });

      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-non-string-context",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "session.status",
            args: {},
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              operatorId: 42,
              source: "ui",
              reason: 42,
            },
          },
        }),
      );
      await expect(engine.executeApprovedAction("apr-non-string-context")).resolves.toMatchObject({
        outcome: "executed",
      });

      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-invalid-payload",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            args: {},
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      await expect(engine.executeApprovedAction("apr-invalid-payload")).rejects.toThrow(
        "Invalid pending action request payload",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores an empty pending request when an approval-gated request has a defensive array shape", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const arrayBackedRequest = [] as unknown as ToolInvokeRequest;
    Object.assign(arrayBackedRequest, {
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
    });

    await expect(engine.invoke(arrayBackedRequest)).resolves.toMatchObject({
      outcome: "approval_required",
    });
    expect(storage.pendingApprovalActions.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {},
      }),
    );
  });

  it("persists only protected approval templates while channel.send waits for policy approval", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_policy_wait";
    const signal = new AbortController().signal;

    const result = await engine.invoke({
      toolName: "channel.send",
      args: {
        connectionId: "conn-telegram",
        target: "-1001234567890",
        message: "Approval requested.",
        interactiveActionTemplate: {
          platform: "telegram",
          tokenId: "rat_policy_wait",
          tokenRef,
          expiresAt: "2099-07-10T00:15:00.000Z",
          buttons: [
            { label: "Approve", decision: "a" },
            { label: "Deny", decision: "r" },
          ],
        },
      },
      agentId: "operator",
      sessionId: "session-policy-wait",
      authContext: { boundary: "tool_host_boundary", secretRefs: [tokenRef] },
      signal,
    });

    expect(result.outcome).toBe("approval_required");
    expect(JSON.stringify(vi.mocked(storage.approvals.createWithTtlDuration).mock.calls)).toContain(tokenRef);
    expect(JSON.stringify(vi.mocked(storage.pendingApprovalActions.upsertPending).mock.calls)).toContain(tokenRef);
    expect(vi.mocked(storage.pendingApprovalActions.upsertPending).mock.calls[0]?.[0].request).not.toHaveProperty(
      "signal",
    );
  });

  it("rejects raw approval bearers anywhere in the pending-action request before policy approval persistence", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const rawToken = `grat_${"z".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_policy_wait";

    await expect(
      engine.invoke({
        toolName: "channel.send",
        args: {
          connectionId: "conn-telegram",
          target: "-1001234567890",
          message: "Approval requested.",
          interactiveActionTemplate: {
            platform: "telegram",
            tokenId: "rat_policy_wait",
            tokenRef,
            expiresAt: "2099-07-10T00:15:00.000Z",
            buttons: [
              { label: "Approve", decision: "a" },
              { label: "Deny", decision: "r" },
            ],
          },
        },
        agentId: "operator",
        sessionId: "session-policy-raw-token",
        authContext: {
          boundary: "tool_host_boundary",
          secretRefs: [tokenRef, rawToken],
        },
      }),
    ).rejects.toThrow(/raw remote approval bearers/i);
    expect(storage.approvals.createWithTtlDuration).not.toHaveBeenCalled();
    expect(storage.pendingApprovalActions.upsertPending).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy pending-action request contains a raw approval bearer outside args", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      const rawToken = `grat_${"l".repeat(43)}`;
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-legacy-raw-bearer",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "session.status",
            args: {},
            agentId: "agent",
            sessionId: "session",
            authContext: {
              boundary: "tool_host_boundary",
              secretRefs: [rawToken],
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);

      await expect(engine.executeApprovedAction("apr-legacy-raw-bearer")).rejects.toThrow(
        /raw remote approval bearers/i,
      );
      expect(storage.toolAccessDecisions.record).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records runtime governance linkage on approval-gated tool requests", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const result = await engine.invoke({
      toolName: "fs.read",
      args: { path: "./workspace/README.md" },
      agentId: "agent",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      taskId: "task-1",
      runId: "run-1",
      surface: "code",
      permissionProfileId: "profile-direct",
      localOperatorOverrideId: "override-direct",
      policyContext: {
        permissionProfileId: "profile-context",
        localOperatorOverrideId: "override-context",
        permissionProfile: {
          profileId: "profile-context",
          label: "Safe context",
          scope: "operator",
          scopeRef: "operator",
          builtin: false,
          status: "active",
          approvalMode: "approve_all",
          toolPatterns: ["*"],
          createdBy: "operator",
          createdAt: "2026-05-18T00:00:00.000Z",
          updatedAt: "2026-05-18T00:00:00.000Z",
        } as PermissionProfileRecord,
      },
    });

    expect(result).toMatchObject({
      outcome: "approval_required",
      audit: {
        permissionProfileId: "profile-context",
        approvalMode: "approve_all",
        reasonCodes: expect.arrayContaining(["permission_profile", "approval_mode_all"]),
      },
    });
    expect(result.audit?.localOperatorOverrideId).toBeUndefined();
    expect(result.audit?.reasonCodes).not.toContain("local_operator_override");

    expect(storage.approvals.createWithTtlDuration).toHaveBeenCalledWith(
      expect.objectContaining({
        linkage: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          taskId: "task-1",
          runId: "run-1",
          originSurface: "code",
          toolName: "fs.read",
          actionType: "tool.invoke",
          permissionProfileId: "profile-context",
          localOperatorOverrideId: undefined,
        },
      }),
      15 * 60_000,
    );
    expect(storage.audit.append).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        outcome: "approval_required",
        policyReason: "approval required by approval mode",
        approvalId: "approval-1",
        taskId: "task-1",
        runId: "run-1",
        matchedGrantId: undefined,
        permissionProfileId: "profile-context",
        localOperatorOverrideId: undefined,
        approvalMode: "approve_all",
        reasonCodes: expect.arrayContaining(["permission_profile", "approval_mode_all"]),
      }),
    );
  });

  it("records the bypass network audit event for non-browser public targets that would otherwise need approval", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["localhost"],
        },
      },
      storage,
    );

    await (
      engine as unknown as {
        recordDangerProfileNetworkBypassIfNeeded: (
          auditEventId: string,
          request: {
            toolName: string;
            args: Record<string, unknown>;
            agentId: string;
            sessionId: string;
            taskId?: string;
          },
          evaluation: {
            allowed: boolean;
            reasonCodes: string[];
            requiresApproval: boolean;
            riskLevel: "danger";
            policyReason: string;
            approvalMode: "bypass";
            permissionProfileId?: string;
            localOperatorOverrideId?: string;
          },
        ) => Promise<void>;
      }
    ).recordDangerProfileNetworkBypassIfNeeded(
      "audit-network",
      {
        toolName: "http.post",
        args: { url: "https://user:secret@example.com/api?token=secret" },
        agentId: "agent",
        sessionId: "session",
        taskId: "task",
      },
      {
        allowed: true,
        reasonCodes: ["allowed", "approval_bypass_mode"],
        requiresApproval: false,
        riskLevel: "danger",
        policyReason: "allowed by bypass approval mode",
        approvalMode: "bypass",
        permissionProfileId: "trusted_local_power",
        localOperatorOverrideId: "override-1",
      },
    );

    expect(storage.audit.append).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        auditEventId: "audit-network",
        event: "approval_bypass_mode_network_target",
        permissionProfileId: "trusted_local_power",
        localOperatorOverrideId: "override-1",
        targets: [
          expect.objectContaining({
            target: "https://example.com",
            hostname: "example.com",
            reason:
              "Low-level bypass audit marker for public network target outside the allowlist: https://example.com",
          }),
        ],
      }),
    );
  });

  it("records full-web public network use without treating it as an approval bypass", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["localhost"],
        },
      },
      storage,
    );

    await (
      engine as unknown as {
        recordDangerProfileNetworkBypassIfNeeded: (
          auditEventId: string,
          request: {
            toolName: string;
            args: Record<string, unknown>;
            agentId: string;
            sessionId: string;
            taskId?: string;
            runId?: string;
            policyContext?: { fullWebAccess?: boolean; permissionProfileId?: string };
          },
          evaluation: {
            allowed: boolean;
            reasonCodes: string[];
            requiresApproval: boolean;
            riskLevel: "danger";
            policyReason: string;
            approvalMode: "bypass";
            permissionProfileId?: string;
            localOperatorOverrideId?: string;
          },
        ) => Promise<void>;
      }
    ).recordDangerProfileNetworkBypassIfNeeded(
      "audit-full-web",
      {
        toolName: "browser.navigate",
        args: { url: "https://user:secret@example.com/api?token=secret" },
        agentId: "agent",
        sessionId: "session",
        taskId: "task",
        runId: "run-1",
        policyContext: { fullWebAccess: true },
      },
      {
        allowed: true,
        reasonCodes: ["allowed"],
        requiresApproval: false,
        riskLevel: "danger",
        policyReason: "allowed by full web access",
        approvalMode: "bypass",
        permissionProfileId: "trusted_local_power",
        localOperatorOverrideId: "override-1",
      },
    );

    expect(storage.audit.append).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        auditEventId: "audit-full-web",
        event: "full_web_access_public_network_target",
        permissionProfileId: "trusted_local_power",
        localOperatorOverrideId: "override-1",
        runId: "run-1",
        targets: [
          expect.objectContaining({
            target: "https://example.com",
            hostname: "example.com",
            reason:
              "Full-web public access allowed network target outside the configured allowlist: https://example.com",
          }),
        ],
      }),
    );
    expect(storage.audit.append).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );
  });

  it("covers approval, read-candidate, and bypass-network defensive defaults", async () => {
    const approvalStorage = createStorageStub();
    vi.mocked(approvalStorage.approvals.createWithTtlDuration).mockImplementation(
      async (input) =>
        ({
          approvalId: "approval-without-expiry",
          kind: input.kind,
          riskLevel: input.riskLevel,
          status: "pending",
          payload: input.payload,
          preview: input.preview,
          createdAt: "2026-03-22T12:00:00.000Z",
          expiresAt: undefined,
          explanationStatus: "not_requested",
        }) as ApprovalRequest,
    );
    const approvalEngine = new ToolPolicyEngine(policyConfig, approvalStorage);

    await expect(
      approvalEngine.invoke({
        toolName: "shell.exec",
        args: { command: "echo approval" },
        agentId: "agent",
        sessionId: "session",
      }),
    ).rejects.toThrow(/did not return an expiry timestamp/i);

    expect(approvalStorage.pendingApprovalActions.upsertPending).not.toHaveBeenCalled();

    const readCandidates = approvalEngine as unknown as {
      validateStructuralSafety: (request: {
        toolName: string;
        args: Record<string, unknown>;
        agentId: string;
        sessionId: string;
      }) => Promise<string | undefined>;
      evaluateShellRisk: (request: {
        toolName: string;
        args: Record<string, unknown>;
        agentId: string;
        sessionId: string;
      }) => { risky: boolean; matchedPattern: string } | undefined;
      recordDangerProfileNetworkBypassIfNeeded: (
        auditEventId: string,
        request: { toolName: string; args: Record<string, unknown>; agentId: string; sessionId: string },
      ) => Promise<void>;
    };

    expect(
      await readCandidates.validateStructuralSafety({
        toolName: "fs.read",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }),
    ).toBeUndefined();
    expect(
      await readCandidates.validateStructuralSafety({
        toolName: "fs.copy",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }),
    ).toBeUndefined();
    expect(
      await readCandidates.validateStructuralSafety({
        toolName: "docs.ingest",
        args: { sourceType: "file" },
        agentId: "agent",
        sessionId: "session",
      }),
    ).toBeUndefined();

    const riskyEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          riskyShellPatterns: ["rm -rf"],
        },
      },
      createStorageStub(),
    ) as unknown as {
      evaluateShellRisk: (request: {
        toolName: string;
        args: Record<string, unknown>;
        agentId: string;
        sessionId: string;
      }) => { risky: boolean; matchedPattern: string } | undefined;
    };
    expect(
      riskyEngine.evaluateShellRisk({
        toolName: "shell.exec",
        args: { command: "rm -rf ./workspace/tmp" },
        agentId: "agent",
        sessionId: "session",
      }),
    ).toMatchObject({ matchedPattern: "rm -rf" });

    const bypassStorage = createStorageStub();
    const bypassEngine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "approve_risky",
        },
      },
      bypassStorage,
    ) as unknown as {
      recordDangerProfileNetworkBypassIfNeeded: (
        auditEventId: string,
        request: { toolName: string; args: Record<string, unknown>; agentId: string; sessionId: string },
        evaluation: {
          allowed: boolean;
          reasonCodes: string[];
          requiresApproval: boolean;
          riskLevel: "danger";
          policyReason: string;
          approvalMode?: "approve_risky" | "bypass";
        },
      ) => Promise<void>;
    };
    await bypassEngine.recordDangerProfileNetworkBypassIfNeeded(
      "audit-skip",
      {
        toolName: "http.get",
        args: { url: "https://example.com/api" },
        agentId: "agent",
        sessionId: "session",
      },
      {
        allowed: true,
        reasonCodes: ["allowed"],
        requiresApproval: false,
        riskLevel: "danger",
        policyReason: "allowed",
        approvalMode: "approve_risky",
      },
    );
    expect(bypassStorage.audit.append).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );
  });
});

describe("ToolPolicyEngine outside-root read access", () => {
  it("allows browser navigation to public hosts by default even in bypass mode", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-browser-navigate",
        toolPattern: "browser.navigate",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
          allow: [],
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "https://apnews.com/oddities" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("allowed");
  });

  it("still blocks metadata hosts under the danger profile", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
          allow: [],
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "http://169.254.169.254/latest/meta-data" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("structural_safety_block");
  });

  it("blocks non-canonical loopback Firecrawl browser backends even when loopback is allowlisted", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST, "127.0.0.1"],
        },
      },
      createStorageStub(),
    );

    const result = await engine.invoke({
      toolName: "browser.search",
      args: {
        query: "coverage",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:9999",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.audit?.reasonCodes).toContain("structural_safety_block");
    expect(result.policyReason).toContain("Private, metadata, or reserved host is blocked");

    const noPortResult = await engine.invoke({
      toolName: "browser.search",
      args: {
        query: "coverage",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(noPortResult.outcome).toBe("blocked");
    expect(noPortResult.audit?.reasonCodes).toContain("structural_safety_block");
    expect(noPortResult.policyReason).toContain("Private, metadata, or reserved host is blocked");
  });

  it("uses the Firecrawl-specific base URL guard for docs ingest policy checks", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST, "127.0.0.1", "localhost"],
        },
      },
      createStorageStub(),
    );

    const result = await engine.invoke({
      toolName: "docs.ingest",
      args: {
        sourceType: "url",
        source: "https://example.com/docs",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://localhost:80",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.audit?.reasonCodes).toContain("structural_safety_block");
    expect(result.policyReason).toContain("Private, metadata, or reserved host is blocked");
  });

  it("includes Firecrawl browser backend URLs in network target evaluation", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST],
        },
      },
      createStorageStub(),
    );

    const searchResult = await engine.invoke({
      toolName: "browser.search",
      args: {
        query: "coverage",
        backend: "firecrawl",
        firecrawlBaseUrl: "https://firecrawl.example",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    const navigateResult = await engine.invoke({
      toolName: "browser.navigate",
      args: {
        url: "https://example.com/page",
        backend: "firecrawl",
        firecrawlBaseUrl: "https://firecrawl.example",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(searchResult.outcome).toBe("blocked");
    expect(searchResult.policyReason).toContain("firecrawl.example");
    expect(navigateResult.outcome).toBe("blocked");
    expect(navigateResult.policyReason).toContain("firecrawl.example");
  });

  it("allows native browser.search without per-host search-engine allowlisting", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: [EXAMPLE_HOST, "firecrawl.example"],
        },
      },
      createStorageStub(),
    );

    const nativeResult = await engine.invoke({
      toolName: "browser.search",
      args: {
        query: "coverage",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    const firecrawlFallbackResult = await engine.invoke({
      toolName: "browser.search",
      args: {
        query: "coverage",
        backend: "firecrawl",
        firecrawlBaseUrl: "https://firecrawl.example",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });
    const firecrawlOnlyResult = await engine.invoke({
      toolName: "browser.search",
      args: {
        query: "coverage",
        backend: "firecrawl",
        firecrawlBaseUrl: "https://firecrawl.example",
        firecrawlFallbackToNative: false,
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(nativeResult.outcome).toBe("approval_required");
    expect(nativeResult.policyReason).not.toContain("browser.search requires at least one native search host");
    expect(firecrawlFallbackResult.outcome).toBe("approval_required");
    expect(firecrawlFallbackResult.policyReason).not.toContain(
      "browser.search requires at least one native search host",
    );
    expect(firecrawlOnlyResult.outcome).toBe("approval_required");
    expect(firecrawlOnlyResult.policyReason).not.toContain("browser.search requires at least one native search host");
  });

  it("allows browser.search when one fallback native search host is allowlisted", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["www.bing.com"],
        },
      },
      createStorageStub(),
    );

    const result = await engine.invoke({
      toolName: "browser.search",
      args: {
        query: "coverage",
        engine: "google",
      },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(result.outcome).toBe("approval_required");
    expect(result.policyReason).not.toContain("browser.search requires at least one native search host");
  });

  it("fails closed for official search when full web access is disabled and the workspace allowlist is empty", async () => {
    const engine = new ToolPolicyEngine(
      { ...policyConfig, sandbox: { ...policyConfig.sandbox, networkAllowlist: [] } },
      createStorageStub(),
    );
    const result = await engine.invoke({
      toolName: "browser.search",
      args: { query: "coverage", backend: "official", providers: ["brave"] },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false },
      dryRun: true,
    });
    expect(result.outcome).toBe("blocked");
    expect(result.audit?.reasonCodes).toContain("structural_safety_block");
    expect(result.policyReason).toContain("api.search.brave.com");
  });

  it("ignores caller-supplied grant hosts and requires stored official-provider consent", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.search.brave.com"] },
      },
      createStorageStub(),
    );
    const result = await engine.invoke({
      toolName: "browser.search",
      args: { query: "coverage", backend: "official", providers: ["brave"] },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false, matchedGrantAllowedHosts: [] },
      dryRun: true,
    });
    expect(result.outcome).toBe("approval_required");
    expect(result.audit?.reasonCodes).toContain("official_search_provider_consent_required");
  });

  it("does not treat caller-supplied matching hosts as official-provider consent", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.search.brave.com"] },
      },
      createStorageStub(),
    );
    const result = await engine.evaluateAccess({
      toolName: "browser.search",
      args: { query: "coverage", backend: "official", providers: ["brave"] },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false, matchedGrantAllowedHosts: ["api.search.brave.com"] },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.reasonCodes).toContain("official_search_provider_consent_required");
  });

  it("accepts only an active exact browser.search host-constrained grant as provider consent", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-brave-consent",
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: { allowedHosts: ["api.search.brave.com"] },
        createdBy: "operator",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ] as never);
    const engine = new ToolPolicyEngine(
      { ...policyConfig, sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.search.brave.com"] } },
      storage,
    );
    const result = await engine.evaluateAccess({
      toolName: "browser.search",
      args: { query: "coverage", backend: "official", providers: ["brave"] },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.matchedGrantId).toBe("grant-brave-consent");
  });

  it.each([
    ["uppercase backend", { backend: "OFFICIAL" }, ["api.search.brave.com"]],
    ["singular engine", { engine: "parallel" }, ["api.parallel.ai"]],
    ["providers-only", { providers: ["brave"] }, ["api.search.brave.com"]],
  ] as const)("uses canonical official-search selection for %s consent", async (_label, selection, allowedHosts) => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-canonical-consent",
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: { allowedHosts: [...allowedHosts] },
        createdBy: "operator",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ] as never);
    const result = await new ToolPolicyEngine(
      { ...policyConfig, sandbox: { ...policyConfig.sandbox, networkAllowlist: [...allowedHosts] } },
      storage,
    ).evaluateAccess({
      toolName: "browser.search",
      args: { query: "coverage", ...selection },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.matchedGrantId).toBe("grant-canonical-consent");
  });

  it.each([
    ["unconstrained", undefined],
    ["empty", { allowedHosts: [] }],
    ["wrong", { allowedHosts: ["api.parallel.ai"] }],
    ["superset", { allowedHosts: ["api.search.brave.com", "example.com"] }],
  ] as const)("does not accept an %s browser.search allow grant as Brave consent", async (_label, constraints) => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-not-consent",
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints,
        createdBy: "operator",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ] as never);
    const result = await new ToolPolicyEngine(
      { ...policyConfig, sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.search.brave.com"] } },
      storage,
    ).evaluateAccess({
      toolName: "browser.search",
      args: { query: "coverage", backend: "official", providers: ["brave"] },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.reasonCodes).toContain("official_search_provider_consent_required");
  });

  it("does not let an official-search host grant act as generic native browser.search access", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-brave-only",
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: { allowedHosts: ["api.search.brave.com"] },
        createdBy: "operator",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ] as never);
    const request = {
      toolName: "browser.search",
      args: { query: "coverage", engine: "google" },
      agentId: "agent",
      sessionId: "session",
    } as const;
    const outsideProfile = await new ToolPolicyEngine(
      {
        ...policyConfig,
        profiles: { minimal: [] },
        tools: { ...policyConfig.tools, profile: "minimal" },
      },
      storage,
    ).evaluateAccess(request);
    expect(outsideProfile.allowed).toBe(false);
    expect(outsideProfile.reasonCodes).toContain("policy_disallow");
    expect(outsideProfile.matchedGrantId).toBeUndefined();

    const inProfile = await new ToolPolicyEngine(policyConfig, storage).evaluateAccess(request);
    expect(inProfile.allowed).toBe(true);
    expect(inProfile.matchedGrantId).toBeUndefined();
  });

  it("requires one exact grant to cover both providers in research mode", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-partial",
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: { allowedHosts: ["api.search.brave.com"] },
        createdBy: "operator",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ] as never);
    const config = {
      ...policyConfig,
      sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.search.brave.com", "api.parallel.ai"] },
    };
    const input = {
      toolName: "browser.search",
      args: { query: "coverage", backend: "official", mode: "research" },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false },
    } as const;
    expect((await new ToolPolicyEngine(config, storage).evaluateAccess(input)).requiresApproval).toBe(true);

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-combined",
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: { allowedHosts: ["api.search.brave.com", "api.parallel.ai"] },
        createdBy: "operator",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ] as never);
    expect((await new ToolPolicyEngine(config, storage).evaluateAccess(input)).requiresApproval).toBe(false);
  });

  it.each(["bypass", "code_mode"] as const)(
    "applies official-provider consent after %s approval clearing",
    async (posture) => {
      const config = {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: posture === "bypass" ? ("bypass" as const) : policyConfig.tools.approvalMode,
        },
        sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.search.brave.com"] },
      };
      const result = await new ToolPolicyEngine(config, createStorageStub()).evaluateAccess({
        toolName: "browser.search",
        args: { query: "coverage", backend: "official", providers: ["brave"] },
        agentId: "agent",
        sessionId: "session",
        policyContext: {
          fullWebAccess: false,
          ...(posture === "code_mode" ? { approvedCodeModeRunId: "code-mode-1" } : {}),
        },
      });
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.reasonCodes).toContain("official_search_provider_consent_required");
    },
  );

  it("keeps deny-wins and treats revoked official-search grants as no consent", async () => {
    const storage = createStorageStub();
    const baseGrant = {
      toolPattern: "browser.search",
      scope: "session" as const,
      scopeRef: "session",
      grantType: "persistent" as const,
      constraints: { allowedHosts: ["api.search.brave.com"] },
      createdBy: "operator",
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    const config = {
      ...policyConfig,
      sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.search.brave.com"] },
    };
    const input = {
      toolName: "browser.search",
      args: { query: "coverage", backend: "official", providers: ["brave"] },
      agentId: "agent",
      sessionId: "session",
      policyContext: { fullWebAccess: false },
    } as const;

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      { grantId: "grant-deny", ...baseGrant, decision: "deny" },
    ] as never);
    const denied = await new ToolPolicyEngine(config, storage).evaluateAccess(input);
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCodes).toContain("grant_deny");

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      {
        grantId: "grant-revoked",
        ...baseGrant,
        decision: "allow",
        revokedAt: "2026-07-14T00:01:00.000Z",
      },
    ] as never);
    const revoked = await new ToolPolicyEngine(config, storage).evaluateAccess(input);
    expect(revoked.allowed).toBe(true);
    expect(revoked.requiresApproval).toBe(true);
    expect(revoked.reasonCodes).toContain("official_search_provider_consent_required");
  });

  it("does not audit dry-run public-host browser reads because public web access is the default", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
          allow: [],
        },
      },
      storage,
    );

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-browser-navigate",
        toolPattern: "browser.navigate",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await engine.invoke({
      toolName: "browser.navigate",
      args: { url: "https://apnews.com/oddities" },
      agentId: "agent",
      sessionId: "session",
      dryRun: true,
    });

    expect(result.outcome).toBe("executed");
    expect(vi.mocked(storage.audit.append)).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );
    expect(vi.mocked(storage.audit.append)).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "full_web_access_public_network_target" }),
    );
  });

  it("persists a default approval expiry when a tool action is gated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
    try {
      const storage = createStorageStub();
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );

      const result = await engine.invoke({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
      });

      expect(result.outcome).toBe("approval_required");
      expect(result.expiresAt).toBe("2026-03-22T12:15:00.000Z");
      expect(vi.mocked(storage.approvals.createWithTtlDuration)).toHaveBeenCalledWith(
        expect.not.objectContaining({ expiresAt: expect.anything() }),
        15 * 60_000,
      );
      expect(vi.mocked(storage.pendingApprovalActions.upsertPending)).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: "2026-03-22T12:15:00.000Z",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires approval when readAccessMode is approval_required and a file is outside trusted roots", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("outside_roots_read_requires_approval");
  });

  it("allows outside-root reads when a scoped grant includes a wildcard allowed path", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-1",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          allowedPaths: ["*"],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("allows outside-root file reads when a later scoped grant covers the path", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-broad-read",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
      {
        grantId: "grant-path-read",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          allowedPaths: ["F:/outside/project"],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "roots_only",
        },
      },
      storage,
    );
    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.reasonCodes).toEqual(["allowed"]);
  });

  it("does not allow a scoped read grant to escape through a symlinked child path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `goat-policy-grant-realpath-${randomUUID()}-`));
    tempRoots.push(root);
    const grantedRoot = path.join(root, "granted");
    const outsideRoot = path.join(root, "outside");
    const linkPath = path.join(grantedRoot, "linked");
    const secretPath = path.join(outsideRoot, "secret.txt");
    await fs.mkdir(grantedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(secretPath, "outside secret", "utf8");
    await fs.symlink(outsideRoot, linkPath, "junction");

    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-realpath",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          allowedPaths: [grantedRoot],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          writeJailRoots: [grantedRoot],
          readOnlyRoots: [],
          readAccessMode: "roots_only",
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: path.join(linkPath, "secret.txt"), startLine: 1, endLine: 1 },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("structural_safety_block");
  });

  it("keeps scoped read grant path constraints active in full-disk read mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `goat-policy-grant-full-disk-${randomUUID()}-`));
    tempRoots.push(root);
    const grantedRoot = path.join(root, "granted");
    const outsideRoot = path.join(root, "outside");
    const linkPath = path.join(grantedRoot, "linked");
    await fs.mkdir(grantedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside secret", "utf8");
    await fs.symlink(outsideRoot, linkPath, "junction");

    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-full-disk-realpath",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          allowedPaths: [grantedRoot],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          writeJailRoots: [grantedRoot],
          readOnlyRoots: [],
          readAccessMode: "full_disk",
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: path.join(linkPath, "secret.txt"), startLine: 1, endLine: 1 },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_constraints_block"]);
  });

  it("allows approved read-only reference roots without approval churn", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-reference-root",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "claude-code-reference",
              rootPath: "F:\\code\\claude-code",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/code/claude-code/src/index.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("does not allow approved read-only reference roots to escape through parent segments", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-reference-root",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "claude-code-reference",
              rootPath: "F:\\code\\claude-code",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/code/claude-code/../private/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("does not bypass outside-root read approval with a forged approval id", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      },
      storage,
    );
    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
      consentContext: {
        source: "ui",
        reason: "approval:apr-forged",
      },
    } as never);
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("allows outside-root reads only when the approval id matches an approved row and fresh pending action request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-123",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              source: "ui",
              reason: "approval:apr-123",
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-123",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bypass outside-root read approval when the matching approval row is not approved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.approvals.get).mockResolvedValue(
        createApprovalRequest({
          approvalId: "apr-pending",
          status: "pending",
        }),
      );
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-pending",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              source: "ui",
              reason: "approval:apr-pending",
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-pending",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bypass outside-root read approval when run lineage differs from the approved request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-run-scoped",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
            workspaceId: "workspace-1",
            taskId: "task-1",
            runId: "run-1",
            surface: "code",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        workspaceId: "workspace-1",
        taskId: "task-1",
        runId: "run-2",
        surface: "code",
        consentContext: {
          source: "ui",
          reason: "approval:apr-run-scoped",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a verified approval bypass roots-only read posture", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-roots-only",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
            consentContext: {
              source: "ui",
              reason: "approval:apr-roots-only",
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "roots_only",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-roots-only",
        },
      } as never);
      expect(evaluation.allowed).toBe(false);
      expect(evaluation.reasonCodes).toContain("structural_safety_block");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects outside-root approval bypasses after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:20:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-expired",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-expired",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an expired approved-action bypass under a slow host clock using database time", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-approval-bypass-db-clock-"));
    tempRoots.push(runtimeDir);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(runtimeDir, "transcripts"),
      auditDir: path.join(runtimeDir, "audit"),
    });
    const databaseNow = Date.now();
    const approval = storage.approvals.create({
      kind: "file.read_range",
      riskLevel: "caution",
      payload: {},
      preview: {},
      expiresAt: new Date(databaseNow + 60_000).toISOString(),
    });
    const request = {
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
      consentContext: {
        source: "ui" as const,
        reason: `approval:${approval.approvalId}`,
      },
    };
    storage.pendingApprovalActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: "tool.invoke",
      request,
      expiresAt: new Date(databaseNow + 60_000).toISOString(),
    });
    storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
    storage.db
      .prepare("UPDATE pending_approval_actions SET expires_at = ? WHERE approval_id = ?")
      .run(new Date(databaseNow - 60_000).toISOString(), approval.approvalId);
    const asyncStorage = createSqliteAsyncStorage(storage);
    const hostClock = vi.spyOn(Date, "now").mockReturnValue(0);

    try {
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        asyncStorage,
      );
      const result = await engine.invoke(request);

      expect(result.outcome).toBe("approval_required");
      expect(result.policyReason).toMatch(/requires approval/i);
    } finally {
      hostClock.mockRestore();
      await asyncStorage.close();
    }
  }, 20_000);

  it("rejects outside-root approval bypasses after the pending action is resolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue({
        ...createPendingApprovalAction({
          approvalId: "apr-executed",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
        resolutionStatus: "executed",
      });
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-executed",
        },
      } as never);
      expect(evaluation.allowed).toBe(true);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows legacy pending approval bypasses only inside the default ttl from createdAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:14:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-legacy",
          createdAt: "2026-03-21T00:00:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-legacy",
        },
      } as never);
      expect(evaluation.requiresApproval).toBe(false);

      vi.setSystemTime(new Date("2026-03-21T00:16:00.000Z"));
      const expiredEvaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-legacy",
        },
      } as never);
      expect(expiredEvaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending approval bypasses with invalid explicit expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-invalid-expiry",
          createdAt: "2026-03-21T00:00:00.000Z",
          expiresAt: "not-a-date",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const evaluation = await engine.evaluateAccess({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
        consentContext: {
          source: "ui",
          reason: "approval:apr-invalid-expiry",
        },
      } as never);
      expect(evaluation.requiresApproval).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not execute approved pending actions after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:20:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-expired-direct",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "file.read_range",
            args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
            agentId: "agent",
            sessionId: "session",
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storage,
      );
      const result = await engine.executeApprovedAction("apr-expired-direct");
      expect(result).toBeUndefined();
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith("apr-expired-direct", "failed", {
        reason: "pending approval action is expired, resolved, or no longer matches the stored request",
      });
      expect(storage.runImmediateTransaction).toHaveBeenCalledTimes(1);
      expect(storage.approvalEvents.append).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "apr-expired-direct",
          eventType: "approved_action_executed",
          payload: expect.objectContaining({ outcome: "blocked" }),
        }),
      );
      expect(storage.audit.append).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores missing and unsupported pending approval actions", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await expect(engine.executeApprovedAction("missing")).resolves.toBeUndefined();

    vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue({
      ...createPendingApprovalAction({
        approvalId: "apr-chat",
        request: { toolName: "session.status", args: {}, agentId: "agent", sessionId: "session" },
      }),
      actionType: "chat.send" as never,
    });

    await expect(engine.executeApprovedAction("apr-chat")).resolves.toBeUndefined();
    expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith("apr-chat", "failed", {
      error: "unsupported pending action type chat.send",
    });
  });

  it("executes a fresh approved pending action and marks it resolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-session",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "session.status",
            args: {},
            agentId: "agent",
            sessionId: "session",
            workspaceId: "workspace-1",
            taskId: "task-1",
            runId: "run-1",
            surface: "code",
            trustLevel: "trusted_workspace",
            sourceAttribution: [{ sourceType: "text", sourceRef: "approval-test" }],
            authContext: { boundary: "tool_host_boundary", secretRefs: ["secret-1"] },
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);

      const result = await engine.executeApprovedAction("apr-session", new AbortController().signal);

      expect(result).toMatchObject({
        outcome: "executed",
        policyReason: "allowed_via_approval:apr-session",
        result: {
          sessionId: "session",
          status: "unavailable",
        },
      });
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
        "apr-session",
        "executed",
        expect.objectContaining({
          outcome: "executed",
        }),
      );
      expect(storage.toolAccessDecisions.record).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "session.status",
          workspaceId: "workspace-1",
          taskId: "task-1",
          runId: "run-1",
          countsTowardLimits: true,
        }),
      );
      expect(storage.approvalEvents.append).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "apr-session",
          eventType: "approved_action_executed",
          payload: expect.objectContaining({ outcome: "executed" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("generates presentation visuals only during a single approved replay", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-approved-presentation-"));
    tempRoots.push(root);
    const storage = createStorageStub();
    let pending: PendingApprovalAction | undefined;
    vi.mocked(storage.pendingApprovalActions.find).mockImplementation(async () => pending);
    vi.mocked(storage.pendingApprovalActions.markResolved).mockImplementation(async (approvalId, status, result) => {
      if (!pending || pending.approvalId !== approvalId) {
        throw new Error(`pending approval ${approvalId} is unavailable`);
      }
      pending = { ...pending, resolutionStatus: status, result, resolvedAt: new Date().toISOString() };
      return pending;
    });
    const preparePresentationVisuals = vi.fn(async () => ({
      plan: [
        {
          slideIndex: 0,
          slideTitle: "Approval-Safe Presentation",
          kind: "cover" as const,
          promptSha256: "c".repeat(64),
        },
      ],
      assets: [
        {
          slideIndex: 0,
          promptSha256: "c".repeat(64),
          asset: {
            bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            mimeType: "image/png" as const,
            source: "openai",
            sourceModel: "gpt-image-2",
          },
        },
      ],
      warnings: [],
      providerCalls: 1,
    }));
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        sandbox: { ...policyConfig.sandbox, writeJailRoots: [root] },
      },
      storage,
      undefined,
      { preparePresentationVisuals },
    );
    const deckPath = path.join(root, "approval-safe.pptx");
    const request: ToolInvokeRequest = {
      toolName: "presentations.create",
      args: {
        path: deckPath,
        title: "Approval-Safe Presentation",
        slides: [
          {
            title: "Grounded Findings",
            bullets: ["The approved deck preserves source-backed findings and writes only after authorization."],
          },
        ],
      },
      agentId: "assistant",
      sessionId: "session-approved-presentation",
      turnId: "turn-approved-presentation",
      runtimeSkillApplications: [
        {
          skillId: "bundled:design-intelligence",
          treeSha256: "a".repeat(64),
          instructionSha256: "b".repeat(64),
          modules: ["main", "enforcement", "layout", "taste", "assets", "audit"],
        },
      ],
      writePathRepair: {
        originalPath: "/workspace/artifacts/approval-safe.pptx",
        repairedPath: deckPath,
        originalReasonCodes: ["structural_safety_block"],
        repairedReasonCodes: ["approval_required"],
      },
      presentationGrounding: { sourceTermCount: 8, matchedSourceTermCount: 6 },
    };

    const waiting = await engine.invoke(request);

    expect(waiting).toMatchObject({ outcome: "approval_required", approvalId: "approval-1" });
    expect(preparePresentationVisuals).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(storage.approvals.createWithTtlDuration).mock.calls[0]?.[0].payload)).not.toContain(
      "iVBORw0KGgo",
    );
    const pendingInput = vi.mocked(storage.pendingApprovalActions.upsertPending).mock.calls[0]?.[0];
    expect(pendingInput?.request).toMatchObject({
      toolName: request.toolName,
      args: request.args,
      runtimeSkillApplications: request.runtimeSkillApplications,
      writePathRepair: request.writePathRepair,
      presentationGrounding: request.presentationGrounding,
    });
    pending = createPendingApprovalAction({
      approvalId: pendingInput?.approvalId ?? "approval-1",
      request: pendingInput?.request ?? {},
      expiresAt: pendingInput?.expiresAt,
    });

    const executed = await engine.executeApprovedAction("approval-1");
    const duplicateReplay = await engine.executeApprovedAction("approval-1");

    expect(executed, JSON.stringify(executed)).toMatchObject({
      outcome: "executed",
      result: {
        path: path.resolve(deckPath),
        designReport: {
          designQuality: {
            runtimeInstructions: { status: "injected" },
            contentGrounding: { status: "passed" },
          },
        },
      },
    });
    await expect(fs.stat(deckPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect(preparePresentationVisuals).toHaveBeenCalledTimes(1);
    expect(preparePresentationVisuals).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: request.turnId,
        runtimeSkillApplications: request.runtimeSkillApplications,
        writePathRepair: request.writePathRepair,
        presentationGrounding: request.presentationGrounding,
      }),
    );
    expect(JSON.stringify(executed)).not.toContain("iVBORw0KGgo");
    expect(duplicateReplay).toBeUndefined();
  }, 20_000);

  it("can defer approved external-runtime resolution to the caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-external-runtime",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "mcp.invoke",
            args: { serverId: "srv-1", toolName: "tool.echo", arguments: { value: "hello" } },
            agentId: "agent",
            sessionId: "session",
            externalRuntime: true,
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);

      const result = await engine.executeApprovedAction("apr-external-runtime", undefined, {
        deferResolution: true,
      });

      expect(result).toMatchObject({
        outcome: "executed",
        result: {
          externalRuntime: true,
          toolName: "mcp.invoke",
        },
      });
      expect(storage.toolAccessDecisions.record).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "mcp.invoke",
          countsTowardLimits: true,
        }),
      );
      expect(storage.pendingApprovalActions.markResolved).not.toHaveBeenCalled();
      expect(storage.approvalEvents.append).not.toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "apr-external-runtime",
          eventType: "approved_action_executed",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers approved policy-denial terminal truth to the canonical side-effect owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      const pendingAction = createPendingApprovalAction({
        approvalId: "apr-external-runtime-denied",
        expiresAt: "2026-03-21T00:10:00.000Z",
        request: {
          toolName: "mcp.invoke",
          args: { serverId: "srv-1", toolName: "tool.mutate", arguments: { value: "hello" } },
          agentId: "agent",
          sessionId: "session",
          externalRuntime: true,
        },
      });
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(pendingAction);
      let transactionDepth = 0;
      vi.mocked(storage.runImmediateTransaction).mockImplementation(async (work) => {
        transactionDepth += 1;
        try {
          return await work();
        } finally {
          transactionDepth -= 1;
        }
      });
      vi.mocked(storage.pendingApprovalActions.markResolved).mockImplementation(
        async (approvalId, status, nextResult) => {
          if (transactionDepth !== 1) {
            throw new Error("pending action terminal truth escaped its transaction");
          }
          return {
            ...pendingAction,
            approvalId,
            resolutionStatus: status,
            result: nextResult,
            resolvedAt: "2026-03-21T00:05:00.000Z",
          };
        },
      );
      vi.mocked(storage.approvalEvents.append).mockImplementation(async (event) => {
        if (transactionDepth !== 1) {
          throw new Error("approved action event escaped its transaction");
        }
        return {
          ...event,
          eventId: "event-external-runtime-denied",
          timestamp: "2026-03-21T00:05:00.000Z",
        };
      });
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          tools: {
            ...policyConfig.tools,
            deny: ["mcp.invoke"],
          },
        },
        storage,
      );

      const result = await engine.executeApprovedAction("apr-external-runtime-denied", undefined, {
        deferResolution: true,
        externalRuntimeReplay: true,
      });

      expect(result).toMatchObject({
        outcome: "blocked",
        policyReason: expect.stringContaining("blocked"),
      });
      expect(storage.runImmediateTransaction).not.toHaveBeenCalled();
      expect(storage.pendingApprovalActions.markResolved).not.toHaveBeenCalled();
      expect(storage.approvalEvents.append).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an approved policy denial terminal when JSONL audit delivery fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      let pendingAction: PendingApprovalAction = createPendingApprovalAction({
        approvalId: "apr-blocked-audit-failure",
        expiresAt: "2026-03-21T00:10:00.000Z",
        request: {
          toolName: "mcp.invoke",
          args: { serverId: "srv-1", toolName: "tool.mutate", arguments: { value: "hello" } },
          agentId: "agent",
          sessionId: "session",
          externalRuntime: true,
        },
      });
      vi.mocked(storage.pendingApprovalActions.find).mockImplementation(async () => pendingAction);
      vi.mocked(storage.pendingApprovalActions.markResolved).mockImplementation(async (_approvalId, status, result) => {
        pendingAction = { ...pendingAction, resolutionStatus: status, result };
        return pendingAction;
      });
      vi.mocked(storage.audit.append).mockRejectedValue(new Error("audit sink unavailable"));
      const insertPolicyBlock = vi.fn(() => ({ changes: 1 }));
      vi.mocked(storage.db.prepare).mockReturnValue({ run: insertPolicyBlock } as never);
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          tools: { ...policyConfig.tools, deny: ["mcp.invoke"] },
        },
        storage,
      );

      await expect(
        engine.executeApprovedAction("apr-blocked-audit-failure", undefined, {
          deferResolution: true,
          externalRuntimeReplay: true,
        }),
      ).resolves.toMatchObject({ outcome: "blocked" });
      await expect(engine.executeApprovedAction("apr-blocked-audit-failure")).resolves.toMatchObject({
        outcome: "blocked",
      });

      expect(pendingAction.resolutionStatus).toBe("failed");
      expect(insertPolicyBlock).toHaveBeenCalledTimes(2);
      expect(storage.approvalEvents.append).toHaveBeenCalledTimes(1);
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can replay an approved dry-run pending action as an external runtime execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-mcp-dry-run",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "mcp.invoke",
            args: { serverId: "srv-1", toolName: "tool.echo", arguments: { value: "hello" } },
            agentId: "agent",
            sessionId: "session",
            dryRun: true,
          },
        }),
      );
      const engine = new ToolPolicyEngine(policyConfig, storage);

      const result = await engine.executeApprovedAction("apr-mcp-dry-run", undefined, {
        deferResolution: true,
        externalRuntimeReplay: true,
      });

      expect(result).toMatchObject({
        outcome: "executed",
        result: {
          externalRuntime: true,
          toolName: "mcp.invoke",
        },
      });
      expect(result?.internalResult).toMatchObject({
        toolName: "mcp.invoke",
        outcome: "executed",
        result: {
          externalRuntime: true,
          toolName: "mcp.invoke",
        },
      });
      expect(storage.audit.append).toHaveBeenCalledWith(
        "tool_invocations",
        expect.objectContaining({
          toolName: "mcp.invoke",
          outcome: "executed",
          policyReason: "allowed_via_approval:apr-mcp-dry-run",
        }),
      );
      expect(storage.pendingApprovalActions.markResolved).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ToolPolicyEngine scoped mutation gating", () => {
  it("treats task-scoped grants as first mutation per task instead of per session", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation(async (scope, scopeRef) => {
      if (scope === "task" && scopeRef === "task-2") {
        return [
          {
            grantId: "grant-task-2",
            toolPattern: "fs.write",
            decision: "allow",
            scope: "task",
            scopeRef: "task-2",
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockImplementation(async (input) => {
      expect(input.scope).toBe("task");
      expect(input.taskId).toBe("task-2");
      return 0;
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = await engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/output.txt", content: "hello" },
      agentId: "agent",
      sessionId: "session-1",
      taskId: "task-2",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("treats workspace-scoped grants as first mutation per workspace instead of global", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation(async (scope, scopeRef) => {
      if (scope === "workspace" && scopeRef === "workspace-1") {
        return [
          {
            grantId: "grant-workspace-1",
            toolPattern: "fs.write",
            decision: "allow",
            scope: "workspace",
            scopeRef: "workspace-1",
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      if (scope === "global" && scopeRef === "global") {
        return [
          {
            grantId: "grant-global",
            toolPattern: "fs.write",
            decision: "allow",
            scope: "global",
            scopeRef: "global",
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockImplementation(async (input) => {
      expect(input.scope).toBe("workspace");
      expect(input.workspaceId).toBe("workspace-1");
      return 0;
    });

    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = await engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/output.txt", content: "hello" },
      agentId: "agent",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("lets matching denies beat allows across scopes", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation(async (scope, scopeRef) => {
      if (scope === "session" && scopeRef === "session-1") {
        return [
          {
            grantId: "grant-session-allow",
            toolPattern: "shell.exec",
            decision: "allow",
            scope,
            scopeRef,
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      if (scope === "task" && scopeRef === "task-1") {
        return [
          {
            grantId: "grant-task-deny",
            toolPattern: "shell.exec",
            decision: "deny",
            scope,
            scopeRef,
            grantType: "persistent",
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session-1",
      taskId: "task-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("grant_deny");
  });

  it("blocks privileged execution when the request trust level is untrusted_external", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session-1",
      trustLevel: "untrusted_external",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("blocks privileged execution when source attribution is untrusted even without a top-level trust level", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const shellEvaluation = await engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session-1",
      sourceAttribution: [
        {
          sourceType: "url",
          sourceRef: "https://example.com/prompt",
          trustLevel: "untrusted_external",
        },
      ],
    });
    const writeEvaluation = await engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/out.txt", content: "hello" },
      agentId: "agent",
      sessionId: "session-1",
      sourceAttribution: [
        {
          sourceType: "text",
          sourceRef: "mixed-context",
          trustLevel: "mixed_untrusted",
        },
      ],
    });

    expect(shellEvaluation.allowed).toBe(false);
    expect(shellEvaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
    expect(writeEvaluation.allowed).toBe(false);
    expect(writeEvaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("blocks writes into read-only reference roots even when granted", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-reference-write",
        toolPattern: "fs.write",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: {
          referenceRoots: [
            {
              label: "claude-code-reference",
              rootPath: "F:\\code\\claude-code",
              access: "read_only",
            },
          ],
        },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);

    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = await engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "F:/code/claude-code/README.md", content: "mutate" },
      agentId: "agent",
      sessionId: "session-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("grant_constraints_block");
  });

  it("blocks scoped grants when mutation, rate, host, and path constraints fail", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          writeJailRoots: ["./workspace"],
          networkAllowlist: [EXAMPLE_HOST, BLOCKED_EXAMPLE_HOST],
        },
      },
      storage,
    );
    const grantBase = {
      grantId: "grant-constraints",
      toolPattern: "fs.write",
      decision: "allow",
      scope: "session",
      scopeRef: "session-1",
      grantType: "persistent",
      createdBy: "test",
      createdAt: new Date().toISOString(),
    } as const;

    vi.mocked(storage.toolGrants.list).mockResolvedValue([{ ...grantBase, constraints: { mutationAllowed: false } }]);
    expect(
      (
        await engine.evaluateAccess({
          toolName: "fs.write",
          args: { path: "./workspace/out.txt", content: "x" },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    for (const [toolName, args] of [
      ["fs.copy", { from: "./workspace/in.txt", to: "./workspace/out.txt" }],
      ["documents.create", { path: "./workspace/report.md", title: "Report", body: "x" }],
      ["channel.send", { connectionId: "conn-1", channelId: "chan-1", text: "hello" }],
    ] as const) {
      vi.mocked(storage.toolGrants.list).mockResolvedValue([
        { ...grantBase, toolPattern: toolName, constraints: { mutationAllowed: false } },
      ]);
      expect(
        (
          await engine.evaluateAccess({
            toolName,
            args,
            agentId: "agent",
            sessionId: "session-1",
          })
        ).reasonCodes,
      ).toEqual(["grant_constraints_block"]);
    }

    vi.mocked(storage.toolGrants.list).mockResolvedValue([{ ...grantBase, constraints: { maxCallsPerHour: 1 } }]);
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockResolvedValueOnce(1);
    expect(
      (
        await engine.evaluateAccess({
          toolName: "fs.write",
          args: { path: "./workspace/out.txt", content: "x" },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockResolvedValue([{ ...grantBase, constraints: { maxWritesPerHour: 1 } }]);
    vi.mocked(storage.toolAccessDecisions.countWritesInLastHourInScope).mockResolvedValueOnce(1);
    expect(
      (
        await engine.evaluateAccess({
          toolName: "fs.write",
          args: { path: "./workspace/out.txt", content: "x" },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      { ...grantBase, toolPattern: "http.post", constraints: { maxWritesPerHour: 1 } },
    ]);
    vi.mocked(storage.toolAccessDecisions.countWritesInLastHourInScope).mockResolvedValueOnce(1);
    expect(
      (
        await engine.evaluateAccess({
          toolName: "http.post",
          args: { url: "https://example.com/api", body: { ok: true } },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      { ...grantBase, constraints: { allowedPaths: ["./workspace/allowed"] } },
    ]);
    const allowedPathEvaluation = await engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: path.resolve("./workspace/allowed/out.txt"), content: "x" },
      agentId: "agent",
      sessionId: "session-1",
    });
    expect(allowedPathEvaluation.reasonCodes).toContain("allowed");
    expect(
      (
        await engine.evaluateAccess({
          toolName: "fs.write",
          args: { path: "./workspace/blocked/out.txt", content: "x" },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-hosts",
        toolPattern: "http.get",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedHosts: [`*.${EXAMPLE_HOST}`] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(
      (
        await engine.evaluateAccess({
          toolName: "http.get",
          args: { url: "https://blocked.example/path" },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
  });

  it("applies scoped grant constraints to safe tools", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
      },
      storage,
    );

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-safe-read",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedPaths: ["./skills/allowed"] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);

    const evaluation = await engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "./skills/blocked/file.md" },
      agentId: "agent",
      sessionId: "session-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_constraints_block"]);
    expect(evaluation.matchedGrantId).toBe("grant-safe-read");
  });

  it("applies docs.ingest grant constraints to URL and file sources", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["allowed.example", "blocked.example"],
        },
      },
      storage,
    );

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-doc-url",
        toolPattern: "docs.ingest",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedHosts: ["allowed.example"] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(
      (
        await engine.evaluateAccess({
          toolName: "docs.ingest",
          args: { sourceType: "url", source: "https://blocked.example/docs.md", namespace: "research" },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
    expect(
      (
        await engine.invoke({
          toolName: "docs.ingest",
          args: { sourceType: "text", source: "inline notes", namespace: "research" },
          agentId: "agent",
          sessionId: "session-1",
          dryRun: true,
        })
      ).policyReason,
    ).toBe("blocked: grant host constraints require a URL docs.ingest source");

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-doc-file",
        toolPattern: "docs.ingest",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedPaths: ["./workspace/allowed"] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(
      (
        await engine.evaluateAccess({
          toolName: "docs.ingest",
          args: { sourceType: "file", source: "./workspace/blocked/docs.md", namespace: "research" },
          agentId: "agent",
          sessionId: "session-1",
        })
      ).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
    expect(
      (
        await engine.invoke({
          toolName: "docs.ingest",
          args: { sourceType: "url", source: "https://allowed.example/docs.md", namespace: "research" },
          agentId: "agent",
          sessionId: "session-1",
          dryRun: true,
        })
      ).policyReason,
    ).toBe("blocked: grant path constraints require a file docs.ingest source");
    expect(
      (
        await engine.invoke({
          toolName: "docs.ingest",
          args: { sourceType: "text", source: "inline notes", namespace: "research" },
          agentId: "agent",
          sessionId: "session-1",
          dryRun: true,
        })
      ).policyReason,
    ).toBe("blocked: grant path constraints require a file docs.ingest source");
  });

  it("allows docs.ingest file sources when a later scoped grant covers the source path", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "roots_only",
        },
      },
      storage,
    );

    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-doc-broad",
        toolPattern: "docs.ingest",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
      {
        grantId: "grant-doc-file",
        toolPattern: "docs.ingest",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedPaths: ["F:/outside/docs"] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);

    const evaluation = await engine.evaluateAccess({
      toolName: "docs.ingest",
      args: { sourceType: "file", source: "F:/outside/docs/brief.md", namespace: "research" },
      agentId: "agent",
      sessionId: "session-1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.matchedGrantId).toBe("grant-doc-file");
    expect(evaluation.reasonCodes).toContain("approval_bypass_mode");
  });

  it("applies scoped grant path constraints to browser output paths", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
      },
      storage,
    );

    for (const [toolName, args] of [
      ["browser.screenshot", { url: "http://localhost/app", outputPath: "./workspace/blocked/shot.png" }],
      [
        "browser.interact",
        {
          url: "http://localhost/app",
          outputPath: "./workspace/blocked/interact.json",
          steps: [{ action: "click", selector: "button" }],
        },
      ],
    ] as const) {
      vi.mocked(storage.toolGrants.list).mockResolvedValue([
        {
          grantId: `grant-${toolName}`,
          toolPattern: toolName,
          decision: "allow",
          scope: "session",
          scopeRef: "session-1",
          grantType: "persistent",
          constraints: { allowedPaths: ["./workspace/allowed"] },
          createdBy: "test",
          createdAt: new Date().toISOString(),
        },
      ]);

      const evaluation = await engine.evaluateAccess({
        toolName,
        args,
        agentId: "agent",
        sessionId: "session-1",
      });

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.reasonCodes).toEqual(["grant_constraints_block"]);
    }
  });

  it("requires explicit browser screenshot output paths for path-scoped grants", async () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-browser-shot",
        toolPattern: "browser.screenshot",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedPaths: ["./workspace/allowed"] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
      },
      storage,
    );

    const evaluation = await engine.evaluateAccess({
      toolName: "browser.screenshot",
      args: { url: "http://localhost/app" },
      agentId: "agent",
      sessionId: "session-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_constraints_block"]);
  });

  it("keeps scoped grant host constraints enforced across HTTP redirects", async () => {
    const originalFetch = globalThis.fetch;
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockResolvedValue([
      {
        grantId: "grant-http-source",
        toolPattern: "http.get",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        constraints: { allowedHosts: ["allowed.example"] },
        createdBy: "test",
        createdAt: new Date().toISOString(),
      },
    ]);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://allowed.example/start") {
        return new Response("", { status: 302, headers: { location: "https://other.example/final" } });
      }
      return new Response("other", { status: 200 });
    }) as unknown as typeof fetch;
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: { ...policyConfig.tools, approvalMode: "bypass" },
        sandbox: { ...policyConfig.sandbox, networkAllowlist: ["allowed.example", "other.example"] },
      },
      storage,
    );

    try {
      const result = await engine.invoke({
        toolName: "http.get",
        args: { url: "https://allowed.example/start" },
        agentId: "agent",
        sessionId: "session-1",
      });

      expect(result.outcome).toBe("blocked");
      expect(result.policyReason).toContain("Host is not yet allowlisted: https://other.example");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects non-canonical docs.ingest sourceType values before source safety checks can be skipped", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["allowed.example", "blocked.example"],
        },
      },
      storage,
    );

    const urlResult = await engine.invoke({
      toolName: "docs.ingest",
      args: { sourceType: " url ", source: "https://blocked.example/docs.md", namespace: "research" },
      agentId: "agent",
      sessionId: "session-1",
      dryRun: true,
    });
    expect(urlResult.outcome).toBe("blocked");
    expect(urlResult.policyReason).toContain("sourceType must be one of file|url|text");
    expect(urlResult.audit?.reasonCodes).toEqual(["structural_safety_block"]);

    const fileResult = await engine.invoke({
      toolName: "docs.ingest",
      args: { sourceType: " file ", source: "F:/outside/docs.md", namespace: "research" },
      agentId: "agent",
      sessionId: "session-1",
      dryRun: true,
    });
    expect(fileResult.outcome).toBe("blocked");
    expect(fileResult.policyReason).toContain("sourceType must be one of file|url|text");
    expect(fileResult.audit?.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("rejects non-canonical docs.ingest backend values before Firecrawl policy can be skipped", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      {
        ...policyConfig,
        tools: {
          ...policyConfig.tools,
          approvalMode: "bypass",
        },
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["example.com", "firecrawl.example"],
        },
      },
      storage,
    );

    const result = await engine.invoke({
      toolName: "docs.ingest",
      args: {
        sourceType: "url",
        source: "https://example.com/docs.md",
        namespace: "research",
        backend: " firecrawl ",
        firecrawlBaseUrl: "https://firecrawl.example",
      },
      agentId: "agent",
      sessionId: "session-1",
      dryRun: true,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain("backend must be one of native|firecrawl");
    expect(result.audit?.reasonCodes).toEqual(["structural_safety_block"]);

    for (const sourceType of ["file", "text"] as const) {
      const nonUrlResult = await engine.invoke({
        toolName: "docs.ingest",
        args: {
          sourceType,
          source: sourceType === "file" ? "./workspace/docs.md" : "inline docs",
          namespace: "research",
          backend: " firecrawl ",
        },
        agentId: "agent",
        sessionId: "session-1",
        dryRun: true,
      });

      expect(nonUrlResult.outcome).toBe("blocked");
      expect(nonUrlResult.policyReason).toContain("backend must be one of native|firecrawl");
      expect(nonUrlResult.audit?.reasonCodes).toEqual(["structural_safety_block"]);
    }
  });

  it("returns internal tool envelopes for executed requests", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const result = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent",
      sessionId: "session-1",
      trustLevel: "trusted_workspace",
    });

    expect(result.outcome).toBe("executed");
    expect(result.internalCall).toMatchObject({
      version: "v1",
      toolName: "session.status",
      trustLevel: "trusted_workspace",
    });
    expect(result.internalResult).toMatchObject({
      version: "v1",
      toolName: "session.status",
      outcome: "executed",
    });
    expect(result.audit).toMatchObject({
      auditEventId: result.auditEventId,
      toolName: "session.status",
      outcome: "executed",
    });
  });

  it("redacts secret-looking tool arguments before persisting audit records", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await (
      engine as unknown as {
        recordInvocation: (
          auditEventId: string,
          request: {
            toolName: string;
            args: Record<string, unknown>;
            agentId: string;
            sessionId: string;
            taskId?: string;
          },
          outcome: "executed" | "approval_required" | "blocked",
          policyReason: string,
        ) => Promise<void>;
      }
    ).recordInvocation(
      "audit-1",
      {
        toolName: "session.status",
        args: {
          command:
            "DATABASE_URL=mongodb://example.com:27017/myapp API_KEY=sk_test_1234567890abcdefghijklmnop NODE_ENV=production",
        },
        agentId: "agent",
        sessionId: "session-1",
      },
      "executed",
      "allowed",
    );

    expect(vi.mocked(storage.audit.append)).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        args: {
          command: expect.stringContaining("[REDACTED]"),
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(storage.audit.append).mock.calls)).not.toContain(
      "sk_test_1234567890abcdefghijklmnop",
    );
  });
});

describe("ToolPolicyEngine branch-tail coverage", () => {
  it("evaluates structural safety fallbacks for sparse shell, docs, browser, and file requests", async () => {
    const priorFirecrawlBaseUrl = process.env.FIRECRAWL_BASE_URL;
    process.env.FIRECRAWL_BASE_URL = "https://example.com/firecrawl";
    try {
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          tools: {
            ...policyConfig.tools,
            approvalMode: "bypass",
          },
          sandbox: {
            ...policyConfig.sandbox,
            networkAllowlist: [EXAMPLE_HOST, "localhost"],
          },
        },
        createStorageStub(),
      );

      const evaluations = [
        await engine.evaluateAccess({
          toolName: "shell.exec",
          args: { command: 7 },
          agentId: "agent",
          sessionId: "session",
        } as never),
        await engine.evaluateAccess({
          toolName: "fs.move",
          args: { from: "./workspace/from.txt" },
          agentId: "agent",
          sessionId: "session",
        }),
        await engine.evaluateAccess({
          toolName: "docs.ingest",
          args: { sourceType: "url", source: "", backend: "firecrawl" },
          agentId: "agent",
          sessionId: "session",
        }),
        await engine.evaluateAccess({
          toolName: "browser.navigate",
          args: { url: "" },
          agentId: "agent",
          sessionId: "session",
        }),
      ];

      expect(evaluations.map((evaluation) => evaluation.allowed)).toEqual([true, true, true, true]);
      expect(evaluations.every((evaluation) => evaluation.requiresApproval === false)).toBe(true);
    } finally {
      if (priorFirecrawlBaseUrl === undefined) {
        delete process.env.FIRECRAWL_BASE_URL;
      } else {
        process.env.FIRECRAWL_BASE_URL = priorFirecrawlBaseUrl;
      }
    }
  });

  it("marks approved actions failed when policy still allows the request but execution fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockResolvedValue(
        createPendingApprovalAction({
          approvalId: "apr-custom-failure",
          expiresAt: "2026-03-21T00:10:00.000Z",
          request: {
            toolName: "custom.allowed",
            args: {},
            agentId: "agent",
            sessionId: "session",
            taskId: "task-1",
            dryRun: false,
            consentContext: {
              operatorId: "operator-1",
              source: "agent",
              reason: "preapproved",
            },
          },
        }),
      );
      const engine = new ToolPolicyEngine(
        {
          ...policyConfig,
          tools: {
            ...policyConfig.tools,
            approvalMode: "bypass",
          },
        },
        storage,
        createCustomAllowedRegistry(),
      );

      const result = await engine.executeApprovedAction("apr-custom-failure");

      expect(result).toMatchObject({
        outcome: "blocked",
        internalResult: {
          outcome: "blocked",
          errorKind: "execution_error",
        },
      });
      expect(storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
        "apr-custom-failure",
        "failed",
        expect.objectContaining({
          outcome: "blocked",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function createPendingApprovalAction(input: {
  approvalId: string;
  request: Record<string, unknown>;
  createdAt?: string;
  expiresAt?: string;
}): PendingApprovalAction {
  return {
    approvalId: input.approvalId,
    actionType: "tool.invoke",
    request: input.request,
    createdAt: input.createdAt ?? "2026-03-21T00:00:00.000Z",
    expiresAt: input.expiresAt,
    resolutionStatus: "pending",
  };
}

function createPermissionProfile(input: {
  approvalMode: PermissionProfileRecord["approvalMode"];
  toolPatterns: string[];
}): PermissionProfileRecord {
  return {
    profileId: "profile-code-mode-test",
    label: "Code Mode Test",
    builtin: false,
    status: "active",
    scope: "operator",
    approvalMode: input.approvalMode,
    toolPatterns: input.toolPatterns,
    allow: [],
    deny: [],
    createdBy: "operator-1",
    createdAt: "2026-03-21T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
  };
}
