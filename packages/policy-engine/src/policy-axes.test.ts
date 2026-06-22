import { describe, expect, it } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { deriveToolPolicyAxes } from "./policy-axes.js";

const sandbox: ToolPolicyConfig["sandbox"] = {
  writeJailRoots: ["./workspace"],
  readOnlyRoots: ["./skills"],
  readAccessMode: "roots_only",
  networkAllowlist: ["api.anthropic.com"],
  riskyShellPatterns: ["rm"],
  requireApprovalForRiskyShell: true,
  riskyArgumentPatterns: [{ toolNamePattern: "*", argumentPath: "command", valuePatterns: ["terraform destroy"] }],
};

describe("deriveToolPolicyAxes", () => {
  it("splits resolved policy into independent sandbox and approval axes", () => {
    const axes = deriveToolPolicyAxes({ sandbox }, { approvalMode: "bypass", readAccessMode: "full_disk" });
    // Approval escalation is independent of sandbox access: a broad-access + bypass
    // combination is expressible without entangling the two axes.
    expect(axes.approval).toEqual({ approvalMode: "bypass", requireApprovalForRiskyShell: true });
    expect(axes.sandbox.filesystemReadMode).toBe("full_disk");
    expect(axes.sandbox.networkAllowlist).toEqual(["api.anthropic.com"]);
    expect(axes.sandbox.riskyArgumentPatterns).toHaveLength(1);
  });

  it("falls back to the sandbox config read mode when the profile does not set one", () => {
    const axes = deriveToolPolicyAxes({ sandbox }, { approvalMode: "approve_risky" });
    expect(axes.sandbox.filesystemReadMode).toBe("roots_only");
  });

  it("defaults the read mode to roots_only when neither profile nor config sets it", () => {
    const axes = deriveToolPolicyAxes(
      { sandbox: { ...sandbox, readAccessMode: undefined } },
      { approvalMode: "approve_all" },
    );
    expect(axes.sandbox.filesystemReadMode).toBe("roots_only");
  });
});
