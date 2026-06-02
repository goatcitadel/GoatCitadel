import { describe, expect, it } from "vitest";
import { normalizeSkillId } from "./skill-import-service.js";

// normalizeSkillId derives the on-disk skill id (installPath = skills/extra/<id>)
// from untrusted frontmatter `name`. It must never yield an id that can escape the
// skills/extra jail. Defense-in-depth alongside assertWritePathInJail at install.
describe("normalizeSkillId path-traversal safety", () => {
  it("rejects names containing path separators or absolute paths", () => {
    for (const name of ["../../etc", "..\\..\\windows", "/etc/passwd", "foo/bar", "foo\\bar", "C:\\evil"]) {
      expect(() => normalizeSkillId(name), name).toThrow(/path separators|safe skill id/i);
    }
  });

  it("rejects names that reduce to dot-only, empty, or traversal ids", () => {
    for (const name of ["..", ".", "...", "   ", "--", "..-.."]) {
      expect(() => normalizeSkillId(name), name).toThrow(/safe skill id|path separators/i);
    }
  });

  it("normalizes benign names to a lowercase slug without leading/trailing punctuation", () => {
    expect(normalizeSkillId("My Cool Skill")).toBe("my-cool-skill");
    expect(normalizeSkillId("  .Edge_Case-2.  ")).toBe("edge_case-2");
    expect(normalizeSkillId("Already-valid_id.v1")).toBe("already-valid_id.v1");
  });

  it("rejects names whose normalized form would still contain a '..' traversal token", () => {
    expect(() => normalizeSkillId("a..b")).toThrow(/safe skill id/i);
  });
});
