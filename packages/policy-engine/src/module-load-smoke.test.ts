import { describe, expect, it } from "vitest";

describe("policy-engine module load smoke", () => {
  it("loads policy-engine exports", async () => {
    const mod = await import("./index.js");
    expect(mod).toBeTruthy();
    expect(typeof mod.ToolPolicyEngine).toBe("function");
  }, 30000);
});
