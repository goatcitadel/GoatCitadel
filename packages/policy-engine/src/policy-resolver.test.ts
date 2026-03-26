import { describe, expect, it } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
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
});
