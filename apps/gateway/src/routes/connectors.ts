import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const connectorQuerySchema = z.object({
  connectorType: z.enum(["browser", "mcp_server", "integration_connection"]).optional(),
});

const connectorParamsSchema = z.object({
  enrollmentId: z.string().min(1),
});

const connectorCapabilitySchema = z.object({
  id: z.enum(["inbound_messages", "outbound_messages", "approvals", "health_checks", "interactive_actions"]),
  version: z.string().min(1),
  enabled: z.boolean(),
});

const enrollmentChallengeSchema = z.object({
  connectorType: z.enum(["browser", "mcp_server", "integration_connection"]),
  label: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  publicKeyPem: z.string().min(1),
  capabilities: z.array(connectorCapabilitySchema).optional(),
});

const enrollmentCompleteSchema = z.object({
  signatureBase64: z.string().min(1),
});

const enrollmentActivateSchema = z.object({
  approvedBy: z.string().min(1),
});

export const connectorsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/connectors", async (request, reply) => {
    const parsed = connectorQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.connectors.listConnectorRecords(parsed.data.connectorType),
    });
  });

  fastify.post("/api/v1/connectors/enrollments/challenge", async (request, reply) => {
    const parsed = enrollmentChallengeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.code(201).send(fastify.services.connectors.issueConnectorEnrollmentChallenge(parsed.data));
  });

  fastify.get("/api/v1/connectors/enrollments/:enrollmentId", async (request, reply) => {
    const params = connectorParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.connectors.getConnectorEnrollment(params.data.enrollmentId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/connectors/enrollments/:enrollmentId/complete", async (request, reply) => {
    const params = connectorParamsSchema.safeParse(request.params);
    const parsed = enrollmentCompleteSchema.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.connectors.completeConnectorEnrollment(params.data.enrollmentId, parsed.data));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/connectors/enrollments/:enrollmentId/health", async (request, reply) => {
    const params = connectorParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.connectors.checkConnectorEnrollmentHealth(params.data.enrollmentId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/connectors/enrollments/:enrollmentId/activate", async (request, reply) => {
    const params = connectorParamsSchema.safeParse(request.params);
    const parsed = enrollmentActivateSchema.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.connectors.activateConnectorEnrollment(params.data.enrollmentId, parsed.data));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
};
