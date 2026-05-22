import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { MOBILE_NATIVE_CAPABILITY_IDS, type MobileNativeCapabilityId } from "@goatcitadel/contracts";
import { z } from "zod";
import type { MobileRouteActorContext } from "../services/mobile-route-service.js";
import { withRouteAccess } from "./route-access.js";

const MOBILE_CAPABILITY_ID_VALUES = [...MOBILE_NATIVE_CAPABILITY_IDS] as [
  MobileNativeCapabilityId,
  ...MobileNativeCapabilityId[],
];

const capabilityIdSchema = z.enum(MOBILE_CAPABILITY_ID_VALUES);
const platformSchema = z.enum(["android", "ios", "web", "unknown"]);

const capabilityProvenanceSchema = z.object({
  platform: platformSchema,
  appVersion: z.string().trim().min(1).optional(),
  deviceId: z.string().trim().min(1).optional(),
  grantId: z.string().trim().min(1).optional(),
  companionSessionId: z.string().trim().min(1).optional(),
  source: z.enum(["mobile_app", "native_module", "gateway"]),
  sessionId: z.string().trim().min(1).optional(),
});

const mobileCapabilitySchema = z.object({
  capabilityId: capabilityIdSchema,
  label: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  state: z.enum(["unavailable", "available", "needs_consent", "enabled", "blocked"]),
  permissionState: z.enum([
    "unknown",
    "not_required",
    "promptable",
    "granted",
    "denied",
    "blocked",
    "special_access_required",
  ]),
  sensitivity: z.enum(["low", "moderate", "high"]),
  collectionMode: z.enum(["user_initiated", "foreground", "background_opt_in", "special_access"]),
  implementationStatus: z.enum(["ready", "scaffolded", "deferred"]),
  consentRequired: z.boolean(),
  consentGranted: z.boolean(),
  backgroundCapable: z.boolean(),
  lastSeenAt: z.string().datetime().optional(),
  lastUsedAt: z.string().datetime().optional(),
  blockedReason: z.string().trim().min(1).optional(),
  provenance: capabilityProvenanceSchema,
});

const mobileContextSchema = z.object({
  contextId: z.string().trim().min(1).optional(),
  capabilityId: capabilityIdSchema,
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  sensitivity: z.enum(["low", "moderate", "high"]),
  summary: z.string().trim().min(1),
  structuredFields: z.record(z.string(), z.string()),
  attachmentIds: z.array(z.string().trim().min(1)).optional(),
  userVisibleReason: z.string().trim().min(1),
  provenance: capabilityProvenanceSchema.partial().optional(),
});

const heartbeatSchema = z.object({
  observedAt: z.string().datetime(),
  appVersion: z.string().trim().min(1).optional(),
  platform: platformSchema.optional(),
  capabilities: z.array(mobileCapabilitySchema).max(32),
});

const contextAuditSchema = z.object({
  contexts: z.array(mobileContextSchema).min(1).max(12),
});

const pushRegistrationSchema = z.object({
  provider: z.enum(["expo", "fcm", "local_only"]),
  enabled: z.boolean(),
  tokenHash: z.string().trim().min(1).optional(),
  tokenPreview: z.string().trim().min(1).max(32).optional(),
  deviceLabel: z.string().trim().min(1).optional(),
  appVersion: z.string().trim().min(1).optional(),
});

const revocationSchema = z.object({
  reason: z.enum(["panic_off", "device_revoked", "user_disabled", "session_expired"]),
  capabilityIds: z.array(capabilityIdSchema).optional(),
  revokedAt: z.string().datetime().optional(),
});

const mobileAuditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  capabilityId: capabilityIdSchema.optional(),
});

export const mobileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/mobile/capabilities", withRouteAccess(fastify, "operator"), async (_request, reply) => {
    return reply.send(await fastify.services.mobile.listMobileCapabilities({}));
  });

  fastify.get("/api/v1/mobile/audit", withRouteAccess(fastify, "operator"), async (request, reply) => {
    const query = mobileAuditQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return reply.send(await fastify.services.mobile.listMobileAudit(query.data));
  });

  fastify.put(
    "/api/v1/mobile/current-device/capabilities",
    withRouteAccess(fastify, "companion"),
    async (request, reply) => {
      const body = heartbeatSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }
      return reply.send(
        await fastify.services.mobile.recordMobileCapabilityHeartbeat(body.data, actorContext(request)),
      );
    },
  );

  fastify.post("/api/v1/mobile/context/audit", withRouteAccess(fastify, "companion"), async (request, reply) => {
    const body = contextAuditSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    return reply
      .code(201)
      .send(await fastify.services.mobile.recordMobileContextAudit(body.data, actorContext(request)));
  });

  fastify.put("/api/v1/mobile/current-device/push", withRouteAccess(fastify, "companion"), async (request, reply) => {
    const body = pushRegistrationSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    return reply.send(await fastify.services.mobile.registerMobilePush(body.data, actorContext(request)));
  });

  fastify.post(
    "/api/v1/mobile/current-device/revoke",
    withRouteAccess(fastify, "companion"),
    async (request, reply) => {
      const body = revocationSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }
      return reply.send(await fastify.services.mobile.revokeMobileCapabilities(body.data, actorContext(request)));
    },
  );
};

function actorContext(request: FastifyRequest): MobileRouteActorContext {
  return {
    actorId: request.authActorId,
    authActorSource: request.authActorSource,
    deviceId: request.authDeviceId,
    grantId: request.authGrantId,
    companionSessionId: request.authCompanionSessionId,
  };
}
