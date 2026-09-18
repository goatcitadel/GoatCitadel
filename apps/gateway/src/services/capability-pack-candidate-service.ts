import path from "node:path";
import { createHash } from "node:crypto";
import {
  ConflictError,
  type CapabilityArtifactRecord,
  type CandidateSkillVersionRecord,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { writeImmutableBundle } from "./candidate-skill-artifacts.js";
import { validateSkillContent } from "./skill-content-validation.js";
import { packBindingHash, type PackAssetBinding } from "./capability-pack-bindings.js";

export function packCandidateIds(workspaceId: string, packId: string, binding: PackAssetBinding) {
  const candidateId = `pack-${packBindingHash({ workspaceId, packId }).slice(0, 24)}`;
  const versionId = `${candidateId}-${packBindingHash(binding).slice(0, 24)}`;
  return { candidateId, versionId, proposalId: `${versionId}-proposal` };
}

export type PackCandidateStorage = Pick<
  AsyncStorage,
  "candidateSkillVersions" | "capabilityProposals" | "runImmediateTransaction" | "skillAggregateRevisions"
>;

/** Publishes an immutable, inactive candidate. Activation stays with the capability lifecycle owner. */
export async function stagePackSkillCandidate(
  deps: { storage: PackCandidateStorage; rootDir: string; candidateRoot: string },
  plan: ChangePlanRecord,
  packId: string,
  binding: Extract<PackAssetBinding, { owner: "capability_candidate" }>,
) {
  const ids = packCandidateIds(plan.origin.workspaceId, packId, binding);
  const existing = await deps.storage.candidateSkillVersions.find(ids.versionId);
  const validation = validateSkillContent({ skillMarkdown: binding.markdown });
  if (!validation.valid)
    throw new ConflictError({
      message: `The bundled skill failed content validation: ${validation.errors.join("; ")}`,
    });
  const createdAt = existing?.createdAt ?? plan.createdAt;
  const actorId = existing?.createdByActorId ?? plan.origin.actorId;
  const sourceFingerprint = packBindingHash(binding);
  const root = path.resolve(deps.rootDir, deps.candidateRoot);
  const bundle = path.join(root, ids.candidateId, ids.versionId);
  const files = {
    "manifest.json": JSON.stringify(
      {
        ...ids,
        sourceKind: "capability_pack",
        packId,
        workspaceId: plan.origin.workspaceId,
        sourceFingerprint,
        createdAt,
        createdByActorId: actorId,
      },
      null,
      2,
    ),
    "SKILL.md": binding.markdown,
    "proof.json": JSON.stringify(
      { validation, sourceFingerprint, behavioralValidation: "not_run", callable: false },
      null,
      2,
    ),
  };
  const artifact = (filename: keyof typeof files, mimeType: string): CapabilityArtifactRecord => ({
    artifactId: `${ids.versionId}-${filename}`,
    relPath: path.relative(deps.rootDir, path.join(bundle, filename)).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(files[filename]).digest("hex"),
    bytes: Buffer.byteLength(files[filename]),
    mimeType,
    createdAt,
  });
  const candidate: CandidateSkillVersionRecord = {
    ...ids,
    sourceKind: "capability_pack",
    lineageStatus: "governed",
    workspaceId: plan.origin.workspaceId,
    sourceFingerprint,
    createdByActorId: actorId,
    title: "Browser QA workflow",
    summary: "Reviewed bundled instructions; approval is required for activation.",
    lifecycleState: "candidate",
    bundleRoot: path.relative(deps.rootDir, bundle).replaceAll("\\", "/"),
    createdAt,
    updatedAt: createdAt,
    manifestArtifact: artifact("manifest.json", "application/json"),
    instructionArtifact: artifact("SKILL.md", "text/markdown"),
    proofArtifact: artifact("proof.json", "application/json"),
  };
  await writeImmutableBundle(root, bundle, files);
  await deps.storage.runImmediateTransaction(async () => {
    const replay = await deps.storage.candidateSkillVersions.find(ids.versionId);
    if (replay) {
      if (
        replay.sourceFingerprint !== sourceFingerprint ||
        replay.instructionArtifact.sha256 !== candidate.instructionArtifact.sha256 ||
        !(await deps.storage.capabilityProposals.find(ids.proposalId))
      )
        throw new ConflictError({ message: "Pack candidate ledger does not match its reviewed binding." });
      return;
    }
    const revision = await deps.storage.skillAggregateRevisions.get("candidate_skill", ids.candidateId);
    if (revision)
      await deps.storage.skillAggregateRevisions.fenceExpectedRevision(
        "candidate_skill",
        ids.candidateId,
        revision.revision,
        createdAt,
      );
    else
      await deps.storage.skillAggregateRevisions.createInitialRevisionFence(
        "candidate_skill",
        ids.candidateId,
        createdAt,
      );
    await deps.storage.candidateSkillVersions.upsert(candidate);
    await deps.storage.capabilityProposals.upsert({
      proposalId: ids.proposalId,
      candidateId: ids.candidateId,
      proposalKind: "skill",
      status: "proposed",
      activationTargetId: ids.candidateId,
      title: candidate.title,
      summary: candidate.summary ?? "Bundled skill",
      payload: {
        workspaceId: plan.origin.workspaceId,
        versionId: ids.versionId,
        packId,
        sourceFingerprint,
        behavioralValidation: "not_run",
      },
      createdAt,
      updatedAt: createdAt,
    });
    if (revision)
      await deps.storage.skillAggregateRevisions.advanceExpectedRevision(
        "candidate_skill",
        ids.candidateId,
        revision.revision,
        createdAt,
      );
  });
  return ids;
}
