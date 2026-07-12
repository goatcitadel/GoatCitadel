import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@goatcitadel/storage";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "./engine.js";

// Regression coverage for CODEX_FINDING #16: MCP invocations bypass per-call
// approval via dry-run. The fix moves the `dryRun` short-circuit to fire
// AFTER the `requiresApproval` branch — so any request that would
// normally require approval surfaces as `approval_required` even when
// `dryRun: true`, instead of leaking through as `outcome: "executed"`.

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
        approvalId: "approval-dry-run",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-05-18T00:00:00.000Z",
        expiresAt: input.expiresAt,
        explanationStatus: "not_requested",
      })),
      createWithTtlDuration: vi.fn((input, ttlMs) => ({
        approvalId: "approval-dry-run",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
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
      listActive: vi.fn(() => []),
    },
  } as unknown as Storage;
}

describe("dry-run vs approval-required (codex #16)", () => {
  it("returns approval_required (not executed) when a dryRun request would require approval", async () => {
    const engine = new ToolPolicyEngine(buildConfig(), createStorageStub());
    const result = await engine.invoke({
      toolName: "mcp.invoke",
      args: { server: "x", tool: "y" },
      agentId: "agent-1",
      sessionId: "session-1",
      dryRun: true,
    });
    expect(result.outcome).toBe("approval_required");
  });

  it("returns executed with dryRun metadata when the request does NOT require approval", async () => {
    const engine = new ToolPolicyEngine(buildConfig(), createStorageStub());
    const result = await engine.invoke({
      toolName: "session.status",
      args: {},
      agentId: "agent-1",
      sessionId: "session-1",
      dryRun: true,
    });
    expect(result.outcome).toBe("executed");
    expect((result as { result?: { dryRun?: boolean } }).result?.dryRun).toBe(true);
  });
});
