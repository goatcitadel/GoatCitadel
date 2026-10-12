import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";

const RATE_LIMIT_MUTATION_MAX = 180;

const artifactParamsSchema = z.object({
  artifactId: z.string().trim().min(1).max(256),
});

const workspaceBodySchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
});

const workspaceQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
});

/** Render evidence for `html` generated artifacts: offline PNG snapshots stored as chat attachments. */
export function registerChatArtifactRenderRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/chat/generated-artifacts/:artifactId/renders",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      const params = artifactParamsSchema.safeParse(request.params);
      const body = workspaceBodySchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
      }
      try {
        const rendered = await fastify.services.chatArtifactRenders.renderChatGeneratedArtifact(
          params.data.artifactId,
          body.data.workspaceId,
        );
        await markMutationCommitted(request);
        return reply.code(201).send(rendered);
      } catch (error) {
        await markMutationCommittedFromError(request, error);
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.get("/api/v1/chat/generated-artifacts/:artifactId/renders", async (request, reply) => {
    const params = artifactParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      reply.header("cache-control", "no-store");
      return reply.send(
        await fastify.services.chatArtifactRenders.listChatArtifactRenders(
          params.data.artifactId,
          query.data.workspaceId,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
}
