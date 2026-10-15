import type { ChatToolRunRecord } from "@goatcitadel/contracts";

const PATH_BRIDGE_POLICY_REASON = "workspace path was not freshly verified for execution";
const WEB_TOOL_PREFIXES = ["browser.", "http.", "web.", "docs.search", "search."];

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

/**
 * Guidance for a tool blocked by the workspace path bridge. The bridge is a
 * fixed execution boundary rather than an approval gate, so the guidance must
 * not suggest retrying with narrower input or imply an approval is pending.
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
  const folder = cwd ? `The working folder ${cwd}` : "The working folder";
  const nextStep =
    "This is a fixed execution boundary, not a pending approval, so retrying the same command will not help. Run it from a folder inside the workspace, or the operator can run it outside GoatCitadel.";
  if (block.reasonCode === "outside_jail") {
    return `${folder} is outside the workspace folders GoatCitadel may run commands in. ${nextStep}`;
  }
  const reason = block.reasonCode ? ` (${block.reasonCode.replaceAll("_", " ")})` : "";
  return `${folder} could not be verified for execution${reason}. ${nextStep}`;
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
