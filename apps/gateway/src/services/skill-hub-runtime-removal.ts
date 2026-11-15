import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CandidateSkillVersionRecord,
  SkillContentIntegrityManifest,
  SkillHubOperationIntentRecord,
  SkillHubOperationSettlementDisposition,
  SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import { isBundledSkillName } from "./plugin-skill-name-rules.js";
import type { StoredPlugin } from "./capability-plugin-store.js";
import type { SkillHubLifecycleFilesystem } from "./skill-hub-lifecycle-filesystem.js";
import type { SkillHubLifecycleApplyResult } from "./skill-hub-lifecycle-service.js";

/** The observed tree recorded when what is on disk could not be read as the check's own. */
export const UNKNOWN_TREE_SHA256 = "0".repeat(64);

/**
 * The pieces of a governed Skill Hub removal that decide what may be touched on disk. Everything here only reads, or
 * moves one folder inside the runtime skills root through the lifecycle filesystem port, which resolves every path
 * against the managed root and refuses links, reparse points and anything outside it. No path here is built from
 * operator or model input: the folder is the skill's own name (checked against the approved intent) and the recovery
 * path is derived from the operation id.
 */

/** The rename that moves a removed skill's folder aside failed, so where the folder is now is not known. */
export class RuntimeRemovalBoundaryError extends Error {}

type RemovalFilesystem = Pick<SkillHubLifecycleFilesystem, "pathKind" | "directoryMatches" | "renameDirectory">;

/** The staging and recovery folders of one operation, beside the skills they belong to. */
export function projectionScratch(root: string, operationId: string): { staging: string; backup: string } {
  const token = createHash("sha256").update(operationId, "utf8").digest("hex").slice(0, 24);
  return {
    staging: path.join(root, `.skill-hub-${token}.staging`),
    backup: path.join(root, `.skill-hub-${token}.backup`),
  };
}

/** Why a removal must not go ahead on what the records say now, or nothing when it may. */
export function removalRecordBlock(
  intent: SkillHubOperationIntentRecord,
  runtime: SkillLifecycleRecord | undefined,
  candidate: CandidateSkillVersionRecord,
): "skill_not_revoked" | "runtime_not_from_check" | undefined {
  if (!runtime || runtime.lifecycleState !== "revoked" || candidate.lifecycleState !== "revoked") {
    return "skill_not_revoked";
  }
  if (
    runtime.provenance?.sourceRef !== intent.snapshotId ||
    runtime.provenance?.contentIntegrity?.treeSha256 !== intent.contentTreeSha256
  ) {
    return "runtime_not_from_check";
  }
  return undefined;
}

/**
 * Why a skill is not the operator's to remove: it is named like a skill that ships with GoatCitadel, or a plugin record
 * (in any state) still lists it. Nothing when it may go.
 */
export function ownedSkillBlock(
  plugins: readonly StoredPlugin[],
  intent: SkillHubOperationIntentRecord,
  skillName: string,
): "bundled_skill" | "plugin_still_installed" | undefined {
  if (isBundledSkillName(skillName)) return "bundled_skill";
  const listed = plugins.some((plugin) =>
    plugin.pieces.some(
      (piece) =>
        piece.kind === "skill" &&
        (piece.skillSnapshotId === intent.snapshotId || piece.removed?.skillId === intent.skillId),
    ),
  );
  return listed ? "plugin_still_installed" : undefined;
}

/**
 * Moves the skill's runtime folder to the operation's recovery path when, and only when, it is a plain directory inside
 * the runtime skills root whose files are exactly the check's. A folder already moved by an earlier attempt of this
 * same operation is accepted when it still matches. Anything else is reported as diverged and left alone; a link, a
 * reparse point or a path outside the root throws before anything moves.
 */
export async function stageRuntimeRemoval(
  filesystem: RemovalFilesystem,
  root: string,
  operationId: string,
  manifest: SkillContentIntegrityManifest,
  skillName: string,
  signal: AbortSignal,
): Promise<{ staged: boolean; diverged: boolean }> {
  const scratch = projectionScratch(root, operationId);
  const target = path.join(root, skillName);
  const targetKind = await filesystem.pathKind(root, target, signal);
  const backupKind = await filesystem.pathKind(root, scratch.backup, signal);
  if (targetKind === "missing") {
    if (backupKind === "missing") return { staged: false, diverged: false };
    const movedStillMatches =
      backupKind === "directory" && (await filesystem.directoryMatches(root, scratch.backup, manifest, signal));
    return movedStillMatches ? { staged: true, diverged: false } : { staged: false, diverged: true };
  }
  if (targetKind !== "directory" || backupKind !== "missing") return { staged: false, diverged: true };
  if (!(await filesystem.directoryMatches(root, target, manifest, signal))) return { staged: false, diverged: true };
  try {
    await filesystem.renameDirectory(root, target, scratch.backup, signal);
  } catch (error) {
    throw new RuntimeRemovalBoundaryError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return { staged: true, diverged: false };
}

/** Puts a moved folder back after a failed commit. If it cannot, it stays at its recovery path for the retry. */
export async function restoreStagedRemoval(
  filesystem: RemovalFilesystem,
  root: string,
  operationId: string,
  skillName: string,
  signal: AbortSignal,
  cause: unknown,
): Promise<void> {
  const scratch = projectionScratch(root, operationId);
  const target = path.join(root, skillName);
  try {
    if (
      (await filesystem.pathKind(root, target, signal)) === "missing" &&
      (await filesystem.pathKind(root, scratch.backup, signal)) === "directory"
    ) {
      await filesystem.renameDirectory(root, scratch.backup, target, signal);
    }
  } catch (restoreError) {
    throw new AggregateError(
      [cause, restoreError],
      "Skill Hub removal failed and its moved folder could not be put back; it stays at its recovery path.",
      { cause: restoreError },
    );
  }
}

export interface RuntimeRemovalContext {
  intent: SkillHubOperationIntentRecord;
  candidate: CandidateSkillVersionRecord;
  /** The skill's lifecycle record as it is now. */
  record: SkillLifecycleRecord | undefined;
  manifest: SkillContentIntegrityManifest;
  skillName: string;
  signal: AbortSignal;
  /** Whether the retained check bytes still verify. */
  artifactVerifies: boolean;
  filesystem: RemovalFilesystem;
  root: string;
  settle(
    disposition: SkillHubOperationSettlementDisposition,
    observedTreeSha256: string,
    result: Record<string, unknown>,
  ): Promise<SkillHubLifecycleApplyResult>;
  /** Deletes the runtime record and its fence and settles `applied`, in one transaction. */
  commit(staged: boolean): Promise<SkillHubLifecycleApplyResult>;
  /**
   * Reads the skills folder again, so the loaded list matches what is on disk. Called once the folder is moved aside
   * and before the record goes, so no skills list can see a loaded skill without its record, and again after a failed
   * commit put the folder back.
   */
  reloadSkills?: () => Promise<unknown>;
  /** Test-only crash seam after the folder was moved and before the commit. */
  afterStage?: (operationId: string) => Promise<void> | void;
}

/**
 * The approved removal of a revoked skill. Before anything moves it re-checks that the check's bytes verify, that the
 * runtime record and the candidate are revoked and that the record names this very check. It then moves the skill's
 * folder aside only when it still matches the check's files, and commits the record deletion and the settlement in one
 * transaction. The moved folder is deleted after the settlement, by the caller. A folder that cannot be proven to be the
 * check's own is left exactly where it is and the operation settles for a manual step. If the commit fails after the
 * move, the folder is put back; a crash instead leaves the record intact and the folder at its recovery path, which the
 * retried effect finishes.
 */
export async function runRuntimeRemoval(context: RuntimeRemovalContext): Promise<SkillHubLifecycleApplyResult> {
  const { intent, signal } = context;
  if (!context.artifactVerifies) {
    return await context.settle("blocked", UNKNOWN_TREE_SHA256, { code: "artifact_tamper", boundaryCrossed: false });
  }
  const recordBlock = removalRecordBlock(intent, context.record, context.candidate);
  if (recordBlock) {
    return await context.settle("blocked", intent.contentTreeSha256, { code: recordBlock, boundaryCrossed: false });
  }
  let staging: { staged: boolean; diverged: boolean };
  try {
    staging = await stageRuntimeRemoval(
      context.filesystem,
      context.root,
      intent.operationId,
      context.manifest,
      context.skillName,
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return await context.settle("manual_reconciliation", UNKNOWN_TREE_SHA256, {
      code: "runtime_removal_unverifiable",
      boundaryCrossed: error instanceof RuntimeRemovalBoundaryError,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (staging.diverged) {
    return await context.settle("manual_reconciliation", UNKNOWN_TREE_SHA256, {
      code: "runtime_projection_diverged",
      boundaryCrossed: false,
    });
  }
  await context.afterStage?.(intent.operationId);
  try {
    signal.throwIfAborted();
    // The loader skips the recovery folder, so after this read the skill is no longer loaded: a skills list in the
    // window between the commit and the caller's final reload cannot write the record or its fence back.
    await context.reloadSkills?.();
    return await context.commit(staging.staged);
  } catch (error) {
    if (staging.staged) {
      await restoreStagedRemoval(
        context.filesystem,
        context.root,
        intent.operationId,
        context.skillName,
        signal,
        error,
      );
      await context.reloadSkills?.();
    }
    throw error;
  }
}
