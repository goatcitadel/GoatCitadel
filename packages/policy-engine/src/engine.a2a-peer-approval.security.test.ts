import { describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

// Regression coverage: an inbound A2A peer turn runs tool calls with
// `authActorSource: "a2a_peer"` (a2a-route-service.ts). A remote peer must NOT be
// able to ride the local operator's global `bypass` approval mode to auto-execute
// risky/danger tools. Approval (or an explicit scoped grant) is required regardless
// of the operator's blanket bypass. The operator's own calls are unaffected.

function createStorageStub(): Storage & AsyncStorage {
  return {
    approvals: {
      create: vi.fn((input) => ({
        approvalId: "approval-1",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-06-02T00:00:00.000Z",
        explanationStatus: "not_requested",
      })),
      get: vi.fn(() => undefined),
    },
    approvalEvents: { append: vi.fn() },
    audit: { append: vi.fn(async () => undefined) },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: { list: vi.fn(() => []), listActive: vi.fn(() => []), consumeOne: vi.fn(() => true) },
    pendingApprovalActions: {
      upsertPending: vi.fn(),
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
    },
    db: { prepare: vi.fn(() => ({ run: vi.fn() })) },
  } as unknown as Storage & AsyncStorage;
}

function buildConfig(approvalMode: "approve_risky" | "bypass"): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", approvalMode, allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist: ["localhost"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  } as ToolPolicyConfig;
}

const DANGER_TOOL = "fs.write";
const DANGER_ARGS = { path: "./workspace/out.txt", content: "x" };

describe("A2A peer cannot ride operator bypass for danger tools", () => {
  it("requires approval for an a2a_peer danger tool even when the operator runs bypass mode", async () => {
    const engine = new ToolPolicyEngine(buildConfig("bypass"), createStorageStub());

    const evaluation = await engine.evaluateAccess({
      toolName: DANGER_TOOL,
      args: DANGER_ARGS,
      agentId: "agent",
      sessionId: "session",
      policyContext: { authActorSource: "a2a_peer" },
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("still auto-approves the operator's own danger tool under bypass mode (fix is scoped to peers)", async () => {
    const engine = new ToolPolicyEngine(buildConfig("bypass"), createStorageStub());

    const evaluation = await engine.evaluateAccess({
      toolName: DANGER_TOOL,
      args: DANGER_ARGS,
      agentId: "agent",
      sessionId: "session",
      policyContext: { authActorSource: "loopback" },
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(false);
  });

  it("requires approval for an a2a_peer danger tool under the shipped approve_risky default", async () => {
    const engine = new ToolPolicyEngine(buildConfig("approve_risky"), createStorageStub());

    const evaluation = await engine.evaluateAccess({
      toolName: DANGER_TOOL,
      args: DANGER_ARGS,
      agentId: "agent",
      sessionId: "session",
      policyContext: { authActorSource: "a2a_peer" },
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.requiresApproval).toBe(true);
  });
});
