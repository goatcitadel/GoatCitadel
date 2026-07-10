import type { FastifyInstance } from "fastify";
import {
  projectChannelSetupDraftForPublicResponse,
  projectChannelSetupDraftsForPublicResponse,
  projectChannelSetupFinalizeResultForPublicResponse,
  projectChannelSetupTestResultForPublicResponse,
  projectChannelSetupValidationResultForPublicResponse,
} from "../services/channel-setup-public-projection.js";
import {
  catalogParamsSchema,
  channelDraftListQuerySchema,
  channelDraftParamsSchema,
  connectionParamsSchema,
  createChannelDraftSchema,
  updateChannelDraftSchema,
} from "./integrations-shared.js";

export function registerChannelSetupIntegrationRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/channels/drafts", async (request, reply) => {
    const parsed = channelDraftListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: projectChannelSetupDraftsForPublicResponse(
        fastify.services.channelSetup.listChannelSetupDrafts(parsed.data),
      ),
    });
  });

  fastify.get("/api/v1/channels/setup-definitions", async (_request, reply) => {
    return reply.send({
      items: fastify.services.channelSetup.listChannelSetupDefinitions(),
    });
  });

  fastify.get("/api/v1/channels/catalog/:catalogId/setup-definition", async (request, reply) => {
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.channelSetup.getChannelSetupDefinition(params.data.catalogId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts", async (request, reply) => {
    const parsed = createChannelDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = fastify.services.channelSetup.createChannelSetupDraft(parsed.data);
      return reply.code(201).send(projectChannelSetupDraftForPublicResponse(created));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/channels/drafts/:draftId", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    const parsed = updateChannelDraftSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: parsed.success ? undefined : parsed.error.flatten(),
        },
      });
    }
    try {
      const updated = fastify.services.channelSetup.updateChannelSetupDraft(params.data.draftId, parsed.data);
      return reply.send(projectChannelSetupDraftForPublicResponse(updated));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/validate", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = fastify.services.channelSetup.validateChannelSetupDraft(params.data.draftId);
      return reply.send(projectChannelSetupValidationResultForPublicResponse(result));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/test", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = await fastify.services.channelSetup.testChannelSetupDraft(params.data.draftId);
      return reply.send(projectChannelSetupTestResultForPublicResponse(result));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/finalize", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const finalized = await fastify.services.channelSetup.finalizeChannelSetupDraft(params.data.draftId);
      return reply.send(projectChannelSetupFinalizeResultForPublicResponse(finalized));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/connections/:connectionId/repair-draft", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const created = fastify.services.channelSetup.createChannelSetupRepairDraft(params.data.connectionId);
      return reply.code(201).send(projectChannelSetupDraftForPublicResponse(created));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/connections/:connectionId/rotate-secret-draft", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const created = fastify.services.channelSetup.createChannelSetupRotateSecretDraft(params.data.connectionId);
      return reply.code(201).send(projectChannelSetupDraftForPublicResponse(created));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/connections/:connectionId/retest", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = await fastify.services.channelSetup.retestChannelConnection(params.data.connectionId);
      return reply.send(projectChannelSetupTestResultForPublicResponse(result));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
