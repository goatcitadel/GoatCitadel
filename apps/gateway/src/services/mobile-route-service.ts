import { randomUUID } from "node:crypto";
import type {
  MobileAuditListResponse,
  MobileCapabilityHeartbeatRequest,
  MobileCapabilityListResponse,
  MobileContextAuditRequest,
  MobileContextAuditResponse,
  MobileContextEnvelope,
  MobileNativeCapabilityId,
  MobileNativeCapabilityRecord,
  MobilePushRegistrationRequest,
  MobilePushRegistrationResponse,
  MobileRevocationRequest,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const mobileRouteMethods = [
  "listMobileCapabilities",
  "listMobileAudit",
  "recordMobileCapabilityHeartbeat",
  "recordMobileContextAudit",
  "registerMobilePush",
  "revokeMobileCapabilities",
] as const;

export type MobileRouteMethod = (typeof mobileRouteMethods)[number];
export type MobileRoutePort = RoutePort<MobileRouteMethod>;
export type MobileRouteService = RouteService<MobileRouteMethod>;

export interface MobileRouteActorContext {
  actorId?: string;
  authActorSource?: string;
  deviceId?: string;
  grantId?: string;
  companionSessionId?: string;
}

export interface MobileRoutePortDependencies {
  storage: Pick<Storage, "audit">;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
}

interface MobileAuditListInput {
  limit?: number;
  capabilityId?: MobileNativeCapabilityId;
}

const MAX_AUDIT_ITEMS = 200;
const MAX_CONTEXTS_PER_REQUEST = 12;
const SENSITIVE_STRUCTURED_FIELD_KEY_PATTERN =
  /(?:lat|latitude|lon|lng|longitude|coord|coordinate|token|secret|path|uri|url|body|text|content|message|phone|number)/i;
const SAFE_STRUCTURED_FIELD_KEYS = new Set([
  "accuracyMeters",
  "approxLatitude",
  "approxLongitude",
  "attachmentCount",
  "collectionMode",
  "notificationApp",
  "notificationCategory",
  "permissionState",
  "place",
  "source",
  "timezone",
  "trigger",
  "zoneLabel",
]);

export function createMobileRoutePort(deps: MobileRoutePortDependencies): MobileRoutePort {
  return {
    listMobileCapabilities: async (_input?: { limit?: number }): Promise<MobileCapabilityListResponse> => {
      const records = await deps.storage.audit.list("approvals");
      const latest = new Map<MobileNativeCapabilityId, MobileNativeCapabilityRecord>();
      for (const record of records) {
        if (record.eventType !== "mobile.capability_heartbeat") {
          continue;
        }
        const capabilities = Array.isArray(record.capabilities) ? record.capabilities : [];
        for (const item of capabilities) {
          if (!isMobileCapabilityRecord(item)) {
            continue;
          }
          latest.set(item.capabilityId, item);
        }
      }
      return { items: [...latest.values()].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)) };
    },
    listMobileAudit: async (input?: MobileAuditListInput): Promise<MobileAuditListResponse> => {
      const limit = Math.max(1, Math.min(input?.limit ?? 100, MAX_AUDIT_ITEMS));
      const records = await deps.storage.audit.list("approvals");
      const items = records
        .filter((record) => typeof record.eventType === "string" && record.eventType.startsWith("mobile."))
        .filter((record) => !input?.capabilityId || record.capabilityId === input.capabilityId)
        .slice(-limit)
        .reverse();
      return { items };
    },
    recordMobileCapabilityHeartbeat: async (
      input: MobileCapabilityHeartbeatRequest,
      actor: MobileRouteActorContext,
    ) => {
      const observedAt = normalizeIsoTimestamp(input.observedAt) ?? new Date().toISOString();
      const capabilities = input.capabilities.map((capability) => ({
        ...capability,
        lastSeenAt: capability.lastSeenAt ?? observedAt,
        provenance: {
          ...capability.provenance,
          platform: capability.provenance.platform ?? input.platform ?? "unknown",
          appVersion: capability.provenance.appVersion ?? input.appVersion,
          deviceId: capability.provenance.deviceId ?? actor.deviceId,
          grantId: capability.provenance.grantId ?? actor.grantId,
          companionSessionId: capability.provenance.companionSessionId ?? actor.companionSessionId,
        },
      }));
      await deps.storage.audit.append("approvals", {
        eventType: "mobile.capability_heartbeat",
        observedAt,
        platform: input.platform,
        appVersion: input.appVersion,
        capabilities,
        ...actor,
      });
      deps.publishRealtime("mobile_capability_heartbeat", "mobile", {
        observedAt,
        capabilityCount: capabilities.length,
        capabilityIds: capabilities.map((capability) => capability.capabilityId),
        deviceId: actor.deviceId,
        companionSessionId: actor.companionSessionId,
      });
      return { accepted: capabilities.length, observedAt };
    },
    recordMobileContextAudit: async (
      input: MobileContextAuditRequest,
      actor: MobileRouteActorContext,
    ): Promise<MobileContextAuditResponse> => {
      const contextEventIds: string[] = [];
      for (const context of input.contexts.slice(0, MAX_CONTEXTS_PER_REQUEST)) {
        const contextEventId = randomUUID();
        contextEventIds.push(contextEventId);
        await deps.storage.audit.append("approvals", {
          eventType: "mobile.context_audit",
          contextEventId,
          capabilityId: context.capabilityId,
          context: sanitizeMobileContextForAudit(context),
          ...actor,
        });
      }
      deps.publishRealtime("mobile_context_audit_recorded", "mobile", {
        accepted: contextEventIds.length,
        contextEventIds,
        capabilityIds: input.contexts.map((context) => context.capabilityId),
        deviceId: actor.deviceId,
        companionSessionId: actor.companionSessionId,
      });
      return { accepted: contextEventIds.length, contextEventIds };
    },
    registerMobilePush: async (
      input: MobilePushRegistrationRequest,
      actor: MobileRouteActorContext,
    ): Promise<MobilePushRegistrationResponse> => {
      const registeredAt = new Date().toISOString();
      const registrationId = randomUUID();
      await deps.storage.audit.append("approvals", {
        eventType: "mobile.push_registration",
        registrationId,
        registeredAt,
        provider: input.provider,
        enabled: input.enabled,
        tokenHash: input.tokenHash,
        tokenPreview: input.tokenPreview,
        deviceLabel: input.deviceLabel,
        appVersion: input.appVersion,
        ...actor,
      });
      deps.publishRealtime("mobile_push_registration_updated", "mobile", {
        registrationId,
        enabled: input.enabled,
        provider: input.provider,
        deviceId: actor.deviceId,
        companionSessionId: actor.companionSessionId,
      });
      return { registrationId, registeredAt, enabled: input.enabled };
    },
    revokeMobileCapabilities: async (input: MobileRevocationRequest, actor: MobileRouteActorContext) => {
      const revokedAt = normalizeIsoTimestamp(input.revokedAt) ?? new Date().toISOString();
      await deps.storage.audit.append("approvals", {
        eventType: "mobile.revocation",
        revokedAt,
        reason: input.reason,
        capabilityIds: input.capabilityIds ?? [],
        ...actor,
      });
      deps.publishRealtime("mobile_capabilities_revoked", "mobile", {
        revokedAt,
        reason: input.reason,
        capabilityIds: input.capabilityIds ?? [],
        deviceId: actor.deviceId,
        companionSessionId: actor.companionSessionId,
      });
      return { revokedAt, capabilityIds: input.capabilityIds ?? [] };
    },
  };
}

export function createMobileRouteService(port: MobileRoutePort): MobileRouteService {
  return createRouteService(port, mobileRouteMethods);
}

export function sanitizeMobileContextForAudit(context: MobileContextEnvelope): MobileContextEnvelope {
  return {
    ...context,
    contextId: context.contextId,
    capturedAt: normalizeIsoTimestamp(context.capturedAt) ?? context.capturedAt,
    expiresAt: context.expiresAt ? (normalizeIsoTimestamp(context.expiresAt) ?? context.expiresAt) : undefined,
    summary: truncateText(context.summary, 500),
    userVisibleReason: truncateText(context.userVisibleReason, 300),
    structuredFields: sanitizeStructuredFields(context.structuredFields, context.sensitivity),
    attachmentIds: context.attachmentIds?.map((attachmentId) => truncateText(attachmentId, 120)),
    provenance: context.provenance
      ? {
          platform: context.provenance.platform,
          appVersion: context.provenance.appVersion,
          deviceId: context.provenance.deviceId,
          grantId: context.provenance.grantId,
          companionSessionId: context.provenance.companionSessionId,
          sessionId: context.provenance.sessionId,
          source: context.provenance.source,
        }
      : undefined,
  };
}

function sanitizeStructuredFields(
  fields: Record<string, string>,
  sensitivity: MobileContextEnvelope["sensitivity"],
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SAFE_STRUCTURED_FIELD_KEYS.has(key)) {
      output[key] = truncateText(value, 160);
      continue;
    }
    if (SENSITIVE_STRUCTURED_FIELD_KEY_PATTERN.test(key) || sensitivity === "high") {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = truncateText(value, 160);
  }
  return output;
}

function isMobileCapabilityRecord(value: unknown): value is MobileNativeCapabilityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<MobileNativeCapabilityRecord>;
  return typeof record.capabilityId === "string" && typeof record.label === "string";
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
