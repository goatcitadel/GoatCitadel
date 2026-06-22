import { describe, expect, it, vi } from "vitest";
import type { PermissionProfileRecord, ToolPolicyConfig } from "@goatcitadel/contracts";
import {
  HEARTBEAT_RESTRICTED_PROFILE,
  SCHEDULED_RESTRICTED_PROFILE,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

// End-to-end assertion of the non-negotiable safety invariant: a dangerous tool
// requested on an autonomous turn (restricted profile) must be denied or gated
// by `engine.evaluateAccess`, even when the base config and the system actor
// would otherwise be permissive. Uses the real default tool registry so tool
// risk levels and existence checks are exercised.

function createStorageStub(): Storage {
  return {
    approvals: {
      create: vi.fn(() => ({ approvalId: "approval-1" })),
      get: vi.fn(),
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
    db: { prepare: vi.fn(() => ({ run: vi.fn() })) },
  } as unknown as Storage;
}

// Permissive base config: a "danger" profile with bypass-leaning approval and a
// broad allow. The restricted *profile* (passed via policyContext) must override.
const PERMISSIVE_CONFIG: ToolPolicyConfig = {
  profiles: {},
  tools: {
    profile: "danger",
    approvalMode: "bypass",
    allow: ["*"],
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

function evaluate(toolName: string, profile: PermissionProfileRecord, args: Record<string, unknown> = {}) {
  const engine = new ToolPolicyEngine(PERMISSIVE_CONFIG, createStorageStub());
  return engine.evaluateAccess({
    toolName,
    args,
    agentId: "proactive",
    sessionId: "session-auto",
    runId: "run-auto",
    permissionProfileId: profile.profileId,
    policyContext: {
      operatorId: "system-cron",
      authActorId: "system-cron",
      authActorSource: "none",
      permissionProfileId: profile.profileId,
      permissionProfile: profile,
    },
  });
}

describe("autonomous restricted profiles via engine.evaluateAccess", () => {
  it("denies side-effecting tools on scheduled-restricted (policy deny-wins)", () => {
    const shell = evaluate("shell.exec", SCHEDULED_RESTRICTED_PROFILE, { command: "echo hi" });
    expect(shell.allowed).toBe(false);
    expect(shell.reasonCodes).toContain("policy_deny");
    expect(shell.permissionProfileId).toBe(SCHEDULED_RESTRICTED_PROFILE.profileId);

    const write = evaluate("fs.write", SCHEDULED_RESTRICTED_PROFILE, { path: "./x", contents: "y" });
    expect(write.allowed).toBe(false);
    expect(write.reasonCodes).toContain("policy_deny");

    const mcp = evaluate("mcp.invoke", SCHEDULED_RESTRICTED_PROFILE);
    expect(mcp.allowed).toBe(false);
    expect(mcp.reasonCodes).toContain("policy_deny");

    // Anti-recursion (P1-F2): self-scheduling is hard-denied on autonomous turns
    // (deny-wins via the `schedule.*` deny), not merely approval-gated.
    const schedule = evaluate("schedule.manage", SCHEDULED_RESTRICTED_PROFILE, { op: "list" });
    expect(schedule.allowed).toBe(false);
    expect(schedule.reasonCodes).toContain("policy_deny");
  });

  it("still allows non-denied read/query tools on scheduled-restricted (narrows, not closes)", () => {
    // Use tools without filesystem path-jail interplay so the assertion isolates
    // the autonomy deny invariant (fs.read has its own readAccessMode gating).
    const memoryRead = evaluate("memory.read", SCHEDULED_RESTRICTED_PROFILE, { key: "k" });
    expect(memoryRead.allowed).toBe(true);
    expect(memoryRead.permissionProfileId).toBe(SCHEDULED_RESTRICTED_PROFILE.profileId);

    const status = evaluate("session.status", SCHEDULED_RESTRICTED_PROFILE);
    expect(status.allowed).toBe(true);
  });

  it("heartbeat-restricted denies everything outside the read-only allowlist", () => {
    for (const tool of ["shell.exec", "fs.write", "fs.read", "memory.write", "session.status"]) {
      const evaluation = evaluate(tool, HEARTBEAT_RESTRICTED_PROFILE, { path: "./x" });
      expect(evaluation.allowed, `${tool} must be denied on heartbeat-restricted`).toBe(false);
      expect(evaluation.reasonCodes).toContain("policy_deny");
    }
  });

  it("heartbeat-restricted allows its read-only allowlist (memory.read)", () => {
    const memoryRead = evaluate("memory.read", HEARTBEAT_RESTRICTED_PROFILE, { key: "k" });
    expect(memoryRead.allowed).toBe(true);
    expect(memoryRead.permissionProfileId).toBe(HEARTBEAT_RESTRICTED_PROFILE.profileId);
  });
});
