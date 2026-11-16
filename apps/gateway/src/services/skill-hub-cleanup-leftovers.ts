import { SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE } from "@goatcitadel/contracts";
import { projectionScratch } from "./skill-hub-runtime-removal.js";

/** The Journey action an applied removal records once when deleting its moved-aside folder fails. */
export const REMOVAL_CLEANUP_FAILED_ACTION = "remove_cleanup_failed";
/** How many workspaces, and how many cleanup failures in each, are read; more than that are not counted. */
export const CLEANUP_WORKSPACE_LIMIT = 200;
const FAILURES_PER_WORKSPACE = 100;

/** The Journey read for one workspace's recorded removal cleanup failures. */
export function removalCleanupFailureQuery(workspaceId: string) {
  return {
    workspaceId,
    eventTypes: [SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE],
    actions: [REMOVAL_CLEANUP_FAILED_ACTION],
    limit: FAILURES_PER_WORKSPACE,
  };
}

/**
 * How many applied removals still have their moved-aside folder in the skills folder after a failed cleanup. It reads
 * the cleanup failures each removal recorded in Journey (`listCleanupFailures`, one workspace at a time), then whether
 * that removal's own staging or recovery folder is still there (`readFolderKind`, the confined lifecycle filesystem's
 * read-only `pathKind` in the runtime skills `root`). The count drops as soon as a folder is gone, whether the retried
 * cleanup or the operator deleted it. A folder that can't be read as plainly gone still counts.
 */
export async function countRemovalCleanupLeftovers(
  listWorkspaceIds: () => Promise<readonly string[]>,
  listCleanupFailures: (workspaceId: string) => Promise<ReadonlyArray<{ summary: Record<string, unknown> }>>,
  readFolderKind: (folder: string) => Promise<string>,
  root: string,
): Promise<number> {
  const operations = new Set<string>();
  for (const workspaceId of await listWorkspaceIds()) {
    for (const event of await listCleanupFailures(workspaceId)) {
      const operationId = event.summary.operationId;
      if (typeof operationId === "string") operations.add(operationId);
    }
  }
  let leftovers = 0;
  for (const operationId of operations) {
    const scratch = projectionScratch(root, operationId);
    if ((await stillThere(readFolderKind, scratch.backup)) || (await stillThere(readFolderKind, scratch.staging))) {
      leftovers += 1;
    }
  }
  return leftovers;
}

async function stillThere(readFolderKind: (folder: string) => Promise<string>, folder: string): Promise<boolean> {
  try {
    return (await readFolderKind(folder)) !== "missing";
  } catch {
    // A link or anything else that can't be read plainly is still something left behind.
    return true;
  }
}
