import { describe, expect, it, vi } from "vitest";
import type { PendingApprovalAction, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

function createStorageStub(): Storage {
  return {
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: {
      list: vi.fn(() => []),
    },
    pendingApprovalActions: {
      find: vi.fn(() => undefined),
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
