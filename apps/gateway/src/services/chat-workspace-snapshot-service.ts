import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CHAT_WORKSPACE_SNAPSHOT_VERSION,
  canonicalJsonString,
  type ChatWorkspaceSnapshotRecord,
  type ChatWorkspaceSnapshotRequest,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { WorkspacePathBridgeSessionBinding } from "./workspace-path-bridge-integration.js";
import type {
  WorkspacePathBridgeExecutionDecision,
  WorkspacePathBridgeResolutionContext,
} from "./tool-invocation-coordinator-service.js";

const execFileAsync = promisify(execFile);
const MAX_CACHE_ENTRIES = 256;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

class WorkspaceSnapshotGitError extends Error {
  public constructor(public readonly reasonCode: "git_not_repository") {
    super(reasonCode);
  }
}

export interface ChatWorkspaceSnapshotServiceDependencies {
  resolveSessionBinding(
    sessionId: string,
  ): WorkspacePathBridgeSessionBinding | undefined | Promise<WorkspacePathBridgeSessionBinding | undefined>;
  verifyWorkspacePath(
    request: ToolInvokeRequest,
    context: WorkspacePathBridgeResolutionContext,
  ): Promise<WorkspacePathBridgeExecutionDecision>;
  runGit?: (cwd: string, args: readonly string[]) => Promise<string>;
  now?: () => Date;
}

/**
 * Captures one content-free workspace/Git receipt after the existing path
 * bridge verifies the server-owned session/project binding. The bounded cache
 * makes route preflight and the eventual send resolve the same immutable bytes.
 */
export class ChatWorkspaceSnapshotService {
  private readonly cache = new Map<string, ChatWorkspaceSnapshotRecord>();
  private readonly inFlight = new Map<string, Promise<ChatWorkspaceSnapshotRecord>>();
  private readonly boundTurnIds = new Map<string, string>();
  private readonly runGit: NonNullable<ChatWorkspaceSnapshotServiceDependencies["runGit"]>;
  private readonly now: () => Date;

  public constructor(private readonly deps: ChatWorkspaceSnapshotServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.runGit =
      deps.runGit ??
      (async (cwd, args) => {
        const result = await execFileAsync("git", [...args], {
          cwd,
          timeout: 5_000,
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
          encoding: "utf8",
        });
        return result.stdout;
      });
  }

  public async capture(input: {
    sessionId: string;
    turnId: string;
    workspaceId: string;
    request: ChatWorkspaceSnapshotRequest;
  }): Promise<ChatWorkspaceSnapshotRecord> {
    validateCaptureInput(input);
    const cacheKey = digest({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      requestId: input.request.requestId,
    });
    this.bindActualTurn(cacheKey, input.turnId);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const active = this.inFlight.get(cacheKey);
    if (active) return active;

    const capturedAt = this.now().toISOString();
    const pending = this.captureFresh(input, cacheKey, capturedAt);
    this.inFlight.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      if (!this.cache.has(cacheKey)) this.boundTurnIds.delete(cacheKey);
      throw error;
    } finally {
      if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey);
    }
  }

  private async captureFresh(
    input: { sessionId: string; turnId: string; workspaceId: string; request: ChatWorkspaceSnapshotRequest },
    cacheKey: string,
    capturedAt: string,
  ): Promise<ChatWorkspaceSnapshotRecord> {
    let before: WorkspacePathBridgeSessionBinding | undefined;
    try {
      before = await this.deps.resolveSessionBinding(input.sessionId);
    } catch {
      return this.remember(cacheKey, unavailable(input, capturedAt, "workspace_unavailable"));
    }
    if (!before || before.workspaceId !== input.workspaceId) {
      return this.remember(cacheKey, unavailable(input, capturedAt, "workspace_unavailable"));
    }
    if (!before.project) {
      return this.remember(cacheKey, unavailable(input, capturedAt, "project_unbound"));
    }
    const project = {
      projectId: before.project.projectId,
      projectRevision: before.project.revision,
    };
    const verificationRequest: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { cwd: "." },
      agentId: "chat-workspace-snapshot",
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      surface: "chat",
    };
    const invocationStem = `workspace-snapshot-${digest({
      sessionId: input.sessionId,
      turnId: input.turnId,
      requestId: input.request.requestId,
    }).slice(0, 32)}`;
    let verification: WorkspacePathBridgeExecutionDecision;
    try {
      verification = await this.deps.verifyWorkspacePath(verificationRequest, {
        invocationId: `${invocationStem}-before`,
        phase: "pre_execute",
      });
    } catch {
      return this.remember(cacheKey, unavailable(input, capturedAt, "path_verification_failed", project));
    }
    if (
      verification.status !== "verified" ||
      !verification.snapshotFingerprintSha256 ||
      !verification.gitIdentitySha256
    ) {
      return this.remember(cacheKey, unavailable(input, capturedAt, "path_verification_failed", project));
    }

    let git: ChatWorkspaceSnapshotRecord["git"];
    try {
      git = await this.captureGitSummary(verification.canonicalCwd);
    } catch (error) {
      const reason = isGitUnavailable(error)
        ? "git_unavailable"
        : error instanceof WorkspaceSnapshotGitError
          ? error.reasonCode
          : "git_summary_failed";
      return this.remember(cacheKey, unavailable(input, capturedAt, reason, project));
    }

    let after: WorkspacePathBridgeSessionBinding | undefined;
    try {
      after = await this.deps.resolveSessionBinding(input.sessionId);
    } catch {
      return this.remember(cacheKey, unavailable(input, capturedAt, "path_identity_changed", project));
    }
    if (!sameBinding(before, after)) {
      return this.remember(cacheKey, unavailable(input, capturedAt, "path_identity_changed", project));
    }
    let verificationAfter: WorkspacePathBridgeExecutionDecision;
    try {
      verificationAfter = await this.deps.verifyWorkspacePath(verificationRequest, {
        invocationId: `${invocationStem}-after`,
        phase: "pre_execute",
      });
    } catch {
      return this.remember(cacheKey, unavailable(input, capturedAt, "path_identity_changed", project));
    }
    if (!samePathVerification(verification, verificationAfter)) {
      return this.remember(cacheKey, unavailable(input, capturedAt, "path_identity_changed", project));
    }
    const record = seal(
      {
        schemaVersion: CHAT_WORKSPACE_SNAPSHOT_VERSION,
        requestId: input.request.requestId,
        workspaceId: input.workspaceId,
        project,
        status: "captured",
        pathBinding: {
          verificationId: verification.snapshotId,
          fingerprintSha256: verification.snapshotFingerprintSha256,
          gitIdentitySha256: verification.gitIdentitySha256,
        },
        git,
        capturedAt,
      },
      input.sessionId,
    );
    return this.remember(cacheKey, record);
  }

  private bindActualTurn(cacheKey: string, turnId: string): void {
    // Route preflight intentionally shares the eventual turn's one-shot
    // capture. Only a canonical (non-preflight) turn consumes the binding.
    if (turnId.startsWith("capability-preflight-")) return;
    const existing = this.boundTurnIds.get(cacheKey);
    if (existing && existing !== turnId) {
      throw new Error(
        "Workspace snapshot request is already bound to another Chat turn. Refresh the snapshot request.",
      );
    }
    if (!existing) this.boundTurnIds.set(cacheKey, turnId);
  }

  private async captureGitSummary(cwd: string): Promise<NonNullable<ChatWorkspaceSnapshotRecord["git"]>> {
    const inside = (await this.runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") throw new WorkspaceSnapshotGitError("git_not_repository");
    const headSha = (await this.runGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim().toLowerCase();
    if (!/^[a-f0-9]{40,64}$/u.test(headSha)) throw new WorkspaceSnapshotGitError("git_not_repository");
    const status = await this.runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const statusLines = status.split(/\r?\n/u).filter((line) => line.length > 0);
    const untrackedChangeCount = statusLines.filter((line) => line.startsWith("??")).length;
    const trackedChangeCount = statusLines.length - untrackedChangeCount;
    let branch: string | undefined;
    try {
      const candidate = (await this.runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      if (candidate && candidate.length <= 256 && !containsControlCharacter(candidate)) branch = candidate;
    } catch {
      // Detached HEAD is valid point-in-time state; omit branch rather than infer one.
      branch = undefined;
    }
    let ahead: number | undefined;
    let behind: number | undefined;
    try {
      const counts = (await this.runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]))
        .trim()
        .split(/\s+/u)
        .map(Number);
      if (counts.length === 2 && counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
        [behind, ahead] = counts;
      }
    } catch {
      // No upstream is an ordinary repository posture; omit divergence counts.
      ahead = undefined;
      behind = undefined;
    }
    return {
      headSha,
      ...(branch ? { branch } : {}),
      trackedChangeCount,
      untrackedChangeCount,
      dirty: trackedChangeCount + untrackedChangeCount > 0,
      ...(ahead !== undefined ? { ahead } : {}),
      ...(behind !== undefined ? { behind } : {}),
    };
  }

  private remember(key: string, value: ChatWorkspaceSnapshotRecord): ChatWorkspaceSnapshotRecord {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) {
        this.cache.delete(oldest);
        this.boundTurnIds.delete(oldest);
      }
    }
    const immutable = deepFreeze(value);
    this.cache.set(key, immutable);
    return immutable;
  }
}

function unavailable(
  input: { sessionId: string; turnId: string; workspaceId: string; request: ChatWorkspaceSnapshotRequest },
  capturedAt: string,
  reasonCode: Exclude<ChatWorkspaceSnapshotRecord["reasonCode"], undefined>,
  project?: NonNullable<ChatWorkspaceSnapshotRecord["project"]>,
): ChatWorkspaceSnapshotRecord {
  return seal(
    {
      schemaVersion: CHAT_WORKSPACE_SNAPSHOT_VERSION,
      requestId: input.request.requestId,
      workspaceId: input.workspaceId,
      ...(project ? { project } : {}),
      status: "unavailable",
      reasonCode,
      capturedAt,
    },
    input.sessionId,
  );
}

function seal(
  input: Omit<ChatWorkspaceSnapshotRecord, "snapshotId" | "snapshotHash">,
  sessionId: string,
): ChatWorkspaceSnapshotRecord {
  // The evidence identity includes the complete content-free material. A
  // repeated client request after restart can therefore never alias different
  // Git/path evidence under the same snapshot id.
  const withIdentity = {
    ...input,
    snapshotId: `chat-workspace-snapshot-${digest({ sessionId, ...input }).slice(0, 32)}`,
  };
  return { ...withIdentity, snapshotHash: digest(withIdentity) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function validateCaptureInput(input: {
  sessionId: string;
  turnId: string;
  workspaceId: string;
  request: ChatWorkspaceSnapshotRequest;
}): void {
  if (
    !input.sessionId.trim() ||
    input.sessionId.length > 256 ||
    !input.turnId.trim() ||
    input.turnId.length > 256 ||
    !input.workspaceId.trim() ||
    input.workspaceId.length > 256
  ) {
    throw new Error("Workspace snapshot requires bounded session, turn, and workspace identities.");
  }
  if (input.request.capture !== true || !REQUEST_ID.test(input.request.requestId)) {
    throw new Error("Workspace snapshot request is malformed.");
  }
}

function sameBinding(
  left: WorkspacePathBridgeSessionBinding,
  right: WorkspacePathBridgeSessionBinding | undefined,
): boolean {
  return Boolean(
    right &&
    left.workspaceId === right.workspaceId &&
    left.project?.projectId === right.project?.projectId &&
    left.project?.revision === right.project?.revision &&
    left.project?.workspaceId === right.project?.workspaceId &&
    left.project?.workspacePath === right.project?.workspacePath &&
    left.gitIdentity?.expectedIdentitySha256 === right.gitIdentity?.expectedIdentitySha256,
  );
}

function samePathVerification(
  left: WorkspacePathBridgeExecutionDecision,
  right: WorkspacePathBridgeExecutionDecision,
): boolean {
  return Boolean(
    right.status === "verified" &&
    left.status === "verified" &&
    left.canonicalCwd === right.canonicalCwd &&
    left.snapshotFingerprintSha256 === right.snapshotFingerprintSha256 &&
    left.gitIdentitySha256 === right.gitIdentitySha256,
  );
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
