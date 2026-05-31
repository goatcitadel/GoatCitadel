import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSkillSubfiles } from "./skill-subfile-resolver.js";

let skillDir: string;
beforeEach(async () => {
  skillDir = await mkdtemp(path.join(tmpdir(), "skill-"));
  await writeFile(path.join(skillDir, "SKILL.md"), "# main");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await mkdir(path.join(skillDir, "templates"), { recursive: true });
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await writeFile(path.join(skillDir, "goatcitadel.skill-bundle.json"), "{}");
  await writeFile(path.join(skillDir, "references", "deep.md"), "deep");
  await writeFile(path.join(skillDir, "templates", "template-a.md"), "tmpl-a");
  await writeFile(path.join(skillDir, "scripts", "review.ps1"), "Write-Output review");
});
afterEach(async () => {
  await rm(skillDir, { recursive: true, force: true });
});

describe("resolveSkillSubfiles", () => {
  it("returns portable bundle files plus references/*, templates/*, and scripts/*", async () => {
    const result = await resolveSkillSubfiles(skillDir);
    const names = result.files.map((f) => path.basename(f.relativePath));
    expect(names).toContain("SKILL.md");
    expect(names).toContain("goatcitadel.skill-bundle.json");
    expect(names).toContain("deep.md");
    expect(names).toContain("template-a.md");
    expect(names).toContain("review.ps1");
    expect(result.files).toHaveLength(5);
  });

  it("ignores files outside SKILL.md / manifest / references / templates / scripts", async () => {
    await writeFile(path.join(skillDir, "ignored.md"), "noop");
    const result = await resolveSkillSubfiles(skillDir);
    expect(result.files.map((f) => path.basename(f.relativePath))).not.toContain("ignored.md");
  });

  it("returns empty references when subdirs are missing", async () => {
    await rm(path.join(skillDir, "references"), { recursive: true, force: true });
    await rm(path.join(skillDir, "templates"), { recursive: true, force: true });
    await rm(path.join(skillDir, "scripts"), { recursive: true, force: true });
    await rm(path.join(skillDir, "goatcitadel.skill-bundle.json"), { force: true });
    const result = await resolveSkillSubfiles(skillDir);
    expect(result.files.map((f) => path.basename(f.relativePath))).toEqual(["SKILL.md"]);
  });

  it("sums byte counts in totalBytes", async () => {
    const result = await resolveSkillSubfiles(skillDir);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(result.files.reduce((sum, f) => sum + f.bytes, 0));
  });
});
