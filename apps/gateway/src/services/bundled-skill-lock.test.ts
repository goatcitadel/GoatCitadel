import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listBundledSkillLockEntries, SkillsService } from "@goatcitadel/skills";
import { captureSkillContentIntegrity } from "./skill-content-integrity.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("bundled skill release lock", () => {
  it("binds every shipped bundled skill tree to the compiled lock entry the gateway re-trusts against", async () => {
    const loaded = await new SkillsService([
      { source: "bundled", dir: path.join(repoRoot, "skills", "bundled") },
    ]).reload();
    expect(loaded.length).toBeGreaterThan(0);

    const expected = await Promise.all(
      loaded.map(async (skill) => {
        const integrity = await captureSkillContentIntegrity(skill.dir);
        return {
          skillId: skill.skillId,
          manifestVersion: integrity.manifestVersion,
          treeSha256: integrity.treeSha256,
          fileCount: integrity.fileCount,
          totalBytes: integrity.totalBytes,
        };
      }),
    );
    // Code-unit order, matching the generator in scripts/bundled-skill-lock.ts.
    expected.sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0));

    // A mismatch here means a bundled skill changed without `pnpm update:skills:lock`; upgraded
    // installs would demote that skill to a non-callable candidate instead of re-trusting it.
    expect([...listBundledSkillLockEntries()]).toEqual(expected);
  });
});
