import { createHash } from "node:crypto";
import path from "node:path";
import {
  SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE,
  SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND,
  SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND,
  type CandidateSkillVersionRecord,
  type SkillContentIntegrityManifest,
  type SkillHubOperationIntentRecord,
  type SkillHubOperationSettlementDisposition,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import type { GovernanceJourneyEventRecord } from "@goatcitadel/storage";
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

type RemovalFilesystem = Pick<
  SkillHubLifecycleFilesystem,
  "pathKind" | "directoryMatches" | "renameDirectory" | "listScratchDirectories" | "removeTreeIfPresent"
>;

/** What staging found: whether the folder sits at the recovery path, and how many scratch folders it left alone. */
export interface RuntimeRemovalStaging {
  staged: boolean;
  diverged: boolean;
  /** Staging or recovery folders of other operations left where they are (none could be proven to be this skill's). */
  otherScratchFolders: number;
}

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
 * same operation is accepted when it still matches. When the folder is gone, a staging or recovery folder an earlier,
 * abandoned operation left beside it is taken over (renamed to this operation's recovery path) when it too matches the
 * check exactly, so its cleanup deletes it; one that cannot be proven is left alone and counted. Anything else is
 * reported as diverged and left alone; a link, a reparse point or a path outside the root throws before anything moves.
 */
export async function stageRuntimeRemoval(
  filesystem: RemovalFilesystem,
  root: string,
  operationId: string,
  manifest: SkillContentIntegrityManifest,
  skillName: string,
  signal: AbortSignal,
): Promise<RuntimeRemovalStaging> {
  const scratch = projectionScratch(root, operationId);
  const target = path.join(root, skillName);
  const targetKind = await filesystem.pathKind(root, target, signal);
  const backupKind = await filesystem.pathKind(root, scratch.backup, signal);
  if (targetKind === "missing" && backupKind === "missing") {
    return await takeOverEarlierRecovery(filesystem, root, scratch, manifest, signal);
  }
  const otherScratchFolders = (await otherScratchNames(filesystem, root, scratch, signal)).length;
  if (targetKind === "missing") {
    const movedStillMatches =
      backupKind === "directory" && (await filesystem.directoryMatches(root, scratch.backup, manifest, signal));
    return { staged: movedStillMatches, diverged: !movedStillMatches, otherScratchFolders };
  }
  if (targetKind !== "directory" || backupKind !== "missing") {
    return { staged: false, diverged: true, otherScratchFolders };
  }
  if (!(await filesystem.directoryMatches(root, target, manifest, signal))) {
    return { staged: false, diverged: true, otherScratchFolders };
  }
  await moveAside(filesystem, root, target, scratch.backup, signal);
  return { staged: true, diverged: false, otherScratchFolders };
}

async function otherScratchNames(
  filesystem: RemovalFilesystem,
  root: string,
  scratch: { staging: string; backup: string },
  signal: AbortSignal,
): Promise<string[]> {
  const own = new Set([path.basename(scratch.staging), path.basename(scratch.backup)]);
  return (await filesystem.listScratchDirectories(root, signal)).filter((name) => !own.has(name));
}

/** The first earlier scratch folder that is a plain directory holding exactly the check's files, taken over. */
async function takeOverEarlierRecovery(
  filesystem: RemovalFilesystem,
  root: string,
  scratch: { staging: string; backup: string },
  manifest: SkillContentIntegrityManifest,
  signal: AbortSignal,
): Promise<RuntimeRemovalStaging> {
  let staged = false;
  let otherScratchFolders = 0;
  for (const name of await otherScratchNames(filesystem, root, scratch, signal)) {
    const candidate = path.join(root, name);
    if (!staged && (await provenCheckFolder(filesystem, root, candidate, manifest, signal))) {
      await moveAside(filesystem, root, candidate, scratch.backup, signal);
      staged = true;
      continue;
    }
    otherScratchFolders += 1;
  }
  return { staged, diverged: false, otherScratchFolders };
}

/** Whether a folder is a plain directory holding exactly the check's files. Anything unprovable, a link included, is not. */
async function provenCheckFolder(
  filesystem: RemovalFilesystem,
  root: string,
  folder: string,
  manifest: SkillContentIntegrityManifest,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    return (
      (await filesystem.pathKind(root, folder, signal)) === "directory" &&
      (await filesystem.directoryMatches(root, folder, manifest, signal))
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

async function moveAside(
  filesystem: RemovalFilesystem,
  root: string,
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await filesystem.renameDirectory(root, source, target, signal);
  } catch (error) {
    throw new RuntimeRemovalBoundaryError(error instanceof Error ? error.message : String(error), { cause: error });
  }
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

/**
 * At most this many versions of one lineage are proven revoked; the owner reads one more, so a lineage with more cannot
 * be proven all revoked.
 */
export const LINEAGE_VERSION_LIMIT = 100;

/**
 * Why the intent's candidate lineage must not be removed now, or nothing when it may. A lineage that already has an
 * applied removal is refused: a removed lineage's runtime fence is gone, so a copy installed later from the same check
 * starts again at the same revisions, and only this tells an approval for the removed lineage apart from one for the
 * copy. A lineage with a version that is not revoked (or more versions than can be read) is refused too, as the guard
 * required when the removal was asked for.
 */
function lineageBlock(
  intent: SkillHubOperationIntentRecord,
  lineage: RuntimeRemovalContext["lineage"],
): "lineage_already_removed" | "candidate_not_revoked" | undefined {
  if (lineage.removedCandidateIds.includes(intent.targetCandidateId!)) return "lineage_already_removed";
  const { versions } = lineage;
  if (versions.length > LINEAGE_VERSION_LIMIT || versions.some((version) => version.lifecycleState !== "revoked")) {
    return "candidate_not_revoked";
  }
  return undefined;
}

export interface RuntimeRemovalContext {
  intent: SkillHubOperationIntentRecord;
  candidate: CandidateSkillVersionRecord;
  /** The skill's lifecycle record as it is now. */
  record: SkillLifecycleRecord | undefined;
  /**
   * The intent's candidate lineage as the records say now: the candidate ids with an applied removal in the intent's
   * workspace, and the lineage's versions (up to `LINEAGE_VERSION_LIMIT` + 1).
   */
  lineage: { removedCandidateIds: readonly string[]; versions: readonly CandidateSkillVersionRecord[] };
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
  /**
   * Deletes the runtime record and its fence and settles `applied`, in one transaction; `detail` goes into the
   * settlement's result.
   */
  commit(staged: boolean, detail: Record<string, unknown>): Promise<SkillHubLifecycleApplyResult>;
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
  const lineage = lineageBlock(intent, context.lineage);
  if (lineage === "lineage_already_removed") {
    return await context.settle("blocked", intent.contentTreeSha256, { code: lineage, boundaryCrossed: false });
  }
  const recordBlock = removalRecordBlock(intent, context.record, context.candidate);
  if (recordBlock) {
    return await context.settle("blocked", intent.contentTreeSha256, { code: recordBlock, boundaryCrossed: false });
  }
  if (lineage) {
    return await context.settle("blocked", intent.contentTreeSha256, { code: lineage, boundaryCrossed: false });
  }
  let staging: RuntimeRemovalStaging;
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
    return await context.commit(
      staging.staged,
      staging.otherScratchFolders > 0 ? { otherScratchFolders: staging.otherScratchFolders } : {},
    );
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

/**
 * After an applied activation or removal: deletes this operation's own staging and recovery folders through the confined
 * lifecycle filesystem, then reads the skills folder again. A cleanup that fails is recorded for the operator through
 * `recordFailure` and rethrown, so the effect is retried.
 */
export async function finishAppliedProjection(
  filesystem: RemovalFilesystem,
  root: string,
  input: {
    intent: SkillHubOperationIntentRecord;
    signal: AbortSignal;
    recordFailure: (error: unknown) => Promise<void>;
    reloadSkills?: () => Promise<unknown>;
  },
): Promise<void> {
  const { intent, signal } = input;
  const scratch = projectionScratch(root, intent.operationId);
  try {
    await filesystem.removeTreeIfPresent(root, scratch.staging, signal);
    await filesystem.removeTreeIfPresent(root, scratch.backup, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    try {
      await input.recordFailure(error);
    } catch (recordError) {
      throw new AggregateError([error, recordError], "Skill Hub cleanup failed and could not be recorded.", {
        cause: recordError,
      });
    }
    throw error;
  }
  await input.reloadSkills?.();
}

/**
 * The Journey event that says, once per operation, that deleting an applied operation's staging or recovery folder
 * failed. It sits beside the operation's own event: the settlement stays as it is (it is immutable), the effect is
 * retried, and the operator can see a folder was left behind. Only the error's code or name is kept, never a path.
 */
export function projectionCleanupFailureEvent(
  intent: SkillHubOperationIntentRecord,
  error: unknown,
  now: string,
): GovernanceJourneyEventRecord {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `skill-hub:journey:${intent.operationId}:cleanup`,
    idempotencyKey: `skill-hub:lifecycle:${intent.operationId}:cleanup`,
    scopeKind: "workspace",
    workspaceId: intent.workspaceId,
    eventType: SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE,
    subjectKind: SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND,
    subjectId: intent.skillId,
    action: `${intent.operationKind}_cleanup_failed`,
    actorId: intent.actorId,
    actorType: "approval_effect",
    approvalId: intent.approvalId,
    fingerprint: intent.requestSha256,
    sourceKind: SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND,
    sourceId: intent.snapshotId,
    trustDisposition: "manual_reconciliation",
    evidenceRefs: [
      { owner: "approval", refId: intent.approvalId },
      { owner: "upstream_snapshot", refId: intent.snapshotId },
    ],
    provenance: { approvalRequired: true, sourceRequired: true },
    summary: {
      operationId: intent.operationId,
      code: "projection_scratch_cleanup_failed",
      error: typeof code === "string" ? code : error instanceof Error ? error.name : "unknown",
    },
    occurredAt: now,
    recordedAt: now,
  };
}
