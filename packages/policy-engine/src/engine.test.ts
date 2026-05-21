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
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { ToolRegistry } from "./tool-registry.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function createStorageStub(): Storage {
  return {
    approvals: {
      create: vi.fn((input) => ({
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
      get: vi.fn((approvalId: string) => createApprovalRequest({ approvalId, status: "approved" })),
    },
    approvalEvents: {
      append: vi.fn(),
    },
    audit: {
      append: vi.fn(async () => undefined),
    },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: {
      list: vi.fn(() => []),
      consumeOne: vi.fn(() => true),
    },
    pendingApprovalActions: {
      upsertPending: vi.fn(),
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
    },
    db: {
      prepare: vi.fn(() => ({
        run: vi.fn(),
      })),
    },
  } as unknown as Storage;
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

describe("ToolPolicyEngine grants", () => {
  it("passes grant list, create, and revoke operations through to storage", () => {
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

  it("uses active grant decision listing so older active denies still win", () => {
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

    const evaluation = engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_deny"]);
    expect(evaluation.matchedGrantId).toBe("grant-old-deny");
  });

  it("uses uncapped fallback grant decision listing so older active denies still win", () => {
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

    const evaluation = engine.evaluateAccess({
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

  it("selects the first allow grant whose constraints match the request", () => {
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

    const evaluation = engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "https://example.com/docs" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.matchedGrantId).toBe("grant-older-matching-host");
  });

  it("uses explicit allow grants to suppress repeat approval prompts for the granted tool", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
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

    const evaluation = engine.evaluateAccess({
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

  it("allows operator-enabled full public web access without opening private hosts", () => {
    const engine = new ToolPolicyEngine(policyConfig, createStorageStub());

    expect(
      engine.evaluateAccess({
        toolName: "browser.navigate",
        args: { url: "https://example.com/docs" },
        agentId: "agent",
        sessionId: "session",
        policyContext: { fullWebAccess: true },
      }).allowed,
    ).toBe(true);

    const privateEvaluation = engine.evaluateAccess({
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

describe("ToolPolicyEngine invocation coverage", () => {
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
      vi.mocked(storage.pendingApprovalActions.find).mockImplementation((approvalId: string) =>
        approvalId === "apr-direct" ? pending : undefined,
      );
      vi.mocked(storage.pendingApprovalActions.markResolved).mockImplementation(
        (approvalId, resolutionStatus, result) => {
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
          status: "ok",
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
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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

    expect(storage.approvals.create).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          target: "https://example.com/api",
        }),
      }),
    );
    expect(storage.approvals.create).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          command: "echo hello",
        }),
      }),
    );
  });
});

describe("ToolPolicyEngine approval bypass safety", () => {
  it("still bypasses ordinary danger approvals when policy explicitly allows bypass mode", () => {
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

    const evaluation = engine.evaluateAccess({
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

  it("keeps outside-root reads approval-gated even when normal approvals are bypassed", () => {
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

    const evaluation = engine.evaluateAccess({
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
  it("reports explicit policy denies, unknown tools, and profile disallows", () => {
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
      denyEngine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
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
      unknownEngine.evaluateAccess({
        toolName: "custom.unknown",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
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
      wildcardEngine.evaluateAccess({
        toolName: "custom.unknown",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["unknown_tool"]);

    expect(
      wildcardEngine.evaluateAccess({
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
      }).reasonCodes,
    ).toEqual(["unknown_tool"]);

    const disallowEngine = new ToolPolicyEngine(emptyProfileConfig, createStorageStub());
    expect(
      disallowEngine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["policy_disallow"]);
  });

  it("marks approve-all, nuclear, and risky shell requests for approval", () => {
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
      approveAllEngine.evaluateAccess({
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
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
      shellEngine.evaluateAccess({
        toolName: "shell.exec",
        args: { command: "rm -rf ./workspace/tmp" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toContain("shell_risky_requires_approval");
    expect(
      shellEngine.evaluateAccess({
        toolName: "shell.exec",
        args: { command: "   " },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);
  });

  it("filters inactive grants before selecting the active scoped fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
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

      const evaluation = engine.evaluateAccess({
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

  it("applies read-path and grant candidate extraction edge cases", () => {
    const docsEngine = new ToolPolicyEngine(policyConfig, createStorageStub());
    expect(
      docsEngine.evaluateAccess({
        toolName: "docs.ingest",
        args: { sourceType: "file", source: "F:/outside/project/spec.md", namespace: "docs" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      docsEngine.evaluateAccess({
        toolName: "fs.copy",
        args: { from: "F:/outside/project/spec.md", to: "./workspace/spec.md" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      docsEngine.evaluateAccess({
        toolName: "fs.copy",
        args: { from: "./workspace/spec.md", to: "F:/outside/project/spec.md" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      docsEngine.evaluateAccess({
        toolName: "fs.move",
        args: { from: "F:/outside/project/spec.md", to: "./workspace/spec.md" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      docsEngine.evaluateAccess({
        toolName: "browser.screenshot",
        args: { url: "http://localhost/app", outputPath: "F:/outside/project/shot.png" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);
    expect(
      docsEngine.evaluateAccess({
        toolName: "browser.interact",
        args: {
          url: "http://localhost/app",
          outputPath: "F:/outside/project/interact.json",
          steps: [{ action: "click", selector: "button" }],
        },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["structural_safety_block"]);

    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
      },
      storage,
    );

    expect(
      grantEngine.evaluateAccess({
        toolName: "http.get",
        agentId: "agent",
        sessionId: "session",
      } as never).allowed,
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
      rootsEngine.evaluateAccess({
        toolName: "fs.read",
        args: { path: "./workspace/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
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
      fullDiskEngine.evaluateAccess({
        toolName: "fs.read",
        args: { path: "F:/outside/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
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

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([{ ...hostGrant, constraints: { allowedHosts: [""] } }]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { host: API_EXAMPLE_HOST },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([{ ...hostGrant, constraints: { allowedHosts: ["*"] } }]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { host: API_EXAMPLE_HOST },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      { ...hostGrant, constraints: { allowedHosts: [API_EXAMPLE_HOST] } },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { host: API_EXAMPLE_HOST },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      {
        ...hostGrant,
        grantId: "grant-browser-storage-host",
        toolPattern: "browser.storage.set",
        constraints: { allowedHosts: ["allowed.example"] },
      },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "browser.storage.set",
        args: { origin: "https://blocked.example" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      {
        ...hostGrant,
        grantId: "grant-browser-cookie-host",
        toolPattern: "browser.cookies.set",
        constraints: { allowedHosts: ["allowed.example"] },
      },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "browser.cookies.set",
        args: { cookies: [{ name: "sid", value: "1", domain: ".blocked.example" }] },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      {
        ...hostGrant,
        grantId: "grant-gmail-fixed-host",
        toolPattern: "gmail.read",
        constraints: { allowedHosts: ["other.example"] },
      },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "gmail.read",
        args: { connectionId: "gmail-connection" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      {
        ...hostGrant,
        grantId: "grant-calendar-fixed-host",
        toolPattern: "calendar.list",
        constraints: { allowedHosts: ["www.googleapis.com"] },
      },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "calendar.list",
        args: { connectionId: "calendar-connection" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    vi.mocked(hostStorage.toolGrants.list).mockReturnValue([
      {
        ...hostGrant,
        constraints: {
          allowedPaths: [null as unknown as string],
        },
      },
    ]);
    expect(
      hostEngine.evaluateAccess({
        toolName: "http.get",
        args: { path: "./workspace/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
  });

  it("covers unknown in-profile grants and approved action payload parsing", async () => {
    const customStorage = createStorageStub();
    vi.mocked(customStorage.toolGrants.list).mockReturnValue([
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
      customEngine.evaluateAccess({
        toolName: "custom.allowed",
        args: { path: "./reference/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(false);

    const registeredCustomEngine = new ToolPolicyEngine(policyConfig, customStorage, createCustomAllowedRegistry());
    expect(
      registeredCustomEngine.evaluateAccess({
        toolName: "custom.allowed",
        args: { path: "./reference/note.txt" },
        agentId: "agent",
        sessionId: "session",
      }).allowed,
    ).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
          status: "ok",
        },
      });

      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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

      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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

    expect(storage.approvals.create).toHaveBeenCalledWith(
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

  it("records the bypass network audit event for public targets that would otherwise need approval", async () => {
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
        toolName: "http.get",
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

  it("covers approval, read-candidate, and bypass-network defensive defaults", async () => {
    const approvalStorage = createStorageStub();
    vi.mocked(approvalStorage.approvals.create).mockImplementation((input) => ({
      approvalId: "approval-without-expiry",
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      payload: input.payload,
      preview: input.preview,
      createdAt: "2026-03-22T12:00:00.000Z",
      expiresAt: undefined,
      explanationStatus: "not_requested",
    }));
    const approvalEngine = new ToolPolicyEngine(policyConfig, approvalStorage);

    await approvalEngine.invoke({
      toolName: "shell.exec",
      args: { command: "echo approval" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(approvalStorage.pendingApprovalActions.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: expect.any(String),
      }),
    );

    const readCandidates = approvalEngine as unknown as {
      validateStructuralSafety: (request: {
        toolName: string;
        args: Record<string, unknown>;
        agentId: string;
        sessionId: string;
      }) => string | undefined;
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
      readCandidates.validateStructuralSafety({
        toolName: "fs.read",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }),
    ).toBeUndefined();
    expect(
      readCandidates.validateStructuralSafety({
        toolName: "fs.copy",
        args: {},
        agentId: "agent",
        sessionId: "session",
      }),
    ).toBeUndefined();
    expect(
      readCandidates.validateStructuralSafety({
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
    expect(bypassStorage.audit.append).not.toHaveBeenCalled();
  });
});

describe("ToolPolicyEngine outside-root read access", () => {
  it("blocks browser navigation to public hosts when they are not allowlisted even in bypass mode", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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

    const evaluation = engine.evaluateAccess({
      toolName: "browser.navigate",
      args: { url: "https://apnews.com/oddities" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.requiresApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("structural_safety_block");
  });

  it("still blocks metadata hosts under the danger profile", () => {
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

    const evaluation = engine.evaluateAccess({
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

  it("requires at least one native browser.search host when native fallback can run", async () => {
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

    expect(nativeResult.outcome).toBe("blocked");
    expect(nativeResult.policyReason).toContain("browser.search requires at least one native search host");
    expect(firecrawlFallbackResult.outcome).toBe("blocked");
    expect(firecrawlFallbackResult.policyReason).toContain("browser.search requires at least one native search host");
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

  it("does not audit public-host bypasses because bypass mode preserves the network allowlist", async () => {
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

    vi.mocked(storage.toolGrants.list).mockReturnValue([
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

    expect(result.outcome).toBe("blocked");
    expect(vi.mocked(storage.audit.append)).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
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
      expect(vi.mocked(storage.approvals.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: "2026-03-22T12:15:00.000Z",
        }),
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

  it("requires approval when readAccessMode is approval_required and a file is outside trusted roots", () => {
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
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("outside_roots_read_requires_approval");
  });

  it("allows outside-root reads when a scoped grant includes a wildcard allowed path", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("allows outside-root file reads when a later scoped grant covers the path", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
    const evaluation = engine.evaluateAccess({
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
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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

    const evaluation = engine.evaluateAccess({
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
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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

    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: path.join(linkPath, "secret.txt"), startLine: 1, endLine: 1 },
      agentId: "agent",
      sessionId: "session",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_constraints_block"]);
  });

  it("allows approved read-only reference roots without approval churn", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/code/claude-code/src/index.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("does not allow approved read-only reference roots to escape through parent segments", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/code/claude-code/../private/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("does not bypass outside-root read approval with a forged approval id", () => {
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
    const evaluation = engine.evaluateAccess({
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

  it("allows outside-root reads only when the approval id matches an approved row and fresh pending action request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      const evaluation = engine.evaluateAccess({
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

  it("does not bypass outside-root read approval when the matching approval row is not approved", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.approvals.get).mockReturnValue(
        createApprovalRequest({
          approvalId: "apr-pending",
          status: "pending",
        }),
      );
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      const evaluation = engine.evaluateAccess({
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

  it("does not bypass outside-root read approval when run lineage differs from the approved request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      const evaluation = engine.evaluateAccess({
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

  it("does not let a verified approval bypass roots-only read posture", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    const storage = createStorageStub();
    try {
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      const evaluation = engine.evaluateAccess({
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

  it("rejects outside-root approval bypasses after expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:20:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      const evaluation = engine.evaluateAccess({
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

  it("rejects outside-root approval bypasses after the pending action is resolved", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue({
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
      const evaluation = engine.evaluateAccess({
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

  it("allows legacy pending approval bypasses only inside the default ttl from createdAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:14:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      const evaluation = engine.evaluateAccess({
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
      const expiredEvaluation = engine.evaluateAccess({
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

  it("rejects pending approval bypasses with invalid explicit expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      const evaluation = engine.evaluateAccess({
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
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
      expect(storage.audit.append).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores missing and unsupported pending approval actions", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    await expect(engine.executeApprovedAction("missing")).resolves.toBeUndefined();

    vi.mocked(storage.pendingApprovalActions.find).mockReturnValue({
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
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
          status: "ok",
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

  it("can defer approved external-runtime resolution to the caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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

  it("can replay an approved dry-run pending action as an external runtime execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T00:05:00.000Z"));
    try {
      const storage = createStorageStub();
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
  it("treats task-scoped grants as first mutation per task instead of per session", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
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
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockImplementation((input) => {
      expect(input.scope).toBe("task");
      expect(input.taskId).toBe("task-2");
      return 0;
    });
    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/output.txt", content: "hello" },
      agentId: "agent",
      sessionId: "session-1",
      taskId: "task-2",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("treats workspace-scoped grants as first mutation per workspace instead of global", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
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
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockImplementation((input) => {
      expect(input.scope).toBe("workspace");
      expect(input.workspaceId).toBe("workspace-1");
      return 0;
    });

    const engine = new ToolPolicyEngine(policyConfig, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "./workspace/output.txt", content: "hello" },
      agentId: "agent",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("lets matching denies beat allows across scopes", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
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
    const evaluation = engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session-1",
      taskId: "task-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("grant_deny");
  });

  it("blocks privileged execution when the request trust level is untrusted_external", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const evaluation = engine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "echo hello" },
      agentId: "agent",
      sessionId: "session-1",
      trustLevel: "untrusted_external",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("untrusted_source_privileged_tool_block");
  });

  it("blocks privileged execution when source attribution is untrusted even without a top-level trust level", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const shellEvaluation = engine.evaluateAccess({
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
    const writeEvaluation = engine.evaluateAccess({
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

  it("blocks writes into read-only reference roots even when granted", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
    const evaluation = engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: "F:/code/claude-code/README.md", content: "mutate" },
      agentId: "agent",
      sessionId: "session-1",
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("grant_constraints_block");
  });

  it("blocks scoped grants when mutation, rate, host, and path constraints fail", () => {
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

    vi.mocked(storage.toolGrants.list).mockReturnValue([{ ...grantBase, constraints: { mutationAllowed: false } }]);
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    for (const [toolName, args] of [
      ["fs.copy", { from: "./workspace/in.txt", to: "./workspace/out.txt" }],
      ["documents.create", { path: "./workspace/report.md", title: "Report", body: "x" }],
      ["channel.send", { connectionId: "conn-1", channelId: "chan-1", text: "hello" }],
    ] as const) {
      vi.mocked(storage.toolGrants.list).mockReturnValue([
        { ...grantBase, toolPattern: toolName, constraints: { mutationAllowed: false } },
      ]);
      expect(
        engine.evaluateAccess({
          toolName,
          args,
          agentId: "agent",
          sessionId: "session-1",
        }).reasonCodes,
      ).toEqual(["grant_constraints_block"]);
    }

    vi.mocked(storage.toolGrants.list).mockReturnValue([{ ...grantBase, constraints: { maxCallsPerHour: 1 } }]);
    vi.mocked(storage.toolAccessDecisions.countToolCallsInLastHourInScope).mockReturnValueOnce(1);
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([{ ...grantBase, constraints: { maxWritesPerHour: 1 } }]);
    vi.mocked(storage.toolAccessDecisions.countWritesInLastHourInScope).mockReturnValueOnce(1);
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      { ...grantBase, toolPattern: "http.post", constraints: { maxWritesPerHour: 1 } },
    ]);
    vi.mocked(storage.toolAccessDecisions.countWritesInLastHourInScope).mockReturnValueOnce(1);
    expect(
      engine.evaluateAccess({
        toolName: "http.post",
        args: { url: "https://example.com/api", body: { ok: true } },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([
      { ...grantBase, constraints: { allowedPaths: ["./workspace/allowed"] } },
    ]);
    const allowedPathEvaluation = engine.evaluateAccess({
      toolName: "fs.write",
      args: { path: path.resolve("./workspace/allowed/out.txt"), content: "x" },
      agentId: "agent",
      sessionId: "session-1",
    });
    expect(allowedPathEvaluation.reasonCodes).toContain("allowed");
    expect(
      engine.evaluateAccess({
        toolName: "fs.write",
        args: { path: "./workspace/blocked/out.txt", content: "x" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);

    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
      engine.evaluateAccess({
        toolName: "http.get",
        args: { url: "https://blocked.example/path" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
    ).toEqual(["grant_constraints_block"]);
  });

  it("applies scoped grant constraints to safe tools", () => {
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

    vi.mocked(storage.toolGrants.list).mockReturnValue([
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

    const evaluation = engine.evaluateAccess({
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

    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
      engine.evaluateAccess({
        toolName: "docs.ingest",
        args: { sourceType: "url", source: "https://blocked.example/docs.md", namespace: "research" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
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

    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
      engine.evaluateAccess({
        toolName: "docs.ingest",
        args: { sourceType: "file", source: "./workspace/blocked/docs.md", namespace: "research" },
        agentId: "agent",
        sessionId: "session-1",
      }).reasonCodes,
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

  it("allows docs.ingest file sources when a later scoped grant covers the source path", () => {
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

    vi.mocked(storage.toolGrants.list).mockReturnValue([
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

    const evaluation = engine.evaluateAccess({
      toolName: "docs.ingest",
      args: { sourceType: "file", source: "F:/outside/docs/brief.md", namespace: "research" },
      agentId: "agent",
      sessionId: "session-1",
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.matchedGrantId).toBe("grant-doc-file");
    expect(evaluation.reasonCodes).toContain("approval_bypass_mode");
  });

  it("applies scoped grant path constraints to browser output paths", () => {
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
      vi.mocked(storage.toolGrants.list).mockReturnValue([
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

      const evaluation = engine.evaluateAccess({
        toolName,
        args,
        agentId: "agent",
        sessionId: "session-1",
      });

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.reasonCodes).toEqual(["grant_constraints_block"]);
    }
  });

  it("requires explicit browser screenshot output paths for path-scoped grants", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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

    const evaluation = engine.evaluateAccess({
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
    vi.mocked(storage.toolGrants.list).mockReturnValue([
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
  it("evaluates structural safety fallbacks for sparse shell, docs, browser, and file requests", () => {
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
        engine.evaluateAccess({
          toolName: "shell.exec",
          args: { command: 7 },
          agentId: "agent",
          sessionId: "session",
        } as never),
        engine.evaluateAccess({
          toolName: "fs.move",
          args: { from: "./workspace/from.txt" },
          agentId: "agent",
          sessionId: "session",
        }),
        engine.evaluateAccess({
          toolName: "docs.ingest",
          args: { sourceType: "url", source: "", backend: "firecrawl" },
          agentId: "agent",
          sessionId: "session",
        }),
        engine.evaluateAccess({
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
      vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
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
