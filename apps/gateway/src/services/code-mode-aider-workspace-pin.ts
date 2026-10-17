import { ConflictError, type CodeModeAiderWorkspacePin } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { parseCodeModeAiderWorkspacePin } from "./code-mode-aider-result-contract.js";
import {
  CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
  captureCodeModeWorkbenchWorktree,
  runCodeModeGitAsync,
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
 * A deterministic pin or seed refusal: the frozen pin, the run binding or the pinned commit itself can never seed,
 * so retrying the dispatch would repeat the same refusal. Execution rethrows it unchanged to terminalize the run.
 * Transient failures (storage, Git processes, a workbench that is not ready yet) stay plain errors.
 */
export class CodeModeAiderWorkspaceRefusal extends ConflictError {
  constructor(message: string) {
    super({ message, details: { reason: "aider_workspace_refused" } });
    this.name = "CodeModeAiderWorkspaceRefusal";
  }
}

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
    { rootDir: deps.rootDir, asyncGit: true },
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
  let parsedPin: CodeModeAiderWorkspacePin;
  try {
    parsedPin = parseCodeModeAiderWorkspacePin(pin);
  } catch (error) {
    throw new CodeModeAiderWorkspaceRefusal(
      `Aider run ${run.runId} workspace pin is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!run.sessionId || run.sessionId !== parsedPin.sessionId) {
    throw new CodeModeAiderWorkspaceRefusal(`Aider run ${run.runId} session does not match its workspace pin.`);
  }
  const timeoutMs = normalizeTimeout(options.gitCaptureTimeoutMs);
  const capture = await captureCodeModeWorkbenchWorktree(
    deps.storage,
    { sessionId: run.sessionId, runId: run.runId },
    timeoutMs,
    { rootDir: deps.rootDir, asyncGit: true },
  );
  if (!capture.valid || !capture.worktreePath) {
    throw new Error(
      `Aider run ${run.runId} pinned workbench is not ready (${capture.reasons.join(", ") || "worktree_not_ready"}).`,
    );
  }
  if (capture.identityHash !== parsedPin.worktreeIdentityHash) {
    // The identity binds session, project and worktree realpath: a re-pointed workbench is a different workspace.
    throw new CodeModeAiderWorkspaceRefusal(
      `Aider run ${run.runId} workbench worktree identity no longer matches its workspace pin.`,
    );
  }
  await assertPinnedCommitPresent(capture.worktreePath, parsedPin.worktreeHead, timeoutMs, run.runId);
  return { worktreePath: capture.worktreePath, baseCommit: parsedPin.worktreeHead, pin: parsedPin };
}

async function assertPinnedCommitPresent(
  worktreePath: string,
  commit: string,
  timeoutMs: number,
  runId: string,
): Promise<void> {
  try {
    await runCodeModeGitAsync(["cat-file", "-e", `${commit}^{commit}`], { cwd: worktreePath, timeoutMs });
  } catch (error) {
    throw new Error(`Aider run ${runId} pinned commit is not available in the workbench worktree.`, { cause: error });
  }
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_GIT_CAPTURE_TIMEOUT_MS)
    : CODE_MODE_GIT_CAPTURE_TIMEOUT_MS;
}
