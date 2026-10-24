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

import type { ChatMode, ToolAccessEvaluateRequest, ToolAccessEvaluateResponse } from "@goatcitadel/contracts";
import type { BaseAgentPromptToolset } from "./base-agent-system-prompt.js";
import { buildToolAccessProbeArgs } from "./chat-turn-agent-runner.js";

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
  /** `undefined` when the tool is not callable this turn; otherwise whether it asks the operator first. */
  const probe = async (toolName: string): Promise<{ requiresApproval: boolean } | undefined> => {
    try {
      const access = await inspect({
        toolName,
        agentId: "assistant",
        sessionId: scope.sessionId,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        surface: scope.mode,
        args: buildToolAccessProbeArgs(toolName, safeWriteFallbackDir),
      });
      return access.allowed ? { requiresApproval: access.requiresApproval } : undefined;
    } catch {
      // Like the runner: a tool whose policy cannot be evaluated is not callable this turn.
      return undefined;
    }
  };
  const allowed = new Set<string>();
  const asksFirst = new Set<string>();
  const names = [...toolset.toolNames];
  for (let start = 0; start < names.length; start += PROBE_CONCURRENCY) {
    const batch = names.slice(start, start + PROBE_CONCURRENCY);
    const verdicts = await Promise.all(batch.map(probe));
    batch.forEach((toolName, index) => {
      const verdict = verdicts[index];
      if (!verdict) return;
      allowed.add(toolName);
      if (verdict.requiresApproval) asksFirst.add(toolName);
    });
  }
  return {
    ...toolset,
    toolNames: names.filter((toolName) => allowed.has(toolName)),
    policyDeniedToolNames: names.filter((toolName) => !allowed.has(toolName)),
    approvalRequiredToolNames: names.filter((toolName) => asksFirst.has(toolName)),
  };
}
