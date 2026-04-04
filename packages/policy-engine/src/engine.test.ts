import { describe, expect, it, vi } from "vitest";
import type { PendingApprovalAction, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

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
    },
    pendingApprovalActions: {
      upsertPending: vi.fn(),
      find: vi.fn(() => undefined),
    },
    db: {
      prepare: vi.fn(() => ({
        run: vi.fn(),
      })),
    },
  } as unknown as Storage;
}

const policyConfig: ToolPolicyConfig = {
  profiles: {
    danger: ["*"],
  },
  tools: {
    profile: "danger",
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

describe("ToolPolicyEngine bankr migration gating", () => {
  it("blocks bankr tools when built-in support is disabled", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, {
      isBankrBuiltinEnabled: () => false,
    });
    const evaluation = engine.evaluateAccess({
      toolName: "bankr.write",
      args: {},
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("bankr_builtin_disabled");
  });

  it("hides bankr tools from catalog when built-in support is disabled", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, {
      isBankrBuiltinEnabled: () => false,
    });
    const catalog = engine.listCatalog();
    expect(catalog.some((tool) => tool.toolName.startsWith("bankr."))).toBe(false);
  });
});

describe("ToolPolicyEngine outside-root read access", () => {
  it("persists a default approval expiry when a tool action is gated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
    try {
      const storage = createStorageStub();
      const engine = new ToolPolicyEngine({
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          readAccessMode: "approval_required",
        },
      }, storage);

      const result = await engine.invoke({
        toolName: "file.read_range",
        args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
        agentId: "agent",
        sessionId: "session",
      });

      expect(result.outcome).toBe("approval_required");
      expect(result.expiresAt).toBe("2026-03-22T12:15:00.000Z");
      expect(vi.mocked(storage.approvals.create)).toHaveBeenCalledWith(expect.objectContaining({
        expiresAt: "2026-03-22T12:15:00.000Z",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires approval when readAccessMode is approval_required and a file is outside trusted roots", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine({
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        readAccessMode: "approval_required",
      },
    }, storage);
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
    const engine = new ToolPolicyEngine({
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        readAccessMode: "approval_required",
      },
    }, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/outside/project/file.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
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
    const engine = new ToolPolicyEngine({
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        readAccessMode: "approval_required",
      },
    }, storage);
    const evaluation = engine.evaluateAccess({
      toolName: "file.read_range",
      args: { path: "F:/code/claude-code/src/index.ts", startLine: 1, endLine: 5 },
      agentId: "agent",
      sessionId: "session",
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("does not bypass outside-root read approval with a forged approval id", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine({
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        readAccessMode: "approval_required",
      },
    }, storage);
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

  it("allows outside-root reads only when the approval id matches the pending approved action request", () => {
    const storage = createStorageStub();
    vi.mocked(storage.pendingApprovalActions.find).mockReturnValue(
      createPendingApprovalAction({
        approvalId: "apr-123",
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
    const engine = new ToolPolicyEngine({
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        readAccessMode: "approval_required",
      },
    }, storage);
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
  });
});

describe("ToolPolicyEngine scoped mutation gating", () => {
  it("treats task-scoped grants as first mutation per task instead of per session", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
      if (scope === "task" && scopeRef === "task-2") {
        return [{
          grantId: "grant-task-2",
          toolPattern: "fs.write",
          decision: "allow",
          scope: "task",
          scopeRef: "task-2",
          grantType: "persistent",
          createdBy: "test",
          createdAt: new Date().toISOString(),
        }];
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

  it("lets matching denies beat allows across scopes", () => {
    const storage = createStorageStub();
    vi.mocked(storage.toolGrants.list).mockImplementation((scope, scopeRef) => {
      if (scope === "session" && scopeRef === "session-1") {
        return [{
          grantId: "grant-session-allow",
          toolPattern: "shell.exec",
          decision: "allow",
          scope,
          scopeRef,
          grantType: "persistent",
          createdBy: "test",
          createdAt: new Date().toISOString(),
        }];
      }
      if (scope === "task" && scopeRef === "task-1") {
        return [{
          grantId: "grant-task-deny",
          toolPattern: "shell.exec",
          decision: "deny",
          scope,
          scopeRef,
          grantType: "persistent",
          createdBy: "test",
          createdAt: new Date().toISOString(),
        }];
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

    await (engine as unknown as {
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
    }).recordInvocation("audit-1", {
      toolName: "session.status",
      args: {
        command: "DATABASE_URL=mongodb://example.com:27017/myapp API_KEY=sk_test_1234567890abcdefghijklmnop NODE_ENV=production",
      },
      agentId: "agent",
      sessionId: "session-1",
    }, "executed", "allowed");

    expect(vi.mocked(storage.audit.append)).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        args: {
          command: expect.stringContaining("[REDACTED]"),
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(storage.audit.append).mock.calls)).not.toContain("sk_test_1234567890abcdefghijklmnop");
  });
});

function createPendingApprovalAction(input: {
  approvalId: string;
  request: Record<string, unknown>;
}): PendingApprovalAction {
  return {
    approvalId: input.approvalId,
    actionType: "tool.invoke",
    request: input.request,
    createdAt: "2026-03-21T00:00:00.000Z",
    resolutionStatus: "pending",
  };
}
