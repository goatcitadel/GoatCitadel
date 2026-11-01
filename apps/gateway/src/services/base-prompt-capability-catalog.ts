/**
 * Narrows the base prompt's advisory tool catalog to the tools this turn's
 * policy allows. The runner drops policy-denied tools from every step's tool
 * schema; listing them in the prompt anyway invited the model to call a tool it
 * was never offered, which the Claude Code CLI bridge fails closed (#494).
 *
 * This only ever removes names. Enforcement still happens at call time, and a
 * tool kept out here by a narrower probe context still reaches the model
 * through the step's real tool list.
 */

import type {
  ChatMode,
  ChatSessionPrefsRecord,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
} from "@goatcitadel/contracts";
import { CODE_MODE_REQUEST_TOOL_NAME, SUBAGENT_FANOUT_TOOL_NAME } from "@goatcitadel/policy-engine";
import type { BaseAgentPromptToolset } from "./base-agent-system-prompt.js";
import { buildToolAccessProbeArgs } from "./chat-turn-agent-runner.js";
import { TOOL_GROUP_OFF_REASON_CODE } from "./chat-turn-agent-runner/tool-failure-messaging.js";
import { CODE_MODE_ONLY_TOOL_NAMES } from "./chat-tool-families.js";

export interface BasePromptCatalogScope {
  sessionId: string;
  workspaceId?: string;
  mode: ChatMode;
}

export type BasePromptToolAccessProbe = (request: ToolAccessEvaluateRequest) => Promise<ToolAccessEvaluateResponse>;

// Matches the runner's per-turn policy probe concurrency.
const PROBE_CONCURRENCY = 8;

export async function filterBasePromptToolsetByPolicy(
  toolset: BaseAgentPromptToolset,
  scope: BasePromptCatalogScope,
  inspect: BasePromptToolAccessProbe,
  safeWriteFallbackDir?: string,
): Promise<BaseAgentPromptToolset> {
  type Verdict = { callable: true; requiresApproval: boolean } | { callable: false; switchedOff: boolean };
  /** Whether the tool is callable this turn and, if so, whether it asks the operator first; if not, whether the operator's tool group switch is why. */
  const probe = async (toolName: string): Promise<Verdict> => {
    try {
      const access = await inspect({
        toolName,
        agentId: "assistant",
        sessionId: scope.sessionId,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        surface: scope.mode,
        args: buildToolAccessProbeArgs(toolName, safeWriteFallbackDir),
      });
      // A tool that is also denied reports policy_deny, not tool_group_off, so a switched-off tool here is
      // one that switching its group on would let through.
      return access.allowed
        ? { callable: true, requiresApproval: access.requiresApproval }
        : { callable: false, switchedOff: access.reasonCodes.includes(TOOL_GROUP_OFF_REASON_CODE) };
    } catch {
      // Like the runner: a tool whose policy cannot be evaluated is not callable this turn.
      return { callable: false, switchedOff: false };
    }
  };
  const allowed = new Set<string>();
  const asksFirst = new Set<string>();
  const switchedOff = new Set<string>();
  const names = [...toolset.toolNames];
  for (let start = 0; start < names.length; start += PROBE_CONCURRENCY) {
    const batch = names.slice(start, start + PROBE_CONCURRENCY);
    const verdicts = await Promise.all(batch.map(probe));
    batch.forEach((toolName, index) => {
      const verdict = verdicts[index];
      if (!verdict) return;
      if (!verdict.callable) {
        if (verdict.switchedOff) switchedOff.add(toolName);
        return;
      }
      allowed.add(toolName);
      if (verdict.requiresApproval) asksFirst.add(toolName);
    });
  }
  return {
    ...toolset,
    toolNames: names.filter((toolName) => allowed.has(toolName)),
    // Switched-off tools are denied tools too; switchedOffToolNames lets the prompt word them as the operator's switch.
    policyDeniedToolNames: names.filter((toolName) => !allowed.has(toolName)),
    switchedOffToolNames: names.filter((toolName) => switchedOff.has(toolName)),
    approvalRequiredToolNames: names.filter((toolName) => asksFirst.has(toolName)),
  };
}

/**
 * The runner offers agent.fanout only on a turn whose automatic delegation was admitted, which turn preparation
 * records as the "auto_when_useful" subagent policy. Listing it otherwise told the model it could delegate, and on
 * the Claude Code CLI a call to a tool the step does not offer fails closed (#495).
 */
export function withoutUnadmittedFanout(
  toolset: BaseAgentPromptToolset,
  subagentPolicy: ChatSessionPrefsRecord["subagentPolicy"] | undefined,
): BaseAgentPromptToolset {
  if (subagentPolicy === "auto_when_useful" || !toolset.toolNames.includes(SUBAGENT_FANOUT_TOOL_NAME)) return toolset;
  return { ...toolset, toolNames: toolset.toolNames.filter((name) => name !== SUBAGENT_FANOUT_TOOL_NAME) };
}

/**
 * No Chat step offers the Code Mode script-only tools (`docs.read_bytes`, `docs.extract_text`, `docs.decompress`):
 * they run only inside an approved Code Mode script. The runner offers `code_mode.request` only on an eligible turn
 * (`resolveCodeModeRequestEligibility`). Listing either otherwise invited calls to tools the step does not offer,
 * which the Claude Code CLI bridge fails closed.
 */
export function withoutUnofferedCodeModeTools<T extends BaseAgentPromptToolset>(
  toolset: T,
  codeModeRequestEligible: boolean,
): T {
  const offered = (name: string) =>
    !CODE_MODE_ONLY_TOOL_NAMES.has(name) && (codeModeRequestEligible || name !== CODE_MODE_REQUEST_TOOL_NAME);
  return {
    ...toolset,
    toolNames: toolset.toolNames.filter(offered),
    ...(toolset.approvalRequiredToolNames
      ? { approvalRequiredToolNames: toolset.approvalRequiredToolNames.filter(offered) }
      : {}),
    ...(toolset.policyDeniedToolNames ? { policyDeniedToolNames: toolset.policyDeniedToolNames.filter(offered) } : {}),
    ...(toolset.switchedOffToolNames ? { switchedOffToolNames: toolset.switchedOffToolNames.filter(offered) } : {}),
  };
}
