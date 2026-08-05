import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { SCHEDULED_RESTRICTED_PROFILE } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

/**
 * Anti-recursion invariant (P1-F2, hardened): under the `scheduled-restricted`
 * profile a scheduled turn's `schedule.manage` call must be HARD-DENIED, never
 * merely approval-gated. An autonomous turn runs unattended, so there is no
 * operator to clear an approval — approval-gating would park forever (or
 * auto-approve under a permissive base policy), which is not a real block. The
 * `scheduled-restricted` deny list therefore includes `schedule.*` and deny-wins
 * makes the engine block the call outright. This asserts the contract via the
 * real `engine.invoke` path.
 */
describe("engine — schedule.manage under scheduled-restricted (P1-F2 anti-recursion)", () => {
  it("hard-denies schedule.manage when run under the scheduled-restricted profile", async () => {
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

    // Must be a hard block — NOT executed, NOT parked as an approval.
    expect(result.outcome).toBe("blocked");
    expect(result.outcome).not.toBe("executed");
    expect(result.outcome).not.toBe("approval_required");
    // A scheduled turn must never silently create an approval row either.
    expect(storage.approvals.create).not.toHaveBeenCalled();
  });

  it("includes schedule.* in the scheduled-restricted deny set (hard anti-recursion)", () => {
    // The scheduled-restricted profile denies the whole schedule family so a
    // scheduled/heartbeat turn can never self-schedule more work.
    expect(SCHEDULED_RESTRICTED_PROFILE.deny).toContain("schedule.*");
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
  } as unknown as Storage & AsyncStorage;
}
