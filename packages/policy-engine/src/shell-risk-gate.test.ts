import { describe, expect, it } from "vitest";
import { classifyShellRisk } from "./sandbox/shell-risk-gate.js";

describe("classifyShellRisk", () => {
  it("flags risky commands", () => {
    const risk = classifyShellRisk("git reset --hard", ["git reset --hard"]);
    expect(risk.risky).toBe(true);
  });

  it("keeps safe commands non-risky", () => {
    const risk = classifyShellRisk("git status", ["git reset --hard"]);
    expect(risk.risky).toBe(false);
  });

  it("flags 'rm -rf /' as risky (matches 'rm')", () => {
    const risk = classifyShellRisk("rm -rf /", ["rm"]);
    expect(risk.risky).toBe(true);
    expect(risk.matchedPattern).toBe("rm");
  });

  it("does NOT flag 'perform cleanup' for 'rm' pattern", () => {
    const risk = classifyShellRisk("perform cleanup", ["rm"]);
    expect(risk.risky).toBe(false);
  });

  it("flags 'git push --force' as risky (matches 'git push')", () => {
    const risk = classifyShellRisk("git push --force", ["git push"]);
    expect(risk.risky).toBe(true);
    expect(risk.matchedPattern).toBe("git push");
  });

  it("flags 'format C:' as risky (matches 'format')", () => {
    const risk = classifyShellRisk("format C:", ["format"]);
    expect(risk.risky).toBe(true);
    expect(risk.matchedPattern).toBe("format");
  });

  it("flags 'format' in 'information about format' but not 'rm' in 'information'", () => {
    const result1 = classifyShellRisk("information about format", ["format"]);
    expect(result1.risky).toBe(true);
    expect(result1.matchedPattern).toBe("format");

    const result2 = classifyShellRisk("information about format", ["rm"]);
    expect(result2.risky).toBe(false);
  });
});