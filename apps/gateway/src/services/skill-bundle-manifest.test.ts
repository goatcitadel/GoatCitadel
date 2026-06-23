import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSkillBundleDeclaredMetadata,
  SKILL_BUNDLE_MANIFEST_FILENAME,
  validateSkillBundleManifestDirectory,
} from "./skill-bundle-manifest.js";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSkillDir(manifestExtra: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-gov-"));
  tmpRoots.push(dir);
  const skillBody = "# Skill\nGovernance test skill.";
  writeFileSync(join(dir, "SKILL.md"), skillBody);
  const sha256 = createHash("sha256").update(Buffer.from(skillBody)).digest("hex");
  writeFileSync(
    join(dir, SKILL_BUNDLE_MANIFEST_FILENAME),
    JSON.stringify({
      manifestVersion: "goatcitadel.skill-bundle.v1",
      scriptDisposition: "review_only_non_callable",
      assets: [{ path: "SKILL.md", sha256, kind: "skill" }],
      ...manifestExtra,
    }),
  );
  return dir;
}

describe("validateSkillBundleManifestDirectory declared governance metadata", () => {
  it("surfaces medium-risk declarations as warnings without blocking (graduated trust)", async () => {
    const dir = makeSkillDir({
      requiredEnv: [{ name: "AWS_SECRET", secret: true }],
      stateDirs: [{ path: "state/cache", writeable: true }],
      declaredDependencies: { capabilities: ["network", "fs.read"] },
    });

    const result = await validateSkillBundleManifestDirectory(dir);

    expect(result.status).toBe("valid");
    expect(result.declaredMetadata?.requiredEnv).toHaveLength(1);
    expect(result.declaredMetadata?.stateDirs).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("secret env var"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("writeable state directory"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("elevated capabilities") && w.includes("network"))).toBe(true);
    // fs.read is not elevated, so it must not be flagged.
    expect(result.warnings.some((w) => w.includes("fs.read"))).toBe(false);
  });

  it("hard-blocks a state directory that traverses outside the skill", async () => {
    const dir = makeSkillDir({ stateDirs: [{ path: "../../etc", writeable: true }] });
    const result = await validateSkillBundleManifestDirectory(dir);
    expect(result.status).toBe("invalid");
    expect(result.errors.some((e) => e.includes("../../etc"))).toBe(true);
  });

  it("omits declaredMetadata when the manifest declares none", async () => {
    const dir = makeSkillDir({});
    const result = await validateSkillBundleManifestDirectory(dir);
    expect(result.status).toBe("valid");
    expect(result.declaredMetadata).toBeUndefined();
  });
});

describe("readSkillBundleDeclaredMetadata", () => {
  it("surfaces declared metadata and medium-risk warnings without verifying assets", async () => {
    // A bogus asset hash would fail full verification, but the lightweight reader
    // must surface governance metadata without hashing files.
    const dir = makeSkillDir({
      assets: [{ path: "SKILL.md", sha256: "0".repeat(64), kind: "skill" }],
      requiredEnv: [{ name: "AWS_SECRET", secret: true }],
      stateDirs: [{ path: "state/cache", writeable: true }],
      declaredDependencies: { tools: ["fs.read"], capabilities: ["network"] },
    });

    const result = await readSkillBundleDeclaredMetadata(dir);

    expect(result?.declaredMetadata?.requiredEnv).toHaveLength(1);
    expect(result?.declaredMetadata?.stateDirs[0]?.path).toBe("state/cache");
    expect(result?.declaredMetadata?.dependencies.capabilities).toContain("network");
    expect(result?.warnings.some((w) => w.includes("secret env var"))).toBe(true);
    expect(result?.warnings.some((w) => w.includes("writeable state directory"))).toBe(true);
    expect(result?.warnings.some((w) => w.includes("elevated capabilities"))).toBe(true);
  });

  it("returns undefined when no manifest is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-gov-empty-"));
    tmpRoots.push(dir);
    expect(await readSkillBundleDeclaredMetadata(dir)).toBeUndefined();
  });

  it("returns undefined when the manifest declares no governance metadata", async () => {
    const dir = makeSkillDir({});
    expect(await readSkillBundleDeclaredMetadata(dir)).toBeUndefined();
  });
});
