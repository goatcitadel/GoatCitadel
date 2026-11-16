import { createSkillHubLifecycleFilesystem } from "./skill-hub-lifecycle-filesystem-composition.js";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
  SKILL_HUB_LIFECYCLE_EVIDENCE_EVENT_KIND,
  SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE,
  SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND,
  SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND,
  SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
  ConflictError,
  canonicalJsonString,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type CandidateSkillVersionRecord,
  type CapabilityArtifactRecord,
  type SkillHubOperationIntentPreview,
  type SkillHubOperationIntentRecord,
  type SkillHubOperationIntentTemplate,
  type SkillHubOperationSettlementDisposition,
  type SkillHubOperationSettlementRecord,
  type SkillHubSnapshotArtifactRecord,
} from "@goatcitadel/contracts";
import {
  computeSkillHubOperationRequestSha256,
  computeSkillHubOperationResultSha256,
  type AsyncStorage as Storage,
  type SkillHubSnapshotRecord,
} from "@goatcitadel/storage";
import { parseSkillMarkdown } from "@goatcitadel/skills";
import { CapabilityPluginStore } from "./capability-plugin-store.js";
import { pluginSkillSource } from "./plugin-owned-refusal.js";
import { takesPowerAway } from "./skill-hub-operation-power.js";
import { SKILL_STATE_METADATA_SETTING_KEY } from "./skill-state-keys.js";
import {
  withoutSkillMetadata,
  ownedSkillBlock,
  finishAppliedProjection,
  LINEAGE_VERSION_LIMIT,
  projectionCleanupFailureEvent,
  projectionScratch,
  runNeverActivatedRemoval,
  runRuntimeRemoval,
  UNKNOWN_TREE_SHA256,
} from "./skill-hub-runtime-removal.js";
import { readSkillHubOperationFingerprint } from "./skill-hub-operation-identity.js";
import {
  asOptionalNumber,
  assertRevisionExpectation,
  assertSkillIdentity,
  asOptionalString,
  hasCurrentPromptwareAudit,
  isRecord,
  removeUndefined,
  resolveManagedRoot,
  sha256,
  toRootRelative,
} from "./skill-hub-lifecycle-values.js";
import { SkillHubArtifactStore, type SkillHubArtifactFilesystem } from "./skill-hub-artifact-store.js";
import {
  PROMPTWARE_SCANNER_ID,
  PROMPTWARE_MAX_FINDINGS,
  PROMPTWARE_SCANNER_VERSION,
  scanPromptwareContent,
} from "./assembled-prompt-injection-guard.js";
import {
  SkillHubLifecycleFilesystem,
  type SkillHubLifecycleFilesystemMutation,
} from "./skill-hub-lifecycle-filesystem.js";

export interface SkillHubLifecycleApplyResult {
  settlement: SkillHubOperationSettlementRecord;
  replayed: boolean;
}

export interface SkillHubLifecycleServiceOptions {
  rootDir: string;
  candidateRoot: string;
  skillsExtraRoot: string;
  artifactStore: SkillHubArtifactStore;
  storage: Pick<
    Storage,
    | "approvals"
    | "skillHubSnapshots"
    | "skillHubArtifacts"
    | "skillHubOperations"
    | "candidateSkillVersions"
    | "skillLifecycle"
    | "skillAggregateRevisions"
    | "evidenceEnvelopes"
    | "governanceJourneyEvents"
    | "systemSettings"
    | "runImmediateTransaction"
  >;
  reloadSkills?: () => Promise<unknown>;
  now?: () => string;
  /** Filesystem port for runtime projection; defaults to the Node implementation. */
  filesystem?: SkillHubArtifactFilesystem;
  /** Test-only crash seam after filesystem projection and before canonical DB mutation. */
  afterRuntimeProjection?: (operationId: string) => Promise<void> | void;
  /** Test-only race seam after filesystem identity capture and before mutation-time revalidation. */
  beforeFilesystemMutation?: (mutation: SkillHubLifecycleFilesystemMutation) => Promise<void> | void;
}

/** Build the exact approval payload and hash-bound immutable preview a future route can submit. */
export function buildSkillHubLifecycleApprovalInput(
  intent: SkillHubOperationIntentTemplate,
  pluginInstallPlanId?: string,
): ApprovalCreateInput {
  const requestSha256 = computeSkillHubOperationRequestSha256({ ...intent, approvalId: "approval:pending" });
  return {
    kind: SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
    riskLevel: "danger",
    payload: {
      operationId: intent.operationId,
      requestSha256,
      workspaceId: intent.workspaceId,
      operationKind: intent.operationKind,
      skillId: intent.skillId,
      snapshotId: intent.snapshotId,
      contentTreeSha256: intent.contentTreeSha256,
    },
    preview: {
      schemaVersion: SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
      intent,
      ...(pluginInstallPlanId === undefined ? {} : { pluginInstallPlanId }),
    } satisfies SkillHubOperationIntentPreview,
    linkage: {
      workspaceId: intent.workspaceId,
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      ...(intent.turnId ? { turnId: intent.turnId } : {}),
    },
  };
}

/** Reconstruct the exact immutable intent only after the canonical approval is approved. */
export function materializeApprovedSkillHubIntent(approval: ApprovalRequest): SkillHubOperationIntentRecord {
  if (approval.kind !== SKILL_HUB_LIFECYCLE_APPROVAL_KIND || approval.status !== "approved") {
    throw new ConflictError({ message: "Skill Hub lifecycle intent requires an approved dedicated approval." });
  }
  const preview = approval.preview as Partial<SkillHubOperationIntentPreview>;
  if (preview.schemaVersion !== SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA || !isRecord(preview.intent)) {
    throw new TypeError("Skill Hub lifecycle approval preview is missing its immutable intent.");
  }
  const intent = preview.intent as unknown as SkillHubOperationIntentTemplate;
  const requestSha256 = computeSkillHubOperationRequestSha256({ ...intent, approvalId: approval.approvalId });
  const expectedPayload = {
    operationId: intent.operationId,
    requestSha256,
    workspaceId: intent.workspaceId,
    operationKind: intent.operationKind,
    skillId: intent.skillId,
    snapshotId: intent.snapshotId,
    contentTreeSha256: intent.contentTreeSha256,
  };
  if (canonicalJsonString(approval.payload) !== canonicalJsonString(expectedPayload)) {
    throw new TypeError("Skill Hub lifecycle approval payload does not match its hash-bound preview.");
  }
  return { ...intent, approvalId: approval.approvalId, requestSha256 };
}

export class SkillHubLifecycleService {
  private readonly rootDir: string;
  private readonly candidateRoot: string;
  private readonly skillsExtraRoot: string;
  private readonly filesystem: SkillHubLifecycleFilesystem;
  private readonly plugins: CapabilityPluginStore;

  public constructor(private readonly options: SkillHubLifecycleServiceOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.candidateRoot = resolveManagedRoot(this.rootDir, options.candidateRoot, "candidate root");
    this.skillsExtraRoot = resolveManagedRoot(this.rootDir, options.skillsExtraRoot, "runtime skill root");
    this.filesystem = createSkillHubLifecycleFilesystem(this.rootDir, options);
    this.plugins = new CapabilityPluginStore(options.storage.systemSettings);
  }

  public async applyApprovedOperation(input: {
    operationId: string;
    approvalId: string;
    requestSha256: string;
    signal?: AbortSignal;
  }): Promise<SkillHubLifecycleApplyResult> {
    const storage = this.options.storage;
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const intent = await storage.skillHubOperations.getIntent(input.operationId);
    if (intent.approvalId !== input.approvalId || intent.requestSha256 !== input.requestSha256) {
      throw new ConflictError({ message: "Skill Hub lifecycle effect identity does not match its immutable intent." });
    }
    // Re-run parent validation against the exact current approval before any effect.
    await storage.skillHubOperations.createIntent(intent);
    const approval = await storage.approvals.get(intent.approvalId);
    if (approval.status !== "approved" || approval.kind !== SKILL_HUB_LIFECYCLE_APPROVAL_KIND) {
      throw new ConflictError({ message: "Skill Hub lifecycle approval is no longer executable." });
    }
    const replay = await storage.skillHubOperations.findSettlementByOperationId(input.operationId);
    if (replay) {
      await this.finishAppliedProjection(intent, replay, signal);
      return { settlement: replay, replayed: true };
    }

    const snapshot = await storage.skillHubSnapshots.get(intent.snapshotId);
    const artifact = await storage.skillHubArtifacts.findBySnapshot(intent.workspaceId, intent.snapshotId);
    if (
      !artifact ||
      snapshot.workspaceId !== intent.workspaceId ||
      snapshot.contentTreeSha256 !== intent.contentTreeSha256 ||
      artifact.contentTreeSha256 !== intent.contentTreeSha256
    ) {
      throw new ConflictError({
        message: "Skill Hub lifecycle snapshot/artifact scope or byte lineage does not match.",
      });
    }
    const pluginSource = takesPowerAway(intent.operationKind) ? undefined : pluginSkillSource(snapshot);
    const pluginInstallPlanId = (approval.preview as Partial<SkillHubOperationIntentPreview>).pluginInstallPlanId;
    if (pluginSource && (!pluginInstallPlanId || !readSkillHubOperationFingerprint(intent, pluginInstallPlanId))) {
      return await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
        code: "plugin_install_authority_missing",
        boundaryCrossed: false,
      });
    }
    if (!(await this.artifactStillVerifies(artifact.bundleRelPath, artifact.manifest))) {
      return await this.settle(intent, artifact.artifactId, "blocked", UNKNOWN_TREE_SHA256, {
        code: "artifact_tamper",
        boundaryCrossed: false,
      });
    }
    if (!takesPowerAway(intent.operationKind) && !hasCurrentPromptwareAudit(snapshot)) {
      return await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
        code: "promptware_policy_stale",
        blockerCodes: ["PROMPTWARE_POLICY_STALE"],
        scannerId: PROMPTWARE_SCANNER_ID,
        scannerVersion: PROMPTWARE_SCANNER_VERSION,
        boundaryCrossed: false,
      });
    }
    if (
      !takesPowerAway(intent.operationKind) &&
      (snapshot.trustDisposition !== "candidate" || snapshot.blockerCodes.length > 0)
    ) {
      return await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
        code: "snapshot_trust_blocked",
        blockerCodes: snapshot.blockerCodes,
        trustDisposition: snapshot.trustDisposition,
        boundaryCrossed: false,
      });
    }

    const bundlePath = this.options.artifactStore.resolveBundlePath(artifact.bundleRelPath);
    if (!takesPowerAway(intent.operationKind)) {
      const promptwareScan = await this.scanVerifiedArtifactPromptware(bundlePath, artifact, signal);
      if (promptwareScan.unscannedPaths.length > 0) {
        return await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
          code: "promptware_scan_incomplete",
          blockerCodes: ["PROMPTWARE_SCAN_INCOMPLETE"],
          scannerId: PROMPTWARE_SCANNER_ID,
          scannerVersion: PROMPTWARE_SCANNER_VERSION,
          sourcePaths: promptwareScan.unscannedPaths,
          boundaryCrossed: false,
        });
      }
      if (promptwareScan.findings.length > 0) {
        return await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
          code: "prompt_injection_detected",
          blockerCodes: ["PROMPT_INJECTION_DETECTED"],
          scannerId: PROMPTWARE_SCANNER_ID,
          scannerVersion: PROMPTWARE_SCANNER_VERSION,
          findings: promptwareScan.findings.map((finding) => ({
            ruleId: finding.ruleId,
            sourcePath: finding.sourcePath,
            evidenceHash: finding.evidenceHash,
          })),
          boundaryCrossed: false,
        });
      }
    }
    const skillEntry = artifact.manifest.files.find((file) => file.path === "SKILL.md");
    if (!skillEntry) throw new ConflictError({ message: "Skill Hub artifact is missing its SKILL.md entry." });
    const skillMarkdown = await this.filesystem.readVerifiedText({
      sourceRoot: bundlePath,
      sourcePath: path.join(bundlePath, "SKILL.md"),
      expectedBytes: skillEntry.bytes,
      expectedSha256: skillEntry.sha256,
      signal,
    });
    const parsed = parseSkillMarkdown(skillMarkdown);
    assertSkillIdentity(intent.skillId, parsed.frontmatter.name);
    try {
      await this.assertExpectedRevisions(intent);
    } catch (error) {
      if (!isConflict(error)) throw error;
      return await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
        code: "stale_aggregate_revision",
        boundaryCrossed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const mutate = () =>
      this.mutateVerifiedOperation(intent, snapshot, artifact, skillMarkdown, parsed.frontmatter.name, signal);
    const result =
      intent.operationKind === "remove"
        ? await this.plugins.withLock(
            (work) => this.runTransaction(work),
            async () => {
              // Under the plugin store's lock, so a plugin install or uninstall cannot change who owns the skill.
              const code = ownedSkillBlock(await this.plugins.list(), intent, parsed.frontmatter.name);
              return code
                ? await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
                    code,
                    boundaryCrossed: false,
                  })
                : await mutate();
            },
          )
        : pluginSource
          ? await this.plugins.withLock(
              (work) => this.runTransaction(work),
              async () => {
                const plugin = pluginSource.pluginId ? await this.plugins.get(pluginSource.pluginId) : undefined;
                if (
                  !plugin ||
                  plugin.installPlanId !== pluginInstallPlanId ||
                  plugin.workspaceId !== intent.workspaceId ||
                  (plugin.state !== "installing" && plugin.state !== "installed") ||
                  !plugin.pieces.some((piece) => piece.kind === "skill" && piece.skillSnapshotId === intent.snapshotId)
                ) {
                  return await this.settle(intent, artifact.artifactId, "blocked", intent.contentTreeSha256, {
                    code: "plugin_install_authority_changed",
                    boundaryCrossed: false,
                  });
                }
                return await mutate();
              },
            )
          : await mutate();
    await this.finishAppliedProjection(intent, result.settlement, signal);
    return result;
  }

  private async mutateVerifiedOperation(
    intent: SkillHubOperationIntentRecord,
    snapshot: SkillHubSnapshotRecord,
    artifact: SkillHubSnapshotArtifactRecord,
    skillMarkdown: string,
    skillName: string,
    signal: AbortSignal,
  ): Promise<SkillHubLifecycleApplyResult> {
    let candidate: CandidateSkillVersionRecord | undefined;
    let runtimeProjected = false;
    if (
      intent.operationKind === "install_inactive" ||
      intent.operationKind === "stage_update_candidate" ||
      intent.operationKind === "stage_rollback_candidate"
    ) {
      if (!(await this.artifactStillVerifies(artifact.bundleRelPath, artifact.manifest))) {
        return await this.settle(intent, artifact.artifactId, "blocked", UNKNOWN_TREE_SHA256, {
          code: "artifact_tamper",
          boundaryCrossed: false,
        });
      }
      candidate = await this.buildInactiveCandidate(intent, snapshot, artifact, skillMarkdown, signal);
    } else {
      candidate = await this.requireBoundCandidate(intent);
    }

    if (intent.operationKind === "remove") {
      return await this.removeRuntimeSkill(intent, candidate, artifact, skillName, signal);
    }

    if (intent.operationKind === "activate") {
      if (!(await this.artifactStillVerifies(artifact.bundleRelPath, artifact.manifest))) {
        return await this.settle(intent, artifact.artifactId, "blocked", UNKNOWN_TREE_SHA256, {
          code: "artifact_tamper",
          boundaryCrossed: false,
        });
      }
      try {
        const projection = await this.projectRuntimeSkill(intent, snapshot, artifact, skillName, signal);
        runtimeProjected = projection.boundaryCrossed;
      } catch (error) {
        if (!(error instanceof AmbiguousSkillRuntimeProjectionError)) throw error;
        return await this.settle(intent, artifact.artifactId, "manual_reconciliation", UNKNOWN_TREE_SHA256, {
          code: "ambiguous_runtime_projection",
          boundaryCrossed: true,
          error: error.message,
        });
      }
      await this.options.afterRuntimeProjection?.(intent.operationId);
      if (!(await this.artifactStillVerifies(artifact.bundleRelPath, artifact.manifest))) {
        return await this.settle(intent, artifact.artifactId, "manual_reconciliation", UNKNOWN_TREE_SHA256, {
          code: "post_projection_artifact_tamper",
          boundaryCrossed: true,
        });
      }
    } else {
      if (!(await this.artifactStillVerifies(artifact.bundleRelPath, artifact.manifest))) {
        return await this.settle(intent, artifact.artifactId, "blocked", UNKNOWN_TREE_SHA256, {
          code: "artifact_tamper",
          boundaryCrossed: false,
        });
      }
    }

    signal.throwIfAborted();
    try {
      return await this.applyCanonicalMutation(intent, candidate, artifact.artifactId, runtimeProjected);
    } catch (error) {
      if (runtimeProjected && isConflict(error)) {
        return await this.settle(intent, artifact.artifactId, "manual_reconciliation", intent.contentTreeSha256, {
          code: "runtime_projected_canonical_conflict",
          boundaryCrossed: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private runTransaction<T>(work: () => T | Promise<T>): Promise<Awaited<T>> {
    return this.options.storage.runImmediateTransaction(work);
  }

  private async assertExpectedRevisions(intent: SkillHubOperationIntentRecord): Promise<void> {
    const candidateRevision = await this.options.storage.skillAggregateRevisions.get(
      "candidate_skill",
      intent.targetCandidateId!,
    );
    const runtimeRevision = await this.options.storage.skillAggregateRevisions.get("runtime_skill", intent.skillId);
    if (intent.expectedRuntimeAbsent && (await this.options.storage.skillLifecycle.find(intent.skillId))) {
      throw new ConflictError({ message: "Skill Hub runtime lifecycle exists without its expected revision." });
    }
    assertRevisionExpectation(
      "candidate",
      candidateRevision?.revision,
      intent.expectedCandidateRevision,
      intent.expectedCandidateAbsent,
    );
    assertRevisionExpectation(
      "runtime",
      runtimeRevision?.revision,
      intent.expectedRuntimeRevision,
      intent.expectedRuntimeAbsent,
    );
  }

  private async requireBoundCandidate(intent: SkillHubOperationIntentRecord): Promise<CandidateSkillVersionRecord> {
    const candidate = await this.options.storage.candidateSkillVersions.get(intent.targetVersionId!);
    if (
      candidate.candidateId !== intent.targetCandidateId ||
      candidate.workspaceId !== intent.workspaceId ||
      candidate.upstreamSnapshotId !== intent.snapshotId ||
      candidate.sourceFingerprint !== intent.contentTreeSha256
    ) {
      throw new ConflictError({ message: "Skill Hub lifecycle candidate lineage does not match the approved intent." });
    }
    return candidate;
  }

  private async buildInactiveCandidate(
    intent: SkillHubOperationIntentRecord,
    snapshot: Awaited<ReturnType<Storage["skillHubSnapshots"]["get"]>>,
    artifact: Awaited<ReturnType<Storage["skillHubArtifacts"]["get"]>>,
    skillMarkdown: string,
    signal: AbortSignal,
  ): Promise<CandidateSkillVersionRecord> {
    const bundleToken = createHash("sha256").update(intent.targetVersionId!).digest("hex").slice(0, 24);
    const directory = path.join(this.candidateRoot, "skill-hub", intent.contentTreeSha256, bundleToken);
    const manifestContent = canonicalJsonString(artifact.manifest);
    const proofContent = canonicalJsonString({
      schemaVersion: "goatcitadel.skill-hub-candidate-proof.v1",
      snapshotId: snapshot.snapshotId,
      contentTreeSha256: snapshot.contentTreeSha256,
      auditSha256: snapshot.auditSha256,
      auditFloorSha256: snapshot.auditFloorSha256,
      permissionEnvelopeSha256: snapshot.permissionEnvelopeSha256,
      blockerCodes: snapshot.blockerCodes,
      trustDisposition: snapshot.trustDisposition,
    });
    await this.filesystem.writeImmutableFile(
      this.candidateRoot,
      path.join(directory, "manifest.json"),
      manifestContent,
      signal,
    );
    await this.filesystem.writeImmutableFile(
      this.candidateRoot,
      path.join(directory, "SKILL.md"),
      skillMarkdown,
      signal,
    );
    await this.filesystem.writeImmutableFile(
      this.candidateRoot,
      path.join(directory, "proof.json"),
      proofContent,
      signal,
    );
    const now = this.now();
    const artifactRecord = (name: string, content: string, mimeType: string): CapabilityArtifactRecord => ({
      artifactId: `skill-hub:${name}:${intent.targetVersionId}`,
      relPath: toRootRelative(this.rootDir, path.join(directory, name === "instruction" ? "SKILL.md" : `${name}.json`)),
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
      mimeType,
      createdAt: now,
    });
    return {
      candidateId: intent.targetCandidateId!,
      versionId: intent.targetVersionId!,
      sourceKind: "upstream_hub",
      lineageStatus: "governed",
      workspaceId: intent.workspaceId,
      sourceFingerprint: intent.contentTreeSha256,
      upstreamSnapshotId: intent.snapshotId,
      supersedesVersionId: intent.supersedesVersionId,
      createdByActorId: intent.actorId,
      title: intent.skillId.slice("extra:".length),
      summary: `Immutable inactive Skill Hub candidate from ${snapshot.sourceProvider}.`,
      bundleRoot: toRootRelative(this.rootDir, directory),
      lifecycleState: "candidate",
      manifestArtifact: artifactRecord("manifest", manifestContent, "application/json"),
      instructionArtifact: artifactRecord("instruction", skillMarkdown, "text/markdown"),
      proofArtifact: artifactRecord("proof", proofContent, "application/json"),
      createdAt: intent.createdAt,
      updatedAt: now,
    };
  }

  private async applyCanonicalMutation(
    intent: SkillHubOperationIntentRecord,
    candidate: CandidateSkillVersionRecord,
    artifactId: string,
    runtimeProjected: boolean,
    detail: Record<string, unknown> = {},
  ): Promise<SkillHubLifecycleApplyResult> {
    const storage = this.options.storage;
    return await this.runTransaction(async () => {
      const replay = await storage.skillHubOperations.findSettlementByOperationId(intent.operationId);
      if (replay) return { settlement: replay, replayed: true };
      const now = this.now();
      let candidateRevision: number | undefined;
      let runtimeRevision: number | undefined;

      if (intent.operationKind === "install_inactive") {
        const revision = await storage.skillAggregateRevisions.createInitialRevisionFence(
          "candidate_skill",
          intent.targetCandidateId!,
          now,
        );
        await storage.candidateSkillVersions.upsert(candidate);
        candidateRevision = revision.revision;
      } else {
        await this.fenceExisting(intent, now);
        if (intent.operationKind === "stage_update_candidate" || intent.operationKind === "stage_rollback_candidate") {
          await storage.candidateSkillVersions.upsert(candidate);
          candidateRevision = (
            await storage.skillAggregateRevisions.advanceExpectedRevision(
              "candidate_skill",
              intent.targetCandidateId!,
              intent.expectedCandidateRevision!,
              now,
            )
          ).revision;
          runtimeRevision = intent.expectedRuntimeRevision;
        } else if (intent.operationKind === "activate") {
          const current = await storage.candidateSkillVersions.get(intent.targetVersionId!);
          if (current.lifecycleState === "revoked") {
            throw new ConflictError({ message: "Revoked Skill Hub candidates cannot be activated." });
          }
          const candidateChanged = current.lifecycleState !== "approved";
          await storage.candidateSkillVersions.updateLifecycleState(intent.targetVersionId!, "approved", now);
          candidateRevision = candidateChanged
            ? (
                await storage.skillAggregateRevisions.advanceExpectedRevision(
                  "candidate_skill",
                  intent.targetCandidateId!,
                  intent.expectedCandidateRevision!,
                  now,
                )
              ).revision
            : intent.expectedCandidateRevision;
          const snapshotArtifact = await storage.skillHubArtifacts.findBySnapshot(
            intent.workspaceId,
            intent.snapshotId,
          );
          if (!snapshotArtifact) {
            throw new ConflictError({ message: "Skill Hub snapshot artifact is missing during activation." });
          }
          const lifecycle = {
            skillId: intent.skillId,
            category: "community_imported" as const,
            lifecycleState: "approved" as const,
            trustLabel: "Approved upstream snapshot",
            provenance: {
              source: "extra",
              sourceRef: intent.snapshotId,
              contentIntegrity: {
                manifestVersion: "goatcitadel.skill-tree.v1" as const,
                treeSha256: intent.contentTreeSha256,
                fileCount: snapshotArtifact.fileCount,
                totalBytes: snapshotArtifact.totalBytes,
                verified: true,
              },
            },
            createdAt: (await storage.skillLifecycle.find(intent.skillId))?.createdAt ?? now,
            updatedAt: now,
          };
          if (intent.expectedRuntimeAbsent) {
            const runtimeFence = await storage.skillAggregateRevisions.createInitialRevisionFence(
              "runtime_skill",
              intent.skillId,
              now,
            );
            await storage.skillLifecycle.upsert(lifecycle);
            runtimeRevision = runtimeFence.revision;
          } else {
            await storage.skillLifecycle.upsert(lifecycle);
            runtimeRevision = (
              await storage.skillAggregateRevisions.advanceExpectedRevision(
                "runtime_skill",
                intent.skillId,
                intent.expectedRuntimeRevision!,
                now,
              )
            ).revision;
          }
        } else if (intent.operationKind === "remove") {
          // The candidate lineage is history: fenced above, never advanced. The record, its fence and saved state go.
          // A lineage never switched on has no record or fence: the settlement alone marks it removed.
          candidateRevision = intent.expectedCandidateRevision;
          if (intent.expectedRuntimeAbsent) {
            if (await storage.skillLifecycle.find(intent.skillId)) {
              throw new ConflictError({ message: "Skill Hub runtime record appeared before the removal committed." });
            }
          } else if (!(await storage.skillLifecycle.delete(intent.skillId))) {
            throw new ConflictError({ message: "Skill Hub runtime record is already gone." });
          } else {
            await storage.skillAggregateRevisions.deleteFence(
              "runtime_skill",
              intent.skillId,
              intent.expectedRuntimeRevision!,
            );
          }
          // Its saved state goes too (`withoutSkillMetadata`); a metadata write meanwhile rolls the removal back to retry.
          await storage.skillLifecycle.deleteSavedState(intent.skillId);
          await storage.systemSettings.deleteCuratorIdleSnapshot(intent.skillId);
          const metadata = await storage.systemSettings.get<unknown>(SKILL_STATE_METADATA_SETTING_KEY);
          const rest = withoutSkillMetadata(metadata?.value, intent.skillId);
          if (
            rest &&
            !(await storage.systemSettings.compareAndSet(SKILL_STATE_METADATA_SETTING_KEY, metadata, rest, now))
          ) {
            throw new ConflictError({ message: "A removed skill's saved state changed while it was being deleted." });
          }
        } else {
          const currentCandidate = await storage.candidateSkillVersions.get(intent.targetVersionId!);
          const candidateChanged = currentCandidate.lifecycleState !== "revoked";
          await storage.candidateSkillVersions.updateLifecycleState(intent.targetVersionId!, "revoked", now);
          candidateRevision = candidateChanged
            ? (
                await storage.skillAggregateRevisions.advanceExpectedRevision(
                  "candidate_skill",
                  intent.targetCandidateId!,
                  intent.expectedCandidateRevision!,
                  now,
                )
              ).revision
            : intent.expectedCandidateRevision;
          const currentLifecycle = await storage.skillLifecycle.get(intent.skillId);
          const runtimeChanged = currentLifecycle.lifecycleState !== "revoked";
          await storage.skillLifecycle.upsert({
            ...currentLifecycle,
            lifecycleState: "revoked",
            trustLabel: "Revoked",
            reviewWarning: "Revoked upstream skill is not callable.",
            updatedAt: now,
          });
          runtimeRevision = runtimeChanged
            ? (
                await storage.skillAggregateRevisions.advanceExpectedRevision(
                  "runtime_skill",
                  intent.skillId,
                  intent.expectedRuntimeRevision!,
                  now,
                )
              ).revision
            : intent.expectedRuntimeRevision;
        }
      }

      return await this.settleInTransaction(intent, artifactId, "applied", intent.contentTreeSha256, {
        code: "applied",
        boundaryCrossed: runtimeProjected,
        candidateVersionId: intent.targetVersionId!,
        runtimeSkillId:
          intent.operationKind === "install_inactive" || intent.operationKind.startsWith("stage_")
            ? undefined
            : intent.skillId,
        candidateRevision,
        runtimeRevision,
        ...detail,
      });
    });
  }

  private async fenceExisting(intent: SkillHubOperationIntentRecord, now: string): Promise<void> {
    await this.options.storage.skillAggregateRevisions.fenceExpectedRevision(
      "candidate_skill",
      intent.targetCandidateId!,
      intent.expectedCandidateRevision!,
      now,
    );
    if (!intent.expectedRuntimeAbsent) {
      await this.options.storage.skillAggregateRevisions.fenceExpectedRevision(
        "runtime_skill",
        intent.skillId,
        intent.expectedRuntimeRevision!,
        now,
      );
    }
  }

  private async settle(
    intent: SkillHubOperationIntentRecord,
    artifactId: string,
    disposition: SkillHubOperationSettlementDisposition,
    observedTreeSha256: string,
    result: Record<string, unknown>,
  ): Promise<SkillHubLifecycleApplyResult> {
    return await this.runTransaction(
      async () => await this.settleInTransaction(intent, artifactId, disposition, observedTreeSha256, result),
    );
  }

  private async settleInTransaction(
    intent: SkillHubOperationIntentRecord,
    artifactId: string,
    disposition: SkillHubOperationSettlementDisposition,
    observedTreeSha256: string,
    rawResult: Record<string, unknown>,
  ): Promise<SkillHubLifecycleApplyResult> {
    const replay = await this.options.storage.skillHubOperations.findSettlementByOperationId(intent.operationId);
    if (replay) return { settlement: replay, replayed: true };
    const result = removeUndefined({ disposition, operationKind: intent.operationKind, ...rawResult });
    const resultSha256 = computeSkillHubOperationResultSha256(result);
    const now = this.now();
    const evidenceEnvelopeId = `skill-hub:evidence:${intent.operationId}`;
    const journeyEventId = `skill-hub:journey:${intent.operationId}`;
    await this.options.storage.evidenceEnvelopes.create({
      envelopeId: evidenceEnvelopeId,
      eventKind: SKILL_HUB_LIFECYCLE_EVIDENCE_EVENT_KIND,
      workspaceId: intent.workspaceId,
      sessionId: intent.sessionId,
      turnId: intent.turnId,
      approvalId: intent.approvalId,
      contentHash: resultSha256,
      payloadHash: resultSha256,
      signatureStatus: "unsigned_local",
      metadata: {
        operationId: intent.operationId,
        action: intent.operationKind,
        subjectKind: SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND,
        subjectId: intent.skillId,
        sourceKind: SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND,
        sourceId: intent.snapshotId,
        contentTreeSha256: intent.contentTreeSha256,
        requestSha256: intent.requestSha256,
        resultSha256,
      },
      createdAt: now,
    });
    await this.options.storage.governanceJourneyEvents.create({
      schemaVersion: "goatcitadel.journey-event.v1",
      eventId: journeyEventId,
      idempotencyKey: `skill-hub:lifecycle:${intent.operationId}`,
      scopeKind: "workspace",
      workspaceId: intent.workspaceId,
      eventType: SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE,
      subjectKind: SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND,
      subjectId: intent.skillId,
      action: intent.operationKind,
      actorId: intent.actorId,
      actorType: "approval_effect",
      sessionId: intent.sessionId,
      turnId: intent.turnId,
      approvalId: intent.approvalId,
      fingerprint: intent.requestSha256,
      sourceKind: SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND,
      sourceId: intent.snapshotId,
      trustDisposition: disposition,
      poisoningStatus: disposition === "applied" ? "clean" : "blocked",
      evidenceRefs: [
        { owner: "approval", refId: intent.approvalId },
        { owner: "upstream_snapshot", refId: intent.snapshotId },
        { owner: "artifact", refId: artifactId },
      ],
      provenance: { approvalRequired: true, sourceRequired: true },
      summary: {
        operationId: intent.operationId,
        requestSha256: intent.requestSha256,
        contentTreeSha256: intent.contentTreeSha256,
        resultSha256,
        disposition,
      },
      occurredAt: now,
      recordedAt: now,
    });
    const settlement = await this.options.storage.skillHubOperations.createSettlement({
      settlementId: `skill-hub:settlement:${intent.operationId}`,
      operationId: intent.operationId,
      workspaceId: intent.workspaceId,
      approvalId: intent.approvalId,
      contentTreeSha256: intent.contentTreeSha256,
      disposition,
      observedTreeSha256,
      candidateVersionId: asOptionalString(result.candidateVersionId),
      runtimeSkillId: asOptionalString(result.runtimeSkillId),
      candidateRevision: asOptionalNumber(result.candidateRevision),
      runtimeRevision: asOptionalNumber(result.runtimeRevision),
      evidenceEnvelopeId,
      journeyEventId,
      result,
      resultSha256,
      settledAt: now,
    });
    return { settlement, replayed: false };
  }

  private async projectRuntimeSkill(
    intent: SkillHubOperationIntentRecord,
    snapshot: Awaited<ReturnType<Storage["skillHubSnapshots"]["get"]>>,
    artifact: Awaited<ReturnType<Storage["skillHubArtifacts"]["get"]>>,
    skillName: string,
    signal: AbortSignal,
  ): Promise<{ boundaryCrossed: boolean }> {
    const scratch = projectionScratch(this.skillsExtraRoot, intent.operationId);
    const target = path.join(this.skillsExtraRoot, skillName);
    const source = this.options.artifactStore.resolveBundlePath(artifact.bundleRelPath);
    await this.filesystem.ensureManagedRoot(this.skillsExtraRoot, signal);
    const expectedSourceJson = `${JSON.stringify(
      {
        manifestVersion: 3,
        installedAt: intent.createdAt,
        candidate: {
          sourceProvider: snapshot.sourceProvider,
          sourceRef: snapshot.sourceRef,
          sourceType: snapshot.sourceType,
        },
        provenance: {
          sourceProvider: snapshot.sourceProvider,
          sourceRef: snapshot.sourceRef,
          sourceType: snapshot.sourceType,
          capturedAt: snapshot.createdAt,
          contentIntegrity: artifact.manifest,
          nonCallableUntilActivated: true,
        },
      },
      null,
      2,
    )}\n`;

    const targetMatches = await this.filesystem.directoryMatches(
      this.skillsExtraRoot,
      target,
      artifact.manifest,
      signal,
    );
    const sourceJsonPath = path.join(target, "source.json");
    if (
      targetMatches &&
      (await this.filesystem.fileMatches(this.skillsExtraRoot, sourceJsonPath, expectedSourceJson, signal))
    ) {
      return { boundaryCrossed: true };
    }
    if (
      (await this.filesystem.pathKind(this.skillsExtraRoot, target, signal)) !== "missing" &&
      (await this.filesystem.pathKind(this.skillsExtraRoot, scratch.backup, signal)) !== "missing"
    ) {
      throw new AmbiguousSkillRuntimeProjectionError("Both a divergent runtime target and recovery backup exist.");
    }
    await this.filesystem.createFreshDirectory(this.skillsExtraRoot, scratch.staging, signal);
    for (const file of artifact.manifest.files) {
      const destination = path.join(scratch.staging, ...file.path.split("/"));
      await this.filesystem.copyVerifiedFile({
        sourceRoot: source,
        sourcePath: path.join(source, ...file.path.split("/")),
        targetRoot: this.skillsExtraRoot,
        targetPath: destination,
        expectedBytes: file.bytes,
        expectedSha256: file.sha256,
        signal,
      });
    }
    if (!(await this.filesystem.directoryMatches(this.skillsExtraRoot, scratch.staging, artifact.manifest, signal))) {
      throw new Error("Skill Hub runtime staging bytes do not match the approved artifact.");
    }
    await this.filesystem.writeImmutableFile(
      this.skillsExtraRoot,
      path.join(scratch.staging, "source.json"),
      expectedSourceJson,
      signal,
    );
    const targetKind = await this.filesystem.pathKind(this.skillsExtraRoot, target, signal);
    const backupKind = await this.filesystem.pathKind(this.skillsExtraRoot, scratch.backup, signal);
    if (targetKind !== "missing") {
      if (backupKind !== "missing")
        throw new AmbiguousSkillRuntimeProjectionError("Runtime recovery backup already exists.");
      await this.filesystem.renameDirectory(this.skillsExtraRoot, target, scratch.backup, signal);
    }
    await this.filesystem.renameDirectory(this.skillsExtraRoot, scratch.staging, target, signal);
    if (!(await this.filesystem.directoryMatches(this.skillsExtraRoot, target, artifact.manifest, signal))) {
      throw new AmbiguousSkillRuntimeProjectionError("Runtime target changed after the replacement boundary.");
    }
    return { boundaryCrossed: true };
  }

  /** The approved removal of a revoked skill; see `runRuntimeRemoval` for what is checked and in what order. */
  private async removeRuntimeSkill(
    intent: SkillHubOperationIntentRecord,
    candidate: CandidateSkillVersionRecord,
    artifact: SkillHubSnapshotArtifactRecord,
    skillName: string,
    signal: AbortSignal,
  ): Promise<SkillHubLifecycleApplyResult> {
    const { storage, reloadSkills, afterRuntimeProjection } = this.options;
    // A lineage never switched on has no runtime record: its removal only marks the lineage removed.
    const run = intent.expectedRuntimeAbsent ? runNeverActivatedRemoval : runRuntimeRemoval;
    return await run({
      intent,
      candidate,
      record: await storage.skillLifecycle.find(intent.skillId),
      lineage: {
        removedCandidateIds: await storage.skillHubOperations.listAppliedRemovalCandidateIds(intent.workspaceId),
        versions: await storage.candidateSkillVersions.listByCandidateId(
          candidate.candidateId,
          LINEAGE_VERSION_LIMIT + 1,
        ),
      },
      manifest: artifact.manifest,
      skillName,
      signal,
      artifactVerifies: await this.artifactStillVerifies(artifact.bundleRelPath, artifact.manifest),
      filesystem: this.filesystem,
      root: this.skillsExtraRoot,
      settle: (disposition, tree, result) => this.settle(intent, artifact.artifactId, disposition, tree, result),
      commit: (staged, detail) => this.applyCanonicalMutation(intent, candidate, artifact.artifactId, staged, detail),
      reloadSkills,
      afterStage: afterRuntimeProjection,
    });
  }

  /** After an applied activation or removal (also on its replay); see `finishAppliedProjection`. */
  private async finishAppliedProjection(
    intent: SkillHubOperationIntentRecord,
    settlement: SkillHubOperationSettlementRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (settlement.disposition !== "applied" || !["activate", "remove"].includes(intent.operationKind)) return;
    const { storage, reloadSkills } = this.options;
    const journey = storage.governanceJourneyEvents;
    await finishAppliedProjection(this.filesystem, this.skillsExtraRoot, {
      intent,
      signal,
      reloadSkills,
      recordFailure: async (error) => {
        const event = projectionCleanupFailureEvent(intent, error, this.now());
        if (!(await journey.find(event.eventId))) await journey.create(event);
      },
    });
  }

  private async artifactStillVerifies(
    bundleRelPath: string,
    manifest: Parameters<SkillHubArtifactStore["verify"]>[0]["manifest"],
  ): Promise<boolean> {
    return this.options.artifactStore.verify({ bundleRelPath, manifest });
  }

  private async scanVerifiedArtifactPromptware(
    bundlePath: string,
    artifact: SkillHubSnapshotArtifactRecord,
    signal: AbortSignal,
  ): Promise<{
    findings: Array<{ ruleId: string; sourcePath: string; evidenceHash: string }>;
    unscannedPaths: string[];
  }> {
    const findings: Array<{ ruleId: string; sourcePath: string; evidenceHash: string }> = [];
    const unscannedPaths: string[] = [];
    for (const entry of artifact.manifest.files) {
      if (!/\.(?:md|txt)$/iu.test(entry.path)) continue;
      try {
        const content = await this.filesystem.readVerifiedText({
          sourceRoot: bundlePath,
          sourcePath: path.join(bundlePath, ...entry.path.split("/")),
          expectedBytes: entry.bytes,
          expectedSha256: entry.sha256,
          signal,
        });
        const fileFindings = scanPromptwareContent({
          source: "imported_skill",
          sourcePath: entry.path,
          content,
        }).map((finding) => ({
          ruleId: finding.ruleId,
          sourcePath: finding.sourcePath ?? entry.path,
          evidenceHash: finding.evidenceHash,
        }));
        findings.push(...fileFindings.slice(0, Math.max(0, PROMPTWARE_MAX_FINDINGS - findings.length)));
      } catch {
        unscannedPaths.push(entry.path);
      }
    }
    return { findings, unscannedPaths };
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

class AmbiguousSkillRuntimeProjectionError extends Error {}

function isConflict(error: unknown): boolean {
  return error instanceof ConflictError || error instanceof AmbiguousSkillRuntimeProjectionError;
}
