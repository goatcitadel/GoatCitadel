import { describe, expect, it } from "vitest";
import {
  SKILL_HUB_ARTIFACT_MAX_FILES,
  assertSkillHubArtifactManifest,
  assertSkillHubBoundedMetadata,
  isSkillHubOperationKind,
  isSkillHubOperationSettlementDisposition,
  skillHubArtifactBundleRelPath,
} from "./skill-hub-lifecycle.js";

const SHA = "a".repeat(64);

describe("Skill Hub lifecycle contracts", () => {
  it("keeps operation and settlement vocabularies closed", () => {
    expect(isSkillHubOperationKind("install_inactive")).toBe(true);
    expect(isSkillHubOperationKind("stage_update_candidate")).toBe(true);
    expect(isSkillHubOperationKind("promote")).toBe(false);
    expect(isSkillHubOperationSettlementDisposition("manual_reconciliation")).toBe(true);
    expect(isSkillHubOperationSettlementDisposition("retrying")).toBe(false);
  });

  it("derives one jailed content-addressed bundle path", () => {
    expect(skillHubArtifactBundleRelPath(SHA)).toBe(`sha256/aa/${SHA}`);
    expect(() => skillHubArtifactBundleRelPath("A".repeat(64))).toThrow(/lowercase SHA-256/);
  });

  it("accepts an exact bounded skill-tree manifest", () => {
    expect(() =>
      assertSkillHubArtifactManifest({
        manifestVersion: "goatcitadel.skill-tree.v1",
        algorithm: "sha256",
        treeSha256: SHA,
        fileCount: 1,
        totalBytes: 8,
        excludedPaths: ["source.json", ".git/**"],
        files: [{ path: "SKILL.md", sha256: "b".repeat(64), bytes: 8 }],
      }),
    ).not.toThrow();
  });

  it("rejects traversal, unsorted paths, inconsistent bytes, and oversized trees", () => {
    const base = {
      manifestVersion: "goatcitadel.skill-tree.v1" as const,
      algorithm: "sha256" as const,
      treeSha256: SHA,
      fileCount: 2,
      totalBytes: 2,
      excludedPaths: ["source.json", ".git/**"] as ["source.json", ".git/**"],
      files: [
        { path: "b.txt", sha256: "b".repeat(64), bytes: 1 },
        { path: "a.txt", sha256: "c".repeat(64), bytes: 1 },
      ],
    };
    expect(() => assertSkillHubArtifactManifest(base)).toThrow(/bytewise sorted/);
    expect(() =>
      assertSkillHubArtifactManifest({
        ...base,
        fileCount: 1,
        totalBytes: 1,
        files: [{ path: "../escape", sha256: "b".repeat(64), bytes: 1 }],
      }),
    ).toThrow(/escapes its root/);
    expect(() =>
      assertSkillHubArtifactManifest({
        ...base,
        totalBytes: 3,
        files: [...base.files].reverse(),
      }),
    ).toThrow(/total bytes/);
    expect(() =>
      assertSkillHubArtifactManifest({
        ...base,
        fileCount: SKILL_HUB_ARTIFACT_MAX_FILES + 1,
        files: [],
      }),
    ).toThrow(/file count/);
  });

  it("bounds settlement metadata without accepting prototype keys", () => {
    expect(() => assertSkillHubBoundedMetadata({ blockerCodes: ["AUDIT_DOWNGRADE"] })).not.toThrow();
    expect(() => assertSkillHubBoundedMetadata({ nested: { constructor: "blocked" } })).toThrow(/invalid key/);
    expect(() => assertSkillHubBoundedMetadata({ detail: "x".repeat(2_049) })).toThrow(/oversized string/);
  });
});
