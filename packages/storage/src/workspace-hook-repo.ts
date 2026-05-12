import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  HookActionConfig,
  HookCreateInput,
  HookFailPolicy,
  HookMode,
  HookRecord,
  HookTrigger,
  HookUpdateInput,
} from "@goatcitadel/contracts";
import { ValidationError, deriveHookPhase } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface HookRow {
  hook_id: string;
  workspace_id: string;
  label: string;
  trigger: HookTrigger;
  mode: HookMode;
  enabled: number;
  priority: number;
  timeout_ms: number;
  fail_policy: HookFailPolicy;
  action_json: string;
  created_at: string;
  updated_at: string;
}

export class WorkspaceHookRepository {
  private readonly listStmt;
  private readonly getStmt;
  private readonly getByTriggerStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.listStmt = db.prepare(`
      SELECT *
      FROM workspace_hooks
      WHERE workspace_id = @workspaceId
      ORDER BY priority DESC, created_at ASC, hook_id ASC
      LIMIT @limit
    `);
    this.getStmt = db.prepare(`
      SELECT *
      FROM workspace_hooks
      WHERE workspace_id = @workspaceId
        AND hook_id = @hookId
    `);
    this.getByTriggerStmt = db.prepare(`
      SELECT *
      FROM workspace_hooks
      WHERE workspace_id = @workspaceId
        AND trigger = @trigger
        AND enabled = 1
      ORDER BY priority DESC, created_at ASC, hook_id ASC
      LIMIT @limit
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO workspace_hooks (
        hook_id,
        workspace_id,
        label,
        trigger,
        mode,
        enabled,
        priority,
        timeout_ms,
        fail_policy,
        action_json,
        created_at,
        updated_at
      ) VALUES (
        @hookId,
        @workspaceId,
        @label,
        @trigger,
        @mode,
        @enabled,
        @priority,
        @timeoutMs,
        @failPolicy,
        @actionJson,
        @createdAt,
        @updatedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE workspace_hooks
      SET
        label = @label,
        enabled = @enabled,
        priority = @priority,
        timeout_ms = @timeoutMs,
        fail_policy = @failPolicy,
        action_json = @actionJson,
        updated_at = @updatedAt
      WHERE workspace_id = @workspaceId
        AND hook_id = @hookId
    `);
    this.deleteStmt = db.prepare(`
      DELETE FROM workspace_hooks
      WHERE workspace_id = @workspaceId
        AND hook_id = @hookId
    `);
  }

  public list(workspaceId: string, limit = 200): HookRecord[] {
    const rows = toHookRows(
      this.listStmt.all({
        workspaceId,
        limit: clampLimit(limit),
      }),
    );
    return rows.map(mapHookRow);
  }

  public listByTrigger(workspaceId: string, trigger: HookTrigger, limit = 200): HookRecord[] {
    const rows = toHookRows(
      this.getByTriggerStmt.all({
        workspaceId,
        trigger,
        limit: clampLimit(limit),
      }),
    );
    return rows.map(mapHookRow);
  }

  public get(workspaceId: string, hookId: string): HookRecord {
    const row = toHookRow(this.getStmt.get({ workspaceId, hookId }));
    if (!row) {
      throw new ValidationError({ message: `Unknown hook ${hookId}` });
    }
    return mapHookRow(row);
  }

  public create(input: HookCreateInput, now = new Date().toISOString()): HookRecord {
    const hookId = `hook_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    this.insertStmt.run({
      hookId,
      workspaceId: input.workspaceId,
      label: normalizeLabel(input.label),
      trigger: input.trigger,
      mode: input.mode,
      enabled: input.enabled === false ? 0 : 1,
      priority: normalizePriority(input.priority),
      timeoutMs: normalizeTimeoutMs(input.timeoutMs),
      failPolicy: normalizeFailPolicy(input.failPolicy),
      actionJson: JSON.stringify(normalizeAction(input.action)),
      createdAt: now,
      updatedAt: now,
    });
    return this.get(input.workspaceId, hookId);
  }

  public update(
    workspaceId: string,
    hookId: string,
    input: HookUpdateInput,
    now = new Date().toISOString(),
  ): HookRecord {
    const current = this.get(workspaceId, hookId);
    this.updateStmt.run({
      workspaceId,
      hookId,
      label: input.label !== undefined ? normalizeLabel(input.label) : current.label,
      enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled ? 1 : 0,
      priority: input.priority !== undefined ? normalizePriority(input.priority) : current.priority,
      timeoutMs: input.timeoutMs !== undefined ? normalizeTimeoutMs(input.timeoutMs) : current.timeoutMs,
      failPolicy: input.failPolicy !== undefined ? normalizeFailPolicy(input.failPolicy) : current.failPolicy,
      actionJson: JSON.stringify(input.action !== undefined ? normalizeAction(input.action) : current.action),
      updatedAt: now,
    });
    return this.get(workspaceId, hookId);
  }

  public delete(workspaceId: string, hookId: string): boolean {
    const result = this.deleteStmt.run({ workspaceId, hookId });
    return Number(result.changes ?? 0) > 0;
  }
}

function mapHookRow(row: HookRow): HookRecord {
  const action = parseHookAction(row.action_json);
  if (!action) {
    throw new ValidationError({ message: `Hook ${row.hook_id} has invalid action config` });
  }
  return {
    hookId: row.hook_id,
    workspaceId: row.workspace_id,
    label: row.label,
    trigger: row.trigger,
    phase: deriveHookPhase(row.trigger),
    mode: row.mode,
    enabled: row.enabled === 1,
    priority: row.priority,
    timeoutMs: row.timeout_ms,
    failPolicy: row.fail_policy,
    action,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseHookAction(raw: string): HookActionConfig | undefined {
  const action = safeJsonParse<unknown>(raw, undefined);
  if (!isRecord(action) || action.type !== "webhook" || !isRecord(action.webhook)) {
    return undefined;
  }

  const url = action.webhook.url;
  const secret = action.webhook.secret;
  if (typeof url !== "string" || (secret !== undefined && typeof secret !== "string")) {
    return undefined;
  }

  return {
    type: "webhook",
    webhook: {
      url,
      ...(secret ? { secret } : {}),
    },
  };
}

function normalizeLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "label" });
  }
  return trimmed;
}

function normalizePriority(value?: number): number {
  const normalized = Math.floor(value ?? 100);
  return Math.max(-10_000, Math.min(10_000, normalized));
}

function normalizeTimeoutMs(value?: number): number {
  const normalized = Math.floor(value ?? 5_000);
  return Math.max(250, Math.min(60_000, normalized));
}

function normalizeFailPolicy(value?: HookFailPolicy): HookFailPolicy {
  return value ?? "open";
}

function normalizeAction(value: HookActionConfig): HookActionConfig {
  if (value.type !== "webhook") {
    throw new ValidationError({
      message: `Unsupported hook action type: ${String((value as { type?: unknown }).type)}`,
    });
  }
  const url = value.webhook?.url?.trim();
  if (!url) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "action.webhook.url" });
  }
  const secret = value.webhook.secret?.trim();
  return {
    type: "webhook",
    webhook: {
      url,
      ...(secret ? { secret } : {}),
    },
  };
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 200;
  }
  return Math.max(1, Math.min(1_000, Math.floor(value)));
}

function toHookRow(value: unknown): HookRow | undefined {
  return isHookRow(value) ? value : undefined;
}

function toHookRows(value: unknown): HookRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isHookRow);
}

function isHookRow(value: unknown): value is HookRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.hook_id === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.label === "string" &&
    typeof value.trigger === "string" &&
    typeof value.mode === "string" &&
    typeof value.enabled === "number" &&
    typeof value.priority === "number" &&
    typeof value.timeout_ms === "number" &&
    typeof value.fail_policy === "string" &&
    typeof value.action_json === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
