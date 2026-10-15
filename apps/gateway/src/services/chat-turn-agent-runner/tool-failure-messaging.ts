import type { ChatToolRunRecord } from "@goatcitadel/contracts";

const PATH_BRIDGE_POLICY_REASON = "workspace path was not freshly verified for execution";
const WEB_TOOL_PREFIXES = ["browser.", "http."];

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function formatToolLabel(toolName: string): string {
  const shortName = toolName.split(".").pop() ?? toolName;
  return shortName.replaceAll("_", " ");
}

function readPathBridgeBlock(
  result: Record<string, unknown> | undefined,
  error: string | undefined,
): { reasonCode?: string } | undefined {
  const bridge = readRecord(result?.workspacePathBridge);
  if (bridge?.status === "blocked") {
    return typeof bridge.reasonCode === "string" ? { reasonCode: bridge.reasonCode } : {};
  }
  return (error ?? "").toLowerCase().includes(PATH_BRIDGE_POLICY_REASON) ? {} : undefined;
}

const JAIL_BOUNDARY_NEXT_STEP =
  "This is a fixed execution boundary, not a pending approval, so retrying the same command will not help. Run it from a folder inside the workspace, or the operator can run it outside GoatCitadel.";

function describePathBridgeBlock(folder: string, reasonCode: string | undefined): string {
  switch (reasonCode) {
    case "outside_jail":
      return `${folder} is outside the workspace folders GoatCitadel may run commands in. ${JAIL_BOUNDARY_NEXT_STEP}`;
    case "symlink_escape":
      return `${folder} resolves through a link to a location outside the workspace folders GoatCitadel may run commands in. ${JAIL_BOUNDARY_NEXT_STEP}`;
    case "invalid_path":
      return `${folder} is not a valid absolute folder path for execution. Retry with an absolute folder path inside the workspace.`;
    case "canonicalization_failed":
    case "round_trip_mismatch":
      return `${folder} could not be resolved to a stable path; it may be missing, inaccessible, or changed during verification. Check that the folder exists and is readable, then retry.`;
    case "wsl_unavailable":
    case "wsl_conversion_failed":
      return `${folder} could not be verified because WSL is unavailable or could not translate the path. Check that WSL is installed and running for the Gateway, then retry.`;
    case "git_unavailable":
      return `${folder} could not be verified because Git is not available to the Gateway. Install or repair Git on the Gateway host, then retry.`;
    case "git_not_repository":
    case "git_verification_failed":
    case "git_identity_mismatch":
      return `${folder} could not be matched to the project's bound Git repository. Check the project's repository binding in Projects, then retry.`;
    default:
      return `${folder} could not be verified for execution by the workspace path bridge. Check Gateway path-bridge health and configuration before retrying; this is not a pending approval.`;
  }
}

/**
 * Guidance for a tool blocked by the workspace path bridge. Only jail-boundary
 * reasons are described as fixed; availability, binding, and canonicalization
 * failures get reason-specific repair steps. None of them imply an approval is
 * pending or suggest a narrower input.
 */
export function buildPathBridgeFailureGuidance(input: {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}): string | undefined {
  const block = readPathBridgeBlock(input.result, input.error);
  if (!block) {
    return undefined;
  }
  const cwd = typeof input.args?.cwd === "string" && input.args.cwd.trim() ? input.args.cwd.trim() : undefined;
  const guidance = describePathBridgeBlock(cwd ? `The working folder ${cwd}` : "The working folder", block.reasonCode);
  return block.reasonCode ? `${guidance} Path-bridge reason: ${block.reasonCode}.` : guidance;
}

function isWebTool(toolName: string): boolean {
  return WEB_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

/**
 * User-facing appendix for failed or blocked tool runs. Only failures and web
 * tool blocks get the URL/query hint; a policy block on another tool is not
 * fixed by a different URL or a narrower query.
 */
export function buildToolFailureAppendixText(failedOrBlocked: readonly ChatToolRunRecord[]): string | undefined {
  if (failedOrBlocked.length === 0) {
    return undefined;
  }
  const policyBlocksOnly = failedOrBlocked.every((run) => run.status === "blocked" && !isWebTool(run.toolName));
  const uniqueTools = [...new Set(failedOrBlocked.map((run) => formatToolLabel(run.toolName)))];
  const outcome = policyBlocksOnly ? "was blocked by policy" : "failed while I was working";
  const opening =
    uniqueTools.length === 1
      ? `Note: ${uniqueTools[0]} ${outcome}, so parts of this answer may be incomplete.`
      : `Note: a few tools ${policyBlocksOnly ? "were blocked by policy" : "failed while I was working"}, so parts of this answer may be incomplete.`;
  const guidance = [...new Set(failedOrBlocked.map((run) => run.failureGuidance).filter(Boolean))][0];
  const closing = policyBlocksOnly
    ? 'Say "keep going" if you want me to try a different approach.'
    : 'Say "keep going" to try another approach, or give me a specific URL or narrower query.';
  return [opening, "", guidance ? `Best next move: ${guidance}` : undefined, guidance ? "" : undefined, closing]
    .filter(Boolean)
    .join("\n");
}
