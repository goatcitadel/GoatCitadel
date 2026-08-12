import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ChatDelegatedScopeCandidatesResponse,
  ChatDelegatedScopeExpansionResponse,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  DelegatedFilesystemScopeControl,
  DelegatedWorkResult,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { assertWritePathInJail, SUBMIT_WORK_RESULT_TOOL_NAME } from "@goatcitadel/policy-engine";
import { projectWorkspaceExplorerText } from "./workspace-explorer-path-projection.js";

export const DELEGATION_SCOPE_EXPANSION_APPROVAL_KIND = "delegation_scope_expansion" as const;
export const DELEGATION_SCOPE_EXPANSION_EFFECT_KIND = "delegation_scope_expansion_apply" as const;
export const DELEGATION_SCOPE_EXPANSION_RESUME_EFFECT_KIND = "delegation_scope_expansion_resume" as const;

interface DelegatedWorkResultServiceDependencies {
  storage: Storage;
  writeJailRoots: string[];
  isEnabled: () => boolean | Promise<boolean>;
  createApproval: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
  appendAudit?: (payload: Record<string, unknown>) => void | Promise<void>;
}

export class DelegatedWorkResultService {
  public constructor(private readonly deps: DelegatedWorkResultServiceDependencies) {}

  /**
   * Lists only bounded, server-discovered workspace-relative paths. The caller
   * cannot provide a path and the response never includes the delegated host
   * root, so this route is discoverability rather than filesystem authority.
   */
  public async listChatScopeExpansionCandidates(input: {
    sessionId: string;
    runId: string;
    stepId: string;
  }): Promise<ChatDelegatedScopeCandidatesResponse> {
    if (!(await this.deps.isEnabled())) {
      throw new Error("Delegated scope expansion is disabled.");
    }
    const { run, step, scope } = await this.resolveActiveChatScope(input);
    const scopeExpansion =
      step.workResult?.disposition === "scope_expansion" ? step.workResult.scopeExpansion : undefined;
    const pendingApprovalId = scopeExpansion?.decision === undefined ? scopeExpansion?.approvalId : undefined;
    return {
      runId: run.runId,
      stepId: step.stepId,
      scopeHash: scope.scopeHash,
      candidates: pendingApprovalId ? [] : listServerOwnedScopeCandidates(scope, this.deps.writeJailRoots),
      ...(pendingApprovalId ? { pendingApprovalId } : {}),
    };
  }

  /**
   * Resolves opaque candidate ids against a fresh server-owned listing, then
   * enters the same submit_work_result approval/resume path used by delegated
   * workers. Unknown or stale ids fail closed.
   */
  public async requestChatScopeExpansion(input: {
    sessionId: string;
    runId: string;
    stepId: string;
    candidateIds: string[];
  }): Promise<ChatDelegatedScopeExpansionResponse> {
    const candidateIds = [...new Set(input.candidateIds.map((value) => value.trim()))];
    if (
      candidateIds.length < 1 ||
      candidateIds.length > 8 ||
      candidateIds.some((value) => !/^[a-f0-9]{64}$/u.test(value))
    ) {
      throw new Error("Scope expansion requires 1..8 valid server candidate ids.");
    }
    const listed = await this.listChatScopeExpansionCandidates(input);
    if (listed.pendingApprovalId) {
      throw new Error("This delegated step already has a scope-expansion approval pending.");
    }
    const byId = new Map(listed.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const selected = candidateIds.map((candidateId) => byId.get(candidateId));
    if (selected.some((candidate) => !candidate)) {
      throw new Error("A scope candidate is stale or is not eligible for this delegated step.");
    }
    const { run, step, scope } = await this.resolveActiveChatScope(input);
    if (scope.scopeHash !== listed.scopeHash) {
      throw new Error("The delegated scope changed while the request was being prepared. Refresh the candidates.");
    }
    if (!step.childSessionId) {
      throw new Error("The delegated step has no active child session.");
    }
    const workspaceId = (await this.deps.storage.chatSessionMeta.get(input.sessionId))?.workspaceId;
    if (!workspaceId) {
      throw new Error("The parent Chat session has no workspace binding.");
    }
    const result = await this.execute({
      toolName: SUBMIT_WORK_RESULT_TOOL_NAME,
      args: {
        disposition: "scope_expansion",
        summary: "Operator requested additional governed scope from Chat.",
        changedFiles: [],
        evidenceRefs: [],
        scopeExpansion: {
          requestedPaths: selected.map((candidate) => candidate!.label),
          reason: "Operator selected additional server-discovered workspace scope from Chat.",
        },
      },
      agentId: "chat-operator-scope-request",
      sessionId: step.childSessionId,
      workspaceId,
      taskId: run.taskId,
      runId: step.durableRunId,
      surface: "chat",
      consentContext: {
        source: "ui",
        reason: "Operator selected a server-owned delegated scope candidate.",
      },
    });
    if (result.waitingForApproval !== true || typeof result.approvalId !== "string" || result.approvalId.length < 1) {
      throw new Error("Delegated scope expansion did not enter the canonical approval wait.");
    }
    return {
      runId: run.runId,
      stepId: step.stepId,
      approvalId: result.approvalId,
      waitingForApproval: true,
    };
  }

  public async assertToolRequestWithinApprovedScope(request: ToolInvokeRequest): Promise<void> {
    if (!(await this.deps.isEnabled()) || request.toolName === SUBMIT_WORK_RESULT_TOOL_NAME) {
      return;
    }
    const parent = (await this.deps.storage.chatDelegationSteps.listParentsByChildSessionIds([request.sessionId])).get(
      request.sessionId,
    );
    if (!parent) {
      return;
    }
    const scope = (await this.deps.storage.chatDelegationSteps.get(parent.stepId)).scopeControl;
    if (!scope) {
      return;
    }
    if (request.toolName === "git.add") {
      const rawPaths = Array.isArray(request.args?.paths) ? request.args.paths : ["."];
      for (const raw of rawPaths) {
        if (typeof raw !== "string" || !raw.trim()) {
          throw new Error("Delegated git.add paths must be non-empty strings.");
        }
        assertResolvedPathWithinDelegatedScope(scope, raw);
      }
      return;
    }
    const pathKeys = delegatedToolPathKeys(request.toolName);
    for (const key of pathKeys) {
      const raw = request.args?.[key];
      if (typeof raw !== "string" || !raw.trim()) {
        throw new Error(`Delegated tool ${request.toolName} requires a server-resolved ${key} inside scope.`);
      }
      assertResolvedPathWithinDelegatedScope(scope, raw);
    }
  }

  public async execute(request: ToolInvokeRequest): Promise<Record<string, unknown>> {
    if (!(await this.deps.isEnabled())) {
      throw new Error(`${SUBMIT_WORK_RESULT_TOOL_NAME} is disabled.`);
    }
    const parent = (await this.deps.storage.chatDelegationSteps.listParentsByChildSessionIds([request.sessionId])).get(
      request.sessionId,
    );
    if (!parent) {
      throw new Error(`${SUBMIT_WORK_RESULT_TOOL_NAME} is available only inside delegated work.`);
    }
    const step = await this.deps.storage.chatDelegationSteps.get(parent.stepId);
    if (step.status !== "running" || step.childSessionId !== request.sessionId) {
      throw new Error("Delegated work result cannot update an inactive or superseded step.");
    }
    const parsed = parseDelegatedWorkResult(request.args ?? {});
    const explorerProfile = isWorkspaceExplorerRole(step.role);
    if (parsed.disposition !== "scope_expansion") {
      const verified = this.verifyTerminalWorkResult(step.scopeControl, parsed, explorerProfile);
      await this.deps.storage.chatDelegationSteps.patch(step.stepId, { workResult: verified });
      await this.deps.appendAudit?.({
        event: "delegation.work_result_submitted",
        stepId: step.stepId,
        runId: step.runId,
        disposition: verified.disposition,
      });
      return { recorded: true, disposition: verified.disposition, stepId: step.stepId };
    }

    const scope = step.scopeControl;
    if (!scope) {
      throw new Error("Delegated scope expansion requires a server-owned filesystem/worktree scope.");
    }
    const durableRunId = request.runId?.trim();
    if (!durableRunId) {
      throw new Error("Delegated scope expansion requires the active durable child run for governed resume.");
    }
    const requested = normalizeDelegatedScopeExpansionPaths({
      rootPath: scope.rootPath,
      requestedPaths: parsed.scopeExpansion!.requestedPaths,
      currentApprovedPaths: scope.approvedPaths,
      writeJailRoots: this.deps.writeJailRoots,
    });
    const duplicate = step.workResult?.scopeExpansion;
    if (
      step.workResult?.disposition === "scope_expansion" &&
      duplicate?.scopeHash === scope.scopeHash &&
      duplicate.decision === undefined &&
      sameStringSet(duplicate.requestedPaths, requested.relativePaths)
    ) {
      return {
        recorded: true,
        duplicate: true,
        disposition: "scope_expansion",
        approvalId: duplicate.approvalId,
        stepId: step.stepId,
      };
    }
    const requestedAt = new Date().toISOString();
    const projectedSummary = explorerProfile
      ? projectWorkspaceExplorerText(parsed.summary, [scope.rootPath])
      : parsed.summary;
    const projectedReason = explorerProfile
      ? projectWorkspaceExplorerText(parsed.scopeExpansion!.reason, [scope.rootPath])
      : parsed.scopeExpansion!.reason;
    const evidenceRefs = normalizeScopedEvidenceRefs(scope, parsed.evidenceRefs);
    const approval = await this.deps.createApproval({
      kind: DELEGATION_SCOPE_EXPANSION_APPROVAL_KIND,
      riskLevel: "danger",
      linkage: {
        sessionId: request.sessionId,
        turnId: request.turnId ?? step.childTurnId,
        runId: step.runId,
        durableRunId,
        workspaceId: request.workspaceId,
        taskId: request.taskId,
        actionType: DELEGATION_SCOPE_EXPANSION_APPROVAL_KIND,
      },
      payload: {
        schemaVersion: "delegation.scope-expansion.v1",
        stepId: step.stepId,
        delegationRunId: step.runId,
        childSessionId: request.sessionId,
        childTurnId: request.turnId ?? step.childTurnId,
        durableRunId,
        dispatchGeneration: scope.dispatchGeneration,
        scopeHash: scope.scopeHash,
        rootPath: scope.rootPath,
        currentApprovedPaths: scope.approvedPaths,
        requestedPaths: requested.relativePaths,
        resolvedPaths: requested.resolvedPaths,
        reason: projectedReason,
      },
      preview: {
        title: "Expand delegated filesystem scope",
        summary: projectedReason,
        requestedPaths: parsed.scopeExpansion!.requestedPaths,
        resolvedPaths: requested.relativePaths,
        currentApprovedPaths: scope.approvedPaths,
        boundary: "filesystem/worktree paths only",
      },
      rollbackNote: "Rejecting or allowing this approval to expire leaves the existing scope unchanged.",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const workResult: DelegatedWorkResult = {
      disposition: "scope_expansion",
      summary: projectedSummary,
      changedFiles: [],
      evidenceRefs,
      scopeHash: scope.scopeHash,
      dispatchGeneration: scope.dispatchGeneration,
      scopeExpansion: {
        requestedPaths: requested.relativePaths,
        resolvedPaths: requested.resolvedPaths,
        reason: projectedReason,
        scopeHash: scope.scopeHash,
        approvalId: approval.approvalId,
        requestedAt,
      },
    };
    await this.deps.storage.chatDelegationSteps.patch(step.stepId, { workResult });
    await this.deps.appendAudit?.({
      event: "delegation.scope_expansion_requested",
      approvalId: approval.approvalId,
      stepId: step.stepId,
      runId: step.runId,
      dispatchGeneration: scope.dispatchGeneration,
      scopeHash: scope.scopeHash,
      requestedPaths: requested.relativePaths,
    });
    return {
      recorded: true,
      disposition: "scope_expansion",
      approvalId: approval.approvalId,
      stepId: step.stepId,
      waitingForApproval: true,
    };
  }

  private verifyTerminalWorkResult(
    scope: DelegatedFilesystemScopeControl | undefined,
    result: DelegatedWorkResult,
    explorerProfile: boolean,
  ): DelegatedWorkResult {
    if (!scope) {
      return result;
    }
    const evidenceRefs = normalizeScopedEvidenceRefs(scope, result.evidenceRefs);
    const authoritativeResult: DelegatedWorkResult = {
      ...result,
      summary: explorerProfile ? projectWorkspaceExplorerText(result.summary, [scope.rootPath]) : result.summary,
      evidenceRefs,
      scopeHash: scope.scopeHash,
      dispatchGeneration: scope.dispatchGeneration,
    };
    if (result.disposition === "blocked") {
      return authoritativeResult;
    }
    const actualChangedFiles = listGitChangedFiles(scope.rootPath);
    const claimedChangedFiles = result.changedFiles.map(normalizeWorkspaceRelativePath);
    const changedFiles = [...new Set([...actualChangedFiles, ...claimedChangedFiles])].sort();
    const outOfScope = changedFiles.filter((file) => !isWithinApprovedScope(file, scope.approvedPaths));
    if (outOfScope.length < 1) {
      return { ...authoritativeResult, changedFiles };
    }
    const diffHash = readGitDiffHash(scope.rootPath);
    return {
      disposition: "blocked",
      summary: `Verification quarantined an out-of-scope delegated diff: ${outOfScope.join(", ")}`,
      changedFiles,
      evidenceRefs: [...evidenceRefs, `quarantine:delegation-diff:${diffHash}`],
      scopeHash: scope.scopeHash,
      dispatchGeneration: scope.dispatchGeneration,
    };
  }

  private async resolveActiveChatScope(input: { sessionId: string; runId: string; stepId: string }): Promise<{
    run: ChatDelegationRunRecord;
    step: ChatDelegationStepRecord;
    scope: DelegatedFilesystemScopeControl;
  }> {
    const run = await this.deps.storage.chatDelegationRuns.get(input.runId);
    if (run.sessionId !== input.sessionId || run.status !== "running") {
      throw new Error("Delegated scope can be expanded only for an active run in this Chat session.");
    }
    if (!run.roles.some(isChatScopeExpandableRole)) {
      throw new Error("Chat scope expansion is available only for explorer or code delegation work.");
    }
    const step = await this.deps.storage.chatDelegationSteps.get(input.stepId);
    if (step.runId !== run.runId || step.status !== "running" || !isChatScopeExpandableRole(step.role)) {
      throw new Error("Delegated scope can be expanded only for an active step in this run.");
    }
    if (!step.scopeControl) {
      throw new Error("This delegated step has no server-owned filesystem scope.");
    }
    return { run, step, scope: step.scopeControl };
  }
}

function isChatScopeExpandableRole(role: string): boolean {
  const normalized = role
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
  return normalized === "coder" || normalized === "workspace-explorer";
}

function isWorkspaceExplorerRole(role: string): boolean {
  return (
    role
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/gu, "-") === "workspace-explorer"
  );
}

export function buildDelegatedFilesystemScopeControl(input: {
  rootPath: string;
  projectId?: string;
  workingPath?: string;
  approvedPaths: string[];
  dispatchGeneration: string;
  updatedAt?: string;
}): DelegatedFilesystemScopeControl {
  const rootPath = fs.realpathSync(path.resolve(input.rootPath));
  const approvedPaths = [...new Set(input.approvedPaths.map(normalizeInitialApprovedPath))].sort();
  if (approvedPaths.length < 1) {
    throw new Error("Delegated filesystem scope requires at least one approved path.");
  }
  const dispatchGeneration = input.dispatchGeneration.trim();
  if (!dispatchGeneration) {
    throw new Error("Delegated filesystem scope requires a dispatch generation.");
  }
  const workingPath = normalizeInitialApprovedPath(input.workingPath ?? approvedPaths[0]!);
  if (!isWithinApprovedScope(workingPath, approvedPaths)) {
    throw new Error("Delegated filesystem working path must be inside the approved scope.");
  }
  return {
    rootPath,
    ...(input.projectId?.trim() ? { projectId: input.projectId.trim() } : {}),
    workingPath,
    approvedPaths,
    dispatchGeneration,
    scopeHash: hashDelegatedScope({
      rootPath,
      projectId: input.projectId?.trim(),
      workingPath,
      approvedPaths,
      dispatchGeneration,
    }),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function normalizeDelegatedScopeExpansionPaths(input: {
  rootPath: string;
  requestedPaths: string[];
  currentApprovedPaths: string[];
  writeJailRoots: string[];
}): { relativePaths: string[]; resolvedPaths: string[] } {
  const rootPath = fs.realpathSync(path.resolve(input.rootPath));
  const relativePaths: string[] = [];
  const resolvedPaths: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.requestedPaths) {
    const relativePath = normalizeScopeExpansionPath(raw);
    const duplicateKey = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    if (seen.has(duplicateKey)) {
      throw new Error(`Delegated scope expansion contains a duplicate path: ${raw}`);
    }
    seen.add(duplicateKey);
    if (isWithinApprovedScope(relativePath, input.currentApprovedPaths)) {
      continue;
    }
    const resolvedPath = path.resolve(rootPath, relativePath);
    assertInsideRoot(rootPath, resolvedPath);
    assertWritePathInJail(resolvedPath, input.writeJailRoots);
    const existingParent = nearestExistingParent(resolvedPath);
    const realParent = fs.realpathSync(existingParent);
    assertInsideRoot(rootPath, realParent);
    relativePaths.push(relativePath);
    resolvedPaths.push(resolvedPath);
  }
  if (relativePaths.length < 1) {
    throw new Error("Requested paths do not expand the current delegated scope.");
  }
  return { relativePaths: relativePaths.sort(), resolvedPaths: resolvedPaths.sort() };
}

function listServerOwnedScopeCandidates(
  scope: DelegatedFilesystemScopeControl,
  writeJailRoots: string[],
): ChatDelegatedScopeCandidatesResponse["candidates"] {
  const discovered = new Set<string>();
  for (const approvedPath of scope.approvedPaths) {
    let parent = path.posix.dirname(approvedPath.replaceAll("\\", "/"));
    while (parent && parent !== "." && parent !== "/") {
      discovered.add(parent);
      const next = path.posix.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  for (const entry of fs
    .readdirSync(scope.rootPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    discovered.add(entry.name);
  }

  const candidates: ChatDelegatedScopeCandidatesResponse["candidates"] = [];
  for (const relativePath of discovered) {
    try {
      const normalized = normalizeDelegatedScopeExpansionPaths({
        rootPath: scope.rootPath,
        requestedPaths: [relativePath],
        currentApprovedPaths: scope.approvedPaths,
        writeJailRoots,
      }).relativePaths[0];
      if (!normalized) continue;
      candidates.push({
        candidateId: createHash("sha256").update(`${scope.scopeHash}\0${normalized}`, "utf8").digest("hex"),
        label: normalized,
        scopeHash: scope.scopeHash,
      });
    } catch {
      // Intentionally ignore a discovered entry that no longer resolves,
      // crosses a symlink, or is outside the configured jail; it is not
      // eligible for Chat selection.
    }
    if (candidates.length >= 64) break;
  }
  return candidates.sort((left, right) => left.label.localeCompare(right.label));
}

export function hashDelegatedScope(input: {
  rootPath: string;
  projectId?: string;
  workingPath?: string;
  approvedPaths: string[];
  dispatchGeneration: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        rootPath: path.resolve(input.rootPath),
        projectId: input.projectId?.trim() || undefined,
        workingPath: input.workingPath ?? input.approvedPaths[0],
        approvedPaths: [...input.approvedPaths].sort(),
        dispatchGeneration: input.dispatchGeneration,
      }),
      "utf8",
    )
    .digest("hex");
}

function parseDelegatedWorkResult(args: Record<string, unknown>): DelegatedWorkResult {
  const disposition = String(args.disposition ?? "");
  if (!(["completed", "blocked", "scope_expansion"] as const).includes(disposition as never)) {
    throw new Error("submit_work_result requires disposition completed, blocked, or scope_expansion.");
  }
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary || summary.length > 8_000) {
    throw new Error("submit_work_result requires a summary of at most 8,000 characters.");
  }
  const changedFiles = readStringArray(args.changedFiles, 1_000).map(normalizeWorkspaceRelativePath);
  const evidenceRefs = readEvidenceRefArray(args.evidenceRefs);
  if (disposition !== "scope_expansion") {
    return { disposition, summary, changedFiles, evidenceRefs } as DelegatedWorkResult;
  }
  const rawScope = args.scopeExpansion;
  if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    throw new Error("scope_expansion disposition requires scopeExpansion paths and a reason.");
  }
  const scope = rawScope as Record<string, unknown>;
  const requestedPaths = readStringArray(scope.requestedPaths, 100);
  const reason = typeof scope.reason === "string" ? scope.reason.trim() : "";
  if (requestedPaths.length < 1 || !reason || reason.length > 2_000) {
    throw new Error("scopeExpansion requires 1..100 requested paths and a reason of at most 2,000 characters.");
  }
  return {
    disposition: "scope_expansion",
    summary,
    changedFiles: [],
    evidenceRefs,
    scopeExpansion: {
      requestedPaths,
      reason,
      scopeHash: "server-pending",
      requestedAt: new Date().toISOString(),
    },
  };
}

function readStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Expected an array with at most ${maxItems} strings.`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("Array values must be non-empty strings.");
    }
    return item.trim();
  });
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f || codeUnit === 0x7f;
  });
}

function readEvidenceRefArray(value: unknown): string[] {
  return readStringArray(value, 1_000).map((item) => {
    if (item.length > 1_000) {
      throw new Error("Delegated evidence references must be at most 1,000 characters each.");
    }
    if (containsAsciiControlCharacter(item)) {
      throw new Error("Delegated evidence references cannot contain control characters.");
    }
    return item;
  });
}

function normalizeScopedEvidenceRefs(scope: DelegatedFilesystemScopeControl, evidenceRefs: string[]): string[] {
  return evidenceRefs.map((evidenceRef) => {
    if (/^file:/iu.test(evidenceRef)) {
      throw new Error("Delegated evidence references cannot use file URLs.");
    }
    if (!isAbsoluteFilesystemReference(evidenceRef)) {
      return evidenceRef;
    }
    if (!path.isAbsolute(evidenceRef)) {
      throw new Error("Delegated evidence reference uses an absolute path for another host platform.");
    }

    const resolvedPath = path.resolve(evidenceRef);
    assertInsideRoot(scope.rootPath, resolvedPath);
    const existingParent = nearestExistingParent(resolvedPath);
    assertInsideRoot(scope.rootPath, fs.realpathSync(existingParent));
    const relativePath = normalizeWorkspaceRelativePath(
      path.relative(scope.rootPath, resolvedPath).replaceAll("\\", "/") || ".",
    );
    if (!isWithinApprovedScope(relativePath, scope.approvedPaths)) {
      throw new Error("Delegated evidence reference is outside the approved scope.");
    }
    return relativePath;
  });
}

function isAbsoluteFilesystemReference(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function normalizeScopeExpansionPath(raw: string): string {
  const value = raw.trim().replaceAll("\\", "/");
  if (!value || value === "." || path.isAbsolute(value) || /^[a-z]:/i.test(value) || /[*?[\]{}]/.test(value)) {
    throw new Error(`Delegated scope path is broad, absolute, or contains a glob: ${raw}`);
  }
  const normalized = path.posix.normalize(value).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Delegated scope path traverses outside the workspace: ${raw}`);
  }
  return normalized;
}

function normalizeWorkspaceRelativePath(raw: string): string {
  const value = raw.trim().replaceAll("\\", "/");
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(value)) {
    throw new Error(`Invalid workspace-relative path: ${raw}`);
  }
  return normalized;
}

function normalizeInitialApprovedPath(raw: string): string {
  const value = raw.trim().replaceAll("\\", "/");
  if (value === ".") {
    return value;
  }
  return normalizeScopeExpansionPath(value);
}

function assertInsideRoot(rootPath: string, targetPath: string): void {
  const relative = path.relative(rootPath, targetPath);
  if (relative && (path.isAbsolute(relative) || relative.split(/[\\/]+/).includes(".."))) {
    throw new Error(`Resolved path escapes delegated workspace root: ${targetPath}`);
  }
}

function nearestExistingParent(targetPath: string): string {
  let candidate = targetPath;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`No existing parent found for delegated scope path: ${targetPath}`);
    }
    candidate = parent;
  }
  return candidate;
}

function isWithinApprovedScope(relativePath: string, approvedPaths: string[]): boolean {
  const normalizeCase = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const candidate = normalizeCase(relativePath.replaceAll("\\", "/"));
  return approvedPaths.some((approved) => {
    const normalized = normalizeCase(approved.replaceAll("\\", "/").replace(/\/$/, ""));
    return normalized === "." || candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

function listGitChangedFiles(rootPath: string): string[] {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [
      ...new Set(
        output
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
          .map((file) => {
            const target = file.includes(" -> ") ? file.split(" -> ").at(-1)! : file;
            return normalizeWorkspaceRelativePath(target);
          }),
      ),
    ].sort();
  } catch {
    return [];
  }
}

function readGitDiffHash(rootPath: string): string {
  try {
    const diff = execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
      cwd: rootPath,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return createHash("sha256").update(diff, "utf8").digest("hex");
  } catch {
    return createHash("sha256").update("diff-unavailable", "utf8").digest("hex");
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return JSON.stringify(left.map(normalize).sort()) === JSON.stringify(right.map(normalize).sort());
}

function delegatedToolPathKeys(toolName: string): string[] {
  switch (toolName) {
    case "fs.read":
    case "fs.list":
    case "fs.stat":
    case "file.read_range":
    case "file.find":
    case "code.search":
    case "code.search_files":
    case "fs.write":
    case "fs.delete":
    case "git.worktree.create":
    case "git.worktree.remove":
      return ["path"];
    case "fs.copy":
      return ["from", "to"];
    case "fs.move":
      return ["from", "to"];
    case "shell.exec":
    case "shell.exec_background":
    case "tests.run":
    case "lint.run":
    case "build.run":
      return ["cwd"];
    default:
      return [];
  }
}

function assertResolvedPathWithinDelegatedScope(scope: DelegatedFilesystemScopeControl, rawPath: string): void {
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(scope.rootPath, scope.workingPath ?? scope.approvedPaths[0] ?? ".", rawPath);
  assertInsideRoot(scope.rootPath, candidate);
  const existingParent = nearestExistingParent(candidate);
  const realParent = fs.realpathSync(existingParent);
  assertInsideRoot(scope.rootPath, realParent);
  const relative = path.relative(scope.rootPath, candidate).replaceAll("\\", "/") || ".";
  if (!isWithinApprovedScope(relative, scope.approvedPaths)) {
    throw new Error(`Delegated tool path is outside the approved scope: ${relative}`);
  }
}
