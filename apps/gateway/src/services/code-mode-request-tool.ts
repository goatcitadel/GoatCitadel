import { createHash } from "node:crypto";
import { ConflictError, GoatError, PolicyViolationError, type ToolInvokeRequest } from "@goatcitadel/contracts";
import { CODE_MODE_REQUEST_TOOL_NAME, readCodeModeRequestArgs } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  CODE_MODE_REQUEST_APPROVAL_KIND,
  type ApprovedCodeModeRequest,
  type ApprovedCodeModeResult,
} from "./capability-system-service.js";

/** What the turn sees when the operator approved a run while Code Mode (or its sandbox) is switched off. */
export const CODE_MODE_OFF_TOOL_ERROR =
  "Code Mode is off. Turn it on from the card in Chat or in Settings, then ask again.";

export interface CodeModeRequestToolDeps {
  storage: Pick<AsyncStorage, "approvals" | "pendingApprovalActions">;
  runApprovedCodeModeRequest(request: ApprovedCodeModeRequest, signal?: AbortSignal): Promise<ApprovedCodeModeResult>;
}

/**
 * Runs an operator-approved `code_mode.request` for the Chat turn waiting on it. The policy engine stamps
 * `approvedByApprovalId` only on approved execution; this re-reads that approval, requires the operator's decision,
 * and binds the run to the source stored with the approval's pending action.
 */
export async function runCodeModeRequestFromTool(
  deps: CodeModeRequestToolDeps,
  request: ToolInvokeRequest,
): Promise<Record<string, unknown>> {
  const approvalId = request.approvedByApprovalId?.trim();
  const sessionId = request.sessionId.trim();
  const turnId = request.turnId?.trim();
  if (!approvalId) {
    throw new PolicyViolationError({ message: "code_mode.request runs only after the operator approves it." });
  }
  if (!sessionId || !turnId) {
    throw new PolicyViolationError({ message: "code_mode.request is available only inside a Chat turn." });
  }
  const approval = await deps.storage.approvals.get(approvalId);
  if (
    approval.kind !== CODE_MODE_REQUEST_APPROVAL_KIND ||
    approval.status !== "approved" ||
    !approval.resolvedBy?.trim()
  ) {
    throw new PolicyViolationError({ message: "code_mode.request needs the operator's approval decision to run." });
  }
  const approvedSource = await readApprovedSource(deps, approvalId);
  const args = readCodeModeRequestArgs(request.args);
  try {
    const result = await deps.runApprovedCodeModeRequest(
      {
        approvalId,
        approvedSourceSha256: createHash("sha256").update(approvedSource).digest("hex"),
        goal: args.goal,
        language: args.language,
        source: args.source,
        ...(args.input ? { input: args.input } : {}),
        sessionId,
        turnId,
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        policyContext: request.policyContext ?? {},
      },
      request.signal,
    );
    return { ...result };
  } catch (error) {
    const reason = error instanceof GoatError ? error.details?.reason : undefined;
    if (reason === "code_mode_off" || reason === "sandbox_off") {
      return { status: "failed", error: CODE_MODE_OFF_TOOL_ERROR };
    }
    throw error;
  }
}

async function readApprovedSource(deps: CodeModeRequestToolDeps, approvalId: string): Promise<string> {
  const pending = await deps.storage.pendingApprovalActions.find(approvalId);
  const stored = pending?.actionType === "tool.invoke" ? pending.request : undefined;
  const source =
    stored?.toolName === CODE_MODE_REQUEST_TOOL_NAME ? (stored.args as { source?: unknown })?.source : undefined;
  if (typeof source !== "string") {
    throw new ConflictError({ message: "The approved code for this request is missing. Ask for approval again." });
  }
  return source;
}
