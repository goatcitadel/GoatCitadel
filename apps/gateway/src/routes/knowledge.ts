import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";
import { sendRouteError } from "./_error-handler.js";
import { projectPublicSecretValue } from "../services/public-secret-projection.js";

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
  embeddingProfile: z
    .object({
      provider: z.string().min(1).optional(),
      modelId: z.string().min(1).optional(),
      dimensions: z.number().int().positive().optional(),
      profileId: z.string().min(1).optional(),
    })
    .optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const embeddingQuerySchema = z.object({
  namespace: z.string().optional(),
  query: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
  embeddingProfile: z
    .object({
      provider: z.string().min(1).optional(),
      modelId: z.string().min(1).optional(),
      dimensions: z.number().int().positive().optional(),
      profileId: z.string().min(1).optional(),
    })
    .optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

export const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/knowledge/approvals/:approvalId/result", withRouteAccess(fastify, "operator"), async (request, reply) => {
    const params = z.object({ approvalId: z.string().min(1).max(256) }).safeParse(request.params);
    const query = z.object({ workspaceId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256), toolName: z.enum(["docs.ingest", "embeddings.index", "embeddings.query"]) }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "A bound Knowledge approval and scope are required." });
    reply.header("Cache-Control", "private, no-store");
    try { return reply.send(projectPublicSecretValue(await fastify.services.knowledge.knowledgeApprovalResult(params.data.approvalId, query.data))); }
    catch (error) { return sendRouteError(reply, error, request.log); }
  });
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
