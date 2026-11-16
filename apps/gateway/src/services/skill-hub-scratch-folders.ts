import { logger } from "@goatcitadel/gateway-core";
import { isSkillHubScratchFolderName } from "@goatcitadel/skills";

const log = logger.child("skill-hub-scratch");

/** Where a skipped folder's debug line goes: the Gateway's logger, which writes it only at debug level. */
export type SkillHubScratchLog = Pick<typeof log, "debug">;

/**
 * Whether a folder in a skills folder is one of Skill Hub's staging or recovery folders, which every listing of
 * installed skills skips. Each skipped folder is logged once at debug level, naming only the folder and which listing
 * skipped it, never a path.
 */
export function skipsSkillHubScratchFolder(name: string, listing: string, sink: SkillHubScratchLog = log): boolean {
  if (!isSkillHubScratchFolderName(name)) return false;
  sink.debug(`Skipping a Skill Hub scratch folder: ${name}`, { listing, folder: name });
  return true;
}
