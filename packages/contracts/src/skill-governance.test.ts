import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SKILL_PERMISSION_ENVELOPE_VERSION,
  SKILL_UPSTREAM_AUDIT_SNAPSHOT_VERSION,
  advanceSkillUpstreamAuditFloor,
  assessSkillLearningEvidence,
  assessSkillUpstreamAudit,
  assertBoundedGovernanceMetadata,
  canonicalSkillLearningFingerprintMaterial,
  diffSkillPermissionEnvelopes,
  isSkillCorrectionProvenanceV1,
  isSkillPermissionEnvelopeV1,
  isSkillUpstreamAuditSnapshotV1,
  normalizeSkillPermissionEnvelope,
  type SkillPermissionEnvelopeV1,
  type SkillUpstreamAuditSnapshotV1,
} from "./skill-governance.js";
import {
  GOVERNANCE_JOURNEY_CURSOR_VERSION,
  GOVERNANCE_JOURNEY_EVENT_VERSION,
  canonicalGovernanceJourneyFilterMaterial,
  isGovernanceJourneyCursorV1,
  isGovernanceJourneyEventRecord,
} from "./journey.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function permissions(overrides: Partial<SkillPermissionEnvelopeV1> = {}): SkillPermissionEnvelopeV1 {
  return normalizeSkillPermissionEnvelope({
    version: SKILL_PERMISSION_ENVELOPE_VERSION,
    toolIds: ["memory.read"],
    environmentVariableNames: ["API_TOKEN"],
    networkOrigins: ["https://api.example.com"],
    filesystem: { readScopes: ["workspace/src"], writeScopes: [] },
    scripts: [],
    dependencies: { packages: ["example-package"], nativeRequirements: [] },
    ...overrides,
  });
}

function snapshot(overrides: Partial<SkillUpstreamAuditSnapshotV1> = {}): SkillUpstreamAuditSnapshotV1 {
  return {
    version: SKILL_UPSTREAM_AUDIT_SNAPSHOT_VERSION,
    snapshotId: "snapshot-1",
    workspaceId: "workspace-1",
    canonicalSourceKey: "github:owner/repo:skill/demo",
    sourceProvider: "github",
    sourceType: "git_url",
    sourceRef: "https://github.com/owner/repo.git#main",
    declaredVersion: "v1.0.0",
    resolvedVersion: "1".repeat(40),
    exactTree: {
      manifestVersion: "goatcitadel.skill-tree.v1",
      treeSha256: SHA_A,
      fileCount: 3,
      totalBytes: 1_024,
    },
    audit: {
      policyId: "skill-import",
      policyVersion: "2.0.0",
      policyRevision: 2,
      scanners: [{ scannerId: "static", scannerVersion: "2.0.0", revision: 2, coverageIds: ["scripts", "secrets"] }],
      findingCodes: [],
      blockerCodes: [],
      approvedBlockerResolutions: [],
    },
    permissionEnvelope: permissions(),
    compatibility: { callability: "governed_candidate" },
    riskLevel: "low",
    trustDisposition: "candidate",
    capturedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("skill governance contracts", () => {
  it("normalizes permission envelopes and classifies widening and narrowing", () => {
    const prior = permissions();
    const widened = permissions({
      toolIds: ["shell.exec", "memory.read", "memory.read"],
      filesystem: { readScopes: ["workspace/src"], writeScopes: ["workspace/src"] },
    });
    expect(widened.toolIds).toEqual(["memory.read", "shell.exec"]);
    expect(isSkillPermissionEnvelopeV1(widened)).toBe(true);
    expect(diffSkillPermissionEnvelopes(prior, widened).disposition).toBe("widened");
    expect(diffSkillPermissionEnvelopes(widened, prior).disposition).toBe("narrowed");
    expect(diffSkillPermissionEnvelopes(undefined, prior).disposition).toBe("unknown");
  });

  it("uses stable workspace-target correction material without session identity", () => {
    const first = canonicalSkillLearningFingerprintMaterial({
      workspaceId: "workspace-1",
      targetKey: "skill/demo",
      title: " Demo   Skill ",
      correctedBehavior: "first line  \r\n  code();  \r\n",
      permissionEnvelopeSha256: SHA_A,
    });
    const replay = canonicalSkillLearningFingerprintMaterial({
      workspaceId: "workspace-1",
      targetKey: "skill/demo",
      title: "Demo Skill",
      correctedBehavior: "first line\n  code();",
      permissionEnvelopeSha256: SHA_A,
    });
    expect(createHash("sha256").update(first).digest("hex")).toBe(createHash("sha256").update(replay).digest("hex"));
    expect(first).not.toContain("session");
  });

  it("retains same-version byte drift, audit downgrade, blocker floors, and permission widening", () => {
    const prior = snapshot({
      audit: {
        ...snapshot().audit,
        blockerCodes: ["PRIOR_UNRESOLVED"],
      },
    });
    const current = snapshot({
      snapshotId: "snapshot-2",
      exactTree: { ...snapshot().exactTree, treeSha256: SHA_B },
      audit: {
        ...snapshot().audit,
        policyRevision: 1,
        scanners: [{ scannerId: "static", scannerVersion: "1.0.0", revision: 1, coverageIds: ["scripts"] }],
      },
      permissionEnvelope: permissions({ toolIds: ["memory.read", "shell.exec"] }),
      priorSnapshotId: "snapshot-1",
    });
    const assessment = assessSkillUpstreamAudit(current, prior);
    expect(assessment.sameVersionByteDrift).toBe(true);
    expect(assessment.auditDowngrade).toBe(true);
    expect(assessment.inheritedBlockerCodes).toEqual(["PRIOR_UNRESOLVED"]);
    expect(assessment.blockerCodes).toEqual(
      expect.arrayContaining([
        "AUDIT_DOWNGRADE",
        "PERMISSION_WIDENED",
        "PRIOR_UNRESOLVED",
        "UPSTREAM_VERSION_BYTE_DRIFT",
      ]),
    );
    expect(assessment.activationAllowed).toBe(false);
    expect(isSkillUpstreamAuditSnapshotV1(current)).toBe(true);
  });

  it("requires explicit approved evidence before clearing an inherited blocker", () => {
    const prior = snapshot({ audit: { ...snapshot().audit, blockerCodes: ["REVIEW_REQUIRED"] } });
    const current = snapshot({
      snapshotId: "snapshot-2",
      priorSnapshotId: "snapshot-1",
      audit: {
        ...snapshot().audit,
        approvedBlockerResolutions: [
          { blockerCode: "REVIEW_REQUIRED", evidenceId: "approval-evidence-1", approvedAt: "2026-07-13T12:30:00.000Z" },
        ],
      },
    });
    expect(assessSkillUpstreamAudit(current, prior).blockerCodes).toContain("REVIEW_REQUIRED");
    expect(assessSkillUpstreamAudit(current, prior, new Set(["approval-evidence-1"])).blockerCodes).not.toContain(
      "REVIEW_REQUIRED",
    );
  });

  it("blocks missing scanner coverage and version changes without a strictly higher revision", () => {
    const prior = snapshot();
    const missing = snapshot({ audit: { ...snapshot().audit, scanners: [] } });
    expect(assessSkillUpstreamAudit(missing).blockerCodes).toContain("AUDIT_MISSING");

    const renamedAtSameRevision = snapshot({
      audit: {
        ...snapshot().audit,
        policyVersion: "2.0.1",
        scanners: [{ scannerId: "static", scannerVersion: "2.0.1", revision: 2, coverageIds: ["scripts", "secrets"] }],
      },
    });
    expect(assessSkillUpstreamAudit(renamedAtSameRevision, prior).blockerCodes).toContain("AUDIT_DOWNGRADE");
  });

  it("retains the strongest historical audit floor across downgrade bounce attempts", () => {
    const revision10 = {
      ...snapshot().audit,
      policyVersion: "10.0.0",
      policyRevision: 10,
      scanners: [{ scannerId: "static", scannerVersion: "10.0.0", revision: 10, coverageIds: ["scripts", "secrets"] }],
    };
    const baseline = advanceSkillUpstreamAuditFloor(revision10);
    expect(baseline.blockerCodes).toEqual([]);

    const revision5 = advanceSkillUpstreamAuditFloor(
      {
        ...revision10,
        policyVersion: "5.0.0",
        policyRevision: 5,
        scanners: [{ scannerId: "static", scannerVersion: "5.0.0", revision: 5, coverageIds: ["scripts"] }],
      },
      baseline.floor,
    );
    expect(revision5.blockerCodes).toEqual(["AUDIT_DOWNGRADE"]);
    expect(revision5.floor.policyRevision).toBe(10);
    expect(revision5.floor.scanners[0]).toMatchObject({ revision: 10, coverageIds: ["scripts", "secrets"] });

    const revision6 = advanceSkillUpstreamAuditFloor(
      {
        ...revision10,
        policyVersion: "6.0.0",
        policyRevision: 6,
        scanners: [{ scannerId: "static", scannerVersion: "6.0.0", revision: 6, coverageIds: [] }],
      },
      revision5.floor,
    );
    expect(revision6.auditDowngrade).toBe(true);
    expect(revision6.auditMissing).toBe(true);
    expect(revision6.blockerCodes).toEqual(["AUDIT_DOWNGRADE", "AUDIT_MISSING"]);
    expect(revision6.floor.policyRevision).toBe(10);
    expect(revision6.floor.scanners[0]).toMatchObject({ revision: 10, coverageIds: ["scripts", "secrets"] });
  });

  it("rejects unknown audit/provenance keys, noncanonical timestamps, and oversized byte identities", () => {
    expect(isSkillUpstreamAuditSnapshotV1({ ...snapshot(), unexpected: true })).toBe(false);
    expect(
      isSkillUpstreamAuditSnapshotV1(snapshot({ audit: { ...snapshot().audit, unexpected: true } as never })),
    ).toBe(false);
    expect(
      isSkillUpstreamAuditSnapshotV1(
        snapshot({
          exactTree: { ...snapshot().exactTree, totalBytes: 536_870_913 },
        }),
      ),
    ).toBe(false);
    expect(
      isSkillUpstreamAuditSnapshotV1(
        snapshot({
          exactTree: { ...snapshot().exactTree, fileCount: 10_001 },
        }),
      ),
    ).toBe(false);
    expect(isSkillUpstreamAuditSnapshotV1(snapshot({ capturedAt: "2026-07-13T12:00:00Z" }))).toBe(false);

    const provenance = {
      version: "goatcitadel.skill-correction-provenance.v1",
      action: "learn_candidate",
      correctionActionId: "action-1",
      actorId: "operator-1",
      workspaceId: "workspace-1",
      source: { kind: "chat_turn", sessionId: "session-1", turnId: "turn-1", messageId: "message-1" },
      sourceSha256: SHA_A,
      correctionSha256: SHA_B,
      sourceArtifact: { artifactId: "source-1", sha256: SHA_A, bytes: 100 },
      correctionArtifact: { artifactId: "correction-1", sha256: SHA_B, bytes: 120 },
      fingerprint: SHA_A,
      capturedAt: "2026-07-13T12:00:00.000Z",
    };
    expect(isSkillCorrectionProvenanceV1({ ...provenance, unexpected: true })).toBe(false);
    expect(isSkillCorrectionProvenanceV1({ ...provenance, source: { ...provenance.source, extra: true } })).toBe(false);
    expect(
      isSkillCorrectionProvenanceV1({
        ...provenance,
        correctionArtifact: { ...provenance.correctionArtifact, bytes: 16_777_217 },
      }),
    ).toBe(false);
  });

  it("requires a declared or resolved upstream version identity", () => {
    const missingVersion = snapshot();
    delete missingVersion.declaredVersion;
    delete missingVersion.resolvedVersion;
    expect(isSkillUpstreamAuditSnapshotV1(missingVersion)).toBe(false);
  });

  it("bounds audit compatibility metadata and rejects raw content or secret-shaped keys", () => {
    expect(() => assertBoundedGovernanceMetadata({ callability: "candidate" }, "compatibility")).not.toThrow();
    expect(() => assertBoundedGovernanceMetadata({ rawText: "payload" }, "compatibility")).toThrow(/forbidden/);
    expect(isSkillUpstreamAuditSnapshotV1(snapshot({ compatibility: { secret: "should-not-live-here" } }))).toBe(false);
    expect(() =>
      assertBoundedGovernanceMetadata(
        { level1: { level2: { level3: { level4: { level5: { level6: { level7: true } } } } } } },
        "compatibility",
      ),
    ).toThrow(/nesting depth/);
  });

  it("fails learning evidence closed and never authorizes callability or memory mutation", () => {
    const result = assessSkillLearningEvidence({
      workspaceMatches: true,
      sourceReferenceValid: true,
      secretLikeContent: false,
      correctionOrigin: "model",
      validationPassed: true,
      permissionDiffDisposition: "none",
      conflictingFingerprint: true,
    });
    expect(result).toMatchObject({
      poisoningStatus: "quarantined",
      callable: false,
      memoryMutation: false,
    });
    expect(result.blockerCodes).toEqual(
      expect.arrayContaining(["UNTRUSTED_CORRECTION_ORIGIN", "CONFLICTING_CORRECTION"]),
    );
  });

  it("validates exact correction provenance", () => {
    expect(
      isSkillCorrectionProvenanceV1({
        version: "goatcitadel.skill-correction-provenance.v1",
        action: "learn_candidate",
        correctionActionId: "action-1",
        actorId: "operator-1",
        workspaceId: "workspace-1",
        source: { kind: "chat_turn", sessionId: "session-1", turnId: "turn-1", messageId: "message-1" },
        sourceSha256: SHA_A,
        correctionSha256: SHA_B,
        sourceArtifact: { artifactId: "source-1", sha256: SHA_A, bytes: 100 },
        correctionArtifact: { artifactId: "correction-1", sha256: SHA_B, bytes: 120 },
        fingerprint: SHA_A,
        capturedAt: "2026-07-13T12:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isSkillCorrectionProvenanceV1({
        version: "goatcitadel.skill-correction-provenance.v1",
        action: "learn_candidate",
        correctionActionId: "action-secret",
        actorId: "operator-1",
        workspaceId: "workspace-1",
        source: { kind: "library_text" },
        sourceSha256: SHA_A,
        correctionSha256: SHA_B,
        fingerprint: SHA_A,
        capturedAt: "2026-07-13T12:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("governance Journey contracts", () => {
  it("canonically binds cursor filters to workspace and normalized sets", () => {
    const first = canonicalGovernanceJourneyFilterMaterial({
      workspaceId: "workspace-1",
      eventTypes: ["skill.updated", "skill.learned", "skill.updated"],
      includeGlobal: false,
    });
    const replay = canonicalGovernanceJourneyFilterMaterial({
      workspaceId: "workspace-1",
      eventTypes: ["skill.learned", "skill.updated"],
    });
    expect(first).toBe(replay);
  });

  it("validates append-only event and high-water cursor envelopes", () => {
    expect(
      isGovernanceJourneyEventRecord({
        schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
        eventId: "event-1",
        idempotencyKey: "skill:version-1:staged",
        scopeKind: "workspace",
        workspaceId: "workspace-1",
        eventType: "skill.candidate",
        subjectKind: "candidate_skill_version",
        subjectId: "version-1",
        action: "staged",
        actorId: "operator-1",
        actorType: "operator",
        fingerprint: SHA_A,
        evidenceRefs: [{ owner: "candidate", refId: "version-1" }],
        provenance: { sourceKind: "chat_turn" },
        summary: { callable: false, memoryMutation: false },
        occurredAt: "2026-07-13T12:00:00.000Z",
        recordedAt: "2026-07-13T12:00:01.000Z",
      }),
    ).toBe(true);

    expect(
      isGovernanceJourneyEventRecord({
        schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
        eventId: "event-bad",
        idempotencyKey: "event-bad",
        scopeKind: "workspace",
        workspaceId: "workspace-1",
        eventType: "skill.candidate",
        subjectKind: "candidate_skill_version",
        subjectId: "version-1",
        action: "staged",
        actorId: "operator-1",
        actorType: "operator",
        evidenceRefs: [],
        provenance: {},
        summary: { content: "raw correction payload" },
        occurredAt: "2026-07-13T12:00:00.000Z",
        recordedAt: "2026-07-13T12:00:01.000Z",
      }),
    ).toBe(false);

    expect(
      isGovernanceJourneyCursorV1({
        version: GOVERNANCE_JOURNEY_CURSOR_VERSION,
        workspaceId: "workspace-1",
        includeGlobal: false,
        filterHash: SHA_A,
        highWater: { recordedAt: "2026-07-13T12:00:02.000Z", eventId: "event-2" },
        position: { recordedAt: "2026-07-13T12:00:01.000Z", eventId: "event-1" },
      }),
    ).toBe(true);
  });

  it("rejects unknown event, evidence, cursor, and position keys plus non-canonical timestamps", () => {
    const event = {
      schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
      eventId: "event-1",
      idempotencyKey: "event-1",
      scopeKind: "workspace",
      workspaceId: "workspace-1",
      eventType: "skill.candidate",
      subjectKind: "candidate_skill_version",
      subjectId: "version-1",
      action: "staged",
      actorId: "operator-1",
      actorType: "operator",
      evidenceRefs: [{ owner: "candidate", refId: "version-1" }],
      provenance: {},
      summary: {},
      occurredAt: "2026-07-13T12:00:00.000Z",
      recordedAt: "2026-07-13T12:00:01.000Z",
    } as const;
    expect(isGovernanceJourneyEventRecord({ ...event, rawText: "hidden payload" })).toBe(false);
    expect(
      isGovernanceJourneyEventRecord({
        ...event,
        evidenceRefs: [{ owner: "candidate", refId: "version-1", content: "hidden payload" }],
      }),
    ).toBe(false);
    expect(isGovernanceJourneyEventRecord({ ...event, occurredAt: "July 13 2026 12:00:00 UTC" })).toBe(false);

    const cursor = {
      version: GOVERNANCE_JOURNEY_CURSOR_VERSION,
      workspaceId: "workspace-1",
      includeGlobal: false,
      filterHash: SHA_A,
      highWater: { recordedAt: "2026-07-13T12:00:02.000Z", eventId: "event-2" },
      position: { recordedAt: "2026-07-13T12:00:01.000Z", eventId: "event-1" },
    } as const;
    expect(isGovernanceJourneyCursorV1({ ...cursor, foreignWorkspaceId: "workspace-2" })).toBe(false);
    expect(
      isGovernanceJourneyCursorV1({
        ...cursor,
        position: { ...cursor.position, injected: true },
      }),
    ).toBe(false);
  });
});
