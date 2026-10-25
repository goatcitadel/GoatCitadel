import { describe, expect, it } from "vitest";
import { wildcardMatch } from "./mcp-server-policy.js";

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
