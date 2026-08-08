import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKILL_CONTENT_INTEGRITY_LIMITS,
  captureSkillContentIntegrity,
  parseSkillContentIntegrityManifest,
  readBoundedSkillTextFile,
  readBoundedSkillSourceManifestSync,
  skillContentIntegrityMatches,
} from "./skill-content-integrity.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createSkillRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-skill-integrity-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), "reviewed instructions\n");
  await fs.writeFile(path.join(root, "references", "guide.md"), "operator guide\n");
  await fs.writeFile(path.join(root, "source.json"), '{"generated":true}\n');
  await fs.writeFile(path.join(root, ".git", "config"), "mutable vcs metadata\n");
  return root;
}

async function createEmptyRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-skill-integrity-limit-"));
  tempRoots.push(root);
  return root;
}

describe("skill content integrity", () => {
  it("creates a deterministic, sorted whole-payload manifest while excluding generated metadata", async () => {
    const root = await createSkillRoot();
    const first = await captureSkillContentIntegrity(root);

    await fs.writeFile(path.join(root, "source.json"), '{"generated":"changed"}\n');
    await fs.writeFile(path.join(root, ".git", "config"), "changed vcs metadata\n");
    const second = await captureSkillContentIntegrity(root);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      manifestVersion: "goatcitadel.skill-tree.v1",
      algorithm: "sha256",
      treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileCount: 2,
      excludedPaths: ["source.json", ".git/**"],
      files: [{ path: "SKILL.md" }, { path: "references/guide.md" }],
    });
    expect(parseSkillContentIntegrityManifest(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it("changes the tree digest for any copied payload byte and rejects a forged manifest digest", async () => {
    const root = await createSkillRoot();
    const before = await captureSkillContentIntegrity(root);
    await fs.writeFile(path.join(root, "references", "guide.md"), "changed operator guide\n");
    const after = await captureSkillContentIntegrity(root);

    expect(skillContentIntegrityMatches(before, after)).toBe(false);
    expect(after.treeSha256).not.toBe(before.treeSha256);
    expect(
      parseSkillContentIntegrityManifest({
        ...after,
        treeSha256: "0".repeat(64),
      }),
    ).toBeUndefined();
  });

  it("rejects payloads with too many files before reading their contents", async () => {
    const root = await createEmptyRoot();
    await Promise.all(
      Array.from({ length: SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles + 1 }, (_, index) =>
        fs.writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), ""),
      ),
    );

    await expect(captureSkillContentIntegrity(root)).rejects.toThrow(
      `exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles} files`,
    );
  });

  it("rejects an oversized single file from metadata before hashing it", async () => {
    const root = await createEmptyRoot();
    const filePath = path.join(root, "oversized.bin");
    await fs.writeFile(filePath, "");
    await fs.truncate(filePath, SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1);

    await expect(captureSkillContentIntegrity(root)).rejects.toThrow(
      `exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes} bytes`,
    );
  });

  it("rejects excessive aggregate payload bytes before hashing the tree", async () => {
    const root = await createEmptyRoot();
    for (let index = 0; index < 8; index += 1) {
      const filePath = path.join(root, `full-${index}.bin`);
      await fs.writeFile(filePath, "");
      await fs.truncate(filePath, SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes);
    }
    await fs.writeFile(path.join(root, "overflow.bin"), "x");

    await expect(captureSkillContentIntegrity(root)).rejects.toThrow(
      `exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes} total bytes`,
    );
  });

  it("rejects forged manifests that claim trees beyond the shared limits", () => {
    const files = Array.from({ length: SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles + 1 }, (_, index) => ({
      path: `file-${String(index).padStart(3, "0")}.txt`,
      sha256: "0".repeat(64),
      bytes: 0,
    }));

    expect(
      parseSkillContentIntegrityManifest({
        manifestVersion: "goatcitadel.skill-tree.v1",
        algorithm: "sha256",
        treeSha256: "0".repeat(64),
        fileCount: files.length,
        totalBytes: 0,
        excludedPaths: ["source.json", ".git/**"],
        files,
      }),
    ).toBeUndefined();
  });

  it("bounds source.json by stat before reading or parsing it", async () => {
    const root = await createEmptyRoot();
    const manifestPath = path.join(root, "source.json");
    await fs.writeFile(manifestPath, "");
    await fs.truncate(manifestPath, SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes + 1);

    expect(() => readBoundedSkillSourceManifestSync(manifestPath)).toThrow(
      `exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes} bytes`,
    );
  });

  it("rejects malformed UTF-8 instead of scanning replacement characters", async () => {
    const root = await createEmptyRoot();
    const filePath = path.join(root, "SKILL.md");
    await fs.writeFile(filePath, Buffer.from([0x49, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0xc3, 0x28]));

    await expect(readBoundedSkillTextFile(filePath)).rejects.toThrow(/not canonical UTF-8/u);
  });
});
