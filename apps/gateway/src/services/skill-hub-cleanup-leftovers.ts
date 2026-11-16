import { projectionScratch, removalCleanupGeneration } from "./skill-hub-runtime-removal.js";

/** How long a count is kept before it is read again, unless a removal's cleanup ran or failed meanwhile. */
export const REMOVAL_CLEANUP_COUNT_TTL_MS = 60_000;

/**
 * System › Health's count of applied removals whose moved-aside folder is still in the skills folder after a failed
 * cleanup. One install-wide read of the cleanup failures removals recorded in Journey (`listCleanupFailures`); with none
 * it answers 0 and touches no file. Otherwise, when the runtime skills `root` doesn't exist it answers 0 (it never
 * creates it: `rootExists` only reads), and else it asks, for each failed operation, whether its own staging or recovery
 * folder is still there (`readFolderKind`, the confined lifecycle filesystem's read-only kind of a path). A folder that
 * can't be read plainly still counts. The count is kept for `REMOVAL_CLEANUP_COUNT_TTL_MS`, or until a removal's
 * cleanup runs or fails, so the health summary's frequent reads do the work once.
 */
export function createRemovalCleanupCounter(
  listCleanupFailures: () => Promise<ReadonlyArray<{ summary: Record<string, unknown> }>>,
  rootExists: () => Promise<boolean>,
  readFolderKind: (folder: string) => Promise<string>,
  root: string,
  now: () => number = Date.now,
): () => Promise<number> {
  let kept: { value: number; at: number; generation: number } | undefined;
  return async () => {
    const generation = removalCleanupGeneration();
    if (kept && kept.generation === generation && now() - kept.at < REMOVAL_CLEANUP_COUNT_TTL_MS) return kept.value;
    const value = await countLeftovers(listCleanupFailures, rootExists, readFolderKind, root);
    kept = { value, at: now(), generation };
    return value;
  };
}

async function countLeftovers(
  listCleanupFailures: () => Promise<ReadonlyArray<{ summary: Record<string, unknown> }>>,
  rootExists: () => Promise<boolean>,
  readFolderKind: (folder: string) => Promise<string>,
  root: string,
): Promise<number> {
  const operations = new Set<string>();
  for (const event of await listCleanupFailures()) {
    const operationId = event.summary.operationId;
    if (typeof operationId === "string") operations.add(operationId);
  }
  if (operations.size === 0 || !(await rootExists())) return 0;
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
