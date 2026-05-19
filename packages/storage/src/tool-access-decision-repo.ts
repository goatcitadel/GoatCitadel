import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { ToolGrantScope, ToolRiskLevel } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

export interface ToolAccessDecisionRecord {
  decisionId: string;
  timestamp: string;
  toolName: string;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  allowed: boolean;
  reasonCodes: string[];
  matchedGrantId?: string;
  requiresApproval: boolean;
  riskLevel: ToolRiskLevel;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  countsTowardLimits?: boolean;
}

interface ToolAccessDecisionRow {
  decision_id: string;
  timestamp: string;
  tool_name: string;
  agent_id: string;
  session_id: string;
  workspace_id: string | null;
  task_id: string | null;
  run_id: string | null;
  allowed: number;
  reason_codes_json: string;
  matched_grant_id: string | null;
  requires_approval: number;
  risk_level: ToolRiskLevel;
  permission_profile_id: string | null;
  local_operator_override_id: string | null;
  counts_toward_limits: number | null;
}

const CAUTION_MUTATING_TOOL_SQL_NAMES = [
  "bankr.write",
  "fs.write",
  "fs.copy",
  "fs.move",
  "fs.delete",
  "http.post",
  "shell.exec",
  "shell.exec_background",
  "git.add",
  "git.commit",
  "git.branch.create",
  "git.branch.switch",
  "git.worktree.create",
  "git.worktree.remove",
  "browser.screenshot",
  "browser.interact",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.set",
  "browser.storage.clear",
  "browser.context.configure",
  "mcp.invoke",
  "gmail.send",
  "memory.write",
  "memory.upsert",
  "docs.ingest",
  "embeddings.index",
  "artifacts.create",
  "documents.create",
  "presentations.create",
  "calendar.create_event",
];

const CAUTION_MUTATING_TOOL_SQL_LIST = CAUTION_MUTATING_TOOL_SQL_NAMES.map((name) => `'${name}'`).join(", ");

function writeDecisionPredicate(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `(
          ${prefix}risk_level IN ('danger', 'nuclear')
          OR ${prefix}tool_name IN (${CAUTION_MUTATING_TOOL_SQL_LIST})
          OR ${prefix}tool_name LIKE '%.send'
          OR ${prefix}tool_name LIKE '%.react'
          OR ${prefix}tool_name LIKE '%.unsend'
        )`;
}

export class ToolAccessDecisionRepository {
  private readonly insertStmt;
  private readonly countByToolGlobalSinceStmt;
  private readonly countByToolAgentSinceStmt;
  private readonly countByToolSessionSinceStmt;
  private readonly countByToolWorkspaceSinceStmt;
  private readonly countByToolTaskSinceStmt;
  private readonly countWritesGlobalSinceStmt;
  private readonly countWritesAgentSinceStmt;
  private readonly countWritesSessionSinceStmt;
  private readonly countWritesWorkspaceSinceStmt;
  private readonly countWritesTaskSinceStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO tool_access_decisions (
        decision_id, timestamp, tool_name, agent_id, session_id, workspace_id, task_id, run_id,
        allowed, reason_codes_json, matched_grant_id, requires_approval, risk_level,
        permission_profile_id, local_operator_override_id, counts_toward_limits
      ) VALUES (
        @decisionId, @timestamp, @toolName, @agentId, @sessionId, @workspaceId, @taskId, @runId,
        @allowed, @reasonCodesJson, @matchedGrantId, @requiresApproval, @riskLevel,
        @permissionProfileId, @localOperatorOverrideId, @countsTowardLimits
      )
    `);
    this.countByToolGlobalSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND counts_toward_limits = 1
        AND timestamp >= @since
    `);
    this.countByToolAgentSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND agent_id = @agentId
        AND counts_toward_limits = 1
        AND timestamp >= @since
    `);
    this.countByToolSessionSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND session_id = @sessionId
        AND counts_toward_limits = 1
        AND timestamp >= @since
    `);
    this.countByToolWorkspaceSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions AS decision
      LEFT JOIN chat_session_meta AS meta
        ON meta.session_id = decision.session_id
      WHERE decision.tool_name = @toolName
        AND (
          decision.workspace_id = @workspaceId
          OR (decision.workspace_id IS NULL AND meta.workspace_id = @workspaceId)
        )
        AND decision.counts_toward_limits = 1
        AND decision.timestamp >= @since
    `);
    this.countByToolTaskSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND task_id = @taskId
        AND counts_toward_limits = 1
        AND timestamp >= @since
    `);
    this.countWritesGlobalSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE allowed = 1
        AND counts_toward_limits = 1
        AND ${writeDecisionPredicate()}
        AND timestamp >= @since
    `);
    this.countWritesAgentSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE agent_id = @agentId
        AND allowed = 1
        AND counts_toward_limits = 1
        AND ${writeDecisionPredicate()}
        AND timestamp >= @since
    `);
    this.countWritesSessionSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE session_id = @sessionId
        AND allowed = 1
        AND counts_toward_limits = 1
        AND ${writeDecisionPredicate()}
        AND timestamp >= @since
    `);
    this.countWritesWorkspaceSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions AS decision
      LEFT JOIN chat_session_meta AS meta
        ON meta.session_id = decision.session_id
      WHERE (
          decision.workspace_id = @workspaceId
          OR (decision.workspace_id IS NULL AND meta.workspace_id = @workspaceId)
        )
        AND decision.allowed = 1
        AND decision.counts_toward_limits = 1
        AND ${writeDecisionPredicate("decision")}
        AND decision.timestamp >= @since
    `);
    this.countWritesTaskSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE task_id = @taskId
        AND allowed = 1
        AND counts_toward_limits = 1
        AND ${writeDecisionPredicate()}
        AND timestamp >= @since
    `);
  }

  public record(
    input: Omit<ToolAccessDecisionRecord, "decisionId" | "timestamp">,
    now = new Date().toISOString(),
  ): ToolAccessDecisionRecord {
    const decisionId = randomUUID();
    this.insertStmt.run({
      decisionId,
      timestamp: now,
      toolName: input.toolName,
      agentId: input.agentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      allowed: input.allowed ? 1 : 0,
      reasonCodesJson: JSON.stringify(input.reasonCodes),
      matchedGrantId: input.matchedGrantId ?? null,
      requiresApproval: input.requiresApproval ? 1 : 0,
      riskLevel: input.riskLevel,
      permissionProfileId: input.permissionProfileId ?? null,
      localOperatorOverrideId: input.localOperatorOverrideId ?? null,
      countsTowardLimits: input.countsTowardLimits === false ? 0 : 1,
    });
    return {
      decisionId,
      timestamp: now,
      ...input,
    };
  }

  public countToolCallsInLastHour(toolName: string, agentId: string, sessionId: string): number {
    return this.countToolCallsInLastHourInScope({
      toolName,
      scope: "session",
      agentId,
      sessionId,
    });
  }

  public countWritesInLastHour(agentId: string, sessionId: string): number {
    return this.countWritesInLastHourInScope({
      scope: "session",
      agentId,
      sessionId,
    });
  }

  public countToolCallsInLastHourInScope(input: {
    toolName: string;
    scope: ToolGrantScope;
    agentId: string;
    sessionId: string;
    workspaceId?: string;
    taskId?: string;
  }): number {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let row: { count: number };
    switch (input.scope) {
      case "global":
        row = this.countByToolGlobalSinceStmt.get({
          toolName: input.toolName,
          since,
        }) as { count: number };
        break;
      case "agent":
        row = this.countByToolAgentSinceStmt.get({
          toolName: input.toolName,
          agentId: input.agentId,
          since,
        }) as { count: number };
        break;
      case "workspace":
        if (!input.workspaceId) {
          return 0;
        }
        row = this.countByToolWorkspaceSinceStmt.get({
          toolName: input.toolName,
          workspaceId: input.workspaceId,
          since,
        }) as { count: number };
        break;
      case "task":
        if (!input.taskId) {
          return 0;
        }
        row = this.countByToolTaskSinceStmt.get({
          toolName: input.toolName,
          taskId: input.taskId,
          since,
        }) as { count: number };
        break;
      case "session":
      default:
        row = this.countByToolSessionSinceStmt.get({
          toolName: input.toolName,
          sessionId: input.sessionId,
          since,
        }) as { count: number };
        break;
    }
    return row.count;
  }

  public countWritesInLastHourInScope(input: {
    scope: ToolGrantScope;
    agentId: string;
    sessionId: string;
    workspaceId?: string;
    taskId?: string;
  }): number {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let row: { count: number };
    switch (input.scope) {
      case "global":
        row = this.countWritesGlobalSinceStmt.get({
          since,
        }) as { count: number };
        break;
      case "agent":
        row = this.countWritesAgentSinceStmt.get({
          agentId: input.agentId,
          since,
        }) as { count: number };
        break;
      case "workspace":
        if (!input.workspaceId) {
          return 0;
        }
        row = this.countWritesWorkspaceSinceStmt.get({
          workspaceId: input.workspaceId,
          since,
        }) as { count: number };
        break;
      case "task":
        if (!input.taskId) {
          return 0;
        }
        row = this.countWritesTaskSinceStmt.get({
          taskId: input.taskId,
          since,
        }) as { count: number };
        break;
      case "session":
      default:
        row = this.countWritesSessionSinceStmt.get({
          sessionId: input.sessionId,
          since,
        }) as { count: number };
        break;
    }
    return row.count;
  }
}

export function mapToolAccessDecisionRow(row: ToolAccessDecisionRow): ToolAccessDecisionRecord {
  return {
    decisionId: row.decision_id,
    timestamp: row.timestamp,
    toolName: row.tool_name,
    agentId: row.agent_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id ?? undefined,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined,
    allowed: Boolean(row.allowed),
    reasonCodes: safeJsonParse<string[]>(row.reason_codes_json, []),
    matchedGrantId: row.matched_grant_id ?? undefined,
    requiresApproval: Boolean(row.requires_approval),
    riskLevel: row.risk_level,
    permissionProfileId: row.permission_profile_id ?? undefined,
    localOperatorOverrideId: row.local_operator_override_id ?? undefined,
    countsTowardLimits: row.counts_toward_limits !== 0,
  };
}
