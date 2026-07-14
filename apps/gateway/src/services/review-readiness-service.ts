import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  ReleaseIdentityReasonCode,
  ReviewFindingImportResult,
  ReviewFindingInput,
  ReviewReadinessLane,
  ReviewReadinessSummary,
  RuntimeBuildIdentity,
  TaskRecord,
} from "@goatcitadel/contracts";
import { redactStructuredSecrets } from "@goatcitadel/contracts";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import type { RuntimeReleaseTrustReader, RuntimeReleaseTrustSnapshot } from "./runtime-release-trust-service.js";
import {
  buildReleaseIdentityCacheKey,
  classifyReleaseCertificateAttestation,
  hasInvalidReleaseEvidenceBoundary,
  resolveReleaseEvidence,
  verifyEvidenceRecords,
  type ReleaseEvidenceLocation,
} from "./review-readiness-release-evidence.js";
import {
  describeReleaseIdentityReason,
  hasCompleteVerifiedPayload,
  releaseAttestationReasonCode,
  releasePayloadReasonCode,
} from "./review-readiness-release-identity.js";

export interface ReviewReadinessServiceDependencies {
  rootDir: string;
  runtimeAppDir?: string;
  runtimeCwd?: string;
  runtimeEnv?: Readonly<Record<string, string | undefined>>;
  gitRunner?: (args: string[], cwd: string) => string | undefined;
  releaseTrust?: RuntimeReleaseTrustReader;
  taskLifecycleService: Pick<
    TaskLifecycleService,
    "appendTaskActivity" | "appendTaskDeliverable" | "createTask" | "listTasks" | "updateTask"
  >;
}

const READINESS_LANES = [
  { lane: "skills-catalog", command: "pnpm verify:skills:catalog" },
  { lane: "catalog-parity", command: "pnpm verify:catalog:parity" },
  { lane: "runtime-truth", command: "pnpm verify:runtime:truth" },
  { lane: "memory-truth", command: "pnpm verify:memory:truth" },
] as const;

const CURRENT_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REVIEW_FINDING_PREFIX = "Review finding key:";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CERTIFICATE_ITEMS = 256;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
export const REQUIRED_RELEASE_PROOF_LANE_NAMES = [
  "verify:fast",
  "verify:runtime:truth",
  "verify:auth:matrix",
  "verify:desktop",
  "verify:code-mode:sandbox",
  "verify:code-mode:hostile-sandbox",
  "verify:agentic:governance",
  "verify:agentic:proof",
  "verify:orchestration:perf",
  "verify:channels:runtime",
  "verify:extensions:package",
  "verify:ui:parity",
  "verify:memory:truth",
  "verify:realtime:truth",
  "verify:architecture:metrics",
  "verify:operator:proof",
  "verify:durable:recovery",
  "verify:surface:regression",
  "verify:visual:regression",
  "verify:backup:roundtrip",
  "verify:catalog:parity",
  "verify:api:compat",
  "verify:a2a:full",
  "docs:check",
  "security:trivy",
] as const;
const DIRECT_ONLY_RELEASE_PROOF_LANES = new Set(["verify:fast", "docs:check", "security:trivy"]);

export class ReviewReadinessService {
  private releaseIdentityCache: { key: string; value: RuntimeBuildIdentity["release"] } | undefined;
  private readonly trustedPackagedAppDir?: string;
  private readonly trustedPackagedIdentity?: Omit<RuntimeBuildIdentity, "release">;

  public constructor(private readonly deps: ReviewReadinessServiceDependencies) {
    if (deps.releaseTrust) {
      this.trustedPackagedAppDir = this.resolvePackagedAppDir(deps.runtimeEnv ?? process.env, true);
      this.trustedPackagedIdentity = this.trustedPackagedAppDir
        ? resolvePackagedBuildIdentity(this.trustedPackagedAppDir)
        : undefined;
    }
  }

  public getReadiness(): ReviewReadinessSummary {
    const linkedTasks = this.listReviewTasks();
    const releaseTrust = this.deps.releaseTrust?.getSnapshot();
    return {
      branch: this.git(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown",
      sha: this.git(["rev-parse", "HEAD"]) || "unknown",
      generatedAt: new Date().toISOString(),
      lanes: READINESS_LANES.map((lane) => this.resolveLane(lane.lane, lane.command)),
      openFindings: linkedTasks.filter((task) => task.status !== "done").length,
      linkedTasks,
      runtimeIdentity: this.resolveRuntimeIdentity(releaseTrust),
      releaseProof: this.readReleaseProofSummary(releaseTrust),
    };
  }

  public importFindings(input: { findings: ReviewFindingInput[]; actorId?: string }): ReviewFindingImportResult {
    const importedAt = new Date().toISOString();
    const created: TaskRecord[] = [];
    const updated: TaskRecord[] = [];
    const skipped: ReviewFindingInput[] = [];
    const existingByKey = new Map(this.listReviewTasks().map((task) => [extractReviewKey(task), task]));

    for (const finding of input.findings) {
      const normalized = normalizeFinding(finding);
      if (!normalized) {
        skipped.push(finding);
        continue;
      }
      const key = buildFindingKey(normalized);
      const existing = existingByKey.get(key);
      if (existing) {
        const task = this.deps.taskLifecycleService.updateTask(existing.taskId, {
          description: renderFindingDescription(key, normalized),
          priority: normalized.priority ?? existing.priority,
          status: existing.status === "done" ? "review" : existing.status,
        });
        this.deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: "diagnostic",
          agentId: input.actorId,
          message: `Review finding refreshed from ${normalized.source}.`,
          metadata: { reviewFindingKey: key, source: normalized.source, component: normalized.component },
        });
        appendEvidenceDeliverable(this.deps.taskLifecycleService, task.taskId, normalized);
        updated.push(task);
        existingByKey.set(key, task);
        continue;
      }
      const task = this.deps.taskLifecycleService.createTask({
        title: normalized.title,
        description: renderFindingDescription(key, normalized),
        status: "review",
        priority: normalized.priority ?? "normal",
        createdBy: "review-readiness",
      });
      this.deps.taskLifecycleService.appendTaskActivity(task.taskId, {
        activityType: "diagnostic",
        agentId: input.actorId,
        message: `Review finding imported from ${normalized.source}.`,
        metadata: { reviewFindingKey: key, source: normalized.source, component: normalized.component },
      });
      appendEvidenceDeliverable(this.deps.taskLifecycleService, task.taskId, normalized);
      created.push(task);
      existingByKey.set(key, task);
    }

    return { importedAt, created, updated, skipped };
  }

  public getRuntimeIdentity(): RuntimeBuildIdentity {
    return this.resolveRuntimeIdentity(this.deps.releaseTrust?.getSnapshot());
  }

  public async refreshRuntimeReleaseTrust(): Promise<ReviewReadinessSummary> {
    await this.deps.releaseTrust?.requestRefresh({ force: true, reason: "operator" });
    return this.getReadiness();
  }

  private resolveRuntimeIdentity(releaseTrustSnapshot?: RuntimeReleaseTrustSnapshot): RuntimeBuildIdentity {
    const env = this.deps.runtimeEnv ?? process.env;
    const packagedAppDir = this.deps.releaseTrust ? this.trustedPackagedAppDir : this.resolvePackagedAppDir(env);
    const unresolvedIdentity = packagedAppDir
      ? (this.trustedPackagedIdentity ?? resolvePackagedBuildIdentity(packagedAppDir))
      : this.resolveSourceBuildIdentity(env);
    const releaseTrust = packagedAppDir ? releaseTrustSnapshot : undefined;
    const identity =
      unresolvedIdentity.kind === "packaged"
        ? {
            ...unresolvedIdentity,
            integrity:
              releaseTrust?.payload.status === "verified" && hasCompleteVerifiedPayload(releaseTrust)
                ? ("clean" as const)
                : releaseTrust?.payload.status === "mismatch"
                  ? ("modified" as const)
                  : ("unknown" as const),
          }
        : unresolvedIdentity;
    const releaseEvidence = releaseTrust ? undefined : resolveReleaseEvidence(this.deps.rootDir, packagedAppDir);
    const cacheKey = releaseTrust
      ? [
          identity.kind,
          identity.version,
          identity.buildSha ?? "",
          identity.integrity,
          releaseTrust.revision,
          releaseTrust.certificate.status,
          releaseTrust.payload.status,
        ].join("|")
      : buildReleaseIdentityCacheKey(identity, releaseEvidence);
    let release = cacheKey && this.releaseIdentityCache?.key === cacheKey ? this.releaseIdentityCache.value : undefined;
    if (!release) {
      release = evaluateReleaseIdentity(identity, releaseEvidence, releaseTrust);
      this.releaseIdentityCache = cacheKey ? { key: cacheKey, value: release } : undefined;
    }
    return {
      ...identity,
      release,
    };
  }

  private listReviewTasks(): TaskRecord[] {
    return this.deps.taskLifecycleService
      .listTasks(500, undefined, undefined, "all")
      .filter((task) => task.createdBy === "review-readiness" || Boolean(extractReviewKey(task)));
  }

  private resolveLane(lane: string, command: string): ReviewReadinessLane {
    const artifact = findLatestVerificationArtifact(this.deps.rootDir, lane);
    if (!artifact) {
      return { lane, status: "missing", rerunHint: command };
    }
    const ageMs = Date.now() - artifact.modifiedAt.getTime();
    return {
      lane,
      status: ageMs > CURRENT_PROOF_MAX_AGE_MS ? "stale" : "current",
      artifactRef: path.relative(this.deps.rootDir, artifact.path),
      lastRunAt: artifact.modifiedAt.toISOString(),
      rerunHint: command,
    };
  }

  private readReleaseProofSummary(
    releaseTrust?: RuntimeReleaseTrustSnapshot,
  ): ReviewReadinessSummary["releaseProof"] | undefined {
    let certificate: Readonly<Record<string, unknown>> | undefined;
    try {
      if (this.deps.releaseTrust) {
        if (
          !this.trustedPackagedAppDir ||
          releaseTrust?.certificate.status !== "verified" ||
          !releaseTrust.authenticatedCertificate
        ) {
          return undefined;
        }
        certificate = releaseTrust.authenticatedCertificate;
      } else {
        const env = this.deps.runtimeEnv ?? process.env;
        const releaseEvidence = resolveReleaseEvidence(this.deps.rootDir, this.resolvePackagedAppDir(env));
        if (!releaseEvidence || hasInvalidReleaseEvidenceBoundary(releaseEvidence)) {
          return undefined;
        }
        certificate = readBoundedJsonRecord(releaseEvidence.certificatePath);
        if (!certificate || hasInvalidReleaseEvidenceBoundary(releaseEvidence)) {
          return undefined;
        }
      }
      const artifacts = Array.isArray(certificate.releaseAssets) ? certificate.releaseAssets : [];
      const requiredLanes = Array.isArray(certificate.requiredLanes) ? certificate.requiredLanes : [];
      const acceptedCaveats = Array.isArray(certificate.acceptedFailures)
        ? certificate.acceptedFailures.slice(0, 8).map((item) => sanitizeOperatorText(item, 240))
        : [];
      const exactShaStatus = summarizeReleaseExactShaStatus(requiredLanes, readString(certificate.commit));
      const sourceWorkflowName = readString(
        isRecord(certificate.releaseWorkflow) ? certificate.releaseWorkflow.name : undefined,
      );
      return {
        sourceCertificate: "release-certificate.json",
        exactShaStatus,
        artifacts: artifacts.slice(0, MAX_CERTIFICATE_ITEMS).map((artifact) => {
          const record = isRecord(artifact) ? artifact : {};
          const name =
            readString(record.name) ??
            readString(record.fileName) ??
            readString(record.relativePath) ??
            readString(record.path) ??
            "unknown";
          return {
            name: sanitizeArtifactName(name),
            platformArch: inferReleasePlatformArch(name),
            signatureStatus: inferReleaseSignatureStatus(record),
            sha256: sanitizeHash(
              readString(record.sha256) ?? readString(record.digestSha256) ?? readString(record.hash),
            ),
            sizeBytes: readNumber(record.sizeBytes) ?? readNumber(record.size) ?? 0,
            sourceWorkflow: sanitizeOperatorText(sourceWorkflowName ?? "unknown", 120),
            exactShaStatus,
            certificateInclusion: "included",
            acceptedCaveats,
          };
        }),
      };
    } catch {
      return undefined;
    }
  }

  private resolveSourceBuildIdentity(
    env: Readonly<Record<string, string | undefined>>,
  ): Omit<RuntimeBuildIdentity, "release"> {
    const buildSha = normalizeGitSha(this.git(["rev-parse", "HEAD"], this.deps.rootDir));
    const status = this.git(["status", "--porcelain"], this.deps.rootDir);
    const integrity = status === undefined ? "unknown" : status.length > 0 ? "modified" : "clean";
    return {
      schemaVersion: 1,
      kind: env.NODE_ENV === "development" || env.GOATCITADEL_DEV === "1" ? "development" : "source",
      version: readPackageVersion(this.deps.rootDir),
      buildSha,
      shortSha: buildSha?.slice(0, 8),
      integrity,
      identitySource: buildSha ? "git_checkout" : "unavailable",
    };
  }

  private resolvePackagedAppDir(
    env: Readonly<Record<string, string | undefined>>,
    explicitOnly = false,
  ): string | undefined {
    const cwd = path.resolve(this.deps.runtimeCwd ?? process.cwd());
    const candidates = explicitOnly
      ? [this.deps.runtimeAppDir]
      : [
          this.deps.runtimeAppDir,
          env.GOATCITADEL_APP_DIR,
          cwd,
          path.dirname(cwd),
          path.dirname(path.dirname(cwd)),
          this.deps.rootDir,
        ];
    for (const candidate of candidates) {
      if (!candidate?.trim()) {
        continue;
      }
      const resolved = path.resolve(candidate);
      if (isRegularFile(path.join(resolved, "release-manifest.json"))) {
        return resolved;
      }
    }
    return undefined;
  }

  private git(args: string[], cwd = this.deps.rootDir): string | undefined {
    if (this.deps.gitRunner) {
      const result = this.deps.gitRunner(args, cwd);
      return result === undefined ? undefined : result.trim();
    }
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }
}

function resolvePackagedBuildIdentity(appDir: string): Omit<RuntimeBuildIdentity, "release"> {
  const manifest = readBoundedJsonRecord(path.join(appDir, "release-manifest.json"));
  if (!manifest || (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2)) {
    return {
      schemaVersion: 1,
      kind: "packaged",
      version: "unknown",
      integrity: "unknown",
      identitySource: "unavailable",
    };
  }
  const source = isRecord(manifest.source) ? manifest.source : {};
  const buildSha = normalizeGitSha(readString(manifest.sourceCommit) ?? readString(source.commit));
  const modified =
    typeof manifest.sourceModified === "boolean"
      ? manifest.sourceModified
      : typeof source.modified === "boolean"
        ? source.modified
        : undefined;
  return {
    schemaVersion: 1,
    kind: "packaged",
    version: sanitizeVersion(manifest.version),
    buildSha,
    shortSha: buildSha?.slice(0, 8),
    integrity: modified === true ? "modified" : modified === false ? "clean" : "unknown",
    identitySource: "packaged_manifest",
  };
}

function evaluateReleaseIdentity(
  identity: Omit<RuntimeBuildIdentity, "release">,
  evidence: ReleaseEvidenceLocation | undefined,
  releaseTrust?: RuntimeReleaseTrustSnapshot,
): RuntimeBuildIdentity["release"] {
  const emptyProof = { total: 0, passed: 0, missing: 0, failed: 0, stale: 0 };
  if (releaseTrust && !releaseTrust.authenticatedCertificate) {
    const reasonCodes = [releaseAttestationReasonCode(releaseTrust), releasePayloadReasonCode(releaseTrust)].filter(
      (code): code is ReleaseIdentityReasonCode => Boolean(code),
    );
    if (!identity.buildSha) reasonCodes.push("identity_sha_unavailable");
    if (identity.integrity === "unknown") reasonCodes.push("identity_integrity_unavailable");
    if (identity.integrity === "modified") reasonCodes.push("source_modified");
    return buildReleaseIdentityResult(
      releaseTrust.certificate.status === "missing" ? "absent" : "parsed",
      emptyProof,
      reasonCodes,
      { releaseTrust },
    );
  }
  if (!evidence) {
    if (!releaseTrust?.authenticatedCertificate) {
      return buildReleaseIdentityResult("absent", emptyProof, ["certificate_absent"]);
    }
  }
  const certificate =
    releaseTrust?.certificate.status === "verified" && releaseTrust.authenticatedCertificate
      ? releaseTrust.authenticatedCertificate
      : evidence
        ? readBoundedJsonRecord(evidence.certificatePath)
        : undefined;
  if (!certificate || !isValidCertificateShape(certificate)) {
    return buildReleaseIdentityResult("malformed", emptyProof, ["certificate_malformed"]);
  }

  const certificateCommit = normalizeGitSha(readString(certificate.commit));
  const certificateVersion = sanitizeVersion(certificate.version);
  const generatedAt = readValidIsoTimestamp(certificate.generatedAt);
  const acceptedFailures = (certificate.acceptedFailures as unknown[])
    .slice(0, 8)
    .map((item) => sanitizeOperatorText(item, 240));
  const acceptedFailureCount = (certificate.acceptedFailures as unknown[]).length;
  const proof = summarizeRequiredProof(certificate.requiredLanes as unknown[], certificateCommit);
  const reasonCodes: ReleaseIdentityReasonCode[] = [];
  if (releaseTrust) {
    const attestationReason = releaseAttestationReasonCode(releaseTrust);
    const payloadReason = releasePayloadReasonCode(releaseTrust);
    if (attestationReason) reasonCodes.push(attestationReason);
    if (payloadReason) reasonCodes.push(payloadReason);
  } else {
    // Legacy/source-mode compatibility only: without a runtime trust reader,
    // filesystem evidence can be inventoried but cannot establish publisher
    // attestation or installed-payload integrity.
    const attestationState = evidence ? classifyReleaseCertificateAttestation(evidence) : "missing";
    reasonCodes.push(
      attestationState === "missing" ? "certificate_attestation_missing" : "certificate_attestation_invalid",
      "runtime_payload_integrity_unverified",
    );
  }

  if (evidence && (evidence.boundaryInvalid || hasInvalidReleaseEvidenceBoundary(evidence))) {
    reasonCodes.push("release_evidence_path_invalid");
  }

  if (!identity.buildSha) {
    reasonCodes.push("identity_sha_unavailable");
  }
  if (identity.integrity === "unknown") {
    reasonCodes.push("identity_integrity_unavailable");
  }
  if (identity.integrity === "modified") {
    reasonCodes.push("source_modified");
  }
  if (!certificateCommit || !identity.buildSha || certificateCommit !== identity.buildSha) {
    reasonCodes.push("certificate_sha_mismatch");
  }
  if (!versionsMatch(identity.version, certificateVersion)) {
    reasonCodes.push("certificate_version_mismatch");
  }
  if (!generatedAt) {
    reasonCodes.push("certificate_timestamp_invalid");
  }
  if (acceptedFailures.length > 0) {
    reasonCodes.push("accepted_failures_present");
  }
  if (proof.missing > 0 || proof.total === 0) {
    reasonCodes.push("required_proof_missing");
  }
  if (proof.failed > 0) {
    reasonCodes.push("required_proof_failed");
  }
  if (proof.stale > 0) {
    reasonCodes.push("required_proof_stale");
  }
  const releaseAssetsValid = hasValidReleaseAssets(certificate.releaseAssets);
  if (!releaseAssetsValid) {
    reasonCodes.push(
      Array.isArray(certificate.releaseAssets) && certificate.releaseAssets.length > 0
        ? "release_assets_invalid"
        : "release_assets_missing",
    );
  }
  const proofBundleValid = hasValidProofBundle(certificate.proofBundle);
  if (!proofBundleValid) {
    reasonCodes.push("proof_bundle_missing");
  }
  const authenticatedPackagedMetadata = Boolean(releaseTrust?.certificate.status === "verified");
  if (releaseAssetsValid && evidence && !authenticatedPackagedMetadata) {
    const assetEvidence = verifyEvidenceRecords(
      certificate.releaseAssets as unknown[],
      evidence.releaseAssetsRoot,
      evidence.trustedRoot,
    );
    if (assetEvidence.invalidPath) {
      reasonCodes.push("release_evidence_path_invalid");
    }
    if (assetEvidence.missing) {
      reasonCodes.push("release_asset_evidence_missing");
    }
    if (assetEvidence.mismatch) {
      reasonCodes.push("release_asset_evidence_mismatch");
    }
  }
  if (proofBundleValid && evidence && !authenticatedPackagedMetadata) {
    const proofEvidence = verifyEvidenceRecords(
      [certificate.proofBundle],
      evidence.proofBundleRoot,
      evidence.trustedRoot,
    );
    if (proofEvidence.invalidPath) {
      reasonCodes.push("release_evidence_path_invalid");
    }
    if (proofEvidence.missing) {
      reasonCodes.push("proof_bundle_evidence_missing");
    }
    if (proofEvidence.mismatch) {
      reasonCodes.push("proof_bundle_evidence_mismatch");
    }
  }
  if (!hasValidExactShaSummary(certificate.exactShaStatus, certificateCommit)) {
    reasonCodes.push("certificate_exact_sha_invalid");
  }
  if (evidence && hasInvalidReleaseEvidenceBoundary(evidence)) {
    reasonCodes.push("release_evidence_path_invalid");
  }

  return buildReleaseIdentityResult("parsed", proof, uniqueReasonCodes(reasonCodes), {
    certificateCommit,
    certificateVersion,
    generatedAt,
    acceptedFailures,
    acceptedFailureCount,
    releaseTrust,
  });
}

function isValidCertificateShape(certificate: Record<string, unknown>): boolean {
  if (
    (certificate.schemaVersion !== 1 && certificate.schemaVersion !== 2) ||
    certificate.product !== "GoatCitadel" ||
    !normalizeGitSha(readString(certificate.commit)) ||
    sanitizeVersion(certificate.version) === "unknown" ||
    !Array.isArray(certificate.requiredLanes) ||
    certificate.requiredLanes.length === 0 ||
    certificate.requiredLanes.length > MAX_CERTIFICATE_ITEMS ||
    !Array.isArray(certificate.acceptedFailures) ||
    certificate.acceptedFailures.length > 64 ||
    certificate.acceptedFailures.some((item) => typeof item !== "string")
  ) {
    return false;
  }
  return certificate.requiredLanes.every((lane) => {
    if (!isRecord(lane)) {
      return false;
    }
    const name = readString(lane.name);
    return Boolean(name && name.length <= 120 && typeof lane.status === "string");
  });
}

function summarizeRequiredProof(
  requiredLanes: unknown[],
  certificateCommit: string | undefined,
): RuntimeBuildIdentity["release"]["requiredProof"] {
  const lanesByName = new Map<string, Record<string, unknown>[]>();
  for (const lane of requiredLanes) {
    if (!isRecord(lane)) {
      continue;
    }
    const name = readString(lane.name);
    if (!name) {
      continue;
    }
    const matches = lanesByName.get(name) ?? [];
    matches.push(lane);
    lanesByName.set(name, matches);
  }
  const summary = {
    total: REQUIRED_RELEASE_PROOF_LANE_NAMES.length,
    passed: 0,
    missing: 0,
    failed: 0,
    stale: 0,
  };
  for (const laneName of REQUIRED_RELEASE_PROOF_LANE_NAMES) {
    const matches = lanesByName.get(laneName) ?? [];
    if (matches.length !== 1) {
      summary.missing += 1;
      continue;
    }
    const lane = matches[0]!;
    if (lane.required !== true) {
      summary.missing += 1;
      continue;
    }
    if (lane.status !== "success") {
      summary.failed += 1;
      continue;
    }
    const substituted = lane.substitutedByReleaseProof === true;
    const directRun = isRecord(lane.directRun) ? lane.directRun : undefined;
    const directSha = normalizeGitSha(
      directRun ? (readString(directRun.headSha) ?? readString(directRun.head_sha)) : undefined,
    );
    if (substituted && (DIRECT_ONLY_RELEASE_PROOF_LANES.has(laneName) || directSha === certificateCommit)) {
      summary.failed += 1;
      continue;
    }
    const proofRun = substituted ? lane.releaseProofRun : lane.directRun;
    if (!isRecord(proofRun)) {
      summary.missing += 1;
      continue;
    }
    if (proofRun.status !== "success" || proofRun.conclusion !== "success") {
      summary.failed += 1;
      continue;
    }
    const proofSha = normalizeGitSha(readString(proofRun.headSha) ?? readString(proofRun.head_sha));
    if (!proofSha) {
      summary.missing += 1;
      continue;
    }
    if (!certificateCommit || proofSha !== certificateCommit) {
      summary.stale += 1;
      continue;
    }
    summary.passed += 1;
  }
  return summary;
}

function hasValidExactShaSummary(value: unknown, certificateCommit: string | undefined): boolean {
  if (!isRecord(value) || value.status !== "matched" || !certificateCommit) {
    return false;
  }
  return normalizeGitSha(readString(value.targetCommit)) === certificateCommit;
}

function hasValidReleaseAssets(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CERTIFICATE_ITEMS) {
    return false;
  }
  return value.every((asset) => {
    if (!isRecord(asset)) {
      return false;
    }
    const name = readString(asset.name) ?? readString(asset.fileName) ?? readString(asset.relativePath);
    const sha = readString(asset.sha256) ?? readString(asset.digestSha256) ?? readString(asset.hash);
    const size = readNumber(asset.sizeBytes) ?? readNumber(asset.size);
    return Boolean(name && name.length <= 240 && sha && SHA256.test(sha) && size && size > 0);
  });
}

function hasValidProofBundle(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const name = readString(value.relativePath) ?? readString(value.name) ?? readString(value.fileName);
  const sha = readString(value.sha256) ?? readString(value.digestSha256) ?? readString(value.hash);
  const size = readNumber(value.sizeBytes) ?? readNumber(value.size);
  return Boolean(name && name.length <= 240 && sha && SHA256.test(sha) && size && size > 0);
}

function buildReleaseIdentityResult(
  certificateState: RuntimeBuildIdentity["release"]["certificateState"],
  requiredProof: RuntimeBuildIdentity["release"]["requiredProof"],
  reasonCodes: ReleaseIdentityReasonCode[],
  details: {
    certificateCommit?: string;
    certificateVersion?: string;
    generatedAt?: string;
    acceptedFailures?: string[];
    acceptedFailureCount?: number;
    releaseTrust?: RuntimeReleaseTrustSnapshot;
  } = {},
): RuntimeBuildIdentity["release"] {
  const uniqueCodes = uniqueReasonCodes(reasonCodes);
  return {
    verified: certificateState === "parsed" && uniqueCodes.length === 0,
    certificateState,
    certificateCommit: details.certificateCommit,
    certificateVersion: details.certificateVersion,
    generatedAt: details.generatedAt,
    requiredProof,
    acceptedFailureCount: details.acceptedFailureCount ?? details.acceptedFailures?.length ?? 0,
    acceptedFailures: details.acceptedFailures ?? [],
    certificateAttestation: {
      status: details.releaseTrust?.certificate.status ?? "not_applicable",
      verifiedAt: details.releaseTrust?.certificate.status === "verified" ? details.releaseTrust.verifiedAt : undefined,
      issuer: details.releaseTrust?.certificate.issuer,
      identity: details.releaseTrust?.certificate.identity,
    },
    runtimePayloadIntegrity: {
      status: details.releaseTrust?.payload.status ?? "not_applicable",
      verifiedAt: details.releaseTrust?.payload.status === "verified" ? details.releaseTrust.verifiedAt : undefined,
      target: details.releaseTrust?.payload.target,
      manifestSha256: details.releaseTrust?.payload.manifestSha256,
      fileCount: details.releaseTrust?.payload.fileCount,
      totalBytes: details.releaseTrust?.payload.totalBytes,
    },
    reasonCodes: uniqueCodes,
    reasons: uniqueCodes.map(describeReleaseIdentityReason),
  };
}

function uniqueReasonCodes(reasonCodes: ReleaseIdentityReasonCode[]): ReleaseIdentityReasonCode[] {
  return [...new Set(reasonCodes)];
}

function versionsMatch(runningVersion: string, certificateVersion: string): boolean {
  if (runningVersion === "unknown" || certificateVersion === "unknown") {
    return false;
  }
  return runningVersion.replace(/^v/i, "") === certificateVersion.replace(/^v/i, "");
}

function readPackageVersion(rootDir: string): string {
  return sanitizeVersion(readBoundedJsonRecord(path.join(rootDir, "package.json"))?.version);
}

function sanitizeVersion(value: unknown): string {
  const version = readString(value);
  return version && version.length <= 64 && /^[a-z0-9.+-]+$/i.test(version) ? version : "unknown";
}

function normalizeGitSha(value: string | undefined): string | undefined {
  return value && FULL_GIT_SHA.test(value) ? value.toLowerCase() : undefined;
}

function readValidIsoTimestamp(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw || raw.length > 64 || !Number.isFinite(Date.parse(raw))) {
    return undefined;
  }
  return raw;
}

function sanitizeOperatorText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const redacted = redactStructuredSecrets(text).value;
  return (
    String(redacted)
      .replace(/\b[A-Za-z]:[\\/][^\s,;]+/g, "[path]")
      .replace(/\/(?:home|Users|var|tmp|opt|root)\/[^\s,;]+/g, "[path]")
      // Certificate text is untrusted operator display input; strip C0/DEL.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength)
  );
}

function sanitizeArtifactName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).pop() ?? "unknown";
  return sanitizeOperatorText(name, 160) || "unknown";
}

function sanitizeHash(value: string | undefined): string {
  return value && SHA256.test(value) ? value.toLowerCase() : "missing";
}

function readBoundedJsonRecord(filePath: string): Record<string, unknown> | undefined {
  let handle: number | undefined;
  try {
    const beforePathStats = fs.lstatSync(filePath);
    if (
      !beforePathStats.isFile() ||
      beforePathStats.isSymbolicLink() ||
      beforePathStats.size <= 0 ||
      beforePathStats.size > MAX_JSON_BYTES
    ) {
      return undefined;
    }
    handle = fs.openSync(filePath, fs.constants.O_RDONLY | readNoFollowFlag());
    const openedStats = fs.fstatSync(handle);
    const currentPathStats = fs.lstatSync(filePath);
    if (
      !openedStats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      !sameFileIdentity(beforePathStats, openedStats) ||
      !sameFileIdentity(openedStats, currentPathStats)
    ) {
      return undefined;
    }
    const raw = fs.readFileSync(handle, "utf8");
    const finalOpenedStats = fs.fstatSync(handle);
    const finalPathStats = fs.lstatSync(filePath);
    if (
      finalPathStats.isSymbolicLink() ||
      !finalPathStats.isFile() ||
      !sameFileIdentity(openedStats, finalOpenedStats) ||
      !sameFileIdentity(finalOpenedStats, finalPathStats)
    ) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readNoFollowFlag(): number {
  return (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function isRegularFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizeFinding(input: ReviewFindingInput): ReviewFindingInput | undefined {
  const title = input.title.trim();
  const source = input.source.trim();
  const component = input.component.trim();
  const files = input.files
    .map((file) => file.trim())
    .filter(Boolean)
    .sort();
  if (!title || !source || !component || files.length === 0) {
    return undefined;
  }
  return {
    ...input,
    title,
    source,
    component,
    files,
    summary: input.summary?.trim() || undefined,
    evidenceRef: input.evidenceRef?.trim() || undefined,
  };
}

function buildFindingKey(finding: ReviewFindingInput): string {
  return [finding.source, finding.component, finding.files.join(","), finding.title].join("::").toLowerCase();
}

function renderFindingDescription(key: string, finding: ReviewFindingInput): string {
  return [
    `${REVIEW_FINDING_PREFIX} ${key}`,
    "",
    finding.summary?.trim() || "Imported review finding awaiting triage.",
    "",
    `Source: ${finding.source}`,
    `Component: ${finding.component}`,
    `Files: ${finding.files.join(", ")}`,
    finding.evidenceRef ? `Evidence: ${finding.evidenceRef}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractReviewKey(task: TaskRecord): string | undefined {
  const line = task.description?.split(/\r?\n/).find((entry) => entry.startsWith(REVIEW_FINDING_PREFIX));
  return line?.slice(REVIEW_FINDING_PREFIX.length).trim();
}

function appendEvidenceDeliverable(
  taskLifecycleService: ReviewReadinessServiceDependencies["taskLifecycleService"],
  taskId: string,
  finding: ReviewFindingInput,
): void {
  if (!finding.evidenceRef) {
    return;
  }
  taskLifecycleService.appendTaskDeliverable(taskId, {
    deliverableType: finding.evidenceRef.startsWith("http") ? "url" : "artifact",
    title: "Review evidence",
    path: finding.evidenceRef,
    description: `Evidence for ${finding.source} review finding.`,
  });
}

function findLatestVerificationArtifact(rootDir: string, lane: string): { path: string; modifiedAt: Date } | undefined {
  const verificationDir = path.join(rootDir, "artifacts", "verification");
  if (!fs.existsSync(verificationDir)) {
    return undefined;
  }
  const entries = fs
    .readdirSync(verificationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const artifactPath = path.join(verificationDir, entry.name);
      return { path: artifactPath, modifiedAt: fs.statSync(artifactPath).mtime };
    })
    .filter((entry) => artifactMatchesLane(entry.path, lane))
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return entries[0];
}

function artifactMatchesLane(artifactPath: string, lane: string): boolean {
  if (path.basename(artifactPath).includes(lane)) {
    return true;
  }
  const manifestPath = path.join(artifactPath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return false;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      lane?: string;
      scenarios?: Array<{ id?: string; title?: string; subsystem?: string; status?: string }>;
    };
    if (manifest.lane === lane) {
      return true;
    }
    return (manifest.scenarios ?? []).some((scenario) => {
      const haystack = `${scenario.id ?? ""} ${scenario.title ?? ""} ${scenario.subsystem ?? ""}`.toLowerCase();
      return scenario.status === "passed" && haystack.includes(lane.toLowerCase());
    });
  } catch {
    return false;
  }
}

function summarizeReleaseExactShaStatus(requiredLanes: unknown[], commit: string | undefined) {
  if (!commit) {
    return "unknown";
  }
  if (!requiredLanes.length) {
    return "unknown";
  }
  const matching = requiredLanes.filter((lane) => {
    if (!isRecord(lane)) {
      return false;
    }
    const directRun = isRecord(lane.directRun) ? lane.directRun : {};
    const releaseProofRun = isRecord(lane.releaseProofRun) ? lane.releaseProofRun : {};
    return (
      readString(directRun.headSha) === commit ||
      readString(directRun.head_sha) === commit ||
      readString(releaseProofRun.headSha) === commit ||
      readString(releaseProofRun.head_sha) === commit
    );
  }).length;
  return matching === requiredLanes.length ? "exact" : matching > 0 ? "partial" : "missing";
}

function inferReleaseSignatureStatus(record: Record<string, unknown>): "experimental" | "unverified" {
  // The release certificate and installed runtime payload now have their own
  // authenticated trust path. Individual release-asset signature fields and
  // .sig/.pem filenames remain inventory only and are not independently
  // verified by this readiness projection.
  const name = readString(record.name) ?? readString(record.fileName) ?? readString(record.relativePath) ?? "";
  return /experimental|preview/i.test(name) ? "experimental" : "unverified";
}

function inferReleasePlatformArch(name: string): string {
  const lower = name.toLowerCase();
  const platform = lower.includes("win")
    ? "windows"
    : lower.includes("mac") || lower.includes("darwin") || lower.endsWith(".dmg")
      ? "macos"
      : lower.includes("linux") || lower.endsWith(".tar.gz")
        ? "linux"
        : "unknown";
  const arch =
    lower.includes("arm64") || lower.includes("aarch64")
      ? "arm64"
      : lower.includes("x64") || lower.includes("amd64")
        ? "x64"
        : "unknown";
  return `${platform}/${arch}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
