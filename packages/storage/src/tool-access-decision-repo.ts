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
  allowed: boolean;
  reasonCodes: string[];
  matchedGrantId?: string;
  requiresApproval: boolean;
  riskLevel: ToolRiskLevel;
}

interface ToolAccessDecisionRow {
  decision_id: string;
  timestamp: string;
  tool_name: string;
  agent_id: string;
  session_id: string;
  task_id: string | null;
  allowed: number;
  reason_codes_json: string;
  matched_grant_id: string | null;
  requires_approval: number;
  risk_level: ToolRiskLevel;
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
        decision_id, timestamp, tool_name, agent_id, session_id, task_id,
        allowed, reason_codes_json, matched_grant_id, requires_approval, risk_level
      ) VALUES (
        @decisionId, @timestamp, @toolName, @agentId, @sessionId, @taskId,
        @allowed, @reasonCodesJson, @matchedGrantId, @requiresApproval, @riskLevel
      )
    `);
    this.countByToolGlobalSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND timestamp >= @since
    `);
    this.countByToolAgentSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND agent_id = @agentId
        AND timestamp >= @since
    `);
    this.countByToolSessionSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND agent_id = @agentId
        AND session_id = @sessionId
        AND timestamp >= @since
    `);
    this.countByToolWorkspaceSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions AS decision
      INNER JOIN chat_session_meta AS meta
        ON meta.session_id = decision.session_id
      WHERE decision.tool_name = @toolName
        AND meta.workspace_id = @workspaceId
        AND decision.timestamp >= @since
    `);
    this.countByToolTaskSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE tool_name = @toolName
        AND task_id = @taskId
        AND timestamp >= @since
    `);
    this.countWritesGlobalSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE allowed = 1
        AND tool_name IN ('fs.write', 'fs.move', 'fs.delete', 'git.add', 'git.commit', 'git.branch.switch', 'git.worktree.create', 'git.worktree.remove', 'gmail.send', 'calendar.create_event')
        AND timestamp >= @since
    `);
    this.countWritesAgentSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE agent_id = @agentId
        AND allowed = 1
        AND tool_name IN ('fs.write', 'fs.move', 'fs.delete', 'git.add', 'git.commit', 'git.branch.switch', 'git.worktree.create', 'git.worktree.remove', 'gmail.send', 'calendar.create_event')
        AND timestamp >= @since
    `);
    this.countWritesSessionSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE agent_id = @agentId
        AND session_id = @sessionId
        AND allowed = 1
        AND tool_name IN ('fs.write', 'fs.move', 'fs.delete', 'git.add', 'git.commit', 'git.branch.switch', 'git.worktree.create', 'git.worktree.remove', 'gmail.send', 'calendar.create_event')
        AND timestamp >= @since
    `);
    this.countWritesWorkspaceSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions AS decision
      INNER JOIN chat_session_meta AS meta
        ON meta.session_id = decision.session_id
      WHERE meta.workspace_id = @workspaceId
        AND decision.allowed = 1
        AND decision.tool_name IN ('fs.write', 'fs.move', 'fs.delete', 'git.add', 'git.commit', 'git.branch.switch', 'git.worktree.create', 'git.worktree.remove', 'gmail.send', 'calendar.create_event')
        AND decision.timestamp >= @since
    `);
    this.countWritesTaskSinceStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM tool_access_decisions
      WHERE task_id = @taskId
        AND allowed = 1
        AND tool_name IN ('fs.write', 'fs.move', 'fs.delete', 'git.add', 'git.commit', 'git.branch.switch', 'git.worktree.create', 'git.worktree.remove', 'gmail.send', 'calendar.create_event')
        AND timestamp >= @since
    `);
  }

  public record(input: Omit<ToolAccessDecisionRecord, "decisionId" | "timestamp">, now = new Date().toISOString()): ToolAccessDecisionRecord {
    const decisionId = randomUUID();
    this.insertStmt.run({
      decisionId,
      timestamp: now,
      toolName: input.toolName,
      agentId: input.agentId,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      allowed: input.allowed ? 1 : 0,
      reasonCodesJson: JSON.stringify(input.reasonCodes),
      matchedGrantId: input.matchedGrantId ?? null,
      requiresApproval: input.requiresApproval ? 1 : 0,
      riskLevel: input.riskLevel,
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
          agentId: input.agentId,
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
          agentId: input.agentId,
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
    taskId: row.task_id ?? undefined,
    allowed: Boolean(row.allowed),
    reasonCodes: safeJsonParse<string[]>(row.reason_codes_json, []),
    matchedGrantId: row.matched_grant_id ?? undefined,
    requiresApproval: Boolean(row.requires_approval),
    riskLevel: row.risk_level,
  };
}


