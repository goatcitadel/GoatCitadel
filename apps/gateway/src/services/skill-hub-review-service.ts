import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ConflictError,
  NotFoundError,
  SKILL_PERMISSION_ENVELOPE_VERSION,
  ValidationError,
  canonicalJsonString,
  diffSkillPermissionEnvelopes,
  isGoatError,
  normalizeSkillPermissionEnvelope,
  type GovernanceJourneyEventRecord,
  type SkillHubSnapshotArtifactRecord,
  type SkillImportValidationResult,
  type SkillPermissionDiffV1,
  type SkillPermissionEnvelopeV1,
  type SkillUpstreamAuditDetails,
} from "@goatcitadel/contracts";
import type { SkillHubSnapshotCreateInput, SkillHubSnapshotRecord, Storage } from "@goatcitadel/storage";
import { parseSkillMarkdown } from "@goatcitadel/skills";
import { SKILL_BUNDLE_MANIFEST_FILENAME } from "./skill-bundle-manifest.js";
import { SkillHubArtifactStore } from "./skill-hub-artifact-store.js";
import type { MaterializedSkillReviewContext, SkillImportService } from "./skill-import-service.js";

export const SKILL_HUB_REVIEW_SCHEMA_VERSION = "goatcitadel.skill-hub-review.v1" as const;

const REVIEW_POLICY_ID = "goatcitadel.skill-hub-admission";
const REVIEW_POLICY_VERSION = "1.0.0";
const REVIEW_POLICY_REVISION = 1;
const REVIEW_IDEMPOTENCY_MAX_LENGTH = 256;
const MARKETPLACE_HOSTS = new Set([
  "agentskill.sh",
  "www.agentskill.sh",
  "clawhub.ai",
  "www.clawhub.ai",
  "skillsmp.com",
  "www.skillsmp.com",
]);
// Hosted bundles flow through fetchAllowlisted, including guarded DNS
// resolution. Git materialization uses the system Git client and cannot reuse
// that dispatcher, so production review admits only exact public forge hosts
// whose DNS is not controlled by the submitted source.
const TRUSTED_GIT_FORGE_HOSTS = new Set(["bitbucket.org", "codeberg.org", "github.com", "gitlab.com"]);

type ReviewStorage = Pick<
  Storage,
  "skillHubSnapshots" | "skillHubArtifacts" | "governanceJourneyEvents" | "runImmediateTransaction"
>;

export interface SkillHubSourceReviewInput {
  workspaceId: string;
  sourceRef: string;
  sourceType?: "git_url" | "remote_bundle";
  idempotencyKey: string;
  actorId: string;
}

export interface SkillHubRollbackReviewInput {
  workspaceId: string;
  snapshotId: string;
  idempotencyKey: string;
  actorId: string;
}

export interface SkillHubReviewResult {
  schemaVersion: typeof SKILL_HUB_REVIEW_SCHEMA_VERSION;
  snapshot: SkillHubSnapshotRecord;
  artifact: SkillHubSnapshotArtifactRecord;
  journeyEvent: GovernanceJourneyEventRecord;
  replayed: boolean;
}

export interface SkillHubReviewServiceOptions {
  storage: ReviewStorage;
  artifactStore: SkillHubArtifactStore;
  skillImport: Pick<SkillImportService, "withMaterializedValidation">;
  now?: () => string;
  /** Test-only transaction rollback seam after snapshot/artifact writes. */
  beforeJourneyPersistence?: (snapshotId: string) => void;
}

interface PreparedReview {
  sourceProvider: string;
  sourceType: string;
  sourceRef: string;
  canonicalSourceKey: string;
  declaredVersion?: string;
  resolvedVersion: string;
  contentTreeSha256: string;
  provenance: Record<string, unknown>;
  audit: SkillUpstreamAuditDetails;
  permissionEnvelope: SkillPermissionEnvelopeV1;
  compatibility: Record<string, unknown>;
  riskLevel: SkillHubSnapshotRecord["riskLevel"];
  trustDisposition: SkillHubSnapshotRecord["trustDisposition"];
  blockerCodes: string[];
}

interface PersistIdentity {
  snapshotId: string;
  artifactId: string;
  journeyEventId: string;
  journeyIdempotencyKey: string;
}

export class SkillHubReviewService {
  private readonly now: () => string;

  public constructor(private readonly options: SkillHubReviewServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async reviewSource(input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult> {
    const workspaceId = normalizeIdentity(input.workspaceId, "workspace ID", 256);
    const actorId = normalizeIdentity(input.actorId, "actor ID", 256);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const source = normalizeHttpsSource(input.sourceRef, input.sourceType);
    const identity = persistIdentity("source-review", workspaceId, idempotencyKey);
    let enteredValidatedCallback = false;
    try {
      return await this.options.skillImport.withMaterializedValidation(
        { sourceRef: source.sourceRef, sourceType: source.sourceType },
        async (context) => {
          enteredValidatedCallback = true;
          assertCompleteValidation(context.validation);
          const validatedTree = context.validation.provenance?.contentIntegrity?.treeSha256;
          if (!validatedTree) {
            rejectReview("CONTENT_INTEGRITY_MISSING", "Validated source did not produce an exact content tree.");
          }
          const published = await this.options.artifactStore.publishFromDirectory({
            sourceDir: context.skillDir,
            expectedTreeSha256: validatedTree,
          });
          const exactSkillDir = this.options.artifactStore.resolveBundlePath(published.bundleRelPath);
          const exactValidation = await context.validateExactDirectory(exactSkillDir);
          const prepared = await prepareReview(
            { ...context, skillDir: exactSkillDir, validation: exactValidation },
            source,
          );
          if (prepared.contentTreeSha256 !== published.manifest.treeSha256) {
            rejectReview("CONTENT_INTEGRITY_MISMATCH", "CAS bytes differ from the exact production review result.");
          }
          const persisted = this.options.storage.runImmediateTransaction(() =>
            this.persistPreparedReview({
              workspaceId,
              actorId,
              idempotencyKey,
              identity,
              prepared,
              artifact: published,
            }),
          );
          await this.assertArtifactBytes(persisted.artifact);
          return persisted;
        },
      );
    } catch (error) {
      if (enteredValidatedCallback || isGoatError(error)) throw error;
      throw new ValidationError({
        field: "sourceRef",
        message: "Skill Hub source could not be materialized into an exact validated tree.",
      });
    }
  }

  public async prepareRollbackReview(input: SkillHubRollbackReviewInput): Promise<SkillHubReviewResult> {
    const workspaceId = normalizeIdentity(input.workspaceId, "workspace ID", 256);
    const actorId = normalizeIdentity(input.actorId, "actor ID", 256);
    const sourceSnapshotId = normalizeIdentity(input.snapshotId, "snapshot ID", 256);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const original = this.options.storage.skillHubSnapshots.find(sourceSnapshotId);
    if (!original || original.workspaceId !== workspaceId) {
      throw new NotFoundError({ entity: "Skill Hub retained snapshot", id: sourceSnapshotId });
    }
    const originalArtifact = this.options.storage.skillHubArtifacts.findBySnapshot(workspaceId, sourceSnapshotId);
    if (!originalArtifact || !(await this.verifyArtifact(originalArtifact))) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Retained Skill Hub rollback bytes are unavailable or fail content verification.",
      });
    }

    const identity = persistIdentity("rollback-review", workspaceId, idempotencyKey);
    const persisted = this.options.storage.runImmediateTransaction(() => {
      const existing = this.options.storage.skillHubSnapshots.find(identity.snapshotId);
      if (existing) {
        assertRollbackReplay(existing, original);
        return this.loadReplay(existing, identity);
      }
      const prior = this.latestSnapshot(original.workspaceId, original.canonicalSourceKey);
      const permissionEnvelope = original.permissionEnvelope as unknown as SkillPermissionEnvelopeV1;
      const createdAt = nextTimestamp(this.now(), prior?.createdAt);
      const snapshot = this.options.storage.skillHubSnapshots.create({
        snapshotId: identity.snapshotId,
        workspaceId,
        operation: "rollback_check",
        sourceProvider: original.sourceProvider,
        sourceType: original.sourceType,
        sourceRef: original.sourceRef,
        canonicalSourceKey: original.canonicalSourceKey,
        declaredVersion: original.declaredVersion,
        resolvedVersion: original.resolvedVersion,
        contentTreeSha256: original.contentTreeSha256,
        provenance: {
          reviewSchemaVersion: SKILL_HUB_REVIEW_SCHEMA_VERSION,
          rollbackFromSnapshotId: original.snapshotId,
          retainedArtifactId: originalArtifact.artifactId,
        },
        audit: original.audit,
        auditSha256: original.auditSha256,
        permissionEnvelope: original.permissionEnvelope,
        permissionEnvelopeSha256: original.permissionEnvelopeSha256,
        permissionDiff: permissionDiff(prior, permissionEnvelope) as unknown as Record<string, unknown>,
        compatibility: original.compatibility,
        riskLevel: original.riskLevel,
        trustDisposition: original.trustDisposition === "revoked" ? "blocked" : original.trustDisposition,
        priorSnapshotId: prior?.snapshotId,
        blockerCodes: original.blockerCodes,
        createdAt,
      });
      const artifact = this.options.storage.skillHubArtifacts.create({
        ...originalArtifact,
        artifactId: identity.artifactId,
        snapshotId: snapshot.snapshotId,
        createdAt,
      });
      this.options.beforeJourneyPersistence?.(snapshot.snapshotId);
      const journeyEvent = this.createJourney({
        identity,
        snapshot,
        artifact,
        actorId,
        action: "rollback_review_prepared",
        operationIdempotencyKey: idempotencyKey,
        rollbackFromSnapshotId: original.snapshotId,
      });
      return result(snapshot, artifact, journeyEvent, false);
    });
    await this.assertArtifactBytes(persisted.artifact);
    return persisted;
  }

  private persistPreparedReview(input: {
    workspaceId: string;
    actorId: string;
    idempotencyKey: string;
    identity: PersistIdentity;
    prepared: PreparedReview;
    artifact: Awaited<ReturnType<SkillHubArtifactStore["publishFromDirectory"]>>;
  }): SkillHubReviewResult {
    const existing = this.options.storage.skillHubSnapshots.find(input.identity.snapshotId);
    if (existing) {
      assertSourceReplay(existing, input.prepared);
      return this.loadReplay(existing, input.identity);
    }
    const prior = this.latestSnapshot(input.workspaceId, input.prepared.canonicalSourceKey);
    const createdAt = nextTimestamp(this.now(), prior?.createdAt);
    const snapshotInput: SkillHubSnapshotCreateInput = {
      snapshotId: input.identity.snapshotId,
      workspaceId: input.workspaceId,
      operation: "review",
      sourceProvider: input.prepared.sourceProvider,
      sourceType: input.prepared.sourceType,
      sourceRef: input.prepared.sourceRef,
      canonicalSourceKey: input.prepared.canonicalSourceKey,
      declaredVersion: input.prepared.declaredVersion,
      resolvedVersion: input.prepared.resolvedVersion,
      contentTreeSha256: input.prepared.contentTreeSha256,
      provenance: input.prepared.provenance,
      audit: input.prepared.audit as unknown as Record<string, unknown>,
      auditSha256: digest(input.prepared.audit),
      permissionEnvelope: input.prepared.permissionEnvelope as unknown as Record<string, unknown>,
      permissionEnvelopeSha256: digest(input.prepared.permissionEnvelope),
      permissionDiff: permissionDiff(prior, input.prepared.permissionEnvelope) as unknown as Record<string, unknown>,
      compatibility: input.prepared.compatibility,
      riskLevel: input.prepared.riskLevel,
      trustDisposition: input.prepared.trustDisposition,
      priorSnapshotId: prior?.snapshotId,
      blockerCodes: input.prepared.blockerCodes,
      createdAt,
    };
    const snapshot = this.options.storage.skillHubSnapshots.create(snapshotInput);
    const artifact = this.options.storage.skillHubArtifacts.create({
      artifactId: input.identity.artifactId,
      workspaceId: input.workspaceId,
      snapshotId: snapshot.snapshotId,
      contentTreeSha256: snapshot.contentTreeSha256,
      bundleRelPath: input.artifact.bundleRelPath,
      manifest: input.artifact.manifest,
      manifestSha256: input.artifact.manifestSha256,
      fileCount: input.artifact.manifest.fileCount,
      totalBytes: input.artifact.manifest.totalBytes,
      createdAt,
    });
    this.options.beforeJourneyPersistence?.(snapshot.snapshotId);
    const journeyEvent = this.createJourney({
      identity: input.identity,
      snapshot,
      artifact,
      actorId: input.actorId,
      action: "upstream_review_captured",
      operationIdempotencyKey: input.idempotencyKey,
    });
    return result(snapshot, artifact, journeyEvent, false);
  }

  private createJourney(input: {
    identity: PersistIdentity;
    snapshot: SkillHubSnapshotRecord;
    artifact: SkillHubSnapshotArtifactRecord;
    actorId: string;
    action: "upstream_review_captured" | "rollback_review_prepared";
    operationIdempotencyKey: string;
    rollbackFromSnapshotId?: string;
  }): GovernanceJourneyEventRecord {
    const timestamp = input.snapshot.createdAt;
    return this.options.storage.governanceJourneyEvents.create({
      schemaVersion: "goatcitadel.journey-event.v1",
      eventId: input.identity.journeyEventId,
      idempotencyKey: input.identity.journeyIdempotencyKey,
      scopeKind: "workspace",
      workspaceId: input.snapshot.workspaceId,
      eventType: "skill_hub_review",
      subjectKind: "skill",
      subjectId: input.snapshot.snapshotId,
      action: input.action,
      actorId: input.actorId,
      actorType: "operator",
      fingerprint: input.snapshot.contentTreeSha256,
      sourceKind: "upstream_snapshot",
      sourceId: input.snapshot.snapshotId,
      trustDisposition: input.snapshot.trustDisposition,
      poisoningStatus: input.snapshot.blockerCodes.length > 0 ? "blocked" : "clean",
      evidenceRefs: [
        { owner: "artifact", refId: input.artifact.artifactId },
        { owner: "upstream_snapshot", refId: input.snapshot.snapshotId },
      ],
      provenance: {
        sourceRequired: true,
        approvalRequired: false,
        reviewSchemaVersion: SKILL_HUB_REVIEW_SCHEMA_VERSION,
        operationIdempotencySha256: digest(input.operationIdempotencyKey),
        ...(input.rollbackFromSnapshotId ? { rollbackFromSnapshotId: input.rollbackFromSnapshotId } : {}),
      },
      summary: {
        actionCode:
          input.action === "upstream_review_captured" ? "UPSTREAM_REVIEW_CAPTURED" : "ROLLBACK_REVIEW_PREPARED",
        auditSha256: input.snapshot.auditSha256,
        permissionEnvelopeSha256: input.snapshot.permissionEnvelopeSha256,
        blockerCodes: input.snapshot.blockerCodes,
        riskLevel: input.snapshot.riskLevel,
      },
      occurredAt: timestamp,
      recordedAt: timestamp,
    });
  }

  private loadReplay(snapshot: SkillHubSnapshotRecord, identity: PersistIdentity): SkillHubReviewResult {
    const artifact = this.options.storage.skillHubArtifacts.findBySnapshot(snapshot.workspaceId, snapshot.snapshotId);
    const journeyEvent = this.options.storage.governanceJourneyEvents.findByIdempotencyKey(
      identity.journeyIdempotencyKey,
    );
    if (!artifact || artifact.artifactId !== identity.artifactId || !journeyEvent) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Skill Hub review replay is missing immutable artifact or Journey evidence.",
      });
    }
    return result(snapshot, artifact, journeyEvent, true);
  }

  private latestSnapshot(workspaceId: string, canonicalSourceKey: string): SkillHubSnapshotRecord | undefined {
    return this.options.storage.skillHubSnapshots.listBySource(workspaceId, canonicalSourceKey, 1)[0];
  }

  private async assertArtifactBytes(artifact: SkillHubSnapshotArtifactRecord): Promise<void> {
    if (!(await this.verifyArtifact(artifact))) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Skill Hub review artifact failed exact-byte verification.",
      });
    }
  }

  private verifyArtifact(artifact: SkillHubSnapshotArtifactRecord): Promise<boolean> {
    return this.options.artifactStore.verify({
      bundleRelPath: artifact.bundleRelPath,
      manifest: artifact.manifest,
    });
  }
}

async function prepareReview(
  context: MaterializedSkillReviewContext,
  source: { sourceRef: string; sourceType: "git_url" | "remote_bundle" },
): Promise<PreparedReview> {
  const validation = context.validation;
  assertCompleteValidation(validation);
  const integrity = validation.provenance?.contentIntegrity;
  if (!integrity) rejectReview("CONTENT_INTEGRITY_MISSING", "Validated source did not produce an exact content tree.");
  if (validation.candidate.sourceType !== source.sourceType || validation.candidate.sourceRef !== source.sourceRef) {
    rejectReview("SOURCE_IDENTITY_MISMATCH", "Materialized source identity did not match the reviewed request.");
  }
  const declaredVersion = await assertKnownFrontmatterShape(context.skillDir);
  const bundleScriptPaths = await assertKnownBundleShape(context.skillDir, validation);
  const networkOrigins = await extractExactNetworkOrigins(context.skillDir, validation, integrity.files);
  const permissionEnvelope = buildPermissionEnvelope(validation, networkOrigins, bundleScriptPaths);
  const blockerCodes = standardizedBlockers(validation);
  const audit = buildAudit(validation, blockerCodes, networkOrigins, permissionEnvelope);
  const resolvedVersion = context.resolvedGitCommit ?? `sha256:${integrity.treeSha256}`;
  const compatibility = {
    bundleManifestStatus: validation.bundleManifest?.status ?? "absent",
    callability: validation.compatibility?.callability ?? "review_only",
    compatibilitySources: [...(validation.compatibility?.sources ?? [])].sort(compareStrings),
  };
  return {
    sourceProvider: validation.candidate.sourceProvider,
    sourceType: validation.candidate.sourceType,
    sourceRef: validation.candidate.sourceRef,
    canonicalSourceKey: validation.candidate.canonicalKey,
    declaredVersion,
    resolvedVersion,
    contentTreeSha256: integrity.treeSha256,
    provenance: {
      reviewSchemaVersion: SKILL_HUB_REVIEW_SCHEMA_VERSION,
      sourceProvider: validation.candidate.sourceProvider,
      sourceType: validation.candidate.sourceType,
      sourceRef: validation.candidate.sourceRef,
      ...(context.resolvedGitCommit ? { resolvedGitCommit: context.resolvedGitCommit } : {}),
      nonCallableUntilActivated: true,
    },
    audit,
    permissionEnvelope,
    compatibility,
    riskLevel: validation.riskLevel,
    trustDisposition: blockerCodes.length === 0 ? "candidate" : "blocked",
    blockerCodes,
  };
}

function assertCompleteValidation(validation: SkillImportValidationResult): void {
  if (!validation.valid) {
    rejectReview("VALIDATION_FAILED", "Skill source failed production admission validation.");
  }
  if (!validation.checks.frontmatterValid || !validation.inferredSkillId) {
    rejectReview("FRONTMATTER_INVALID", "Skill source lacks a validated canonical skill identity.");
  }
  if (!validation.provenance?.contentIntegrity) {
    rejectReview("CONTENT_INTEGRITY_MISSING", "Skill source lacks exact-byte provenance.");
  }
  if (validation.bundleManifest?.status === "invalid") {
    rejectReview("BUNDLE_MANIFEST_INVALID", "Skill bundle manifest is invalid.");
  }
  if (
    validation.warnings.some(
      (warning) =>
        warning.startsWith("Security scan skipped large files:") ||
        warning === "Security scan reached the file inspection limit; review the remaining files manually.",
    )
  ) {
    rejectReview("SCAN_INCOMPLETE", "Skill source security coverage was incomplete.");
  }
  const mappings = validation.externalToolMappings ?? [];
  if (mappings.some((mapping) => mapping.disposition !== "mapped" || !mapping.mappedCapabilityId)) {
    rejectReview("UNMAPPED_TOOL", "Skill source declares a tool without an exact governed mapping.");
  }
  if ((validation.declaredTools?.length ?? 0) !== mappings.length) {
    rejectReview("TOOL_MAPPING_INCOMPLETE", "Skill tool mapping coverage is incomplete.");
  }
  if (!validation.scriptDisposition) {
    rejectReview("SCRIPT_PERMISSION_UNKNOWN", "Skill script permission coverage is missing.");
  }
}

function buildPermissionEnvelope(
  validation: SkillImportValidationResult,
  networkOrigins: string[],
  bundleScriptPaths: string[],
): SkillPermissionEnvelopeV1 {
  const mappings = validation.externalToolMappings ?? [];
  const mappedByName = new Map(mappings.map((mapping) => [mapping.declaredTool.toLowerCase(), mapping]));
  const metadata = validation.bundleManifest?.declaredMetadata;
  const toolIds = mappings.map((mapping) => mapping.mappedCapabilityId!);
  for (const dependency of metadata?.dependencies.tools ?? []) {
    const mapping = mappedByName.get(dependency.toLowerCase());
    if (!mapping?.mappedCapabilityId) {
      rejectReview("UNMAPPED_TOOL", "Bundle dependency declares a tool without an exact governed mapping.");
    }
    toolIds.push(mapping.mappedCapabilityId);
  }
  const nativeRequirements = [
    ...validation.requires.map((value) => `require:${normalizePermissionValue(value, "requirement")}`),
    ...(metadata?.dependencies.skillIds ?? []).map(
      (value) => `skill:${normalizePermissionValue(value, "skill dependency")}`,
    ),
    ...(metadata?.dependencies.capabilities ?? []).map(
      (value) => `capability:${normalizePermissionValue(value, "capability dependency")}`,
    ),
  ];
  try {
    return normalizeSkillPermissionEnvelope({
      version: SKILL_PERMISSION_ENVELOPE_VERSION,
      toolIds,
      environmentVariableNames: (metadata?.requiredEnv ?? []).map((entry) => entry.name),
      networkOrigins,
      filesystem: {
        readScopes: (metadata?.stateDirs ?? []).map((entry) => entry.path),
        writeScopes: (metadata?.stateDirs ?? []).filter((entry) => entry.writeable === true).map((entry) => entry.path),
      },
      scripts: [...(validation.scriptDisposition?.scriptFiles ?? []), ...bundleScriptPaths],
      dependencies: {
        packages: [],
        nativeRequirements,
      },
    });
  } catch {
    rejectReview("PERMISSION_ENVELOPE_INVALID", "Skill permission envelope could not be normalized exactly.");
  }
}

function buildAudit(
  validation: SkillImportValidationResult,
  blockerCodes: string[],
  networkOrigins: string[],
  permissionEnvelope: SkillPermissionEnvelopeV1,
): SkillUpstreamAuditDetails {
  const findingCodes = [
    "BUNDLE_METADATA_VALIDATED",
    "CONTENT_TREE_VALIDATED",
    "FRONTMATTER_VALIDATED",
    "PERMISSION_ENVELOPE_DERIVED",
    "SECURITY_SCAN_COMPLETE",
    ...(validation.checks.licenseDetected ? ["LICENSE_PRESENT"] : ["LICENSE_NOT_DETECTED"]),
    ...(permissionEnvelope.scripts.length ? ["SCRIPT_FILES_DECLARED"] : []),
    ...(validation.suspiciousSignals.length ? ["SUSPICIOUS_SCRIPT_INDICATOR"] : []),
    ...(networkOrigins.length ? ["NETWORK_ORIGINS_DECLARED"] : []),
  ];
  return {
    policyId: REVIEW_POLICY_ID,
    policyVersion: REVIEW_POLICY_VERSION,
    policyRevision: REVIEW_POLICY_REVISION,
    scanners: [
      {
        scannerId: "goatcitadel.import-validator",
        scannerVersion: "1.0.0",
        revision: 1,
        coverageIds: ["bundle_manifest", "content_integrity", "frontmatter", "tool_mapping"],
      },
      {
        scannerId: "goatcitadel.static-permission-scan",
        scannerVersion: "1.0.0",
        revision: 1,
        coverageIds: ["filesystem", "network_origins", "scripts"],
      },
    ],
    findingCodes: [...new Set(findingCodes)].sort(compareStrings),
    blockerCodes,
    approvedBlockerResolutions: [],
  };
}

function standardizedBlockers(validation: SkillImportValidationResult): string[] {
  const blockers = [
    ...(validation.suspiciousSignals.length ? ["SUSPICIOUS_SCRIPT_INDICATOR"] : []),
    ...(validation.reviewDisposition === "reference_only" ? ["REFERENCE_ONLY_SOURCE"] : []),
    ...(validation.reviewDisposition === "conditional" ? ["CONDITIONAL_REVIEW_REQUIRED"] : []),
  ];
  return [...new Set(blockers)].sort(compareStrings);
}

async function assertKnownBundleShape(skillDir: string, validation: SkillImportValidationResult): Promise<string[]> {
  if (validation.bundleManifest?.status !== "valid") return [];
  const raw = await fs.readFile(path.join(skillDir, SKILL_BUNDLE_MANIFEST_FILENAME), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    rejectReview("BUNDLE_MANIFEST_INVALID", "Skill bundle manifest is not valid JSON.");
  }
  if (!isRecord(value)) rejectReview("BUNDLE_MANIFEST_INVALID", "Skill bundle manifest is not an object.");
  assertKnownKeys(
    value,
    [
      "manifestVersion",
      "skillId",
      "name",
      "generatedAt",
      "allowedDirectories",
      "requiredEnv",
      "stateDirs",
      "declaredDependencies",
      "scriptDisposition",
      "assets",
    ],
    "UNKNOWN_BUNDLE_DIMENSION",
  );
  if (Array.isArray(value.requiredEnv)) {
    for (const entry of value.requiredEnv) {
      if (!isRecord(entry)) rejectReview("UNKNOWN_BUNDLE_DIMENSION", "Unknown required-env permission shape.");
      assertKnownKeys(entry, ["name", "description", "required", "secret"], "UNKNOWN_BUNDLE_DIMENSION");
    }
  }
  if (Array.isArray(value.stateDirs)) {
    for (const entry of value.stateDirs) {
      if (!isRecord(entry)) rejectReview("UNKNOWN_BUNDLE_DIMENSION", "Unknown state-dir permission shape.");
      assertKnownKeys(entry, ["path", "description", "writeable"], "UNKNOWN_BUNDLE_DIMENSION");
    }
  }
  if (isRecord(value.declaredDependencies)) {
    assertKnownKeys(value.declaredDependencies, ["tools", "skillIds", "capabilities"], "UNKNOWN_BUNDLE_DIMENSION");
  }
  if (Array.isArray(value.assets)) {
    for (const entry of value.assets) {
      if (!isRecord(entry)) rejectReview("UNKNOWN_BUNDLE_DIMENSION", "Unknown bundle-asset permission shape.");
      assertKnownKeys(entry, ["path", "sha256", "kind", "bytes", "callable"], "UNKNOWN_BUNDLE_DIMENSION");
    }
  }
  if (validation.warnings.some((warning) => warning.startsWith("Manifest declares unsupported allowed directories:"))) {
    rejectReview("UNKNOWN_BUNDLE_DIMENSION", "Bundle declares an unsupported permission directory.");
  }
  return Array.isArray(value.assets)
    ? value.assets
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.kind === "script")
        .map((entry) => entry.path)
        .filter((scriptPath): scriptPath is string => typeof scriptPath === "string")
    : [];
}

async function assertKnownFrontmatterShape(skillDir: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const parsed = parseSkillMarkdown(raw);
  const frontmatter = parsed.frontmatter as unknown as Record<string, unknown>;
  assertKnownKeys(frontmatter, ["name", "description", "metadata"], "UNKNOWN_FRONTMATTER_DIMENSION");
  if (frontmatter.metadata !== undefined) {
    if (!isRecord(frontmatter.metadata)) {
      rejectReview("UNKNOWN_FRONTMATTER_DIMENSION", "Skill metadata is not a known permission shape.");
    }
    assertKnownKeys(
      frontmatter.metadata,
      ["version", "tags", "tools", "requires", "keywords"],
      "UNKNOWN_FRONTMATTER_DIMENSION",
    );
  }
  const version = isRecord(frontmatter.metadata) ? frontmatter.metadata.version : undefined;
  return typeof version === "string" && version.trim() ? version.normalize("NFKC").trim() : undefined;
}

async function extractExactNetworkOrigins(
  skillDir: string,
  validation: SkillImportValidationResult,
  manifestFiles: Array<{ path: string; bytes: number }>,
): Promise<string[]> {
  if (validation.networkSignals.length === 0) return [];
  const filesByPath = new Map(manifestFiles.map((file) => [file.path, file]));
  const origins = new Set<string>();
  for (const relativePath of validation.networkSignals) {
    const file = filesByPath.get(relativePath);
    if (!file || file.bytes > 220_000) {
      rejectReview("NETWORK_ORIGIN_UNKNOWN", "Network indicator is outside exact scan coverage.");
    }
    const absolutePath = resolveManifestFile(skillDir, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const urls = extractAbsoluteUrls(content);
    if (urls.length === 0 || hasUnboundNetworkCall(content)) {
      rejectReview("NETWORK_ORIGIN_UNKNOWN", "Network indicator lacks an exact literal origin.");
    }
    for (const value of urls) {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.origin === "null") {
        rejectReview("NETWORK_ORIGIN_INVALID", "Network origin contains credentials or is not hierarchical.");
      }
      origins.add(parsed.origin.toLowerCase());
    }
  }
  return [...origins].sort(compareStrings);
}

function extractAbsoluteUrls(content: string): string[] {
  return [...content.matchAll(/https?:\/\/[^\s"'`<>()\\]+/giu)]
    .map((match) => (match[0] ?? "").replace(/[.,;:!?\]}]+$/u, ""))
    .filter((value) => {
      try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin !== "null";
      } catch {
        return false;
      }
    });
}

function hasUnboundNetworkCall(content: string): boolean {
  const fetchCalls = countMatches(content, /\bfetch\s*\(/giu);
  const boundFetchCalls = countMatches(content, /\bfetch\s*\(\s*(["'`])https?:\/\/[^"'`]+\1/giu);
  const axiosCalls = countMatches(content, /\baxios(?:\.[A-Za-z]+)?\s*\(/giu);
  const boundAxiosCalls = countMatches(content, /\baxios(?:\.[A-Za-z]+)?\s*\(\s*(["'`])https?:\/\/[^"'`]+\1/giu);
  const curlLines = content.split(/\r?\n/gu).filter((line) => /\bcurl\s+/iu.test(line));
  return (
    fetchCalls !== boundFetchCalls ||
    axiosCalls !== boundAxiosCalls ||
    curlLines.some((line) => extractAbsoluteUrls(line).length === 0)
  );
}

function normalizeHttpsSource(
  value: string,
  requestedType: SkillHubSourceReviewInput["sourceType"],
): { sourceRef: string; sourceType: "git_url" | "remote_bundle" } {
  if (typeof value !== "string" || value !== value.normalize("NFKC").trim() || !value || value.length > 2_048) {
    throw new ValidationError({ field: "sourceRef", message: "Skill Hub sourceRef must be bounded and canonical." });
  }
  if (/[%](?:00|0a|0d|2e|2f|5c)/iu.test(value) || /(?:^|\/)(?:\.{1,2})(?:\/|$)/u.test(value)) {
    throw new ValidationError({ field: "sourceRef", message: "Skill Hub sourceRef contains an unsafe path." });
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError({ field: "sourceRef", message: "Skill Hub sourceRef must be an HTTPS URL." });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    !parsed.hostname
  ) {
    throw new ValidationError({
      field: "sourceRef",
      message: "Skill Hub sources require credential-free, fragment-free HTTPS URLs.",
    });
  }
  const host = parsed.hostname.toLowerCase();
  if (MARKETPLACE_HOSTS.has(host)) {
    throw new ValidationError({
      field: "sourceRef",
      message: "Marketplace listing URLs are reference-only and cannot enter production snapshot review.",
    });
  }
  if (isLocalNetworkHost(host)) {
    throw new ValidationError({ field: "sourceRef", message: "Local-network skill sources are unsupported." });
  }
  const sourceType = requestedType ?? (/\/skill\.md$/iu.test(parsed.pathname) ? "remote_bundle" : "git_url");
  if (sourceType === "remote_bundle" && !/\/skill\.md$/iu.test(parsed.pathname)) {
    throw new ValidationError({
      field: "sourceRef",
      message: "Remote bundle sources must identify an exact skill.md endpoint.",
    });
  }
  if (sourceType === "git_url") {
    if (!TRUSTED_GIT_FORGE_HOSTS.has(host)) {
      throw new ValidationError({
        field: "sourceRef",
        message: "Production Git review supports exact trusted public forge hosts only.",
      });
    }
    if (parsed.pathname.split("/").filter(Boolean).length < 2) {
      throw new ValidationError({ field: "sourceRef", message: "Git source URL does not identify a repository." });
    }
  }
  return { sourceRef: parsed.toString(), sourceType };
}

function isLocalNetworkHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const isIpv6 = address.includes(":");
  if (
    (isIpv6 &&
      (address === "::" ||
        address === "::1" ||
        address.startsWith("fc") ||
        address.startsWith("fd") ||
        /^fe[89ab]/u.test(address))) ||
    address.startsWith("127.")
  ) {
    return true;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
    (parts[0] ?? 0) >= 224
  );
}

function assertSourceReplay(stored: SkillHubSnapshotRecord, expected: PreparedReview): void {
  const same =
    stored.operation === "review" &&
    stored.sourceProvider === expected.sourceProvider &&
    stored.sourceType === expected.sourceType &&
    stored.sourceRef === expected.sourceRef &&
    stored.canonicalSourceKey === expected.canonicalSourceKey &&
    stored.declaredVersion === expected.declaredVersion &&
    stored.resolvedVersion === expected.resolvedVersion &&
    stored.contentTreeSha256 === expected.contentTreeSha256 &&
    stored.auditSha256 === digest(expected.audit) &&
    stored.permissionEnvelopeSha256 === digest(expected.permissionEnvelope) &&
    canonicalJsonString(stored.compatibility) === canonicalJsonString(expected.compatibility);
  if (!same) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "Skill Hub review idempotency key is already bound to different source material.",
    });
  }
}

function assertRollbackReplay(stored: SkillHubSnapshotRecord, original: SkillHubSnapshotRecord): void {
  if (
    stored.operation !== "rollback_check" ||
    stored.workspaceId !== original.workspaceId ||
    stored.contentTreeSha256 !== original.contentTreeSha256 ||
    stored.auditSha256 !== original.auditSha256 ||
    stored.permissionEnvelopeSha256 !== original.permissionEnvelopeSha256 ||
    stored.provenance.rollbackFromSnapshotId !== original.snapshotId
  ) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "Skill Hub rollback-review idempotency key is bound to different retained material.",
    });
  }
}

function persistIdentity(operation: string, workspaceId: string, idempotencyKey: string): PersistIdentity {
  const fingerprint = digest({ operation, workspaceId, idempotencyKey });
  return {
    snapshotId: `skill-hub-review-${fingerprint.slice(0, 40)}`,
    artifactId: `skill-hub-artifact-${fingerprint.slice(0, 40)}`,
    journeyEventId: `skill-hub-journey-${fingerprint.slice(0, 40)}`,
    journeyIdempotencyKey: `skill-hub:review:${fingerprint}`,
  };
}

function permissionDiff(
  prior: SkillHubSnapshotRecord | undefined,
  current: SkillPermissionEnvelopeV1,
): SkillPermissionDiffV1 {
  return prior
    ? diffSkillPermissionEnvelopes(prior.permissionEnvelope as unknown as SkillPermissionEnvelopeV1, current)
    : emptyPermissionDiff();
}

function emptyPermissionDiff(): SkillPermissionDiffV1 {
  const dimension = () => ({ added: [] as string[], removed: [] as string[] });
  return {
    version: "goatcitadel.skill-permission-diff.v1",
    disposition: "none",
    dimensions: {
      toolIds: dimension(),
      environmentVariableNames: dimension(),
      networkOrigins: dimension(),
      filesystemReadScopes: dimension(),
      filesystemWriteScopes: dimension(),
      scripts: dimension(),
      packages: dimension(),
      nativeRequirements: dimension(),
    },
  };
}

function result(
  snapshot: SkillHubSnapshotRecord,
  artifact: SkillHubSnapshotArtifactRecord,
  journeyEvent: GovernanceJourneyEventRecord,
  replayed: boolean,
): SkillHubReviewResult {
  return { schemaVersion: SKILL_HUB_REVIEW_SCHEMA_VERSION, snapshot, artifact, journeyEvent, replayed };
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = normalizeIdentity(value, "idempotency key", REVIEW_IDEMPOTENCY_MAX_LENGTH);
  if (!/^[\p{L}\p{N}._:@/+*-]+$/u.test(normalized)) {
    throw new ValidationError({ field: "idempotencyKey", message: "Skill Hub idempotency key is not canonical." });
  }
  return normalized;
}

function normalizeIdentity(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value.length > maxLength || value !== value.normalize("NFKC").trim()) {
    throw new ValidationError({ field: label, message: `Skill Hub ${label} must be bounded and canonical.` });
  }
  return value;
}

function normalizePermissionValue(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || containsAsciiControlCharacter(normalized)) {
    rejectReview("PERMISSION_VALUE_INVALID", `Skill ${label} is not a canonical permission value.`);
  }
  return normalized;
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function resolveManifestFile(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    rejectReview("NETWORK_ORIGIN_UNKNOWN", "Network scan path is not canonical.");
  }
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    rejectReview("NETWORK_ORIGIN_UNKNOWN", "Network scan path escapes the validated skill tree.");
  }
  return resolved;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: string[], code: string): void {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((key) => !allowlist.has(key))) {
    rejectReview(code, "Skill bundle declares an unknown permission-bearing dimension.");
  }
}

function rejectReview(code: string, message: string): never {
  throw new ValidationError({
    message,
    field: code,
  });
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function digest(value: unknown): string {
  const material = typeof value === "string" ? value : canonicalJsonString(value);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nextTimestamp(candidate: string, prior: string | undefined): string {
  let candidateMs: number;
  try {
    candidateMs = new Date(candidate).getTime();
  } catch {
    candidateMs = Number.NaN;
  }
  if (!Number.isFinite(candidateMs) || new Date(candidateMs).toISOString() !== candidate) {
    throw new TypeError("Skill Hub review clock must return a canonical ISO timestamp.");
  }
  const priorMs = prior ? new Date(prior).getTime() : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(candidateMs, priorMs + 1)).toISOString();
}
