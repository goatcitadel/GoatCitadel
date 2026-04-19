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
  LoadedSkill,
  SkillLifecycleRecord,
  SkillListItem,
  SkillRuntimeState,
  SkillStateRecord,
  ToolCatalogEntry,
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
const CODE_MODE_OUTPUT_CAPTURE_LIMIT_BYTES = 64 * 1024;
const CODE_MODE_IPC_MAX_BYTES = 128 * 1024;
const CODE_MODE_HEAP_MB = 64;

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

export class CapabilitySystemService {
  private readonly candidateRoot: string;
  private readonly artifactRoot: string;
  private readonly tempRoot: string;
  private readonly harnessPath: string;
  private readonly sandboxMetadata: CodeModeSandboxMetadata;

  public constructor(private readonly options: CapabilitySystemServiceOptions) {
    this.candidateRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.candidateRoot);
    this.artifactRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.codeModeArtifactRoot);
    this.tempRoot = resolveManagedRoot(options.rootDir, options.runtimeConfig.tempRoot);
    this.harnessPath = path.join(this.tempRoot, "code-mode-harness.mjs");
    this.sandboxMetadata = resolveCodeModeSandboxMetadata(options.runtimeConfig.codeModeSandbox);
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

  public listCodeModeRuns(limit = 100): CodeModeRunRecord[] {
    return this.options.storage.codeModeRuns.list(limit);
  }

  public getCodeModeRun(runId: string): CodeModeRunRecord {
    return this.options.storage.codeModeRuns.get(runId);
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
    const policySnapshot = this.options.readPolicySnapshot();
    const codeHash = sha256Text(source);
    const wrapperManifestHash = sha256Text(JSON.stringify(wrapperManifest));
    const policySnapshotHash = sha256Text(JSON.stringify(policySnapshot));
    const runId = `code-run-${randomUUID()}`;
    const sandbox = this.sandboxMetadata;

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
      codeHash,
      wrapperManifestHash,
      capabilitySnapshotId: snapshot.snapshotId,
      requestedOutputIntent: request.requestedOutputIntent,
      saveCandidateOnSuccess: Boolean(request.saveCandidateOnSuccess),
      inspectPath: codeArtifact.relPath,
      codePreview: buildCodePreview(source),
      affectedResources: wrapperManifest.wrappers.map((wrapper) => wrapper.name),
      sessionId: request.sessionId,
      turnId: request.turnId,
      sandbox,
    });

    const approval = await this.options.createApproval({
      kind: "code_mode.run",
      riskLevel: "caution",
      payload: approvalPayload,
      preview: approvalPayload,
      linkage: {
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolName: "code_mode.run",
        actionType: "code_mode.run",
      },
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });

    const runRecord: CodeModeRunRecord = {
      runId,
      status: "approval_pending",
      language: request.language,
      requestedOutputIntent: request.requestedOutputIntent,
      saveCandidateOnSuccess: Boolean(request.saveCandidateOnSuccess),
      capabilitySnapshotId: snapshot.snapshotId,
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
    const stored = this.options.storage.codeModeRuns.upsert(runRecord);

    this.options.storage.pendingApprovalActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: "code_mode.run",
      request: {
        runId: stored.runId,
        input: request.input ?? {},
      },
      createdAt,
    });
    this.options.storage.approvalEvents.append({
      approvalId: approval.approvalId,
      eventType: "pending_action_registered",
      actorId: "system",
      payload: {
        actionType: "code_mode.run",
        runId: stored.runId,
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

    this.options.publishRealtime("code_mode_run_created", "capabilities", {
      runId: stored.runId,
      approvalId: stored.approvalId,
      capabilitySnapshotId: stored.capabilitySnapshotId,
      wrapperManifestHash: stored.wrapperManifestHash,
      codeHash: stored.codeHash,
      sandbox,
    });
    return stored;
  }

  public async executeApprovedCodeModeRun(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    const pending = this.options.storage.pendingApprovalActions.find(approvalId);
    if (!pending || pending.resolutionStatus !== "pending" || pending.actionType !== "code_mode.run") {
      return undefined;
    }
    const runId = asOptionalString(pending.request.runId);
    if (!runId) {
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", {
        reason: "missing code mode run id",
      });
      throw new NotFoundError({ entity: "code mode run", id: "missing" });
    }

    const existing = this.options.storage.codeModeRuns.get(runId);
    const runInput = isRecord(pending.request.input) ? pending.request.input : {};
    const startedAt = new Date().toISOString();
    const sandbox = existing.sandbox ?? this.sandboxMetadata;
    this.options.storage.codeModeRuns.upsert({
      ...existing,
      status: "running",
      startedAt,
      sandbox,
    });
    this.options.publishRealtime("code_mode_run_started", "capabilities", {
      runId,
      approvalId,
      startedAt,
      sandbox,
    });

    const source = await fs.readFile(path.resolve(this.options.rootDir, existing.codeArtifact.relPath), "utf8");
    const wrapperManifest = JSON.parse(
      await fs.readFile(path.resolve(this.options.rootDir, existing.wrapperManifestArtifact.relPath), "utf8"),
    ) as CodeModeWrapperManifest;
    const compiledSource = transpileGuestSource(existing.language, source);

    let finalRun = existing;
    try {
      throwIfCapabilitySystemAborted(signal, `Code mode run ${runId} was aborted before execution started.`);
      if (!sandbox.available) {
        this.options.publishRealtime("code_mode_sandbox_unavailable", "capabilities", {
          runId,
          approvalId,
          sandbox,
          failClosedReason: sandbox.failClosedReason,
        });
      }
      assertCodeModeSandboxAvailable(sandbox);
      await this.ensureHarnessFile();
      const execution = await this.executeChildHarness({
        runId,
        sandbox,
        source: compiledSource,
        input: runInput,
        requestedOutputIntent: existing.requestedOutputIntent,
        wrapperManifest,
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
        ...existing,
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
        startedAt,
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

      this.options.storage.pendingApprovalActions.markResolved(approvalId, "executed", {
        outcome: finalRun.status,
        runId: finalRun.runId,
      });
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
          sandbox,
        },
      };
    } catch (error) {
      finalRun = this.options.storage.codeModeRuns.upsert({
        ...finalRun,
        status: "failed",
        sandbox,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      this.options.storage.pendingApprovalActions.markResolved(approvalId, "failed", {
        runId: finalRun.runId,
        error: finalRun.error,
      });
      this.options.publishRealtime("code_mode_run_failed", "capabilities", {
        runId: finalRun.runId,
        approvalId,
        error: finalRun.error,
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
          sandbox,
        },
      };
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
    signal?: AbortSignal;
  }): Promise<{
    result?: Record<string, unknown>;
    error?: string;
    failed: boolean;
    stdout: BoundedCaptureState;
    stderr: BoundedCaptureState;
  }> {
    const runTempRoot = path.join(this.tempRoot, input.runId);
    const preparedSandbox = await prepareCodeModeSandboxLaunch(
      this.options.runtimeConfig.codeModeSandbox,
      {
        runId: input.runId,
        nodePath: process.execPath,
        harnessPath: this.harnessPath,
        runTempRoot,
        heapMb: CODE_MODE_HEAP_MB,
        env: createMinimalSyntheticEnv(),
      },
      { metadata: input.sandbox },
    );

    const child = spawn(preparedSandbox.launch.executable, preparedSandbox.launch.args, {
      shell: preparedSandbox.launch.shell,
      cwd: preparedSandbox.launch.cwd,
      env: preparedSandbox.launch.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const stdout = createBoundedCapture();
    const stderr = createBoundedCapture();
    const abortChild = (reason?: string) => {
      replyToChild({
        jsonrpc: "2.0",
        method: "run.cancel",
        params: {
          reason: reason ?? `Code Mode run ${input.runId} was aborted.`,
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

    const replyToChild = (message: Record<string, unknown>): void => {
      if (!child.connected) {
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (bytes > CODE_MODE_IPC_MAX_BYTES) {
        child.send({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: {
            code: "MESSAGE_TOO_LARGE",
            message: "Code Mode IPC message exceeded the maximum allowed size.",
          },
        });
        return;
      }
      child.send(message);
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
        settlePending(new Error("Code Mode IPC message exceeded the maximum allowed size."));
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
          pending.reject(message.error ?? new Error("Unknown Code Mode IPC error."));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (message.method !== "capability.invoke" || typeof message.id !== "string") {
        return;
      }

      void (async () => {
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
            sessionId: input.runId,
            taskId: input.runId,
            signal: input.signal,
            consentContext: {
              source: "agent",
              reason: `code-mode:${input.runId}`,
            },
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
      return new Promise<TResult>((resolve, reject) => {
        pendingRequests.set(id, {
          resolve: (value) => resolve(value as TResult),
          reject,
        });
        replyToChild({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
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
      await exitPromise.catch(() => undefined);
      return {
        failed: true,
        error: error instanceof Error ? error.message : String(error),
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

function buildCodePreview(source: string): string {
  const compact = source.replace(/\s+/gu, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

function buildCodeModeApprovalPayload(input: {
  runId: string;
  codeHash: string;
  wrapperManifestHash: string;
  capabilitySnapshotId: string;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess: boolean;
  inspectPath: string;
  codePreview: string;
  affectedResources: string[];
  sessionId?: string;
  turnId?: string;
  sandbox: CodeModeSandboxMetadata;
}): Record<string, unknown> {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    description: "Start a sandbox-gated Code Mode v1 run with the frozen wrapper manifest and policy snapshot.",
    riskLevel: "caution",
    affectedResources: input.affectedResources,
    codeHash: input.codeHash,
    wrapperManifestHash: input.wrapperManifestHash,
    capabilitySnapshotId: input.capabilitySnapshotId,
    inspectPath: input.inspectPath,
    codePreview: input.codePreview,
    requestedOutputIntent: input.requestedOutputIntent,
    saveCandidateOnSuccess: input.saveCandidateOnSuccess,
    sandbox: input.sandbox,
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

function createMinimalSyntheticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GOATCITADEL_CODE_MODE: "1",
    TZ: process.env.TZ ?? "UTC",
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "WINDIR", "TEMP", "TMP"]) {
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

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
