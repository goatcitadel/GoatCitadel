import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ChatSessionWorkbenchPatchApplyResponse,
  CodeModeAiderAdapterResultEnvelope,
  CodeModeAiderPromotionRecord,
  CodeModeAiderPromotionRequestResponse,
  CodeModeAiderWorkspacePin,
  CodeModeRunRecord,
  PendingApprovalAction,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  ChatWorkbenchPatchRefusedError,
  type ChatSessionWorkbenchPatchApplyInput,
  type ChatWorkbenchPatchRefusalReason,
} from "./chat-workbench-service.js";
import {
  parseCodeModeAiderAdapterResultEnvelope,
  parseCodeModeAiderPromotionRecord,
  parseCodeModeAiderWorkspacePin,
  withPromotedCodeModeAiderReplayPosture,
} from "./code-mode-aider-result-contract.js";
import { CODE_MODE_AIDER_PROMOTE_ACTION_TYPE } from "./code-mode-pending-action-types.js";
import {
  CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
  CODE_MODE_WORKBENCH_PATCH_MAX_BYTES,
  captureCodeModeWorkbenchWorktree,
  readContainedRegularFile,
} from "./code-mode-worktree-capture.js";

/**
 * Approval-gated promotion of a pinned Aider patch into the Chat workbench. The operator requests promotion of a
 * completed, workspace-pinned `patch_produced` run; a separate `code_mode.aider_promote` approval gates it. On
 * approval the patch artifact sha256 and the workbench HEAD/state are re-checked against the plan-time pin, and the
 * patch is applied through the guarded workbench path at most once. An `applying` intent written before the apply
 * makes any retry after an interrupted apply refuse with `promotion_outcome_unknown` instead of re-applying.
 */

export { CODE_MODE_AIDER_PROMOTE_ACTION_TYPE, isCodeModePendingActionType } from "./code-mode-pending-action-types.js";
export const CODE_MODE_AIDER_PROMOTE_APPROVAL_KIND = CODE_MODE_AIDER_PROMOTE_ACTION_TYPE;

export type CodeModeAiderPromotionRefusalReason =
  | "run_not_completed"
  | "no_patch"
  | "not_pinned"
  | "pin_binding_mismatch"
  | "session_mismatch"
  | "patch_hash_mismatch"
  | "worktree_not_ready"
  | "worktree_identity_changed"
  | "worktree_head_moved"
  | "worktree_state_drift"
  | "patch_out_of_scope"
  | "patch_check_failed"
  | "promotion_in_progress"
  | "promotion_outcome_unknown"
  | "workbench_apply_unavailable"
  | "workbench_precondition_failed"
  | "approval_binding_mismatch";

export interface CodeModeAiderPromotionDeps {
  storage: Pick<
    AsyncStorage,
    | "approvals"
    | "approvalEvents"
    | "chatSessionWorkbench"
    | "codeModeRuns"
    | "pendingApprovalActions"
    | "runImmediateTransaction"
  >;
  rootDir: string;
  artifactRoot: string;
  createApproval: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<void>;
  applyChatSessionWorkbenchPatch?: (
    sessionId: string,
    input: ChatSessionWorkbenchPatchApplyInput,
  ) => Promise<ChatSessionWorkbenchPatchApplyResponse>;
  gitCaptureTimeoutMs?: number;
  now?: () => Date;
}

const PROMOTE_APPROVAL_TTL_MS = 15 * 60_000;
const MAX_PROMOTED_PATCH_BYTES = CODE_MODE_WORKBENCH_PATCH_MAX_BYTES;
const MAX_APPROVAL_CHANGED_PATHS = 50;
const MAX_APPROVAL_PATH_CHARS = 512;
const MAX_STORED_ERROR_CHARS = 240;
const MAX_POLICY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const PIN_SNAPSHOT_KEY = "codeModeAiderWorkspacePin";

const WORKBENCH_REFUSAL_REASONS: Record<ChatWorkbenchPatchRefusalReason, CodeModeAiderPromotionRefusalReason> = {
  out_of_scope: "patch_out_of_scope",
  head_moved: "worktree_head_moved",
  state_drift: "worktree_state_drift",
  check_failed: "patch_check_failed",
  precondition_failed: "workbench_precondition_failed",
};

class PromotionRefusal extends Error {
  public constructor(
    public readonly reason: CodeModeAiderPromotionRefusalReason,
    message: string,
  ) {
    super(message);
  }
}

interface PromotableRun {
  run: CodeModeRunRecord;
  sessionId: string;
  adapter: Record<string, unknown>;
  envelope: CodeModeAiderAdapterResultEnvelope;
  patchArtifact: NonNullable<CodeModeAiderAdapterResultEnvelope["patchArtifact"]>;
  pin: CodeModeAiderWorkspacePin;
}

export async function requestCodeModeAiderPromotion(
  deps: CodeModeAiderPromotionDeps,
  run: CodeModeRunRecord,
  operatorId?: string,
): Promise<CodeModeAiderPromotionRequestResponse> {
  let promotable: PromotableRun;
  let changedPaths: { paths: string[]; truncated: boolean };
  try {
    const existing = readPromotionRecord(readAdapter(run));
    if (existing?.status === "promoted") {
      return { runId: run.runId, status: "already_promoted", promotion: existing };
    }
    if (existing) {
      throw new PromotionRefusal(
        "promotion_in_progress",
        `Aider run ${run.runId} already has a promotion in flight under approval ${existing.approvalId}.`,
      );
    }
    promotable = await readPromotableRun(deps, run);
    // Shown to the approver; the hash-verified patch bytes (not this list) are what promotion applies.
    changedPaths = listPatchChangedPaths(readVerifiedPatch(deps, promotable.patchArtifact.artifact));
  } catch (error) {
    if (error instanceof PromotionRefusal) {
      throw new ConflictError({ message: error.message, details: { reason: error.reason, runId: run.runId } });
    }
    throw error;
  }
  const workspaceId = run.workspaceId ?? "default";
  const artifact = promotable.patchArtifact.artifact;
  const payload: Record<string, unknown> = {
    runId: run.runId,
    workspaceId,
    patchSha256: artifact.sha256,
    patchArtifactId: artifact.artifactId,
    ...(promotable.patchArtifact.fileCount !== undefined ? { fileCount: promotable.patchArtifact.fileCount } : {}),
    pinnedHead: promotable.pin.worktreeHead,
    changedPaths: changedPaths.paths,
    changedPathsTruncated: changedPaths.truncated,
  };
  const now = readNow(deps);
  const approval = await deps.createApproval({
    kind: CODE_MODE_AIDER_PROMOTE_APPROVAL_KIND,
    riskLevel: "caution",
    payload,
    preview: payload,
    // F9: no sessionId/turnId and no code hashes, so the approval stays out of chat continuation and Code Mode run paths.
    linkage: {
      workspaceId,
      runId: run.runId,
      toolName: CODE_MODE_AIDER_PROMOTE_APPROVAL_KIND,
      actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
    },
    expiresAt: new Date(now.getTime() + PROMOTE_APPROVAL_TTL_MS).toISOString(),
  });
  await deps.storage.pendingApprovalActions.upsertPending({
    approvalId: approval.approvalId,
    actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
    request: { runId: run.runId, patchSha256: artifact.sha256, patchArtifactId: artifact.artifactId },
    createdAt: now.toISOString(),
    expiresAt: approval.expiresAt,
  });
  await deps.storage.approvalEvents.append({
    approvalId: approval.approvalId,
    eventType: "pending_action_registered",
    actorId: operatorId ?? "system",
    payload: { actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE, runId: run.runId, patchSha256: artifact.sha256 },
  });
  await deps.publishRealtime("code_mode_aider_promotion_requested", "capabilities", {
    runId: run.runId,
    approvalId: approval.approvalId,
    patchSha256: artifact.sha256,
  });
  return {
    runId: run.runId,
    status: "approval_pending",
    approvalId: approval.approvalId,
    ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
  };
}

export async function executeApprovedCodeModeAiderPromotion(
  deps: CodeModeAiderPromotionDeps,
  approvalId: string,
  pending: PendingApprovalAction,
): Promise<ToolInvokeResult> {
  const runId = typeof pending.request.runId === "string" ? pending.request.runId : "";
  try {
    const run = runId ? await deps.storage.codeModeRuns.find(runId) : undefined;
    if (!run) {
      throw new PromotionRefusal("run_not_completed", `Aider run ${runId || "(missing)"} was not found.`);
    }
    const approval = await readBoundApproval(deps, approvalId, pending);
    const existing = readPromotionRecord(readAdapter(run));
    if (existing) {
      return await settleExistingPromotion(deps, approvalId, run.runId, existing);
    }
    const promotable = await readPromotableRun(deps, run);
    const artifact = promotable.patchArtifact.artifact;
    if (pending.request.patchSha256 !== artifact.sha256 || pending.request.patchArtifactId !== artifact.artifactId) {
      throw new PromotionRefusal("patch_hash_mismatch", "Approved promotion does not match the run's patch artifact.");
    }
    const patch = readVerifiedPatch(deps, artifact);
    if (!deps.applyChatSessionWorkbenchPatch) {
      throw new PromotionRefusal("workbench_apply_unavailable", "The Chat workbench patch path is unavailable.");
    }
    await assertWorktreeMatchesPin(deps, promotable);
    const intent: CodeModeAiderPromotionRecord = {
      version: 1,
      status: "applying",
      approvalId,
      patchArtifactId: artifact.artifactId,
      patchSha256: artifact.sha256,
      pin: promotable.pin,
      startedAt: readNow(deps).toISOString(),
      ...(approval.resolvedBy ? { resolvedBy: approval.resolvedBy } : {}),
    };
    const claimed = await writePromotionIntent(deps, run.runId, intent);
    if (claimed) {
      return await settleExistingPromotion(deps, approvalId, run.runId, claimed);
    }
    const applied = await applyPromotedPatch(deps, promotable, patch, intent);
    return await finalizePromotion(deps, promotable, intent, applied);
  } catch (error) {
    if (error instanceof PromotionRefusal) {
      return await refusePromotion(deps, approvalId, runId, error.reason, error.message);
    }
    throw error;
  }
}

/** Defense in depth: the pending action must belong to an approved promote approval for the same patch hash. */
async function readBoundApproval(
  deps: CodeModeAiderPromotionDeps,
  approvalId: string,
  pending: PendingApprovalAction,
): Promise<ApprovalRequest> {
  let approval: ApprovalRequest;
  try {
    approval = await deps.storage.approvals.get(approvalId);
  } catch (error) {
    throw new PromotionRefusal(
      "approval_binding_mismatch",
      `Approval ${approvalId} could not be read: ${describeError(error)}`,
    );
  }
  const payload = isRecord(approval.payload) ? approval.payload : {};
  if (
    approval.kind !== CODE_MODE_AIDER_PROMOTE_APPROVAL_KIND ||
    approval.status !== "approved" ||
    pending.actionType !== CODE_MODE_AIDER_PROMOTE_ACTION_TYPE ||
    typeof pending.request.patchSha256 !== "string" ||
    payload.patchSha256 !== pending.request.patchSha256
  ) {
    throw new PromotionRefusal(
      "approval_binding_mismatch",
      `Approval ${approvalId} is not an approved Aider promotion for this patch.`,
    );
  }
  return approval;
}

/** Repository paths named by the patch's `diff --git` headers, bounded for the approval payload. */
export function listPatchChangedPaths(patch: string): { paths: string[]; truncated: boolean } {
  const paths = new Set<string>();
  let truncated = false;
  for (const line of patch.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    for (const raw of new Set([match[1]!, match[2]!])) {
      if (paths.size >= MAX_APPROVAL_CHANGED_PATHS) {
        truncated = true;
        break;
      }
      paths.add(raw.length > MAX_APPROVAL_PATH_CHARS ? `${raw.slice(0, MAX_APPROVAL_PATH_CHARS)}...` : raw);
    }
  }
  return { paths: [...paths], truncated };
}

async function readPromotableRun(deps: CodeModeAiderPromotionDeps, run: CodeModeRunRecord): Promise<PromotableRun> {
  if (run.status !== "completed") {
    throw new PromotionRefusal("run_not_completed", `Aider run ${run.runId} is ${run.status}, not completed.`);
  }
  const adapter = readAdapter(run);
  if (!adapter) {
    throw new PromotionRefusal("no_patch", `Run ${run.runId} has no Aider result.`);
  }
  let envelope: CodeModeAiderAdapterResultEnvelope;
  try {
    envelope = parseCodeModeAiderAdapterResultEnvelope(adapter.envelope, { promotion: adapter.promotion });
  } catch (error) {
    throw new PromotionRefusal("no_patch", `Aider result envelope is invalid: ${describeError(error)}`);
  }
  if (envelope.outcome !== "patch_produced" || !envelope.patchArtifact) {
    throw new PromotionRefusal("no_patch", `Aider run ${run.runId} did not produce a patch.`);
  }
  const pin = readVerifiedSnapshotPin(deps, run);
  if (!run.sessionId || run.sessionId !== pin.sessionId) {
    throw new PromotionRefusal("session_mismatch", `Aider run ${run.runId} session does not match its workspace pin.`);
  }
  return { run, sessionId: run.sessionId, adapter, envelope, patchArtifact: envelope.patchArtifact, pin };
}

/** The pin is trusted only from the hash-verified policy snapshot that bound the run's approved input. */
function readVerifiedSnapshotPin(deps: CodeModeAiderPromotionDeps, run: CodeModeRunRecord): CodeModeAiderWorkspacePin {
  let snapshot: Record<string, unknown>;
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
    if (!isRecord(parsed)) {
      throw new Error("policy snapshot is not an object");
    }
    if (sha256(JSON.stringify(parsed)) !== run.policySnapshotHash) {
      throw new Error("policy snapshot value does not match the recorded snapshot hash");
    }
    if (parsed.codeModeInputHash !== run.codeModeInputHash) {
      throw new Error("policy snapshot input hash does not match the run");
    }
    snapshot = parsed;
  } catch (error) {
    throw new PromotionRefusal(
      "pin_binding_mismatch",
      `Aider run policy snapshot failed verification: ${describeError(error)}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot, PIN_SNAPSHOT_KEY)) {
    throw new PromotionRefusal(
      "not_pinned",
      `Aider run ${run.runId} is not pinned to a workbench; it cannot be promoted.`,
    );
  }
  try {
    return parseCodeModeAiderWorkspacePin(snapshot[PIN_SNAPSHOT_KEY]);
  } catch (error) {
    throw new PromotionRefusal("pin_binding_mismatch", `Aider workspace pin is invalid: ${describeError(error)}`);
  }
}

function readVerifiedPatch(
  deps: CodeModeAiderPromotionDeps,
  artifact: PromotableRun["patchArtifact"]["artifact"],
): string {
  let bytes: Buffer;
  try {
    bytes = readContainedRegularFile(
      path.resolve(deps.rootDir, artifact.relPath),
      deps.artifactRoot,
      MAX_PROMOTED_PATCH_BYTES,
    );
  } catch (error) {
    throw new PromotionRefusal(
      "patch_hash_mismatch",
      `Aider patch artifact could not be read: ${describeError(error)}`,
    );
  }
  if (sha256(bytes) !== artifact.sha256) {
    throw new PromotionRefusal(
      "patch_hash_mismatch",
      "Aider patch artifact bytes no longer match the recorded sha256.",
    );
  }
  return bytes.toString("utf8");
}

async function assertWorktreeMatchesPin(deps: CodeModeAiderPromotionDeps, promotable: PromotableRun): Promise<void> {
  const capture = await captureCodeModeWorkbenchWorktree(
    deps.storage,
    { sessionId: promotable.sessionId, runId: promotable.run.runId },
    deps.gitCaptureTimeoutMs ?? CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
    { rootDir: deps.rootDir },
  );
  if (!capture.valid) {
    throw new PromotionRefusal(
      "worktree_not_ready",
      `Chat workbench is not ready (${capture.reasons.join(", ") || "worktree_not_ready"}).`,
    );
  }
  if (capture.identityHash !== promotable.pin.worktreeIdentityHash) {
    throw new PromotionRefusal(
      "worktree_identity_changed",
      "Chat workbench worktree identity changed since plan time.",
    );
  }
  if (capture.headHash !== promotable.pin.worktreeHead) {
    throw new PromotionRefusal("worktree_head_moved", "Chat workbench HEAD moved since plan time.");
  }
  if (capture.stateHash !== promotable.pin.worktreeStateHash) {
    throw new PromotionRefusal("worktree_state_drift", "Chat workbench files changed since plan time.");
  }
}

/** F8: re-read then write inside one immediate transaction. Returns the competing record when one already exists. */
async function writePromotionIntent(
  deps: CodeModeAiderPromotionDeps,
  runId: string,
  intent: CodeModeAiderPromotionRecord,
): Promise<CodeModeAiderPromotionRecord | undefined> {
  return await deps.storage.runImmediateTransaction(async () => {
    const current = await deps.storage.codeModeRuns.get(runId);
    const adapter = readAdapter(current);
    if (!adapter) {
      throw new PromotionRefusal("no_patch", `Run ${runId} lost its Aider result before the promotion started.`);
    }
    const existing = readPromotionRecord(adapter);
    if (existing) {
      return existing;
    }
    await deps.storage.codeModeRuns.upsert(withAdapter(current, { ...adapter, promotion: intent }));
    return undefined;
  });
}

async function applyPromotedPatch(
  deps: CodeModeAiderPromotionDeps,
  promotable: PromotableRun,
  patch: string,
  intent: CodeModeAiderPromotionRecord,
): Promise<ChatSessionWorkbenchPatchApplyResponse> {
  try {
    // Guarded mode: the workbench re-checks HEAD/state under its write lock and runs `git apply --check` first.
    return await deps.applyChatSessionWorkbenchPatch!(promotable.sessionId, {
      patch,
      expectedWorktreeHead: intent.pin.worktreeHead,
      expectedWorktreeStateHash: intent.pin.worktreeStateHash,
    });
  } catch (error) {
    if (error instanceof ChatWorkbenchPatchRefusedError) {
      // Refused before any file was written: the intent is safe to clear.
      await clearPromotionIntent(deps, promotable.run.runId, intent.approvalId);
      throw new PromotionRefusal(WORKBENCH_REFUSAL_REASONS[error.reason], error.message);
    }
    throw new PromotionRefusal(
      "promotion_outcome_unknown",
      `Workbench apply failed after the promotion intent was recorded; the outcome must be reconciled manually: ${describeError(error)}`,
    );
  }
}

async function clearPromotionIntent(
  deps: CodeModeAiderPromotionDeps,
  runId: string,
  approvalId: string,
): Promise<void> {
  await deps.storage.runImmediateTransaction(async () => {
    const current = await deps.storage.codeModeRuns.get(runId);
    const adapter = readAdapter(current);
    const existing = readPromotionRecord(adapter);
    if (!adapter || existing?.status !== "applying" || existing.approvalId !== approvalId) {
      return;
    }
    const { promotion: _cleared, ...rest } = adapter;
    await deps.storage.codeModeRuns.upsert(withAdapter(current, rest));
  });
}

async function finalizePromotion(
  deps: CodeModeAiderPromotionDeps,
  promotable: PromotableRun,
  intent: CodeModeAiderPromotionRecord,
  applied: ChatSessionWorkbenchPatchApplyResponse,
): Promise<ToolInvokeResult> {
  const promoted: CodeModeAiderPromotionRecord = {
    ...intent,
    status: "promoted",
    promotedAt: readNow(deps).toISOString(),
    changedFiles: applied.changedFiles.filter((file) => typeof file === "string" && file.length > 0),
    workbenchValidationStatus: applied.state.validationStatus,
  };
  const runId = promotable.run.runId;
  try {
    await deps.storage.runImmediateTransaction(async () => {
      const current = await deps.storage.codeModeRuns.get(runId);
      const adapter = readAdapter(current);
      const existing = readPromotionRecord(adapter);
      if (!adapter || existing?.status !== "applying" || existing.approvalId !== intent.approvalId) {
        throw new Error("promotion intent changed while the patch was applied");
      }
      const envelope = parseCodeModeAiderAdapterResultEnvelope(adapter.envelope, { promotion: existing });
      const promotedEnvelope = withPromotedCodeModeAiderReplayPosture(envelope, promoted);
      parseCodeModeAiderAdapterResultEnvelope(promotedEnvelope, { promotion: promoted });
      await deps.storage.codeModeRuns.upsert(
        withAdapter(current, { ...adapter, envelope: promotedEnvelope, promotion: promoted }),
      );
    });
  } catch (error) {
    throw new PromotionRefusal(
      "promotion_outcome_unknown",
      `Patch was applied but the promotion could not be recorded; reconcile manually: ${describeError(error)}`,
    );
  }
  await deps.storage.pendingApprovalActions.markResolved(intent.approvalId, "executed", {
    outcome: "executed",
    status: "promoted",
    runId,
    promotion: promoted,
  });
  await appendExecutedEvent(deps, intent.approvalId, runId, "promoted");
  await deps.publishRealtime("code_mode_aider_patch_promoted", "capabilities", {
    runId,
    approvalId: intent.approvalId,
    patchSha256: promoted.patchSha256,
    changedFiles: promoted.changedFiles,
    workbenchValidationStatus: promoted.workbenchValidationStatus,
  });
  return {
    outcome: "executed",
    policyReason: "code_mode_aider_promote:promoted",
    auditEventId: `code-mode-aider-promote-${runId}`,
    result: { runId, status: "promoted", promotion: promoted },
  };
}

async function settleExistingPromotion(
  deps: CodeModeAiderPromotionDeps,
  approvalId: string,
  runId: string,
  existing: CodeModeAiderPromotionRecord,
): Promise<ToolInvokeResult> {
  if (existing.status === "promoted") {
    await deps.storage.pendingApprovalActions.markResolved(approvalId, "executed", {
      outcome: "executed",
      status: "already_promoted",
      runId,
      alreadyPromoted: true,
      promotion: existing,
    });
    await appendExecutedEvent(deps, approvalId, runId, "already_promoted");
    return {
      outcome: "executed",
      policyReason: "code_mode_aider_promote:already_promoted",
      auditEventId: `code-mode-aider-promote-${runId}`,
      result: { runId, status: "promoted", alreadyPromoted: true, promotion: existing },
    };
  }
  if (existing.approvalId === approvalId) {
    throw new PromotionRefusal(
      "promotion_outcome_unknown",
      `Promotion under approval ${approvalId} was interrupted after its intent was recorded; it is never re-applied.`,
    );
  }
  throw new PromotionRefusal(
    "promotion_in_progress",
    `Aider run ${runId} has a promotion in flight under approval ${existing.approvalId}.`,
  );
}

async function refusePromotion(
  deps: CodeModeAiderPromotionDeps,
  approvalId: string,
  runId: string,
  reason: CodeModeAiderPromotionRefusalReason,
  message: string,
): Promise<ToolInvokeResult> {
  const manual = reason === "promotion_outcome_unknown";
  const boundedError =
    message.length > MAX_STORED_ERROR_CHARS ? `${message.slice(0, MAX_STORED_ERROR_CHARS)}...` : message;
  await deps.storage.pendingApprovalActions.markResolved(approvalId, "failed", {
    outcome: "blocked",
    status: "refused",
    ...(runId ? { runId } : {}),
    reason,
    error: boundedError,
    ...(manual ? { manualReconciliationRequired: true } : {}),
  });
  await appendExecutedEvent(deps, approvalId, runId, "refused", { reason });
  // Realtime carries only the typed reason; the bounded error text stays in the pending action result.
  await deps.publishRealtime("code_mode_aider_promotion_refused", "capabilities", {
    ...(runId ? { runId } : {}),
    approvalId,
    reason,
  });
  return {
    outcome: "blocked",
    policyReason: `code_mode_aider_promote:${reason}`,
    auditEventId: `code-mode-aider-promote-${runId || approvalId}`,
    result: { ...(runId ? { runId } : {}), status: "refused", reason, error: boundedError },
  };
}

async function appendExecutedEvent(
  deps: CodeModeAiderPromotionDeps,
  approvalId: string,
  runId: string,
  outcome: "promoted" | "already_promoted" | "refused",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await deps.storage.approvalEvents.append({
    approvalId,
    eventType: "approved_action_executed",
    actorId: "system",
    payload: { actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE, ...(runId ? { runId } : {}), outcome, ...extra },
  });
}

function readAdapter(run: CodeModeRunRecord): Record<string, unknown> | undefined {
  const result = run.result;
  const adapter = isRecord(result) ? result.aiderAdapter : undefined;
  return isRecord(adapter) ? adapter : undefined;
}

/** A corrupt promotion record means the promotion state is unknown; it is never re-applied. */
function readPromotionRecord(adapter: Record<string, unknown> | undefined): CodeModeAiderPromotionRecord | undefined {
  if (!adapter || adapter.promotion === undefined || adapter.promotion === null) {
    return undefined;
  }
  try {
    return parseCodeModeAiderPromotionRecord(adapter.promotion);
  } catch (error) {
    throw new PromotionRefusal(
      "promotion_outcome_unknown",
      `Aider promotion record is invalid: ${describeError(error)}`,
    );
  }
}

function withAdapter(run: CodeModeRunRecord, adapter: Record<string, unknown>): CodeModeRunRecord {
  const result = isRecord(run.result) ? run.result : {};
  return { ...run, result: { ...result, aiderAdapter: adapter } };
}

function readNow(deps: CodeModeAiderPromotionDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
