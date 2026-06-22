import { describe, expect, it } from "vitest";
import type { PermissionProfileRecord, ToolPolicyConfig } from "@goatcitadel/contracts";
import { isToolAllowed, resolveEffectivePolicy } from "@goatcitadel/policy-engine";
import {
  AUTONOMOUS_RESTRICTED_PROFILES,
  HEARTBEAT_PERMISSION_PROFILE_ID,
  HEARTBEAT_READ_ONLY_ALLOW,
  HEARTBEAT_RESTRICTED_PROFILE,
  SCHEDULED_RESTRICTED_DENY,
  SCHEDULED_RESTRICTED_PROFILE,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  autonomousTurnKindForProfileId,
  buildAutonomousTurnContext,
  isAutonomousTurnRequest,
  resolveAutonomousPermissionProfile,
} from "./autonomous-turn-policy.js";

// A permissive base config: an unrestricted operator would have "*" available
// with bypass approval. The restricted *profile* passed via policyContext must
// override this and narrow the surface — that is the safety invariant under test.
const PERMISSIVE_CONFIG: ToolPolicyConfig = {
  profiles: {},
  tools: {
    profile: "danger",
    allow: ["*"],
    deny: [],
  },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

function resolveWithProfile(profile: PermissionProfileRecord) {
  return resolveEffectivePolicy(PERMISSIVE_CONFIG, "proactive", profile);
}

const DANGEROUS_SAMPLE_TOOLS = [
  "shell.exec",
  "shell.run",
  "fs.write",
  "fs.move",
  "fs.delete",
  "git.commit",
  "git.push",
  "http.post",
  "gmail.send",
  "telegram.send",
  "mcp.invoke",
  "browser.interact",
];

describe("restricted permission profiles", () => {
  it("exposes both restricted profiles with the documented ids", () => {
    expect(SCHEDULED_RESTRICTED_PROFILE.profileId).toBe(SCHEDULED_TURN_PERMISSION_PROFILE_ID);
    expect(HEARTBEAT_RESTRICTED_PROFILE.profileId).toBe(HEARTBEAT_PERMISSION_PROFILE_ID);
    expect(AUTONOMOUS_RESTRICTED_PROFILES).toEqual([SCHEDULED_RESTRICTED_PROFILE, HEARTBEAT_RESTRICTED_PROFILE]);
    // Both are global, built-in, and fail-closed on filesystem read scope.
    for (const profile of AUTONOMOUS_RESTRICTED_PROFILES) {
      expect(profile.builtin).toBe(true);
      expect(profile.scope).toBe("global");
      expect(profile.readAccessMode).toBe("approval_required");
    }
  });

  it("scheduled-restricted denies the dangerous/side-effecting tool set", () => {
    const policy = resolveWithProfile(SCHEDULED_RESTRICTED_PROFILE);

    for (const tool of DANGEROUS_SAMPLE_TOOLS) {
      expect(isToolAllowed(policy, tool), `${tool} must be denied on scheduled-restricted`).toBe(false);
    }
    // Every documented deny pattern is present on the profile.
    for (const pattern of SCHEDULED_RESTRICTED_DENY) {
      expect(SCHEDULED_RESTRICTED_PROFILE.deny).toContain(pattern);
    }
  });

  it("scheduled-restricted still allows read/query tools (narrows, not closes)", () => {
    const policy = resolveWithProfile(SCHEDULED_RESTRICTED_PROFILE);

    expect(isToolAllowed(policy, "fs.read")).toBe(true);
    expect(isToolAllowed(policy, "http.get")).toBe(true);
    expect(isToolAllowed(policy, "memory.read")).toBe(true);
    // Risky-but-not-denied tools require approval rather than bypass.
    expect(policy.approvalMode).toBe("approve_risky");
  });

  it("scheduled-restricted hard-denies self-scheduling (schedule.* anti-recursion)", () => {
    const policy = resolveWithProfile(SCHEDULED_RESTRICTED_PROFILE);
    expect(isToolAllowed(policy, "schedule.manage")).toBe(false);
    expect(SCHEDULED_RESTRICTED_PROFILE.deny).toContain("schedule.*");
  });

  it("heartbeat-restricted is read-only: only the allowlist is callable", () => {
    const policy = resolveWithProfile(HEARTBEAT_RESTRICTED_PROFILE);

    for (const tool of HEARTBEAT_READ_ONLY_ALLOW) {
      expect(isToolAllowed(policy, tool), `${tool} must be allowed on heartbeat-restricted`).toBe(true);
    }
    // Everything outside the allowlist is denied by default.
    for (const tool of [...DANGEROUS_SAMPLE_TOOLS, "fs.read", "http.get", "session.status"]) {
      expect(isToolAllowed(policy, tool), `${tool} must be denied on heartbeat-restricted`).toBe(false);
    }
    expect(policy.approvalMode).toBe("approve_all");
  });

  it("resolveAutonomousPermissionProfile maps kind to profile (and back)", () => {
    expect(resolveAutonomousPermissionProfile("scheduled")).toBe(SCHEDULED_RESTRICTED_PROFILE);
    expect(resolveAutonomousPermissionProfile("heartbeat")).toBe(HEARTBEAT_RESTRICTED_PROFILE);
    expect(autonomousTurnKindForProfileId(SCHEDULED_TURN_PERMISSION_PROFILE_ID)).toBe("scheduled");
    expect(autonomousTurnKindForProfileId(HEARTBEAT_PERMISSION_PROFILE_ID)).toBe("heartbeat");
    expect(autonomousTurnKindForProfileId("trusted_local_power")).toBeUndefined();
  });
});

describe("buildAutonomousTurnContext", () => {
  it("carries the restricted profile, system actor, and run id (scheduled)", () => {
    const { policyContext, consentContext } = buildAutonomousTurnContext({
      kind: "scheduled",
      systemActorId: "system-cron",
      runId: "run-123",
      sessionId: "sess-1",
      workspaceId: "ws-1",
      taskId: "task-1",
    });

    expect(policyContext.permissionProfileId).toBe(SCHEDULED_TURN_PERMISSION_PROFILE_ID);
    expect(policyContext.permissionProfile).toBe(SCHEDULED_RESTRICTED_PROFILE);
    expect(policyContext.operatorId).toBe("system-cron");
    expect(policyContext.authActorId).toBe("system-cron");
    expect(policyContext.authActorSource).toBe("none");
    expect(policyContext.runId).toBe("run-123");
    expect(policyContext.sessionId).toBe("sess-1");
    expect(policyContext.workspaceId).toBe("ws-1");
    expect(policyContext.taskId).toBe("task-1");
    expect(policyContext.surface).toBe("tools");

    expect(consentContext.operatorId).toBe("system-cron");
    expect(consentContext.source).toBe("agent");
    expect(consentContext.reason).toContain("scheduled");
  });

  it("carries the heartbeat profile for heartbeat turns", () => {
    const { policyContext } = buildAutonomousTurnContext({
      kind: "heartbeat",
      systemActorId: "system-heartbeat",
      runId: "run-hb",
    });

    expect(policyContext.permissionProfileId).toBe(HEARTBEAT_PERMISSION_PROFILE_ID);
    expect(policyContext.permissionProfile).toBe(HEARTBEAT_RESTRICTED_PROFILE);
    expect(policyContext.operatorId).toBe("system-heartbeat");
  });

  it("the attached profile drives engine policy resolution (end-to-end)", () => {
    // Simulate what the engine does: take the policyContext.permissionProfile
    // and feed it through resolveEffectivePolicy. Dangerous tools must be denied
    // even though the base config is fully permissive.
    const { policyContext } = buildAutonomousTurnContext({
      kind: "scheduled",
      systemActorId: "system-cron",
      runId: "run-xyz",
    });
    const policy = resolveEffectivePolicy(
      PERMISSIVE_CONFIG,
      "proactive",
      policyContext.permissionProfile,
    );
    expect(isToolAllowed(policy, "shell.exec")).toBe(false);
    expect(isToolAllowed(policy, "fs.write")).toBe(false);
    expect(isToolAllowed(policy, "fs.read")).toBe(true);
  });

  it("does not mutate its input", () => {
    const input = {
      kind: "scheduled" as const,
      systemActorId: "system-cron",
      runId: "run-1",
    };
    const snapshot = JSON.stringify(input);
    buildAutonomousTurnContext(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("isAutonomousTurnRequest", () => {
  it("is true for both restricted autonomous profiles (cron/commitment + heartbeat)", () => {
    expect(isAutonomousTurnRequest({ permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID })).toBe(true);
    expect(isAutonomousTurnRequest({ permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID })).toBe(true);
  });

  it("is false for interactive / unknown / absent profiles", () => {
    expect(isAutonomousTurnRequest({ permissionProfileId: "trusted_local_power" })).toBe(false);
    expect(isAutonomousTurnRequest({ permissionProfileId: "safe" })).toBe(false);
    expect(isAutonomousTurnRequest({})).toBe(false);
    expect(isAutonomousTurnRequest({ permissionProfileId: "" })).toBe(false);
  });
});
