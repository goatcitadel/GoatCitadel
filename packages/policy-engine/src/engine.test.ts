import { describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

function createStorageStub(): Storage {
  return {
    toolAccessDecisions: {
      record: vi.fn(),
    },
    toolGrants: {
      list: vi.fn(() => []),
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
});
