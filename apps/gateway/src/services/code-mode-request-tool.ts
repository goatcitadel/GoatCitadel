import { createHash } from "node:crypto";
import { ConflictError, GoatError, PolicyViolationError, type ToolInvokeRequest } from "@goatcitadel/contracts";
import { CODE_MODE_REQUEST_TOOL_NAME, readCodeModeRequestArgs } from "@goatcitadel/policy-engine";
import type { ApprovedCodeModeRequest } from "./capability-system-service.js";

/**
 * What the turn sees when the operator approved a run while Code Mode (or its sandbox) is switched off. The approval
 * effects treat this `{ status: "failed", error }` result as executed-with-error (`code-mode-request-resume.ts`), so
 * the waiting turn resumes and the model can explain it.
 */
export const CODE_MODE_OFF_TOOL_ERROR =
  "Code Mode is off. Turn it on from the card in Chat or in Settings, then ask again.";
/** What the turn sees when the approved run cannot start because this machine has no Code Mode sandbox. */
export const CODE_MODE_UNSUPPORTED_TOOL_ERROR = "This computer can't run Code Mode, so the code did not run.";

/** The ids an approved `code_mode.request` tool call must carry: the policy engine stamps the approval id. */
export function readCodeModeRequestToolIds(request: ToolInvokeRequest): {
  approvalId: string;
  sessionId: string;
  turnId: string;
} {
  const approvalId = request.approvedByApprovalId?.trim();
  const sessionId = request.sessionId.trim();
  const turnId = request.turnId?.trim();
  if (!approvalId) {
    throw new PolicyViolationError({ message: "code_mode.request runs only after the operator approves it." });
  }
  if (!sessionId || !turnId) {
    throw new PolicyViolationError({ message: "code_mode.request is available only inside a Chat turn." });
  }
  return { approvalId, sessionId, turnId };
}

/**
 * Builds the run request for an approved `code_mode.request` tool call, bound to the source stored with the
 * approval's pending action (`storedRequest`).
 */
export function buildApprovedCodeModeRequestFromTool(
  request: ToolInvokeRequest,
  storedRequest: { toolName?: unknown; args?: unknown } | undefined,
): ApprovedCodeModeRequest {
  const { approvalId, sessionId, turnId } = readCodeModeRequestToolIds(request);
  const storedSource =
    storedRequest?.toolName === CODE_MODE_REQUEST_TOOL_NAME
      ? (storedRequest.args as { source?: unknown } | undefined)?.source
      : undefined;
  if (typeof storedSource !== "string") {
    throw new ConflictError({ message: "The approved code for this request is missing. Ask for approval again." });
  }
  const args = readCodeModeRequestArgs(request.args);
  return {
    approvalId,
    approvedSourceSha256: createHash("sha256").update(storedSource).digest("hex"),
    goal: args.goal,
    language: args.language,
    source: args.source,
    ...(args.input ? { input: args.input } : {}),
    ...(args.reads ? { reads: args.reads } : {}),
    sessionId,
    turnId,
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
    policyContext: request.policyContext ?? {},
  };
}

/**
 * The helpers a Chat request run can call. Each reads only the path it names (fs.list: the folder it names), which
 * must be in the approved `reads`; a docs.* helper may name an approved attachment instead. Helpers that search
 * across the read roots (file.find, code.search, code.search_files, session.search) are not among them.
 */
const CODE_MODE_REQUEST_READ_HELPERS: ReadonlySet<string> = new Set([
  "fs.read",
  "file.read_range",
  "fs.stat",
  "fs.list",
  "docs.read_bytes",
  "docs.extract_text",
]);
/** docs.decompress works on bytes the script already holds and reads no file. */
const CODE_MODE_REQUEST_NO_READ_HELPERS: ReadonlySet<string> = new Set(["docs.decompress"]);

/** Whether a Chat request run's script may call this helper; the others are left out of the run's manifest. */
export function isCodeModeRequestHelper(wrapperName: string): boolean {
  return CODE_MODE_REQUEST_READ_HELPERS.has(wrapperName) || CODE_MODE_REQUEST_NO_READ_HELPERS.has(wrapperName);
}

/**
 * The refusal for a helper call in a Chat request run that does not name an approved target, or undefined when it
 * may run. `resolvedPath` is the call's `path` and `approvedPaths` the `reads` entries, each after the same session
 * path resolution; a docs.* `attachmentId` must equal an entry. A run without `reads` reads nothing.
 */
export function unapprovedCodeModeReadError(input: {
  wrapperName: string;
  args: Record<string, unknown>;
  approvedReads: readonly string[];
  resolvedPath?: string;
  approvedPaths: ReadonlySet<string>;
}): string | undefined {
  const { wrapperName, args } = input;
  if (!isCodeModeRequestHelper(wrapperName)) {
    return `${wrapperName} is not available in this run, which can read only the files approved for it.`;
  }
  if (CODE_MODE_REQUEST_NO_READ_HELPERS.has(wrapperName)) {
    return undefined;
  }
  const attachmentId =
    wrapperName.startsWith("docs.") && typeof args.attachmentId === "string" ? args.attachmentId.trim() : "";
  if (attachmentId && !input.approvedReads.some((entry) => entry.trim() === attachmentId)) {
    return `Attachment "${attachmentId}" is not in the files approved for this run, so ${wrapperName} cannot read it.`;
  }
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (rawPath && !(input.resolvedPath && input.approvedPaths.has(input.resolvedPath))) {
    return `"${rawPath}" is not in the files approved for this run, so ${wrapperName} cannot read it.`;
  }
  // Without a path fs.list and fs.stat fall back to the workspace folder, which the operator did not approve.
  return rawPath || attachmentId ? undefined : `${wrapperName} must name a file or folder approved for this run.`;
}

/**
 * The result the waiting turn resumes with when an approved run was refused because Code Mode cannot run here, or
 * undefined for any other error (which the caller rethrows).
 */
export function codeModeRequestToolFailure(error: unknown): { status: "failed"; error: string } | undefined {
  const reason = error instanceof GoatError ? error.details?.reason : undefined;
  if (reason === "code_mode_off" || reason === "sandbox_off") {
    return { status: "failed", error: CODE_MODE_OFF_TOOL_ERROR };
  }
  return reason === "sandbox_unsupported" ? { status: "failed", error: CODE_MODE_UNSUPPORTED_TOOL_ERROR } : undefined;
}
