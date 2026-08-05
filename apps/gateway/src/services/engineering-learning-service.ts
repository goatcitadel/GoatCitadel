import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonString,
  redactSecretText,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type CodeModeRunVerificationResponse,
  type EngineeringLearningAction,
  type EngineeringLearningRecord,
  type EngineeringLearningStatus,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

export const ENGINEERING_LEARNING_APPROVAL_KIND = "engineering_learning.lifecycle" as const;
export const ENGINEERING_LEARNING_EFFECT_KIND = "engineering_learning_lifecycle_apply" as const;

export interface EngineeringLearningProposalInput {
  workspaceId: string;
  projectId?: string;
  source: EngineeringLearningRecord["source"];
  disposition: "completed";
  changedFiles: string[];
  verificationEvidence: string[];
  failedClaimVerification?: boolean;
  title: string;
  problem: string;
  rootCause: string;
  resolution: string;
  prevention: string;
  failedAttempts?: string[];
  applicablePaths?: string[];
}

export interface EngineeringLearningActionInput {
  action: EngineeringLearningAction;
  actorId?: string;
  targetLearningIds?: string[];
  updates?: Partial<
    Pick<
      EngineeringLearningRecord,
      "title" | "problem" | "rootCause" | "resolution" | "prevention" | "failedAttempts" | "applicablePaths"
    >
  >;
}

interface EngineeringLearningServiceDependencies {
  storage: Pick<Storage, "approvals" | "engineeringLearnings">;
  rootDir: string;
  isEnabled: () => boolean | Promise<boolean>;
  createApproval: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
  resolveSourceRoot: (input: { sessionId?: string; projectId?: string }) => Promise<string | undefined>;
  resolveProjectId?: (sessionId: string) => string | undefined | Promise<string | undefined>;
  appendAudit?: (payload: Record<string, unknown>) => void | Promise<void>;
}

export class EngineeringLearningService {
  public constructor(private readonly deps: EngineeringLearningServiceDependencies) {}

  public async propose(input: EngineeringLearningProposalInput): Promise<EngineeringLearningRecord> {
    await this.requireEnabled();
    if (
      input.disposition !== "completed" ||
      input.failedClaimVerification === true ||
      input.changedFiles.length < 1 ||
      input.verificationEvidence.map((item) => item.trim()).filter(Boolean).length < 1
    ) {
      throw new Error(
        "Engineering learning proposals require completed code work, changed files, and verified evidence.",
      );
    }
    const sourceRunId = requiredText(input.source.runId, "source run", 256);
    const existing = await this.readBySourceRun(input.workspaceId, sourceRunId);
    if (existing) return await this.refreshFreshness(existing);
    const sourceRoot = await this.deps.resolveSourceRoot({
      sessionId: input.source.sessionId,
      projectId: input.projectId,
    });
    if (!sourceRoot) {
      throw new Error("Engineering learning proposal has no current project/worktree source root.");
    }
    const fileEvidence = materializeFileEvidence(sourceRoot, input.changedFiles);
    if (fileEvidence.length < 1) {
      throw new Error("Engineering learning proposal could not hash any changed files.");
    }
    const now = new Date().toISOString();
    const learningId = `learning-${randomUUID()}`;
    const applicablePaths = normalizeApplicablePaths(
      input.applicablePaths?.length ? input.applicablePaths : input.changedFiles,
    );
    const sanitized = sanitizeProposalText(input);
    const source = {
      ...input.source,
      runId: sourceRunId,
      ...(input.source.commitSha ? { commitSha: input.source.commitSha.trim() } : {}),
    };
    const fingerprint = buildLearningFingerprint({
      title: sanitized.title,
      problem: sanitized.problem,
      applicablePaths,
      fileEvidence,
    });
    const base = {
      learningId,
      workspaceId: requiredText(input.workspaceId, "workspace", 256),
      ...(input.projectId ? { projectId: requiredText(input.projectId, "project", 256) } : {}),
      status: "proposed" as const,
      ...sanitized,
      applicablePaths,
      source,
      fileEvidence,
      verificationEvidence: input.verificationEvidence.map((item) => safeText(item, 1_000)).filter(Boolean),
      createdAt: now,
      updatedAt: now,
    };
    const record: EngineeringLearningRecord = {
      ...base,
      provenanceHash: sha256(canonicalJsonString(base)),
    };
    await this.deps.storage.engineeringLearnings.create(record, fingerprint);
    await this.deps.appendAudit?.({ event: "engineering_learning.proposed", learningId, sourceRunId });
    return record;
  }

  public async proposeFromVerifiedCodeModeRun(
    response: CodeModeRunVerificationResponse,
  ): Promise<EngineeringLearningRecord | undefined> {
    if (!(await this.deps.isEnabled()) || response.evidence.status !== "verified") return undefined;
    const run = response.run;
    const changedFiles = response.evidence.subject.changedFiles;
    if (run.status !== "completed" || changedFiles.length < 1) return undefined;
    const projectId = run.sessionId ? await this.deps.resolveProjectId?.(run.sessionId) : undefined;
    const result = run.result && typeof run.result === "object" ? run.result : {};
    const resultSummary = firstRecordText(result, ["summary", "message", "output", "result"]);
    return await this.propose({
      workspaceId: run.workspaceId ?? "default",
      projectId,
      source: {
        runId: run.runId,
        sessionId: run.sessionId,
        turnId: run.turnId,
        patchArtifactId: run.stdoutArtifact?.artifactId,
        commitSha: response.evidence.subject.worktreeHeadHash,
      },
      disposition: "completed",
      changedFiles,
      verificationEvidence: [
        `code-mode-verification:${response.evidence.evidenceId}`,
        ...response.evidence.outputArtifactRefs.map((ref) => `artifact:${ref}`),
      ],
      title: run.requestedOutputIntent?.trim() || `Verified Code Mode change ${run.runId}`,
      problem: run.requestedOutputIntent?.trim() || "A verified Code Mode task changed the project.",
      rootCause:
        firstRecordText(result, ["rootCause", "root_cause"]) ||
        "Root cause was not explicitly captured by the code run and must be reviewed before activation.",
      resolution: resultSummary || `Applied and verified changes in ${changedFiles.join(", ")}.`,
      prevention:
        firstRecordText(result, ["prevention", "preventRecurrence"]) ||
        `Retain the named verification evidence and recheck the affected paths: ${changedFiles.join(", ")}.`,
      failedAttempts: readRecordStringArray(result.failedAttempts),
      applicablePaths: changedFiles,
    });
  }

  public async list(input: {
    workspaceId: string;
    projectId?: string;
    status?: EngineeringLearningStatus;
    limit?: number;
  }): Promise<{
    items: EngineeringLearningRecord[];
  }> {
    await this.requireEnabled();
    const records = await this.deps.storage.engineeringLearnings.list(input);
    return { items: await Promise.all(records.map((record) => this.refreshFreshness(record))) };
  }

  public async get(learningId: string): Promise<EngineeringLearningRecord> {
    await this.requireEnabled();
    const record = await this.read(learningId);
    if (!record) throw new Error(`Engineering learning not found: ${learningId}`);
    return await this.refreshFreshness(record);
  }

  public async retrieveContext(input: {
    workspaceId: string;
    projectId?: string;
    paths?: string[];
    limit?: number;
  }): Promise<{
    items: EngineeringLearningRecord[];
    citations: Array<{ learningId: string; sourceRunId: string; evidence: string[] }>;
  }> {
    const candidates = (
      await this.list({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        status: "active",
        limit: input.limit ?? 20,
      })
    ).items;
    const paths = normalizeApplicablePaths(input.paths ?? []);
    const items = candidates.filter(
      (record) => record.status === "active" && (paths.length === 0 || pathsOverlap(paths, record.applicablePaths)),
    );
    return {
      items,
      citations: items.map((record) => ({
        learningId: record.learningId,
        sourceRunId: record.source.runId,
        evidence: [...record.verificationEvidence],
      })),
    };
  }

  public async findOverlaps(learningId: string): Promise<EngineeringLearningRecord[]> {
    const learning = await this.get(learningId);
    return (await this.deps.storage.engineeringLearnings.listWorkspaceExcept(learning.workspaceId, learningId)).filter(
      (candidate) =>
        normalizedSubject(candidate) === normalizedSubject(learning) ||
        pathsOverlap(candidate.applicablePaths, learning.applicablePaths) ||
        candidate.fileEvidence.some((file) => learning.fileEvidence.some((other) => other.sha256 === file.sha256)),
    );
  }

  public async requestAction(learningId: string, input: EngineeringLearningActionInput): Promise<ApprovalRequest> {
    await this.requireEnabled();
    const learning = await this.get(learningId);
    if (input.action === "activate" && learning.status === "stale") {
      throw new Error("Stale engineering learnings must be updated or replaced before activation.");
    }
    const targetLearningIds = [...new Set((input.targetLearningIds ?? []).map((item) => item.trim()).filter(Boolean))];
    for (const targetId of targetLearningIds) await this.get(targetId);
    const updates = input.updates ? sanitizeLearningUpdates(input.updates) : undefined;
    const payload = {
      schemaVersion: "engineering-learning.lifecycle.v1",
      learningId,
      action: input.action,
      expectedProvenanceHash: learning.provenanceHash,
      targetLearningIds,
      updates,
    };
    const approval = await this.deps.createApproval({
      kind: ENGINEERING_LEARNING_APPROVAL_KIND,
      riskLevel: input.action === "reject" || input.action === "archive" ? "caution" : "danger",
      linkage: {
        workspaceId: learning.workspaceId,
        sessionId: learning.source.sessionId,
        turnId: learning.source.turnId,
        runId: learning.source.runId,
        actionType: ENGINEERING_LEARNING_APPROVAL_KIND,
        operatorId: input.actorId,
      },
      payload,
      preview: {
        title: `${input.action} engineering learning`,
        learningId,
        learningTitle: learning.title,
        status: learning.status,
        targetLearningIds,
        evidence: learning.verificationEvidence,
      },
      rollbackNote: "The learning remains outside automatic context until this lifecycle effect completes.",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    await this.deps.appendAudit?.({
      event: "engineering_learning.action_requested",
      learningId,
      action: input.action,
      approvalId: approval.approvalId,
    });
    return approval;
  }

  public async applyApprovedAction(approvalId: string): Promise<{
    learningId: string;
    action: EngineeringLearningAction;
    status: EngineeringLearningStatus;
  }> {
    const approval = await this.deps.storage.approvals.get(approvalId);
    if (!approval || approval.kind !== ENGINEERING_LEARNING_APPROVAL_KIND || approval.status !== "approved") {
      throw new Error(`Approval ${approvalId} is not an approved engineering-learning lifecycle request.`);
    }
    const payload = approval.payload;
    const learningId = requiredText(payload.learningId, "learning", 256);
    const action = payload.action as EngineeringLearningAction;
    if (!["activate", "update", "consolidate", "replace", "reject", "archive"].includes(action)) {
      throw new Error("Engineering learning lifecycle action is invalid.");
    }
    const current = await this.get(learningId);
    if (current.provenanceHash !== payload.expectedProvenanceHash) {
      throw new Error("Engineering learning changed after approval was requested.");
    }
    if (["activate", "replace", "consolidate"].includes(action) && current.status === "stale") {
      throw new Error("Stale engineering learnings must be updated before they can become active context.");
    }
    const updates = isRecord(payload.updates) ? sanitizeLearningUpdates(payload.updates) : undefined;
    const targets = readRecordStringArray(payload.targetLearningIds);
    const status: EngineeringLearningStatus =
      action === "activate" || action === "replace" || action === "consolidate"
        ? "active"
        : action === "reject"
          ? "rejected"
          : action === "archive"
            ? "archived"
            : current.status;
    const updatedAt = new Date().toISOString();
    const nextWithoutHash = {
      ...current,
      ...(updates ?? {}),
      status,
      ...(targets[0] ? { supersedesLearningId: targets[0] } : {}),
      updatedAt,
    };
    const next: EngineeringLearningRecord = {
      ...nextWithoutHash,
      provenanceHash: sha256(canonicalJsonString(nextWithoutHash)),
    };
    await this.persistRecord(next);
    if (action === "replace" || action === "consolidate") {
      for (const targetId of targets) {
        const target = await this.read(targetId);
        if (!target || target.workspaceId !== current.workspaceId) continue;
        const supersededWithoutHash = {
          ...target,
          status: "superseded",
          supersedesLearningId: learningId,
          updatedAt,
        } as const;
        await this.persistRecord({
          ...supersededWithoutHash,
          provenanceHash: sha256(canonicalJsonString(supersededWithoutHash)),
        });
      }
    }
    await this.deps.appendAudit?.({
      event: "engineering_learning.lifecycle_applied",
      learningId,
      action,
      status,
      approvalId,
    });
    return { learningId, action, status };
  }

  public async refreshAll(limit = 500): Promise<number> {
    if (!(await this.deps.isEnabled())) return 0;
    const records = await this.deps.storage.engineeringLearnings.listRefreshCandidates(limit);
    let stale = 0;
    for (const record of records) {
      if ((await this.refreshFreshness(record)).status === "stale") stale += 1;
    }
    return stale;
  }

  private async refreshFreshness(record: EngineeringLearningRecord): Promise<EngineeringLearningRecord> {
    if (record.status !== "active" && record.status !== "proposed") return record;
    const root = await this.deps.resolveSourceRoot({ sessionId: record.source.sessionId, projectId: record.projectId });
    const reasons: string[] = [];
    if (!root) {
      reasons.push("source_root_missing");
    } else {
      for (const file of record.fileEvidence) {
        const target = resolveEvidencePath(root, file.path);
        if (!fs.existsSync(target)) reasons.push(`source_missing:${file.path}`);
        else if (sha256(fs.readFileSync(target)) !== file.sha256) reasons.push(`source_changed:${file.path}`);
      }
      if (record.source.commitSha && !isReachableCommit(root, record.source.commitSha)) {
        reasons.push("source_commit_unreachable");
      }
    }
    if (reasons.length < 1) return record;
    const updatedAt = new Date().toISOString();
    const staleWithoutHash = { ...record, status: "stale" as const, staleReasons: reasons, updatedAt };
    const next: EngineeringLearningRecord = {
      ...staleWithoutHash,
      provenanceHash: sha256(canonicalJsonString(staleWithoutHash)),
    };
    await this.persistRecord(next);
    await this.deps.appendAudit?.({
      event: "engineering_learning.marked_stale",
      learningId: record.learningId,
      reasons,
    });
    return next;
  }

  private async persistRecord(record: EngineeringLearningRecord): Promise<void> {
    const fingerprint = buildLearningFingerprint(record);
    await this.deps.storage.engineeringLearnings.update(record, fingerprint);
  }

  private async read(learningId: string): Promise<EngineeringLearningRecord | undefined> {
    return this.deps.storage.engineeringLearnings.get(learningId);
  }

  private async readBySourceRun(
    workspaceId: string,
    sourceRunId: string,
  ): Promise<EngineeringLearningRecord | undefined> {
    return this.deps.storage.engineeringLearnings.getBySourceRun(workspaceId, sourceRunId);
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.deps.isEnabled())) throw new Error("Feature engineeringLearningsV1Enabled is disabled.");
  }
}

function materializeFileEvidence(root: string, files: string[]): EngineeringLearningRecord["fileEvidence"] {
  return normalizeApplicablePaths(files).flatMap((relativePath) => {
    const target = resolveEvidencePath(root, relativePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return [];
    return [{ path: relativePath, sha256: sha256(fs.readFileSync(target)) }];
  });
}

function resolveEvidencePath(root: string, relativePath: string): string {
  const realRoot = fs.realpathSync(path.resolve(root));
  const target = path.resolve(realRoot, relativePath);
  const relative = path.relative(realRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Learning evidence escapes source root: ${relativePath}`);
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`Learning evidence has no existing parent: ${relativePath}`);
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const realRelative = path.relative(realRoot, realExisting);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Learning evidence escapes source root through a link: ${relativePath}`);
  }
  return target;
}

function normalizeApplicablePaths(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        const normalized = path.posix.normalize(value.trim().replaceAll("\\", "/")).replace(/^\.\//, "");
        if (
          !normalized ||
          normalized === "." ||
          normalized === ".." ||
          normalized.startsWith("../") ||
          path.isAbsolute(value)
        ) {
          throw new Error(`Invalid engineering learning path: ${value}`);
        }
        return normalized;
      }),
    ),
  ].sort();
}

function sanitizeProposalText(
  input: EngineeringLearningProposalInput,
): Pick<EngineeringLearningRecord, "title" | "problem" | "rootCause" | "resolution" | "prevention" | "failedAttempts"> {
  return {
    title: safeText(input.title, 300),
    problem: safeText(input.problem, 8_000),
    rootCause: safeText(input.rootCause, 8_000),
    resolution: safeText(input.resolution, 8_000),
    prevention: safeText(input.prevention, 8_000),
    failedAttempts: (input.failedAttempts ?? []).map((item) => safeText(item, 2_000)).filter(Boolean),
  };
}

function sanitizeLearningUpdates(value: Record<string, unknown>): EngineeringLearningActionInput["updates"] {
  return {
    ...(typeof value.title === "string" ? { title: safeText(value.title, 300) } : {}),
    ...(typeof value.problem === "string" ? { problem: safeText(value.problem, 8_000) } : {}),
    ...(typeof value.rootCause === "string" ? { rootCause: safeText(value.rootCause, 8_000) } : {}),
    ...(typeof value.resolution === "string" ? { resolution: safeText(value.resolution, 8_000) } : {}),
    ...(typeof value.prevention === "string" ? { prevention: safeText(value.prevention, 8_000) } : {}),
    ...(Array.isArray(value.failedAttempts)
      ? { failedAttempts: readRecordStringArray(value.failedAttempts).map((item) => safeText(item, 2_000)) }
      : {}),
    ...(Array.isArray(value.applicablePaths)
      ? { applicablePaths: normalizeApplicablePaths(readRecordStringArray(value.applicablePaths)) }
      : {}),
  };
}

function buildLearningFingerprint(
  input: Pick<EngineeringLearningRecord, "title" | "problem" | "applicablePaths" | "fileEvidence">,
): string {
  return sha256(
    canonicalJsonString({ subject: normalizedSubject(input), paths: input.applicablePaths, files: input.fileEvidence }),
  );
}

function normalizedSubject(input: Pick<EngineeringLearningRecord, "title" | "problem">): string {
  return `${input.title} ${input.problem}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pathsOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function firstRecordText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return safeText(value, 8_000);
  }
  return undefined;
}

function readRecordStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label} is required.`);
  return value.trim();
}

function safeText(value: string, max: number): string {
  return redactSecretText(value).value.trim().slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isReachableCommit(root: string, commit: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
