import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { PLUGIN_TOOL_GROUP_HOLD_REASON_CODE } from "@goatcitadel/policy-engine";
import { readLongestPageTextLength } from "../chat-agent-browser-results.js";

const PATH_BRIDGE_POLICY_REASON = "workspace path was not freshly verified for execution";
const WEB_TOOL_PREFIXES = ["browser.", "http."];
export const MEMORY_CONSENT_BLOCKED_REASON =
  "memory persistence requires explicit user consent; ask before saving long-term memory";
const MEMORY_CONSENT_EXAMPLES = '"Remember that …" or "Add this to memory: …"';
const MAX_POLICY_GUIDANCE_LINES = 3;

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

const WEB_PAGE_READ_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
const WEB_LOOKUP_TOOL_NAMES = new Set(["browser.search", ...WEB_PAGE_READ_TOOL_NAMES]);
// The browser result classifier's own floor for useful page text.
const MIN_USABLE_PAGE_TEXT_CHARS = 40;

/**
 * A failed or blocked web lookup (a search or page read) the turn worked around: another page read in the
 * same turn succeeded, so the answer rests on sources it did open and reports its own gaps. Reading a page
 * never recovers a failed web action such as a post or a click, and a switched-off group is still a policy
 * block the operator can lift, so neither is ever recovered.
 */
export function isRecoveredWebReadFailure(
  failedRun: ChatToolRunRecord,
  toolRuns: readonly ChatToolRunRecord[],
): boolean {
  if (!WEB_LOOKUP_TOOL_NAMES.has(failedRun.toolName) || isSwitchedOffRun(failedRun) || isPolicyReasonBlock(failedRun)) {
    return false;
  }
  // Only a read that brought back page text counts; one that returned just a URL read nothing.
  return toolRuns.some(
    (run) =>
      run !== failedRun &&
      run.status === "executed" &&
      WEB_PAGE_READ_TOOL_NAMES.has(run.toolName) &&
      readLongestPageTextLength(readRecord(run.result) ?? {}) >= MIN_USABLE_PAGE_TEXT_CHARS,
  );
}

/** A policy re-check that denied the tool or found its group off: the operator's to lift, never worked around. */
function isPolicyReasonBlock(run: ChatToolRunRecord): boolean {
  const codes = readPolicyRevalidationReasonCodes(readRecord(run.result));
  return codes.includes(TOOL_GROUP_OFF_REASON_CODE) || codes.includes(POLICY_DENY_REASON_CODE);
}

const OPERATOR_BOUNDARY_NEXT_STEP =
  "This is an operator policy boundary, not a pending approval, so retrying it with different input will not help.";

// The policy engine's reason code, and the sentence it puts in its reason, for a tool in a switched-off group.
export const TOOL_GROUP_OFF_REASON_CODE = "tool_group_off";
const TOOL_GROUP_OFF_ERROR_FRAGMENT = "tool group switched off";
const POLICY_DENY_REASON_CODE = "policy_deny";

/** Reason codes the Chat runner recorded when it re-checked policy before the call (`result.policyRevalidation`). */
function readPolicyRevalidationReasonCodes(result: Record<string, unknown> | undefined): readonly string[] {
  const codes = readRecord(result?.policyRevalidation)?.reasonCodes;
  return Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string") : [];
}

/**
 * True when the operator's tool group switch stopped the tool. The policy engine's own reason names the switch, but
 * the Chat runner re-checks policy before a call and writes an error of its own ("Current deny-wins policy blocks
 * ..."), so that path is recognised from the re-check's reason codes. A tool that is also denied reports
 * policy_deny, and switching its group on alone would not run it, so that is not a switch-off block.
 */
function isSwitchedOffGroupBlock(lowercasedError: string, result: Record<string, unknown> | undefined): boolean {
  if (lowercasedError.includes(TOOL_GROUP_OFF_ERROR_FRAGMENT)) {
    return true;
  }
  const codes = readPolicyRevalidationReasonCodes(result);
  return codes.includes(TOOL_GROUP_OFF_REASON_CODE) && !codes.includes(POLICY_DENY_REASON_CODE);
}

function isSwitchedOffRun(run: ChatToolRunRecord): boolean {
  return run.status === "blocked" && isSwitchedOffGroupBlock((run.error ?? "").toLowerCase(), run.result);
}

// The policy engine's reason when a plugin's hold, not the operator's switch, keeps the group off: it names the first
// plugin that holds it, then the group's label, or says "a plugin" when it has no name to give.
const PLUGIN_HOLD_PATTERN = /tool group switched off by (?:the plugin (.+?)|a plugin)(?: \([^()]*\))?\s*$/u;
/** Stands in for a holder the engine couldn't name, so the guidance still points to uninstalling a plugin. */
const UNNAMED_PLUGIN = "a plugin";

/**
 * The plugin the engine named for a hold ("a plugin" when it gave no name), or undefined when the operator's switch (or
 * no reason) stopped the tool. The runner's own re-check writes an error of its own, so there a hold is read from the
 * re-check's `plugin_tool_group_hold` reason code, which names no plugin.
 */
function pluginHoldingGroup(
  error: string | undefined,
  result: Record<string, unknown> | undefined,
): string | undefined {
  const match = PLUGIN_HOLD_PATTERN.exec(error ?? "");
  if (match) return match[1]?.trim() || UNNAMED_PLUGIN;
  return readPolicyRevalidationReasonCodes(result).includes(PLUGIN_TOOL_GROUP_HOLD_REASON_CODE)
    ? UNNAMED_PLUGIN
    : undefined;
}

/** Where the operator lifts switched-off groups: the Tools switch, uninstalling the plugin that holds one, or both. */
function switchedOffClosing(runs: readonly ChatToolRunRecord[]): string {
  const held = runs.filter((run) => pluginHoldingGroup(run.error, run.result) !== undefined).length;
  if (held === runs.length) {
    return "The operator can uninstall the plugin that keeps a group off, which turns that group back on. Once the group is on, ask again and I'll retry.";
  }
  if (held > 0) {
    return "The operator can switch tool groups back on in Capabilities › Tools, and uninstall the plugin that keeps a group off, which turns that group back on. Once the group is on, ask again and I'll retry.";
  }
  return "The operator can switch tool groups back on in Capabilities › Tools. Once the group is on, ask again and I'll retry.";
}

/**
 * Guidance for a tool stopped by operator governance: a tools.deny entry, a
 * tool outside the resolved allow list or permission profile, a Citadel Ward
 * deny, a switched-off tool group, or a target outside the write roots. Only
 * the operator can lift these, so the guidance names the setting to change and
 * never invites a retry.
 *
 * Write-root errors are thrown before any write, so they qualify whether the
 * run settled as blocked or failed. The policy-decision reasons qualify only
 * for a run that settled as blocked, never one whose dispatch had started.
 */
export function buildGovernanceBlockGuidance(input: {
  toolName: string;
  status: ChatToolRunRecord["status"];
  error?: string;
  result?: Record<string, unknown>;
}): string | undefined {
  const error = (input.error ?? "").toLowerCase();
  const tool = input.toolName;
  if (error.includes("write jail") || error.includes("outside write")) {
    return `The target path is outside the folders GoatCitadel may write to. ${OPERATOR_BOUNDARY_NEXT_STEP} The operator must add that folder to sandbox.operatorWriteRoots (with allowDelete for deletes) before ${tool} can change it; tell the operator that instead of writing somewhere else.`;
  }
  if (input.status !== "blocked") {
    return undefined;
  }
  // Before the tools.deny branch: the remedy is the operator's switch, and nothing in tools.deny needs editing.
  if (isSwitchedOffGroupBlock(error, input.result)) {
    // A plugin's hold is lifted only by uninstalling that plugin, never by the Tools switch.
    const plugin = pluginHoldingGroup(input.error, input.result);
    if (plugin === UNNAMED_PLUGIN) {
      return `${tool} is switched off: a plugin keeps its tool group off. ${OPERATOR_BOUNDARY_NEXT_STEP} Uninstalling that plugin turns the group back on, and only the operator can do that; tell them which tool you needed.`;
    }
    if (plugin) {
      return `${tool} is switched off: the plugin ${plugin} keeps its tool group off. ${OPERATOR_BOUNDARY_NEXT_STEP} Uninstalling ${plugin} turns the group back on, and only the operator can do that; tell them which tool you needed.`;
    }
    return `${tool} is switched off: the operator turned off its tool group in Capabilities › Tools. ${OPERATOR_BOUNDARY_NEXT_STEP} Only the operator can switch that group back on; tell them which tool you needed.`;
  }
  if (error.includes("tool denied by policy")) {
    return `${tool} is denied by the operator's tool policy. ${OPERATOR_BOUNDARY_NEXT_STEP} The operator must remove ${tool} (or the pattern that matches it) from tools.deny before it can run.`;
  }
  if (error.includes("not available in resolved policy")) {
    return `${tool} is not allowed by the active tool policy or permission profile. ${OPERATOR_BOUNDARY_NEXT_STEP} When a permission profile is active, the operator must include ${tool} in that profile's tool patterns, because tools.allow cannot lift a profile ceiling. Otherwise the operator must add ${tool} to tools.allow before it can run.`;
  }
  if (error.includes("denied by a citadel ward")) {
    return `${tool} is denied by a Citadel Ward. ${OPERATOR_BOUNDARY_NEXT_STEP} The operator must change that Ward before ${tool} can run.`;
  }
  return undefined;
}

/**
 * True for a non-web run stopped by a tool-policy decision: the policy
 * engine's `blocked: <reason>` outcome, a runner policy or capability-profile
 * revalidation, or an operator governance block. Path-bridge blocks have their
 * own reason-specific recovery, and runner guards that are not policy (the
 * memory-consent check, "execution skipped" input repairs, content gates) are
 * excluded, because their fix may be a different request or a repair.
 */
function isToolPolicyBlock(run: ChatToolRunRecord): boolean {
  // A switched-off group is a policy block on a web or browser tool too; a different URL won't lift it (P2-R20).
  if (isSwitchedOffRun(run)) {
    return true;
  }
  if (run.status !== "blocked" || isWebTool(run.toolName) || isPathBridgeBlock(run)) {
    return false;
  }
  const error = (run.error ?? "").trim().toLowerCase();
  return (
    error.startsWith("blocked:") ||
    /\bpolicy\b/.test(error) ||
    /\bcapability profile\b.*\bdoes not authorize\b/.test(error) ||
    Boolean(buildGovernanceBlockGuidance(run))
  );
}

function isPathBridgeBlock(run: ChatToolRunRecord): boolean {
  return run.status === "blocked" && Boolean(readPathBridgeBlock(run.result, run.error));
}

function isFailedMemoryWrite(run: ChatToolRunRecord): boolean {
  return run.status === "failed" && (run.toolName === "memory.write" || run.toolName === "memory.upsert");
}

function isMemoryConsentBlock(input: { status: ChatToolRunRecord["status"]; error?: string }): boolean {
  return input.status === "blocked" && (input.error ?? "").includes(MEMORY_CONSENT_BLOCKED_REASON);
}

/**
 * Guidance for a memory write stopped by the runner's consent check. The check
 * matches accepted phrasings in the user's own message, so a narrower tool
 * input or a repeat call cannot pass it; only a message using one of those
 * phrasings can.
 */
export function buildMemoryConsentBlockGuidance(input: {
  status: ChatToolRunRecord["status"];
  error?: string;
}): string | undefined {
  if (!isMemoryConsentBlock(input)) {
    return undefined;
  }
  return `Long-term memory is saved only when the user's own message uses an accepted consent phrasing, for example ${MEMORY_CONSENT_EXAMPLES}. This is a phrase check on the user's message, not on the tool input, so do not retry the write with different input. Ask the user to use one of those phrasings; a bare "yes" does not pass the check.`;
}

/**
 * True when every failed attempt was a memory-consent block and the answer
 * already talks about memory, so the generic "blocked by policy" appendix
 * would only contradict it.
 */
export function answerCoversMemoryConsentBlocks(
  content: string,
  failedOrBlocked: readonly ChatToolRunRecord[],
): boolean {
  return failedOrBlocked.length > 0 && failedOrBlocked.every(isMemoryConsentBlock) && /\bmemory\b/i.test(content);
}

/**
 * Recovery answer for a turn whose every failed attempt was blocked by tool
 * policy, the memory-consent check, or the workspace path bridge. The answer
 * says what stopped the tool and what lifts it, and never invites a narrower
 * retry or echoes the raw reason. A path-bridge answer carries only its
 * reason-specific guidance, because most of those reasons (an invalid path,
 * missing Git or WSL) are repaired, not lifted by policy. Returns undefined when
 * any attempt failed or was blocked for another reason, or the blocks are of
 * mixed kinds, which keeps the generic recovery text.
 */
export function buildPolicyBlockedRecoveryText(failedOrBlocked: readonly ChatToolRunRecord[]): string | undefined {
  if (failedOrBlocked.length === 0) {
    return undefined;
  }
  if (failedOrBlocked.every(isMemoryConsentBlock)) {
    return [
      "I didn't save that to memory. Long-term memory is saved only when your message uses one of the accepted consent phrasings, and this one didn't match any of them, so I stopped instead of retrying.",
      `To save it, use one of those phrasings, for example ${MEMORY_CONSENT_EXAMPLES}.`,
    ].join("\n\n");
  }
  if (failedOrBlocked.every(isFailedMemoryWrite)) {
    // The generic "try a narrower input" template hid a failed write (#566). The write is all-or-nothing
    // (#571), but a failed run doesn't prove it failed before the commit: a timeout or cancel only stops
    // the wait, and audit persistence runs after the tool returns (#575). Only a missing required argument,
    // checked before any storage call, proves that nothing was kept.
    const reason = failedOrBlocked
      .at(-1)
      ?.error?.replace(/^execution error:\s*/i, "")
      .trim();
    const detail = reason ? ` (${reason})` : "";
    if (!reason || !/^[a-z][\w.]* is required$/i.test(reason)) {
      return [
        `The memory write didn't finish cleanly${detail}, so I can't confirm whether this was saved.`,
        "Check Library > Memory before asking me to remember it again, so you don't end up with a duplicate.",
      ].join("\n\n");
    }
    return [
      `I didn't save that to memory: the memory write failed${detail}. Nothing was saved, so I won't be able to recall it later.`,
      "Ask me to remember it again. If it keeps failing, the error above is what to report.",
    ].join("\n\n");
  }
  const lastBlock = failedOrBlocked.at(-1);
  if (lastBlock && failedOrBlocked.every(isPathBridgeBlock)) {
    const pathBridgeGuidance = buildPathBridgeFailureGuidance(lastBlock);
    return pathBridgeGuidance
      ? `I stopped instead of retrying ${lastBlock.toolName}. ${pathBridgeGuidance}`
      : undefined;
  }
  if (!failedOrBlocked.every(isToolPolicyBlock)) {
    return undefined;
  }
  const tools = [...new Set(failedOrBlocked.map((run) => run.toolName))].join(", ");
  const guidance = [
    ...new Set(failedOrBlocked.map((run) => buildGovernanceBlockGuidance(run)).filter((line) => line !== undefined)),
  ].slice(0, MAX_POLICY_GUIDANCE_LINES);
  // A switched-off group is lifted in Capabilities › Tools (or, for a plugin's hold, Plugins), not by editing the policy.
  const closing = failedOrBlocked.every(isSwitchedOffRun)
    ? switchedOffClosing(failedOrBlocked)
    : "The operator can review what this workspace's tools may do in Settings > Tools. Once the policy allows it, ask again and I'll retry.";
  return [
    `I couldn't do that: this workspace's tool policy blocked ${tools}. A policy block is not caused by the input, so I stopped instead of retrying it with a different one.`,
    ...guidance.map((line) => `Why: ${line}`),
    closing,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * User-facing appendix for failed or blocked tool runs. Only failures and web
 * tool blocks get the URL/query hint; a policy block on another tool, or on a
 * web tool in a switched-off group, is not fixed by a different URL or a
 * narrower query.
 */
export function buildToolFailureAppendixText(failedOrBlocked: readonly ChatToolRunRecord[]): string | undefined {
  if (failedOrBlocked.length === 0) {
    return undefined;
  }
  if (failedOrBlocked.every(isMemoryConsentBlock)) {
    return `Note: nothing was saved to memory. Long-term memory is saved only when your message uses an accepted consent phrasing, for example ${MEMORY_CONSENT_EXAMPLES}.`;
  }
  const policyBlocksOnly = failedOrBlocked.every(
    (run) => isSwitchedOffRun(run) || (run.status === "blocked" && !isWebTool(run.toolName)),
  );
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
