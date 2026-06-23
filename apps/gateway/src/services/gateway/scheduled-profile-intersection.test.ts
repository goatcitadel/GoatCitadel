import { describe, expect, it } from "vitest";
import type { PermissionProfileRecord, ToolPolicyConfig } from "@goatcitadel/contracts";
import { isToolAllowed, resolveEffectivePolicy } from "@goatcitadel/policy-engine";
import {
  buildScheduledCreatorIntersectionProfile,
  permissionProfileAppliesToCreator,
} from "./scheduled-profile-intersection.js";

const POLICY_CONFIG: ToolPolicyConfig = {
  profiles: { danger: ["*"] },
  tools: {
    profile: "danger",
    allow: [],
    deny: [],
  },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
    readAccessMode: "full_disk",
  },
};

function creatorProfile(overrides: Partial<PermissionProfileRecord> = {}): PermissionProfileRecord {
  return {
    profileId: "creator-profile",
    label: "Creator Profile",
    builtin: false,
    status: "active",
    scope: "operator",
    scopeRef: "operator-1",
    approvalMode: "bypass",
    legacyToolProfile: "danger",
    toolPatterns: ["*"],
    allow: [],
    deny: [],
    readAccessMode: "full_disk",
    defaultForSurfaces: ["chat"],
    createdBy: "operator-1",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildScheduledCreatorIntersectionProfile", () => {
  it("keeps scheduled-restricted deny rules even for a broad creator profile", () => {
    const profile = buildScheduledCreatorIntersectionProfile({
      creatorProfile: creatorProfile(),
      runId: "cron-run-1",
      knownToolNames: ["fs.read", "shell.exec", "http.get", "schedule.manage", "gmail.send"],
      now: "2026-06-23T00:00:00.000Z",
    });
    const policy = resolveEffectivePolicy(POLICY_CONFIG, "proactive", profile);

    expect(profile.profileId).toBe("scheduled-intersection:cron-run-1");
    expect(profile.approvalMode).toBe("approve_risky");
    expect(profile.readAccessMode).toBe("approval_required");
    expect(isToolAllowed(policy, "fs.read")).toBe(true);
    expect(isToolAllowed(policy, "http.get")).toBe(true);
    expect(isToolAllowed(policy, "shell.exec")).toBe(false);
    expect(isToolAllowed(policy, "schedule.manage")).toBe(false);
    expect(isToolAllowed(policy, "gmail.send")).toBe(false);
  });

  it("does not widen past a narrow creator profile", () => {
    const profile = buildScheduledCreatorIntersectionProfile({
      creatorProfile: creatorProfile({
        approvalMode: "approve_all",
        toolPatterns: ["memory.read"],
        readAccessMode: "roots_only",
      }),
      runId: "cron-run-2",
      knownToolNames: ["memory.read", "fs.read", "http.get"],
      now: "2026-06-23T00:00:00.000Z",
    });
    const policy = resolveEffectivePolicy(POLICY_CONFIG, "proactive", profile);

    expect(profile.approvalMode).toBe("approve_all");
    expect(profile.readAccessMode).toBe("roots_only");
    expect(isToolAllowed(policy, "memory.read")).toBe(true);
    expect(isToolAllowed(policy, "fs.read")).toBe(false);
    expect(isToolAllowed(policy, "http.get")).toBe(false);
  });
});

describe("permissionProfileAppliesToCreator", () => {
  it("accepts only matching active scopes for creator provenance", () => {
    expect(
      permissionProfileAppliesToCreator({
        profile: creatorProfile({ scope: "global", scopeRef: undefined }),
        creatorActorId: undefined,
        workspaceId: "ws-1",
      }),
    ).toBe(true);
    expect(
      permissionProfileAppliesToCreator({
        profile: creatorProfile({ scope: "operator", scopeRef: "operator-1" }),
        creatorActorId: "operator-1",
        workspaceId: "ws-1",
      }),
    ).toBe(true);
    expect(
      permissionProfileAppliesToCreator({
        profile: creatorProfile({ scope: "operator", scopeRef: "operator-1" }),
        creatorActorId: "operator-2",
        workspaceId: "ws-1",
      }),
    ).toBe(false);
    expect(
      permissionProfileAppliesToCreator({
        profile: creatorProfile({ scope: "workspace", scopeRef: "ws-1" }),
        creatorActorId: "operator-2",
        workspaceId: "ws-1",
      }),
    ).toBe(true);
    expect(
      permissionProfileAppliesToCreator({
        profile: creatorProfile({ scope: "workspace", scopeRef: "ws-2" }),
        creatorActorId: "operator-2",
        workspaceId: "ws-1",
      }),
    ).toBe(false);
  });
});
