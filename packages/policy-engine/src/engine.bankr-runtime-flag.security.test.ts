import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@goatcitadel/storage";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "./engine.js";

// Regression coverage for CODEX_FINDING #31: the Bankr feature flag was
// previously read once at engine constructor time and used to decide
// whether Bankr tool definitions appeared in the registry. If the
// gateway started with the flag OFF and an operator toggled it ON via
// /api/v1/settings, the engine's feature-flag deny stopped firing but
// `toolDef` for `bankr.write` remained undefined — so the risk
// classifier fell back to `riskLevel: "caution"` and
// `requiresApproval: false`, and the executor ran the write tool with
// no approval. The fix always includes Bankr in the registry and gates
// callability lazily.

function buildConfig(): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", approvalMode: "approve_risky", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: false,
    },
  } as ToolPolicyConfig;
}

function createStorageStub(): Storage {
  return {
    approvals: {
      create: vi.fn((input) => ({
        approvalId: "approval-bankr",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-05-18T00:00:00.000Z",
        expiresAt: input.expiresAt,
        explanationStatus: "not_requested",
      })),
    },
    approvalEvents: { append: vi.fn() },
    audit: { append: vi.fn(async () => undefined) },
    db: { prepare: vi.fn(() => ({ run: vi.fn() })) },
    pendingApprovalActions: {
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
      upsertPending: vi.fn(),
    },
    toolAccessDecisions: {
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
      record: vi.fn(),
    },
    toolGrants: {
      consumeOne: vi.fn(),
      list: vi.fn(() => []),
    },
  } as unknown as Storage;
}

describe("Bankr runtime feature flag (codex #31)", () => {
  it("denies bankr.write when flag is permanently off", async () => {
    const engine = new ToolPolicyEngine(buildConfig(), createStorageStub(), undefined, {
      isBankrBuiltinEnabled: () => false,
    });
    const decision = engine.evaluateAccess({
      toolName: "bankr.write",
      args: { actionType: "transfer", prompt: "send 50 USDC to 0xabc" },
      agentId: "agent-1",
      sessionId: "session-1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain("bankr_builtin_disabled");
  });

  it("requires approval for bankr.write when flag is toggled on AFTER construction", async () => {
    let flagState = false;
    const engine = new ToolPolicyEngine(buildConfig(), createStorageStub(), undefined, {
      isBankrBuiltinEnabled: () => flagState,
    });
    // Flag is initially false → bankr.write is denied.
    expect(
      engine.evaluateAccess({
        toolName: "bankr.write",
        args: { actionType: "transfer", prompt: "send 50 USDC to 0xabc" },
        agentId: "agent-1",
        sessionId: "session-1",
      }).allowed,
    ).toBe(false);

    // Operator toggles the flag on.
    flagState = true;
    const decision = engine.evaluateAccess({
      toolName: "bankr.write",
      args: { actionType: "transfer", prompt: "send 50 USDC to 0xabc" },
      agentId: "agent-1",
      sessionId: "session-1",
    });

    // CRITICAL: after toggle, bankr.write must NOT silently execute. The
    // approval / risk metadata must come from toolDef, not from a
    // default-fallback. We accept either:
    //   (a) allowed=true with requiresApproval=true (operator must approve), or
    //   (b) allowed=false (some other policy gate denies, also safe).
    // We REJECT the codex-#31 attack scenario: allowed=true with
    // requiresApproval=false (the bypass that ran writes without approval).
    if (decision.allowed) {
      expect(decision.requiresApproval).toBe(true);
      expect(decision.riskLevel).not.toBe("safe");
    }
  });

  it("includes bankr.write in the catalog only when the flag is on", () => {
    let flagState = false;
    const engine = new ToolPolicyEngine(buildConfig(), createStorageStub(), undefined, {
      isBankrBuiltinEnabled: () => flagState,
    });
    const offCatalog = engine.listCatalog();
    expect(offCatalog.find((tool) => tool.toolName === "bankr.write")).toBeUndefined();

    flagState = true;
    const onCatalog = engine.listCatalog();
    expect(onCatalog.find((tool) => tool.toolName === "bankr.write")).toBeDefined();
  });
});
