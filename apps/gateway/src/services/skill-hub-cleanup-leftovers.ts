import { SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { SkillHubLifecycleFilesystem } from "./skill-hub-lifecycle-filesystem.js";
import { projectionScratch } from "./skill-hub-runtime-removal.js";

/** The Journey action an applied removal records once when deleting its moved-aside folder fails. */
export const REMOVAL_CLEANUP_FAILED_ACTION = "remove_cleanup_failed";
/** How many workspaces, and how many cleanup failures in each, are read; more than that are not counted. */
const WORKSPACE_LIMIT = 200;
const FAILURES_PER_WORKSPACE = 100;

export interface RemovalCleanupLeftoverSources {
  storage: {
    workspaces: Pick<AsyncStorage["workspaces"], "list">;
    governanceJourneyEvents: Pick<AsyncStorage["governanceJourneyEvents"], "listPage">;
  };
  filesystem: Pick<SkillHubLifecycleFilesystem, "pathKind">;
  /** The runtime skills root the removals moved folders aside in. */
  root: string;
  signal: AbortSignal;
}

/**
 * How many applied removals still have their moved-aside folder in the skills folder after a failed cleanup. It reads
 * the cleanup failures each removal recorded in Journey, then whether that removal's own staging or recovery folder is
 * still there, through the confined lifecycle filesystem (it only reads). The count drops as soon as a folder is gone,
 * whether the retried cleanup or the operator deleted it. A folder that can't be read as plainly gone still counts.
 */
export async function countRemovalCleanupLeftovers(sources: RemovalCleanupLeftoverSources): Promise<number> {
  const { storage, filesystem, root, signal } = sources;
  const operations = new Set<string>();
  for (const workspace of await storage.workspaces.list("all", WORKSPACE_LIMIT)) {
    const page = await storage.governanceJourneyEvents.listPage({
      workspaceId: workspace.workspaceId,
      eventTypes: [SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE],
      actions: [REMOVAL_CLEANUP_FAILED_ACTION],
      limit: FAILURES_PER_WORKSPACE,
    });
    for (const event of page.items) {
      const operationId = event.summary?.operationId;
      if (typeof operationId === "string") operations.add(operationId);
    }
  }
  let leftovers = 0;
  for (const operationId of operations) {
    const scratch = projectionScratch(root, operationId);
    if (
      (await stillThere(filesystem, root, scratch.backup, signal)) ||
      (await stillThere(filesystem, root, scratch.staging, signal))
    ) {
      leftovers += 1;
    }
  }
  return leftovers;
}

async function stillThere(
  filesystem: RemovalCleanupLeftoverSources["filesystem"],
  root: string,
  folder: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    return (await filesystem.pathKind(root, folder, signal)) !== "missing";
  } catch (error) {
    if (signal.aborted) throw error;
    // A link or anything else that can't be read plainly is still something left behind.
    return true;
  }
}
