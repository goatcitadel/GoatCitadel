import assert from "node:assert/strict";
import type { DatabaseClient } from "./db.js";
import { ToolAccessDecisionRepository, type ToolAccessDecisionRecord } from "./tool-access-decision-repo.js";

export function verifyToolPolicyIdentityAccounting(db: DatabaseClient): void {
  const repo = new ToolAccessDecisionRepository(db);
  const base = {
    agentId: "policy-identity-agent",
    sessionId: "policy-identity-session",
    workspaceId: "policy-identity-workspace",
    taskId: "policy-identity-task",
    allowed: true,
    requiresApproval: false,
    riskLevel: "caution" as const,
    reasonCodes: ["allowed"],
  };
  const record = (input: Partial<ToolAccessDecisionRecord>, now?: string) =>
    repo.record(
      {
        ...base,
        toolName: "mcp.docs.read",
        policyToolName: "mcp.invoke",
        ...input,
      },
      now,
    );
  const native = record({});
  record({ toolName: "mcp.docs.search" });
  record({ toolName: "mcp.invoke", policyToolName: undefined });
  record({ agentId: "other", sessionId: "other", workspaceId: "other", taskId: "other" });
  record({ countsTowardLimits: false });
  record({ allowed: false, countsTowardLimits: false });
  record({}, new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  record({ toolName: "mcp.unbound.tool", policyToolName: undefined });

  for (const scope of ["global", "agent", "session", "workspace", "task"] as const) {
    const input = { ...base, scope };
    assert.equal(
      repo.countToolCallsInLastHourInScope({ ...input, toolName: "mcp.invoke" }),
      scope === "global" ? 4 : 3,
      `${scope}: shared MCP limit counts each authorized identity once`,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({ ...input, toolName: "mcp.docs.read" }),
      scope === "global" ? 2 : 1,
      `${scope}: native limit retains exact tool identity`,
    );
    assert.equal(
      repo.countWritesInLastHourInScope(input),
      scope === "global" ? 4 : 3,
      `${scope}: named MCP invocations retain conservative mutation accounting`,
    );
  }
  assert.equal(repo.countToolCallsInLastHour("mcp.docs.search", base.agentId, base.sessionId), 1);
  const row = db
    .prepare("SELECT tool_name, policy_tool_name FROM tool_access_decisions WHERE decision_id = ?")
    .get(native.decisionId) as { tool_name: string; policy_tool_name: string };
  assert.equal(row.tool_name, "mcp.docs.read");
  assert.equal(row.policy_tool_name, "mcp.invoke");
  for (const toolName of ["fs.read", "mcp.invoke", "MCP.docs.read", "mcp.", "mcp." + "x".repeat(252)]) {
    assert.throws(() => record({ toolName }), Error, `invalid shared identity: ${toolName}`);
  }
}
