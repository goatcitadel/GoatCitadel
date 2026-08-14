import type { DatabaseClient } from "./db.js";
import type {
  ChatFanoutInvocationCreateResult,
  ChatFanoutInvocationRecord,
  ChatFanoutInvocationStatus,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";

interface ChatFanoutInvocationRow {
  invocation_id: string;
  parent_run_id: string;
  tool_run_id: string;
  delegation_run_id: string | null;
  session_id: string;
  workspace_id: string;
  project_id: string;
  status: ChatFanoutInvocationStatus;
  child_count: number | string;
  subtasks_json: string;
  grant_id: string;
  reserved_activations: number | string;
  reserved_budget_usd: number | string;
  objective: string;
  capability_profile_hash: string | null;
  policy_profile_hash: string | null;
  project_binding_hash: string;
  grant_binding_hash: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  terminal_reason: string | null;
}

const TERMINAL_STATUSES = new Set<ChatFanoutInvocationStatus>([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "blocked",
]);

/**
 * Canonical parent-tool invocation bridge for durable Chat fan-out. The unique
 * parent/tool pair is deliberately server-owned: duplicate tool delivery and
 * recovery converge on the same aggregate instead of creating more children.
 */
export class ChatFanoutInvocationRepository {
  private readonly getStmt;
  private readonly getByParentToolStmt;
  private readonly insertStmt;
  private readonly patchStmt;
  private readonly listActiveStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_fanout_invocations WHERE invocation_id = ?");
    this.getByParentToolStmt = db.prepare(`
      SELECT * FROM chat_fanout_invocations
      WHERE parent_run_id = ? AND tool_run_id = ?
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO chat_fanout_invocations (
        invocation_id, parent_run_id, tool_run_id, delegation_run_id,
        session_id, workspace_id, project_id, status, child_count, grant_id,
        subtasks_json, reserved_activations, reserved_budget_usd, objective,
        capability_profile_hash, policy_profile_hash, project_binding_hash,
        grant_binding_hash, created_at, updated_at, finished_at, terminal_reason
      ) VALUES (
        @invocationId, @parentRunId, @toolRunId, @delegationRunId,
        @sessionId, @workspaceId, @projectId, @status, @childCount, @grantId,
        @subtasksJson, @reservedActivations, @reservedBudgetUsd, @objective,
        @capabilityProfileHash, @policyProfileHash, @projectBindingHash,
        @grantBindingHash, @createdAt, @updatedAt, @finishedAt, @terminalReason
      )
      ON CONFLICT(parent_run_id, tool_run_id) DO NOTHING
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_fanout_invocations
      SET
        delegation_run_id = @delegationRunId,
        status = @status,
        updated_at = @updatedAt,
        finished_at = @finishedAt,
        terminal_reason = @terminalReason
      WHERE invocation_id = @invocationId
    `);
    this.listActiveStmt = db.prepare(`
      SELECT * FROM chat_fanout_invocations
      WHERE status IN ('reserving', 'reserved', 'dispatching', 'waiting')
      ORDER BY updated_at ASC, invocation_id ASC
      LIMIT ?
    `);
  }

  public createOrGet(
    input: Omit<ChatFanoutInvocationRecord, "updatedAt"> & { updatedAt?: string },
  ): ChatFanoutInvocationRecord {
    return this.createOrGetWithOutcome(input).invocation;
  }

  public createOrGetWithOutcome(
    input: Omit<ChatFanoutInvocationRecord, "updatedAt"> & { updatedAt?: string },
  ): ChatFanoutInvocationCreateResult {
    return this.db.transaction("immediate", () => {
      const existing = this.findByParentAndTool(input.parentRunId, input.toolRunId);
      if (existing) {
        return { invocation: existing, created: false };
      }
      const now = input.updatedAt ?? input.createdAt;
      this.insertStmt.run({
        invocationId: input.invocationId,
        parentRunId: input.parentRunId,
        toolRunId: input.toolRunId,
        delegationRunId: input.delegationRunId ?? null,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        status: input.status,
        childCount: input.childCount,
        grantId: input.grantId,
        subtasksJson: JSON.stringify(input.subtasks),
        reservedActivations: input.reservedActivations,
        reservedBudgetUsd: input.reservedBudgetUsd,
        objective: input.objective,
        capabilityProfileHash: input.capabilityProfileHash ?? null,
        policyProfileHash: input.policyProfileHash ?? null,
        projectBindingHash: input.projectBindingHash,
        grantBindingHash: input.grantBindingHash,
        createdAt: input.createdAt,
        updatedAt: now,
        finishedAt: input.finishedAt ?? null,
        terminalReason: input.terminalReason ?? null,
      });
      const created = this.findByParentAndTool(input.parentRunId, input.toolRunId);
      if (!created) {
        throw new Error(`Failed to create Chat fan-out invocation ${input.invocationId}`);
      }
      return { invocation: created, created: true };
    });
  }

  public get(invocationId: string): ChatFanoutInvocationRecord {
    const row = mapRow(this.getStmt.get(invocationId));
    if (!row) throw new NotFoundError({ entity: "Chat fan-out invocation", id: invocationId });
    return row;
  }

  public findByParentAndTool(parentRunId: string, toolRunId: string): ChatFanoutInvocationRecord | undefined {
    return mapRow(this.getByParentToolStmt.get(parentRunId, toolRunId));
  }

  public patch(
    invocationId: string,
    input: {
      delegationRunId?: string;
      status?: ChatFanoutInvocationStatus;
      terminalReason?: string;
      finishedAt?: string;
      clearFinishedAt?: boolean;
      updatedAt?: string;
    },
  ): ChatFanoutInvocationRecord {
    const current = this.get(invocationId);
    const status = input.status ?? current.status;
    if (TERMINAL_STATUSES.has(current.status) && status !== current.status) {
      throw new Error(`Terminal Chat fan-out invocation ${invocationId} cannot transition from ${current.status}.`);
    }
    const finishedAt = input.clearFinishedAt
      ? undefined
      : input.finishedAt !== undefined
        ? input.finishedAt
        : TERMINAL_STATUSES.has(status)
          ? (current.finishedAt ?? new Date().toISOString())
          : current.finishedAt;
    this.patchStmt.run({
      invocationId,
      delegationRunId: input.delegationRunId !== undefined ? input.delegationRunId : (current.delegationRunId ?? null),
      status,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
      finishedAt: finishedAt ?? null,
      terminalReason: input.terminalReason !== undefined ? input.terminalReason : (current.terminalReason ?? null),
    });
    return this.get(invocationId);
  }

  public listActive(limit = 200): ChatFanoutInvocationRecord[] {
    return this.listActiveStmt
      .all(Math.max(1, Math.min(1000, Math.floor(limit))))
      .map((row: unknown) => mapRow(row))
      .filter((row): row is ChatFanoutInvocationRecord => Boolean(row));
  }
}

function mapRow(value: unknown): ChatFanoutInvocationRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as ChatFanoutInvocationRow;
  if (
    !row.invocation_id ||
    !row.parent_run_id ||
    !row.tool_run_id ||
    !row.session_id ||
    !row.workspace_id ||
    !row.project_id ||
    !row.grant_id ||
    !row.objective ||
    !row.project_binding_hash ||
    !row.grant_binding_hash ||
    !isStatus(row.status)
  ) {
    return undefined;
  }
  const childCount = Number(row.child_count);
  const reservedActivations = Number(row.reserved_activations);
  const reservedBudgetUsd = Number(row.reserved_budget_usd);
  if (
    !Number.isInteger(childCount) ||
    childCount < 1 ||
    childCount > 3 ||
    !Number.isInteger(reservedActivations) ||
    reservedActivations < childCount ||
    !Number.isFinite(reservedBudgetUsd) ||
    reservedBudgetUsd < 0
  ) {
    return undefined;
  }
  const subtasks = parseSubtasks(row.subtasks_json);
  if (!subtasks || subtasks.length !== childCount) {
    return undefined;
  }
  return {
    invocationId: row.invocation_id,
    parentRunId: row.parent_run_id,
    toolRunId: row.tool_run_id,
    ...(row.delegation_run_id ? { delegationRunId: row.delegation_run_id } : {}),
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    status: row.status,
    childCount,
    subtasks,
    grantId: row.grant_id,
    reservedActivations,
    reservedBudgetUsd,
    objective: row.objective,
    ...(row.capability_profile_hash ? { capabilityProfileHash: row.capability_profile_hash } : {}),
    ...(row.policy_profile_hash ? { policyProfileHash: row.policy_profile_hash } : {}),
    projectBindingHash: row.project_binding_hash,
    grantBindingHash: row.grant_binding_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
  };
}

function parseSubtasks(value: string): ChatFanoutInvocationRecord["subtasks"] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3) return undefined;
    const subtasks = parsed.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      if (typeof record.objective !== "string" || !record.objective.trim()) return undefined;
      return {
        objective: record.objective,
        ...(typeof record.label === "string" && record.label.trim() ? { label: record.label } : {}),
        ...(typeof record.expectedOutput === "string" && record.expectedOutput.trim()
          ? { expectedOutput: record.expectedOutput }
          : {}),
      };
    });
    return subtasks.every(Boolean) ? (subtasks as ChatFanoutInvocationRecord["subtasks"]) : undefined;
  } catch {
    return undefined;
  }
}

function isStatus(value: unknown): value is ChatFanoutInvocationStatus {
  return (
    typeof value === "string" &&
    [
      "reserving",
      "reserved",
      "dispatching",
      "waiting",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "blocked",
    ].includes(value)
  );
}
