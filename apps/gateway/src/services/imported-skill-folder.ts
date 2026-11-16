import fsSync from "node:fs";
import type { LoadedSkill } from "@goatcitadel/contracts";

/**
 * An imported (`extra`) skill the loader still lists whose folder is no longer on disk: the loader read it before a
 * governed removal moved its folder aside. Nothing may write a lifecycle record, a skill state or a runtime fence for
 * such a skill when it has no record, or a removed skill would come back (and its fence alone would block a reinstall).
 */
export function importedSkillFolderGone(skill: Pick<LoadedSkill, "source" | "dir">): boolean {
  return skill.source === "extra" && !fsSync.existsSync(skill.dir);
}
