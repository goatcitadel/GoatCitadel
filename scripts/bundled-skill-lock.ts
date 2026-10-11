import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { captureSkillContentIntegrity } from "../apps/gateway/src/services/skill-content-integrity.js";
import { GENERATED_BUNDLED_SKILL_LOCK } from "../packages/skills/src/bundled-skill-lock.generated.js";
import type { BundledSkillLockEntry } from "../packages/skills/src/bundled-skill-lock.js";
import { parseSkillMarkdown, resolveSkillNameViolation } from "../packages/skills/src/frontmatter.js";

// Release-bound bundled skill lock.
//
// `--check` (default) recomputes the exact-byte tree identity of every skill under
// skills/bundled with the same fingerprint the gateway binds lifecycle rows to, and fails when
// packages/skills/src/bundled-skill-lock.generated.ts disagrees. `--write` regenerates that file.
// Skill ids mirror the loader: `bundled:<frontmatter name>`, skipping identifier-unsafe names.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledRoot = path.join(repoRoot, "skills", "bundled");
const generatedPath = path.join(repoRoot, "packages", "skills", "src", "bundled-skill-lock.generated.ts");
const generatedRelPath = path.relative(repoRoot, generatedPath).replaceAll("\\", "/");

async function collectBundledSkillLockEntries(): Promise<BundledSkillLockEntry[]> {
  const directories = await fs.readdir(bundledRoot, { withFileTypes: true });
  const candidates = [
    bundledRoot,
    ...directories.filter((entry) => entry.isDirectory()).map((entry) => path.join(bundledRoot, entry.name)),
  ];
  const entries: BundledSkillLockEntry[] = [];
  const seen = new Set<string>();
  for (const skillDir of candidates) {
    const skillFile = path.join(skillDir, "SKILL.md");
    let raw: string;
    try {
      raw = await fs.readFile(skillFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const name = parseSkillMarkdown(raw).frontmatter.name;
    const violation = resolveSkillNameViolation(name);
    if (violation) {
      console.warn(`[bundled-skill-lock] skipping ${path.relative(repoRoot, skillFile)}: name ${violation}`);
      continue;
    }
    const skillId = `bundled:${name}`;
    if (seen.has(skillId)) {
      throw new Error(`Duplicate bundled skill id ${skillId} at ${path.relative(repoRoot, skillFile)}.`);
    }
    seen.add(skillId);
    const integrity = await captureSkillContentIntegrity(skillDir);
    entries.push({
      skillId,
      manifestVersion: integrity.manifestVersion,
      treeSha256: integrity.treeSha256,
      fileCount: integrity.fileCount,
      totalBytes: integrity.totalBytes,
    });
  }
  return entries.sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0));
}

function renderGeneratedModule(entries: readonly BundledSkillLockEntry[]): string {
  const lines = [
    "// GENERATED FILE - do not edit by hand.",
    "// Regenerate with `pnpm update:skills:lock`. `pnpm verify:skills:catalog` fails while this lock",
    "// drifts from the skill trees under skills/bundled.",
    'import type { BundledSkillLockEntry } from "./bundled-skill-lock.js";',
    "",
    "export const GENERATED_BUNDLED_SKILL_LOCK: readonly BundledSkillLockEntry[] = [",
  ];
  for (const entry of entries) {
    lines.push(
      "  {",
      `    skillId: ${JSON.stringify(entry.skillId)},`,
      `    manifestVersion: ${JSON.stringify(entry.manifestVersion)},`,
      `    treeSha256: ${JSON.stringify(entry.treeSha256)},`,
      `    fileCount: ${entry.fileCount},`,
      `    totalBytes: ${entry.totalBytes},`,
      "  },",
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

function describeEntry(entry: BundledSkillLockEntry): string {
  return `${entry.treeSha256.slice(0, 12)}… (${entry.fileCount} files, ${entry.totalBytes} bytes)`;
}

function diffLockEntries(
  expected: readonly BundledSkillLockEntry[],
  actual: readonly BundledSkillLockEntry[],
): string[] {
  const actualById = new Map(actual.map((entry) => [entry.skillId, entry]));
  const findings: string[] = [];
  for (const entry of expected) {
    const locked = actualById.get(entry.skillId);
    if (!locked) {
      findings.push(`missing lock entry for ${entry.skillId} (disk ${describeEntry(entry)})`);
      continue;
    }
    actualById.delete(entry.skillId);
    if (
      locked.manifestVersion !== entry.manifestVersion ||
      locked.treeSha256 !== entry.treeSha256 ||
      locked.fileCount !== entry.fileCount ||
      locked.totalBytes !== entry.totalBytes
    ) {
      findings.push(
        `stale lock entry for ${entry.skillId}: lock ${describeEntry(locked)} vs disk ${describeEntry(entry)}`,
      );
    }
  }
  for (const stale of actualById.values()) {
    findings.push(`lock entry ${stale.skillId} has no skill tree on disk`);
  }
  return findings;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const entries = await collectBundledSkillLockEntries();
  if (write) {
    await fs.writeFile(generatedPath, renderGeneratedModule(entries), "utf8");
    console.log(`[bundled-skill-lock] wrote ${entries.length} entries to ${generatedRelPath}`);
    return;
  }
  const findings = diffLockEntries(entries, GENERATED_BUNDLED_SKILL_LOCK);
  if (findings.length === 0) {
    console.log(`[bundled-skill-lock] ${entries.length} bundled skill trees match ${generatedRelPath}`);
    return;
  }
  for (const finding of findings) {
    console.log(`ERROR stale_bundled_skill_lock: ${finding}`);
  }
  console.log(`[bundled-skill-lock] run \`pnpm update:skills:lock\` after reviewing the bundled skill change.`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
