import { createHash } from "node:crypto";
import path from "node:path";
import {
  ConflictError,
  type CandidateSkillVersionRecord,
  type CandidateSkillEvaluationBinding,
  type LearningReviewSource,
  type SkillListItem,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { parseSkillMarkdown } from "@goatcitadel/skills";
import { readCandidateSkillArtifacts } from "./candidate-skill-artifact-review.js";
import { assertBackgroundSkillSourcesCurrent } from "./background-skill-draft-service.js";
type EvidenceStorage = Pick<
  AsyncStorage,
  | "candidateSkillVersions"
  | "skillAggregateRevisions"
  | "backgroundLearningJobs"
  | "chatTurnTraces"
  | "chatToolRuns"
  | "skillEvaluationRuns"
>;
type EvidenceDeps = { storage: EvidenceStorage; rootDir: string; candidateRoot: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function readBackgroundSkillEvaluationTarget(deps: EvidenceDeps, version: CandidateSkillVersionRecord) {
  if (
    version.sourceKind !== "background_workflow" ||
    version.lineageStatus !== "governed" ||
    !version.workspaceId ||
    !version.sourceFingerprint ||
    version.createdByActorId !== "system:background-learning" ||
    version.programArtifact ||
    version.schemaArtifact
  )
    throw new ConflictError({ message: "Background workflow provenance is unavailable." });
  const revision = await deps.storage.skillAggregateRevisions.get("candidate_skill", version.candidateId);
  if (!revision) throw new ConflictError({ message: "Background workflow revision is unavailable." });
  const review = await readCandidateSkillArtifacts(
    deps.rootDir,
    path.resolve(deps.rootDir, deps.candidateRoot),
    version,
    revision.revision,
  );
  const manifest = JSON.parse(review.artifacts.find((item) => item.label === "Provenance")!.content) as Record<
    string,
    unknown
  >;
  if (
    manifest.candidateId !== version.candidateId ||
    manifest.versionId !== version.versionId ||
    manifest.workspaceId !== version.workspaceId ||
    manifest.sourceFingerprint !== version.sourceFingerprint ||
    manifest.requestAuthority !== "system_proposal_only" ||
    typeof manifest.learningJobId !== "string" ||
    typeof manifest.sourceSessionId !== "string" ||
    !Array.isArray(manifest.learningReviewSources)
  )
    throw new ConflictError({ message: "Background workflow manifest changed." });
  const fingerprint = await assertBackgroundSkillSourcesCurrent(deps.storage, {
    jobId: manifest.learningJobId,
    workspaceId: version.workspaceId,
    sessionId: manifest.sourceSessionId,
    sources: manifest.learningReviewSources as LearningReviewSource[],
  });
  if (fingerprint !== version.sourceFingerprint)
    throw new ConflictError({ message: "Background workflow source evidence changed. Prepare a fresh draft." });
  const markdown = review.artifacts.find((item) => item.label === "Instructions")!.content,
    parsed = parseSkillMarkdown(markdown);
  const binding: CandidateSkillEvaluationBinding = {
    candidateId: version.candidateId,
    versionId: version.versionId,
    revision: revision.revision,
    instructionSha256: version.instructionArtifact.sha256,
    manifestSha256: version.manifestArtifact.sha256,
    sourceFingerprint: version.sourceFingerprint,
  };
  const skill: SkillListItem = {
    skillId: `candidate-version:${version.versionId}`,
    name: parsed.frontmatter.name,
    source: "extra",
    dir: path.resolve(deps.rootDir, version.bundleRoot),
    tags: [],
    declaredTools: [],
    requires: [],
    keywords: [],
    instructionBody: parsed.body,
    mtime: version.updatedAt,
    revision: revision.revision,
    state: "disabled",
    lifecycleState: version.lifecycleState,
    callable: false,
  };
  return { skill, binding };
}
export async function resolveBackgroundSkillEvaluationTarget(deps: EvidenceDeps, skillId: string) {
  if (!skillId.startsWith("candidate-version:")) return undefined;
  const version = await deps.storage.candidateSkillVersions.find(skillId.slice("candidate-version:".length));
  return version ? readBackgroundSkillEvaluationTarget(deps, version) : undefined;
}
export async function assertBackgroundSkillEvaluationCurrent(
  deps: EvidenceDeps,
  version: CandidateSkillVersionRecord,
): Promise<void> {
  if (version.sourceKind !== "background_workflow") return;
  const { skill, binding } = await readBackgroundSkillEvaluationTarget(deps, version);
  const runs = await deps.storage.skillEvaluationRuns.listBySkill(skill.skillId);
  const eligible = runs.some(
    (run) =>
      run.status === "completed" &&
      run.accepted &&
      run.candidateBinding &&
      run.candidateBinding.candidateId === binding.candidateId &&
      run.candidateBinding.versionId === binding.versionId &&
      (run.candidateBinding.revision === binding.revision ||
        ["approved", "trusted"].includes(version.lifecycleState)) &&
      run.candidateBinding.instructionSha256 === binding.instructionSha256 &&
      run.candidateBinding.manifestSha256 === binding.manifestSha256 &&
      run.candidateBinding.sourceFingerprint === binding.sourceFingerprint &&
      run.baselineResult.instructionHash === hash(skill.instructionBody) &&
      run.baselineResult.score.passRate >= run.targetPassRate &&
      run.scenarios.length >= 2 &&
      new Set(run.scenarios.map((item) => item.prompt.trim().toLowerCase())).size >= 2 &&
      run.scenarios.some((item) => item.tags?.includes("held_out")),
  );
  if (!eligible)
    throw new ConflictError({
      message:
        "Evaluate this exact draft with a distinct held-out example before requesting activation. Static coverage is separate from observed task success.",
    });
}
