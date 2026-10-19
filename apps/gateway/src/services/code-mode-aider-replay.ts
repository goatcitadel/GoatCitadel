import path from "node:path";
import { createHash } from "node:crypto";
import type {
  CodeModeAiderReplayLink,
  CodeModeAiderWorkspacePin,
  CodeModeLanguage,
  CodeModeRunRecord,
  CodeModeRunRequest,
} from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import { parseCodeModeAiderWorkspacePin } from "./code-mode-aider-result-contract.js";
import { CODE_MODE_AIDER_ADAPTER_ID } from "./code-mode-execution-backends.js";
import {
  CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
  captureCodeModeWorkbenchWorktree,
  readContainedRegularFile,
} from "./code-mode-worktree-capture.js";

/**
 * Replay of a recorded Aider run (#368). A replay is a NEW run that re-executes the original's recorded request and
 * input at the same pinned workbench HEAD/state. It goes through the ordinary `code_mode.run` approval, links back to
 * the original through an immutable policy-snapshot entry, and its patch can reach the workbench only through the
 * existing hash-checked, at-most-once promote path. The original run, and any patch it promoted, are never touched.
 */

export type CodeModeAiderReplayRefusalReason =
  | "not_aider_run"
  | "run_not_terminal"
  | "not_pinned"
  | "replay_binding_mismatch"
  | "worktree_not_ready"
  | "worktree_identity_changed"
  | "worktree_head_moved"
  | "worktree_state_drift";

export interface CodeModeAiderReplayDeps {
  storage: Parameters<typeof captureCodeModeWorkbenchWorktree>[0];
  rootDir: string;
  artifactRoot: string;
  gitCaptureTimeoutMs?: number;
}

export interface PreparedCodeModeAiderReplay {
  request: CodeModeRunRequest;
  replayOf: CodeModeAiderReplayLink;
}

export const CODE_MODE_AIDER_REPLAY_SNAPSHOT_KEY = "codeModeAiderReplayOf";

const REPLAYABLE_STATUSES = new Set<CodeModeRunRecord["status"]>(["completed", "failed"]);
const MAX_POLICY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

function refuse(reason: CodeModeAiderReplayRefusalReason, runId: string, message: string): never {
  throw new ConflictError({ message, details: { reason, runId } });
}

/** Rebuilds the original's request from its hash-verified evidence and checks the live workbench against its pin. */
export async function prepareCodeModeAiderReplay(
  deps: CodeModeAiderReplayDeps,
  original: CodeModeRunRecord,
  operatorId?: string,
): Promise<PreparedCodeModeAiderReplay> {
  if (original.executionBackend?.backendId !== CODE_MODE_AIDER_ADAPTER_ID) {
    refuse("not_aider_run", original.runId, `Run ${original.runId} is not an Aider adapter run.`);
  }
  if (!REPLAYABLE_STATUSES.has(original.status)) {
    refuse(
      "run_not_terminal",
      original.runId,
      `Aider run ${original.runId} is ${original.status}; replay needs a finished run.`,
    );
  }
  const snapshot = readVerifiedPolicySnapshot(deps, original);
  if (!Object.prototype.hasOwnProperty.call(snapshot, "codeModeAiderWorkspacePin")) {
    refuse(
      "not_pinned",
      original.runId,
      `Aider run ${original.runId} is not pinned to a workbench; it cannot be replayed.`,
    );
  }
  let pin: CodeModeAiderWorkspacePin;
  try {
    pin = parseCodeModeAiderWorkspacePin(snapshot.codeModeAiderWorkspacePin);
  } catch (error) {
    refuse("replay_binding_mismatch", original.runId, `Aider workspace pin is invalid: ${describeError(error)}`);
  }
  const aider = readRecordedAiderRequest(snapshot.codeModeAiderRequest, original.runId);
  if (!original.sessionId || original.sessionId !== pin.sessionId) {
    refuse("replay_binding_mismatch", original.runId, `Aider run ${original.runId} session does not match its pin.`);
  }
  await assertWorkbenchMatchesPin(deps, original.runId, pin);
  const source = readVerifiedSource(deps, original);
  const input = isRecord(snapshot.codeModeInput) ? snapshot.codeModeInput : {};
  return {
    request: {
      language: original.language as CodeModeLanguage,
      source,
      executionBackendId: CODE_MODE_AIDER_ADAPTER_ID,
      ...(original.originSurface ? { originSurface: original.originSurface } : {}),
      ...(original.workspaceId ? { workspaceId: original.workspaceId } : {}),
      // The replay runs as the actor who requested it, never as the original run's operator.
      ...(operatorId ? { operatorId } : {}),
      input,
      sessionId: pin.sessionId,
      aider,
    },
    replayOf: { runId: original.runId, policySnapshotHash: original.policySnapshotHash, workspacePin: pin },
  };
}

/** Run inside run creation: the pin the replay itself captured must be the original's, or the replay is refused. */
export function assertReplayPinUnchanged(
  replayOf: CodeModeAiderReplayLink,
  captured: CodeModeAiderWorkspacePin | undefined,
): void {
  const expected = replayOf.workspacePin;
  if (!captured) {
    refuse("worktree_not_ready", replayOf.runId, "Chat workbench is no longer a ready, clean pin target.");
  }
  if (captured.worktreeIdentityHash !== expected.worktreeIdentityHash) {
    refuse(
      "worktree_identity_changed",
      replayOf.runId,
      "Chat workbench worktree identity changed since the original run.",
    );
  }
  if (captured.worktreeHead !== expected.worktreeHead) {
    refuse("worktree_head_moved", replayOf.runId, "Chat workbench HEAD moved since the original run.");
  }
  if (captured.worktreeStateHash !== expected.worktreeStateHash) {
    refuse("worktree_state_drift", replayOf.runId, "Chat workbench files changed since the original run.");
  }
}

/** Adds the replay link to the replay's own `code_mode.run` approval preview so the approver sees what it re-runs. */
export function withCodeModeAiderReplayPreview<T extends object>(
  replayOf: CodeModeAiderReplayLink | undefined,
  payload: T,
): T {
  return replayOf
    ? { ...payload, replayOfRunId: replayOf.runId, replayPinnedHead: replayOf.workspacePin.worktreeHead }
    : payload;
}

/** Reads the replay link of a run from its hash-verified policy snapshot; undefined for a non-replay run. */
export function readCodeModeAiderReplayLink(
  deps: Pick<CodeModeAiderReplayDeps, "rootDir" | "artifactRoot">,
  run: CodeModeRunRecord,
): CodeModeAiderReplayLink | undefined {
  const link = readVerifiedPolicySnapshot(deps, run)[CODE_MODE_AIDER_REPLAY_SNAPSHOT_KEY];
  if (!isRecord(link) || typeof link.runId !== "string" || typeof link.policySnapshotHash !== "string") {
    return undefined;
  }
  return {
    runId: link.runId,
    policySnapshotHash: link.policySnapshotHash,
    workspacePin: parseCodeModeAiderWorkspacePin(link.workspacePin),
  };
}

async function assertWorkbenchMatchesPin(
  deps: CodeModeAiderReplayDeps,
  runId: string,
  pin: CodeModeAiderWorkspacePin,
): Promise<void> {
  const capture = await captureCodeModeWorkbenchWorktree(
    deps.storage,
    { sessionId: pin.sessionId, runId },
    deps.gitCaptureTimeoutMs ?? CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
    { rootDir: deps.rootDir, asyncGit: true },
  );
  if (!capture.valid) {
    refuse("worktree_not_ready", runId, `Chat workbench is not ready (${capture.reasons.join(", ") || "not_ready"}).`);
  }
  assertReplayPinUnchanged(
    { runId, policySnapshotHash: "", workspacePin: pin },
    {
      ...pin,
      worktreeIdentityHash: capture.identityHash ?? "",
      worktreeHead: capture.headHash ?? "",
      worktreeStateHash: capture.stateHash ?? "",
    },
  );
}

function readVerifiedPolicySnapshot(
  deps: Pick<CodeModeAiderReplayDeps, "rootDir" | "artifactRoot">,
  run: CodeModeRunRecord,
): Record<string, unknown> {
  try {
    const bytes = readContainedRegularFile(
      path.resolve(deps.rootDir, run.policySnapshotArtifact.relPath),
      deps.artifactRoot,
      MAX_POLICY_SNAPSHOT_BYTES,
    );
    if (sha256(bytes) !== run.policySnapshotArtifact.sha256) {
      throw new Error("policy snapshot bytes do not match the recorded artifact hash");
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed) || sha256(JSON.stringify(parsed)) !== run.policySnapshotHash) {
      throw new Error("policy snapshot value does not match the recorded snapshot hash");
    }
    if (parsed.codeModeInputHash !== run.codeModeInputHash) {
      throw new Error("policy snapshot input hash does not match the run");
    }
    return parsed;
  } catch (error) {
    refuse(
      "replay_binding_mismatch",
      run.runId,
      `Aider run policy snapshot failed verification: ${describeError(error)}`,
    );
  }
}

function readVerifiedSource(
  deps: Pick<CodeModeAiderReplayDeps, "rootDir" | "artifactRoot">,
  run: CodeModeRunRecord,
): string {
  try {
    const bytes = readContainedRegularFile(
      path.resolve(deps.rootDir, run.codeArtifact.relPath),
      deps.artifactRoot,
      MAX_SOURCE_BYTES,
    );
    const source = bytes.toString("utf8");
    if (sha256(bytes) !== run.codeArtifact.sha256 || sha256(source) !== run.codeHash) {
      throw new Error("source bytes do not match the recorded hashes");
    }
    return source;
  } catch (error) {
    refuse("replay_binding_mismatch", run.runId, `Aider run source failed verification: ${describeError(error)}`);
  }
}

function readRecordedAiderRequest(value: unknown, runId: string): NonNullable<CodeModeRunRequest["aider"]> {
  if (!isRecord(value) || typeof value.requestMarkdown !== "string" || !value.requestMarkdown.trim()) {
    refuse("replay_binding_mismatch", runId, `Aider run ${runId} has no recorded request.`);
  }
  return {
    requestMarkdown: value.requestMarkdown,
    ...(typeof value.repositoryRootRelPath === "string" ? { repositoryRootRelPath: value.repositoryRootRelPath } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
