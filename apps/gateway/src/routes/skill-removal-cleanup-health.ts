import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { redactStructuredSecrets } from "@goatcitadel/contracts";

/** How long the health summary waits for the skill removal cleanup count before it answers without it. */
const SKILL_REMOVAL_CLEANUP_WAIT_MS = 2_000;
/** Whether the last read of the skill removal cleanup count failed, so a streak of failures is warned about once. */
let skillRemovalCleanupFailing = false;

/**
 * System › Health's count of applied skill removals whose moved-aside folder is still in the skills folder. A host that
 * doesn't compose it, a read that fails, or one slower than `SKILL_REMOVAL_CLEANUP_WAIT_MS` answers nothing (logged at
 * debug), so the health summary never waits long on it, never fails for it, and the page never reads it as none left.
 */
export async function readSkillRemovalCleanup(
  fastify: FastifyInstance,
  log: FastifyBaseLogger,
): Promise<{ leftFolders: number } | undefined> {
  const owner = fastify.services.capabilitySkills?.removalCleanup;
  if (!owner) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), SKILL_REMOVAL_CLEANUP_WAIT_MS);
  });
  try {
    const leftFolders = await Promise.race([owner.countLeftovers(), late]);
    if (leftFolders === undefined) log.debug("skill removal cleanups took too long to read");
    else skillRemovalCleanupFailing = false;
    return leftFolders === undefined ? undefined : { leftFolders };
  } catch (error) {
    const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: String(error) };
    // Once at warn when the reads start failing, then at debug until one succeeds again.
    const report = { err: redactStructuredSecrets(diagnostic).value };
    if (skillRemovalCleanupFailing) log.debug(report, "skill removal cleanups could not be read");
    else log.warn(report, "skill removal cleanups could not be read");
    skillRemovalCleanupFailing = true;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
