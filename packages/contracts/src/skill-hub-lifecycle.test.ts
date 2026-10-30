import { describe, expect, it } from "vitest";
import type { SkillGovernanceBlockerCode } from "./skill-governance.js";
import {
  SKILL_HUB_ARTIFACT_MAX_FILES,
  SKILL_HUB_BLOCKER_CODES,
  TRUSTED_GIT_FORGE_HOSTS,
  assertSkillHubArtifactManifest,
  assertSkillHubBoundedMetadata,
  isSkillHubOperationKind,
  isSkillHubOperationSettlementDisposition,
  namesGitRepository,
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

/**
 * Every governance blocker code. Typed as a full record, so adding a code to `SkillGovernanceBlockerCode` fails the
 * contracts build here until it is listed, and the test below then fails until `SKILL_HUB_BLOCKER_CODES` names it.
 */
const GOVERNANCE_BLOCKER_CODES: Record<SkillGovernanceBlockerCode, true> = {
  AUDIT_MISSING: true,
  AUDIT_DOWNGRADE: true,
  UPSTREAM_VERSION_BYTE_DRIFT: true,
  PERMISSION_WIDENED: true,
  PERMISSION_UNKNOWN: true,
  FOREIGN_SCOPE: true,
  MALFORMED_SOURCE_REFERENCE: true,
  SECRET_LIKE_CONTENT: true,
  UNTRUSTED_CORRECTION_ORIGIN: true,
  VALIDATION_FAILED: true,
  CONFLICTING_CORRECTION: true,
};

describe("Skill Hub blocker codes", () => {
  it("types every blocker the review can produce", () => {
    // The review's own five (`standardizedBlockers` in skill-hub-review-service.ts, typed with SkillHubBlockerCode).
    expect(SKILL_HUB_BLOCKER_CODES).toEqual(
      expect.arrayContaining([
        "CONDITIONAL_REVIEW_REQUIRED",
        "PROMPT_INJECTION_DETECTED",
        "PROMPTWARE_SCAN_INCOMPLETE",
        "REFERENCE_ONLY_SOURCE",
        "SUSPICIOUS_SCRIPT_INDICATOR",
      ]),
    );
  });

  it("lists every governance blocker a stored snapshot can carry", () => {
    expect(SKILL_HUB_BLOCKER_CODES).toEqual(expect.arrayContaining(Object.keys(GOVERNANCE_BLOCKER_CODES)));
  });

  it("lists the install guard codes an operator can meet, once each", () => {
    expect(SKILL_HUB_BLOCKER_CODES).toEqual(
      expect.arrayContaining(["SOURCE_ALREADY_INSTALLED", "CANDIDATE_ALREADY_EXISTS", "RUNTIME_ALREADY_EXISTS"]),
    );
    expect(new Set(SKILL_HUB_BLOCKER_CODES).size).toBe(SKILL_HUB_BLOCKER_CODES.length);
  });

  it("names the four public forges Git review trusts, lower-case and exact", () => {
    expect([...TRUSTED_GIT_FORGE_HOSTS].sort()).toEqual(["bitbucket.org", "codeberg.org", "github.com", "gitlab.com"]);
  });

  it("asks a Git address for an owner and a repository, however it is slashed", () => {
    for (const pathname of [
      "/owner/repo",
      "/owner/repo/",
      "owner/repo",
      "/owner/repo/tree/main/skills/x",
      "//owner//repo",
    ]) {
      expect(namesGitRepository(pathname), pathname).toBe(true);
    }
    for (const pathname of ["", "/", "/owner", "/owner/", "owner", "//"]) {
      expect(namesGitRepository(pathname), pathname).toBe(false);
    }
  });
});
