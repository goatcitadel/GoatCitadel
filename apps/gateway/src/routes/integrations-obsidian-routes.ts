import type { FastifyInstance } from "fastify";
import {
  obsidianAppendSchema,
  obsidianInboxCaptureSchema,
  obsidianPatchSchema,
  obsidianReadQuerySchema,
  obsidianSearchSchema,
} from "./integrations-shared.js";

export function registerObsidianIntegrationRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/integrations/obsidian/status", async (_request, reply) => {
    return reply.send(await fastify.services.obsidian.getObsidianIntegrationStatus());
  });

  fastify.patch("/api/v1/integrations/obsidian/config", async (request, reply) => {
    const parsed = obsidianPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.obsidian.updateObsidianIntegrationConfig(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/test", async (_request, reply) => {
    try {
      return reply.send(await fastify.services.obsidian.testObsidianIntegration());
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/search", async (request, reply) => {
    const parsed = obsidianSearchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: await fastify.services.obsidian.searchObsidianNotes(parsed.data.query, parsed.data.limit),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/integrations/obsidian/note", async (request, reply) => {
    const parsed = obsidianReadQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.obsidian.readObsidianNote(parsed.data.path));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/append", async (request, reply) => {
    const parsed = obsidianAppendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(
        await fastify.services.obsidian.appendObsidianNote(parsed.data.path, parsed.data.markdownBlock),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/inbox/capture", async (request, reply) => {
    const parsed = obsidianInboxCaptureSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.obsidian.captureObsidianInboxEntry(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
