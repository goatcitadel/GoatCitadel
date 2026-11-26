import type { LoadedSkill, SkillScanSummary } from "@goatcitadel/contracts";
import { readSkillScanFiles, scanSkillContents } from "./skill-content-scan.js";

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
  const files = await readSkillScanFiles(skill.dir);
  const summary = { ...scanSkillContents(files.files, "operator", { truncated: files.truncated }), treeSha256 };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, summary);
  return summary;
}

export function clearOperatorSkillScanCache(): void {
  cache.clear();
}
