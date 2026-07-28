import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  DelegatedFilesystemScopeControl,
  DelegatedWorkResult,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { assertWritePathInJail, SUBMIT_WORK_RESULT_TOOL_NAME } from "@goatcitadel/policy-engine";

export const DELEGATION_SCOPE_EXPANSION_APPROVAL_KIND = "delegation_scope_expansion" as const;
export const DELEGATION_SCOPE_EXPANSION_EFFECT_KIND = "delegation_scope_expansion_apply" as const;

interface DelegatedWorkResultServiceDependencies {
  storage: Storage;
  writeJailRoots: string[];
  isEnabled: () => boolean;
  createApproval: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
  appendAudit?: (payload: Record<string, unknown>) => void;
}

export class DelegatedWorkResultService {
  public constructor(private readonly deps: DelegatedWorkResultServiceDependencies) {}

  public assertToolRequestWithinApprovedScope(request: ToolInvokeRequest): void {
    if (!this.deps.isEnabled() || request.toolName === SUBMIT_WORK_RESULT_TOOL_NAME) {
      return;
    }
    const parent = this.deps.storage.chatDelegationSteps
      .listParentsByChildSessionIds([request.sessionId])
      .get(request.sessionId);
    if (!parent) {
      return;
    }
    const scope = this.deps.storage.chatDelegationSteps.get(parent.stepId).scopeControl;
    if (!scope) {
      return;
    }
    if (request.toolName === "git.add") {
      const rawPaths = Array.isArray(request.args?.paths) ? request.args.paths : ["."];
      for (const raw of rawPaths) {
        if (typeof raw !== "string" || !raw.trim()) {
          throw new Error("Delegated git.add paths must be non-empty strings.");
        }
        assertResolvedPathWithinDelegatedScope(scope, path.resolve(scope.rootPath, raw));
      }
      return;
    }
    const pathKeys = delegatedMutationPathKeys(request.toolName);
    for (const key of pathKeys) {
      const raw = request.args?.[key];
      if (typeof raw !== "string" || !raw.trim()) {
        throw new Error(`Delegated mutation ${request.toolName} requires a server-resolved ${key} inside scope.`);
      }
      assertResolvedPathWithinDelegatedScope(scope, raw);
    }
  }

  public async execute(request: ToolInvokeRequest): Promise<Record<string, unknown>> {
    if (!this.deps.isEnabled()) {
      throw new Error(`${SUBMIT_WORK_RESULT_TOOL_NAME} is disabled.`);
    }
    const parent = this.deps.storage.chatDelegationSteps
      .listParentsByChildSessionIds([request.sessionId])
      .get(request.sessionId);
    if (!parent) {
      throw new Error(`${SUBMIT_WORK_RESULT_TOOL_NAME} is available only inside delegated work.`);
    }
    const step = this.deps.storage.chatDelegationSteps.get(parent.stepId);
    if (step.status !== "running" || step.childSessionId !== request.sessionId) {
      throw new Error("Delegated work result cannot update an inactive or superseded step.");
    }
    const parsed = parseDelegatedWorkResult(request.args ?? {});
    if (parsed.disposition !== "scope_expansion") {
      const verified = this.verifyTerminalWorkResult(step.scopeControl, parsed);
      this.deps.storage.chatDelegationSteps.patch(step.stepId, { workResult: verified });
      this.deps.appendAudit?.({
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
    const approval = await this.deps.createApproval({
      kind: DELEGATION_SCOPE_EXPANSION_APPROVAL_KIND,
      riskLevel: "danger",
      linkage: {
        sessionId: request.sessionId,
        runId: step.runId,
        durableRunId: request.runId,
        workspaceId: request.workspaceId,
        taskId: request.taskId,
        actionType: DELEGATION_SCOPE_EXPANSION_APPROVAL_KIND,
      },
      payload: {
        schemaVersion: "delegation.scope-expansion.v1",
        stepId: step.stepId,
        delegationRunId: step.runId,
        childSessionId: request.sessionId,
        durableRunId: request.runId,
        dispatchGeneration: scope.dispatchGeneration,
        scopeHash: scope.scopeHash,
        rootPath: scope.rootPath,
        currentApprovedPaths: scope.approvedPaths,
        requestedPaths: requested.relativePaths,
        resolvedPaths: requested.resolvedPaths,
        reason: parsed.scopeExpansion!.reason,
      },
      preview: {
        title: "Expand delegated filesystem scope",
        summary: parsed.scopeExpansion!.reason,
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
      summary: parsed.summary,
      changedFiles: [],
      evidenceRefs: parsed.evidenceRefs,
      scopeHash: scope.scopeHash,
      dispatchGeneration: scope.dispatchGeneration,
      scopeExpansion: {
        requestedPaths: requested.relativePaths,
        resolvedPaths: requested.resolvedPaths,
        reason: parsed.scopeExpansion!.reason,
        scopeHash: scope.scopeHash,
        approvalId: approval.approvalId,
        requestedAt,
      },
    };
    this.deps.storage.chatDelegationSteps.patch(step.stepId, { workResult });
    this.deps.appendAudit?.({
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
  ): DelegatedWorkResult {
    if (!scope) {
      return result;
    }
    const authoritativeResult: DelegatedWorkResult = {
      ...result,
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
      evidenceRefs: [...result.evidenceRefs, `quarantine:delegation-diff:${diffHash}`],
      scopeHash: scope.scopeHash,
      dispatchGeneration: scope.dispatchGeneration,
    };
  }
}

export function buildDelegatedFilesystemScopeControl(input: {
  rootPath: string;
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
  return {
    rootPath,
    approvedPaths,
    dispatchGeneration,
    scopeHash: hashDelegatedScope({ rootPath, approvedPaths, dispatchGeneration }),
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

export function hashDelegatedScope(input: {
  rootPath: string;
  approvedPaths: string[];
  dispatchGeneration: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        rootPath: path.resolve(input.rootPath),
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
  const evidenceRefs = readStringArray(args.evidenceRefs, 1_000);
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

function delegatedMutationPathKeys(toolName: string): string[] {
  switch (toolName) {
    case "fs.write":
    case "fs.delete":
    case "git.worktree.create":
    case "git.worktree.remove":
      return ["path"];
    case "fs.copy":
      return ["to"];
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
  const candidate = path.resolve(rawPath);
  assertInsideRoot(scope.rootPath, candidate);
  const existingParent = nearestExistingParent(candidate);
  const realParent = fs.realpathSync(existingParent);
  assertInsideRoot(scope.rootPath, realParent);
  const relative = path.relative(scope.rootPath, candidate).replaceAll("\\", "/") || ".";
  if (!isWithinApprovedScope(relative, scope.approvedPaths)) {
    throw new Error(`Delegated mutation path is outside the approved scope: ${relative}`);
  }
}
