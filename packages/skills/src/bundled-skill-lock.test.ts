import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listBundledSkillLockEntries, resolveBundledSkillLockEntry } from "./bundled-skill-lock.js";
import { parseSkillMarkdown } from "./frontmatter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, "../../../skills/bundled");

describe("bundled skill lock", () => {
  it("lists well-formed, unique, sorted entries for bundled skill ids", () => {
    const entries = listBundledSkillLockEntries();
    expect(entries.length).toBeGreaterThan(0);
    const ids = entries.map((entry) => entry.skillId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    for (const entry of entries) {
      expect(entry.skillId).toMatch(/^bundled:[^\s:]+$/u);
      expect(entry.manifestVersion).toBe("goatcitadel.skill-tree.v1");
      expect(entry.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.fileCount).toBeGreaterThan(0);
      expect(entry.totalBytes).toBeGreaterThan(0);
      expect(resolveBundledSkillLockEntry(entry.skillId)).toBe(entry);
    }
    expect(resolveBundledSkillLockEntry("bundled:not-a-shipped-skill")).toBeUndefined();
  });

  it("covers exactly the skill directories shipped under skills/bundled", async () => {
    const directories = await fs.readdir(bundledDir, { withFileTypes: true });
    const shipped: string[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const raw = await fs.readFile(path.join(bundledDir, entry.name, "SKILL.md"), "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      shipped.push(`bundled:${parseSkillMarkdown(raw).frontmatter.name}`);
    }
    shipped.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(listBundledSkillLockEntries().map((entry) => entry.skillId)).toEqual(shipped);
  });
});
