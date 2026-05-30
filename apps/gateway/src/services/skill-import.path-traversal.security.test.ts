import { describe, expect, it } from "vitest";
import { __normalizeSkillIdForTests } from "./skill-import-service.js";

// Coverage for skill-id normalization: a skill `name` derived from frontmatter
// must not yield an id that escapes the intended skills/extra install
// directory. Names with path separators, traversal segments, leading dots, or
// absolute paths are rejected rather than coerced.

describe("normalizeSkillId path containment", () => {
  it("normalizes ordinary names into a safe lowercase id", () => {
    expect(__normalizeSkillIdForTests("My Skill")).toBe("my-skill");
    expect(__normalizeSkillIdForTests("  Cloudflare API  ")).toBe("cloudflare-api");
    expect(__normalizeSkillIdForTests("data.export.v2")).toBe("data.export.v2");
    expect(__normalizeSkillIdForTests("..foo..")).toBe("foo");
  });

  it("rejects traversal segments", () => {
    expect(() => __normalizeSkillIdForTests("..")).toThrow("does not yield a safe skill id");
    expect(() => __normalizeSkillIdForTests(".")).toThrow("does not yield a safe skill id");
    expect(() => __normalizeSkillIdForTests("a..b")).toThrow("does not yield a safe skill id");
  });

  it("rejects names containing path separators", () => {
    expect(() => __normalizeSkillIdForTests("../foo")).toThrow("must not contain path separators");
    expect(() => __normalizeSkillIdForTests("a/b")).toThrow("must not contain path separators");
    expect(() => __normalizeSkillIdForTests("a\\b")).toThrow("must not contain path separators");
  });

  it("rejects absolute paths", () => {
    expect(() => __normalizeSkillIdForTests("/etc/passwd")).toThrow("must not contain path separators");
  });
});
