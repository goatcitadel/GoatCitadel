/* eslint-disable max-lines */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as ts from "typescript";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ApprovalResolveInput,
  AutonomousActivationGrantCreateInput,
  AutonomousActivationGrantEvaluationInput,
  AutonomousActivationGrantRevokeInput,
  CandidateLifecycleActionResult,
  CandidateSkillDetailRecord,
  CandidateSkillVersionRecord,
  CapabilityArtifactRecord,
  CapabilityCatalogEntry,
  CapabilityCatalogScope,
  CapabilityCatalogSnapshotRecord,
  CompactToolDirectorySnapshot,
  CapabilityProposalDetailRecord,
  CapabilityProposalKind,
  CapabilityProposalRecord,
  ChatMessageRecord,
  ChatSessionWorkbenchCommandRunRequest,
  ChatSessionWorkbenchCommandRunResponse,
  ChatSessionWorkbenchRecord,
  ChatTurnTraceRecord,
  CodeModeAutonomousActivationEvidence,
  CodeModeLanguage,
  CodeModeSandboxMetadata,
  CodeModeRunArtifactKind,
  CodeModeRunArtifactPreview,
  CodeModeRunComparisonRecord,
  CodeModeRunRecord,
  CodeModeRunRequest,
  CodeModeRunListOptions,
  CodeModeRunVerificationRequest,
  CodeModeRunVerificationResponse,
  CodeModeVerificationEvidenceRecord,
  CodeModeRunExecutionBackendRef,
  CodeModeTrustedCodeWriteVerification,
  LoadedSkill,
  PendingApprovalAction,
  SkillLifecycleRecord,
  SkillListItem,
  SkillRuntimeState,
  SkillStateRecord,
  ToolCatalogEntry,
  LocalOperatorOverrideRecord,
  PermissionProfileRecord,
  RuntimeDecisionTraceAppendInput,
  PermissionSurface,
  ToolPolicyActorContext,
  ToolInvokeRequest,
  ToolInvokeResult,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import {
  classifyToolEffectPotential,
  ConflictError,
  NotFoundError,
  redactStructuredSecrets,
  ValidationError,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { CapabilityRuntimeConfig, CodeModeDockerBackendConfig, FeatureFlagsConfig } from "../config.js";
import { CODE_MODE_CHILD_SOURCE } from "./code-mode-child-source.js";
import {
  CodeModeExecutionBackendUnavailableError,
  createCodeModeExecutionBackendRunner,
} from "./code-mode-execution-backend-runner.js";
import { parseCodeModeAiderAdapterResultEnvelope } from "./code-mode-aider-result-contract.js";
import {
  CODE_MODE_AIDER_ADAPTER_ID,
  buildCodeModeExecutionBackends,
  buildCodeModeRunExecutionBackendRef,
} from "./code-mode-execution-backends.js";
import { assertCodeModeSandboxAvailable, resolveCodeModeSandboxMetadata } from "./code-mode-sandbox-runner.js";
import { AutonomousActivationGrantService } from "./autonomous-activation-grant-service.js";
import type { EffectiveCapabilitySet } from "./capability-scope-resolver.js";
import { validateSkillContent } from "./skill-content-validation.js";
import {
  captureSkillContentIntegritySync,
  parseSkillContentIntegrityManifest,
  readBoundedSkillSourceManifestSync,
  verifySkillContentIntegritySync,
} from "./skill-content-integrity.js";
import type { ApprovalResolveResult } from "./approval-types.js";
import { CodeModeVerificationService } from "./code-mode-verification-service.js";

const CODE_MODE_RUN_TIMEOUT_MS = 15_000;
const CODE_MODE_WRAPPER_SETTLE_TIMEOUT_MS = 500;
const CODE_MODE_OUTPUT_CAPTURE_LIMIT_BYTES = 64 * 1024;
const CODE_MODE_FINAL_TRANSCRIPT_LIMIT_BYTES = 24 * 1024;
const CODE_MODE_RECOVERY_ERROR_LIMIT_BYTES = 2 * 1024;
const CODE_MODE_RECOVERY_ERRORS_MAX_ENTRIES = 32;
const CODE_MODE_RECOVERY_ERRORS_TOTAL_LIMIT_BYTES = 24 * 1024;
const CODE_MODE_IPC_MAX_BYTES = 128 * 1024;
const CODE_MODE_HEAP_MB = 64;
const CODE_MODE_ENV_PASSTHROUGH_KEYS = [
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ALLUSERSPROFILE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
];
const DEFAULT_WORKSPACE_ID = "default";

type LateCodeModeApprovalCleanupResult = {
  approvalId: string;
  attempted: true;
  status: "completed" | "failed";
  errors: string[];
};

type ChatInlineApprovalRecord = ReturnType<Storage["chatInlineApprovals"]["listBySession"]>[number];

export interface CapabilitySystemServiceOptions {
  rootDir: string;
  runtimeConfig: CapabilityRuntimeConfig;
  storage: Storage;
  readFeatureFlags: () => Pick<FeatureFlagsConfig, "codeModeV1Enabled"> & Record<string, boolean>;
  listToolCatalog: () => ToolCatalogEntry[];
  listLoadedSkills: () => LoadedSkill[];
  readSkillStates: () => Map<string, SkillStateRecord>;
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
  createApproval: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
  resolveApproval: (approvalId: string, input: ApprovalResolveInput) => Promise<ApprovalResolveResult>;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  readPolicySnapshot: () => Record<string, unknown>;
  resolveSandboxMetadata?: (config: CapabilityRuntimeConfig["codeModeSandbox"]) => CodeModeSandboxMetadata;
  resolvePolicyContext?: (input: {
    operatorId?: string;
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: CodeModeOriginSurface;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }) => ToolPolicyActorContext;
  getChatSessionWorkbench?: (sessionId: string) => Promise<ChatSessionWorkbenchRecord>;
  runChatSessionWorkbenchCommand?: (
    sessionId: string,
    input: ChatSessionWorkbenchCommandRunRequest,
  ) => Promise<ChatSessionWorkbenchCommandRunResponse>;
  flushTranscriptOutbox?: () => Promise<number>;
  spawnCodeModeChild?: typeof spawn;
}

interface CodeModeWrapperManifest {
  manifestVersion: 1;
  capabilitySnapshotId: string;
  createdAt: string;
  wrappers: Array<{
    name: string;
    description: string;
    argSchema: Record<string, unknown>;
    readOnly: true;
    deterministic: true;
    codeModeAllowed: true;
  }>;
}

export interface CodeModeApprovalQueueItem {
  approvalId: string;
  sessionId: string;
  kind?: string;
  toolName?: string;
  reason?: string;
  riskLevel?: ApprovalRequest["riskLevel"];
  expiresAt?: string;
  createdAt: string;
  stale: boolean;
  staleReason?: string;
  details?: Record<string, unknown>;
}

interface BoundedCaptureState {
  text: string;
  truncated: boolean;
}

type CodeModeOriginSurface = NonNullable<CodeModeRunRequest["originSurface"]>;

/**
 * Filters an array of skill items by an effective capability set.
 *
 * When `effective === "ALL"` (the default for unconfigured scopes), returns the
 * full input unchanged. Otherwise returns only items whose `skillId` is present
 * in the effective set. This is the core filter for workspace/citadel capability
 * scoping of the skill catalog.
 */
export function filterSkillItemsByEffectiveSet<T extends { skillId: string }>(
  items: T[],
  effective: EffectiveCapabilitySet,
): T[] {
  if (effective === "ALL") {
    return items;
  }
  return items.filter((item) => effective.has(item.skillId));
}

class CodeModeSandboxLaunchFailure extends Error {
  public constructor(
    message: string,
    public readonly sandbox: CodeModeSandboxMetadata,
  ) {
    super(message);
    this.name = "CodeModeSandboxLaunchFailure";
  }
}

class CodeModeExecutionPreDispatchFailure extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodeModeExecutionPreDispatchFailure";
  }
}

export class CapabilitySystemService {
  private readonly candidateRoot: string;
  private readonly artifactRoot: string;
  private readonly tempRoot: string;
  private readonly resolveSandboxMetadata: (
    config: CapabilityRuntimeConfig["codeModeSandbox"],
  ) => CodeModeSandboxMetadata;
  private readonly autonomousActivationGrants: AutonomousActivationGrantService;
  private readonly codeModeVerification?: CodeModeVerificationService;

  public constructor(private readonly options: CapabilitySystemServiceOptions) {
    this.candidateRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.candidateRoot);
    this.artifactRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.codeModeArtifactRoot);
    this.tempRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.tempRoot);
    this.resolveSandboxMetadata =
      options.resolveSandboxMetadata ?? ((config) => resolveCodeModeSandboxMetadata(config));
    this.autonomousActivationGrants = new AutonomousActivationGrantService(
      options.storage.systemSettings,
      (eventType, source, payload) => options.publishRealtime(eventType, source, payload),
    );
    if (options.getChatSessionWorkbench && options.runChatSessionWorkbenchCommand) {
      this.codeModeVerification = new CodeModeVerificationService({
        rootDir: options.rootDir,
        artifactRoot: this.artifactRoot,
        storage: options.storage,
        getWorkbench: options.getChatSessionWorkbench,
        runWorkbenchCommand: options.runChatSessionWorkbenchCommand,
        publishRealtime: options.publishRealtime,
      });
    }
  }

  private resolveCurrentSandboxMetadata(): CodeModeSandboxMetadata {
    return this.resolveSandboxMetadata(this.options.runtimeConfig.codeModeSandbox);
  }

  public ensureSkillLifecycleBackfill(): void {
    const skills = this.options.listLoadedSkills();
    for (const skill of skills) {
      if (this.options.storage.skillLifecycle.find(skill.skillId)) {
        continue;
      }
      this.options.storage.skillLifecycle.upsert(buildSkillLifecycleRecord(skill));
    }
  }

  public listSkills(effectiveSkills: EffectiveCapabilitySet = "ALL"): SkillListItem[] {
    this.ensureSkillLifecycleBackfill();
    const stateMap = this.options.readSkillStates();
    const all = this.options.listLoadedSkills().map((skill) => {
      const state = stateMap.get(skill.skillId);
      const lifecycle = this.resolveSkillLifecycle(skill);
      return {
        ...skill,
        revision:
          state?.revision ??
          this.options.storage.skillAggregateRevisions.ensure("runtime_skill", skill.skillId).revision,
        state: state?.state ?? "enabled",
        note: state?.note,
        stateUpdatedAt: state?.updatedAt,
        pinned: state?.pinned,
        usageCount: state?.usageCount,
        lastUsedAt: state?.lastUsedAt,
        capabilityCategory: lifecycle.category,
        lifecycleState: lifecycle.lifecycleState,
        lifecycle,
        callable: isSkillCallable(lifecycle, state?.state ?? "enabled"),
        trustLabel: lifecycle.trustLabel,
        reviewWarning: lifecycle.reviewWarning,
      };
    });
    return filterSkillItemsByEffectiveSet(all, effectiveSkills);
  }

  private resolveSkillLifecycle(skill: LoadedSkill): SkillLifecycleRecord {
    const existing = this.options.storage.skillLifecycle.find(skill.skillId);
    const projected = buildSkillLifecycleRecord(skill, existing?.createdAt);
    if (skill.source !== "extra") {
      if (!existing) {
        return this.options.storage.skillLifecycle.upsert(projected);
      }
      if (!skillLifecycleExactIntegrityMatches(existing, projected)) {
        projected.lifecycleState = "candidate";
        projected.trustLabel = "Exact-byte review required";
        projected.reviewWarning = existing.provenance?.contentIntegrity
          ? "Skill content changed after its trusted exact-byte lifecycle binding; review and reactivate this version before use."
          : "Legacy skill lifecycle is missing exact-byte provenance; review and reactivate this version before use.";
      } else {
        projected.lifecycleState = existing.lifecycleState;
        projected.trustLabel = existing.trustLabel;
        projected.reviewWarning = existing.reviewWarning;
      }
      if (skillLifecycleProjectionMatches(existing, projected)) {
        return existing;
      }
      return this.options.storage.skillLifecycle.upsert(projected);
    }
    // Revocation is durable deny-wins truth. Filesystem discovery or editable
    // source metadata must never hydrate a revoked imported skill back into a
    // candidate (or any other callable lifecycle posture).
    if (existing?.lifecycleState === "revoked") {
      return existing;
    }
    if (durableImportedActivationMatches(existing, projected)) {
      projected.lifecycleState = existing.lifecycleState;
      projected.trustLabel = existing.trustLabel;
      projected.reviewWarning = existing.reviewWarning;
      // Keep the operator-approved source identity immutable. source.json is
      // editable metadata; only its freshly verified content digest may be
      // projected into an already-governed lifecycle row.
      projected.provenance = {
        ...existing.provenance,
        source: existing.provenance?.source ?? "extra",
        contentIntegrity: projected.provenance?.contentIntegrity,
      };
    }
    if (existing && skillLifecycleProjectionMatches(existing, projected)) {
      return existing;
    }
    return this.options.storage.skillLifecycle.upsert(projected);
  }

  public listCatalog(
    scope: CapabilityCatalogScope,
    effectiveSkills: EffectiveCapabilitySet = "ALL",
  ): CapabilityCatalogEntry[] {
    this.ensureSkillLifecycleBackfill();
    const inspectable = this.buildInspectableCatalog(effectiveSkills);
    return scope === "callable" ? inspectable.filter((entry) => entry.callable) : inspectable;
  }

  public getCompactToolDirectorySnapshot(ttlMs = 300_000): CompactToolDirectorySnapshot {
    this.ensureSkillLifecycleBackfill();
    const now = new Date();
    const createdAt = now.toISOString();
    const resolvedTtlMs = Math.max(1_000, Math.min(ttlMs, 3_600_000));
    const expiresAt = new Date(now.getTime() + resolvedTtlMs).toISOString();
    const inspectable = this.buildInspectableCatalog();
    const callableTools = inspectable.filter((entry) => entry.callable && entry.kind === "tool" && entry.toolName);
    const toolCatalogByName = new Map(this.options.listToolCatalog().map((tool) => [tool.toolName, tool]));
    const tools = callableTools.map((entry) => {
      const toolName = entry.toolName as string;
      const tool = toolCatalogByName.get(toolName);
      const schemaJson = canonicalJson(tool?.argSchema ?? {});
      const schemaHash = sha256Text(schemaJson);
      return {
        capabilityId: entry.capabilityId,
        toolName,
        title: entry.title,
        summary: entry.summary,
        riskLabel: tool?.riskLevel ?? "unknown",
        schemaRef: {
          refId: `tool-schema:${schemaHash}`,
          toolName,
          schemaHash,
          schemaUri: `/api/v1/capabilities/tool-directory/schemas/${encodeURIComponent(toolName)}`,
        },
        readOnly: Boolean(entry.wrapperVisibility?.readOnly),
        deterministic: Boolean(entry.wrapperVisibility?.deterministic),
        codeModeAllowed: Boolean(entry.wrapperVisibility?.codeModeAllowed),
      };
    });
    const payloadForHash = canonicalJson({
      version: "compact-tool-directory.v1",
      source: "callable_catalog",
      tools,
      omitted: {
        inspectableOnlyCount: inspectable.filter((entry) => !entry.callable).length,
        reason: "callable_only",
      },
    });
    const hash = sha256Text(payloadForHash);
    return {
      snapshotId: `compact-tools-${hash.slice(0, 16)}`,
      version: "compact-tool-directory.v1",
      source: "callable_catalog",
      createdAt,
      expiresAt,
      ttlMs: resolvedTtlMs,
      hash,
      toolCount: tools.length,
      tools,
      omitted: {
        inspectableOnlyCount: inspectable.filter((entry) => !entry.callable).length,
        reason: "callable_only",
      },
    };
  }

  public getToolSchema(toolName: string): { toolName: string; schemaHash: string; schema: Record<string, unknown> } {
    const tool = this.options.listToolCatalog().find((entry) => entry.toolName === toolName);
    if (!tool) {
      throw new Error(`Unknown tool schema: ${toolName}`);
    }
    const schema = tool.argSchema ?? {};
    return {
      toolName,
      schemaHash: sha256Text(canonicalJson(schema)),
      schema,
    };
  }

  public listCodeModeExecutionBackends() {
    return buildCodeModeExecutionBackends({
      codeModeEnabled: this.options.readFeatureFlags().codeModeV1Enabled,
      sandbox: this.resolveCurrentSandboxMetadata(),
      dockerBackend: this.options.runtimeConfig.codeModeDockerBackend,
      aiderAdapter: this.options.runtimeConfig.codeModeAiderAdapter,
    });
  }

  public listAutonomousActivationGrants(includeExpired = false) {
    return this.autonomousActivationGrants.listGrants({ includeExpired });
  }

  public createAutonomousActivationGrant(input: AutonomousActivationGrantCreateInput) {
    return this.autonomousActivationGrants.createGrant(input);
  }

  public revokeAutonomousActivationGrant(grantId: string, input: AutonomousActivationGrantRevokeInput) {
    return this.autonomousActivationGrants.revokeGrant(grantId, input);
  }

  public evaluateAutonomousActivationGrant(input: AutonomousActivationGrantEvaluationInput) {
    return this.autonomousActivationGrants.evaluateGrant(input);
  }

  public recordAutonomousActivationGrantUse(grantId: string, estimatedCostUsd?: number) {
    return this.autonomousActivationGrants.recordGrantUse(grantId, estimatedCostUsd);
  }

  public freezeCatalogSnapshot(): CapabilityCatalogSnapshotRecord {
    const inspectableEntries = this.listCatalog("inspectable");
    const snapshot: CapabilityCatalogSnapshotRecord = {
      snapshotId: `cap-snap-${randomUUID()}`,
      inspectableEntries,
      callableEntries: inspectableEntries.filter((entry) => entry.callable),
      createdAt: new Date().toISOString(),
    };
    return this.options.storage.capabilityCatalogSnapshots.create(snapshot);
  }

  public getCatalogSnapshot(snapshotId: string): CapabilityCatalogSnapshotRecord {
    return this.options.storage.capabilityCatalogSnapshots.get(snapshotId);
  }

  public getCandidateDetail(candidateId: string): CandidateSkillDetailRecord {
    return this.buildCandidateDetail(candidateId);
  }

  public listProposals(limit = 100): CapabilityProposalRecord[] {
    return this.options.storage.capabilityProposals.list(limit);
  }

  public getProposalDetail(proposalId: string): CapabilityProposalDetailRecord {
    const proposal = this.options.storage.capabilityProposals.get(proposalId);
    const candidate = proposal.candidateId
      ? this.options.storage.candidateSkillVersions.findLatestByCandidateId(proposal.candidateId)
        ? this.buildCandidateDetail(proposal.candidateId)
        : undefined
      : undefined;
    return {
      proposal,
      events: this.options.storage.capabilityProposalEvents.listByProposalId(proposalId),
      candidate,
    };
  }

  public createProposal(input: {
    proposalKind: CapabilityProposalKind;
    title: string;
    summary: string;
    payload: Record<string, unknown>;
    candidateId?: string;
    activationTargetId?: string;
  }): CapabilityProposalRecord {
    const now = new Date().toISOString();
    const proposal: CapabilityProposalRecord = {
      proposalId: `proposal-${randomUUID()}`,
      proposalKind: input.proposalKind,
      status: "proposed",
      title: input.title.trim(),
      summary: input.summary.trim(),
      payload: input.payload,
      candidateId: input.candidateId,
      activationTargetId: input.activationTargetId,
      createdAt: now,
      updatedAt: now,
    };
    const stored = this.options.storage.capabilityProposals.upsert(proposal);
    this.options.storage.capabilityProposalEvents.append({
      eventId: randomUUID(),
      proposalId: stored.proposalId,
      eventType: "created",
      actorId: "operator",
      payload: {
        proposalKind: stored.proposalKind,
        status: stored.status,
      },
      createdAt: now,
    });
    this.options.publishRealtime("capability_proposal_created", "capabilities", {
      proposalId: stored.proposalId,
      proposalKind: stored.proposalKind,
      status: stored.status,
    });
    return stored;
  }

  public promoteCandidate(
    candidateId: string,
    expectedRevision: number,
    versionId?: string,
  ): CandidateLifecycleActionResult {
    const versions = this.requireCandidateVersions(candidateId);
    const selected = versionId ? this.requireCandidateVersion(candidateId, versionId) : versions[0]!;
    this.verifyCandidateVersionArtifacts(selected);
    const occurredAt = new Date().toISOString();
    const mutation = this.options.storage.skillAggregateRevisions.runWithRevision(
      "candidate_skill",
      candidateId,
      expectedRevision,
      () => {
        const currentVersions = this.requireCandidateVersions(candidateId);
        this.requireCandidateVersion(candidateId, selected.versionId);
        const changedVersionIds: string[] = [];
        for (const version of currentVersions) {
          if (version.versionId === selected.versionId) {
            if (version.lifecycleState !== "approved" && version.lifecycleState !== "trusted") {
              this.options.storage.candidateSkillVersions.updateLifecycleState(
                version.versionId,
                "approved",
                occurredAt,
              );
              changedVersionIds.push(version.versionId);
            }
            continue;
          }
          if (version.lifecycleState === "approved" || version.lifecycleState === "trusted") {
            this.options.storage.candidateSkillVersions.updateLifecycleState(
              version.versionId,
              "deprecated",
              occurredAt,
            );
            changedVersionIds.push(version.versionId);
          }
        }
        return {
          value: {
            changedVersionIds: changedVersionIds.sort(compareCodeUnits),
            detail: this.buildCandidateDetail(candidateId, expectedRevision),
          },
          changed: changedVersionIds.length > 0,
        };
      },
      occurredAt,
    );
    const detail = { ...mutation.value.detail, revision: mutation.revision };
    if (mutation.changed) {
      this.options.publishRealtime("candidate_skill_promoted", "capabilities", {
        candidateId,
        versionId: selected.versionId,
        revision: mutation.revision,
      });
    }
    return {
      action: "promote",
      candidateId,
      revision: mutation.revision,
      selectedVersionId: selected.versionId,
      changedVersionIds: mutation.value.changedVersionIds,
      occurredAt,
      detail,
    };
  }

  public revokeCandidate(
    candidateId: string,
    expectedRevision: number,
    versionId?: string,
  ): CandidateLifecycleActionResult {
    const versions = this.requireCandidateVersions(candidateId);
    const selected = versionId ? this.requireCandidateVersion(candidateId, versionId) : versions[0]!;
    const occurredAt = new Date().toISOString();
    const mutation = this.options.storage.skillAggregateRevisions.runWithRevision(
      "candidate_skill",
      candidateId,
      expectedRevision,
      () => {
        const currentVersions = this.requireCandidateVersions(candidateId);
        this.requireCandidateVersion(candidateId, selected.versionId);
        const targets = versionId
          ? currentVersions.filter((version) => version.versionId === selected.versionId)
          : currentVersions;
        const changedVersionIds: string[] = [];
        for (const version of targets) {
          if (version.lifecycleState === "revoked") {
            continue;
          }
          this.options.storage.candidateSkillVersions.updateLifecycleState(version.versionId, "revoked", occurredAt);
          changedVersionIds.push(version.versionId);
        }
        return {
          value: {
            changedVersionIds: changedVersionIds.sort(compareCodeUnits),
            detail: this.buildCandidateDetail(candidateId, expectedRevision),
          },
          changed: changedVersionIds.length > 0,
        };
      },
      occurredAt,
    );
    const detail = { ...mutation.value.detail, revision: mutation.revision };
    if (mutation.changed) {
      this.options.publishRealtime("candidate_skill_revoked", "capabilities", {
        candidateId,
        versionId: selected.versionId,
        revokedVersionIds: mutation.value.changedVersionIds,
        revision: mutation.revision,
      });
    }
    return {
      action: "revoke",
      candidateId,
      revision: mutation.revision,
      selectedVersionId: selected.versionId,
      changedVersionIds: mutation.value.changedVersionIds,
      occurredAt,
      detail,
    };
  }

  public rollbackCandidate(
    candidateId: string,
    targetVersionId: string,
    expectedRevision: number,
  ): CandidateLifecycleActionResult {
    this.requireCandidateVersions(candidateId);
    const target = this.requireCandidateVersion(candidateId, targetVersionId);
    this.verifyCandidateVersionArtifacts(target);
    const occurredAt = new Date().toISOString();
    const mutation = this.options.storage.skillAggregateRevisions.runWithRevision(
      "candidate_skill",
      candidateId,
      expectedRevision,
      () => {
        const currentVersions = this.requireCandidateVersions(candidateId);
        this.requireCandidateVersion(candidateId, targetVersionId);
        const changedVersionIds: string[] = [];
        for (const version of currentVersions) {
          if (version.versionId === target.versionId) {
            if (version.lifecycleState !== "approved" && version.lifecycleState !== "trusted") {
              this.options.storage.candidateSkillVersions.updateLifecycleState(
                version.versionId,
                "approved",
                occurredAt,
              );
              changedVersionIds.push(version.versionId);
            }
            continue;
          }
          if (version.lifecycleState !== "revoked" && version.lifecycleState !== "deprecated") {
            this.options.storage.candidateSkillVersions.updateLifecycleState(
              version.versionId,
              "deprecated",
              occurredAt,
            );
            changedVersionIds.push(version.versionId);
          }
        }
        return {
          value: {
            changedVersionIds: changedVersionIds.sort(compareCodeUnits),
            detail: this.buildCandidateDetail(candidateId, expectedRevision),
          },
          changed: changedVersionIds.length > 0,
        };
      },
      occurredAt,
    );
    const detail = { ...mutation.value.detail, revision: mutation.revision };
    if (mutation.changed) {
      this.options.publishRealtime("candidate_skill_rolled_back", "capabilities", {
        candidateId,
        targetVersionId,
        revision: mutation.revision,
      });
    }
    return {
      action: "rollback",
      candidateId,
      revision: mutation.revision,
      selectedVersionId: target.versionId,
      changedVersionIds: mutation.value.changedVersionIds,
      occurredAt,
      detail,
    };
  }

  public listCodeModeRuns(options: number | CodeModeRunListOptions = 100): CodeModeRunRecord[] {
    const filters = normalizeCodeModeRunListOptions(options);
    const runs = this.listStoredCodeModeRunsForRead(filters).map((run) => this.hydrateCodeModeRunForRead(run));
    return filters.status
      ? runs.filter((run) => run.status === filters.status).slice(0, filters.limit)
      : runs.slice(0, filters.limit);
  }

  public getCodeModeRun(runId: string): CodeModeRunRecord {
    return this.hydrateCodeModeRunForRead(this.options.storage.codeModeRuns.get(runId));
  }

  public async getCodeModeRunArtifactPreview(
    runId: string,
    artifactKind: CodeModeRunArtifactKind,
    scope?: Pick<CodeModeRunListOptions, "sessionId" | "turnId" | "workspaceId">,
  ): Promise<CodeModeRunArtifactPreview> {
    const run = scope ? this.getCodeModeRunInScope(runId, scope) : this.getCodeModeRun(runId);
    const target = selectCodeModeRunArtifact(run, artifactKind);
    const content = await this.readVerifiedManagedArtifactText(target.artifact, {
      label: target.label,
      expectedSha256: target.expectedContentSha256,
    });
    if (target.expectedJsonValueSha256) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new ConflictError({
          message: `${target.label} is not valid JSON; refusing to inspect Code Mode run.`,
          details: {
            parseError: error instanceof Error ? error.message : String(error),
          },
        });
      }
      assertJsonValueHash(parsed, target.expectedJsonValueSha256, target.label);
    }
    return {
      runId,
      artifactKind,
      artifact: target.artifact,
      content,
      sha256: sha256Text(content),
      verifiedAt: new Date().toISOString(),
      truncated: target.truncated,
    };
  }

  public compareCodeModeRuns(
    runId: string,
    baselineRunId: string,
    scope?: Pick<CodeModeRunListOptions, "sessionId" | "turnId" | "workspaceId">,
  ): CodeModeRunComparisonRecord {
    const run = scope ? this.getCodeModeRunInScope(runId, scope) : this.getCodeModeRun(runId);
    const baseline = scope ? this.getCodeModeRunInScope(baselineRunId, scope) : this.getCodeModeRun(baselineRunId);
    return {
      runId: run.runId,
      baselineRunId: baseline.runId,
      comparedAt: new Date().toISOString(),
      run: summarizeCodeModeRunForComparison(run),
      baseline: summarizeCodeModeRunForComparison(baseline),
      matches: {
        capabilitySnapshot: run.capabilitySnapshotId === baseline.capabilitySnapshotId,
        source: run.codeHash === baseline.codeHash,
        input: run.codeModeInputHash === baseline.codeModeInputHash,
        wrapperManifest: run.wrapperManifestHash === baseline.wrapperManifestHash,
        policySnapshot: run.policySnapshotHash === baseline.policySnapshotHash,
        permissionProfile: run.permissionProfileId === baseline.permissionProfileId,
        localOperatorOverride: run.localOperatorOverrideId === baseline.localOperatorOverrideId,
        sandboxRunner: run.sandbox?.runnerId === baseline.sandbox?.runnerId,
        sandboxProfile: run.sandbox?.isolationProfile === baseline.sandbox?.isolationProfile,
        sandboxAvailability: run.sandbox?.available === baseline.sandbox?.available,
      },
      sandbox: {
        run: run.sandbox,
        baseline: baseline.sandbox,
      },
    };
  }

  public getCodeModeRunInScope(
    runId: string,
    scope: Pick<CodeModeRunListOptions, "sessionId" | "turnId" | "workspaceId">,
  ): CodeModeRunRecord {
    const run = this.options.storage.codeModeRuns.get(runId);
    if (
      (scope.sessionId && run.sessionId !== scope.sessionId) ||
      (scope.turnId && run.turnId !== scope.turnId) ||
      (scope.workspaceId && run.workspaceId !== scope.workspaceId)
    ) {
      throw new NotFoundError({ entity: "code mode run", id: runId });
    }
    return this.hydrateCodeModeRunForRead(run);
  }

  public async verifyCodeModeRun(
    runId: string,
    request: CodeModeRunVerificationRequest,
    scope: Pick<CodeModeRunListOptions, "sessionId" | "turnId" | "workspaceId">,
    operatorId?: string,
  ): Promise<CodeModeRunVerificationResponse> {
    if (!this.codeModeVerification) {
      throw new ConflictError({ message: "Code Mode workbench verification is unavailable." });
    }
    const run = this.getCodeModeRunInScope(runId, scope);
    const recorded = await this.codeModeVerification.verifyRun(run, request.commandName, operatorId);
    return {
      ...recorded,
      run: this.hydrateCodeModeRunForRead(recorded.run),
    };
  }

  public listCodeModeRunVerificationEvidence(
    runId: string,
    scope: Pick<CodeModeRunListOptions, "sessionId" | "turnId" | "workspaceId">,
    limit = 50,
  ): CodeModeVerificationEvidenceRecord[] {
    this.getCodeModeRunInScope(runId, scope);
    return this.options.storage.codeModeRuns.listVerificationEvidence(runId, limit);
  }

  private listStoredCodeModeRuns(filters: Required<Pick<CodeModeRunListOptions, "limit">> & CodeModeRunListOptions) {
    const repository = this.options.storage.codeModeRuns as typeof this.options.storage.codeModeRuns & {
      listFiltered?: (options: CodeModeRunListOptions) => CodeModeRunRecord[];
    };
    if (repository.listFiltered) {
      return repository.listFiltered(filters);
    }
    return repository
      .list(filters.limit)
      .filter((run) => (filters.workspaceId ? run.workspaceId === filters.workspaceId : true))
      .filter((run) => (filters.sessionId ? run.sessionId === filters.sessionId : true))
      .filter((run) => (filters.turnId ? run.turnId === filters.turnId : true))
      .filter((run) => (filters.status ? run.status === filters.status : true));
  }

  private listStoredCodeModeRunsForRead(
    filters: Required<Pick<CodeModeRunListOptions, "limit">> & CodeModeRunListOptions,
  ): CodeModeRunRecord[] {
    if (
      filters.status === "expired" ||
      filters.status === "approval_pending" ||
      filters.status === "failed" ||
      filters.status === "rejected"
    ) {
      const repository = this.options.storage.codeModeRuns as typeof this.options.storage.codeModeRuns & {
        listFilteredForStatusHydration?: (
          options: CodeModeRunListOptions & { status: CodeModeRunRecord["status"] },
        ) => CodeModeRunRecord[];
      };
      if (repository.listFilteredForStatusHydration) {
        return repository.listFilteredForStatusHydration({
          workspaceId: filters.workspaceId,
          sessionId: filters.sessionId,
          turnId: filters.turnId,
          status: filters.status,
          limit: filters.limit,
        });
      }
      const scanLimit = Math.min(Math.max(filters.limit * 4, filters.limit), 1000);
      return repository
        .list(scanLimit)
        .filter((run) => (filters.workspaceId ? run.workspaceId === filters.workspaceId : true))
        .filter((run) => (filters.sessionId ? run.sessionId === filters.sessionId : true))
        .filter((run) => (filters.turnId ? run.turnId === filters.turnId : true))
        .filter((run) => run.status === filters.status || run.status === "approval_pending");
    }
    return this.listStoredCodeModeRuns(filters);
  }

  public listChatPendingApprovals(sessionId: string): CodeModeApprovalQueueItem[] {
    const approvals = this.listChatInlineApprovalsForSessionTree(sessionId);
    return approvals
      .map((item) => {
        let approval: ApprovalRequest | undefined;
        try {
          approval = this.options.storage.approvals.get(item.approvalId);
        } catch {
          approval = undefined;
        }
        const expired = Boolean(approval?.expiresAt && Date.parse(approval.expiresAt) <= Date.now());
        const staleReason =
          approval?.status && approval.status !== "pending"
            ? approval.status
            : expired
              ? "expired"
              : item.status !== "pending"
                ? item.status
                : undefined;
        const queueItem = {
          approvalId: item.approvalId,
          sessionId: item.sessionId,
          kind: item.kind ?? approval?.kind,
          toolName:
            item.toolName ??
            asOptionalString(item.details?.toolName) ??
            asOptionalString(approval?.preview.toolName) ??
            approval?.kind,
          reason:
            item.reason ??
            asOptionalString(item.details?.description) ??
            asOptionalString(approval?.preview.description) ??
            asOptionalString(approval?.preview.reason),
          riskLevel: item.riskLevel ?? approval?.riskLevel,
          expiresAt: approval?.expiresAt ?? item.expiresAt,
          createdAt: item.createdAt,
          details: item.details,
          stale: Boolean(staleReason),
          staleReason,
        } satisfies CodeModeApprovalQueueItem;
        return redactStructuredSecrets(queueItem).value;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private listChatInlineApprovalsForSessionTree(sessionId: string): ChatInlineApprovalRecord[] {
    const approvalsById = new Map<string, ChatInlineApprovalRecord>();
    const addApprovals = (items: ChatInlineApprovalRecord[]) => {
      for (const item of items) {
        if (!approvalsById.has(item.approvalId)) {
          approvalsById.set(item.approvalId, item);
        }
      }
    };
    addApprovals(this.options.storage.chatInlineApprovals.listBySession(sessionId));
    for (const childSessionId of this.resolveWaitingDelegatedApprovalSessionIds(sessionId)) {
      addApprovals(this.options.storage.chatInlineApprovals.listBySession(childSessionId));
    }
    return [...approvalsById.values()];
  }

  private resolveWaitingDelegatedApprovalSessionIds(sessionId: string): string[] {
    const childSessionIds = new Set<string>();
    const addChildSessionId = (value: unknown) => {
      const childSessionId = asOptionalString(value);
      if (childSessionId) {
        childSessionIds.add(childSessionId);
      }
    };
    try {
      const plans = this.options.storage.chatExecutionPlans.listBySession(sessionId, 10);
      const activePlan =
        plans.find((plan) => plan.status === "running") ??
        plans.find((plan) => plan.status === "ready") ??
        plans.find((plan) => plan.status === "drafted");
      if (activePlan?.status === "running") {
        for (const step of activePlan.steps) {
          if (step.status === "running") {
            addChildSessionId(step.childSessionId);
          }
        }
      }
    } catch (error) {
      void error;
      // Fallback for older test/storage harnesses that may not expose execution plans.
    }
    let traces: ChatTurnTraceRecord[];
    try {
      traces = this.options.storage.chatTurnTraces.listBySession(sessionId, 25);
    } catch {
      return [...childSessionIds];
    }
    for (const trace of traces) {
      const waitingOnApproval =
        trace.status === "waiting_for_approval" ||
        trace.orchestration?.steps.some((step) => step.waitStatus === "waiting_for_approval") ||
        trace.executionPlan?.steps.some((step) => step.status === "running" && step.childSessionId);
      if (!waitingOnApproval) {
        continue;
      }
      for (const step of trace.orchestration?.steps ?? []) {
        if (step.waitStatus === "waiting_for_approval" || step.status === "running") {
          addChildSessionId((step as { childSessionId?: unknown }).childSessionId);
        }
      }
      for (const step of trace.executionPlan?.steps ?? []) {
        if (step.status === "running") {
          addChildSessionId(step.childSessionId);
        }
      }
    }
    return [...childSessionIds];
  }

  public async createCodeModeRun(request: CodeModeRunRequest): Promise<CodeModeRunRecord> {
    this.requireCodeModeEnabled();
    const source = request.source.trim();
    if (!source) {
      throw new ValidationError({ message: "Code Mode source is required." });
    }
    validateGuestSource(source);
    this.ensureSkillLifecycleBackfill();

    const snapshot = this.freezeCatalogSnapshot();
    const createdAt = new Date().toISOString();
    const wrapperManifest = this.buildWrapperManifest(snapshot, createdAt);
    const codeHash = sha256Text(source);
    const wrapperManifestHash = sha256Text(JSON.stringify(wrapperManifest));
    const runId = `code-run-${randomUUID()}`;
    const runInput = request.input ?? {};
    const runInputHash = sha256Text(JSON.stringify(runInput));
    const sandbox = this.resolveCurrentSandboxMetadata();
    let executionBackend: CodeModeRunExecutionBackendRef;
    try {
      executionBackend = buildCodeModeRunExecutionBackendRef(sandbox, {
        dockerBackend: this.options.runtimeConfig.codeModeDockerBackend,
        aiderAdapter: this.options.runtimeConfig.codeModeAiderAdapter,
        requestedBackendId: request.executionBackendId?.trim() || undefined,
      });
    } catch (error) {
      throw new ValidationError({
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (executionBackend.backendId === CODE_MODE_AIDER_ADAPTER_ID && !request.aider?.requestMarkdown?.trim()) {
      throw new ValidationError({ message: "Aider Code Mode runs require aider.requestMarkdown." });
    }
    const originSurface = normalizeCodeModeOriginSurface(request.originSurface);
    const sessionId = request.sessionId?.trim() || undefined;
    const turnId = request.turnId?.trim() || undefined;
    const chatSessionMeta = sessionId ? this.options.storage.chatSessionMeta.get(sessionId) : undefined;
    if (sessionId && !chatSessionMeta) {
      throw new ValidationError({ message: `Code Mode session ${sessionId} was not found.` });
    }
    if (turnId) {
      if (!sessionId) {
        throw new ValidationError({ message: "Code Mode turnId requires a sessionId." });
      }
      let turnTrace: ChatTurnTraceRecord;
      try {
        turnTrace = this.options.storage.chatTurnTraces.get(turnId);
      } catch {
        throw new ValidationError({ message: `Code Mode turn ${turnId} was not found.` });
      }
      if (turnTrace.sessionId !== sessionId) {
        throw new ValidationError({
          message: `Code Mode turn ${turnId} does not belong to session ${sessionId}.`,
        });
      }
    }
    const sessionWorkspaceId = chatSessionMeta?.workspaceId;
    const workspaceId = resolveCodeModeWorkspaceId({
      sessionId,
      requestWorkspaceId: request.workspaceId,
      sessionWorkspaceId,
    });
    const policyContext = this.options.resolvePolicyContext?.({
      operatorId: request.operatorId,
      workspaceId,
      sessionId,
      runId,
      surface: originSurface,
      permissionProfileId: request.permissionProfileId,
      localOperatorOverrideId: request.localOperatorOverrideId,
    });
    if (request.permissionProfileId && policyContext?.permissionProfileId !== request.permissionProfileId) {
      throw new ValidationError({
        message: `Permission profile ${request.permissionProfileId} is not active for this Code Mode run.`,
      });
    }
    if (request.localOperatorOverrideId && policyContext?.localOperatorOverrideId !== request.localOperatorOverrideId) {
      throw new ValidationError({
        message: `Local Operator Override ${request.localOperatorOverrideId} is not active for this Code Mode run.`,
      });
    }
    const autonomousActivation = request.autonomousActivation
      ? this.prepareCodeModeAutonomousActivation({
          workspaceId,
          surface: originSurface ?? "code",
          estimatedCostUsd: request.estimatedCostUsd,
        })
      : undefined;
    const policySnapshot = {
      ...this.options.readPolicySnapshot(),
      codeModePermissionContext: serializePolicyContext(policyContext),
      codeModeInput: runInput,
      codeModeInputHash: runInputHash,
      codeModeAutonomousActivation: autonomousActivation,
    };
    const policySnapshotHash = sha256Text(JSON.stringify(policySnapshot));

    const codeArtifact = await this.persistManagedTextArtifact(
      this.artifactRoot,
      [runId],
      `source.${request.language === "typescript" ? "ts" : "js"}`,
      source,
      request.language === "typescript" ? "text/typescript" : "text/javascript",
    );
    const wrapperManifestArtifact = await this.persistManagedJsonArtifact(
      this.artifactRoot,
      [runId],
      "wrapper-manifest.json",
      wrapperManifest,
    );
    const policySnapshotArtifact = await this.persistManagedJsonArtifact(
      this.artifactRoot,
      [runId],
      "policy-snapshot.json",
      policySnapshot,
    );

    const approvalPayload = buildCodeModeApprovalPayload({
      runId,
      workspaceId,
      codeHash,
      wrapperManifestHash,
      inputHash: runInputHash,
      capabilitySnapshotId: snapshot.snapshotId,
      requestedOutputIntent: request.requestedOutputIntent,
      saveCandidateOnSuccess: Boolean(request.saveCandidateOnSuccess),
      inspectPath: codeArtifact.relPath,
      codePreview: buildCodePreview(source),
      affectedResources: wrapperManifest.wrappers.map((wrapper) => wrapper.name),
      sessionId,
      turnId,
      originSurface,
      sandbox,
      permissionProfileId: policyContext?.permissionProfileId,
      permissionProfileLabel: policyContext?.permissionProfile?.label,
      localOperatorOverrideId: policyContext?.localOperatorOverrideId,
      executionBackend,
      autonomousActivation,
    });
    const approvalLinkage = buildCodeModeApprovalLinkage({
      workspaceId,
      runId,
      sessionId,
      turnId,
      originSurface,
      permissionProfileId: policyContext?.permissionProfileId,
      localOperatorOverrideId: policyContext?.localOperatorOverrideId,
    });

    const buildFailedRunRecord = (
      error: unknown,
      errorCode: "approval_create_failed" | "approval_registration_failed",
      phase: "approval_create" | "approval_registration",
      approvalId?: string,
      cleanup?: LateCodeModeApprovalCleanupResult,
    ): CodeModeRunRecord => {
      const normalized = normalizeCodeModeIpcError(error);
      const failedAt = new Date().toISOString();
      return this.options.storage.codeModeRuns.upsert({
        runId,
        status: "failed",
        language: request.language,
        originSurface,
        workspaceId,
        operatorId: request.operatorId,
        permissionProfileId: policyContext?.permissionProfileId,
        permissionProfileLabel: policyContext?.permissionProfile?.label,
        localOperatorOverrideId: policyContext?.localOperatorOverrideId,
        requestedOutputIntent: request.requestedOutputIntent,
        saveCandidateOnSuccess: Boolean(request.saveCandidateOnSuccess),
        capabilitySnapshotId: snapshot.snapshotId,
        codeModeInputHash: runInputHash,
        wrapperManifestHash,
        policySnapshotHash,
        codeHash,
        approvalId,
        sessionId,
        turnId,
        sandbox,
        executionBackend,
        executionRecovery: {
          generation: 0,
          phase: "terminal",
          disposition: "terminal",
          finalTranscriptEventId: sessionId ? `code-mode-final:${runId}` : undefined,
        },
        autonomousActivation,
        codeArtifact,
        wrapperManifestArtifact,
        policySnapshotArtifact,
        stdoutTruncated: false,
        stderrTruncated: false,
        error: normalized.message,
        errorCode,
        errorDetails: {
          phase,
          ...(approvalId ? { approvalId } : {}),
          ...(cleanup ? { lateApprovalCleanup: cleanup } : {}),
          ...(normalized.code ? { causeCode: normalized.code } : {}),
          ...(normalized.details ? { causeDetails: normalized.details } : {}),
        },
        createdAt,
        finishedAt: failedAt,
      });
    };
    const publishCreationFailure = (record: CodeModeRunRecord) => {
      this.options.publishRealtime("code_mode_run_failed", "capabilities", {
        runId: record.runId,
        approvalId: record.approvalId,
        capabilitySnapshotId: record.capabilitySnapshotId,
        originSurface,
        sandbox,
        permissionProfileId: record.permissionProfileId,
        localOperatorOverrideId: record.localOperatorOverrideId,
        autonomousActivation: record.autonomousActivation,
        errorCode: record.errorCode,
        error: record.error,
        errorDetails: record.errorDetails,
      });
    };

    let approval: ApprovalRequest;
    try {
      approval = await this.options.createApproval({
        kind: "code_mode.run",
        riskLevel: "caution",
        payload: approvalPayload,
        preview: approvalPayload,
        linkage: approvalLinkage,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    } catch (error) {
      const lateApprovalId = approvalIdFromApprovalCreateFailure(error);
      const cleanup = lateApprovalId
        ? await this.terminalizeLateFailedCodeModeApproval(lateApprovalId, error)
        : undefined;
      publishCreationFailure(
        buildFailedRunRecord(error, "approval_create_failed", "approval_create", lateApprovalId, cleanup),
      );
      throw error;
    }

    const runRecord: CodeModeRunRecord = {
      runId,
      status: "approval_pending",
      language: request.language,
      originSurface,
      workspaceId,
      operatorId: request.operatorId,
      permissionProfileId: policyContext?.permissionProfileId,
      permissionProfileLabel: policyContext?.permissionProfile?.label,
      localOperatorOverrideId: policyContext?.localOperatorOverrideId,
      requestedOutputIntent: request.requestedOutputIntent,
      saveCandidateOnSuccess: Boolean(request.saveCandidateOnSuccess),
      capabilitySnapshotId: snapshot.snapshotId,
      codeModeInputHash: runInputHash,
      wrapperManifestHash,
      policySnapshotHash,
      codeHash,
      approvalId: approval.approvalId,
      sessionId,
      turnId,
      sandbox,
      executionBackend,
      executionRecovery: {
        generation: 0,
        phase: "not_started",
        disposition: "none",
        finalTranscriptEventId: sessionId ? `code-mode-final:${runId}` : undefined,
      },
      autonomousActivation,
      codeArtifact,
      wrapperManifestArtifact,
      policySnapshotArtifact,
      stdoutTruncated: false,
      stderrTruncated: false,
      verification: {
        status: "not_applicable",
        updatedAt: createdAt,
      },
      createdAt,
    };

    let stored: CodeModeRunRecord | undefined;
    try {
      stored = this.options.storage.codeModeRuns.upsert(runRecord);
      this.options.storage.pendingApprovalActions.upsertPending({
        approvalId: approval.approvalId,
        actionType: "code_mode.run",
        request: {
          runId: stored.runId,
          input: runInput,
          aider: request.aider,
          originSurface,
          workspaceId,
          operatorId: request.operatorId,
          policyContext: serializePolicyContext(policyContext),
          autonomousActivation,
        },
        createdAt,
        expiresAt: approval.expiresAt,
      });
      this.options.storage.approvalEvents.append({
        approvalId: approval.approvalId,
        eventType: "pending_action_registered",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          runId: stored.runId,
          originSurface,
          permissionProfileId: stored.permissionProfileId,
          localOperatorOverrideId: stored.localOperatorOverrideId,
          autonomousActivation: stored.autonomousActivation,
        },
      });

      if (sessionId) {
        this.options.storage.chatInlineApprovals.upsert({
          approvalId: approval.approvalId,
          sessionId,
          turnId: turnId ?? `code-mode-${stored.runId}`,
          kind: "code_mode.run",
          toolName: "Code Mode v1",
          status: "pending",
          reason: asOptionalString(approvalPayload.description) ?? "Code Mode v1 run pending approval.",
          riskLevel: "caution",
          expiresAt: approval.expiresAt,
          details: approvalPayload,
          createdAt,
        });
      }
    } catch (error) {
      const failureDetails = {
        runId,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "approval_registration_failed",
      };
      publishCreationFailure(
        buildFailedRunRecord(error, "approval_registration_failed", "approval_registration", approval.approvalId),
      );
      try {
        this.options.storage.pendingApprovalActions.markResolved(approval.approvalId, "failed", failureDetails);
      } catch (pendingResolveError) {
        // If pending-action creation itself failed, there is nothing to resolve.
        void pendingResolveError;
      }
      try {
        await this.options.resolveApproval(approval.approvalId, {
          decision: "reject",
          resolvedBy: "system",
          resolutionNote: "Code Mode approval registration failed before execution could be queued.",
        });
      } catch (approvalResolveError) {
        void approvalResolveError;
      }
      try {
        this.options.storage.approvalEvents.append({
          approvalId: approval.approvalId,
          eventType: "pending_action_refused",
          actorId: "system",
          payload: {
            actionType: "code_mode.run",
            ...failureDetails,
          },
        });
      } catch (eventError) {
        void eventError;
      }
      throw error;
    }
    if (!stored) {
      throw new Error(`Code Mode run ${runId} registration failed before storage returned a row.`);
    }

    this.recordCodeModeCapabilityProfileDecision({
      run: stored,
      snapshot,
      sandbox,
      executionBackend,
      createdAt,
    });

    this.options.publishRealtime("code_mode_run_created", "capabilities", {
      runId: stored.runId,
      approvalId: stored.approvalId,
      capabilitySnapshotId: stored.capabilitySnapshotId,
      wrapperManifestHash: stored.wrapperManifestHash,
      codeHash: stored.codeHash,
      originSurface,
      sandbox,
      executionBackend,
      permissionProfileId: stored.permissionProfileId,
      localOperatorOverrideId: stored.localOperatorOverrideId,
      autonomousActivation: stored.autonomousActivation,
    });
    return this.hydrateCodeModeRunForRead(stored);
  }

  private recordCodeModeCapabilityProfileDecision(input: {
    run: CodeModeRunRecord;
    snapshot: CapabilityCatalogSnapshotRecord;
    sandbox: CodeModeSandboxMetadata;
    executionBackend: CodeModeRunExecutionBackendRef;
    createdAt: string;
  }): void {
    const runtimeDecisionTraces = this.options.storage.runtimeDecisionTraces as
      | { append: (record: RuntimeDecisionTraceAppendInput) => unknown }
      | undefined;
    if (!runtimeDecisionTraces) {
      return;
    }
    const callableToolCount = countCatalogEntries(input.snapshot.callableEntries, "tool");
    const callableSkillCount = countCatalogEntries(input.snapshot.callableEntries, "skill");
    const reviewWarningCount = input.snapshot.inspectableEntries.filter((entry) => Boolean(entry.reviewWarning)).length;
    const trace: RuntimeDecisionTraceAppendInput = {
      kind: "capability_profile_frozen",
      scope: {
        workspaceId: input.run.workspaceId,
        sessionId: input.run.sessionId,
        turnId: input.run.turnId,
        runId: input.run.runId,
        approvalId: input.run.approvalId,
      },
      selected: `Froze capability profile ${input.snapshot.snapshotId} for Code Mode approval.`,
      rationale:
        "Code Mode v1 captures the inspectable and callable catalog, policy posture, sandbox metadata, and execution backend before approval so operator review uses immutable evidence.",
      signals: [
        {
          source: "capability",
          key: "snapshot_id",
          value: input.snapshot.snapshotId,
          weight: "strong",
          evidence: {
            refType: "capability_snapshot",
            refId: input.snapshot.snapshotId,
            label: "Frozen capability catalog",
          },
        },
        {
          source: "capability",
          key: "inspectable_count",
          value: input.snapshot.inspectableEntries.length,
          weight: "informational",
        },
        {
          source: "capability",
          key: "callable_count",
          value: input.snapshot.callableEntries.length,
          weight: "strong",
        },
        { source: "capability", key: "callable_tools", value: callableToolCount, weight: "informational" },
        { source: "capability", key: "callable_skills", value: callableSkillCount, weight: "informational" },
        {
          source: "capability",
          key: "inspectable_only_count",
          value: input.snapshot.inspectableEntries.length - input.snapshot.callableEntries.length,
          weight: "informational",
        },
        {
          source: "capability",
          key: "review_warning_count",
          value: reviewWarningCount,
          weight: reviewWarningCount > 0 ? "weak" : "informational",
        },
        {
          source: "policy",
          key: "permission_profile",
          value: input.run.permissionProfileId ?? "default",
          weight: "strong",
        },
        {
          source: "policy",
          key: "local_operator_override",
          value: input.run.localOperatorOverrideId ?? "none",
          weight: input.run.localOperatorOverrideId ? "strong" : "informational",
        },
        {
          source: "policy",
          key: "sandbox_available",
          value: input.sandbox.available,
          weight: input.sandbox.available ? "strong" : "blocking",
        },
        {
          source: "policy",
          key: "execution_backend",
          value: input.executionBackend.backendId,
          weight: "strong",
        },
        {
          source: "approval",
          key: "approval_id",
          value: input.run.approvalId ?? null,
          weight: input.run.approvalId ? "strong" : "weak",
        },
      ],
      alternatives: [
        {
          label: "Use live callable catalog during execution",
          outcome: "blocked",
          reasonNotChosen: "A mutable catalog would not match the operator approval evidence.",
          blockedBy: "immutable capability snapshot required",
        },
        {
          label: "Skip capability profile evidence",
          outcome: "blocked",
          reasonNotChosen: "The operator could not audit which tools and skills were callable for the run.",
          blockedBy: "Code Mode approval truth contract",
        },
      ],
      evidenceRefs: [
        { refType: "capability_snapshot", refId: input.snapshot.snapshotId, label: "Frozen capability catalog" },
        { refType: "run", refId: input.run.runId, label: "Code Mode run" },
        ...(input.run.approvalId
          ? [{ refType: "approval" as const, refId: input.run.approvalId, label: "Code Mode approval" }]
          : []),
        ...(input.run.sessionId ? [{ refType: "session" as const, refId: input.run.sessionId }] : []),
        ...(input.run.turnId ? [{ refType: "turn" as const, refId: input.run.turnId }] : []),
      ],
      createdAt: input.createdAt,
    };
    try {
      runtimeDecisionTraces.append(trace);
    } catch (error) {
      void error;
    }
  }

  private prepareCodeModeAutonomousActivation(input: {
    workspaceId?: string;
    surface: CodeModeOriginSurface;
    estimatedCostUsd?: number;
  }): CodeModeAutonomousActivationEvidence {
    const result = this.autonomousActivationGrants.evaluateGrant({
      workspaceId: input.workspaceId,
      surface: input.surface,
      riskLevel: "danger",
      activationKind: "code_mode",
      capabilityId: "code-mode",
      toolName: "code.mode.run",
      estimatedCostUsd: input.estimatedCostUsd,
    });
    const evidence: CodeModeAutonomousActivationEvidence = {
      requested: true,
      allowed: result.allowed,
      matchedGrantId: result.matchedGrantId,
      riskLevel: "danger",
      governance: result.governance,
      blockers: result.blockers,
    };
    if (!result.allowed || !result.matchedGrantId) {
      throw new ValidationError({
        message: `Autonomous Code Mode activation requires an active matching operator grant. ${result.blockers.join(" ")}`,
      });
    }
    // Reserve the activation/budget against the grant at approval time, not after the run
    // completes. This is deliberate for a danger-risk autonomy path: reserving up front
    // prevents concurrently-prepared runs from collectively exceeding the operator's
    // activation/budget ceiling. The trade-off is that a later-aborted run still consumes
    // its reservation (conservative — it over-restricts, never over-permits).
    this.autonomousActivationGrants.recordGrantUse(result.matchedGrantId, input.estimatedCostUsd ?? 0);
    return evidence;
  }

  public async executeApprovedCodeModeRun(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    const pending = this.options.storage.pendingApprovalActions.find(approvalId);
    if (!pending || pending.resolutionStatus !== "pending" || pending.actionType !== "code_mode.run") {
      return this.terminalizeCodeModeRunForMissingPendingAction(approvalId);
    }
    const approval = this.options.storage.approvals.get(approvalId);
    const approvalRunId = approval.kind === "code_mode.run" ? resolveCodeModeApprovalRunId(approval) : undefined;
    const runId = asOptionalString(pending.request.runId);
    if (!runId) {
      const reason = "missing code mode run id";
      const terminalized = this.terminalizeCodeModeRunForCorruptPendingAction(approval, pending, {
        reason,
        errorCode: "RUN_ID_MISSING",
        terminalReason: "Code Mode pending action is missing its run id; approved run cannot execute safely.",
        terminalErrorCode: "pending_action_corrupt",
      });
      if (terminalized) {
        return terminalized;
      }
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", {
        reason,
      });
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "pending_action_refused",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          error: reason,
          errorCode: "RUN_ID_MISSING",
        },
      });
      this.options.publishRealtime("code_mode_run_refused", "capabilities", {
        approvalId,
        error: reason,
        errorCode: "RUN_ID_MISSING",
      });
      throw new NotFoundError({ entity: "code mode run", id: "missing" });
    }
    if (approvalRunId && approvalRunId !== runId) {
      const reason = `Code Mode pending action points at ${runId}, but approval ${approvalId} belongs to ${approvalRunId}.`;
      const terminalized = this.terminalizeCodeModeRunForCorruptPendingAction(approval, pending, {
        reason,
        errorCode: "RUN_ID_MISMATCH",
        terminalReason: "Code Mode pending action targets a different run; approved run cannot execute safely.",
        terminalErrorCode: "pending_action_corrupt",
      });
      if (terminalized) {
        return terminalized;
      }
    }

    let existing = this.options.storage.codeModeRuns.find(runId);
    if (!existing) {
      const terminalized = this.terminalizeCodeModeRunForCorruptPendingAction(approval, pending, {
        reason: `Code Mode run ${runId} is missing; approved pending action cannot execute.`,
        errorCode: "RUN_NOT_FOUND",
        terminalReason: "Code Mode pending action points at a missing run; approved run cannot execute safely.",
        terminalErrorCode: "pending_action_corrupt",
      });
      if (terminalized) {
        return terminalized;
      }
      const reason = `Code Mode run ${runId} is missing; approved pending action cannot execute.`;
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", { runId, reason });
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "pending_action_refused",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          runId,
          error: reason,
          errorCode: "RUN_NOT_FOUND",
        },
      });
      this.options.publishRealtime("code_mode_run_refused", "capabilities", {
        runId,
        approvalId,
        error: reason,
        errorCode: "RUN_NOT_FOUND",
      });
      throw new NotFoundError({ entity: "code mode run", id: runId });
    }
    if (existing.status === "running") {
      const recovered = recoverStaleCodeModeExecutionClaim(
        this.options.storage.codeModeRuns,
        existing,
        approvalId,
        new Date().toISOString(),
      );
      if (recovered) {
        existing = recovered;
        this.options.publishRealtime(
          existing.status === "approval_pending"
            ? "code_mode_run_claim_recovered"
            : "code_mode_run_manual_reconciliation_required",
          "capabilities",
          {
            runId: existing.runId,
            approvalId,
            status: existing.status,
            sandbox: existing.sandbox,
            executionRecovery: existing.executionRecovery,
          },
        );
      } else {
        this.options.publishRealtime("code_mode_run_refused", "capabilities", {
          runId: existing.runId,
          approvalId,
          status: existing.status,
          error: `Code Mode run ${runId} is already running.`,
          errorCode: "RUN_ALREADY_CLAIMED",
          sandbox: existing.sandbox,
        });
        return undefined;
      }
    }
    if (existing.status === "completed" || existing.status === "failed") {
      this.options.storage.pendingApprovalActions.markResolved(
        approvalId,
        existing.status === "completed" ? "executed" : "failed",
        {
          outcome: existing.status,
          runId: existing.runId,
          recoveredTerminalOutcome: true,
          executionRecovery: existing.executionRecovery,
          ...(existing.executionRecovery.disposition === "manual_reconciliation"
            ? { manualReconciliationRequired: true }
            : {}),
          ...(existing.error ? { error: existing.error } : {}),
          ...(existing.errorCode ? { errorCode: existing.errorCode } : {}),
          ...(existing.errorDetails ? { errorDetails: existing.errorDetails } : {}),
        },
      );
      this.enqueueCodeModeFinalTranscriptSafely(existing);
      await this.flushCodeModeFinalTranscriptOutbox();
      return buildCodeModeToolInvokeResult(existing);
    }
    if (existing.status !== "approval_pending") {
      const reason = `Code Mode run ${runId} is ${existing.status}; only approval_pending runs can execute.`;
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", { runId, reason });
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "pending_action_refused",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          runId: existing.runId,
          status: existing.status,
          error: reason,
        },
      });
      this.options.publishRealtime("code_mode_run_refused", "capabilities", {
        runId: existing.runId,
        approvalId,
        status: existing.status,
        error: reason,
        errorCode: "INVALID_RUN_STATE",
        sandbox: existing.sandbox,
      });
      throw new ConflictError({ message: reason });
    }
    if (approval.kind !== "code_mode.run" || approval.status !== "approved") {
      const reason =
        approval.kind !== "code_mode.run"
          ? `approval kind ${approval.kind} cannot execute Code Mode`
          : `approval status is ${approval.status}`;
      const refusedAt = new Date().toISOString();
      const refusedRun = this.options.storage.codeModeRuns.upsert({
        ...existing,
        status: "failed",
        error: reason,
        sandbox: existing.sandbox ?? this.resolveCurrentSandboxMetadata(),
        finishedAt: refusedAt,
      });
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", { reason });
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "pending_action_refused",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          runId: refusedRun.runId,
          status: refusedRun.status,
          error: reason,
        },
      });
      this.options.publishRealtime("code_mode_run_failed", "capabilities", {
        runId: refusedRun.runId,
        approvalId,
        status: refusedRun.status,
        error: reason,
        sandbox: refusedRun.sandbox,
      });
      throw new ConflictError({ message: `Code Mode run ${runId} refused: ${reason}.` });
    }
    if (!isCodeModePendingActionExecutable(pending, approval)) {
      const reason = "Code Mode pending action expired before approval execution";
      const refusedAt = new Date().toISOString();
      const refusedRun = this.options.storage.codeModeRuns.upsert({
        ...existing,
        status: "expired",
        error: reason,
        sandbox: existing.sandbox ?? this.resolveCurrentSandboxMetadata(),
        finishedAt: refusedAt,
      });
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", { reason });
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "pending_action_refused",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          runId: refusedRun.runId,
          status: refusedRun.status,
          error: reason,
          pendingExpiresAt: pending.expiresAt,
          approvalResolvedAt: approval.resolvedAt,
        },
      });
      this.options.publishRealtime("code_mode_run_failed", "capabilities", {
        runId: refusedRun.runId,
        approvalId,
        status: refusedRun.status,
        error: reason,
        sandbox: refusedRun.sandbox,
      });
      throw new ConflictError({ message: `Code Mode run ${runId} refused: ${reason}.` });
    }
    let sandbox = this.resolveCurrentSandboxMetadata();
    let finalRun = existing;
    let claimStartedAt: string | undefined;
    let claimGeneration: number | undefined;

    try {
      assertApprovedSandboxPostureStillCurrent(existing.sandbox, sandbox);
      if (existing.approvalId && existing.approvalId !== approvalId) {
        throw new ConflictError({
          message: `Code Mode approval ${approvalId} is not linked to run ${runId}.`,
        });
      }
      throwIfCapabilitySystemAborted(signal, `Code mode run ${runId} was aborted before execution claim.`);
      if (!sandbox.available) {
        this.options.publishRealtime("code_mode_sandbox_unavailable", "capabilities", {
          runId,
          approvalId,
          sandbox,
          failClosedReason: sandbox.failClosedReason,
        });
      }
      assertCodeModeSandboxAvailable(sandbox);
      claimStartedAt = new Date().toISOString();
      const claimedRun = this.options.storage.codeModeRuns.claimForExecution({
        runId,
        approvalId,
        sandbox,
        startedAt: claimStartedAt,
      });
      if (!claimedRun) {
        const currentRun = this.options.storage.codeModeRuns.find(runId);
        this.options.publishRealtime("code_mode_run_refused", "capabilities", {
          runId,
          approvalId,
          status: currentRun?.status ?? "missing",
          error: `Code Mode run ${runId} was already claimed or is no longer approval_pending.`,
          sandbox: currentRun?.sandbox ?? existing.sandbox,
        });
        return undefined;
      }
      finalRun = claimedRun;
      claimGeneration = claimedRun.executionRecovery.generation;
      const activeClaimStartedAt = claimStartedAt;
      const activeClaimGeneration = claimGeneration;
      this.options.publishRealtime("code_mode_run_started", "capabilities", {
        runId,
        approvalId,
        startedAt: claimStartedAt,
        executionGeneration: claimGeneration,
        sandbox,
      });
      throwIfCapabilitySystemAborted(signal, `Code mode run ${runId} was aborted after execution claim.`);
      const source = await this.readVerifiedManagedArtifactText(finalRun.codeArtifact, {
        label: "Code Mode source artifact",
        expectedSha256: finalRun.codeHash,
      });
      const wrapperManifestRaw = await this.readVerifiedManagedArtifactText(finalRun.wrapperManifestArtifact, {
        label: "Code Mode wrapper manifest artifact",
      });
      const policySnapshotRaw = await this.readVerifiedManagedArtifactText(finalRun.policySnapshotArtifact, {
        label: "Code Mode policy snapshot artifact",
      });
      const wrapperManifest = JSON.parse(wrapperManifestRaw) as CodeModeWrapperManifest;
      const policySnapshot = JSON.parse(policySnapshotRaw) as Record<string, unknown>;
      assertJsonValueHash(wrapperManifest, finalRun.wrapperManifestHash, "Code Mode wrapper manifest artifact");
      assertJsonValueHash(policySnapshot, finalRun.policySnapshotHash, "Code Mode policy snapshot artifact");
      const runPolicyContext = buildCodeModeRunPolicyContext({
        run: finalRun,
        pendingRequest: pending.request,
        policySnapshot,
      });
      assertCodeModeRunPolicyContextMatchesStoredRun(finalRun, runPolicyContext);
      const livePolicyContext = this.options.resolvePolicyContext?.({
        operatorId: finalRun.operatorId,
        workspaceId: finalRun.workspaceId,
        sessionId: finalRun.sessionId,
        runId: finalRun.runId,
        surface: normalizeCodeModeOriginSurface(finalRun.originSurface),
        permissionProfileId: finalRun.permissionProfileId,
        localOperatorOverrideId: finalRun.localOperatorOverrideId,
      });
      assertLiveCodeModePolicyContextMatchesStoredRun(finalRun, livePolicyContext);
      const runInput = readFrozenCodeModeInput(policySnapshot, pending.request.input, finalRun.codeModeInputHash);
      const wrapperPolicyContext = buildCodeModeWrapperPolicyContext(runPolicyContext, finalRun);
      const compiledSource = transpileGuestSource(finalRun.language, source);
      throwIfCapabilitySystemAborted(signal, `Code mode run ${runId} was aborted before execution started.`);
      const beforeExecutionDispatch = async () => {
        throwIfCapabilitySystemAborted(signal, `Code mode run ${runId} was aborted before execution dispatch.`);
        const boundaryCrossedAt = new Date().toISOString();
        const boundaryRun = this.options.storage.codeModeRuns.markExecutionBoundaryCrossed({
          runId,
          approvalId,
          startedAt: activeClaimStartedAt,
          executionGeneration: activeClaimGeneration,
          boundaryCrossedAt,
        });
        if (!boundaryRun) {
          throw new ConflictError({ message: `Code Mode run ${runId} execution claim moved before dispatch.` });
        }
        finalRun = boundaryRun;
        this.options.publishRealtime("code_mode_execution_boundary_crossed", "capabilities", {
          runId,
          approvalId,
          startedAt: claimStartedAt,
          executionGeneration: claimGeneration,
          boundaryCrossedAt,
        });
      };
      const onExecutionDispatchFailed = async () => {
        const resetRun = this.options.storage.codeModeRuns.resetExecutionBoundaryBeforeDispatch({
          runId,
          approvalId,
          startedAt: activeClaimStartedAt,
          executionGeneration: activeClaimGeneration,
        });
        if (resetRun) {
          finalRun = resetRun;
        }
      };
      const execution =
        finalRun.executionBackend?.backendId === CODE_MODE_AIDER_ADAPTER_ID
          ? await this.executeAiderAdapterRun({
              runId,
              sandbox,
              executionBackend: finalRun.executionBackend,
              language: finalRun.language,
              source,
              pendingAiderRequest: pending.request.aider,
              beforeExecutionDispatch,
              onExecutionDispatchFailed,
              signal,
            })
          : await this.executeGovernedChildHarness({
              runId,
              sandbox,
              executionBackend: finalRun.executionBackend,
              source: compiledSource,
              input: runInput,
              requestedOutputIntent: finalRun.requestedOutputIntent,
              wrapperManifest,
              policyContext: wrapperPolicyContext,
              workspaceId: finalRun.workspaceId,
              parentSessionId: finalRun.sessionId,
              beforeExecutionDispatch,
              onExecutionDispatchFailed,
              signal,
            });

      let stdoutArtifact: CapabilityArtifactRecord | undefined;
      let stderrArtifact: CapabilityArtifactRecord | undefined;
      if (execution.stdout.text.length > 0) {
        stdoutArtifact = await this.persistManagedTextArtifact(
          this.artifactRoot,
          [runId],
          "stdout.log",
          execution.stdout.text,
          "text/plain",
        );
      }
      if (execution.stderr.text.length > 0) {
        stderrArtifact = await this.persistManagedTextArtifact(
          this.artifactRoot,
          [runId],
          "stderr.log",
          execution.stderr.text,
          "text/plain",
        );
      }

      const finishedAt = new Date().toISOString();
      const trustedCodeWriteVerification = buildTrustedCodeWriteVerification({
        verifiedAt: finishedAt,
        source: { artifact: finalRun.codeArtifact, expectedSha256: finalRun.codeHash, content: source },
        wrapperManifest: {
          artifact: finalRun.wrapperManifestArtifact,
          content: wrapperManifestRaw,
        },
        policySnapshot: {
          artifact: finalRun.policySnapshotArtifact,
          content: policySnapshotRaw,
        },
        stdout: stdoutArtifact ? { artifact: stdoutArtifact, content: execution.stdout.text } : undefined,
        stderr: stderrArtifact ? { artifact: stderrArtifact, content: execution.stderr.text } : undefined,
      });
      const executionResult = attachTrustedCodeWriteVerification(execution.result, trustedCodeWriteVerification);
      const outputRun = this.options.storage.codeModeRuns.recordExecutionOutput({
        ...finalRun,
        sandbox,
        stdoutArtifact,
        stderrArtifact,
        stdoutPreview: toPreview(execution.stdout.text),
        stderrPreview: toPreview(execution.stderr.text),
        stdoutTruncated: execution.stdout.truncated,
        stderrTruncated: execution.stderr.truncated,
        trustedCodeWriteVerification,
        verification: execution.failed
          ? { status: "not_applicable", updatedAt: finishedAt }
          : {
              status: "completed_unverified",
              reason: "Execution completed; no fresh named semantic proof has been recorded.",
              updatedAt: finishedAt,
            },
        result: executionResult,
        error: execution.error,
        errorCode: execution.errorCode,
        errorDetails: execution.errorDetails,
        approvalId,
        startedAt: claimStartedAt,
        executionGeneration: claimGeneration,
        executionPhase: execution.failed ? "output_captured_failed" : "output_captured_completed",
      });
      if (!outputRun) {
        return this.handleLostCodeModeExecutionClaim({
          runId,
          approvalId,
          claimStartedAt,
          claimGeneration,
          sandbox,
        });
      }
      finalRun = outputRun;
      const interruptionReason = signal?.aborted
        ? signal.reason instanceof Error
          ? signal.reason.message
          : typeof signal.reason === "string"
            ? signal.reason
            : `Code mode run ${runId} was interrupted after execution started.`
        : execution.manualReconciliationReason;
      const terminalRun = interruptionReason
        ? this.options.storage.codeModeRuns.markExecutionInterrupted({
            runId,
            approvalId,
            startedAt: claimStartedAt,
            executionGeneration: claimGeneration,
            interruptedAt: finishedAt,
            interruptionReason,
            errorDetails: {
              phase: "after_execution_boundary",
              completedOutputPrefixPersisted: true,
              ...(execution.errorCode ? { childErrorCode: execution.errorCode } : {}),
              ...(execution.errorDetails ? { childErrorDetails: execution.errorDetails } : {}),
            },
          })
        : this.options.storage.codeModeRuns.finishExecutionClaim({
            ...finalRun,
            status: execution.failed ? "failed" : "completed",
            verification: execution.failed
              ? { status: "not_applicable", updatedAt: finishedAt }
              : {
                  status: "completed_unverified",
                  reason: "Execution completed; no fresh named semantic proof has been recorded.",
                  updatedAt: finishedAt,
                },
            approvalId,
            startedAt: claimStartedAt,
            finishedAt,
          });
      if (!terminalRun) {
        return this.handleLostCodeModeExecutionClaim({
          runId,
          approvalId,
          claimStartedAt,
          claimGeneration,
          sandbox,
        });
      }
      finalRun = terminalRun;
      if (finalRun.executionRecovery.disposition === "manual_reconciliation") {
        this.options.publishRealtime("code_mode_run_interrupted", "capabilities", {
          runId: finalRun.runId,
          approvalId,
          status: finalRun.status,
          error: finalRun.error,
          errorCode: finalRun.errorCode,
          executionRecovery: finalRun.executionRecovery,
          sandbox,
        });
      }

      if (
        finalRun.status === "completed" &&
        finalRun.executionRecovery.phase === "terminal" &&
        finalRun.executionRecovery.disposition !== "manual_reconciliation" &&
        !execution.failed &&
        finalRun.saveCandidateOnSuccess &&
        finalRun.executionBackend?.backendId !== CODE_MODE_AIDER_ADAPTER_ID
      ) {
        try {
          await this.stageCandidateBundle(finalRun, source, wrapperManifest, runInput);
        } catch (candidateError) {
          const message = candidateError instanceof Error ? candidateError.message : String(candidateError);
          finalRun = this.options.storage.codeModeRuns.upsert({
            ...finalRun,
            status: "failed",
            error: message,
            errorCode: "candidate_stage_failed",
            errorDetails: {
              phase: "candidate_stage",
              approvalId,
            },
            finishedAt: new Date().toISOString(),
          });
          this.options.publishRealtime("candidate_skill_stage_failed", "capabilities", {
            runId: finalRun.runId,
            approvalId,
            error: message,
          });
        }
      }

      this.options.storage.pendingApprovalActions.markResolved(
        approvalId,
        finalRun.status === "completed" ? "executed" : "failed",
        {
          outcome: finalRun.status,
          runId: finalRun.runId,
          executionRecovery: finalRun.executionRecovery,
          ...(finalRun.executionRecovery.disposition === "manual_reconciliation"
            ? { manualReconciliationRequired: true }
            : {}),
          ...(finalRun.error ? { error: finalRun.error } : {}),
          ...(finalRun.errorCode ? { errorCode: finalRun.errorCode } : {}),
          ...(finalRun.errorDetails ? { errorDetails: finalRun.errorDetails } : {}),
        },
      );
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "approved_action_executed",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          runId: finalRun.runId,
          status: finalRun.status,
        },
      });
      this.options.publishRealtime(
        finalRun.status === "completed" ? "code_mode_run_completed" : "code_mode_run_failed",
        "capabilities",
        {
          runId: finalRun.runId,
          approvalId,
          status: finalRun.status,
          error: finalRun.error,
          errorCode: finalRun.errorCode,
          errorDetails: finalRun.errorDetails,
          trustedCodeWriteVerification: finalRun.trustedCodeWriteVerification,
          verification: finalRun.verification,
          sandbox,
        },
      );
      this.enqueueCodeModeFinalTranscriptSafely(finalRun);
      await this.flushCodeModeFinalTranscriptOutbox();

      return {
        outcome: "executed",
        policyReason: `code_mode_run:${finalRun.status}`,
        auditEventId: `code-mode-${finalRun.runId}`,
        result: {
          runId: finalRun.runId,
          status: finalRun.status,
          codeHash: finalRun.codeHash,
          trustedCodeWriteVerification: finalRun.trustedCodeWriteVerification,
          verification: finalRun.verification,
          ...(finalRun.error ? { error: finalRun.error } : {}),
          ...(finalRun.errorCode ? { errorCode: finalRun.errorCode } : {}),
          ...(finalRun.errorDetails ? { errorDetails: finalRun.errorDetails } : {}),
          sandbox,
        },
      };
    } catch (error) {
      if (error instanceof CodeModeSandboxLaunchFailure) {
        sandbox = error.sandbox;
      }
      const interrupted = isCodeModeExecutionInterrupted(error, signal);
      const retryablePreDispatchFailure =
        error instanceof CodeModeSandboxLaunchFailure ||
        error instanceof CodeModeExecutionPreDispatchFailure ||
        error instanceof CodeModeExecutionBackendUnavailableError;
      if (interrupted || retryablePreDispatchFailure) {
        const interruptedAt = new Date().toISOString();
        const interruptionReason = error instanceof Error ? error.message : String(error);
        if (claimStartedAt && claimGeneration !== undefined) {
          if (finalRun.executionRecovery.phase === "claimed") {
            finalRun =
              this.options.storage.codeModeRuns.releaseExecutionClaim({
                runId,
                approvalId,
                startedAt: claimStartedAt,
                executionGeneration: claimGeneration,
                interruptedAt,
                interruptionReason,
                sandbox,
              }) ?? finalRun;
          } else {
            finalRun =
              this.options.storage.codeModeRuns.markExecutionInterrupted({
                runId,
                approvalId,
                startedAt: claimStartedAt,
                executionGeneration: claimGeneration,
                interruptedAt,
                interruptionReason,
                errorDetails: {
                  phase: "after_execution_boundary",
                  completedOutputPrefixPersisted: Boolean(finalRun.stdoutArtifact || finalRun.stderrArtifact),
                },
              }) ?? finalRun;
          }
        }
        this.options.publishRealtime(
          retryablePreDispatchFailure && finalRun.status === "approval_pending"
            ? "code_mode_run_dispatch_deferred"
            : "code_mode_run_interrupted",
          "capabilities",
          {
            runId,
            approvalId,
            status: finalRun.status,
            error: interruptionReason,
            executionRecovery: finalRun.executionRecovery,
            sandbox,
          },
        );
        if (finalRun.status === "failed") {
          this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", {
            runId,
            error: finalRun.error,
            errorCode: finalRun.errorCode,
            manualReconciliationRequired: true,
          });
          this.enqueueCodeModeFinalTranscriptSafely(finalRun);
          await this.flushCodeModeFinalTranscriptOutbox();
          return buildCodeModeToolInvokeResult(finalRun);
        }
        return undefined;
      }
      const normalizedError = normalizeCodeModeIpcError(error);
      const failedAt = new Date().toISOString();
      if (claimStartedAt && claimGeneration !== undefined) {
        const terminalRun =
          finalRun.executionRecovery.phase === "claimed"
            ? this.options.storage.codeModeRuns.failExecutionClaimBeforeDispatch({
                runId,
                approvalId,
                startedAt: claimStartedAt,
                executionGeneration: claimGeneration,
                finishedAt: failedAt,
                error: normalizedError.message,
                errorCode: normalizedError.code,
                errorDetails: normalizedError.details,
              })
            : this.options.storage.codeModeRuns.markExecutionInterrupted({
                runId,
                approvalId,
                startedAt: claimStartedAt,
                executionGeneration: claimGeneration,
                interruptedAt: failedAt,
                interruptionReason: normalizedError.message,
                errorDetails: {
                  phase: "after_execution_boundary",
                  completedOutputPrefixPersisted: Boolean(finalRun.stdoutArtifact || finalRun.stderrArtifact),
                  childErrorCode: normalizedError.code,
                  childErrorDetails: normalizedError.details,
                },
              });
        if (!terminalRun) {
          return this.handleLostCodeModeExecutionClaim({
            runId,
            approvalId,
            claimStartedAt,
            claimGeneration,
            sandbox,
          });
        }
        finalRun = terminalRun;
      } else {
        finalRun = this.options.storage.codeModeRuns.upsert({
          ...finalRun,
          status: "failed",
          sandbox,
          error: normalizedError.message,
          errorCode: normalizedError.code,
          errorDetails: normalizedError.details,
          startedAt: finalRun.startedAt,
          finishedAt: failedAt,
        });
      }
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", {
        runId: finalRun.runId,
        error: finalRun.error,
        errorCode: finalRun.errorCode,
        errorDetails: finalRun.errorDetails,
      });
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "approved_action_executed",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          runId: finalRun.runId,
          status: finalRun.status,
          error: finalRun.error,
          errorCode: finalRun.errorCode,
          errorDetails: finalRun.errorDetails,
        },
      });
      this.options.publishRealtime("code_mode_run_failed", "capabilities", {
        runId: finalRun.runId,
        approvalId,
        error: finalRun.error,
        errorCode: finalRun.errorCode,
        errorDetails: finalRun.errorDetails,
        sandbox,
      });
      this.enqueueCodeModeFinalTranscriptSafely(finalRun);
      await this.flushCodeModeFinalTranscriptOutbox();
      return {
        outcome: "executed",
        policyReason: "code_mode_run:failed",
        auditEventId: `code-mode-${finalRun.runId}`,
        result: {
          runId: finalRun.runId,
          status: finalRun.status,
          error: finalRun.error,
          ...(finalRun.errorCode ? { errorCode: finalRun.errorCode } : {}),
          ...(finalRun.errorDetails ? { errorDetails: finalRun.errorDetails } : {}),
          sandbox,
        },
      };
    }
  }

  /**
   * Re-enqueue terminal Code Mode summaries that were committed before a
   * previous process could publish their deterministic transcript event.
   * The outbox event id is stable, so repeated boots remain idempotent.
   */
  public reconcileCodeModeFinalTranscriptDeliveries(limit = 500): {
    checked: number;
    enqueued: number;
    errors: string[];
    omittedErrors: number;
  } {
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 500;
    const pageSize = Math.max(1, Math.min(normalizedLimit, 500));
    const errors: string[] = [];
    let retainedErrorBytes = 0;
    let omittedErrors = 0;
    let enqueued = 0;
    let checked = 0;
    let cursor: { finishedAt: string; runId: string } | undefined;
    while (true) {
      const pending = this.options.storage.codeModeRuns.listPendingFinalTranscriptDeliveryPage({
        afterFinishedAt: cursor?.finishedAt,
        afterRunId: cursor?.runId,
        limit: pageSize,
      });
      if (pending.length === 0) {
        break;
      }
      checked += pending.length;
      for (const run of pending) {
        try {
          if (this.enqueueCodeModeFinalTranscript(run)) {
            enqueued += 1;
          }
        } catch (error) {
          const boundedError = boundRedactedError(`${run.runId}: ${errorMessage(error)}`);
          const boundedErrorBytes = Buffer.byteLength(boundedError, "utf8");
          if (
            errors.length >= CODE_MODE_RECOVERY_ERRORS_MAX_ENTRIES ||
            retainedErrorBytes + boundedErrorBytes > CODE_MODE_RECOVERY_ERRORS_TOTAL_LIMIT_BYTES
          ) {
            omittedErrors += 1;
          } else {
            errors.push(boundedError);
            retainedErrorBytes += boundedErrorBytes;
          }
        }
      }
      const last = pending.at(-1)!;
      cursor = { finishedAt: last.finishedAt ?? last.createdAt, runId: last.runId };
      if (pending.length < pageSize) {
        break;
      }
    }
    return { checked, enqueued, errors, omittedErrors };
  }

  private enqueueCodeModeFinalTranscriptSafely(run: CodeModeRunRecord): boolean {
    try {
      return this.enqueueCodeModeFinalTranscript(run);
    } catch (error) {
      try {
        this.options.publishRealtime("code_mode_transcript_delivery_deferred", "capabilities", {
          runId: run.runId,
          error: boundRedactedError(errorMessage(error)),
        });
      } catch (diagnosticError) {
        void diagnosticError;
        // The durable run/outbox remain authoritative when diagnostics fail.
      }
      return false;
    }
  }

  private enqueueCodeModeFinalTranscript(run: CodeModeRunRecord): boolean {
    const eventId = run.executionRecovery.finalTranscriptEventId;
    if (
      !run.sessionId ||
      !eventId ||
      run.executionRecovery.finalTranscriptEnqueuedAt ||
      (run.status !== "completed" && run.status !== "failed")
    ) {
      return false;
    }
    if (
      !this.options.storage.sessions ||
      !this.options.storage.chatMessages ||
      !this.options.storage.transcriptOutbox ||
      !this.options.storage.runImmediateTransaction
    ) {
      return false;
    }
    const session = this.options.storage.sessions.getBySessionId(run.sessionId);
    const timestamp = run.finishedAt ?? new Date().toISOString();
    const message: ChatMessageRecord = {
      messageId: eventId,
      sessionId: run.sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "code-mode",
      content: buildCodeModeFinalTranscriptContent(run),
      timestamp,
    };
    const event: TranscriptEvent = {
      eventId,
      actionId: `code-mode:${run.runId}`,
      idempotencyKey: `code-mode-final:${run.runId}:${run.executionRecovery.generation}`,
      sessionId: run.sessionId,
      sessionKey: session.sessionKey,
      timestamp,
      type: "message.assistant",
      actorType: "agent",
      actorId: "code-mode",
      payload: { message },
    };
    const wasQueued = Boolean(this.options.storage.transcriptOutbox.get(eventId));
    this.options.storage.runImmediateTransaction(() => {
      const latest = this.options.storage.codeModeRuns.get(run.runId);
      if (
        latest.executionRecovery.finalTranscriptEnqueuedAt ||
        latest.executionRecovery.generation !== run.executionRecovery.generation ||
        latest.executionRecovery.finalTranscriptEventId !== eventId ||
        (latest.status !== "completed" && latest.status !== "failed")
      ) {
        return;
      }
      this.options.storage.chatMessages.upsert(message, timestamp);
      this.options.storage.transcriptOutbox.enqueue(event, timestamp);
      this.options.storage.codeModeRuns.markFinalTranscriptEnqueued({
        runId: latest.runId,
        executionGeneration: latest.executionRecovery.generation,
        eventId,
        enqueuedAt: timestamp,
      });
    });
    return !wasQueued && Boolean(this.options.storage.transcriptOutbox.get(eventId));
  }

  private async flushCodeModeFinalTranscriptOutbox(): Promise<void> {
    if (!this.options.flushTranscriptOutbox) {
      return;
    }
    try {
      await this.options.flushTranscriptOutbox();
    } catch (error) {
      try {
        this.options.publishRealtime("code_mode_transcript_delivery_deferred", "capabilities", {
          error: boundRedactedError(errorMessage(error)),
        });
      } catch (diagnosticError) {
        void diagnosticError;
        // Delivery is still durable and will be retried on the next drain.
      }
    }
  }

  private handleLostCodeModeExecutionClaim(input: {
    runId: string;
    approvalId: string;
    claimStartedAt: string;
    claimGeneration: number;
    sandbox: CodeModeSandboxMetadata;
  }): undefined {
    const currentRun = this.options.storage.codeModeRuns.find(input.runId);
    const reason = `Code Mode run ${input.runId} execution claim moved before terminal update.`;
    this.options.storage.approvalEvents.append({
      approvalId: input.approvalId,
      eventType: "code_mode_execution_claim_lost",
      actorId: "system",
      payload: {
        actionType: "code_mode.run",
        runId: input.runId,
        status: currentRun?.status ?? "missing",
        startedAt: input.claimStartedAt,
        executionGeneration: input.claimGeneration,
        currentStartedAt: currentRun?.startedAt,
        currentExecutionGeneration: currentRun?.executionRecovery.generation,
        error: reason,
      },
    });
    this.options.publishRealtime("code_mode_run_claim_lost", "capabilities", {
      runId: input.runId,
      approvalId: input.approvalId,
      status: currentRun?.status ?? "missing",
      startedAt: input.claimStartedAt,
      executionGeneration: input.claimGeneration,
      currentStartedAt: currentRun?.startedAt,
      currentExecutionGeneration: currentRun?.executionRecovery.generation,
      error: reason,
      sandbox: currentRun?.sandbox ?? input.sandbox,
    });
    return undefined;
  }

  private async terminalizeLateFailedCodeModeApproval(
    approvalId: string,
    error: unknown,
  ): Promise<LateCodeModeApprovalCleanupResult> {
    const normalized = normalizeCodeModeIpcError(error);
    const cleanupErrors: string[] = [];
    try {
      await this.options.resolveApproval(approvalId, {
        decision: "reject",
        resolvedBy: "system",
        resolutionNote: `Code Mode approval creation failed after the approval row was created: ${normalized.message}`,
      });
    } catch (resolveError) {
      cleanupErrors.push(
        `approval_reject_failed: ${resolveError instanceof Error ? resolveError.message : String(resolveError)}`,
      );
    }
    try {
      this.options.storage.approvalEvents.append({
        approvalId,
        eventType: "pending_action_refused",
        actorId: "system",
        payload: {
          actionType: "code_mode.run",
          phase: "approval_create",
          error: normalized.message,
          errorCode: "approval_create_failed",
        },
      });
    } catch (eventError) {
      cleanupErrors.push(
        `approval_event_append_failed: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
      );
    }
    return {
      approvalId,
      attempted: true,
      status: cleanupErrors.length > 0 ? "failed" : "completed",
      errors: cleanupErrors,
    };
  }

  private hydrateCodeModeRunForRead(run: CodeModeRunRecord): CodeModeRunRecord {
    const hydrated = this.hydrateCodeModeRunLinkage(
      this.terminalizeExpiredCodeModeRun(this.terminalizeResolvedCodeModeRunWithMissingPendingAction(run)),
    );
    return this.codeModeVerification?.refreshRun(hydrated) ?? hydrated;
  }

  private terminalizeCodeModeRunForMissingPendingAction(approvalId: string): ToolInvokeResult | undefined {
    let approval: ApprovalRequest;
    try {
      approval = this.options.storage.approvals.get(approvalId);
    } catch {
      return undefined;
    }
    const runId = resolveCodeModeApprovalRunId(approval);
    if (approval.kind !== "code_mode.run" || !runId || !isResolvedCodeModeApprovalStatus(approval.status)) {
      return undefined;
    }
    const run = this.options.storage.codeModeRuns.find(runId);
    if (!run) {
      this.appendCodeModeMissingPendingActionEvent(approval, undefined, {
        status: "missing",
        error: `Code Mode run ${runId} is missing while recovering a resolved approval without a pending action.`,
        errorCode: "RUN_NOT_FOUND",
      });
      return {
        outcome: "blocked",
        policyReason: "code_mode_run:pending_action_missing",
        auditEventId: `code-mode-${runId}`,
        result: {
          runId,
          status: "missing",
          errorCode: "RUN_NOT_FOUND",
        },
      };
    }
    const terminal = this.terminalizeResolvedCodeModeRunWithMissingPendingAction(run, approval);
    return {
      outcome: "executed",
      policyReason: `code_mode_run:${terminal.status}`,
      auditEventId: `code-mode-${terminal.runId}`,
      result: {
        runId: terminal.runId,
        status: terminal.status,
        ...(terminal.error ? { error: terminal.error } : {}),
        ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
        ...(terminal.errorDetails ? { errorDetails: terminal.errorDetails } : {}),
        sandbox: terminal.sandbox,
      },
    };
  }

  private terminalizeCodeModeRunForCorruptPendingAction(
    approval: ApprovalRequest,
    pending: PendingApprovalAction,
    input: {
      reason: string;
      errorCode: string;
      terminalReason: string;
      terminalErrorCode: string;
    },
  ): ToolInvokeResult | undefined {
    const runId = resolveCodeModeApprovalRunId(approval);
    if (approval.kind !== "code_mode.run" || !runId || !isResolvedCodeModeApprovalStatus(approval.status)) {
      return undefined;
    }
    const run = this.options.storage.codeModeRuns.find(runId);
    if (!run) {
      const pendingRunId = pending.request.runId === undefined ? null : asOptionalString(pending.request.runId);
      this.options.storage.pendingApprovalActions.markResolved(approval.approvalId, "failed", {
        runId,
        pendingRunId,
        reason: input.reason,
        errorCode: input.errorCode,
      });
      this.appendCodeModeMissingPendingActionEvent(approval, undefined, {
        status: "missing",
        pendingRunId,
        error: input.reason,
        errorCode: input.errorCode,
      });
      this.options.publishRealtime("code_mode_run_refused", "capabilities", {
        runId,
        approvalId: approval.approvalId,
        pendingRunId,
        error: input.reason,
        errorCode: input.errorCode,
      });
      return {
        outcome: "blocked",
        policyReason: "code_mode_run:pending_action_corrupt",
        auditEventId: `code-mode-${runId}`,
        result: {
          runId,
          status: "missing",
          errorCode: input.errorCode,
        },
      };
    }
    const pendingRunId = pending.request.runId === undefined ? null : asOptionalString(pending.request.runId);
    this.options.storage.pendingApprovalActions.markResolved(approval.approvalId, "failed", {
      runId: run.runId,
      pendingRunId,
      reason: input.reason,
      errorCode: input.errorCode,
    });
    const terminal = this.terminalizeResolvedCodeModeRunWithMissingPendingAction(run, approval, {
      force: true,
      reason: input.terminalReason,
      errorCode: input.terminalErrorCode,
      errorDetailsReason: "pending_action_corrupt",
      pendingRunId,
    });
    return {
      outcome: "executed",
      policyReason: `code_mode_run:${terminal.status}`,
      auditEventId: `code-mode-${terminal.runId}`,
      result: {
        runId: terminal.runId,
        status: terminal.status,
        ...(terminal.error ? { error: terminal.error } : {}),
        ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
        ...(terminal.errorDetails ? { errorDetails: terminal.errorDetails } : {}),
        sandbox: terminal.sandbox,
      },
    };
  }

  private terminalizeResolvedCodeModeRunWithMissingPendingAction(
    run: CodeModeRunRecord,
    approvalInput?: ApprovalRequest,
    options?: {
      force?: boolean;
      reason?: string;
      errorCode?: string;
      errorDetailsReason?: string;
      pendingRunId?: string | null;
    },
  ): CodeModeRunRecord {
    if (run.status !== "approval_pending" || !run.approvalId) {
      return run;
    }
    const pending = this.options.storage.pendingApprovalActions.find(run.approvalId);
    if (!options?.force && pending?.resolutionStatus === "pending") {
      return run;
    }
    const approval =
      approvalInput ??
      (() => {
        try {
          return this.options.storage.approvals.get(run.approvalId);
        } catch {
          return undefined;
        }
      })();
    if (!approval || approval.kind !== "code_mode.run" || !isResolvedCodeModeApprovalStatus(approval.status)) {
      return run;
    }
    const expectedRunId = resolveCodeModeApprovalRunId(approval);
    if (expectedRunId && expectedRunId !== run.runId) {
      return run;
    }
    const nonExecutingApproval = approval.status !== "approved";
    const reason =
      options?.reason ??
      (approval.status === "rejected"
        ? "Code Mode approval was rejected before the pending action could be recovered."
        : approval.status === "edited"
          ? "Code Mode approval was edited, but Code Mode runs are immutable and cannot execute safely."
          : "Code Mode pending action is missing; approved run cannot execute safely.");
    const errorCode =
      options?.errorCode ??
      (approval.status === "rejected"
        ? "approval_rejected_pending_action_missing"
        : approval.status === "edited"
          ? "approval_edited_pending_action_missing"
          : "pending_action_missing");
    const terminal = this.options.storage.codeModeRuns.upsert({
      ...run,
      status: nonExecutingApproval ? "rejected" : "failed",
      error: reason,
      errorCode,
      errorDetails: {
        phase: "approval_resolution",
        reason: options?.errorDetailsReason ?? "pending_action_missing",
        approvalStatus: approval.status,
        approvalResolvedAt: approval.resolvedAt,
        ...(options?.pendingRunId !== undefined ? { pendingRunId: options.pendingRunId } : {}),
      },
      sandbox: run.sandbox ?? this.resolveCurrentSandboxMetadata(),
      finishedAt: run.finishedAt ?? new Date().toISOString(),
    });
    this.appendCodeModeMissingPendingActionEvent(approval, terminal, {
      status: terminal.status,
      error: reason,
      errorCode,
      ...(options?.pendingRunId !== undefined ? { pendingRunId: options.pendingRunId } : {}),
    });
    this.options.publishRealtime(
      nonExecutingApproval ? "code_mode_run_refused" : "code_mode_run_failed",
      "capabilities",
      {
        runId: terminal.runId,
        approvalId: approval.approvalId,
        status: terminal.status,
        error: reason,
        errorCode,
        errorDetails: terminal.errorDetails,
        sandbox: terminal.sandbox,
      },
    );
    return terminal;
  }

  private appendCodeModeMissingPendingActionEvent(
    approval: ApprovalRequest,
    run: CodeModeRunRecord | undefined,
    payload: Record<string, unknown>,
  ): void {
    this.options.storage.approvalEvents.append({
      approvalId: approval.approvalId,
      eventType: "pending_action_refused",
      actorId: "system",
      payload: {
        actionType: "code_mode.run",
        runId: run?.runId ?? resolveCodeModeApprovalRunId(approval),
        approvalStatus: approval.status,
        errorCode: "pending_action_missing",
        ...payload,
      },
    });
  }

  private terminalizeExpiredCodeModeRun(run: CodeModeRunRecord): CodeModeRunRecord {
    if (run.status !== "approval_pending" || !run.approvalId) {
      return run;
    }
    let approval: ApprovalRequest | undefined;
    try {
      approval = this.options.storage.approvals.get(run.approvalId);
    } catch {
      approval = undefined;
    }
    const pending = this.options.storage.pendingApprovalActions.find(run.approvalId);
    if (!isCodeModeApprovalExpiredForRead(approval, pending)) {
      return run;
    }
    const reason = "Code Mode approval expired before execution";
    const expired = this.options.storage.codeModeRuns.upsert({
      ...run,
      status: "expired",
      error: reason,
      sandbox: run.sandbox ?? this.resolveCurrentSandboxMetadata(),
      finishedAt: run.finishedAt ?? new Date().toISOString(),
    });
    try {
      this.options.storage.pendingApprovalActions.markResolved(run.approvalId, "failed", {
        runId: run.runId,
        reason,
      });
    } catch (error) {
      void error;
      // Missing/corrupt pending-action rows should not hide the Code Mode run
      // terminalization truth from list/detail reads.
    }
    this.options.storage.approvalEvents.append({
      approvalId: run.approvalId,
      eventType: "pending_action_refused",
      actorId: "system",
      payload: {
        actionType: "code_mode.run",
        runId: expired.runId,
        status: expired.status,
        error: reason,
        approvalStatus: approval?.status,
        approvalExpiresAt: approval?.expiresAt,
        pendingExpiresAt: pending?.expiresAt,
      },
    });
    this.options.publishRealtime("code_mode_run_failed", "capabilities", {
      runId: expired.runId,
      approvalId: run.approvalId,
      status: expired.status,
      error: reason,
      sandbox: expired.sandbox,
    });
    return expired;
  }

  private hydrateCodeModeRunLinkage(run: CodeModeRunRecord): CodeModeRunRecord {
    if (run.originSurface || !run.approvalId) {
      return run;
    }
    try {
      const approval = this.options.storage.approvals.get(run.approvalId);
      const originSurface = normalizeCodeModeOriginSurface(approval.linkage?.originSurface);
      return originSurface ? { ...run, originSurface } : run;
    } catch {
      return run;
    }
  }

  private buildCandidateDetail(candidateId: string, revision?: number): CandidateSkillDetailRecord {
    const versions = this.requireCandidateVersions(candidateId);
    const aggregateRevision =
      revision ?? this.options.storage.skillAggregateRevisions.ensure("candidate_skill", candidateId).revision;
    const activeVersion = versions.find(
      (version) => version.lifecycleState === "approved" || version.lifecycleState === "trusted",
    );
    const latestVersion = versions[0]!;
    const relatedProposals = this.options.storage.capabilityProposals
      .list(200)
      .filter((proposal) => proposal.candidateId === candidateId || proposal.activationTargetId === candidateId);
    const originatingRunId = activeVersion?.originatingRunId ?? latestVersion?.originatingRunId;
    const originatingRun = originatingRunId ? this.options.storage.codeModeRuns.find(originatingRunId) : undefined;
    const activationBlockers = activeVersion
      ? []
      : ["No candidate version has been promoted into an approved or trusted lifecycle state."];
    return {
      candidateId,
      revision: aggregateRevision,
      versions,
      latestVersion,
      activeVersion,
      relatedProposals,
      originatingRun,
      activationBlocked: activationBlockers.length > 0,
      activationBlockers,
    };
  }

  private requireCandidateVersions(candidateId: string) {
    const versions = this.options.storage.candidateSkillVersions.listByCandidateId(candidateId, 200);
    if (versions.length === 0) {
      throw new NotFoundError({ entity: "candidate skill", id: candidateId });
    }
    return versions;
  }

  private requireCandidateVersion(candidateId: string, versionId: string) {
    const version = this.options.storage.candidateSkillVersions.get(versionId);
    if (version.candidateId !== candidateId) {
      throw new NotFoundError({ entity: "candidate skill version", id: versionId });
    }
    return version;
  }

  private verifyCandidateVersionArtifacts(version: CandidateSkillVersionRecord): void {
    const artifacts = [
      { label: "Candidate manifest", artifact: version.manifestArtifact },
      { label: "Candidate instructions", artifact: version.instructionArtifact },
      { label: "Candidate proof", artifact: version.proofArtifact },
      ...(version.programArtifact ? [{ label: "Candidate program", artifact: version.programArtifact }] : []),
      ...(version.schemaArtifact ? [{ label: "Candidate schemas", artifact: version.schemaArtifact }] : []),
    ];
    for (const item of artifacts) {
      const targetPath = path.resolve(this.options.rootDir, item.artifact.relPath);
      assertPathInsideRoot(targetPath, this.candidateRoot, item.label);
      const content = fsSync.readFileSync(targetPath, "utf8");
      if (sha256Text(content) !== item.artifact.sha256) {
        this.options.publishRealtime("candidate_skill_artifact_tamper_detected", "capabilities", {
          candidateId: version.candidateId,
          versionId: version.versionId,
          artifactId: item.artifact.artifactId,
          label: item.label,
        });
        throw new ConflictError({
          message: `${item.label} hash mismatch; refusing to promote candidate skill.`,
        });
      }
    }
  }

  private buildInspectableCatalog(effectiveSkills: EffectiveCapabilitySet = "ALL"): CapabilityCatalogEntry[] {
    const entries: CapabilityCatalogEntry[] = [];
    for (const tool of this.options.listToolCatalog()) {
      entries.push({
        capabilityId: `tool:${tool.toolName}`,
        kind: "tool",
        category: "built_in",
        title: tool.toolName,
        summary: tool.description,
        callable: true,
        toolName: tool.toolName,
        wrapperVisibility: {
          readOnly: Boolean(tool.readOnly),
          deterministic: Boolean(tool.deterministic),
          codeModeAllowed: Boolean(tool.codeModeAllowed),
        },
        effectPotential:
          tool.effectPotential ??
          classifyToolEffectPotential({
            toolName: tool.toolName,
            trustedBuiltin: true,
            category: tool.category,
            riskLevel: tool.riskLevel,
            requiresApproval: tool.requiresApproval,
            readOnly: tool.readOnly,
          }),
      });
    }

    for (const skill of this.listSkills(effectiveSkills)) {
      entries.push({
        capabilityId: `skill:${skill.skillId}`,
        kind: "skill",
        category: skill.capabilityCategory ?? "project_local",
        title: skill.name,
        summary: summarizeInstructionBody(skill.instructionBody),
        callable: Boolean(skill.callable),
        lifecycleState: skill.lifecycleState,
        trustLabel: skill.trustLabel,
        reviewWarning: skill.reviewWarning,
        skillId: skill.skillId,
        declaredTools: skill.declaredTools,
        requires: skill.requires,
        sourceRef: skill.lifecycle?.provenance?.sourceRef,
        sourceProvider: skill.lifecycle?.provenance?.sourceProvider,
      });
    }

    for (const candidate of this.options.storage.candidateSkillVersions.list(200)) {
      entries.push({
        capabilityId: `candidate:${candidate.candidateId}:${candidate.versionId}`,
        kind: "candidate_skill",
        category: "self_generated",
        title: candidate.title,
        summary: candidate.summary ?? "Generated candidate skill",
        callable: false,
        lifecycleState: candidate.lifecycleState,
        trustLabel: "Candidate",
        candidateId: candidate.candidateId,
      });
    }

    for (const proposal of this.options.storage.capabilityProposals.list(200)) {
      entries.push({
        capabilityId: `proposal:${proposal.proposalId}`,
        kind: "proposal",
        category: "self_generated",
        title: proposal.title,
        summary: proposal.summary,
        callable: false,
        proposalId: proposal.proposalId,
        reviewWarning: "Inspectable only until governance activation.",
      });
    }
    return entries;
  }

  private buildWrapperManifest(snapshot: CapabilityCatalogSnapshotRecord, createdAt: string): CodeModeWrapperManifest {
    const callableToolNames = new Set(
      snapshot.callableEntries
        .filter((entry) => entry.kind === "tool" && typeof entry.toolName === "string")
        .map((entry) => entry.toolName as string),
    );
    return {
      manifestVersion: 1,
      capabilitySnapshotId: snapshot.snapshotId,
      createdAt,
      wrappers: this.options
        .listToolCatalog()
        .filter(
          (tool) => callableToolNames.has(tool.toolName) && tool.readOnly && tool.deterministic && tool.codeModeAllowed,
        )
        .map((tool) => ({
          name: tool.toolName,
          description: tool.description,
          argSchema: tool.argSchema ?? {},
          readOnly: true as const,
          deterministic: true as const,
          codeModeAllowed: true as const,
        })),
    };
  }

  private async executeGovernedChildHarness(input: {
    runId: string;
    sandbox: CodeModeSandboxMetadata;
    executionBackend?: CodeModeRunExecutionBackendRef;
    source: string;
    input: Record<string, unknown>;
    requestedOutputIntent?: string;
    wrapperManifest: CodeModeWrapperManifest;
    policyContext?: ToolPolicyActorContext;
    workspaceId?: string;
    parentSessionId?: string;
    beforeExecutionDispatch: () => Promise<void>;
    onExecutionDispatchFailed: () => Promise<void>;
    signal?: AbortSignal;
  }) {
    return this.executeChildHarness(input);
  }

  private async executeAiderAdapterRun(input: {
    runId: string;
    sandbox: CodeModeSandboxMetadata;
    executionBackend?: CodeModeRunExecutionBackendRef;
    language: CodeModeLanguage;
    source: string;
    pendingAiderRequest: unknown;
    beforeExecutionDispatch: () => Promise<void>;
    onExecutionDispatchFailed: () => Promise<void>;
    signal?: AbortSignal;
  }): Promise<{
    result?: Record<string, unknown>;
    error?: string;
    errorCode?: string;
    errorDetails?: Record<string, unknown>;
    manualReconciliationReason?: string;
    failed: boolean;
    stdout: BoundedCaptureState;
    stderr: BoundedCaptureState;
  }> {
    const aider = readPendingAiderRunRequest(input.pendingAiderRequest);
    const runTempRoot = path.join(this.tempRoot, input.runId);
    const backendRunner = createCodeModeExecutionBackendRunner({
      sandbox: input.sandbox,
      sandboxConfig: this.options.runtimeConfig.codeModeSandbox,
      executionBackend: input.executionBackend,
      dockerLaunch: buildCodeModeDockerLaunchOptions(this.options.runtimeConfig.codeModeDockerBackend),
      dockerBackendConfig: this.options.runtimeConfig.codeModeDockerBackend,
      aiderAdapter: this.options.runtimeConfig.codeModeAiderAdapter,
    });
    if (backendRunner.mode !== "aider_audit" || !backendRunner.executeAiderAdapter) {
      throw new Error("Selected Code Mode backend does not support Aider adapter execution.");
    }
    let dispatchBoundaryCrossed = false;
    try {
      const execution = await backendRunner.executeAiderAdapter({
        runId: input.runId,
        runTempRoot,
        language: input.language,
        source: input.source,
        requestMarkdown: aider.requestMarkdown,
        repositoryRootRelPath: aider.repositoryRootRelPath,
        model: aider.model,
        persister: this.buildAiderArtifactPersister(),
        beforeDispatch: async () => {
          await input.beforeExecutionDispatch();
          dispatchBoundaryCrossed = true;
        },
        onDispatchFailed: async () => {
          await input.onExecutionDispatchFailed();
          dispatchBoundaryCrossed = false;
        },
        signal: input.signal,
      });
      return {
        result: execution.result,
        error: execution.error,
        errorCode: execution.errorCode,
        errorDetails: execution.errorDetails,
        failed: execution.failed,
        stdout: toCaptureState(execution.stdout),
        stderr: toCaptureState(execution.stderr),
      };
    } catch (error) {
      if (!dispatchBoundaryCrossed) {
        throw new CodeModeExecutionPreDispatchFailure(
          `Aider Code Mode execution failed before dispatch: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      await this.cleanupCodeModeRunTempRoot(input.runId, runTempRoot);
    }
  }

  private async executeChildHarness(input: {
    runId: string;
    sandbox: CodeModeSandboxMetadata;
    executionBackend?: CodeModeRunExecutionBackendRef;
    source: string;
    input: Record<string, unknown>;
    requestedOutputIntent?: string;
    wrapperManifest: CodeModeWrapperManifest;
    policyContext?: ToolPolicyActorContext;
    workspaceId?: string;
    parentSessionId?: string;
    beforeExecutionDispatch: () => Promise<void>;
    onExecutionDispatchFailed: () => Promise<void>;
    signal?: AbortSignal;
  }): Promise<{
    result?: Record<string, unknown>;
    error?: string;
    errorCode?: string;
    errorDetails?: Record<string, unknown>;
    manualReconciliationReason?: string;
    failed: boolean;
    stdout: BoundedCaptureState;
    stderr: BoundedCaptureState;
  }> {
    const runTempRoot = path.join(this.tempRoot, input.runId);
    const backendRunner = createCodeModeExecutionBackendRunner({
      sandbox: input.sandbox,
      sandboxConfig: this.options.runtimeConfig.codeModeSandbox,
      executionBackend: input.executionBackend,
      dockerLaunch: buildCodeModeDockerLaunchOptions(this.options.runtimeConfig.codeModeDockerBackend),
    });
    if (backendRunner.mode !== "child_harness") {
      throw new Error("Selected Code Mode backend does not support child harness execution.");
    }
    let preparedSandbox: Awaited<ReturnType<typeof backendRunner.prepareLaunch>>;
    try {
      const harnessPath = await this.prepareRunHarnessFile(runTempRoot);
      preparedSandbox = await backendRunner.prepareLaunch({
        sandbox: input.sandbox,
        runId: input.runId,
        nodePath: process.execPath,
        harnessPath,
        runTempRoot,
        heapMb: CODE_MODE_HEAP_MB,
        env: createMinimalSyntheticEnv(),
      });
    } catch (error) {
      await this.cleanupCodeModeRunTempRoot(input.runId, runTempRoot);
      if (error instanceof CodeModeExecutionBackendUnavailableError) {
        throw error;
      }
      throw new CodeModeSandboxLaunchFailure(
        error instanceof Error ? error.message : String(error),
        buildCodeModeSandboxLaunchFailureMetadata(input.sandbox, error),
      );
    }

    const launchTransport = preparedSandbox.launch.transport;
    let child: ReturnType<typeof spawn>;
    try {
      child = (this.options.spawnCodeModeChild ?? spawn)(
        preparedSandbox.launch.executable,
        preparedSandbox.launch.args,
        {
          shell: preparedSandbox.launch.shell,
          cwd: preparedSandbox.launch.cwd,
          env: preparedSandbox.launch.env,
          stdio: launchTransport === "node_ipc" ? ["ignore", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      await this.cleanupCodeModeRunTempRoot(input.runId, runTempRoot);
      throw new CodeModeSandboxLaunchFailure(
        error instanceof Error ? error.message : String(error),
        buildCodeModeSandboxLaunchFailureMetadata(input.sandbox, error),
      );
    }

    const stdout = createBoundedCapture();
    const stderr = createBoundedCapture();
    let stdioJsonBuffer = "";
    let childStreamFailure: ReturnType<typeof createCodeModeChildStreamError> | undefined;
    const runAbortController = new AbortController();
    const abortChild = (reason?: string) => {
      const message = reason ?? `Code Mode run ${input.runId} was aborted.`;
      if (!runAbortController.signal.aborted) {
        runAbortController.abort(new Error(message));
      }
      replyToChild({
        jsonrpc: "2.0",
        method: "run.cancel",
        params: {
          reason: message,
        },
      });
      setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
      }, 200).unref();
    };
    const pendingRequests = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      }
    >();
    const activeWrapperTasks = new Set<Promise<void>>();
    let executionDispatched = false;
    let executionRequestId: string | undefined;
    let executionEvidenceReceived = false;
    let manualReconciliationReason: string | undefined;

    const sendMessageToChild = (message: Record<string, unknown>): boolean => {
      if (launchTransport === "stdio_jsonrpc") {
        if (!child.stdin?.writable) {
          return false;
        }
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
            if (error) {
              failChildDispatch("stdio", error);
            }
          });
          return true;
        } catch {
          return false;
        }
      }
      if (!child.connected) {
        return false;
      }
      try {
        child.send(message, (error) => {
          if (error) {
            failChildDispatch("ipc", error);
          }
        });
        return true;
      } catch {
        return false;
      }
    };

    const replyToChild = (message: Record<string, unknown>): boolean => {
      if (launchTransport === "node_ipc" && !child.connected) {
        return false;
      }
      if (launchTransport === "stdio_jsonrpc" && !child.stdin?.writable) {
        return false;
      }
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (bytes > CODE_MODE_IPC_MAX_BYTES) {
        return sendMessageToChild({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: {
            code: "MESSAGE_TOO_LARGE",
            message: "Code Mode IPC message exceeded the maximum allowed size.",
          },
        });
      }
      return sendMessageToChild(message);
    };

    const settlePending = (error: unknown): void => {
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    };

    const failChildStream = (streamName: "stdin" | "stdout" | "stderr", error: Error): void => {
      if (childStreamFailure) {
        return;
      }
      childStreamFailure = createCodeModeChildStreamError(input.runId, streamName, error);
      settlePending(childStreamFailure);
      if (!runAbortController.signal.aborted) {
        runAbortController.abort(normalizeCodeModeIpcError(childStreamFailure));
      }
      if (!child.killed) {
        child.kill();
      }
    };

    const failChildDispatch = (transport: "ipc" | "stdio", error: Error): void => {
      if (executionEvidenceReceived) {
        // A correlated run.execute response or child wrapper request is
        // stronger evidence than a late transport acknowledgement failure.
        // Fast terminal child failures can close IPC before Node invokes an
        // earlier send callback; treating that callback as outcome uncertainty
        // would erase the exact child error even though execution is proven.
        return;
      }
      manualReconciliationReason = `Code Mode ${transport} dispatch acknowledgement failed after the durable execution boundary: ${error.message}`;
      failChildStream(transport === "stdio" ? "stdin" : "stdout", error);
    };

    const handleChildMessage = (message: unknown) => {
      if (!isRecord(message)) {
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (bytes > CODE_MODE_IPC_MAX_BYTES) {
        settlePending({
          code: "MESSAGE_TOO_LARGE",
          message: "Code Mode IPC message exceeded the maximum allowed size.",
          details: {
            bytes,
            maxBytes: CODE_MODE_IPC_MAX_BYTES,
            direction: "child_to_parent",
          },
        });
        child.kill();
        return;
      }

      if (typeof message.id === "string" && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
        const pending = pendingRequests.get(message.id);
        if (!pending) {
          return;
        }
        if (message.id === executionRequestId) {
          executionEvidenceReceived = true;
        }
        pendingRequests.delete(message.id);
        if (Object.hasOwn(message, "error")) {
          pending.reject(normalizeCodeModeIpcError(message.error));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (message.method !== "capability.invoke" || typeof message.id !== "string") {
        return;
      }

      const wrapperTask = (async () => {
        try {
          const params = isRecord(message.params) ? message.params : {};
          const wrapperName = asOptionalString(params.wrapperName);
          if (!wrapperName) {
            throw new ValidationError({ message: "Code Mode wrapper name is required." });
          }
          const wrapper = input.wrapperManifest.wrappers.find((item) => item.name === wrapperName);
          if (!wrapper) {
            throw new ValidationError({ message: `Wrapper ${wrapperName} is not available in this run.` });
          }
          executionEvidenceReceived = true;
          const deadlineAt = typeof params.deadlineAt === "number" ? params.deadlineAt : undefined;
          if (deadlineAt && Date.now() > deadlineAt) {
            throw new ConflictError({ message: `Wrapper ${wrapperName} missed its execution deadline.` });
          }
          this.options.publishRealtime("code_mode_wrapper_call_started", "capabilities", {
            runId: input.runId,
            wrapperName,
            requestId: message.id,
          });
          const invocationResult = await this.options.invokeTool({
            toolName: wrapperName,
            args: isRecord(params.args) ? params.args : {},
            agentId: `code-mode:${input.runId}`,
            sessionId: input.parentSessionId ?? input.runId,
            taskId: input.runId,
            runId: input.runId,
            workspaceId: input.workspaceId,
            signal: runAbortController.signal,
            consentContext: {
              source: "agent",
              reason: `code-mode:${input.runId}`,
            },
            policyContext: input.policyContext,
          });
          if (invocationResult.outcome !== "executed") {
            throw new ConflictError({
              message: `Wrapper ${wrapperName} did not execute: ${invocationResult.policyReason}`,
            });
          }
          this.options.publishRealtime("code_mode_wrapper_call_completed", "capabilities", {
            runId: input.runId,
            wrapperName,
            requestId: message.id,
          });
          replyToChild({
            jsonrpc: "2.0",
            id: message.id,
            result: invocationResult.result ?? {},
          });
        } catch (error) {
          replyToChild({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: "WRAPPER_EXECUTION_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      })();
      activeWrapperTasks.add(wrapperTask);
      void wrapperTask.finally(() => activeWrapperTasks.delete(wrapperTask));
    };

    if (launchTransport === "node_ipc") {
      child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
      child.stdout?.on("error", (error: Error) => failChildStream("stdout", error));
      child.on("message", handleChildMessage);
    } else {
      child.stdin?.on("error", (error: Error) => failChildStream("stdin", error));
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdioJsonBuffer += String(chunk);
        let newlineIndex = stdioJsonBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdioJsonBuffer.slice(0, newlineIndex).trim();
          stdioJsonBuffer = stdioJsonBuffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            try {
              handleChildMessage(JSON.parse(line));
            } catch (error) {
              settlePending({
                code: "INVALID_STDIO_JSON",
                message: error instanceof Error ? error.message : String(error),
              });
              child.kill();
            }
          }
          newlineIndex = stdioJsonBuffer.indexOf("\n");
        }
      });
      child.stdout?.on("error", (error: Error) => failChildStream("stdout", error));
    }
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.stderr?.on("error", (error: Error) => failChildStream("stderr", error));

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (childStreamFailure) {
          reject(childStreamFailure);
          return;
        }
        if (pendingRequests.size > 0) {
          settlePending(
            new Error(`Code Mode child exited before replying (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
          );
        }
        if (code === 0 || code === null) {
          resolve();
          return;
        }
        reject(new Error(`Code Mode child exited with code ${code}${signal ? ` (${signal})` : ""}.`));
      });
    });

    const sendRequest = async <TResult>(method: string, params: Record<string, unknown>): Promise<TResult> => {
      if (childStreamFailure) {
        return Promise.reject(childStreamFailure);
      }
      const id = `rpc-${randomUUID()}`;
      const message = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      if (method === "run.execute") {
        executionRequestId = id;
      }
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (bytes > CODE_MODE_IPC_MAX_BYTES) {
        throw {
          code: "MESSAGE_TOO_LARGE",
          message: "Code Mode IPC message exceeded the maximum allowed size.",
          details: {
            bytes,
            maxBytes: CODE_MODE_IPC_MAX_BYTES,
            direction: "parent_to_child",
            method,
          },
        };
      }
      try {
        await input.beforeExecutionDispatch();
      } catch (error) {
        // The request has not reached either transport yet. Reset a tentative
        // boundary even when the durable hook failed after its write (for
        // example while publishing an operational diagnostic).
        await input.onExecutionDispatchFailed();
        throw new CodeModeExecutionPreDispatchFailure(
          `Code Mode execution failed before child request dispatch: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      let resolveResponse!: (value: TResult) => void;
      let rejectResponse!: (error: unknown) => void;
      const response = new Promise<TResult>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      pendingRequests.set(id, {
        resolve: (value) => resolveResponse(value as TResult),
        reject: rejectResponse,
      });
      if (!sendMessageToChild(message)) {
        pendingRequests.delete(id);
        await input.onExecutionDispatchFailed();
        throw new CodeModeExecutionPreDispatchFailure("Code Mode child IPC channel closed before request dispatch.");
      }
      executionDispatched = true;
      return response;
    };

    const timeoutHandle = setTimeout(() => {
      abortChild(`Code Mode run exceeded ${CODE_MODE_RUN_TIMEOUT_MS}ms.`);
    }, CODE_MODE_RUN_TIMEOUT_MS);
    const abortListener = () => {
      abortChild(
        input.signal?.reason instanceof Error
          ? input.signal.reason.message
          : typeof input.signal?.reason === "string"
            ? input.signal.reason
            : `Code Mode run ${input.runId} was aborted.`,
      );
    };
    if (input.signal) {
      if (input.signal.aborted) {
        abortListener();
      } else {
        input.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
      throwIfCapabilitySystemAborted(input.signal, `Code mode run ${input.runId} was aborted before child execution.`);
      const result = await sendRequest<Record<string, unknown>>("run.execute", {
        runId: input.runId,
        source: input.source,
        input: input.input,
        requestedOutputIntent: input.requestedOutputIntent,
        deadlineAt: Date.now() + CODE_MODE_RUN_TIMEOUT_MS,
        wrapperManifest: input.wrapperManifest,
      });
      await waitForWrapperTasksToSettle(activeWrapperTasks);
      await exitPromise;
      return {
        result: normalizeRunResult(result),
        failed: false,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      };
    } catch (error) {
      if (!child.killed) {
        child.kill();
      }
      if (!runAbortController.signal.aborted) {
        runAbortController.abort(normalizeCodeModeIpcError(error));
      }
      await waitForWrapperTasksToSettle(activeWrapperTasks);
      await exitPromise.catch(() => undefined);
      if (!executionDispatched) {
        throw error;
      }
      const normalizedError = normalizeCodeModeIpcError(error);
      return {
        failed: true,
        error: normalizedError.message,
        errorCode: normalizedError.code,
        errorDetails: normalizedError.details,
        manualReconciliationReason,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (input.signal) {
        input.signal.removeEventListener("abort", abortListener);
      }
      await this.cleanupCodeModeRunTempRoot(input.runId, runTempRoot);
    }
  }

  private async cleanupCodeModeRunTempRoot(runId: string, runTempRoot: string): Promise<void> {
    const resolvedTempRoot = path.resolve(this.tempRoot);
    const resolvedRunTempRoot = path.resolve(runTempRoot);
    const relative = path.relative(resolvedTempRoot, resolvedRunTempRoot);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fsSync.existsSync(resolvedRunTempRoot)
    ) {
      return;
    }
    try {
      await fs.rm(resolvedRunTempRoot, { recursive: true, force: true });
    } catch (error) {
      this.options.publishRealtime("code_mode_temp_cleanup_failed", "capabilities", {
        runId,
        path: resolvedRunTempRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async prepareRunHarnessFile(runTempRoot: string): Promise<string> {
    await fs.mkdir(runTempRoot, { recursive: true });
    const runHarnessPath = path.join(runTempRoot, "code-mode-harness.mjs");
    const nextHash = sha256Text(CODE_MODE_CHILD_SOURCE);
    const existing = fsSync.existsSync(runHarnessPath) ? await fs.readFile(runHarnessPath, "utf8") : undefined;
    if (!existing || sha256Text(existing) !== nextHash) {
      await fs.writeFile(runHarnessPath, CODE_MODE_CHILD_SOURCE, "utf8");
    }
    return runHarnessPath;
  }

  private async stageCandidateBundle(
    run: CodeModeRunRecord,
    source: string,
    wrapperManifest: CodeModeWrapperManifest,
    sampleInput: Record<string, unknown>,
  ): Promise<void> {
    const proposalInput = readRecord(sampleInput.capabilityProposal);
    const candidateId = normalizeCandidateId(readOptionalString(proposalInput, "candidateId"), run.codeHash);
    const versionId = `version-${sha256Text(`code-mode-candidate\u0000${run.runId}`).slice(0, 32)}`;
    const now = run.startedAt ?? run.createdAt;
    const bundleSegments = [candidateId, versionId];
    const skillTitle =
      readOptionalString(proposalInput, "title") ??
      readOptionalString(sampleInput, "skillName") ??
      run.requestedOutputIntent?.trim() ??
      `Generated Candidate ${run.runId.slice(-6)}`;
    const summary =
      run.requestedOutputIntent ??
      readOptionalString(proposalInput, "summary") ??
      "Generated candidate skill from Code Mode v1.";
    const requiredPermissions = readStringArray(sampleInput.requiredPermissions);
    const validationExpectation = readOptionalString(sampleInput, "validationExpectation");
    const rollbackPosture = readOptionalString(sampleInput, "rollbackPosture");
    const sourceSessionId = readOptionalString(proposalInput, "sourceSessionId") ?? run.sessionId;
    const sourceTurnId = readOptionalString(proposalInput, "sourceTurnId") ?? run.turnId;
    const candidateSkillMarkdown =
      readOptionalString(run.result, "candidateSkillMarkdown") ??
      readOptionalString(run.result, "skillMarkdown") ??
      readOptionalString(sampleInput, "candidateSkillMarkdown") ??
      buildGeneratedCandidateSkillMarkdown({
        title: skillTitle,
        summary,
        requiredPermissions,
        validationExpectation,
        rollbackPosture,
        sourceSessionId,
        sourceTurnId,
      });
    const validation = validateSkillContent({ skillMarkdown: candidateSkillMarkdown });
    if (!validation.valid) {
      throw new ConflictError({
        message: `Generated candidate skill failed validation: ${validation.errors.join("; ")}`,
      });
    }
    const workspaceId =
      run.workspaceId?.trim() ||
      (run.sessionId ? this.options.storage.chatSessionMeta.get(run.sessionId)?.workspaceId : undefined) ||
      "default";
    const sourceFingerprint = run.codeHash;
    const createdByActorId = run.operatorId?.trim() || "system:code-mode";
    const skillManifest = {
      manifestVersion: 1,
      candidateId,
      versionId,
      title: skillTitle,
      summary,
      sourceKind: "code_mode_generated",
      lineageStatus: "governed",
      workspaceId,
      sourceFingerprint,
      createdByActorId,
      originatingRunId: run.runId,
      proposalId: readOptionalString(proposalInput, "proposalId"),
      candidateType: "self_generated_skill",
      sourceSessionId,
      sourceTurnId,
      requiredPermissions,
      validationExpectation,
      rollbackPosture,
      wrapperManifestHash: run.wrapperManifestHash,
      capabilitySnapshotId: run.capabilitySnapshotId,
      createdAt: now,
    };
    const proof = {
      originatingRunId: run.runId,
      proposalId: readOptionalString(proposalInput, "proposalId"),
      candidateId,
      versionId,
      sourceSessionId,
      sourceTurnId,
      candidateType: "self_generated_skill",
      lineageStatus: "governed",
      workspaceId,
      sourceFingerprint,
      createdByActorId,
      wrapperManifestVersion: wrapperManifest.manifestVersion,
      wrapperManifestHash: run.wrapperManifestHash,
      requiredPermissions,
      validationExpectation,
      rollbackPosture,
      skillContentValidation: validation,
      sampleInput,
      sampleOutput: run.result ?? {},
      generatedSmokeCase: {
        description: "Run completed under the Code Mode v1 harness.",
        status: "completed",
      },
      lastSuccessfulExecutionTimestamp: now,
    };
    const schemaBundle = {
      inputSchema: null,
      outputSchema: null,
    };
    const manifestContent = JSON.stringify(skillManifest, null, 2);
    const proofContent = JSON.stringify(proof, null, 2);
    const schemaContent = JSON.stringify(schemaBundle, null, 2);
    const programFilename = `program.${run.language === "typescript" ? "ts" : "js"}`;
    const deterministicArtifactMetadata = (filename: string) => ({
      artifactId: `artifact-${sha256Text(`${versionId}\u0000${filename}`).slice(0, 32)}`,
      createdAt: now,
    });
    const manifestArtifact = this.buildManagedArtifactRecord(
      this.candidateRoot,
      bundleSegments,
      "skill.json",
      manifestContent,
      "application/json",
      deterministicArtifactMetadata("skill.json"),
    );
    const instructionArtifact = this.buildManagedArtifactRecord(
      this.candidateRoot,
      bundleSegments,
      "SKILL.md",
      candidateSkillMarkdown,
      "text/markdown",
      deterministicArtifactMetadata("SKILL.md"),
    );
    const proofArtifact = this.buildManagedArtifactRecord(
      this.candidateRoot,
      bundleSegments,
      "proof.json",
      proofContent,
      "application/json",
      deterministicArtifactMetadata("proof.json"),
    );
    const programArtifact = this.buildManagedArtifactRecord(
      this.candidateRoot,
      bundleSegments,
      programFilename,
      source,
      run.language === "typescript" ? "text/typescript" : "text/javascript",
      deterministicArtifactMetadata(programFilename),
    );
    const schemaArtifact = this.buildManagedArtifactRecord(
      this.candidateRoot,
      bundleSegments,
      "schemas.json",
      schemaContent,
      "application/json",
      deterministicArtifactMetadata("schemas.json"),
    );
    const candidateRecord: CandidateSkillVersionRecord = {
      candidateId,
      versionId,
      sourceKind: "code_mode_generated",
      lineageStatus: "governed",
      workspaceId,
      sourceFingerprint,
      createdByActorId,
      title: skillTitle,
      summary,
      bundleRoot: normalizeRelPath(
        path.relative(this.options.rootDir, path.join(this.candidateRoot, ...bundleSegments)),
      ),
      originatingRunId: run.runId,
      wrapperManifestHash: run.wrapperManifestHash,
      lifecycleState: "candidate",
      manifestArtifact,
      instructionArtifact,
      proofArtifact,
      programArtifact,
      schemaArtifact,
      createdAt: now,
      updatedAt: now,
      lastSuccessfulExecutionAt: now,
    };

    const replay = this.options.storage.candidateSkillVersions.find(versionId);
    if (replay) {
      assertCodeModeCandidateReplay(replay, candidateRecord);
      this.verifyCandidateVersionArtifacts(replay);
      if (!this.options.storage.skillAggregateRevisions.get("candidate_skill", candidateId)) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `Candidate skill ${candidateId} has a version but no canonical aggregate revision.`,
        });
      }
      return;
    }

    const existingVersions = this.options.storage.candidateSkillVersions.listByCandidateId(candidateId, 1);
    const existingRevision = this.options.storage.skillAggregateRevisions.get("candidate_skill", candidateId);
    if ((existingVersions.length === 0) !== (existingRevision === undefined)) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message:
          existingVersions.length === 0
            ? `Candidate skill ${candidateId} has an orphan aggregate revision.`
            : `Candidate skill ${candidateId} has versions but no canonical aggregate revision.`,
      });
    }

    await this.persistManagedArtifactRecord(this.candidateRoot, manifestArtifact, manifestContent);
    await this.persistManagedArtifactRecord(this.candidateRoot, instructionArtifact, candidateSkillMarkdown);
    await this.persistManagedArtifactRecord(this.candidateRoot, proofArtifact, proofContent);
    await this.persistManagedArtifactRecord(this.candidateRoot, programArtifact, source);
    await this.persistManagedArtifactRecord(this.candidateRoot, schemaArtifact, schemaContent);

    const staged = existingRevision
      ? this.options.storage.skillAggregateRevisions.runWithRevision(
          "candidate_skill",
          candidateId,
          existingRevision.revision,
          () => ({
            value: this.options.storage.candidateSkillVersions.upsert(candidateRecord),
            changed: true,
          }),
          now,
        )
      : this.options.storage.skillAggregateRevisions.createWithInitialRevision(
          "candidate_skill",
          candidateId,
          () => ({
            value: this.options.storage.candidateSkillVersions.upsert(candidateRecord),
            changed: true,
          }),
          now,
        );

    this.options.publishRealtime("candidate_skill_staged", "capabilities", {
      candidateId,
      versionId,
      originatingRunId: run.runId,
      revision: staged.revision,
    });
  }

  private requireCodeModeEnabled(): void {
    if (!this.options.readFeatureFlags().codeModeV1Enabled) {
      throw new ConflictError({
        message: "Code Mode v1 is disabled. Enable codeModeV1Enabled before creating runs.",
      });
    }
  }

  private async persistManagedJsonArtifact(
    root: string,
    segments: string[],
    filename: string,
    value: unknown,
  ): Promise<CapabilityArtifactRecord> {
    return this.persistManagedTextArtifact(
      root,
      segments,
      filename,
      JSON.stringify(value, null, 2),
      "application/json",
    );
  }

  private buildAiderArtifactPersister() {
    return {
      persistText: (input: { segments: string[]; filename: string; content: string; mimeType: string }) =>
        this.persistManagedTextArtifact(
          this.artifactRoot,
          input.segments,
          input.filename,
          input.content,
          input.mimeType,
        ),
      persistJson: (input: { segments: string[]; filename: string; value: unknown }) =>
        this.persistManagedJsonArtifact(this.artifactRoot, input.segments, input.filename, input.value),
    };
  }

  private async persistManagedTextArtifact(
    root: string,
    segments: string[],
    filename: string,
    content: string,
    mimeType: string,
  ): Promise<CapabilityArtifactRecord> {
    const artifact = this.buildManagedArtifactRecord(root, segments, filename, content, mimeType);
    await this.persistManagedArtifactRecord(root, artifact, content);
    return artifact;
  }

  private buildManagedArtifactRecord(
    root: string,
    segments: string[],
    filename: string,
    content: string,
    mimeType: string,
    metadata?: Pick<CapabilityArtifactRecord, "artifactId" | "createdAt">,
  ): CapabilityArtifactRecord {
    const targetPath = path.join(root, ...segments.map(sanitizePathSegment), sanitizePathSegment(filename));
    return {
      artifactId: metadata?.artifactId ?? `artifact-${randomUUID()}`,
      relPath: normalizeRelPath(path.relative(this.options.rootDir, targetPath)),
      sha256: sha256Text(content),
      bytes: Buffer.byteLength(content, "utf8"),
      mimeType,
      createdAt: metadata?.createdAt ?? new Date().toISOString(),
    };
  }

  private async persistManagedArtifactRecord(
    root: string,
    artifact: CapabilityArtifactRecord,
    content: string,
  ): Promise<void> {
    const targetPath = path.resolve(this.options.rootDir, artifact.relPath);
    assertPathInsideRoot(targetPath, root, "Managed artifact");
    if (sha256Text(content) !== artifact.sha256 || Buffer.byteLength(content, "utf8") !== artifact.bytes) {
      throw new ConflictError({ message: "Managed artifact metadata does not match the bytes being persisted." });
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (fsSync.existsSync(targetPath)) {
      const existingContent = await fs.readFile(targetPath, "utf8");
      if (
        sha256Text(existingContent) !== artifact.sha256 ||
        Buffer.byteLength(existingContent, "utf8") !== artifact.bytes
      ) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `Pre-existing managed artifact ${artifact.relPath} does not match the deterministic candidate bytes.`,
        });
      }
      return;
    }
    await fs.writeFile(targetPath, content, "utf8");
  }

  private async readVerifiedManagedArtifactText(
    artifact: CapabilityArtifactRecord,
    options: { label: string; expectedSha256?: string },
  ): Promise<string> {
    const targetPath = path.resolve(this.options.rootDir, artifact.relPath);
    assertPathInsideRoot(targetPath, this.artifactRoot, options.label);
    const content = await fs.readFile(targetPath, "utf8");
    const actualSha256 = sha256Text(content);
    const expectedSha256 = options.expectedSha256 ?? artifact.sha256;
    if (actualSha256 !== artifact.sha256 || actualSha256 !== expectedSha256) {
      throw new ConflictError({
        message: `${options.label} hash mismatch; refusing to execute Code Mode run.`,
      });
    }
    return content;
  }
}

function selectCodeModeRunArtifact(
  run: CodeModeRunRecord,
  artifactKind: CodeModeRunArtifactKind,
): {
  artifact: CapabilityArtifactRecord;
  label: string;
  expectedContentSha256?: string;
  expectedJsonValueSha256?: string;
  truncated: boolean;
} {
  switch (artifactKind) {
    case "source":
      return {
        artifact: run.codeArtifact,
        label: "Code Mode source artifact",
        expectedContentSha256: run.codeHash,
        truncated: false,
      };
    case "wrapper_manifest":
      return {
        artifact: run.wrapperManifestArtifact,
        label: "Code Mode wrapper manifest artifact",
        expectedJsonValueSha256: run.wrapperManifestHash,
        truncated: false,
      };
    case "policy_snapshot":
      return {
        artifact: run.policySnapshotArtifact,
        label: "Code Mode policy snapshot artifact",
        expectedJsonValueSha256: run.policySnapshotHash,
        truncated: false,
      };
    case "stdout":
      if (!run.stdoutArtifact) {
        throw new NotFoundError({ entity: "code mode stdout artifact", id: run.runId });
      }
      return {
        artifact: run.stdoutArtifact,
        label: "Code Mode stdout artifact",
        truncated: run.stdoutTruncated,
      };
    case "stderr":
      if (!run.stderrArtifact) {
        throw new NotFoundError({ entity: "code mode stderr artifact", id: run.runId });
      }
      return {
        artifact: run.stderrArtifact,
        label: "Code Mode stderr artifact",
        truncated: run.stderrTruncated,
      };
    case "aider_request":
      return {
        artifact: selectAiderAdapterArtifact(run, "requestArtifact", "Aider request artifact"),
        label: "Code Mode Aider request artifact",
        truncated: false,
      };
    case "aider_invocation_plan":
      return {
        artifact: selectAiderAdapterArtifact(run, "invocationPlanArtifact", "Aider invocation plan artifact"),
        label: "Code Mode Aider invocation plan artifact",
        truncated: false,
      };
    case "aider_result_envelope":
      return {
        artifact: selectAiderAdapterArtifact(run, "resultEnvelopeArtifact", "Aider result envelope artifact"),
        label: "Code Mode Aider result envelope artifact",
        truncated: false,
      };
    case "aider_patch":
      return {
        artifact: selectAiderEnvelopeArtifact(run, "patchArtifact", "Aider patch artifact"),
        label: "Code Mode Aider patch artifact",
        truncated: false,
      };
    case "aider_stdout":
      return {
        artifact: selectAiderEnvelopeArtifact(run, "stdoutArtifact", "Aider stdout artifact"),
        label: "Code Mode Aider stdout artifact",
        truncated: false,
      };
    case "aider_stderr":
      return {
        artifact: selectAiderEnvelopeArtifact(run, "stderrArtifact", "Aider stderr artifact"),
        label: "Code Mode Aider stderr artifact",
        truncated: false,
      };
    default:
      throw new ValidationError({ message: `Unsupported Code Mode artifact kind: ${artifactKind}` });
  }
}

function selectAiderAdapterArtifact(
  run: CodeModeRunRecord,
  key: "requestArtifact" | "invocationPlanArtifact" | "resultEnvelopeArtifact",
  label: string,
): CapabilityArtifactRecord {
  const adapter = readAiderAdapterResult(run);
  return readCapabilityArtifactRecord(adapter[key], run.runId, label);
}

function selectAiderEnvelopeArtifact(
  run: CodeModeRunRecord,
  key: "patchArtifact" | "stdoutArtifact" | "stderrArtifact",
  label: string,
): CapabilityArtifactRecord {
  const adapter = readAiderAdapterResult(run);
  const envelope = parseCodeModeAiderAdapterResultEnvelope(adapter.envelope);
  if (key === "patchArtifact") {
    return readCapabilityArtifactRecord(envelope.patchArtifact?.artifact, run.runId, label);
  }
  return readCapabilityArtifactRecord(envelope[key], run.runId, label);
}

function readAiderAdapterResult(run: CodeModeRunRecord): Record<string, unknown> {
  const result = run.result;
  const adapter = isRecord(result) ? result.aiderAdapter : undefined;
  if (!isRecord(adapter)) {
    throw new NotFoundError({ entity: "code mode aider artifact", id: run.runId });
  }
  return adapter;
}

function readCapabilityArtifactRecord(value: unknown, runId: string, label: string): CapabilityArtifactRecord {
  if (!isRecord(value)) {
    throw new NotFoundError({ entity: label.toLowerCase(), id: runId });
  }
  for (const key of ["artifactId", "relPath", "sha256", "mimeType", "createdAt"]) {
    if (typeof value[key] !== "string" || !value[key]) {
      throw new ConflictError({ message: `${label} metadata is invalid; refusing to inspect Code Mode run.` });
    }
  }
  if (typeof value.bytes !== "number" || !Number.isFinite(value.bytes) || value.bytes < 0) {
    throw new ConflictError({ message: `${label} byte metadata is invalid; refusing to inspect Code Mode run.` });
  }
  return value as unknown as CapabilityArtifactRecord;
}

function summarizeCodeModeRunForComparison(run: CodeModeRunRecord): CodeModeRunComparisonRecord["run"] {
  return {
    runId: run.runId,
    status: run.status,
    capabilitySnapshotId: run.capabilitySnapshotId,
    codeModeInputHash: run.codeModeInputHash,
    wrapperManifestHash: run.wrapperManifestHash,
    policySnapshotHash: run.policySnapshotHash,
    codeHash: run.codeHash,
    permissionProfileId: run.permissionProfileId,
    localOperatorOverrideId: run.localOperatorOverrideId,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

function buildSkillLifecycleRecord(skill: LoadedSkill, existingCreatedAt?: string): SkillLifecycleRecord {
  const now = new Date().toISOString();
  const sourceManifest = readSkillSourceManifest(skill);
  const mapped = mapSkillSource(skill.source, sourceManifest);
  return {
    skillId: skill.skillId,
    category: mapped.category,
    lifecycleState: mapped.lifecycleState,
    trustLabel: mapped.trustLabel,
    reviewWarning: mapped.reviewWarning,
    provenance: sourceManifest.provenance,
    createdAt: existingCreatedAt ?? now,
    updatedAt: now,
  };
}

function skillLifecycleProjectionMatches(left: SkillLifecycleRecord, right: SkillLifecycleRecord): boolean {
  return (
    left.skillId === right.skillId &&
    left.category === right.category &&
    left.lifecycleState === right.lifecycleState &&
    left.trustLabel === right.trustLabel &&
    left.reviewWarning === right.reviewWarning &&
    JSON.stringify(left.provenance) === JSON.stringify(right.provenance)
  );
}

function durableImportedActivationMatches(
  existing: SkillLifecycleRecord | undefined,
  projected: SkillLifecycleRecord,
): existing is SkillLifecycleRecord & {
  lifecycleState: Extract<SkillLifecycleRecord["lifecycleState"], "approved" | "trusted">;
} {
  if (!existing || (existing.lifecycleState !== "approved" && existing.lifecycleState !== "trusted")) {
    return false;
  }
  if (existing.category !== "community_imported" || projected.category !== "community_imported") {
    return false;
  }
  const governedIntegrity = existing.provenance?.contentIntegrity;
  const verifiedIntegrity = projected.provenance?.contentIntegrity;
  return Boolean(
    governedIntegrity &&
    governedIntegrity.verified &&
    verifiedIntegrity?.verified &&
    governedIntegrity.manifestVersion === verifiedIntegrity.manifestVersion &&
    governedIntegrity.treeSha256 === verifiedIntegrity.treeSha256 &&
    governedIntegrity.fileCount === verifiedIntegrity.fileCount &&
    governedIntegrity.totalBytes === verifiedIntegrity.totalBytes,
  );
}

function skillLifecycleExactIntegrityMatches(existing: SkillLifecycleRecord, projected: SkillLifecycleRecord): boolean {
  const governed = existing.provenance?.contentIntegrity;
  const current = projected.provenance?.contentIntegrity;
  return Boolean(
    governed?.verified &&
    current?.verified &&
    governed.manifestVersion === current.manifestVersion &&
    governed.treeSha256 === current.treeSha256 &&
    governed.fileCount === current.fileCount &&
    governed.totalBytes === current.totalBytes,
  );
}

interface SkillSourceManifestRead {
  provenance?: SkillLifecycleRecord["provenance"];
  integrityStatus?: "verified" | "missing" | "mismatch";
}

function readSkillSourceManifest(skill: LoadedSkill): SkillSourceManifestRead {
  if (skill.source !== "extra") {
    try {
      const integrity = captureSkillContentIntegritySync(skill.dir);
      return {
        provenance: {
          source: skill.source,
          contentIntegrity: {
            manifestVersion: integrity.manifestVersion,
            treeSha256: integrity.treeSha256,
            fileCount: integrity.fileCount,
            totalBytes: integrity.totalBytes,
            verified: true,
          },
        },
        integrityStatus: "verified",
      };
    } catch {
      return {
        provenance: { source: skill.source },
        integrityStatus: "mismatch",
      };
    }
  }
  const manifestPath = path.join(skill.dir, "source.json");
  if (!fsSync.existsSync(manifestPath)) {
    return {
      provenance: {
        source: skill.source,
      },
      integrityStatus: "missing",
    };
  }
  try {
    const parsed = readBoundedSkillSourceManifestSync(manifestPath);
    // source.json is editable provenance metadata. Activation-like fields in it
    // are never authority; only an already-durable lifecycle record for this
    // exact verified tree may restore approved/trusted callability.
    const candidate = isRecord(parsed.candidate) ? parsed.candidate : undefined;
    const rawProvenance = isRecord(parsed.provenance)
      ? parsed.provenance
      : isRecord(candidate?.provenance)
        ? candidate.provenance
        : undefined;
    const rawContentIntegrity = rawProvenance?.contentIntegrity;
    const contentIntegrity = parseSkillContentIntegrityManifest(rawContentIntegrity);
    const integrityVerified = contentIntegrity ? verifySkillContentIntegritySync(skill.dir, contentIntegrity) : false;
    const commitSha = parseOptionalSkillCommitSha(rawProvenance?.commitSha);
    return {
      provenance: {
        source: skill.source,
        sourceRef: typeof candidate?.sourceRef === "string" ? candidate.sourceRef : undefined,
        sourceProvider: typeof candidate?.sourceProvider === "string" ? candidate.sourceProvider : undefined,
        commitSha,
        contentIntegrity: contentIntegrity
          ? {
              manifestVersion: contentIntegrity.manifestVersion,
              treeSha256: contentIntegrity.treeSha256,
              fileCount: contentIntegrity.fileCount,
              totalBytes: contentIntegrity.totalBytes,
              verified: integrityVerified,
            }
          : undefined,
      },
      integrityStatus: contentIntegrity
        ? integrityVerified
          ? "verified"
          : "mismatch"
        : rawContentIntegrity === undefined
          ? "missing"
          : "mismatch",
    };
  } catch {
    return {
      provenance: {
        source: skill.source,
      },
      integrityStatus: "mismatch",
    };
  }
}

function parseOptionalSkillCommitSha(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[a-f0-9]{7,64}$/i.test(value)) {
    throw new Error("Skill provenance commitSha must be a 7-64 character hexadecimal Git object id.");
  }
  return value;
}

function mapSkillSource(
  source: LoadedSkill["source"],
  manifest: SkillSourceManifestRead,
): Pick<SkillLifecycleRecord, "category" | "lifecycleState" | "trustLabel" | "reviewWarning"> {
  const exactBytesUnavailable = manifest.integrityStatus !== "verified";
  switch (source) {
    case "bundled":
      return {
        category: "built_in",
        lifecycleState: exactBytesUnavailable ? "candidate" : "trusted",
        trustLabel: exactBytesUnavailable ? "Exact-byte review required" : "Built-in",
        reviewWarning: exactBytesUnavailable
          ? "Built-in skill content could not be bound to a bounded exact-byte manifest and is not callable."
          : undefined,
      };
    case "managed":
      return {
        category: "optional",
        lifecycleState: exactBytesUnavailable ? "candidate" : "trusted",
        trustLabel: exactBytesUnavailable ? "Exact-byte review required" : "Managed optional",
        reviewWarning: exactBytesUnavailable
          ? "Managed skill content could not be bound to a bounded exact-byte manifest and is not callable."
          : undefined,
      };
    case "workspace":
      return {
        category: "project_local",
        lifecycleState: exactBytesUnavailable ? "candidate" : "approved",
        trustLabel: exactBytesUnavailable ? "Exact-byte review required" : "Project-local",
        reviewWarning: exactBytesUnavailable
          ? "Workspace skill content could not be bound to a bounded exact-byte manifest and is not callable."
          : undefined,
      };
    case "extra":
    default:
      return {
        category: "community_imported",
        lifecycleState: "candidate",
        trustLabel: "Imported/community",
        reviewWarning:
          manifest.integrityStatus === "mismatch"
            ? "Imported skill content does not match its validated exact-byte provenance; re-import or re-review before activation."
            : manifest.integrityStatus === "missing"
              ? manifest.provenance?.sourceRef
                ? "Imported skill is missing exact-byte provenance and remains non-callable until re-imported and governed activation is recorded."
                : "Missing provenance manifest; imported skill remains non-callable until governed activation."
              : "Imported skill remains inspectable only until governed durable activation is recorded.",
      };
  }
}

function isSkillCallable(lifecycle: SkillLifecycleRecord, state: SkillRuntimeState): boolean {
  if (state === "disabled") {
    return false;
  }
  return lifecycle.lifecycleState === "approved" || lifecycle.lifecycleState === "trusted";
}

function summarizeInstructionBody(body: string): string {
  const line = body
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? "Skill instructions";
}

function countCatalogEntries(entries: CapabilityCatalogEntry[], kind: CapabilityCatalogEntry["kind"]): number {
  return entries.filter((entry) => entry.kind === kind).length;
}

function resolveManagedRoot(rootDir: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(rootDir, configuredPath);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function assertCodeModeCandidateReplay(
  stored: CandidateSkillVersionRecord,
  attempted: CandidateSkillVersionRecord,
): void {
  const immutableProjection = (record: CandidateSkillVersionRecord) => ({
    candidateId: record.candidateId,
    versionId: record.versionId,
    sourceKind: record.sourceKind,
    lineageStatus: record.lineageStatus,
    workspaceId: record.workspaceId,
    sourceFingerprint: record.sourceFingerprint,
    upstreamSnapshotId: record.upstreamSnapshotId,
    supersedesVersionId: record.supersedesVersionId,
    createdByActorId: record.createdByActorId,
    title: record.title,
    summary: record.summary,
    bundleRoot: record.bundleRoot,
    originatingRunId: record.originatingRunId,
    wrapperManifestHash: record.wrapperManifestHash,
    manifestArtifact: record.manifestArtifact,
    instructionArtifact: record.instructionArtifact,
    proofArtifact: record.proofArtifact,
    programArtifact: record.programArtifact,
    schemaArtifact: record.schemaArtifact,
    createdAt: record.createdAt,
  });
  if (canonicalJson(immutableProjection(stored)) !== canonicalJson(immutableProjection(attempted))) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Code Mode candidate replay ${attempted.versionId} conflicts with the canonical immutable record.`,
    });
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

function buildTrustedCodeWriteVerification(input: {
  verifiedAt: string;
  source: TrustedCodeVerificationArtifactInput;
  wrapperManifest: TrustedCodeVerificationArtifactInput;
  policySnapshot: TrustedCodeVerificationArtifactInput;
  stdout?: Omit<TrustedCodeVerificationArtifactInput, "expectedSha256">;
  stderr?: Omit<TrustedCodeVerificationArtifactInput, "expectedSha256">;
}): CodeModeTrustedCodeWriteVerification {
  return {
    mode: "trusted_code_artifact_hash_check",
    claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox",
    verifiedAt: input.verifiedAt,
    artifacts: [
      trustedCodeVerificationArtifact("source", input.source),
      trustedCodeVerificationArtifact("wrapper_manifest", input.wrapperManifest),
      trustedCodeVerificationArtifact("policy_snapshot", input.policySnapshot),
      ...(input.stdout ? [trustedCodeVerificationArtifact("stdout", input.stdout)] : []),
      ...(input.stderr ? [trustedCodeVerificationArtifact("stderr", input.stderr)] : []),
    ],
    notes: [
      "Verifies managed artifact bytes and hashes used by trusted-code execution.",
      "Does not claim hostile-code sandboxing or remove approval, policy, or path-jail requirements.",
    ],
  };
}

type TrustedCodeVerificationArtifactInput = {
  artifact: CapabilityArtifactRecord;
  content: string;
  expectedSha256?: string;
};

function trustedCodeVerificationArtifact(
  artifactKind: CodeModeTrustedCodeWriteVerification["artifacts"][number]["artifactKind"],
  input: TrustedCodeVerificationArtifactInput,
): CodeModeTrustedCodeWriteVerification["artifacts"][number] {
  const actualSha256 = sha256Text(input.content);
  const expectedSha256 = input.expectedSha256 ?? input.artifact.sha256;
  return {
    artifactKind,
    artifactId: input.artifact.artifactId,
    relPath: input.artifact.relPath,
    expectedSha256,
    actualSha256,
    verified: actualSha256 === expectedSha256 && actualSha256 === input.artifact.sha256,
    bytes: input.artifact.bytes,
  };
}

function attachTrustedCodeWriteVerification(
  result: Record<string, unknown> | undefined,
  evidence: CodeModeTrustedCodeWriteVerification,
): Record<string, unknown> {
  return {
    ...(isRecord(result) ? result : {}),
    trustedCodeWriteVerification: evidence,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readOptionalString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeCandidateId(candidateId: string | undefined, fallbackHash: string): string {
  const cleaned = candidateId?.replace(/[^a-zA-Z0-9_.:-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (cleaned && cleaned.length <= 80) {
    return cleaned.startsWith("candidate-") ? cleaned : `candidate-${cleaned}`;
  }
  return `candidate-${fallbackHash.slice(0, 12)}`;
}

function buildGeneratedCandidateSkillMarkdown(input: {
  title: string;
  summary: string;
  requiredPermissions: string[];
  validationExpectation?: string;
  rollbackPosture?: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
}): string {
  const skillName = normalizeGeneratedSkillName(input.title);
  const description = sanitizeSkillContentText(input.summary);
  const permissions =
    input.requiredPermissions.length > 0
      ? input.requiredPermissions.map((item) => `- ${sanitizeSkillContentText(item)}`).join("\n")
      : "- No additional permissions requested by the initial candidate.";
  return [
    "---",
    `name: ${quoteYamlScalar(skillName)}`,
    `description: ${quoteYamlScalar(description)}`,
    "---",
    "",
    `# ${skillName}`,
    "",
    "## When to use",
    sanitizeSkillContentText(input.summary),
    "",
    "## When not to use",
    "- Do not use while this candidate is proposed, validating, rejected, revoked, deprecated, or failed.",
    "- Do not bypass GoatCitadel policy, approvals, path jails, or capability lifecycle checks.",
    "",
    "## Required inputs",
    "- The user request that triggered the reusable workflow.",
    "- Any workspace context the approved skill explicitly asks for.",
    "",
    "## Required permissions",
    permissions,
    "",
    "## Workflow",
    "- Confirm the request still matches this approved skill.",
    "- Gather the minimum context needed for the workflow.",
    "- Use only callable tools and approved runtime capabilities.",
    "- Return concise output with evidence, uncertainty, and any required next action.",
    "",
    "## Output contract",
    "- State what was done.",
    "- Link or name any artifacts produced.",
    "- State validation performed and anything not validated.",
    "",
    "## Validation notes",
    `- ${sanitizeSkillContentText(
      input.validationExpectation ??
        "The Code Mode staging run must validate the skill content and record artifact hashes.",
    )}`,
    "",
    "## Provenance",
    `- Source session: ${sanitizeSkillContentText(input.sourceSessionId ?? "current session")}`,
    `- Source turn: ${sanitizeSkillContentText(input.sourceTurnId ?? "current turn")}`,
    "",
    "## Rollback",
    `- ${sanitizeSkillContentText(
      input.rollbackPosture ??
        "Rollback restores the previously approved version and records durable lifecycle evidence.",
    )}`,
  ].join("\n");
}

function normalizeGeneratedSkillName(title: string): string {
  const cleaned = title
    .replace(/^build reusable skill:\s*/iu, "")
    .replace(/[^a-z0-9 ]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
  if (!cleaned) {
    return "Generated Capability Candidate";
  }
  return cleaned
    .split(" ")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function sanitizeSkillContentText(value: string): string {
  const redacted = value
    .replace(/https?:\/\/\S+/giu, "[external source]")
    .replace(/\b(api[_-]?key|secret|password|token|credential)\b/giu, "sensitive value")
    .replace(/\b(sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,})\b/giu, "[redacted]")
    .replace(/\b(fetch\s*\(|axios\.|curl\s+)\b/giu, "[network step]")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted || "No additional detail provided.";
}

function quoteYamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/gu, " ").trim());
}

function assertJsonValueHash(value: unknown, expectedSha256: string, label: string): void {
  if (sha256Text(JSON.stringify(value)) !== expectedSha256) {
    throw new ConflictError({
      message: `${label} value hash mismatch; refusing to execute Code Mode run.`,
    });
  }
}

function sanitizePathSegment(value: string): string {
  return Array.from(value, (segment) => {
    const code = segment.charCodeAt(0);
    if (code <= 0x1f || /[<>:"/\\|?*]/u.test(segment)) {
      return "-";
    }
    return segment;
  }).join("");
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function assertPathInsideRoot(targetPath: string, rootDir: string, label: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError({ message: `${label} is outside the managed artifact root.` });
  }
}

function buildCodePreview(source: string): string {
  const compact = source.replace(/\s+/gu, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

function normalizeCodeModeOriginSurface(value: unknown): CodeModeOriginSurface | undefined {
  return value === "chat" || value === "cowork" || value === "code" ? value : undefined;
}

function resolveCodeModeWorkspaceId(input: {
  sessionId?: string;
  requestWorkspaceId?: string;
  sessionWorkspaceId?: string;
}): string | undefined {
  if (!input.sessionId) {
    return input.requestWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  }
  const sessionWorkspaceId = input.sessionWorkspaceId?.trim();
  const requestWorkspaceId = input.requestWorkspaceId?.trim();
  if (sessionWorkspaceId) {
    if (requestWorkspaceId && requestWorkspaceId !== sessionWorkspaceId) {
      throw new ValidationError({
        message: `Code Mode workspaceId ${requestWorkspaceId} does not match session ${input.sessionId} workspace ${sessionWorkspaceId}.`,
      });
    }
    return sessionWorkspaceId;
  }
  return requestWorkspaceId ?? DEFAULT_WORKSPACE_ID;
}

function serializePolicyContext(context: ToolPolicyActorContext | undefined): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return {
    operatorId: context.operatorId,
    authActorId: context.authActorId,
    authActorSource: context.authActorSource,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    taskId: context.taskId,
    runId: context.runId,
    approvedCodeModeRunId: context.approvedCodeModeRunId,
    surface: context.surface,
    permissionProfileId: context.permissionProfileId,
    permissionProfileLabel: context.permissionProfile?.label,
    permissionProfileApprovalMode: context.permissionProfile?.approvalMode,
    permissionProfile: context.permissionProfile ? serializePermissionProfile(context.permissionProfile) : undefined,
    localOperatorOverrideId: context.localOperatorOverrideId,
    localOperatorOverrideExpiresAt: context.localOperatorOverride?.expiresAt,
    localOperatorOverrideScope: context.localOperatorOverride?.scope,
    localOperatorOverride: context.localOperatorOverride
      ? serializeLocalOperatorOverride(context.localOperatorOverride)
      : undefined,
  };
}

function deserializePolicyContext(value: unknown): ToolPolicyActorContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const permissionProfile = deserializePermissionProfile(value.permissionProfile);
  const localOperatorOverride = deserializeLocalOperatorOverride(value.localOperatorOverride);
  return {
    operatorId: asOptionalString(value.operatorId),
    authActorId: asOptionalString(value.authActorId),
    authActorSource: asOptionalString(value.authActorSource) as ToolPolicyActorContext["authActorSource"],
    workspaceId: asOptionalString(value.workspaceId),
    sessionId: asOptionalString(value.sessionId),
    taskId: asOptionalString(value.taskId),
    runId: asOptionalString(value.runId),
    approvedCodeModeRunId: asOptionalString(value.approvedCodeModeRunId),
    surface: asPermissionSurface(value.surface),
    permissionProfileId: permissionProfile?.profileId ?? asOptionalString(value.permissionProfileId),
    permissionProfile,
    localOperatorOverrideId: localOperatorOverride?.overrideId ?? asOptionalString(value.localOperatorOverrideId),
    localOperatorOverride,
  };
}

function buildCodeModeRunPolicyContext(input: {
  run: CodeModeRunRecord;
  pendingRequest: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
}): ToolPolicyActorContext | undefined {
  const frozenFromSnapshot = deserializePolicyContext(input.policySnapshot.codeModePermissionContext);
  const frozen = frozenFromSnapshot ?? deserializePolicyContext(input.pendingRequest.policyContext);
  return {
    ...frozen,
    operatorId: frozen?.operatorId ?? input.run.operatorId,
    workspaceId: frozen?.workspaceId ?? input.run.workspaceId,
    sessionId: frozen?.sessionId ?? input.run.sessionId,
    runId: input.run.runId,
    taskId: frozen?.taskId ?? input.run.runId,
    surface: frozen?.surface ?? normalizeCodeModeOriginSurface(input.run.originSurface),
    permissionProfileId: frozen?.permissionProfileId ?? input.run.permissionProfileId,
    localOperatorOverrideId: frozen?.localOperatorOverrideId ?? input.run.localOperatorOverrideId,
  };
}

function isCodeModePendingActionExecutable(
  pending: { expiresAt?: string },
  approval: Pick<ApprovalRequest, "status" | "resolvedAt">,
): boolean {
  if (!pending.expiresAt) {
    return true;
  }
  const expiresAtMs = Date.parse(pending.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  if (Date.now() <= expiresAtMs) {
    return true;
  }
  if (approval.status !== "approved" || !approval.resolvedAt) {
    return false;
  }
  const resolvedAtMs = Date.parse(approval.resolvedAt);
  return Number.isFinite(resolvedAtMs) && resolvedAtMs <= expiresAtMs;
}

function isCodeModeApprovalExpiredForRead(
  approval: Pick<ApprovalRequest, "status" | "expiresAt" | "resolvedAt"> | undefined,
  pending: { expiresAt?: string; resolutionStatus?: string } | undefined,
): boolean {
  const now = Date.now();
  if (approval?.expiresAt) {
    const approvalExpiresAtMs = Date.parse(approval.expiresAt);
    if (Number.isFinite(approvalExpiresAtMs) && approvalExpiresAtMs <= now && approval.status !== "approved") {
      return true;
    }
  }
  if (!pending?.expiresAt || pending.resolutionStatus !== "pending") {
    return false;
  }
  const pendingExpiresAtMs = Date.parse(pending.expiresAt);
  if (!Number.isFinite(pendingExpiresAtMs) || pendingExpiresAtMs > now) {
    return false;
  }
  if (approval?.status !== "approved" || !approval.resolvedAt) {
    return true;
  }
  const resolvedAtMs = Date.parse(approval.resolvedAt);
  return !Number.isFinite(resolvedAtMs) || resolvedAtMs > pendingExpiresAtMs;
}

function isResolvedCodeModeApprovalStatus(status: ApprovalRequest["status"]): boolean {
  return status === "approved" || status === "rejected" || status === "edited";
}

function resolveCodeModeApprovalRunId(approval: ApprovalRequest): string | undefined {
  return (
    asOptionalString(approval.linkage?.runId) ??
    asOptionalString((approval.linkage as Record<string, unknown> | undefined)?.codeModeRunId) ??
    asOptionalString(approval.payload.runId)
  );
}

function assertCodeModeRunPolicyContextMatchesStoredRun(
  run: CodeModeRunRecord,
  context: ToolPolicyActorContext | undefined,
): void {
  if (run.permissionProfileId && context?.permissionProfileId !== run.permissionProfileId) {
    throw new ConflictError({
      message: `Code Mode permission profile mismatch; expected ${run.permissionProfileId}.`,
    });
  }
  if (run.permissionProfileId && context?.permissionProfile?.profileId !== run.permissionProfileId) {
    throw new ConflictError({
      message: `Code Mode permission profile snapshot is missing profile ${run.permissionProfileId}.`,
    });
  }
  if (run.localOperatorOverrideId && context?.localOperatorOverrideId !== run.localOperatorOverrideId) {
    throw new ConflictError({
      message: `Code Mode local operator override mismatch; expected ${run.localOperatorOverrideId}.`,
    });
  }
  if (run.localOperatorOverrideId && context?.localOperatorOverride?.overrideId !== run.localOperatorOverrideId) {
    throw new ConflictError({
      message: `Code Mode local operator override snapshot is missing override ${run.localOperatorOverrideId}.`,
    });
  }
}

function assertLiveCodeModePolicyContextMatchesStoredRun(
  run: CodeModeRunRecord,
  context: ToolPolicyActorContext | undefined,
): void {
  if (run.permissionProfileId && context?.permissionProfileId !== run.permissionProfileId) {
    throw new ConflictError({
      message: `Code Mode permission profile ${run.permissionProfileId} is no longer active for this run.`,
    });
  }
  if (run.localOperatorOverrideId && context?.localOperatorOverrideId !== run.localOperatorOverrideId) {
    throw new ConflictError({
      message: `Code Mode local operator override ${run.localOperatorOverrideId} is no longer active for this run.`,
    });
  }
}

function assertApprovedSandboxPostureStillCurrent(
  approved: CodeModeSandboxMetadata | undefined,
  current: CodeModeSandboxMetadata,
): void {
  if (!approved) {
    return;
  }
  const mismatchedField = (
    [
      "runnerId",
      "runnerVersion",
      "platform",
      "isolationProfile",
      "required",
      "available",
      "failClosedReason",
      "advisoryUnsandboxedReason",
    ] as const
  ).find((field) => approved[field] !== current[field]);
  const mismatchedArrayField =
    mismatchedField ??
    (["checksPassed", "checksFailed"] as const).find((field) => !sameSandboxCheckList(approved[field], current[field]));
  if (!mismatchedArrayField) {
    return;
  }
  throw new ConflictError({
    message: `Code Mode approved sandbox posture changed at ${mismatchedArrayField}; refusing to execute run.`,
  });
}

function sameSandboxCheckList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function readFrozenCodeModeInput(
  policySnapshot: Record<string, unknown>,
  legacyPendingInput: unknown,
  expectedInputHash?: string,
): Record<string, unknown> {
  const frozenInput = isRecord(policySnapshot.codeModeInput) ? policySnapshot.codeModeInput : undefined;
  const runInput = frozenInput ?? (isRecord(legacyPendingInput) ? legacyPendingInput : {});
  const inputHash = asOptionalString(policySnapshot.codeModeInputHash);
  const computedInputHash = sha256Text(JSON.stringify(runInput));
  if (inputHash && computedInputHash !== inputHash) {
    throw new ConflictError({ message: "Code Mode input snapshot hash mismatch; refusing to execute run." });
  }
  if (expectedInputHash && computedInputHash !== expectedInputHash) {
    throw new ConflictError({ message: "Code Mode stored input hash mismatch; refusing to execute run." });
  }
  return runInput;
}

function buildCodeModeWrapperPolicyContext(
  context: ToolPolicyActorContext | undefined,
  run: CodeModeRunRecord,
): ToolPolicyActorContext {
  return {
    ...context,
    operatorId: context?.operatorId ?? run.operatorId,
    workspaceId: context?.workspaceId ?? run.workspaceId,
    sessionId: context?.sessionId ?? run.sessionId,
    taskId: run.runId,
    runId: run.runId,
    approvedCodeModeRunId: run.runId,
    surface: context?.surface ?? normalizeCodeModeOriginSurface(run.originSurface) ?? "code",
    permissionProfileId: context?.permissionProfileId ?? run.permissionProfileId,
    localOperatorOverrideId: context?.localOperatorOverrideId ?? run.localOperatorOverrideId,
    localOperatorOverride: context?.localOperatorOverride,
  };
}

function serializePermissionProfile(profile: PermissionProfileRecord): Record<string, unknown> {
  return {
    profileId: profile.profileId,
    label: profile.label,
    description: profile.description,
    builtin: profile.builtin,
    status: profile.status,
    scope: profile.scope,
    scopeRef: profile.scopeRef,
    approvalMode: profile.approvalMode,
    legacyToolProfile: profile.legacyToolProfile,
    toolPatterns: profile.toolPatterns,
    allow: profile.allow,
    deny: profile.deny,
    readAccessMode: profile.readAccessMode,
    defaultForSurfaces: profile.defaultForSurfaces,
    createdBy: profile.createdBy,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    archivedAt: profile.archivedAt,
  };
}

function deserializePermissionProfile(value: unknown): PermissionProfileRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const profileId = asOptionalString(value.profileId);
  const label = asOptionalString(value.label);
  const approvalMode = asOptionalString(value.approvalMode);
  if (!profileId || !label || !isToolApprovalMode(approvalMode)) {
    return undefined;
  }
  return {
    profileId,
    label,
    description: asOptionalString(value.description),
    builtin: value.builtin === true,
    status: value.status === "archived" ? "archived" : "active",
    scope: isPermissionProfileScope(value.scope) ? value.scope : "operator",
    scopeRef: asOptionalString(value.scopeRef),
    approvalMode,
    legacyToolProfile: asOptionalString(value.legacyToolProfile),
    toolPatterns: asStringArray(value.toolPatterns),
    allow: asStringArray(value.allow),
    deny: asStringArray(value.deny),
    readAccessMode: isFilesystemReadAccessMode(value.readAccessMode) ? value.readAccessMode : undefined,
    defaultForSurfaces: asPermissionSurfaceArray(value.defaultForSurfaces),
    createdBy: asOptionalString(value.createdBy) ?? "system",
    createdAt: asOptionalString(value.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asOptionalString(value.updatedAt) ?? new Date(0).toISOString(),
    archivedAt: asOptionalString(value.archivedAt),
  };
}

function serializeLocalOperatorOverride(record: LocalOperatorOverrideRecord): Record<string, unknown> {
  return {
    overrideId: record.overrideId,
    operatorId: record.operatorId,
    scope: record.scope,
    scopeRef: record.scopeRef,
    reason: record.reason,
    status: record.status,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

function deserializeLocalOperatorOverride(value: unknown): LocalOperatorOverrideRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const overrideId = asOptionalString(value.overrideId);
  const operatorId = asOptionalString(value.operatorId);
  const reason = asOptionalString(value.reason);
  const createdAt = asOptionalString(value.createdAt);
  const expiresAt = asOptionalString(value.expiresAt);
  if (!overrideId || !operatorId || !reason || !createdAt || !expiresAt) {
    return undefined;
  }
  return {
    overrideId,
    operatorId,
    scope: isLocalOperatorOverrideScope(value.scope) ? value.scope : "session",
    scopeRef: asOptionalString(value.scopeRef),
    reason,
    status: isLocalOperatorOverrideStatus(value.status) ? value.status : "active",
    createdBy: asOptionalString(value.createdBy) ?? operatorId,
    createdAt,
    expiresAt,
    revokedAt: asOptionalString(value.revokedAt),
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asPermissionSurface(value: unknown): PermissionSurface | undefined {
  return isPermissionSurface(value) ? value : undefined;
}

function asPermissionSurfaceArray(value: unknown): PermissionSurface[] | undefined {
  const surfaces = Array.isArray(value) ? value.filter(isPermissionSurface) : [];
  return surfaces.length > 0 ? surfaces : undefined;
}

function isToolApprovalMode(value: unknown): value is PermissionProfileRecord["approvalMode"] {
  return value === "approve_all" || value === "approve_risky" || value === "bypass";
}

function isPermissionProfileScope(value: unknown): value is PermissionProfileRecord["scope"] {
  return value === "global" || value === "operator" || value === "workspace";
}

function isFilesystemReadAccessMode(value: unknown): value is PermissionProfileRecord["readAccessMode"] {
  return value === "roots_only" || value === "approval_required" || value === "full_disk";
}

function isPermissionSurface(value: unknown): value is PermissionSurface {
  return (
    value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "tools" ||
    value === "mcp" ||
    value === "all"
  );
}

function isLocalOperatorOverrideScope(value: unknown): value is LocalOperatorOverrideRecord["scope"] {
  return value === "operator" || value === "workspace" || value === "session" || value === "run";
}

function isLocalOperatorOverrideStatus(value: unknown): value is LocalOperatorOverrideRecord["status"] {
  return value === "active" || value === "expired" || value === "revoked";
}

function normalizeCodeModeRunListOptions(
  options: number | CodeModeRunListOptions,
): Required<Pick<CodeModeRunListOptions, "limit">> & CodeModeRunListOptions {
  if (typeof options === "number") {
    return { limit: normalizeListLimit(options) };
  }
  return {
    limit: normalizeListLimit(options.limit),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.status ? { status: options.status } : {}),
  };
}

function normalizeListLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 100;
}

function buildCodeModeApprovalLinkage(input: {
  workspaceId?: string;
  runId?: string;
  sessionId?: string;
  turnId?: string;
  originSurface?: CodeModeOriginSurface;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}): ApprovalCreateInput["linkage"] {
  return {
    workspaceId: input.workspaceId,
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    originSurface: input.originSurface,
    toolName: "code_mode.run",
    actionType: "code_mode.run",
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
  };
}

function buildCodeModeApprovalPayload(input: {
  runId: string;
  codeHash: string;
  wrapperManifestHash: string;
  inputHash: string;
  capabilitySnapshotId: string;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess: boolean;
  inspectPath: string;
  codePreview: string;
  affectedResources: string[];
  sessionId?: string;
  turnId?: string;
  workspaceId?: string;
  originSurface?: CodeModeOriginSurface;
  sandbox: CodeModeSandboxMetadata;
  executionBackend: CodeModeRunExecutionBackendRef;
  autonomousActivation?: CodeModeAutonomousActivationEvidence;
  permissionProfileId?: string;
  permissionProfileLabel?: string;
  localOperatorOverrideId?: string;
}): Record<string, unknown> {
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    originSurface: input.originSurface,
    description:
      "Start a policy-governed Code Mode v1 run with sandbox posture recorded and rechecked, plus a frozen wrapper manifest and policy snapshot.",
    riskLevel: "caution",
    affectedResources: input.affectedResources,
    codeHash: input.codeHash,
    wrapperManifestHash: input.wrapperManifestHash,
    inputHash: input.inputHash,
    capabilitySnapshotId: input.capabilitySnapshotId,
    inspectPath: input.inspectPath,
    codePreview: input.codePreview,
    requestedOutputIntent: input.requestedOutputIntent,
    saveCandidateOnSuccess: input.saveCandidateOnSuccess,
    sandbox: input.sandbox,
    executionBackend: input.executionBackend,
    autonomousActivation: input.autonomousActivation,
    permissionProfileId: input.permissionProfileId,
    permissionProfileLabel: input.permissionProfileLabel,
    localOperatorOverrideId: input.localOperatorOverrideId,
  };
}

function validateGuestSource(source: string): void {
  const sourceFile = ts.createSourceFile(
    "code-mode-source.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const parseError = parseDiagnostics[0];
  if (parseError) {
    throw new ValidationError({
      message: `Code Mode source could not be parsed: ${ts.flattenDiagnosticMessageText(parseError.messageText, "\n")}`,
    });
  }
  const forbiddenLabel = findForbiddenGuestSourceReference(sourceFile);
  if (forbiddenLabel) {
    throw new ValidationError({
      message: `Code Mode source may not reference ${forbiddenLabel}.`,
    });
  }
}

function findForbiddenGuestSourceReference(root: ts.Node): string | undefined {
  let forbiddenLabel: string | undefined;
  const visit = (node: ts.Node): void => {
    if (forbiddenLabel) {
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      forbiddenLabel = "import statements";
      return;
    }
    if (ts.isCallExpression(node)) {
      forbiddenLabel = readBlockedGuestSourceCallLabel(node.expression);
      if (forbiddenLabel) {
        return;
      }
    }
    if (ts.isPropertyAccessExpression(node) && isProcessGuestSourceExpression(node.expression)) {
      forbiddenLabel = "process";
      return;
    }
    if (ts.isIdentifier(node) && isBlockedGuestSourceIdentifierReference(node)) {
      forbiddenLabel = readBlockedGuestSourceIdentifierLabel(node.text);
      if (forbiddenLabel) {
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return forbiddenLabel;
}

function readBlockedGuestSourceCallLabel(expression: ts.Expression): string | undefined {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) {
    return "dynamic import";
  }
  if (isProcessGuestSourceExpression(expression)) {
    return "process";
  }
  if (ts.isIdentifier(expression)) {
    return readBlockedGuestSourceIdentifierLabel(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return readBlockedGuestSourceIdentifierLabel(expression.name.text);
  }
  return undefined;
}

function readBlockedGuestSourceIdentifierLabel(text: string): string | undefined {
  if (text === "require") {
    return "require";
  }
  if (text === "process") {
    return "process";
  }
  if (text === "fetch") {
    return "fetch";
  }
  if (text === "setTimeout" || text === "setInterval" || text === "setImmediate" || text === "queueMicrotask") {
    return "timers or schedulers";
  }
  return undefined;
}

function isProcessGuestSourceExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "process";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "process" || isProcessGuestSourceExpression(expression.expression);
  }
  return false;
}

function isBlockedGuestSourceIdentifierReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isParameter(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isFunctionDeclaration(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  return true;
}

function transpileGuestSource(language: CodeModeLanguage, source: string): string {
  if (language === "javascript") {
    return source;
  }
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noResolve: true,
      removeComments: false,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
    },
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  const firstError = errors[0];
  if (firstError) {
    throw new ValidationError({
      message: `TypeScript transpilation failed: ${ts.flattenDiagnosticMessageText(firstError.messageText, "\n")}`,
    });
  }
  return transpiled.outputText;
}

function normalizeRunResult(result: unknown): Record<string, unknown> {
  if (isRecord(result)) {
    return result;
  }
  return { value: result };
}

function createCodeModeChildStreamError(
  runId: string,
  streamName: "stdin" | "stdout" | "stderr",
  error: Error,
): {
  code: "CODE_MODE_CHILD_STREAM_ERROR";
  message: string;
  details: Record<string, unknown>;
} {
  return {
    code: "CODE_MODE_CHILD_STREAM_ERROR",
    message: `Code Mode child ${streamName} stream failed: ${error.message}`,
    details: {
      runId,
      stream: streamName,
    },
  };
}

function normalizeCodeModeIpcError(error: unknown): {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (isRecord(error)) {
    const code = asOptionalString(error.code);
    const message = asOptionalString(error.message) ?? "Unknown Code Mode IPC error.";
    const details = isRecord(error.details) ? error.details : undefined;
    const normalizedMessage = code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
    return { code, message: normalizedMessage, details };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: typeof error === "string" && error.trim() ? error.trim() : "Unknown Code Mode IPC error." };
}

function approvalIdFromApprovalCreateFailure(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("approvalId" in error)) {
    return undefined;
  }
  const value = (error as { approvalId?: unknown }).approvalId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildCodeModeSandboxLaunchFailureMetadata(
  sandbox: CodeModeSandboxMetadata,
  error: unknown,
): CodeModeSandboxMetadata {
  const message = error instanceof Error ? error.message : String(error);
  const checksFailed = [...new Set([...sandbox.checksFailed, "launch_preparation_failed"])];
  const failureMessage = `Code Mode sandbox launch preparation failed: ${message}`;
  return {
    ...sandbox,
    available: false,
    checksFailed,
    ...(sandbox.required
      ? { failClosedReason: sandbox.failClosedReason ?? failureMessage, advisoryUnsandboxedReason: undefined }
      : {
          advisoryUnsandboxedReason: sandbox.advisoryUnsandboxedReason ?? failureMessage,
          failClosedReason: undefined,
        }),
  };
}

function createMinimalSyntheticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GOATCITADEL_CODE_MODE: "1",
    TZ: process.env.TZ ?? "UTC",
  };
  for (const key of CODE_MODE_ENV_PASSTHROUGH_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function buildCodeModeDockerLaunchOptions(config: CodeModeDockerBackendConfig):
  | {
      enabled: true;
      image: string;
      dockerCommand?: string;
      nodeCommand?: string;
      requireDigestPin: boolean;
    }
  | undefined {
  const image = config.image?.trim();
  if (!config.enabled || !image) {
    return undefined;
  }
  return {
    enabled: true,
    image,
    dockerCommand: config.dockerCommand,
    nodeCommand: config.nodeCommand,
    requireDigestPin: config.requireDigestPin,
  };
}

function createBoundedCapture(): {
  append: (chunk: Buffer | string) => void;
  finish: () => BoundedCaptureState;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (truncated) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const remaining = CODE_MODE_OUTPUT_CAPTURE_LIMIT_BYTES - bytes;
      if (remaining <= 0) {
        chunks.push(Buffer.from("\n...[truncated]\n", "utf8"));
        truncated = true;
        return;
      }
      if (buffer.length <= remaining) {
        chunks.push(buffer);
        bytes += buffer.length;
        return;
      }
      chunks.push(buffer.subarray(0, remaining));
      chunks.push(Buffer.from("\n...[truncated]\n", "utf8"));
      bytes = CODE_MODE_OUTPUT_CAPTURE_LIMIT_BYTES;
      truncated = true;
    },
    finish() {
      return {
        text: Buffer.concat(chunks).toString("utf8"),
        truncated,
      };
    },
  };
}

function toCaptureState(text: string): BoundedCaptureState {
  return {
    text,
    truncated: false,
  };
}

async function waitForWrapperTasksToSettle(tasks: Set<Promise<void>>): Promise<void> {
  const snapshot = [...tasks];
  if (snapshot.length === 0) {
    return;
  }
  await Promise.race([
    Promise.allSettled(snapshot),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CODE_MODE_WRAPPER_SETTLE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

function toPreview(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= 4000) {
    return normalized;
  }
  const truncationMarker = "...[truncated]";
  if (normalized.includes(truncationMarker)) {
    const previewBudget = 4000 - truncationMarker.length - 1;
    const head = normalized.slice(0, Math.max(0, previewBudget)).trimEnd();
    return `${head}\n${truncationMarker}`;
  }
  return `${normalized.slice(0, 3997)}...`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildCodeModeToolInvokeResult(run: CodeModeRunRecord): ToolInvokeResult {
  return {
    outcome: "executed",
    policyReason: `code_mode_run:${run.status}`,
    auditEventId: `code-mode-${run.runId}`,
    result: {
      runId: run.runId,
      status: run.status,
      codeHash: run.codeHash,
      executionRecovery: run.executionRecovery,
      trustedCodeWriteVerification: run.trustedCodeWriteVerification,
      verification: run.verification,
      ...(run.executionRecovery.disposition === "manual_reconciliation" ? { manualReconciliationRequired: true } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      ...(run.errorDetails ? { errorDetails: run.errorDetails } : {}),
      ...(run.sandbox ? { sandbox: run.sandbox } : {}),
    },
  };
}

function buildCodeModeFinalTranscriptContent(run: CodeModeRunRecord): string {
  const artifactLine = (label: string, artifact: CapabilityArtifactRecord | undefined) =>
    artifact ? `- ${label}: ${artifact.relPath} (sha256 ${artifact.sha256})` : `- ${label}: none`;
  const recovery = run.executionRecovery;
  const lines = [
    `Code Mode run ${run.runId} ${run.status}.`,
    "",
    `Recovery truth: ${recovery.disposition}; generation ${recovery.generation}; phase ${recovery.phase}.`,
    ...(recovery.interruptionReason ? [`Interruption reason: ${recovery.interruptionReason}`] : []),
    ...(recovery.disposition === "manual_reconciliation"
      ? ["Manual reconciliation is required. This run was not automatically replayed after its execution boundary."]
      : []),
    "",
    "Durable artifact references:",
    artifactLine("source", run.codeArtifact),
    artifactLine("wrapper manifest", run.wrapperManifestArtifact),
    artifactLine("policy snapshot", run.policySnapshotArtifact),
    artifactLine("stdout", run.stdoutArtifact),
    artifactLine("stderr", run.stderrArtifact),
    "",
    `Semantic verification: ${run.verification?.status ?? "not_applicable"}.`,
    "Artifact hash verification establishes trusted-code artifact integrity only; it does not establish hostile-code sandboxing.",
    ...(run.stdoutPreview ? ["", "Captured stdout prefix:", run.stdoutPreview] : []),
    ...(run.stderrPreview ? ["", "Captured stderr prefix:", run.stderrPreview] : []),
  ];
  const redacted = redactStructuredSecrets(lines.join("\n")).value;
  return boundUtf8Text(
    typeof redacted === "string" ? redacted : JSON.stringify(redacted),
    CODE_MODE_FINAL_TRANSCRIPT_LIMIT_BYTES,
    "\n...[Code Mode transcript summary truncated]",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundRedactedError(value: string): string {
  const redacted = redactStructuredSecrets(value).value;
  return boundUtf8Text(String(redacted), CODE_MODE_RECOVERY_ERROR_LIMIT_BYTES, "...[truncated]");
}

function boundUtf8Text(value: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  let retainedBytes = 0;
  let retainedCodeUnits = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + bytes > budget) {
      break;
    }
    retainedBytes += bytes;
    retainedCodeUnits += character.length;
  }
  return `${value.slice(0, retainedCodeUnits)}${marker}`;
}

function throwIfCapabilitySystemAborted(signal: AbortSignal | undefined, fallbackMessage: string): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : fallbackMessage);
}

function isCodeModeExecutionInterrupted(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof Error && error.name === "AbortError") ||
    /aborted|lease ownership moved|worker stopped|worker lease/i.test(message)
  );
}

function recoverStaleCodeModeExecutionClaim(
  repository: {
    releaseExecutionClaim(input: {
      runId: string;
      approvalId: string;
      startedAt: string;
      executionGeneration: number;
      interruptedAt: string;
      interruptionReason: string;
    }): CodeModeRunRecord | undefined;
    markExecutionInterrupted(input: {
      runId: string;
      approvalId: string;
      startedAt?: string;
      executionGeneration: number;
      interruptedAt: string;
      interruptionReason: string;
      errorDetails?: Record<string, unknown>;
    }): CodeModeRunRecord | undefined;
  },
  run: CodeModeRunRecord,
  approvalId: string,
  recoveredAt: string,
): CodeModeRunRecord | undefined {
  if (!isStaleCodeModeExecutionClaim(run.startedAt)) {
    return undefined;
  }
  const interruptionReason = `Gateway restarted or lost the Code Mode execution owner while phase was ${run.executionRecovery.phase}.`;
  if (run.executionRecovery.phase === "claimed" && run.startedAt) {
    return repository.releaseExecutionClaim({
      runId: run.runId,
      approvalId,
      startedAt: run.startedAt,
      executionGeneration: run.executionRecovery.generation,
      interruptedAt: recoveredAt,
      interruptionReason,
    });
  }
  return repository.markExecutionInterrupted({
    runId: run.runId,
    approvalId,
    startedAt: run.startedAt,
    executionGeneration: run.executionRecovery.generation,
    interruptedAt: recoveredAt,
    interruptionReason,
    errorDetails: {
      phase: run.executionRecovery.phase,
      staleOwnerRecovered: true,
      completedOutputPrefixPersisted: Boolean(run.stdoutArtifact || run.stderrArtifact),
    },
  });
}

function isStaleCodeModeExecutionClaim(startedAt?: string): boolean {
  if (!startedAt) {
    return true;
  }
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return true;
  }
  return Date.now() - startedAtMs > CODE_MODE_RUN_TIMEOUT_MS + CODE_MODE_WRAPPER_SETTLE_TIMEOUT_MS;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPendingAiderRunRequest(value: unknown): {
  requestMarkdown: string;
  repositoryRootRelPath?: string;
  model?: string;
} {
  if (!isRecord(value)) {
    throw new Error("Aider Code Mode pending action is missing aider request metadata.");
  }
  const requestMarkdown = asOptionalString(value.requestMarkdown);
  if (!requestMarkdown) {
    throw new Error("Aider Code Mode pending action is missing requestMarkdown.");
  }
  return {
    requestMarkdown,
    repositoryRootRelPath: asOptionalString(value.repositoryRootRelPath),
    model: asOptionalString(value.model),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const __internal = {
  createMinimalSyntheticEnv,
  createCodeModeChildStreamError,
  normalizeCodeModeIpcError,
  buildCodeModeFinalTranscriptContent,
  // Exposed for tests asserting the single execution chokepoint: a self-authored
  // skill must be non-callable while `candidate` and callable only once a
  // governed activation flips it to `approved`/`trusted`.
  isSkillCallable,
};
