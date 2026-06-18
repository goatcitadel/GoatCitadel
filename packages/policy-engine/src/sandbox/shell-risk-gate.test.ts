import { describe, expect, it } from "vitest";
import { classifyShellRisk } from "./shell-risk-gate.js";

describe("classifyShellRisk", () => {
  it("matches literal shell risk patterns across normalized whitespace", () => {
    expect(classifyShellRisk("sudo   rm   -rf ./workspace/tmp", ["rm -rf"])).toEqual({
      risky: true,
      matchedPattern: "rm -rf",
    });
  });

  it("matches bounded glob shell risk patterns", () => {
    expect(classifyShellRisk("git clean -xfd ./workspace/tmp", ["git clean *"])).toEqual({
      risky: true,
      matchedPattern: "git clean *",
    });
    expect(classifyShellRisk("pnpm install --force", ["*--force*"])).toEqual({
      risky: true,
      matchedPattern: "*--force*",
    });
  });

  it("does not match command fragments inside ordinary words", () => {
    expect(classifyShellRisk("node scripts/warm-cache.mjs", ["rm"])).toEqual({ risky: false });
  });

  it("ignores blank and overlong patterns", () => {
    expect(classifyShellRisk("rm -rf ./workspace/tmp", ["   ", "x".repeat(600)])).toEqual({ risky: false });
  });
});
