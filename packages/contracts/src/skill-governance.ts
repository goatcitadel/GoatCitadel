import { canonicalJsonString } from "./canonical-json.js";

export const SKILL_PERMISSION_ENVELOPE_VERSION = "goatcitadel.skill-permission-envelope.v1" as const;
export const SKILL_PERMISSION_DIFF_VERSION = "goatcitadel.skill-permission-diff.v1" as const;
export const SKILL_UPSTREAM_AUDIT_SNAPSHOT_VERSION = "goatcitadel.skill-upstream-audit.v1" as const;
export const SKILL_UPSTREAM_AUDIT_FLOOR_VERSION = "goatcitadel.skill-upstream-audit-floor.v1" as const;
export const SKILL_CORRECTION_PROVENANCE_VERSION = "goatcitadel.skill-correction-provenance.v1" as const;
export const SKILL_LEARNING_FINGERPRINT_VERSION = "goatcitadel.skill-learning-fingerprint.v1" as const;
export const GOVERNANCE_METADATA_MAX_BYTES = 16_384 as const;
export const GOVERNANCE_METADATA_MAX_DEPTH = 6 as const;
export const GOVERNANCE_METADATA_MAX_ENTRIES = 128 as const;
export const SKILL_TREE_MAX_FILES = 10_000 as const;
export const SKILL_TREE_MAX_BYTES = 536_870_912 as const;
export const SKILL_CORRECTION_ARTIFACT_MAX_BYTES = 16_777_216 as const;

export type SkillPermissionDiffDisposition = "none" | "narrowed" | "widened" | "mixed" | "unknown";
export type SkillLearningPoisoningStatus = "clean" | "blocked" | "quarantined" | "conflicting";
export type SkillUpstreamTrustDisposition = "review_only" | "candidate" | "blocked" | "revoked";

export type SkillGovernanceBlockerCode =
  | "AUDIT_MISSING"
  | "AUDIT_DOWNGRADE"
  | "UPSTREAM_VERSION_BYTE_DRIFT"
  | "PERMISSION_WIDENED"
  | "PERMISSION_UNKNOWN"
  | "FOREIGN_SCOPE"
  | "MALFORMED_SOURCE_REFERENCE"
  | "SECRET_LIKE_CONTENT"
  | "UNTRUSTED_CORRECTION_ORIGIN"
  | "VALIDATION_FAILED"
  | "CONFLICTING_CORRECTION";

export interface SkillPermissionEnvelopeV1 {
  version: typeof SKILL_PERMISSION_ENVELOPE_VERSION;
  toolIds: string[];
  environmentVariableNames: string[];
  networkOrigins: string[];
  filesystem: {
    readScopes: string[];
    writeScopes: string[];
  };
  scripts: string[];
  dependencies: {
    packages: string[];
    nativeRequirements: string[];
  };
}

export interface SkillPermissionDimensionDiff {
  added: string[];
  removed: string[];
}

export interface SkillPermissionDiffV1 {
  version: typeof SKILL_PERMISSION_DIFF_VERSION;
  disposition: SkillPermissionDiffDisposition;
  dimensions: {
    toolIds: SkillPermissionDimensionDiff;
    environmentVariableNames: SkillPermissionDimensionDiff;
    networkOrigins: SkillPermissionDimensionDiff;
    filesystemReadScopes: SkillPermissionDimensionDiff;
    filesystemWriteScopes: SkillPermissionDimensionDiff;
    scripts: SkillPermissionDimensionDiff;
    packages: SkillPermissionDimensionDiff;
    nativeRequirements: SkillPermissionDimensionDiff;
  };
}

export interface SkillExactTreeIdentity {
  manifestVersion: "goatcitadel.skill-tree.v1";
  treeSha256: string;
  fileCount: number;
  totalBytes: number;
}

export interface SkillAuditScannerSnapshot {
  scannerId: string;
  scannerVersion: string;
  revision: number;
  coverageIds: string[];
}

export interface SkillApprovedBlockerResolution {
  blockerCode: string;
  evidenceId: string;
  approvedAt: string;
}

export interface SkillUpstreamAuditDetails {
  policyId: string;
  policyVersion: string;
  policyRevision: number;
  scanners: SkillAuditScannerSnapshot[];
  findingCodes: string[];
  blockerCodes: string[];
  approvedBlockerResolutions: SkillApprovedBlockerResolution[];
}

export interface SkillUpstreamAuditSnapshotV1 {
  version: typeof SKILL_UPSTREAM_AUDIT_SNAPSHOT_VERSION;
  snapshotId: string;
  workspaceId: string;
  canonicalSourceKey: string;
  sourceProvider: string;
  sourceType: string;
  sourceRef: string;
  declaredVersion?: string;
  resolvedVersion?: string;
  exactTree: SkillExactTreeIdentity;
  audit: SkillUpstreamAuditDetails;
  permissionEnvelope: SkillPermissionEnvelopeV1;
  compatibility: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high" | "unknown";
  trustDisposition: SkillUpstreamTrustDisposition;
  priorSnapshotId?: string;
  capturedAt: string;
}

export interface SkillUpstreamAuditAssessment {
  blockerCodes: string[];
  inheritedBlockerCodes: string[];
  permissionDiff: SkillPermissionDiffV1;
  sameVersionByteDrift: boolean;
  auditDowngrade: boolean;
  activationAllowed: boolean;
}

/**
 * Monotonic, source-scoped audit state. This is deliberately smaller than an
 * upstream snapshot: it retains only the strongest policy/scanner coverage and
 * every effective blocker ever observed for that source.
 */
export interface SkillUpstreamAuditFloorV1 {
  version: typeof SKILL_UPSTREAM_AUDIT_FLOOR_VERSION;
  policyId: string;
  policyVersion: string;
  policyRevision: number;
  scanners: SkillAuditScannerSnapshot[];
  effectiveBlockerCodes: string[];
}

export interface SkillUpstreamAuditFloorAdvance {
  floor: SkillUpstreamAuditFloorV1;
  blockerCodes: string[];
  auditDowngrade: boolean;
  auditMissing: boolean;
}

export interface SkillCorrectionArtifactRef {
  artifactId: string;
  sha256: string;
  bytes: number;
}

export interface SkillCorrectionProvenanceV1 {
  version: typeof SKILL_CORRECTION_PROVENANCE_VERSION;
  action: "learn_candidate";
  correctionActionId: string;
  actorId: string;
  workspaceId: string;
  source:
    | {
        kind: "chat_turn";
        sessionId: string;
        turnId: string;
        messageId: string;
      }
    | {
        kind: "library_text";
      };
  sourceSha256: string;
  correctionSha256: string;
  sourceArtifact?: SkillCorrectionArtifactRef;
  correctionArtifact?: SkillCorrectionArtifactRef;
  fingerprint: string;
  capturedAt: string;
}

export interface SkillLearningFingerprintInput {
  workspaceId: string;
  targetKey: string;
  title: string;
  correctedBehavior: string;
  permissionEnvelopeSha256: string;
}

export interface SkillLearningEvidenceRiskInput {
  workspaceMatches: boolean;
  sourceReferenceValid: boolean;
  secretLikeContent: boolean;
  correctionOrigin: "authenticated_operator" | "model" | "tool" | "browser" | "unknown";
  validationPassed: boolean;
  permissionDiffDisposition: SkillPermissionDiffDisposition;
  conflictingFingerprint: boolean;
}

export interface SkillLearningEvidenceAssessment {
  poisoningStatus: SkillLearningPoisoningStatus;
  blockerCodes: SkillGovernanceBlockerCode[];
  callable: false;
  memoryMutation: false;
}

export function normalizeSkillPermissionEnvelope(input: SkillPermissionEnvelopeV1): SkillPermissionEnvelopeV1 {
  return {
    version: SKILL_PERMISSION_ENVELOPE_VERSION,
    toolIds: normalizeIdentifiers(input.toolIds, "tool ID"),
    environmentVariableNames: normalizeEnvironmentVariableNames(input.environmentVariableNames),
    networkOrigins: normalizeNetworkOrigins(input.networkOrigins),
    filesystem: {
      readScopes: normalizeFilesystemScopes(input.filesystem.readScopes),
      writeScopes: normalizeFilesystemScopes(input.filesystem.writeScopes),
    },
    scripts: normalizeFreeformValues(input.scripts, "script"),
    dependencies: {
      packages: normalizeIdentifiers(input.dependencies.packages, "package"),
      nativeRequirements: normalizeFreeformValues(input.dependencies.nativeRequirements, "native requirement"),
    },
  };
}

export function canonicalSkillPermissionEnvelope(input: SkillPermissionEnvelopeV1): string {
  return canonicalJsonString(normalizeSkillPermissionEnvelope(input));
}

export function diffSkillPermissionEnvelopes(
  prior: SkillPermissionEnvelopeV1 | undefined,
  current: SkillPermissionEnvelopeV1 | undefined,
): SkillPermissionDiffV1 {
  if (!prior || !current || !isSkillPermissionEnvelopeV1(prior) || !isSkillPermissionEnvelopeV1(current)) {
    return emptyPermissionDiff("unknown");
  }
  const previous = normalizeSkillPermissionEnvelope(prior);
  const next = normalizeSkillPermissionEnvelope(current);
  const dimensions = {
    toolIds: diffValues(previous.toolIds, next.toolIds),
    environmentVariableNames: diffValues(previous.environmentVariableNames, next.environmentVariableNames),
    networkOrigins: diffValues(previous.networkOrigins, next.networkOrigins),
    filesystemReadScopes: diffValues(previous.filesystem.readScopes, next.filesystem.readScopes),
    filesystemWriteScopes: diffValues(previous.filesystem.writeScopes, next.filesystem.writeScopes),
    scripts: diffValues(previous.scripts, next.scripts),
    packages: diffValues(previous.dependencies.packages, next.dependencies.packages),
    nativeRequirements: diffValues(previous.dependencies.nativeRequirements, next.dependencies.nativeRequirements),
  };
  const changes = Object.values(dimensions);
  const widened = changes.some((change) => change.added.length > 0);
  const narrowed = changes.some((change) => change.removed.length > 0);
  return {
    version: SKILL_PERMISSION_DIFF_VERSION,
    disposition: widened && narrowed ? "mixed" : widened ? "widened" : narrowed ? "narrowed" : "none",
    dimensions,
  };
}

export function assessSkillUpstreamAudit(
  current: SkillUpstreamAuditSnapshotV1,
  prior?: SkillUpstreamAuditSnapshotV1,
  verifiedApprovalEvidenceIds: ReadonlySet<string> = new Set<string>(),
): SkillUpstreamAuditAssessment {
  const blockers = new Set<string>();
  const inherited = new Set<string>();
  let sameVersionByteDrift = false;
  let auditDowngrade = false;

  const currentValid = isSkillUpstreamAuditSnapshotV1(current);
  if (!currentValid) {
    blockers.add("AUDIT_MISSING");
    return {
      blockerCodes: [...blockers],
      inheritedBlockerCodes: [],
      permissionDiff: emptyPermissionDiff("unknown"),
      sameVersionByteDrift: false,
      auditDowngrade: false,
      activationAllowed: false,
    };
  }

  if (hasMissingAuditCoverage(current)) blockers.add("AUDIT_MISSING");

  if (prior && isSkillUpstreamAuditSnapshotV1(prior)) {
    const sameSource = current.canonicalSourceKey === prior.canonicalSourceKey;
    const declaredVersionMatches =
      Boolean(current.declaredVersion) && current.declaredVersion === prior.declaredVersion;
    const resolvedVersionMatches =
      Boolean(current.resolvedVersion) && current.resolvedVersion === prior.resolvedVersion;
    sameVersionByteDrift =
      sameSource &&
      (declaredVersionMatches || resolvedVersionMatches) &&
      current.exactTree.treeSha256 !== prior.exactTree.treeSha256;
    if (sameVersionByteDrift) blockers.add("UPSTREAM_VERSION_BYTE_DRIFT");

    auditDowngrade = hasAuditDowngrade(current, prior);
    if (auditDowngrade) blockers.add("AUDIT_DOWNGRADE");

    const approvedResolutions = new Set(
      current.audit.approvedBlockerResolutions
        .filter(
          (resolution) =>
            isApprovedBlockerResolution(resolution) && verifiedApprovalEvidenceIds.has(resolution.evidenceId),
        )
        .map((resolution) => resolution.blockerCode),
    );
    for (const blocker of prior.audit.blockerCodes) {
      if (!approvedResolutions.has(blocker)) inherited.add(blocker);
    }
  }

  for (const blocker of current.audit.blockerCodes) blockers.add(blocker);
  for (const blocker of inherited) blockers.add(blocker);

  const permissionDiff = prior
    ? diffSkillPermissionEnvelopes(prior.permissionEnvelope, current.permissionEnvelope)
    : emptyPermissionDiff("none");
  if (permissionDiff.disposition === "widened" || permissionDiff.disposition === "mixed") {
    blockers.add("PERMISSION_WIDENED");
  } else if (permissionDiff.disposition === "unknown") {
    blockers.add("PERMISSION_UNKNOWN");
  }

  return {
    blockerCodes: [...blockers].sort(compareStrings),
    inheritedBlockerCodes: [...inherited].sort(compareStrings),
    permissionDiff,
    sameVersionByteDrift,
    auditDowngrade,
    activationAllowed:
      blockers.size === 0 && current.trustDisposition !== "blocked" && current.trustDisposition !== "revoked",
  };
}

/**
 * Advances the durable audit floor without trusting the caller to provide a
 * prior snapshot. A weaker or incomplete observation is recorded as a blocker
 * but can never lower the retained policy, scanner revisions, coverage, or
 * historical blocker set. The persistence layer must serialize this operation
 * per workspace and canonical source.
 */
export function advanceSkillUpstreamAuditFloor(
  current: SkillUpstreamAuditDetails,
  prior?: SkillUpstreamAuditFloorV1,
): SkillUpstreamAuditFloorAdvance {
  if (!isAuditSnapshot(current)) {
    throw new TypeError("Skill upstream audit details are malformed.");
  }
  if (prior && !isSkillUpstreamAuditFloorV1(prior)) {
    throw new TypeError("Skill upstream audit floor is malformed.");
  }

  const auditMissing =
    current.scanners.length === 0 || current.scanners.some((scanner) => scanner.coverageIds.length === 0);
  const auditDowngrade = prior ? hasAuditFloorDowngrade(current, prior) : false;
  const blockers = new Set(prior?.effectiveBlockerCodes ?? []);
  for (const blocker of current.blockerCodes) blockers.add(blocker);
  if (auditMissing) blockers.add("AUDIT_MISSING");
  if (auditDowngrade) blockers.add("AUDIT_DOWNGRADE");

  const policy = advancePolicyFloor(current, prior);
  const scanners = advanceScannerFloor(current.scanners, prior?.scanners ?? []);
  const floor: SkillUpstreamAuditFloorV1 = {
    version: SKILL_UPSTREAM_AUDIT_FLOOR_VERSION,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyRevision: policy.policyRevision,
    scanners,
    effectiveBlockerCodes: [...blockers].sort(compareStrings),
  };
  if (!isSkillUpstreamAuditFloorV1(floor)) {
    throw new TypeError("Advanced skill upstream audit floor is malformed.");
  }
  return {
    floor,
    blockerCodes: [...floor.effectiveBlockerCodes],
    auditDowngrade,
    auditMissing,
  };
}

export function canonicalSkillLearningFingerprintMaterial(input: SkillLearningFingerprintInput): string {
  const workspaceId = normalizeRequiredText(input.workspaceId, "workspace ID", 256);
  const targetKey = normalizeRequiredText(input.targetKey, "target key", 256);
  const permissionEnvelopeSha256 = input.permissionEnvelopeSha256.trim().toLowerCase();
  if (!isSha256(permissionEnvelopeSha256)) {
    throw new TypeError("Skill learning permission envelope hash must be a SHA-256 hex digest.");
  }
  return `${SKILL_LEARNING_FINGERPRINT_VERSION}\u0000${canonicalJsonString({
    version: SKILL_LEARNING_FINGERPRINT_VERSION,
    workspaceId,
    targetKey,
    normalizedTitle: normalizeTitle(input.title),
    normalizedCorrectedBehavior: normalizeCorrectedBehavior(input.correctedBehavior),
    permissionEnvelopeSha256,
  })}`;
}

export function assessSkillLearningEvidence(input: SkillLearningEvidenceRiskInput): SkillLearningEvidenceAssessment {
  const blockers: SkillGovernanceBlockerCode[] = [];
  if (!input.workspaceMatches) blockers.push("FOREIGN_SCOPE");
  if (!input.sourceReferenceValid) blockers.push("MALFORMED_SOURCE_REFERENCE");
  if (input.secretLikeContent) blockers.push("SECRET_LIKE_CONTENT");
  if (!input.validationPassed) blockers.push("VALIDATION_FAILED");
  if (input.permissionDiffDisposition === "widened" || input.permissionDiffDisposition === "mixed") {
    blockers.push("PERMISSION_WIDENED");
  } else if (input.permissionDiffDisposition === "unknown") {
    blockers.push("PERMISSION_UNKNOWN");
  }
  if (input.correctionOrigin !== "authenticated_operator") blockers.push("UNTRUSTED_CORRECTION_ORIGIN");
  if (input.conflictingFingerprint) blockers.push("CONFLICTING_CORRECTION");

  const hardBlocked = blockers.some(
    (blocker) => blocker !== "UNTRUSTED_CORRECTION_ORIGIN" && blocker !== "CONFLICTING_CORRECTION",
  );
  const poisoningStatus: SkillLearningPoisoningStatus = hardBlocked
    ? "blocked"
    : blockers.includes("UNTRUSTED_CORRECTION_ORIGIN")
      ? "quarantined"
      : blockers.includes("CONFLICTING_CORRECTION")
        ? "conflicting"
        : "clean";
  return {
    poisoningStatus,
    blockerCodes: [...new Set(blockers)].sort(compareStrings) as SkillGovernanceBlockerCode[],
    callable: false,
    memoryMutation: false,
  };
}

export function isSkillPermissionEnvelopeV1(value: unknown): value is SkillPermissionEnvelopeV1 {
  if (!isRecord(value) || value.version !== SKILL_PERMISSION_ENVELOPE_VERSION) return false;
  try {
    const input = value as unknown as SkillPermissionEnvelopeV1;
    return canonicalJsonString(input) === canonicalJsonString(normalizeSkillPermissionEnvelope(input));
  } catch {
    return false;
  }
}

export function isSkillUpstreamAuditSnapshotV1(value: unknown): value is SkillUpstreamAuditSnapshotV1 {
  if (!isRecord(value) || value.version !== SKILL_UPSTREAM_AUDIT_SNAPSHOT_VERSION) return false;
  const input = value as unknown as SkillUpstreamAuditSnapshotV1;
  return (
    hasExactKeys(
      value,
      [
        "version",
        "snapshotId",
        "workspaceId",
        "canonicalSourceKey",
        "sourceProvider",
        "sourceType",
        "sourceRef",
        "exactTree",
        "audit",
        "permissionEnvelope",
        "compatibility",
        "riskLevel",
        "trustDisposition",
        "capturedAt",
      ],
      ["declaredVersion", "resolvedVersion", "priorSnapshotId"],
    ) &&
    isBoundedText(input.snapshotId, 256) &&
    isBoundedText(input.workspaceId, 256) &&
    isBoundedText(input.canonicalSourceKey, 1_024) &&
    isBoundedText(input.sourceProvider, 128) &&
    isBoundedText(input.sourceType, 128) &&
    isBoundedText(input.sourceRef, 2_048) &&
    (input.declaredVersion === undefined || isBoundedText(input.declaredVersion, 512)) &&
    (input.resolvedVersion === undefined || isBoundedText(input.resolvedVersion, 512)) &&
    (input.declaredVersion !== undefined || input.resolvedVersion !== undefined) &&
    isExactTree(input.exactTree) &&
    isAuditSnapshot(input.audit) &&
    isSkillPermissionEnvelopeV1(input.permissionEnvelope) &&
    isBoundedGovernanceMetadata(input.compatibility) &&
    (input.riskLevel === "low" ||
      input.riskLevel === "medium" ||
      input.riskLevel === "high" ||
      input.riskLevel === "unknown") &&
    (input.trustDisposition === "review_only" ||
      input.trustDisposition === "candidate" ||
      input.trustDisposition === "blocked" ||
      input.trustDisposition === "revoked") &&
    (input.priorSnapshotId === undefined || isBoundedText(input.priorSnapshotId, 256)) &&
    isIsoTimestamp(input.capturedAt)
  );
}

export function isSkillUpstreamAuditFloorV1(value: unknown): value is SkillUpstreamAuditFloorV1 {
  if (!isRecord(value) || value.version !== SKILL_UPSTREAM_AUDIT_FLOOR_VERSION) return false;
  return (
    hasExactKeys(value, [
      "version",
      "policyId",
      "policyVersion",
      "policyRevision",
      "scanners",
      "effectiveBlockerCodes",
    ]) &&
    isBoundedText(value.policyId, 256) &&
    isBoundedText(value.policyVersion, 256) &&
    Number.isSafeInteger(value.policyRevision) &&
    Number(value.policyRevision) >= 0 &&
    Array.isArray(value.scanners) &&
    value.scanners.length <= 64 &&
    value.scanners.every(isScannerSnapshot) &&
    isCanonicalScannerFloor(value.scanners) &&
    isCanonicalStringArray(value.effectiveBlockerCodes, 64, 128)
  );
}

export function isSkillUpstreamAuditDetails(value: unknown): value is SkillUpstreamAuditDetails {
  return isAuditSnapshot(value);
}

export function isBoundedGovernanceMetadata(value: unknown): value is Record<string, unknown> {
  try {
    assertBoundedGovernanceMetadata(value, "governance metadata");
    return true;
  } catch {
    return false;
  }
}

export function assertBoundedGovernanceMetadata(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  const counter = { entries: 0 };
  inspectGovernanceMetadata(value, 0, counter, label);
  const bytes = new TextEncoder().encode(canonicalJsonString(value)).byteLength;
  if (bytes > GOVERNANCE_METADATA_MAX_BYTES) {
    throw new TypeError(`${label} exceeds the ${GOVERNANCE_METADATA_MAX_BYTES}-byte canonical limit.`);
  }
}

export function isFullGitCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/iu.test(value);
}

export function isSkillCorrectionProvenanceV1(value: unknown): value is SkillCorrectionProvenanceV1 {
  if (!isRecord(value) || value.version !== SKILL_CORRECTION_PROVENANCE_VERSION) return false;
  const input = value as unknown as SkillCorrectionProvenanceV1;
  if (
    !hasExactKeys(
      value,
      [
        "version",
        "action",
        "correctionActionId",
        "actorId",
        "workspaceId",
        "source",
        "sourceSha256",
        "correctionSha256",
        "fingerprint",
        "capturedAt",
      ],
      ["sourceArtifact", "correctionArtifact"],
    ) ||
    input.action !== "learn_candidate" ||
    !isBoundedText(input.correctionActionId, 256) ||
    !isBoundedText(input.actorId, 256) ||
    !isBoundedText(input.workspaceId, 256) ||
    !isSha256(input.sourceSha256) ||
    !isSha256(input.correctionSha256) ||
    (input.sourceArtifact !== undefined) !== (input.correctionArtifact !== undefined) ||
    (input.sourceArtifact !== undefined && !isArtifactRef(input.sourceArtifact)) ||
    (input.correctionArtifact !== undefined && !isArtifactRef(input.correctionArtifact)) ||
    (input.sourceArtifact !== undefined && input.sourceArtifact.sha256 !== input.sourceSha256) ||
    (input.correctionArtifact !== undefined && input.correctionArtifact.sha256 !== input.correctionSha256) ||
    !isSha256(input.fingerprint) ||
    !isIsoTimestamp(input.capturedAt) ||
    !isRecord(input.source)
  ) {
    return false;
  }
  if (input.source.kind === "library_text") return hasExactKeys(input.source, ["kind"]);
  return (
    input.source.kind === "chat_turn" &&
    hasExactKeys(input.source, ["kind", "sessionId", "turnId", "messageId"]) &&
    isBoundedText(input.source.sessionId, 256) &&
    isBoundedText(input.source.turnId, 256) &&
    isBoundedText(input.source.messageId, 256)
  );
}

function emptyPermissionDiff(disposition: SkillPermissionDiffDisposition): SkillPermissionDiffV1 {
  const empty = (): SkillPermissionDimensionDiff => ({ added: [], removed: [] });
  return {
    version: SKILL_PERMISSION_DIFF_VERSION,
    disposition,
    dimensions: {
      toolIds: empty(),
      environmentVariableNames: empty(),
      networkOrigins: empty(),
      filesystemReadScopes: empty(),
      filesystemWriteScopes: empty(),
      scripts: empty(),
      packages: empty(),
      nativeRequirements: empty(),
    },
  };
}

function diffValues(prior: readonly string[], current: readonly string[]): SkillPermissionDimensionDiff {
  const previous = new Set(prior);
  const next = new Set(current);
  return {
    added: current.filter((value) => !previous.has(value)),
    removed: prior.filter((value) => !next.has(value)),
  };
}

function hasAuditDowngrade(current: SkillUpstreamAuditSnapshotV1, prior: SkillUpstreamAuditSnapshotV1): boolean {
  if (
    current.audit.policyId !== prior.audit.policyId ||
    current.audit.policyRevision < prior.audit.policyRevision ||
    (current.audit.policyVersion !== prior.audit.policyVersion &&
      current.audit.policyRevision <= prior.audit.policyRevision)
  ) {
    return true;
  }
  const currentScanners = new Map(current.audit.scanners.map((scanner) => [scanner.scannerId, scanner]));
  return prior.audit.scanners.some((previousScanner) => {
    const nextScanner = currentScanners.get(previousScanner.scannerId);
    if (
      !nextScanner ||
      nextScanner.revision < previousScanner.revision ||
      (nextScanner.scannerVersion !== previousScanner.scannerVersion &&
        nextScanner.revision <= previousScanner.revision)
    ) {
      return true;
    }
    const nextCoverage = new Set(nextScanner.coverageIds);
    return previousScanner.coverageIds.some((coverageId) => !nextCoverage.has(coverageId));
  });
}

function hasAuditFloorDowngrade(current: SkillUpstreamAuditDetails, prior: SkillUpstreamAuditFloorV1): boolean {
  if (
    current.policyId !== prior.policyId ||
    current.policyRevision < prior.policyRevision ||
    (current.policyVersion !== prior.policyVersion && current.policyRevision <= prior.policyRevision)
  ) {
    return true;
  }
  const currentScanners = new Map(current.scanners.map((scanner) => [scanner.scannerId, scanner]));
  return prior.scanners.some((floorScanner) => {
    const observed = currentScanners.get(floorScanner.scannerId);
    if (
      !observed ||
      observed.revision < floorScanner.revision ||
      (observed.scannerVersion !== floorScanner.scannerVersion && observed.revision <= floorScanner.revision)
    ) {
      return true;
    }
    const observedCoverage = new Set(observed.coverageIds);
    return floorScanner.coverageIds.some((coverageId) => !observedCoverage.has(coverageId));
  });
}

function advancePolicyFloor(
  current: SkillUpstreamAuditDetails,
  prior?: SkillUpstreamAuditFloorV1,
): Pick<SkillUpstreamAuditFloorV1, "policyId" | "policyVersion" | "policyRevision"> {
  if (!prior || (current.policyId === prior.policyId && current.policyRevision > prior.policyRevision)) {
    return {
      policyId: current.policyId,
      policyVersion: current.policyVersion,
      policyRevision: current.policyRevision,
    };
  }
  return {
    policyId: prior.policyId,
    policyVersion: prior.policyVersion,
    policyRevision: prior.policyRevision,
  };
}

function advanceScannerFloor(
  current: readonly SkillAuditScannerSnapshot[],
  prior: readonly SkillAuditScannerSnapshot[],
): SkillAuditScannerSnapshot[] {
  const floor = new Map(prior.map((scanner) => [scanner.scannerId, normalizeScannerSnapshot(scanner)]));
  for (const observed of current) {
    const normalized = normalizeScannerSnapshot(observed);
    const retained = floor.get(normalized.scannerId);
    if (!retained) {
      floor.set(normalized.scannerId, normalized);
      continue;
    }
    const coverageIds = [...new Set([...retained.coverageIds, ...normalized.coverageIds])].sort(compareStrings);
    floor.set(normalized.scannerId, {
      scannerId: retained.scannerId,
      scannerVersion: normalized.revision > retained.revision ? normalized.scannerVersion : retained.scannerVersion,
      revision: Math.max(retained.revision, normalized.revision),
      coverageIds,
    });
  }
  return [...floor.values()].sort((left, right) => compareStrings(left.scannerId, right.scannerId));
}

function normalizeScannerSnapshot(input: SkillAuditScannerSnapshot): SkillAuditScannerSnapshot {
  return {
    scannerId: input.scannerId,
    scannerVersion: input.scannerVersion,
    revision: input.revision,
    coverageIds: [...new Set(input.coverageIds)].sort(compareStrings),
  };
}

function hasMissingAuditCoverage(input: SkillUpstreamAuditSnapshotV1): boolean {
  return input.audit.scanners.length === 0 || input.audit.scanners.some((scanner) => scanner.coverageIds.length === 0);
}

function normalizeIdentifiers(values: readonly string[], label: string): string[] {
  return normalizeValues(values, (value) => {
    const normalized = normalizeRequiredText(value, label, 512);
    if (!/^[\p{L}\p{N}._:@/+*-]+$/u.test(normalized)) {
      throw new TypeError(`Invalid ${label}.`);
    }
    return normalized;
  });
}

function normalizeEnvironmentVariableNames(values: readonly string[]): string[] {
  return normalizeValues(values, (value) => {
    const normalized = normalizeRequiredText(value, "environment variable name", 256);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) {
      throw new TypeError("Invalid environment variable name.");
    }
    return normalized;
  });
}

function normalizeNetworkOrigins(values: readonly string[]): string[] {
  return normalizeValues(values, (value) => {
    const parsed = new URL(normalizeRequiredText(value, "network origin", 2_048));
    if (!new Set(["http:", "https:", "ws:", "wss:"]).has(parsed.protocol) || parsed.origin === "null") {
      throw new TypeError("Invalid network origin.");
    }
    return parsed.origin.toLowerCase();
  });
}

function normalizeFilesystemScopes(values: readonly string[]): string[] {
  return normalizeValues(values, (value) => {
    const normalized = normalizeRequiredText(value, "filesystem scope", 2_048).replaceAll("\\", "/");
    if (normalized.split("/").includes("..")) throw new TypeError("Filesystem scopes may not contain '..'.");
    return normalized.replace(/\/{2,}/gu, "/");
  });
}

function normalizeFreeformValues(values: readonly string[], label: string): string[] {
  return normalizeValues(values, (value) => normalizeRequiredText(value, label, 2_048));
}

function normalizeValues(values: readonly string[], normalizer: (value: string) => string): string[] {
  if (!Array.isArray(values) || values.length > 256)
    throw new TypeError("Permission lists are bounded to 256 entries.");
  return [...new Set(values.map(normalizer))].sort(compareStrings);
}

function normalizeTitle(value: string): string {
  return normalizeRequiredText(value, "skill title", 512).replace(/[\t ]+/gu, " ");
}

function normalizeCorrectedBehavior(value: string): string {
  if (typeof value !== "string") throw new TypeError("corrected behavior must be a string.");
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^(?:\n)+|(?:\n)+$/gu, "");
  if (!normalized.trim() || normalized.length > 100_000) {
    throw new TypeError("Corrected behavior is missing or too long.");
  }
  return normalized;
}

function normalizeRequiredText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength) throw new TypeError(`${label} is missing or too long.`);
  return normalized;
}

function isExactTree(value: unknown): value is SkillExactTreeIdentity {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ["manifestVersion", "treeSha256", "fileCount", "totalBytes"]) &&
    value.manifestVersion === "goatcitadel.skill-tree.v1" &&
    isSha256(value.treeSha256) &&
    Number.isSafeInteger(value.fileCount) &&
    Number(value.fileCount) >= 0 &&
    Number(value.fileCount) <= SKILL_TREE_MAX_FILES &&
    Number.isSafeInteger(value.totalBytes) &&
    Number(value.totalBytes) >= 0 &&
    Number(value.totalBytes) <= SKILL_TREE_MAX_BYTES
  );
}

function isAuditSnapshot(value: unknown): value is SkillUpstreamAuditDetails {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "policyId",
      "policyVersion",
      "policyRevision",
      "scanners",
      "findingCodes",
      "blockerCodes",
      "approvedBlockerResolutions",
    ]) &&
    isBoundedText(value.policyId, 256) &&
    isBoundedText(value.policyVersion, 256) &&
    Number.isSafeInteger(value.policyRevision) &&
    Number(value.policyRevision) >= 0 &&
    Array.isArray(value.scanners) &&
    value.scanners.length <= 64 &&
    value.scanners.every(isScannerSnapshot) &&
    hasUniqueScannerIds(value.scanners) &&
    isStringArray(value.findingCodes, 1_024) &&
    isStringArray(value.blockerCodes, 1_024) &&
    Array.isArray(value.approvedBlockerResolutions) &&
    value.approvedBlockerResolutions.length <= 1_024 &&
    value.approvedBlockerResolutions.every(isApprovedBlockerResolution)
  );
}

function isScannerSnapshot(value: unknown): value is SkillAuditScannerSnapshot {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ["scannerId", "scannerVersion", "revision", "coverageIds"]) &&
    isBoundedText(value.scannerId, 256) &&
    isBoundedText(value.scannerVersion, 256) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    isStringArray(value.coverageIds, 256)
  );
}

function isApprovedBlockerResolution(value: unknown): value is SkillApprovedBlockerResolution {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ["blockerCode", "evidenceId", "approvedAt"]) &&
    isBoundedText(value.blockerCode, 256) &&
    isBoundedText(value.evidenceId, 256) &&
    isIsoTimestamp(value.approvedAt)
  );
}

function isArtifactRef(value: unknown): value is SkillCorrectionArtifactRef {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ["artifactId", "sha256", "bytes"]) &&
    isBoundedText(value.artifactId, 256) &&
    isSha256(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) >= 0 &&
    Number(value.bytes) <= SKILL_CORRECTION_ARTIFACT_MAX_BYTES
  );
}

function isStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isBoundedText(item, 512));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  return (
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function hasUniqueScannerIds(value: readonly SkillAuditScannerSnapshot[]): boolean {
  return new Set(value.map((scanner) => scanner.scannerId)).size === value.length;
}

function isCanonicalScannerFloor(value: readonly SkillAuditScannerSnapshot[]): boolean {
  if (!hasUniqueScannerIds(value)) return false;
  return value.every((scanner, index) => {
    const previous = value[index - 1];
    return (
      (!previous || compareStrings(previous.scannerId, scanner.scannerId) < 0) &&
      isCanonicalStringArray(scanner.coverageIds, 256, 512)
    );
  });
}

function isCanonicalStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  if (!isStringArray(value, maxItems) || !value.every((item) => item.length <= maxLength)) return false;
  const normalized = [...new Set(value)].sort(compareStrings);
  return normalized.length === value.length && normalized.every((item, index) => item === value[index]);
}

function inspectGovernanceMetadata(value: unknown, depth: number, counter: { entries: number }, label: string): void {
  if (depth > GOVERNANCE_METADATA_MAX_DEPTH) {
    throw new TypeError(`${label} exceeds the maximum nesting depth.`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2_048) throw new TypeError(`${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    counter.entries += value.length;
    assertEntryBudget(counter, label);
    for (const entry of value) inspectGovernanceMetadata(entry, depth + 1, counter, label);
    return;
  }
  if (!isRecord(value)) throw new TypeError(`${label} contains an unsupported value.`);
  const entries = Object.entries(value);
  counter.entries += entries.length;
  assertEntryBudget(counter, label);
  for (const [key, entry] of entries) {
    if (!key || key.length > 128 || isForbiddenGovernanceMetadataKey(key)) {
      throw new TypeError(`${label} contains forbidden or invalid key '${key}'.`);
    }
    inspectGovernanceMetadata(entry, depth + 1, counter, label);
  }
}

function assertEntryBudget(counter: { entries: number }, label: string): void {
  if (counter.entries > GOVERNANCE_METADATA_MAX_ENTRIES) {
    throw new TypeError(`${label} exceeds the ${GOVERNANCE_METADATA_MAX_ENTRIES}-entry limit.`);
  }
}

function isForbiddenGovernanceMetadataKey(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  return new Set([
    "apikey",
    "authorization",
    "body",
    "content",
    "cookie",
    "cookies",
    "correctedbehavior",
    "credential",
    "credentials",
    "message",
    "messages",
    "password",
    "plaintext",
    "privatekey",
    "prompt",
    "raw",
    "rawcontent",
    "rawtext",
    "response",
    "secret",
    "secrets",
    "sourcetext",
    "text",
    "token",
    "tokens",
  ]).has(normalized);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
