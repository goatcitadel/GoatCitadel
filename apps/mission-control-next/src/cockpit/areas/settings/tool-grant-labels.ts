import type { ToolGrantDecision, ToolGrantRecord, ToolGrantScope, ToolGrantType } from "@goatcitadel/contracts";

/** Operator words for a recorded grant's decision and scope; the raw values stay in the grant's details. */
export const TOOL_GRANT_DECISION_LABELS: Record<ToolGrantDecision, string> = { allow: "Allow", deny: "Deny" };

export const TOOL_GRANT_SCOPE_LABELS: Record<ToolGrantScope, string> = {
  global: "Global",
  workspace: "Workspace",
  session: "Session",
  agent: "Agent",
  task: "Task",
  citadel: "Citadel",
  chamber: "Chamber",
};

/** "session.status · Allow · Workspace": the pattern, then what it does and where. Never the grant ID. */
export function describeToolGrant(grant: Pick<ToolGrantRecord, "toolPattern" | "decision" | "scope">): string {
  return [
    grant.toolPattern,
    TOOL_GRANT_DECISION_LABELS[grant.decision] ?? "Unknown decision",
    TOOL_GRANT_SCOPE_LABELS[grant.scope] ?? "Unknown scope",
  ].join(" · ");
}

export const TOOL_GRANT_TYPE_LABELS: Record<ToolGrantType, string> = {
  persistent: "Until revoked",
  ttl: "Expires at a time",
  one_time: "One use",
};
