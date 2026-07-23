import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillImportService } from "./skill-import-service.js";
import { SKILL_CONTENT_INTEGRITY_LIMITS } from "./skill-content-integrity.js";

function createSystemSettingsRepo() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): { value: T } | undefined {
      if (!store.has(key)) {
        return undefined;
      }
      return { value: store.get(key) as T };
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

describe("SkillImportService loop41 zip install behavior", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-loop41-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // HX-402 P2 (coverage-preserving remodel): local zip bundles validate
  // byte-exactly but can never publish — with or without force — and the
  // redirect marks them ineligible for the governed hub (local sources).
  it("validates local zip bundles and redirects without ever publishing bytes", async () => {
    const firstZip = createSkillZip(rootDir, "zip-runtime-tool-a.zip");
    const secondZip = createSkillZip(rootDir, "zip-runtime-tool-b.zip");
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

    const firstAttempt = await service.installImport({
      sourceRef: firstZip,
      sourceType: "local_zip",
      sourceProvider: "local",
    });
    expect(firstAttempt.validation.valid).toBe(true);
    expect(firstAttempt.validation.riskLevel).toBe("low");
    expect(firstAttempt.validation.candidate).toMatchObject({
      sourceProvider: "local",
      sourceType: "local_zip",
      sourceRef: firstZip,
    });
    expect(firstAttempt.redirect).toMatchObject({
      owner: "skill_hub",
      eligible: false,
      ineligibleReason: expect.stringContaining("governed Skill Hub"),
    });
    // ADVERSARIAL: repeated and forced attempts still publish nothing.
    const forcedAttempt = await service.installImport({
      sourceRef: secondZip,
      sourceType: "local_zip",
      sourceProvider: "local",
      force: true,
      confirmHighRisk: true,
    });
    expect(forcedAttempt.disposition).toBe("redirected_to_skill_hub");
    expect(fs.existsSync(path.join(rootDir, "skills", "extra"))).toBe(false);
    const lookup = await service.lookupSources(secondZip, 5);
    expect(lookup.bestMatch).toMatchObject({
      sourceProvider: "local",
      alreadyInstalled: false,
    });
    expect(service.listHistory(3)).toEqual([
      expect.objectContaining({
        action: "install",
        outcome: "accepted",
        sourceRef: secondZip,
        details: expect.objectContaining({ disposition: "redirected_to_skill_hub" }),
      }),
      expect.objectContaining({
        action: "install",
        outcome: "accepted",
        sourceRef: firstZip,
        details: expect.objectContaining({ disposition: "redirected_to_skill_hub" }),
      }),
    ]);
    // Real zip pack/unpack over the filesystem is genuinely slow; under v8
    // coverage instrumentation in a loaded parallel run it can exceed the
    // default 15s budget, so give this I/O-heavy case explicit headroom.
  }, 30_000);

  it("rejects a zip entry whose declared uncompressed size exceeds the shared per-file limit", async () => {
    const zipPath = path.join(rootDir, "oversized-zip-skill.zip");
    const zip = new AdmZip();
    zip.addFile(
      "bundle/oversized-zip-skill/SKILL.md",
      Buffer.from(
        [
          "---",
          "name: Oversized Zip Skill",
          "description: Valid metadata paired with an oversized archive entry.",
          "---",
          "",
          "This archive must be rejected before extraction.",
          "",
        ].join("\n"),
      ),
    );
    zip.addFile(
      "bundle/oversized-zip-skill/oversized.bin",
      Buffer.alloc(SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1),
    );
    zip.writeZip(zipPath);
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

    await expect(
      service.installImport({
        sourceRef: zipPath,
        sourceType: "local_zip",
        sourceProvider: "local",
      }),
    ).rejects.toThrow(`exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes} bytes`);

    expect(fs.existsSync(path.join(rootDir, "skills", "extra", "oversized-zip-skill"))).toBe(false);
  });
});

function createSkillZip(rootDir: string, fileName: string): string {
  const sourceRoot = path.join(rootDir, `${fileName}-source`);
  const skillDir = path.join(sourceRoot, "nested", "zip-runtime-tool");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: Zip Runtime Tool",
      "description: Validate zipped runtime skill installation metadata behavior.",
      "---",
      "",
      "Use this zipped skill fixture to validate install cleanup and metadata handling.",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n", "utf8");
  const zipPath = path.join(rootDir, fileName);
  const zip = new AdmZip();
  zip.addLocalFolder(sourceRoot, "bundle");
  zip.writeZip(zipPath);
  return zipPath;
}
