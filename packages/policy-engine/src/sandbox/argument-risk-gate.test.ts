import { describe, expect, it } from "vitest";
import type { ToolRiskyArgumentPattern } from "@goatcitadel/contracts";
import { classifyArgumentRisk } from "./argument-risk-gate.js";

const IAC_PATTERNS: ToolRiskyArgumentPattern[] = [
  {
    toolNamePattern: "*",
    argumentPath: "command",
    valuePatterns: ["terraform destroy", "pulumi destroy", "cdk destroy"],
  },
  { toolNamePattern: "terraform.*", argumentPath: "action", valuePatterns: ["destroy"] },
];

describe("classifyArgumentRisk", () => {
  it("is inert when no patterns are configured", () => {
    expect(classifyArgumentRisk("shell.exec", { command: "terraform destroy" }, []).risky).toBe(false);
    expect(classifyArgumentRisk("shell.exec", { command: "terraform destroy" }, undefined).risky).toBe(false);
  });

  it("flags a destructive command argument for any tool", () => {
    const decision = classifyArgumentRisk("shell.exec", { command: "terraform destroy --auto-approve" }, IAC_PATTERNS);
    expect(decision.risky).toBe(true);
    expect(decision.matchedPattern).toBe("terraform destroy");
  });

  it("flags risky content beyond the first 8 KiB of an argument value", () => {
    const longPrefix = "x".repeat(9000);
    const decision = classifyArgumentRisk("shell.exec", { command: `${longPrefix} terraform destroy` }, IAC_PATTERNS);
    expect(decision.risky).toBe(true);
    expect(decision.matchedPattern).toBe("terraform destroy");
  });

  it("matches on a tool-name-scoped pattern via a nested argument path", () => {
    const decision = classifyArgumentRisk("terraform.run", { action: "destroy" }, IAC_PATTERNS);
    expect(decision.risky).toBe(true);
    expect(decision.toolNamePattern).toBe("terraform.*");
  });

  it("does not match when the tool name is outside the pattern scope", () => {
    expect(classifyArgumentRisk("pulumi.run", { action: "destroy" }, IAC_PATTERNS).risky).toBe(false);
  });

  it("is word-bounded so 'destroy' does not match 'destroyer'", () => {
    const patterns: ToolRiskyArgumentPattern[] = [
      { toolNamePattern: "*", argumentPath: "command", valuePatterns: ["destroy"] },
    ];
    expect(classifyArgumentRisk("shell.exec", { command: "run destroyer build" }, patterns).risky).toBe(false);
    expect(classifyArgumentRisk("shell.exec", { command: "please destroy now" }, patterns).risky).toBe(true);
  });

  it("falls back to the whole args JSON when no argumentPath is given (use unbounded patterns)", () => {
    // Without an argumentPath the gate matches against the stringified args, where
    // values are wrapped in JSON punctuation — so an unbounded `*...*` pattern is the
    // reliable form. Prefer argumentPath for precise matching.
    const patterns: ToolRiskyArgumentPattern[] = [{ toolNamePattern: "*", valuePatterns: ["*cdk destroy*"] }];
    expect(classifyArgumentRisk("iac.apply", { nested: { command: "cdk destroy" } }, patterns).risky).toBe(true);
  });

  it("ignores patterns when the argument value is absent", () => {
    expect(classifyArgumentRisk("shell.exec", { other: "value" }, IAC_PATTERNS).risky).toBe(false);
  });
});
