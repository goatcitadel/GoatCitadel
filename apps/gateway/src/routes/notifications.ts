import type { FastifyPluginAsync } from "fastify";
import { NOTIFICATION_EVENT_TYPES } from "@goatcitadel/contracts";
import { z } from "zod";

const workspaceQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const targetInputSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    kind: z.enum(["channel_connection", "https_webhook"]),
    channelConnectionId: z.string().trim().min(1).optional(),
    webhookUrlSecretRef: z.string().trim().min(1).optional(),
    credentialSecretRef: z.string().trim().min(1).optional(),
    lifecycleState: z.enum(["active", "disabled", "archived"]).optional(),
  })
  .strict();

const ruleInputSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    eventTypes: z.array(z.enum(NOTIFICATION_EVENT_TYPES)).min(1),
    targetIds: z.array(z.string().trim().min(1)).min(1),
    deliveryPolicy: z.enum(["always", "when_away"]).optional(),
    lifecycleState: z.enum(["active", "disabled", "archived"]).optional(),
  })
  .strict();

const createTargetSchema = z.object({ workspaceId: z.string().trim().min(1).optional(), target: targetInputSchema });
const updateTargetSchema = createTargetSchema.extend({ expectedRevision: z.number().int().positive() });
const createRuleSchema = z.object({ workspaceId: z.string().trim().min(1).optional(), rule: ruleInputSchema });
const updateRuleSchema = createRuleSchema.extend({ expectedRevision: z.number().int().positive() });
const idParamsSchema = z.object({ targetId: z.string().trim().min(1) });
const ruleParamsSchema = z.object({ ruleId: z.string().trim().min(1) });
const presenceSchema = z
  .object({
    workspaceId: z.string().trim().min(1).optional(),
    leaseId: z.string().trim().min(1).optional(),
    clientId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1).optional(),
    focused: z.boolean(),
    visible: z.boolean(),
    ttlMs: z.number().int().min(5_000).max(90_000).optional(),
  })
  .strict();
const notificationRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1).optional(),
    eventType: z.enum(NOTIFICATION_EVENT_TYPES),
    sessionId: z.string().trim().min(1).optional(),
    turnId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(4_000),
    targetIds: z.array(z.string()).optional(),
  })
  .strict();

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/notifications/targets", async (request, reply) => {
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    return reply.send({
      items: fastify.services.integrations.listNotificationTargets(query.data.workspaceId, query.data.includeArchived),
    });
  });

  fastify.post("/api/v1/notifications/targets", async (request, reply) => {
    const body = createTargetSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return reply
      .code(201)
      .send(fastify.services.integrations.createNotificationTarget(body.data.workspaceId, body.data.target));
  });

  fastify.patch("/api/v1/notifications/targets/:targetId", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = updateTargetSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return reply.send(
      fastify.services.integrations.updateNotificationTarget(
        body.data.workspaceId,
        params.data.targetId,
        body.data.expectedRevision,
        body.data.target,
      ),
    );
  });

  fastify.post("/api/v1/notifications/targets/:targetId/test", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = z.object({ workspaceId: z.string().trim().min(1).optional() }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid notification test request." });
    return reply.send(
      await fastify.services.integrations.sendTestNotification(body.data.workspaceId, params.data.targetId),
    );
  });

  fastify.get("/api/v1/notifications/rules", async (request, reply) => {
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    return reply.send({
      items: fastify.services.integrations.listNotificationRules(query.data.workspaceId, query.data.includeArchived),
    });
  });

  fastify.post("/api/v1/notifications/rules", async (request, reply) => {
    const body = createRuleSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return reply
      .code(201)
      .send(fastify.services.integrations.createNotificationRule(body.data.workspaceId, body.data.rule));
  });

  fastify.patch("/api/v1/notifications/rules/:ruleId", async (request, reply) => {
    const params = ruleParamsSchema.safeParse(request.params);
    const body = updateRuleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid notification rule update." });
    return reply.send(
      fastify.services.integrations.updateNotificationRule(
        body.data.workspaceId,
        params.data.ruleId,
        body.data.expectedRevision,
        body.data.rule,
      ),
    );
  });

  fastify.put("/api/v1/notifications/presence", async (request, reply) => {
    const body = presenceSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return reply.send(fastify.services.integrations.upsertNotificationPresence(body.data));
  });

  fastify.get("/api/v1/notifications/deliveries", async (request, reply) => {
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    return reply.send({
      items: fastify.services.integrations.listNotificationDeliveries(query.data.workspaceId, query.data.limit),
    });
  });

  fastify.post("/api/v1/notifications/requests", async (request, reply) => {
    const body = notificationRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { workspaceId, ...notification } = body.data;
    return reply.code(202).send(await fastify.services.integrations.requestNotification(workspaceId, notification));
  });
};
