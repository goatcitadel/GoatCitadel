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
  CandidateLifecycleActionResult,
  CandidateSkillDetailRecord,
  CandidateSkillVersionRecord,
  CapabilityArtifactRecord,
  CapabilityCatalogEntry,
  CapabilityCatalogScope,
  CapabilityCatalogSnapshotRecord,
  CapabilityProposalDetailRecord,
  CapabilityProposalKind,
  CapabilityProposalRecord,
  CodeModeLanguage,
  CodeModeSandboxMetadata,
  CodeModeRunRecord,
  CodeModeRunRequest,
  CodeModeRunListOptions,
  LoadedSkill,
  PendingApprovalAction,
  SkillLifecycleRecord,
  SkillListItem,
  SkillRuntimeState,
  SkillStateRecord,
  ToolCatalogEntry,
  LocalOperatorOverrideRecord,
  PermissionProfileRecord,
  PermissionSurface,
  ToolPolicyActorContext,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { CapabilityRuntimeConfig, FeatureFlagsConfig } from "../config.js";
import { CODE_MODE_CHILD_SOURCE } from "./code-mode-child-source.js";
import {
  assertCodeModeSandboxAvailable,
  prepareCodeModeSandboxLaunch,
  resolveCodeModeSandboxMetadata,
} from "./code-mode-sandbox-runner.js";

const CODE_MODE_RUN_TIMEOUT_MS = 15_000;
const CODE_MODE_WRAPPER_SETTLE_TIMEOUT_MS = 500;
const CODE_MODE_OUTPUT_CAPTURE_LIMIT_BYTES = 64 * 1024;
const CODE_MODE_IPC_MAX_BYTES = 128 * 1024;
const CODE_MODE_HEAP_MB = 64;
const CODE_MODE_ENV_PASSTHROUGH_KEYS = ["SystemRoot", "SYSTEMROOT", "ComSpec", "WINDIR", "TEMP", "TMP"];
const DEFAULT_WORKSPACE_ID = "default";

type LateCodeModeApprovalCleanupResult = {
  approvalId: string;
  attempted: true;
  status: "completed" | "failed";
  errors: string[];
};

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

class CodeModeSandboxLaunchFailure extends Error {
  public constructor(
    message: string,
    public readonly sandbox: CodeModeSandboxMetadata,
  ) {
    super(message);
    this.name = "CodeModeSandboxLaunchFailure";
  }
}

export class CapabilitySystemService {
  private readonly candidateRoot: string;
  private readonly artifactRoot: string;
  private readonly tempRoot: string;
  private readonly harnessPath: string;
  private readonly resolveSandboxMetadata: (
    config: CapabilityRuntimeConfig["codeModeSandbox"],
  ) => CodeModeSandboxMetadata;

  public constructor(private readonly options: CapabilitySystemServiceOptions) {
    this.candidateRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.candidateRoot);
    this.artifactRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.codeModeArtifactRoot);
    this.tempRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.tempRoot);
    this.harnessPath = path.join(this.tempRoot, "code-mode-harness.mjs");
    this.resolveSandboxMetadata =
      options.resolveSandboxMetadata ?? ((config) => resolveCodeModeSandboxMetadata(config));
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

  public listSkills(): SkillListItem[] {
    this.ensureSkillLifecycleBackfill();
    const stateMap = this.options.readSkillStates();
    return this.options.listLoadedSkills().map((skill) => {
      const state = stateMap.get(skill.skillId);
      const lifecycle = this.options.storage.skillLifecycle.find(skill.skillId) ?? buildSkillLifecycleRecord(skill);
      return {
        ...skill,
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
  }

  public listCatalog(scope: CapabilityCatalogScope): CapabilityCatalogEntry[] {
    this.ensureSkillLifecycleBackfill();
    const inspectable = this.buildInspectableCatalog();
    return scope === "callable" ? inspectable.filter((entry) => entry.callable) : inspectable;
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

  public promoteCandidate(candidateId: string, versionId?: string): CandidateLifecycleActionResult {
    const versions = this.requireCandidateVersions(candidateId);
    const selected = versionId ? this.requireCandidateVersion(candidateId, versionId) : versions[0]!;
    this.verifyCandidateVersionArtifacts(selected);
    const changedVersionIds = new Set<string>();
    const occurredAt = new Date().toISOString();
    this.options.storage.runImmediateTransaction(() => {
      for (const version of versions) {
        if (version.versionId === selected.versionId) {
          this.options.storage.candidateSkillVersions.updateLifecycleState(version.versionId, "approved", occurredAt);
          changedVersionIds.add(version.versionId);
          continue;
        }
        if (version.lifecycleState === "approved" || version.lifecycleState === "trusted") {
          this.options.storage.candidateSkillVersions.updateLifecycleState(version.versionId, "deprecated", occurredAt);
          changedVersionIds.add(version.versionId);
        }
      }
    });
    const detail = this.buildCandidateDetail(candidateId);
    this.options.publishRealtime("candidate_skill_promoted", "capabilities", {
      candidateId,
      versionId: selected.versionId,
    });
    return {
      action: "promote",
      candidateId,
      selectedVersionId: selected.versionId,
      changedVersionIds: [...changedVersionIds],
      occurredAt,
      detail,
    };
  }

  public revokeCandidate(candidateId: string, versionId?: string): CandidateLifecycleActionResult {
    const versions = this.requireCandidateVersions(candidateId);
    const selected = versionId ? this.requireCandidateVersion(candidateId, versionId) : versions[0]!;
    const targets = versionId ? [selected] : versions;
    const occurredAt = new Date().toISOString();
    for (const version of targets) {
      this.options.storage.candidateSkillVersions.updateLifecycleState(version.versionId, "revoked", occurredAt);
    }
    const detail = this.buildCandidateDetail(candidateId);
    this.options.publishRealtime("candidate_skill_revoked", "capabilities", {
      candidateId,
      versionId: selected.versionId,
      revokedVersionIds: targets.map((version) => version.versionId),
    });
    return {
      action: "revoke",
      candidateId,
      selectedVersionId: selected.versionId,
      changedVersionIds: targets.map((version) => version.versionId),
      occurredAt,
      detail,
    };
  }

  public rollbackCandidate(candidateId: string, targetVersionId: string): CandidateLifecycleActionResult {
    const versions = this.requireCandidateVersions(candidateId);
    const target = this.requireCandidateVersion(candidateId, targetVersionId);
    this.verifyCandidateVersionArtifacts(target);
    const occurredAt = new Date().toISOString();
    const changedVersionIds = new Set<string>();
    this.options.storage.runImmediateTransaction(() => {
      for (const version of versions) {
        if (version.versionId === target.versionId) {
          this.options.storage.candidateSkillVersions.updateLifecycleState(version.versionId, "approved", occurredAt);
          changedVersionIds.add(version.versionId);
          continue;
        }
        if (version.lifecycleState !== "revoked") {
          this.options.storage.candidateSkillVersions.updateLifecycleState(version.versionId, "deprecated", occurredAt);
          changedVersionIds.add(version.versionId);
        }
      }
    });
    const detail = this.buildCandidateDetail(candidateId);
    this.options.publishRealtime("candidate_skill_rolled_back", "capabilities", {
      candidateId,
      targetVersionId,
    });
    return {
      action: "rollback",
      candidateId,
      selectedVersionId: target.versionId,
      changedVersionIds: [...changedVersionIds],
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
    if (filters.status === "expired" || filters.status === "approval_pending") {
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
        });
      }
      return repository
        .list(Number.MAX_SAFE_INTEGER)
        .filter((run) => (filters.workspaceId ? run.workspaceId === filters.workspaceId : true))
        .filter((run) => (filters.sessionId ? run.sessionId === filters.sessionId : true))
        .filter((run) => (filters.turnId ? run.turnId === filters.turnId : true))
        .filter((run) => run.status === filters.status || run.status === "approval_pending");
    }
    return this.listStoredCodeModeRuns(filters);
  }

  public listChatPendingApprovals(sessionId: string): CodeModeApprovalQueueItem[] {
    const approvals = this.options.storage.chatInlineApprovals.listBySession(sessionId);
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
        return {
          approvalId: item.approvalId,
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
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
    const originSurface = normalizeCodeModeOriginSurface(request.originSurface);
    const sessionWorkspaceId = request.sessionId
      ? this.options.storage.chatSessionMeta.get(request.sessionId)?.workspaceId
      : undefined;
    const workspaceId = resolveCodeModeWorkspaceId({
      sessionId: request.sessionId,
      requestWorkspaceId: request.workspaceId,
      sessionWorkspaceId,
    });
    const policyContext = this.options.resolvePolicyContext?.({
      operatorId: request.operatorId,
      workspaceId,
      sessionId: request.sessionId,
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
    const policySnapshot = {
      ...this.options.readPolicySnapshot(),
      codeModePermissionContext: serializePolicyContext(policyContext),
      codeModeInput: runInput,
      codeModeInputHash: runInputHash,
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
      sessionId: request.sessionId,
      turnId: request.turnId,
      originSurface,
      sandbox,
      permissionProfileId: policyContext?.permissionProfileId,
      permissionProfileLabel: policyContext?.permissionProfile?.label,
      localOperatorOverrideId: policyContext?.localOperatorOverrideId,
    });
    const approvalLinkage = buildCodeModeApprovalLinkage({
      workspaceId,
      runId,
      sessionId: request.sessionId,
      turnId: request.turnId,
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
        sessionId: request.sessionId,
        turnId: request.turnId,
        sandbox,
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
      const cleanup = lateApprovalId ? this.terminalizeLateFailedCodeModeApproval(lateApprovalId, error) : undefined;
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
      sessionId: request.sessionId,
      turnId: request.turnId,
      sandbox,
      codeArtifact,
      wrapperManifestArtifact,
      policySnapshotArtifact,
      stdoutTruncated: false,
      stderrTruncated: false,
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
          originSurface,
          workspaceId,
          operatorId: request.operatorId,
          policyContext: serializePolicyContext(policyContext),
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
        },
      });

      if (request.sessionId) {
        this.options.storage.chatInlineApprovals.upsert({
          approvalId: approval.approvalId,
          sessionId: request.sessionId,
          turnId: request.turnId ?? `code-mode-${stored.runId}`,
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
        this.options.storage.approvals.resolve(approval.approvalId, {
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

    this.options.publishRealtime("code_mode_run_created", "capabilities", {
      runId: stored.runId,
      approvalId: stored.approvalId,
      capabilitySnapshotId: stored.capabilitySnapshotId,
      wrapperManifestHash: stored.wrapperManifestHash,
      codeHash: stored.codeHash,
      originSurface,
      sandbox,
      permissionProfileId: stored.permissionProfileId,
      localOperatorOverrideId: stored.localOperatorOverrideId,
    });
    return this.hydrateCodeModeRunForRead(stored);
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
      const recovered = recoverStaleCodeModeExecutionClaim(this.options.storage.codeModeRuns, existing, approvalId);
      if (recovered) {
        existing = recovered;
        this.options.publishRealtime("code_mode_run_claim_recovered", "capabilities", {
          runId: existing.runId,
          approvalId,
          status: existing.status,
          sandbox: existing.sandbox,
        });
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
      this.options.publishRealtime("code_mode_run_started", "capabilities", {
        runId,
        approvalId,
        startedAt: claimStartedAt,
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
      await this.ensureHarnessFile();
      const execution = await this.executeChildHarness({
        runId,
        sandbox,
        source: compiledSource,
        input: runInput,
        requestedOutputIntent: finalRun.requestedOutputIntent,
        wrapperManifest,
        policyContext: wrapperPolicyContext,
        workspaceId: finalRun.workspaceId,
        parentSessionId: finalRun.sessionId,
        signal,
      });
      throwIfCapabilitySystemAborted(signal, `Code mode run ${runId} was aborted after execution started.`);

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

      finalRun = this.options.storage.codeModeRuns.upsert({
        ...finalRun,
        status: execution.failed ? "failed" : "completed",
        sandbox,
        stdoutArtifact,
        stderrArtifact,
        stdoutPreview: toPreview(execution.stdout.text),
        stderrPreview: toPreview(execution.stderr.text),
        stdoutTruncated: execution.stdout.truncated,
        stderrTruncated: execution.stderr.truncated,
        result: execution.result,
        error: execution.error,
        errorCode: execution.errorCode,
        errorDetails: execution.errorDetails,
        startedAt: claimStartedAt,
        finishedAt: new Date().toISOString(),
      });

      if (!execution.failed && finalRun.saveCandidateOnSuccess) {
        try {
          await this.stageCandidateBundle(finalRun, source, wrapperManifest, runInput);
        } catch (candidateError) {
          this.options.publishRealtime("candidate_skill_stage_failed", "capabilities", {
            runId: finalRun.runId,
            approvalId,
            error: candidateError instanceof Error ? candidateError.message : String(candidateError),
          });
        }
      }

      this.options.storage.pendingApprovalActions.markResolved(
        approvalId,
        finalRun.status === "completed" ? "executed" : "failed",
        {
          outcome: finalRun.status,
          runId: finalRun.runId,
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
          sandbox,
        },
      );

      return {
        outcome: "executed",
        policyReason: `code_mode_run:${finalRun.status}`,
        auditEventId: `code-mode-${finalRun.runId}`,
        result: {
          runId: finalRun.runId,
          status: finalRun.status,
          codeHash: finalRun.codeHash,
          ...(finalRun.error ? { error: finalRun.error } : {}),
          ...(finalRun.errorCode ? { errorCode: finalRun.errorCode } : {}),
          ...(finalRun.errorDetails ? { errorDetails: finalRun.errorDetails } : {}),
          sandbox,
        },
      };
    } catch (error) {
      if (isCodeModeExecutionInterrupted(error, signal)) {
        if (claimStartedAt) {
          finalRun =
            this.options.storage.codeModeRuns.releaseExecutionClaim({
              runId,
              approvalId,
              startedAt: claimStartedAt,
            }) ?? finalRun;
        }
        this.options.publishRealtime("code_mode_run_interrupted", "capabilities", {
          runId,
          approvalId,
          status: finalRun.status,
          error: error instanceof Error ? error.message : String(error),
          sandbox,
        });
        return undefined;
      }
      if (error instanceof CodeModeSandboxLaunchFailure) {
        sandbox = error.sandbox;
      }
      const normalizedError = normalizeCodeModeIpcError(error);
      finalRun = this.options.storage.codeModeRuns.upsert({
        ...finalRun,
        status: "failed",
        sandbox,
        error: normalizedError.message,
        errorCode: normalizedError.code,
        errorDetails: normalizedError.details,
        startedAt: finalRun.startedAt,
        finishedAt: new Date().toISOString(),
      });
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

  private terminalizeLateFailedCodeModeApproval(approvalId: string, error: unknown): LateCodeModeApprovalCleanupResult {
    const normalized = normalizeCodeModeIpcError(error);
    const cleanupErrors: string[] = [];
    try {
      this.options.storage.approvals.resolve(approvalId, {
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
    return this.hydrateCodeModeRunLinkage(
      this.terminalizeExpiredCodeModeRun(this.terminalizeResolvedCodeModeRunWithMissingPendingAction(run)),
    );
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
    const rejected = approval.status === "rejected";
    const reason =
      options?.reason ??
      (rejected
        ? "Code Mode approval was rejected before the pending action could be recovered."
        : "Code Mode pending action is missing; approved run cannot execute safely.");
    const errorCode =
      options?.errorCode ?? (rejected ? "approval_rejected_pending_action_missing" : "pending_action_missing");
    const terminal = this.options.storage.codeModeRuns.upsert({
      ...run,
      status: rejected ? "rejected" : "failed",
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
    this.options.publishRealtime(rejected ? "code_mode_run_refused" : "code_mode_run_failed", "capabilities", {
      runId: terminal.runId,
      approvalId: approval.approvalId,
      status: terminal.status,
      error: reason,
      errorCode,
      errorDetails: terminal.errorDetails,
      sandbox: terminal.sandbox,
    });
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

  private buildCandidateDetail(candidateId: string): CandidateSkillDetailRecord {
    const versions = this.requireCandidateVersions(candidateId);
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

  private buildInspectableCatalog(): CapabilityCatalogEntry[] {
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
      });
    }

    for (const skill of this.listSkills()) {
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

  private async executeChildHarness(input: {
    runId: string;
    sandbox: CodeModeSandboxMetadata;
    source: string;
    input: Record<string, unknown>;
    requestedOutputIntent?: string;
    wrapperManifest: CodeModeWrapperManifest;
    policyContext?: ToolPolicyActorContext;
    workspaceId?: string;
    parentSessionId?: string;
    signal?: AbortSignal;
  }): Promise<{
    result?: Record<string, unknown>;
    error?: string;
    errorCode?: string;
    errorDetails?: Record<string, unknown>;
    failed: boolean;
    stdout: BoundedCaptureState;
    stderr: BoundedCaptureState;
  }> {
    const runTempRoot = path.join(this.tempRoot, input.runId);
    let preparedSandbox: Awaited<ReturnType<typeof prepareCodeModeSandboxLaunch>>;
    try {
      const harnessPath = await this.prepareRunHarnessFile(runTempRoot);
      preparedSandbox = await prepareCodeModeSandboxLaunch(
        this.options.runtimeConfig.codeModeSandbox,
        {
          runId: input.runId,
          nodePath: process.execPath,
          harnessPath,
          runTempRoot,
          heapMb: CODE_MODE_HEAP_MB,
          env: createMinimalSyntheticEnv(),
        },
        { metadata: input.sandbox },
      );
    } catch (error) {
      throw new CodeModeSandboxLaunchFailure(
        error instanceof Error ? error.message : String(error),
        buildCodeModeSandboxLaunchFailureMetadata(input.sandbox, error),
      );
    }

    const child = spawn(preparedSandbox.launch.executable, preparedSandbox.launch.args, {
      shell: preparedSandbox.launch.shell,
      cwd: preparedSandbox.launch.cwd,
      env: preparedSandbox.launch.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const stdout = createBoundedCapture();
    const stderr = createBoundedCapture();
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
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));

    const pendingRequests = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      }
    >();
    const activeWrapperTasks = new Set<Promise<void>>();

    const sendMessageToChild = (message: Record<string, unknown>): boolean => {
      if (!child.connected) {
        return false;
      }
      try {
        child.send(message, () => {
          // The child may exit while an async wrapper call is finishing. A closed
          // IPC channel is already represented by the run result, so do not leak
          // EPIPE/ERR_IPC_CHANNEL_CLOSED as an unhandled process rejection.
        });
        return true;
      } catch {
        return false;
      }
    };

    const replyToChild = (message: Record<string, unknown>): boolean => {
      if (!child.connected) {
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

    child.on("message", (message: unknown) => {
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
    });

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
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

    const sendRequest = <TResult>(method: string, params: Record<string, unknown>): Promise<TResult> => {
      const id = `rpc-${randomUUID()}`;
      const message = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (bytes > CODE_MODE_IPC_MAX_BYTES) {
        return Promise.reject({
          code: "MESSAGE_TOO_LARGE",
          message: "Code Mode IPC message exceeded the maximum allowed size.",
          details: {
            bytes,
            maxBytes: CODE_MODE_IPC_MAX_BYTES,
            direction: "parent_to_child",
            method,
          },
        });
      }
      return new Promise<TResult>((resolve, reject) => {
        pendingRequests.set(id, {
          resolve: (value) => resolve(value as TResult),
          reject,
        });
        if (!sendMessageToChild(message)) {
          pendingRequests.delete(id);
          reject(new Error("Code Mode child IPC channel closed before request could be sent."));
        }
      });
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
      const normalizedError = normalizeCodeModeIpcError(error);
      return {
        failed: true,
        error: normalizedError.message,
        errorCode: normalizedError.code,
        errorDetails: normalizedError.details,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (input.signal) {
        input.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private async ensureHarnessFile(): Promise<void> {
    await fs.mkdir(this.tempRoot, { recursive: true });
    const nextHash = sha256Text(CODE_MODE_CHILD_SOURCE);
    const existing = fsSync.existsSync(this.harnessPath) ? await fs.readFile(this.harnessPath, "utf8") : undefined;
    if (existing && sha256Text(existing) === nextHash) {
      return;
    }
    await fs.writeFile(this.harnessPath, CODE_MODE_CHILD_SOURCE, "utf8");
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
    const candidateId = `candidate-${run.codeHash.slice(0, 12)}`;
    const versionId = `version-${randomUUID()}`;
    const now = new Date().toISOString();
    const bundleSegments = [candidateId, versionId];
    const skillTitle = run.requestedOutputIntent?.trim() || `Generated Candidate ${run.runId.slice(-6)}`;
    const skillManifest = {
      manifestVersion: 1,
      candidateId,
      versionId,
      title: skillTitle,
      summary: run.requestedOutputIntent ?? "Generated candidate skill from Code Mode v1.",
      sourceKind: "code_mode_generated",
      originatingRunId: run.runId,
      wrapperManifestHash: run.wrapperManifestHash,
      capabilitySnapshotId: run.capabilitySnapshotId,
      createdAt: now,
    };
    const skillMarkdown = [
      `# ${skillTitle}`,
      "> Generated candidate skill from a successful Code Mode v1 run",
      "",
      "## Purpose",
      run.requestedOutputIntent ?? "Review the attached generated program and decide whether to promote it.",
      "",
      "## Workflow",
      "- Inspect the generated program and proof artifacts.",
      "- Validate the wrapper allowlist and sample output.",
      "- Promote only through governed approval.",
      "",
      "## Output Contract",
      "- Candidate bundle with manifest, instructions, source program, and proof.json.",
    ].join("\n");
    const proof = {
      originatingRunId: run.runId,
      wrapperManifestVersion: wrapperManifest.manifestVersion,
      wrapperManifestHash: run.wrapperManifestHash,
      sampleInput,
      sampleOutput: run.result ?? {},
      generatedSmokeCase: {
        description: "Run completed under the Code Mode v1 harness.",
        status: run.status,
      },
      lastSuccessfulExecutionTimestamp: now,
    };
    const schemaBundle = {
      inputSchema: null,
      outputSchema: null,
    };

    const manifestArtifact = await this.persistManagedJsonArtifact(
      this.candidateRoot,
      bundleSegments,
      "skill.json",
      skillManifest,
    );
    const instructionArtifact = await this.persistManagedTextArtifact(
      this.candidateRoot,
      bundleSegments,
      "SKILL.md",
      skillMarkdown,
      "text/markdown",
    );
    const proofArtifact = await this.persistManagedJsonArtifact(
      this.candidateRoot,
      bundleSegments,
      "proof.json",
      proof,
    );
    const programArtifact = await this.persistManagedTextArtifact(
      this.candidateRoot,
      bundleSegments,
      `program.${run.language === "typescript" ? "ts" : "js"}`,
      source,
      run.language === "typescript" ? "text/typescript" : "text/javascript",
    );
    const schemaArtifact = await this.persistManagedJsonArtifact(
      this.candidateRoot,
      bundleSegments,
      "schemas.json",
      schemaBundle,
    );

    this.options.storage.candidateSkillVersions.upsert({
      candidateId,
      versionId,
      sourceKind: "code_mode_generated",
      title: skillTitle,
      summary: run.requestedOutputIntent ?? "Generated candidate skill from Code Mode v1.",
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
    });

    this.options.publishRealtime("candidate_skill_staged", "capabilities", {
      candidateId,
      versionId,
      originatingRunId: run.runId,
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

  private async persistManagedTextArtifact(
    root: string,
    segments: string[],
    filename: string,
    content: string,
    mimeType: string,
  ): Promise<CapabilityArtifactRecord> {
    const targetDir = path.join(root, ...segments.map(sanitizePathSegment));
    await fs.mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, sanitizePathSegment(filename));
    await fs.writeFile(targetPath, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    return {
      artifactId: `artifact-${randomUUID()}`,
      relPath: normalizeRelPath(path.relative(this.options.rootDir, targetPath)),
      sha256: sha256Text(content),
      bytes,
      mimeType,
      createdAt: new Date().toISOString(),
    };
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

function buildSkillLifecycleRecord(skill: LoadedSkill): SkillLifecycleRecord {
  const now = new Date().toISOString();
  const provenance = readSkillProvenance(skill);
  const mapped = mapSkillSource(skill.source, provenance);
  return {
    skillId: skill.skillId,
    category: mapped.category,
    lifecycleState: mapped.lifecycleState,
    trustLabel: mapped.trustLabel,
    reviewWarning: mapped.reviewWarning,
    provenance,
    createdAt: now,
    updatedAt: now,
  };
}

function readSkillProvenance(skill: LoadedSkill): SkillLifecycleRecord["provenance"] | undefined {
  if (skill.source !== "extra") {
    return {
      source: skill.source,
    };
  }
  const manifestPath = path.join(skill.dir, "source.json");
  if (!fsSync.existsSync(manifestPath)) {
    return {
      source: skill.source,
    };
  }
  try {
    const parsed = JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as {
      candidate?: {
        sourceRef?: string;
        sourceProvider?: string;
      };
    };
    return {
      source: skill.source,
      sourceRef: parsed.candidate?.sourceRef,
      sourceProvider: parsed.candidate?.sourceProvider,
    };
  } catch {
    return {
      source: skill.source,
    };
  }
}

function mapSkillSource(
  source: LoadedSkill["source"],
  provenance: SkillLifecycleRecord["provenance"] | undefined,
): Pick<SkillLifecycleRecord, "category" | "lifecycleState" | "trustLabel" | "reviewWarning"> {
  switch (source) {
    case "bundled":
      return {
        category: "built_in",
        lifecycleState: "trusted",
        trustLabel: "Built-in",
      };
    case "managed":
      return {
        category: "optional",
        lifecycleState: "trusted",
        trustLabel: "Managed optional",
      };
    case "workspace":
      return {
        category: "project_local",
        lifecycleState: "approved",
        trustLabel: "Project-local",
      };
    case "extra":
    default:
      return {
        category: "community_imported",
        lifecycleState: "approved",
        trustLabel: "Imported/community",
        reviewWarning: provenance?.sourceRef ? undefined : "Missing provenance manifest; review before trusting.",
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

function resolveManagedRoot(rootDir: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(rootDir, configuredPath);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  return status === "approved" || status === "rejected";
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
    permissionProfileId: input.permissionProfileId,
    permissionProfileLabel: input.permissionProfileLabel,
    localOperatorOverrideId: input.localOperatorOverrideId,
  };
}

function validateGuestSource(source: string): void {
  const forbiddenPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\bimport\s*\(/u, label: "dynamic import" },
    { pattern: /\bimport\s+[^("'`]/u, label: "import statements" },
    { pattern: /\brequire\s*\(/u, label: "require" },
    { pattern: /\bprocess\b/u, label: "process" },
    { pattern: /\bfetch\b/u, label: "fetch" },
    {
      pattern: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/u,
      label: "timers or schedulers",
    },
  ];
  for (const forbidden of forbiddenPatterns) {
    if (forbidden.pattern.test(source)) {
      throw new ValidationError({
        message: `Code Mode source may not reference ${forbidden.label}.`,
      });
    }
  }
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
      startedAt?: string;
    }): CodeModeRunRecord | undefined;
  },
  run: CodeModeRunRecord,
  approvalId: string,
): CodeModeRunRecord | undefined {
  if (!isStaleCodeModeExecutionClaim(run.startedAt)) {
    return undefined;
  }
  return repository.releaseExecutionClaim({
    runId: run.runId,
    approvalId,
    startedAt: run.startedAt,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const __internal = {
  createMinimalSyntheticEnv,
};
