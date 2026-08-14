import type { FastifyInstance } from "fastify";
import { ConflictError, SemanticValidationError, type ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  projectChannelSetupDraftForPublicResponse,
  projectChannelSetupDraftsForPublicResponse,
  projectChannelSetupFinalizeResultForPublicResponse,
  projectChannelSetupTestResultForPublicResponse,
  projectChannelSetupValidationResultForPublicResponse,
} from "../services/channel-setup-public-projection.js";
import {
  catalogParamsSchema,
  channelDraftActionSchema,
  channelDraftSecureFieldsSchema,
  channelDraftListQuerySchema,
  channelDraftParamsSchema,
  connectionParamsSchema,
  createChannelDraftSchema,
  updateChannelDraftSchema,
} from "./integrations-shared.js";
import { sendRouteError } from "./_error-handler.js";

export function registerChannelSetupIntegrationRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/channels/drafts/:draftId/secure-fields",
    {
      bodyLimit: 200 * 1_024,
      logLevel: "silent",
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      const params = channelDraftParamsSchema.safeParse(request.params);
      const body = channelDraftSecureFieldsSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
      }
      try {
        const updated = await fastify.services.channelSetup.setChannelSetupDraftSecrets(params.data.draftId, body.data);
        return reply.send(projectChannelSetupDraftForPublicResponse(updated));
      } catch (error) {
        return error instanceof ConflictError
          ? sendRouteError(reply, error, request.log)
          : reply.code(422).send({ error: (error as Error).message });
      }
    },
  );

  fastify.get("/api/v1/channels/drafts", async (request, reply) => {
    const parsed = channelDraftListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: projectChannelSetupDraftsForPublicResponse(
        await fastify.services.channelSetup.listChannelSetupDrafts(parsed.data),
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
      const created = await fastify.services.channelSetup.createChannelSetupDraft(parsed.data);
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
      const updated = await fastify.services.channelSetup.updateChannelSetupDraft(params.data.draftId, parsed.data);
      return reply.send(projectChannelSetupDraftForPublicResponse(updated));
    } catch (error) {
      return error instanceof ConflictError
        ? sendRouteError(reply, error, request.log)
        : reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/validate", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    const body = channelDraftActionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
    }
    try {
      const result = await fastify.services.channelSetup.validateChannelSetupDraft(
        params.data.draftId,
        body.data.expectedRevision,
      );
      return reply.send(projectChannelSetupValidationResultForPublicResponse(result));
    } catch (error) {
      return error instanceof ConflictError
        ? sendRouteError(reply, error, request.log)
        : reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/test", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    const body = channelDraftActionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
    }
    try {
      const result = await fastify.services.channelSetup.testChannelSetupDraft(
        params.data.draftId,
        body.data.expectedRevision,
      );
      return reply.send(projectChannelSetupTestResultForPublicResponse(result));
    } catch (error) {
      return error instanceof ConflictError
        ? sendRouteError(reply, error, request.log)
        : reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/finalize", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    const body = channelDraftActionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
    }
    try {
      const evolution = fastify.services.evolution;
      if (evolution && (await evolution.isEnabled())) {
        const drafts = await fastify.services.channelSetup.listChannelSetupDrafts({ limit: 100 });
        const draft = drafts.find((item: ChannelSetupDraft) => item.draftId === params.data.draftId);
        if (!draft) throw new SemanticValidationError("The channel setup draft no longer exists.");
        if (draft.revision !== body.data.expectedRevision) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: "The channel setup draft changed before its Change Plan was created.",
            details: {
              resourceKind: "channel_setup_draft",
              resourceId: draft.draftId,
              expectedRevision: body.data.expectedRevision,
              currentRevision: draft.revision,
            },
          });
        }
        const plan = await evolution.create({
          actor: {
            workspaceId: "default",
            actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
            surface: "settings",
            requestId: request.id,
          },
          request: { kind: "channel_connection", channelKind: draft.catalogId, draftId: draft.draftId },
          idempotencyKey: `legacy-channel-finalize:${request.id}:${draft.draftId}:${draft.revision}`,
          expectedTargetRevision: draft.revision,
        });
        return reply.code(202).send({
          draft: projectChannelSetupDraftForPublicResponse(draft),
          changePlan: plan,
          finalized: false,
        });
      }
      const finalized = await fastify.services.channelSetup.finalizeChannelSetupDraft(
        params.data.draftId,
        body.data.expectedRevision,
      );
      return reply.send(projectChannelSetupFinalizeResultForPublicResponse(finalized));
    } catch (error) {
      return error instanceof ConflictError
        ? sendRouteError(reply, error, request.log)
        : reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/connections/:connectionId/repair-draft", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const created = await fastify.services.channelSetup.createChannelSetupRepairDraft(params.data.connectionId);
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
      const created = await fastify.services.channelSetup.createChannelSetupRotateSecretDraft(params.data.connectionId);
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
