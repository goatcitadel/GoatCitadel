import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const memoryWriteSchema = z.object({
  namespace: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const memorySearchSchema = z.object({
  namespace: z.string().optional(),
  query: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
  filters: z.record(z.unknown()).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const docsIngestSchema = z.object({
  sourceType: z.enum(["file", "url", "text"]),
  source: z.string().min(1),
  namespace: z.string().min(1),
  title: z.string().optional(),
  chunking: z
    .object({
      targetChars: z.number().int().positive().optional(),
      overlapChars: z.number().int().nonnegative().optional(),
      maxChunks: z.number().int().positive().optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const embeddingIndexSchema = z.object({
  namespace: z.string().optional(),
  documentId: z.string().optional(),
  force: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const embeddingQuerySchema = z.object({
  namespace: z.string().optional(),
  query: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

export const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/knowledge/memory/write", async (request, reply) => {
    const parsed = memoryWriteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.knowledge.knowledgeMemoryWrite(parsed.data));
  });

  fastify.post("/api/v1/knowledge/memory/search", async (request, reply) => {
    const parsed = memorySearchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.knowledge.knowledgeMemorySearch(parsed.data));
  });

  fastify.post("/api/v1/knowledge/docs/ingest", async (request, reply) => {
    const parsed = docsIngestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.knowledge.knowledgeDocsIngest(parsed.data));
  });

  fastify.post("/api/v1/knowledge/embeddings/index", async (request, reply) => {
    const parsed = embeddingIndexSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.knowledge.knowledgeEmbeddingsIndex(parsed.data));
  });

  fastify.post("/api/v1/knowledge/embeddings/query", async (request, reply) => {
    const parsed = embeddingQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.knowledge.knowledgeEmbeddingsQuery(parsed.data));
  });
};
