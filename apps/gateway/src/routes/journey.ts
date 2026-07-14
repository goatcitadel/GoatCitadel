import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JourneyTimelineQuery } from "@goatcitadel/contracts";
import type { JourneyTimelineRouteService } from "../services/journey-timeline-route-service.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const boundedList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return [...new Set(values.flatMap((item) => item.split(",")).map((item) => item.normalize("NFKC").trim()))].filter(
      Boolean,
    );
  })
  .refine((values) => values.length <= 64 && values.every((value) => value.length <= 256), {
    message: "Journey filters are bounded to 64 values of 256 characters.",
  });

const listQuerySchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(256),
    includeGlobal: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    eventTypes: boundedList,
    subjectKinds: boundedList,
    actions: boundedList,
    subjectId: z.string().trim().min(1).max(256).optional(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    trustDispositions: boundedList,
    poisoningStatuses: boundedList.refine(
      (values) => values.every((value) => ["clean", "blocked", "quarantined", "conflicting"].includes(value)),
      { message: "Journey poisoning status is unsupported." },
    ),
    cursor: z.string().min(1).max(8_192).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const journeyRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator", {
    onSend: async (_request, reply, payload) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      return payload;
    },
  });

  fastify.get("/api/v1/journey/events", operatorOnly, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const service = (fastify.services as unknown as { journeyTimeline?: JourneyTimelineRouteService }).journeyTimeline;
    if (!service) return reply.code(503).send({ error: "Journey timeline service is unavailable." });
    try {
      return reply.send(service.listTimeline(parsed.data as JourneyTimelineQuery));
    } catch (error) {
      if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
      return sendRouteError(reply, error, request.log);
    }
  });
};
