import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { projectGatewayEventResultForPublic } from "../services/session-operational-public-projection.js";

const bodySchema = z.object({
  eventId: z.string().min(1),
  route: z.object({
    channel: z.string().min(1),
    account: z.string().min(1),
    peer: z.string().optional(),
    room: z.string().optional(),
    threadId: z.string().optional(),
  }),
  actor: z.object({
    type: z.enum(["user", "agent", "system"]),
    id: z.string().min(1),
  }),
  message: z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
    attachments: z
      .array(
        z.object({
          attachmentId: z.string().min(1),
          fileName: z.string().min(1),
          mimeType: z.string().min(1),
          sizeBytes: z.number().int().nonnegative(),
        }),
      )
      .optional(),
  }),
  taskId: z.string().min(1).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const gatewayEventsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/gateway/events", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const idempotencyKey = (request as typeof request & { idempotencyKey: string }).idempotencyKey;
    const result = await fastify.services.gatewayEvents.ingestEvent(idempotencyKey, parsed.data);
    return reply.code(200).send(projectGatewayEventResultForPublic(result));
  });
};
