import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { SCHEDULED_RESTRICTED_PROFILE } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

/**
 * Anti-recursion invariant (P1-F2): under the `scheduled-restricted` profile a
 * scheduled turn's `schedule.manage` call must surface as `approval_required`
 * (never silently `executed`), so a scheduled turn cannot self-schedule more
 * work without an operator approving it. `schedule.manage` is `danger` +
 * `requiresApproval` and the restricted profile is `approve_risky`, so the
 * engine raises an approval rather than executing. This asserts the contract via
 * the real `engine.invoke` path.
 */
describe("engine — schedule.manage under scheduled-restricted (P1-F2 anti-recursion)", () => {
  it("requires approval for schedule.manage when run under the scheduled-restricted profile", async () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(policyConfig, storage);

    const result = await engine.invoke({
      toolName: "schedule.manage",
      args: { op: "create", name: "Recursive", schedule: "0 9 * * *", prompt: "spawn more work" },
      agentId: "agent",
      sessionId: "cron-session",
      runId: "run-scheduled",
      surface: "tools",
      permissionProfileId: SCHEDULED_RESTRICTED_PROFILE.profileId,
      policyContext: {
        operatorId: "system-cron",
        authActorId: "system-cron",
        authActorSource: "none",
        permissionProfileId: SCHEDULED_RESTRICTED_PROFILE.profileId,
        permissionProfile: SCHEDULED_RESTRICTED_PROFILE,
        surface: "tools",
      },
    });

    // Must require approval — NOT executed, NOT a hard block (deny).
    expect(result.outcome).toBe("approval_required");
    expect(result.outcome).not.toBe("executed");
    expect(result.outcome).not.toBe("blocked");
  });

  it("does not include schedule.manage in the scheduled-restricted deny set (it surfaces as approval, not a hard deny)", () => {
    // The scheduled-restricted profile denies side-effecting tools outright but
    // intentionally leaves schedule.manage approval-gated rather than denied, so
    // an operator can still approve a scheduled self-schedule when they want it.
    expect(SCHEDULED_RESTRICTED_PROFILE.deny).not.toContain("schedule.manage");
    expect(SCHEDULED_RESTRICTED_PROFILE.deny).not.toContain("schedule.*");
  });
});

const policyConfig: ToolPolicyConfig = {
  profiles: { danger: ["*"] },
  tools: { profile: "danger", approvalMode: "approve_risky", allow: [], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["localhost"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

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
        createdAt: "2026-06-22T12:00:00.000Z",
        expiresAt: input.expiresAt ?? undefined,
        explanationStatus: "not_requested",
      })),
      get: vi.fn(
        (approvalId: string): ApprovalRequest => ({
          approvalId,
          kind: "tool",
          riskLevel: "danger",
          status: "pending",
          payload: {},
          preview: {},
          createdAt: "2026-06-22T12:00:00.000Z",
          explanationStatus: "not_requested",
        }),
      ),
    },
    approvalEvents: { append: vi.fn() },
    audit: { append: vi.fn(async () => undefined) },
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
      prepare: vi.fn(() => ({ run: vi.fn() })),
    },
  } as unknown as Storage;
}
