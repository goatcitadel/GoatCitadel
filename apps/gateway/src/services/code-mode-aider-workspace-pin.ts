import type { CodeModeAiderWorkspacePin } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { parseCodeModeAiderWorkspacePin } from "./code-mode-aider-result-contract.js";
import {
  CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
  captureCodeModeWorkbenchWorktree,
  runCodeModeGit,
} from "./code-mode-worktree-capture.js";

/**
 * Aider workspace pin: captured at plan time against a ready, clean Chat workbench, and resolved back into a seed at
 * execution time. The pin binds the worktree identity (sessionId + projectId + realpath) and the exact HEAD commit;
 * a run without a pin can never be promoted.
 */

export interface CodeModeAiderWorkspacePinDeps {
  storage: Pick<AsyncStorage, "chatSessionWorkbench">;
  rootDir: string;
}

export interface CodeModeAiderWorkspaceSeed {
  worktreePath: string;
  baseCommit: string;
  pin: CodeModeAiderWorkspacePin;
}

const MAX_GIT_CAPTURE_TIMEOUT_MS = 120_000;

/**
 * Returns a pin only for a ready workbench whose worktree captures cleanly with no changed or untracked files.
 * Dirty, not-ready, outside-root or sessionless workbenches get no pin. Storage errors propagate.
 */
export async function captureCodeModeAiderWorkspacePin(
  deps: CodeModeAiderWorkspacePinDeps,
  binding: { sessionId: string; runId: string },
  options: { now?: () => Date; gitCaptureTimeoutMs?: number } = {},
): Promise<CodeModeAiderWorkspacePin | undefined> {
  const capture = await captureCodeModeWorkbenchWorktree(
    deps.storage,
    binding,
    normalizeTimeout(options.gitCaptureTimeoutMs),
    { rootDir: deps.rootDir },
  );
  if (!capture.valid || !capture.headHash || capture.changedFiles.length !== 0 || capture.changedFilesTruncated) {
    return undefined;
  }
  return {
    version: 1,
    sessionId: binding.sessionId,
    worktreeIdentityHash: capture.identityHash,
    worktreeHead: capture.headHash,
    worktreeStateHash: capture.stateHash,
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * Resolves the pinned worktree for execution. Fails closed when the run's session differs from the pin, the
 * workbench is no longer ready, the worktree identity changed, or the pinned commit is unavailable. HEAD and the
 * working tree may have moved since the pin: the seed always uses the pinned commit.
 */
export async function resolveCodeModeAiderWorkspaceSeed(
  deps: CodeModeAiderWorkspacePinDeps,
  pin: CodeModeAiderWorkspacePin,
  run: { sessionId?: string; runId: string },
  options: { gitCaptureTimeoutMs?: number } = {},
): Promise<CodeModeAiderWorkspaceSeed> {
  const parsedPin = parseCodeModeAiderWorkspacePin(pin);
  if (!run.sessionId || run.sessionId !== parsedPin.sessionId) {
    throw new Error(`Aider run ${run.runId} session does not match its workspace pin.`);
  }
  const timeoutMs = normalizeTimeout(options.gitCaptureTimeoutMs);
  const capture = await captureCodeModeWorkbenchWorktree(
    deps.storage,
    { sessionId: run.sessionId, runId: run.runId },
    timeoutMs,
    { rootDir: deps.rootDir },
  );
  if (!capture.valid || !capture.worktreePath) {
    throw new Error(
      `Aider run ${run.runId} pinned workbench is not ready (${capture.reasons.join(", ") || "worktree_not_ready"}).`,
    );
  }
  if (capture.identityHash !== parsedPin.worktreeIdentityHash) {
    throw new Error(`Aider run ${run.runId} workbench worktree identity no longer matches its workspace pin.`);
  }
  assertPinnedCommitPresent(capture.worktreePath, parsedPin.worktreeHead, timeoutMs, run.runId);
  return { worktreePath: capture.worktreePath, baseCommit: parsedPin.worktreeHead, pin: parsedPin };
}

function assertPinnedCommitPresent(worktreePath: string, commit: string, timeoutMs: number, runId: string): void {
  try {
    runCodeModeGit(["cat-file", "-e", `${commit}^{commit}`], { cwd: worktreePath, timeoutMs });
  } catch (error) {
    throw new Error(`Aider run ${runId} pinned commit is not available in the workbench worktree.`, { cause: error });
  }
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_GIT_CAPTURE_TIMEOUT_MS)
    : CODE_MODE_GIT_CAPTURE_TIMEOUT_MS;
}
