import path from "node:path";
import { createHash } from "node:crypto";
import {
  ConflictError,
  type CandidateSkillVersionRecord,
  type LoadedSkill,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import { parseSkillMarkdown, resolveSkillNameViolation } from "@goatcitadel/skills";
import { readCandidateSkillArtifacts } from "./candidate-skill-artifact-review.js";
import { captureSkillContentIntegrity } from "./skill-content-integrity.js";

/** Project only reviewed instruction bundles; never execute a candidate program. */
export async function loadApprovedCandidateSkill(input: {
  rootDir: string;
  candidateRoot: string;
  version: CandidateSkillVersionRecord;
  workspaceId: string;
}): Promise<{ skill: LoadedSkill; lifecycle: SkillLifecycleRecord } | undefined> {
  const { version } = input;
  if (
    version.workspaceId !== input.workspaceId ||
    version.lineageStatus !== "governed" ||
    !["workflow_capture", "capability_pack"].includes(version.sourceKind) ||
    !["approved", "trusted"].includes(version.lifecycleState) ||
    version.programArtifact ||
    version.schemaArtifact
  )
    return undefined;
  const reviewed = await readCandidateSkillArtifacts(input.rootDir, input.candidateRoot, version, 0);
  const markdown = reviewed.artifacts.find((item) => item.label === "Instructions")!.content;
  const parsed = parseSkillMarkdown(markdown);
  if (resolveSkillNameViolation(parsed.frontmatter.name))
    throw new ConflictError({ message: "Approved skill has an invalid name." });
  const dir = path.resolve(input.rootDir, version.bundleRoot);
  const integrity = await captureSkillContentIntegrity(dir);
  const expected = [version.manifestArtifact, version.instructionArtifact, version.proofArtifact];
  if (
    integrity.files.length !== expected.length ||
    integrity.files.some(
      (file) =>
        !expected.some(
          (artifact) =>
            path.resolve(dir, file.path) === path.resolve(input.rootDir, artifact.relPath) &&
            file.sha256 === artifact.sha256 &&
            file.bytes === artifact.bytes,
        ),
    )
  ) {
    throw new ConflictError({ message: "Approved skill bundle changed after artifact review." });
  }
  const suffix = createHash("sha256").update(version.candidateId).digest("hex").slice(0, 12);
  const skillId = `extra:reviewed-${suffix}`;
  return {
    skill: {
      skillId,
      name: `${parsed.frontmatter.name}-${suffix}`,
      source: "extra",
      dir,
      tags: parsed.frontmatter.metadata?.tags ?? [],
      declaredTools: parsed.frontmatter.metadata?.tools ?? [],
      requires: parsed.frontmatter.metadata?.requires ?? [],
      // Keep the reviewed human name routable while the catalog name retains its
      // collision-resistant suffix. This remains downstream of workspace/trust checks.
      keywords: [...new Set([parsed.frontmatter.name, ...(parsed.frontmatter.metadata?.keywords ?? [])])],
      instructionBody: parsed.body,
      mtime: version.updatedAt,
    },
    lifecycle: {
      skillId,
      category: "self_generated",
      lifecycleState: version.lifecycleState,
      trustLabel: "Operator approved",
      reviewWarning: "Instruction reuse is approved; behavioral validation is recorded separately.",
      provenance: {
        source: version.sourceKind,
        sourceRef: `candidate:${version.candidateId}:${version.versionId}`,
        contentIntegrity: {
          manifestVersion: integrity.manifestVersion,
          treeSha256: integrity.treeSha256,
          fileCount: integrity.fileCount,
          totalBytes: integrity.totalBytes,
          verified: true,
        },
      },
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    },
  };
}
