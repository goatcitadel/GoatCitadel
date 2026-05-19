import { describe, expect, it } from "vitest";
import type { LocalOperatorOverrideRecord, PermissionProfileRecord, ToolPolicyConfig } from "@goatcitadel/contracts";
import { isToolAllowed, resolveEffectivePolicy } from "./policy-resolver.js";

const config: ToolPolicyConfig = {
  profiles: {
    minimal: ["session.status"],
    coding: ["session.status", "fs.read", "fs.write"],
  },
  tools: {
    profile: "coding",
    allow: ["http.get"],
    deny: ["fs.write"],
  },
  agents: {
    agentA: {
      tools: {
        allow: ["shell.exec"],
        deny: ["http.get"],
      },
    },
  },
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

describe("resolveEffectivePolicy", () => {
  it("applies deny-wins across base and agent overrides", () => {
    const policy = resolveEffectivePolicy(config, "agentA");

    expect(isToolAllowed(policy, "fs.read")).toBe(true);
    expect(isToolAllowed(policy, "fs.write")).toBe(false);
    expect(isToolAllowed(policy, "http.get")).toBe(false);
    expect(isToolAllowed(policy, "shell.exec")).toBe(true);
  });

  it("applies glob denies against profile-derived tools", () => {
    const policy = resolveEffectivePolicy({
      ...config,
      profiles: {
        coding: ["session.status", "session.inspect", "fs.read"],
      },
      tools: {
        profile: "coding",
        allow: [],
        deny: ["session.*"],
      },
    });

    expect(isToolAllowed(policy, "session.status")).toBe(false);
    expect(isToolAllowed(policy, "session.inspect")).toBe(false);
    expect(isToolAllowed(policy, "fs.read")).toBe(true);
  });

  it("defaults missing profile selection to all tools and danger profile to bypass approval", () => {
    const allToolsPolicy = resolveEffectivePolicy(
      {
        ...config,
        tools: {
          allow: [],
          deny: ["shell.exec"],
        },
        agents: {},
      } as ToolPolicyConfig,
      "missing-agent",
    );
    expect(isToolAllowed(allToolsPolicy, "fs.read")).toBe(true);
    expect(isToolAllowed(allToolsPolicy, "shell.exec")).toBe(false);

    const policy = resolveEffectivePolicy(
      {
        ...config,
        profiles: {},
        tools: {
          profile: "danger",
          allow: [],
          deny: ["shell.exec"],
        },
        agents: {},
      },
      "missing-agent",
    );

    expect(policy.approvalMode).toBe("bypass");
  });

  it("applies first-class permission profiles above legacy tool profiles", () => {
    const safeProfile = createProfile({
      profileId: "safe",
      label: "Safe",
      approvalMode: "approve_all",
      legacyToolProfile: "danger",
      toolPatterns: ["*"],
    });

    const safePolicy = resolveEffectivePolicy(config, "agentA", safeProfile);

    expect(safePolicy.permissionProfileId).toBe("safe");
    expect(safePolicy.permissionProfileLabel).toBe("Safe");
    expect(safePolicy.approvalMode).toBe("approve_all");
    expect(isToolAllowed(safePolicy, "shell.exec")).toBe(true);
    expect(isToolAllowed(safePolicy, "fs.write")).toBe(false);

    const customProfile = createProfile({
      profileId: "custom-review",
      label: "Review",
      approvalMode: "approve_risky",
      toolPatterns: ["session.status"],
      allow: ["docs.search"],
      deny: ["shell.*"],
    });
    const customPolicy = resolveEffectivePolicy(config, "agentA", customProfile);

    expect(isToolAllowed(customPolicy, "session.status")).toBe(true);
    expect(isToolAllowed(customPolicy, "docs.search")).toBe(true);
    expect(isToolAllowed(customPolicy, "shell.exec")).toBe(false);
  });

  it("lets local operator override skip normal prompts and profile tool limits while preserving denies", () => {
    const override = createOverride();
    const profile = createProfile({
      profileId: "trusted_local_power",
      label: "Trusted Local Power",
      approvalMode: "approve_all",
      toolPatterns: ["session.status"],
      deny: ["shell.exec"],
    });

    const policy = resolveEffectivePolicy(config, "missing-agent", profile, override);

    expect(policy.approvalMode).toBe("bypass");
    expect(policy.localOperatorOverrideId).toBe(override.overrideId);
    expect(isToolAllowed(policy, "session.status")).toBe(true);
    expect(isToolAllowed(policy, "fs.read")).toBe(true);
    expect(isToolAllowed(policy, "shell.exec")).toBe(false);
  });

  it("does not treat expired or revoked local operator override objects as bypass authority", () => {
    const profile = createProfile({
      profileId: "profile-safe",
      label: "Safe",
      approvalMode: "approve_all",
      toolPatterns: ["session.status"],
    });
    const expired = { ...createOverride(), expiresAt: "2000-01-01T00:00:00.000Z" };
    const revoked = { ...createOverride(), status: "revoked" as const };

    const expiredPolicy = resolveEffectivePolicy(config, "missing-agent", profile, expired);
    const revokedPolicy = resolveEffectivePolicy(config, "missing-agent", profile, revoked);

    expect(expiredPolicy.approvalMode).toBe("approve_all");
    expect(expiredPolicy.localOperatorOverrideId).toBeUndefined();
    expect(isToolAllowed(expiredPolicy, "fs.read")).toBe(false);
    expect(revokedPolicy.approvalMode).toBe("approve_all");
    expect(revokedPolicy.localOperatorOverrideId).toBeUndefined();
    expect(isToolAllowed(revokedPolicy, "fs.read")).toBe(false);
  });

  it("uses the stricter read access mode from global config and permission profile", () => {
    const profile = createProfile({
      profileId: "profile-read",
      label: "Read Profile",
      approvalMode: "approve_risky",
      toolPatterns: ["fs.read"],
      readAccessMode: "approval_required",
    });
    const relaxedGlobalPolicy = resolveEffectivePolicy(
      {
        ...config,
        sandbox: {
          ...config.sandbox,
          readAccessMode: "full_disk",
        },
      },
      "agentA",
      profile,
    );
    const strictGlobalPolicy = resolveEffectivePolicy(
      {
        ...config,
        sandbox: {
          ...config.sandbox,
          readAccessMode: "roots_only",
        },
      },
      "agentA",
      { ...profile, readAccessMode: "full_disk" },
    );

    expect(relaxedGlobalPolicy.readAccessMode).toBe("approval_required");
    expect(strictGlobalPolicy.readAccessMode).toBe("roots_only");
  });
});

function createProfile(input: {
  profileId: string;
  label: string;
  approvalMode: PermissionProfileRecord["approvalMode"];
  legacyToolProfile?: string;
  toolPatterns: string[];
  allow?: string[];
  deny?: string[];
  readAccessMode?: PermissionProfileRecord["readAccessMode"];
}): PermissionProfileRecord {
  return {
    profileId: input.profileId,
    label: input.label,
    builtin: true,
    status: "active",
    scope: "global",
    approvalMode: input.approvalMode,
    legacyToolProfile: input.legacyToolProfile,
    toolPatterns: input.toolPatterns,
    allow: input.allow ?? [],
    deny: input.deny ?? [],
    readAccessMode: input.readAccessMode,
    createdBy: "test",
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
  };
}

function createOverride(): LocalOperatorOverrideRecord {
  return {
    overrideId: "override-1",
    operatorId: "operator",
    scope: "workspace",
    scopeRef: "workspace",
    reason: "test",
    status: "active",
    createdBy: "operator",
    createdAt: "2026-05-17T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}
