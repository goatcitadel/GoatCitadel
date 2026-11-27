import type { LoadedSkill, SkillScanSummary } from "@goatcitadel/contracts";
import { shouldIncludeSkillContentPath, skillContentTreeSha256 } from "./skill-content-integrity.js";
import { readSkillScanFiles, scanSkillContents, type SkillScanFile } from "./skill-content-scan.js";

/**
 * The content scan of a skill in the operator's own folders (workspace skills and `.assistant/skills`). Its verdict is
 * at most a warning: the operator put the skill there, so a finding is shown, never enforced. Results are kept per
 * skill and content hash, so a skill is rescanned only when its files change.
 */
const OPERATOR_SOURCES: ReadonlySet<LoadedSkill["source"]> = new Set(["workspace", "managed"]);
const CACHE_LIMIT = 512;
const cache = new Map<string, SkillScanSummary>();

export async function operatorSkillScanVerdict(
  skill: Pick<LoadedSkill, "skillId" | "source" | "dir">,
  treeSha256: string | undefined,
): Promise<SkillScanSummary | undefined> {
  if (!OPERATOR_SOURCES.has(skill.source) || !treeSha256) return undefined;
  const key = JSON.stringify([skill.skillId, treeSha256]);
  const cached = cache.get(key);
  if (cached) return cached;
  const read = await readSkillScanFiles(skill.dir, { includeAssetBytes: true });
  // Check exactly the files the content hash covers (it leaves out GoatCitadel's own source.json), so the scan and the
  // key it is cached under always describe the same content.
  const files = { ...read, files: read.files.filter((file) => shouldIncludeSkillContentPath(file.path)) };
  const summary = { ...scanSkillContents(files.files, "operator", { truncated: files.truncated }), treeSha256 };
  // The hash was taken before these reads, so the files may have changed since: keep the result only when the bytes
  // just scanned are exactly the content the hash names, or a later read of that content would reuse the wrong scan.
  if (!files.truncated && scannedExactly(files.files, treeSha256)) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, summary);
  }
  return summary;
}

function scannedExactly(files: readonly SkillScanFile[], treeSha256: string): boolean {
  const fullyRead = files.every((file) => !file.unreadable && (file.size ?? file.bytes.length) === file.bytes.length);
  return fullyRead && skillContentTreeSha256(files) === treeSha256;
}

export function clearOperatorSkillScanCache(): void {
  cache.clear();
}
