import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";

function createStorageStub(): Storage & AsyncStorage {
  return {
    approvals: {
      create: vi.fn(),
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
      listActive: vi.fn(() => []),
      consumeOne: vi.fn(),
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
  } as unknown as Storage & AsyncStorage;
}

function createConfig(overrides: Partial<ToolPolicyConfig> = {}): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist: ["localhost"],
      riskyShellPatterns: ["rm -rf"],
      requireApprovalForRiskyShell: true,
    },
    ...overrides,
  };
}

type EngineWithBranchPrivates = {
  evaluateAccess(request: ToolInvokeRequest): {
    allowed: boolean;
    policyReason: string;
  };
  evaluateShellRisk(request: ToolInvokeRequest): { risky: true; matchedPattern: string } | undefined;
  executeAllowedRequest(
    request: ToolInvokeRequest,
    auditEventId: string,
    policyReason: string,
  ): Promise<{
    outcome: string;
    audit?: {
      startedAt?: string;
      completedAt?: string;
    };
  }>;
  recordDangerProfileNetworkBypassIfNeeded(auditEventId: string, request: ToolInvokeRequest): Promise<void>;
};

describe("ToolPolicyEngine loop 15 branch tails", () => {
  afterEach(() => {
    vi.doUnmock("./sandbox/shell-risk-gate.js");
    vi.resetModules();
  });

  it("uses completed time when an allowed request is executed without an explicit start time", async () => {
    const { ToolPolicyEngine } = await import("./engine.js");
    const engine = new ToolPolicyEngine(createConfig(), createStorageStub()) as unknown as EngineWithBranchPrivates;

    const result = await engine.executeAllowedRequest(
      {
        toolName: "session.status",
        args: {},
        agentId: "agent",
        sessionId: "session",
      },
      "audit-success-fallback",
      "allowed by loop15 test",
    );

    expect(result.outcome).toBe("executed");
    expect(result.audit?.startedAt).toBe(result.audit?.completedAt);
  }, 30_000);

  it("uses completed time when a runtime failure is recorded without an explicit start time", async () => {
    const { ToolPolicyEngine } = await import("./engine.js");
    const engine = new ToolPolicyEngine(
      createConfig({
        tools: { profile: "danger", approvalMode: "bypass", allow: [], deny: [] },
      }),
      createStorageStub(),
    ) as unknown as EngineWithBranchPrivates;

    const result = await engine.executeAllowedRequest(
      {
        toolName: "custom.unsupported",
        args: {},
        agentId: "agent",
        sessionId: "session",
      },
      "audit-error-fallback",
      "allowed by loop15 test",
    );

    expect(result.outcome).toBe("blocked");
    expect(result.audit?.startedAt).toBe(result.audit?.completedAt);
  });

  it("treats an omitted approval mode on the danger profile as bypass audit eligible", async () => {
    const { ToolPolicyEngine } = await import("./engine.js");
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(createConfig(), storage) as unknown as EngineWithBranchPrivates;

    await engine.recordDangerProfileNetworkBypassIfNeeded("audit-default-mode", {
      toolName: "http.post",
      args: { url: "https://blocked.example.test/api" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(storage.audit.append).toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({
        event: "approval_bypass_mode_network_target",
        auditEventId: "audit-default-mode",
        toolName: "http.post",
        targets: [
          expect.objectContaining({
            hostname: "blocked.example.test",
          }),
        ],
      }),
    );
  });

  it("falls back to an unknown shell pattern label when a risky classifier omits the match", async () => {
    vi.doMock("./sandbox/shell-risk-gate.js", () => ({
      classifyShellRisk: vi.fn(() => ({ risky: true })),
    }));
    const { ToolPolicyEngine } = await import("./engine.js");
    const engine = new ToolPolicyEngine(createConfig(), createStorageStub()) as unknown as EngineWithBranchPrivates;

    const shellRisk = engine.evaluateShellRisk({
      toolName: "shell.exec",
      args: { command: "rm -rf ./workspace/tmp" },
      agentId: "agent",
      sessionId: "session",
    });

    expect(shellRisk).toEqual({ risky: true, matchedPattern: "unknown" });
  });
});
