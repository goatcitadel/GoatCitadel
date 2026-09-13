import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ConflictError,
  type CandidateSkillArtifactReview,
  type CandidateSkillVersionRecord,
} from "@goatcitadel/contracts";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";

export async function readCandidateSkillArtifacts(
  rootDir: string,
  candidateRoot: string,
  version: CandidateSkillVersionRecord,
  revision: number,
): Promise<CandidateSkillArtifactReview> {
  const artifacts = [];
  for (const [label, artifact] of [
    ["Instructions", version.instructionArtifact],
    ["Provenance", version.manifestArtifact],
    ["Validation evidence", version.proofArtifact],
    ["Program", version.programArtifact],
    ["Schemas", version.schemaArtifact],
  ] as const) {
    if (!artifact) continue;
    const target = path.resolve(rootDir, artifact.relPath);
    assertWritePathInJail(target, [candidateRoot]);
    const before = await fs.lstat(target);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > 128 * 1024 ||
      before.size !== artifact.bytes
    ) {
      throw new ConflictError({ message: "Candidate artifact exceeds review limits or its file identity changed." });
    }
    const handle = await fs.open(target, "r");
    try {
      const stat = await handle.stat();
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size)
        throw new ConflictError({ message: "Candidate artifact changed during review." });
      const bytes = Buffer.alloc(stat.size + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (
        read.bytesRead !== artifact.bytes ||
        createHash("sha256").update(bytes.subarray(0, read.bytesRead)).digest("hex") !== artifact.sha256
      ) {
        throw new ConflictError({ message: "Candidate artifact hash changed. Review a new candidate version." });
      }
      artifacts.push({
        label,
        artifactRef: `capability_artifact:${artifact.artifactId}:sha256:${artifact.sha256}`,
        content: bytes.subarray(0, read.bytesRead).toString("utf8"),
      });
    } finally {
      await handle.close();
    }
  }
  return { candidateId: version.candidateId, versionId: version.versionId, revision, artifacts };
}
