import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsService, type SkillsLogger } from "./loader.js";

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-skills-link-"));
  tempRoots.push(dir);
  return dir;
}

async function writeSkill(dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody for ${name}.\n`,
    "utf8",
  );
}

// "junction" is ignored on POSIX and needs no privilege on Windows. Returns
// false when this platform/user cannot create links so the test can skip.
async function tryLink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

const makeLogger = (): SkillsLogger => ({ warn: vi.fn(), error: vi.fn() });

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SkillsService linked skill directories (C-15)", () => {
  it("loads a link whose target directory stays inside the source root", async () => {
    const root = await makeTempDir();
    await writeSkill(path.join(root, "real", "inner"), "linked-inside");
    if (!(await tryLink(path.join(root, "real", "inner"), path.join(root, "alias")))) {
      return;
    }
    const logger = makeLogger();
    const loaded = await new SkillsService([{ source: "workspace", dir: root }], logger).reload();
    expect(loaded.map((skill) => skill.name)).toEqual(["linked-inside"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips and reports a link that escapes the source root", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeSkill(path.join(outside, "evil"), "escaped");
    await writeSkill(path.join(root, "good"), "good-skill");
    if (!(await tryLink(path.join(outside, "evil"), path.join(root, "escape")))) {
      return;
    }
    const logger = makeLogger();
    const loaded = await new SkillsService([{ source: "workspace", dir: root }], logger).reload();
    expect(loaded.map((skill) => skill.name)).toEqual(["good-skill"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("outside its source root"),
      expect.objectContaining({ source: "workspace" }),
    );
  });

  it("reports a broken link instead of dropping it silently", async () => {
    const root = await makeTempDir();
    if (!(await tryLink(path.join(root, "missing-target"), path.join(root, "dangling")))) {
      return;
    }
    const logger = makeLogger();
    const loaded = await new SkillsService([{ source: "workspace", dir: root }], logger).reload();
    expect(loaded).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("broken skill link"), expect.any(Object));
  });
});
