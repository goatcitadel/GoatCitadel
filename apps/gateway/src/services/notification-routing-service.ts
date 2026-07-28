import { createHash, randomUUID } from "node:crypto";
import {
  NOTIFICATION_EVENT_TYPES,
  ValidationError,
  type IntegrationConnection,
  type NotificationClientPresenceLease,
  type NotificationDeliveryRecord,
  type NotificationDispatchResult,
  type NotificationEventRecord,
  type NotificationRule,
  type NotificationRuleInput,
  type NotificationTarget,
  type NotificationTargetInput,
  type NotifyRequest,
} from "@goatcitadel/contracts";
import type { NotificationRoutingRepository } from "@goatcitadel/storage";

const MAX_PRESENCE_LEASE_MS = 90_000;
const MAX_LABEL_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 4_000;
const SECRET_REF_PREFIX = "keychain:goatcitadel:";

export interface NotificationDeliveryAdapterResult {
  status: "pending" | "delivered" | "failed" | "unknown_after_send";
  attemptCount?: number;
  lastError?: string;
  externalSideEffectRunId?: string;
}

export interface NotificationRoutingServiceDependencies {
  repository: NotificationRoutingRepository;
  normalizeWorkspaceId(workspaceId?: string): string;
  getIntegrationConnection(connectionId: string): IntegrationConnection;
  deliver(
    target: NotificationTarget,
    event: NotificationEventRecord,
    idempotencyKey: string,
  ): Promise<NotificationDeliveryAdapterResult>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: { eventClass?: "domain_fact" | "operational_signal" | "ui_notification" },
  ): void;
  now?: () => Date;
  randomId?: () => string;
}

export class NotificationRoutingService {
  private readonly now: () => Date;
  private readonly randomId: () => string;

  public constructor(private readonly deps: NotificationRoutingServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.randomId = deps.randomId ?? randomUUID;
  }

  public listTargets(workspaceId?: string, includeArchived = false): NotificationTarget[] {
    return this.deps.repository.listTargets(this.workspace(workspaceId), includeArchived);
  }

  public createTarget(workspaceId: string | undefined, input: NotificationTargetInput): NotificationTarget {
    const normalizedWorkspaceId = this.workspace(workspaceId);
    const validated = this.validateTarget(normalizedWorkspaceId, input);
    return this.deps.repository.createTarget(this.randomId(), normalizedWorkspaceId, validated, this.isoNow());
  }

  public updateTarget(
    workspaceId: string | undefined,
    targetId: string,
    expectedRevision: number,
    input: NotificationTargetInput,
  ): NotificationTarget {
    const normalizedWorkspaceId = this.workspace(workspaceId);
    this.assertTargetWorkspace(targetId, normalizedWorkspaceId);
    const validated = this.validateTarget(normalizedWorkspaceId, input);
    return this.deps.repository.updateTarget(targetId, expectedRevision, validated, this.isoNow());
  }

  public listRules(workspaceId?: string, includeArchived = false): NotificationRule[] {
    return this.deps.repository.listRules(this.workspace(workspaceId), includeArchived);
  }

  public createRule(workspaceId: string | undefined, input: NotificationRuleInput): NotificationRule {
    const normalizedWorkspaceId = this.workspace(workspaceId);
    const validated = this.validateRule(normalizedWorkspaceId, input);
    return this.deps.repository.createRule(this.randomId(), normalizedWorkspaceId, validated, this.isoNow());
  }

  public updateRule(
    workspaceId: string | undefined,
    ruleId: string,
    expectedRevision: number,
    input: NotificationRuleInput,
  ): NotificationRule {
    const normalizedWorkspaceId = this.workspace(workspaceId);
    const existing = this.deps.repository.getRule(ruleId);
    assertWorkspace(existing.workspaceId, normalizedWorkspaceId, "notification rule");
    const validated = this.validateRule(normalizedWorkspaceId, input);
    return this.deps.repository.updateRule(ruleId, expectedRevision, validated, this.isoNow());
  }

  public upsertPresence(input: {
    workspaceId?: string;
    leaseId?: string;
    clientId: string;
    sessionId?: string;
    focused: boolean;
    visible: boolean;
    ttlMs?: number;
  }): NotificationClientPresenceLease {
    const now = this.now();
    const ttlMs = Math.max(5_000, Math.min(MAX_PRESENCE_LEASE_MS, input.ttlMs ?? MAX_PRESENCE_LEASE_MS));
    const lease: NotificationClientPresenceLease = {
      leaseId: requireOpaqueId(input.leaseId ?? this.randomId(), "leaseId"),
      workspaceId: this.workspace(input.workspaceId),
      clientId: requireOpaqueId(input.clientId, "clientId"),
      ...(input.sessionId ? { sessionId: requireOpaqueId(input.sessionId, "sessionId") } : {}),
      focused: input.focused,
      visible: input.visible,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    return this.deps.repository.upsertPresence(lease);
  }

  public listDeliveries(workspaceId?: string, limit?: number): NotificationDeliveryRecord[] {
    return this.deps.repository.listDeliveries(this.workspace(workspaceId), limit);
  }

  public async sendTest(workspaceId: string | undefined, targetId: string): Promise<NotificationDispatchResult> {
    const normalizedWorkspaceId = this.workspace(workspaceId);
    const target = this.assertTargetWorkspace(targetId, normalizedWorkspaceId);
    if (target.lifecycleState !== "active") {
      throw validationError("Target must be active before a test can be sent.", "targetId");
    }
    const event = this.recordEvent(normalizedWorkspaceId, {
      eventType: "durable.attention_required",
      title: "Test notification",
      message: "GoatCitadel notification routing is connected.",
      source: "operator_test",
    });
    const delivery = await this.deliverForRule(event, target, "operator_test");
    return buildDispatchResult(event, [delivery]);
  }

  public async request(workspaceId: string | undefined, input: NotifyRequest): Promise<NotificationDispatchResult> {
    if (input.targetIds?.length) {
      throw validationError(
        "Notification requests cannot select external targets; operator-authored rules own external routing.",
        "targetIds",
      );
    }
    return this.dispatch(workspaceId, { ...input, source: "notify.request" });
  }

  public async dispatch(
    workspaceId: string | undefined,
    input: Omit<NotifyRequest, "targetIds"> & { source: string; eventId?: string; ruleId?: string },
  ): Promise<NotificationDispatchResult> {
    const normalizedWorkspaceId = this.workspace(workspaceId);
    validateEvent(input);
    const event = this.recordEvent(normalizedWorkspaceId, input);

    this.deps.publishRealtime("notification_event", "notifications", { ...event }, { eventClass: "ui_notification" });

    const deliveries: NotificationDeliveryRecord[] = [];
    const rules = this.deps.repository
      .listRules(normalizedWorkspaceId)
      .filter(
        (rule) =>
          rule.lifecycleState === "active" &&
          rule.eventTypes.includes(event.eventType) &&
          (!input.ruleId || rule.ruleId === input.ruleId),
      );
    const isPresent = this.deps.repository.hasActivePresence(normalizedWorkspaceId, this.isoNow());

    for (const rule of rules) {
      for (const targetId of rule.targetIds) {
        const target = this.assertTargetWorkspace(targetId, normalizedWorkspaceId);
        if (target.lifecycleState !== "active") continue;
        if (rule.deliveryPolicy === "when_away" && isPresent) {
          deliveries.push(this.recordSuppressedDelivery(event, rule.ruleId, target.targetId));
          continue;
        }
        deliveries.push(await this.deliverForRule(event, target, rule.ruleId));
      }
    }

    return buildDispatchResult(event, deliveries);
  }

  private async deliverForRule(
    event: NotificationEventRecord,
    target: NotificationTarget,
    ruleId: string,
  ): Promise<NotificationDeliveryRecord> {
    const idempotencyKey = `notification:${event.eventId}:${ruleId}:${target.targetId}`;
    const now = this.isoNow();
    const delivery = this.deps.repository.createDelivery({
      deliveryId: this.randomId(),
      eventId: event.eventId,
      ruleId,
      targetId: target.targetId,
      workspaceId: event.workspaceId,
      idempotencyKey,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    if (delivery.attemptCount > 0 || delivery.status !== "pending") return delivery;

    try {
      const outcome = await this.deps.deliver(target, event, idempotencyKey);
      const updated = this.deps.repository.patchDelivery(delivery.deliveryId, {
        status: outcome.status,
        attemptCount: outcome.attemptCount ?? 1,
        updatedAt: this.isoNow(),
        ...(outcome.lastError ? { lastError: sanitizeFailure(outcome.lastError) } : {}),
        ...(outcome.externalSideEffectRunId ? { externalSideEffectRunId: outcome.externalSideEffectRunId } : {}),
      });
      this.publishDelivery(updated);
      return updated;
    } catch (error) {
      const updated = this.deps.repository.patchDelivery(delivery.deliveryId, {
        status: "failed",
        attemptCount: 1,
        lastError: sanitizeFailure(error instanceof Error ? error.message : "Notification delivery failed."),
        updatedAt: this.isoNow(),
      });
      this.publishDelivery(updated);
      return updated;
    }
  }

  private recordSuppressedDelivery(
    event: NotificationEventRecord,
    ruleId: string,
    targetId: string,
  ): NotificationDeliveryRecord {
    const now = this.isoNow();
    return this.deps.repository.createDelivery({
      deliveryId: this.randomId(),
      eventId: event.eventId,
      ruleId,
      targetId,
      workspaceId: event.workspaceId,
      idempotencyKey: `notification:${event.eventId}:${ruleId}:${targetId}`,
      status: "suppressed_present",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private recordEvent(
    workspaceId: string,
    input: Omit<NotifyRequest, "targetIds"> & { source: string; eventId?: string },
  ): NotificationEventRecord {
    const event: NotificationEventRecord = {
      eventId: input.eventId ?? this.randomId(),
      workspaceId,
      eventType: input.eventType,
      ...(input.sessionId ? { sessionId: requireOpaqueId(input.sessionId, "sessionId") } : {}),
      ...(input.turnId ? { turnId: requireOpaqueId(input.turnId, "turnId") } : {}),
      title: input.title.trim(),
      message: input.message.trim(),
      source: requireOpaqueId(input.source, "source"),
      createdAt: this.isoNow(),
    };
    return this.deps.repository.createEvent(event);
  }

  private validateTarget(workspaceId: string, input: NotificationTargetInput): NotificationTargetInput {
    const label = requireBoundedText(input.label, "label", MAX_LABEL_LENGTH);
    if (input.kind === "channel_connection") {
      const connectionId = requireOpaqueId(input.channelConnectionId, "channelConnectionId");
      const connection = this.deps.getIntegrationConnection(connectionId);
      if (connection.kind !== "channel" || connection.enabled !== true) {
        throw validationError(
          "Notification target must reference an enabled channel connection.",
          "channelConnectionId",
        );
      }
      if (connection.workspaceId && connection.workspaceId !== workspaceId) {
        throw validationError("Notification channel connection belongs to another workspace.", "channelConnectionId");
      }
      return {
        label,
        kind: input.kind,
        channelConnectionId: connectionId,
        lifecycleState: input.lifecycleState ?? "active",
      };
    }
    if (input.kind !== "https_webhook") {
      throw validationError("Unsupported notification target kind.", "kind");
    }
    return {
      label,
      kind: input.kind,
      webhookUrlSecretRef: validateSecretRef(input.webhookUrlSecretRef, "webhookUrlSecretRef"),
      ...(input.credentialSecretRef
        ? { credentialSecretRef: validateSecretRef(input.credentialSecretRef, "credentialSecretRef") }
        : {}),
      lifecycleState: input.lifecycleState ?? "active",
    };
  }

  private validateRule(workspaceId: string, input: NotificationRuleInput): NotificationRuleInput {
    const eventTypes = [...new Set(input.eventTypes)];
    if (!eventTypes.length || eventTypes.some((eventType) => !NOTIFICATION_EVENT_TYPES.includes(eventType))) {
      throw validationError("Notification rule must contain supported event types.", "eventTypes");
    }
    const targetIds = [...new Set(input.targetIds.map((targetId) => requireOpaqueId(targetId, "targetIds")))];
    if (!targetIds.length) throw validationError("Notification rule must contain at least one target.", "targetIds");
    for (const targetId of targetIds) this.assertTargetWorkspace(targetId, workspaceId);
    return {
      label: requireBoundedText(input.label, "label", MAX_LABEL_LENGTH),
      eventTypes,
      targetIds,
      deliveryPolicy: input.deliveryPolicy ?? "always",
      lifecycleState: input.lifecycleState ?? "active",
    };
  }

  private assertTargetWorkspace(targetId: string, workspaceId: string): NotificationTarget {
    const target = this.deps.repository.getTarget(requireOpaqueId(targetId, "targetId"));
    assertWorkspace(target.workspaceId, workspaceId, "notification target");
    return target;
  }

  private publishDelivery(delivery: NotificationDeliveryRecord): void {
    this.deps.publishRealtime("notification_delivery", "notifications", {
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      targetId: delivery.targetId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      updatedAt: delivery.updatedAt,
    });
  }

  private workspace(workspaceId?: string): string {
    return this.deps.normalizeWorkspaceId(workspaceId);
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export function notificationDestinationFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function accountFromNotificationSecretRef(secretRef: string): string {
  const normalized = secretRef.trim();
  if (!normalized.startsWith(SECRET_REF_PREFIX)) {
    throw validationError("Notification secret references must use the GoatCitadel keychain.", "secretRef");
  }
  const account = normalized.slice(SECRET_REF_PREFIX.length).trim();
  if (!account || account.includes("..") || /[\s\\/]/u.test(account)) {
    throw validationError("Notification secret reference is invalid.", "secretRef");
  }
  return account;
}

export function parseAllowedNotificationWebhookUrl(value: string, isAllowlisted: (url: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Webhook destination secret does not contain a valid URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isUnsafeWebhookHostname(url.hostname) ||
    !isAllowlisted(url.toString())
  ) {
    throw new Error("Webhook destination is not an allowlisted public HTTPS URL.");
  }
  return url;
}

function validateSecretRef(secretRef: string | undefined, field: string): string {
  if (!secretRef) throw validationError(`${field} is required.`, field);
  accountFromNotificationSecretRef(secretRef);
  return secretRef.trim();
}

function isUnsafeWebhookHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  if (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function validateEvent(input: Omit<NotifyRequest, "targetIds">): void {
  if (!NOTIFICATION_EVENT_TYPES.includes(input.eventType)) {
    throw validationError("Unsupported notification event type.", "eventType");
  }
  requireBoundedText(input.title, "title", MAX_LABEL_LENGTH);
  requireBoundedText(input.message, "message", MAX_MESSAGE_LENGTH);
}

function requireOpaqueId(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9_.:@-]+$/u.test(normalized)) {
    throw validationError(`${field} is invalid.`, field);
  }
  return normalized;
}

function requireBoundedText(value: string, field: string, maxLength: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > maxLength) {
    throw validationError(`${field} must contain between 1 and ${maxLength} characters.`, field);
  }
  return normalized;
}

function assertWorkspace(actual: string, expected: string, kind: string): void {
  if (actual !== expected) throw validationError(`${kind} belongs to another workspace.`, "workspaceId");
}

function sanitizeFailure(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/giu, "[redacted destination]")
    .replace(/(authorization|token|secret|password)\s*[:=]\s*\S+/giu, "$1=[redacted]")
    .slice(0, 500);
}

function validationError(message: string, field: string): ValidationError {
  return new ValidationError({ message, field });
}

function buildDispatchResult(
  event: NotificationEventRecord,
  deliveries: NotificationDeliveryRecord[],
): NotificationDispatchResult {
  if (!deliveries.length) return { event, deliveries, status: "no_targets" };
  const statuses = new Set(deliveries.map((delivery) => delivery.status));
  if (statuses.size === 1) return { event, deliveries, status: deliveries[0]!.status };
  if (statuses.has("unknown_after_send")) return { event, deliveries, status: "unknown_after_send" };
  if (statuses.has("failed") && statuses.has("delivered")) return { event, deliveries, status: "partially_delivered" };
  if (statuses.has("failed")) return { event, deliveries, status: "failed" };
  if (statuses.has("pending")) return { event, deliveries, status: "pending" };
  return { event, deliveries, status: "partially_delivered" };
}
