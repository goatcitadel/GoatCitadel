import { describe, expect, it } from "vitest";
import { normalizeMcpPolicy, wildcardMatch } from "./mcp-server-policy.js";

describe("wildcardMatch", () => {
  it("treats ? as exactly one character, not an optional previous character", () => {
    expect(wildcardMatch("delete_x", "delete_?")).toBe(true);
    expect(wildcardMatch("delete_", "delete_?")).toBe(false);
    expect(wildcardMatch("delete", "delete_?")).toBe(false);
    expect(wildcardMatch("delete_xy", "delete_?")).toBe(false);
  });

  it("does not throw on a leading ?", () => {
    expect(() => wildcardMatch("ab", "?b")).not.toThrow();
    expect(wildcardMatch("ab", "?b")).toBe(true);
  });

  it("keeps * glob behaviour and literal escaping", () => {
    expect(wildcardMatch("files.read", "files.*")).toBe(true);
    expect(wildcardMatch("filesXread", "files.read")).toBe(false);
    expect(wildcardMatch("a(b)", "a(b)")).toBe(true);
    expect(wildcardMatch("anything", "***")).toBe(true);
  });
});

describe("normalizeMcpPolicy approvalPosture", () => {
  it.each(["everything_asks", "reads_free", "nothing_asks"] as const)("keeps %s", (approvalPosture) => {
    expect(normalizeMcpPolicy({ approvalPosture }).approvalPosture).toBe(approvalPosture);
  });

  it("keeps the setting when an unrelated policy field is edited on top of a saved policy", () => {
    const saved = normalizeMcpPolicy({ approvalPosture: "reads_free", notes: "before" });
    const edited = normalizeMcpPolicy({ ...saved, notes: "after" });
    expect(edited).toMatchObject({ approvalPosture: "reads_free", notes: "after" });
  });

  it("drops an unknown value so a damaged record falls back to asking for everything", () => {
    for (const bad of ["sometimes", "", "READS_FREE", 7, null, {}]) {
      expect(normalizeMcpPolicy({ approvalPosture: bad } as never)).not.toHaveProperty("approvalPosture");
    }
  });

  it("leaves the stored shape unchanged when no setting was chosen", () => {
    expect(normalizeMcpPolicy()).not.toHaveProperty("approvalPosture");
    expect(normalizeMcpPolicy({ redactionMode: "strict" })).not.toHaveProperty("approvalPosture");
  });
});
