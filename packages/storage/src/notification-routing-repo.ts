import {
  ConflictError,
  NotFoundError,
  type NotificationClientPresenceLease,
  type NotificationDeliveryRecord,
  type NotificationEventRecord,
  type NotificationRule,
  type NotificationRuleInput,
  type NotificationTarget,
  type NotificationTargetInput,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export class NotificationRoutingRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public listTargets(workspaceId: string, includeArchived = false): NotificationTarget[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM notification_targets WHERE workspace_id = ? ${includeArchived ? "" : "AND lifecycle_state <> 'archived'"} ORDER BY label, target_id`,
        )
        .all(workspaceId) as TargetRow[]
    ).map(mapTarget);
  }

  public getTarget(targetId: string): NotificationTarget {
    const row = this.db.prepare("SELECT * FROM notification_targets WHERE target_id = ?").get(targetId) as
      | TargetRow
      | undefined;
    if (!row) throw new NotFoundError({ entity: "Notification target", id: targetId });
    return mapTarget(row);
  }

  public createTarget(
    targetId: string,
    workspaceId: string,
    input: NotificationTargetInput,
    now = new Date().toISOString(),
  ): NotificationTarget {
    this.db
      .prepare(
        `INSERT INTO notification_targets (target_id, workspace_id, revision, label, kind, channel_connection_id, webhook_url_secret_ref, credential_secret_ref, lifecycle_state, created_at, updated_at) VALUES (@targetId, @workspaceId, 1, @label, @kind, @channelConnectionId, @webhookUrlSecretRef, @credentialSecretRef, @lifecycleState, @now, @now)`,
      )
      .run({
        targetId,
        workspaceId,
        label: input.label,
        kind: input.kind,
        channelConnectionId: input.channelConnectionId ?? null,
        webhookUrlSecretRef: input.webhookUrlSecretRef ?? null,
        credentialSecretRef: input.credentialSecretRef ?? null,
        lifecycleState: input.lifecycleState ?? "active",
        now,
      });
    return this.getTarget(targetId);
  }

  public updateTarget(
    targetId: string,
    expectedRevision: number,
    input: NotificationTargetInput,
    now = new Date().toISOString(),
  ): NotificationTarget {
    const result = this.db
      .prepare(
        `UPDATE notification_targets SET revision = revision + 1, label = @label, kind = @kind, channel_connection_id = @channelConnectionId, webhook_url_secret_ref = @webhookUrlSecretRef, credential_secret_ref = @credentialSecretRef, lifecycle_state = @lifecycleState, updated_at = @now WHERE target_id = @targetId AND revision = @expectedRevision`,
      )
      .run({
        targetId,
        expectedRevision,
        label: input.label,
        kind: input.kind,
        channelConnectionId: input.channelConnectionId ?? null,
        webhookUrlSecretRef: input.webhookUrlSecretRef ?? null,
        credentialSecretRef: input.credentialSecretRef ?? null,
        lifecycleState: input.lifecycleState ?? "active",
        now,
      });
    if (Number(result.changes ?? 0) !== 1)
      throw revisionConflict("Notification target", targetId, expectedRevision, this.getTarget(targetId).revision);
    return this.getTarget(targetId);
  }

  public listRules(workspaceId: string, includeArchived = false): NotificationRule[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM notification_rules WHERE workspace_id = ? ${includeArchived ? "" : "AND lifecycle_state <> 'archived'"} ORDER BY label, rule_id`,
        )
        .all(workspaceId) as RuleRow[]
    ).map(mapRule);
  }

  public getRule(ruleId: string): NotificationRule {
    const row = this.db.prepare("SELECT * FROM notification_rules WHERE rule_id = ?").get(ruleId) as
      | RuleRow
      | undefined;
    if (!row) throw new NotFoundError({ entity: "Notification rule", id: ruleId });
    return mapRule(row);
  }

  public createRule(
    ruleId: string,
    workspaceId: string,
    input: NotificationRuleInput,
    now = new Date().toISOString(),
  ): NotificationRule {
    this.db
      .prepare(
        `INSERT INTO notification_rules (rule_id, workspace_id, revision, label, event_types_json, target_ids_json, delivery_policy, lifecycle_state, created_at, updated_at) VALUES (@ruleId, @workspaceId, 1, @label, @eventTypesJson, @targetIdsJson, @deliveryPolicy, @lifecycleState, @now, @now)`,
      )
      .run({
        ruleId,
        workspaceId,
        label: input.label,
        eventTypesJson: JSON.stringify(input.eventTypes),
        targetIdsJson: JSON.stringify(input.targetIds),
        deliveryPolicy: input.deliveryPolicy ?? "always",
        lifecycleState: input.lifecycleState ?? "active",
        now,
      });
    return this.getRule(ruleId);
  }

  public updateRule(
    ruleId: string,
    expectedRevision: number,
    input: NotificationRuleInput,
    now = new Date().toISOString(),
  ): NotificationRule {
    const result = this.db
      .prepare(
        `UPDATE notification_rules SET revision = revision + 1, label = @label, event_types_json = @eventTypesJson, target_ids_json = @targetIdsJson, delivery_policy = @deliveryPolicy, lifecycle_state = @lifecycleState, updated_at = @now WHERE rule_id = @ruleId AND revision = @expectedRevision`,
      )
      .run({
        ruleId,
        expectedRevision,
        label: input.label,
        eventTypesJson: JSON.stringify(input.eventTypes),
        targetIdsJson: JSON.stringify(input.targetIds),
        deliveryPolicy: input.deliveryPolicy ?? "always",
        lifecycleState: input.lifecycleState ?? "active",
        now,
      });
    if (Number(result.changes ?? 0) !== 1)
      throw revisionConflict("Notification rule", ruleId, expectedRevision, this.getRule(ruleId).revision);
    return this.getRule(ruleId);
  }

  public upsertPresence(input: NotificationClientPresenceLease): NotificationClientPresenceLease {
    this.db
      .prepare(
        `INSERT INTO notification_presence_leases (lease_id, workspace_id, client_id, session_id, focused, visible, expires_at, updated_at) VALUES (@leaseId, @workspaceId, @clientId, @sessionId, @focused, @visible, @expiresAt, @updatedAt) ON CONFLICT(lease_id) DO UPDATE SET workspace_id = excluded.workspace_id, client_id = excluded.client_id, session_id = excluded.session_id, focused = excluded.focused, visible = excluded.visible, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run({
        ...input,
        sessionId: input.sessionId ?? null,
        focused: input.focused ? 1 : 0,
        visible: input.visible ? 1 : 0,
      });
    return input;
  }

  public hasActivePresence(workspaceId: string, now = new Date().toISOString()): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM notification_presence_leases WHERE workspace_id = ? AND focused = 1 AND visible = 1 AND expires_at > ? LIMIT 1",
      )
      .get(workspaceId, now) as { present: number } | undefined;
    return row?.present === 1;
  }

  public createEvent(event: NotificationEventRecord): NotificationEventRecord {
    this.db
      .prepare(
        `INSERT INTO notification_events (event_id, workspace_id, event_type, session_id, turn_id, title, message, source, created_at) VALUES (@eventId, @workspaceId, @eventType, @sessionId, @turnId, @title, @message, @source, @createdAt) ON CONFLICT(event_id) DO NOTHING`,
      )
      .run({ ...event, sessionId: event.sessionId ?? null, turnId: event.turnId ?? null });
    return this.getEvent(event.eventId);
  }

  public getEvent(eventId: string): NotificationEventRecord {
    const row = this.db.prepare("SELECT * FROM notification_events WHERE event_id = ?").get(eventId) as
      | EventRow
      | undefined;
    if (!row) throw new NotFoundError({ entity: "Notification event", id: eventId });
    return mapEvent(row);
  }

  public createDelivery(input: NotificationDeliveryRecord): NotificationDeliveryRecord {
    this.db
      .prepare(
        `INSERT INTO notification_deliveries (delivery_id, event_id, rule_id, target_id, workspace_id, idempotency_key, status, attempt_count, last_error, external_side_effect_run_id, created_at, updated_at) VALUES (@deliveryId, @eventId, @ruleId, @targetId, @workspaceId, @idempotencyKey, @status, @attemptCount, @lastError, @externalSideEffectRunId, @createdAt, @updatedAt) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run({
        ...input,
        lastError: input.lastError ?? null,
        externalSideEffectRunId: input.externalSideEffectRunId ?? null,
      });
    return this.getDeliveryByIdempotencyKey(input.idempotencyKey);
  }

  public patchDelivery(
    deliveryId: string,
    patch: Pick<NotificationDeliveryRecord, "status" | "attemptCount" | "updatedAt"> & {
      lastError?: string;
      externalSideEffectRunId?: string;
    },
  ): NotificationDeliveryRecord {
    this.db
      .prepare(
        `UPDATE notification_deliveries SET status = @status, attempt_count = @attemptCount, last_error = @lastError, external_side_effect_run_id = @externalSideEffectRunId, updated_at = @updatedAt WHERE delivery_id = @deliveryId`,
      )
      .run({
        deliveryId,
        ...patch,
        lastError: patch.lastError ?? null,
        externalSideEffectRunId: patch.externalSideEffectRunId ?? null,
      });
    return this.getDelivery(deliveryId);
  }

  public getDelivery(deliveryId: string): NotificationDeliveryRecord {
    const row = this.db.prepare("SELECT * FROM notification_deliveries WHERE delivery_id = ?").get(deliveryId) as
      | DeliveryRow
      | undefined;
    if (!row) throw new NotFoundError({ entity: "Notification delivery", id: deliveryId });
    return mapDelivery(row);
  }

  public getDeliveryByIdempotencyKey(key: string): NotificationDeliveryRecord {
    const row = this.db.prepare("SELECT * FROM notification_deliveries WHERE idempotency_key = ?").get(key) as
      | DeliveryRow
      | undefined;
    if (!row) throw new NotFoundError({ entity: "Notification delivery", id: key });
    return mapDelivery(row);
  }

  public listDeliveries(workspaceId: string, limit = 100): NotificationDeliveryRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM notification_deliveries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(workspaceId, Math.max(1, Math.min(500, limit))) as DeliveryRow[]
    ).map(mapDelivery);
  }
}

interface TargetRow {
  target_id: string;
  workspace_id: string;
  revision: number;
  label: string;
  kind: NotificationTarget["kind"];
  channel_connection_id: string | null;
  webhook_url_secret_ref: string | null;
  credential_secret_ref: string | null;
  lifecycle_state: NotificationTarget["lifecycleState"];
  created_at: string;
  updated_at: string;
}
interface RuleRow {
  rule_id: string;
  workspace_id: string;
  revision: number;
  label: string;
  event_types_json: string;
  target_ids_json: string;
  delivery_policy: NotificationRule["deliveryPolicy"];
  lifecycle_state: NotificationRule["lifecycleState"];
  created_at: string;
  updated_at: string;
}
interface DeliveryRow {
  delivery_id: string;
  event_id: string;
  rule_id: string;
  target_id: string;
  workspace_id: string;
  idempotency_key: string;
  status: NotificationDeliveryRecord["status"];
  attempt_count: number;
  last_error: string | null;
  external_side_effect_run_id: string | null;
  created_at: string;
  updated_at: string;
}
interface EventRow {
  event_id: string;
  workspace_id: string;
  event_type: NotificationEventRecord["eventType"];
  session_id: string | null;
  turn_id: string | null;
  title: string;
  message: string;
  source: string;
  created_at: string;
}

function mapTarget(row: TargetRow): NotificationTarget {
  return {
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    label: row.label,
    kind: row.kind,
    channelConnectionId: row.channel_connection_id ?? undefined,
    webhookUrlSecretRef: row.webhook_url_secret_ref ?? undefined,
    credentialSecretRef: row.credential_secret_ref ?? undefined,
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapRule(row: RuleRow): NotificationRule {
  return {
    ruleId: row.rule_id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    label: row.label,
    eventTypes: parseStringArray(row.event_types_json) as NotificationRule["eventTypes"],
    targetIds: parseStringArray(row.target_ids_json),
    deliveryPolicy: row.delivery_policy,
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapDelivery(row: DeliveryRow): NotificationDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    ruleId: row.rule_id,
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? undefined,
    externalSideEffectRunId: row.external_side_effect_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapEvent(row: EventRow): NotificationEventRecord {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    title: row.title,
    message: row.message,
    source: row.source,
    createdAt: row.created_at,
  };
}
function revisionConflict(kind: string, id: string, expectedRevision: number, actualRevision: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `${kind} ${id} revision changed.`,
    details: {
      resourceKind: kind.toLowerCase().replaceAll(" ", "_"),
      resourceId: id,
      expectedRevision,
      actualRevision,
    },
  });
}
function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
