import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REFS,
  CHAT_ROUTED_CONTEXT_CONTROL_PATTERN,
  CHAT_ROUTED_CONTEXT_REF_PATTERN,
  MOBILE_NATIVE_CAPABILITY_IDS,
  NotFoundError,
  type ChatSendMessageRequest,
  type RoutingPreflightRequest,
  type RoutingPreflightResult,
} from "@goatcitadel/contracts";
import { z } from "zod";
import {
  projectChatContextManifestForPublic,
  projectChatHistoryMessageForPublic,
  projectChatMessageForPublic,
} from "../services/chat-secret-projection.js";
import {
  sessionParamsSchema,
  turnParamsSchema,
  streamResumeQuerySchema,
  streamSseReply,
  sendChatWriteError,
} from "./chat.shared.js";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";
import { projectAndCapChatHistoryWindow, projectChatHistoryContinuation } from "../services/chat-history-service.js";
import {
  createAuthenticatedOperatorAdmissionContext as createBrandedAuthenticatedOperatorAdmissionContext,
  type AuthenticatedOperatorAdmissionContext,
} from "../services/session-control-service.js";

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
});

const chatHistoryReadSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    limit: z.coerce.number().int().positive().max(101).default(21),
    cursor: z.string().trim().min(1).optional(),
    cursorSequence: z.coerce.number().int().positive().safe().optional(),
    direction: z.enum(["older", "newer"]).optional(),
    offset: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
    snapshotMaxSequence: z.coerce.number().int().positive().safe().optional(),
    snapshotMessageCount: z.coerce.number().int().nonnegative().safe().optional(),
    messageId: z.string().trim().min(1).optional(),
    sequence: z.coerce.number().int().positive().safe().optional(),
    maxBytes: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  })
  .superRefine((value, context) => {
    if (value.cursor !== undefined && value.offset !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cursor and offset cannot be used together",
        path: ["cursor"],
      });
    }
    if ((value.messageId === undefined) !== (value.sequence === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "messageId and sequence are required together",
        path: [value.messageId === undefined ? "messageId" : "sequence"],
      });
    }
    if (value.messageId !== undefined && (value.cursor !== undefined || value.offset !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "anchored history cannot be combined with cursor or offset",
        path: [value.cursor !== undefined ? "cursor" : "offset"],
      });
    }
    const continuationFields = [value.direction, value.cursorSequence].filter((item) => item !== undefined).length;
    if (
      continuationFields > 0 &&
      (value.direction === undefined || value.cursor === undefined || value.cursorSequence === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "direction, cursor, and cursorSequence are required together",
        path: [value.direction === undefined ? "direction" : value.cursor === undefined ? "cursor" : "cursorSequence"],
      });
    }
    if (value.direction !== undefined && (value.offset !== undefined || value.messageId !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "history continuation cannot be combined with offset or anchor identity",
        path: [value.offset !== undefined ? "offset" : "messageId"],
      });
    }
    if (value.snapshotMaxSequence !== undefined && value.offset === undefined && value.direction === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "snapshotMaxSequence requires offset pagination",
        path: ["snapshotMaxSequence"],
      });
    }
    if (value.snapshotMessageCount !== undefined && value.offset === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "snapshotMessageCount requires offset pagination",
        path: ["snapshotMessageCount"],
      });
    }
    if (value.direction !== undefined && value.snapshotMaxSequence === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "snapshotMaxSequence is required for history continuation",
        path: ["snapshotMaxSequence"],
      });
    }
  });

const chatThreadQuerySchema = z.object({
  includeDecisionTrace: z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1")
    .optional(),
});

const capabilityProfileQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
});

const routeDecisionSchema = z.object({
  action: z.enum(["send", "retry", "edit"]),
  turnId: z.string().optional(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  requestedProviderId: z.string().optional(),
  requestedModel: z.string().optional(),
  effectiveProviderId: z.string().optional(),
  effectiveModel: z.string().optional(),
  selectionSource: z.enum(["manual", "session", "global"]),
  normalizationReason: z.string().optional(),
  fallbackPolicy: z.enum(["off", "armed"]),
  fallbackResult: z.enum(["not_applicable", "same_boundary", "local_to_cloud", "cloud_to_local"]),
  runtimeReachability: z.enum(["not_checked", "reachable", "unreachable", "models_unavailable"]),
  runtimeClass: z.enum(["local", "cloud", "unknown"]),
  blockedReason: z.string().optional(),
  degradedReason: z.string().optional(),
  capabilityFingerprint: z.string().min(1).optional(),
  capabilityContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  capabilityProfileSchemaVersion: z.literal("chat.turn.capability-profile.v1").optional(),
  capabilityCompactionDimensionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  fingerprint: z.string().min(1),
});

const mobileCapabilityIdSchema = z.enum(MOBILE_NATIVE_CAPABILITY_IDS);
const chatOnlyModeSchema = z.enum(["chat", "cowork", "code"]).transform(() => "chat" as const);

const sideChatContextSchema = z.object({
  parentSessionId: z.string().min(1),
  originSurface: chatOnlyModeSchema,
  selectedTurnId: z.string().min(1).optional(),
  recentTurnLimit: z.coerce.number().int().positive().max(12).optional(),
});

const mobileContextSchema = z.object({
  contextId: z.string().trim().min(1).optional(),
  capabilityId: mobileCapabilityIdSchema,
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  sensitivity: z.enum(["low", "moderate", "high"]),
  summary: z.string().trim().min(1),
  structuredFields: z.record(z.string(), z.string()),
  attachmentIds: z.array(z.string().trim().min(1)).optional(),
  userVisibleReason: z.string().trim().min(1),
  provenance: z
    .object({
      platform: z.enum(["android", "ios", "web", "unknown"]).optional(),
      appVersion: z.string().trim().min(1).optional(),
      deviceId: z.string().trim().min(1).optional(),
      grantId: z.string().trim().min(1).optional(),
      companionSessionId: z.string().trim().min(1).optional(),
      sessionId: z.string().trim().min(1).optional(),
      source: z.enum(["mobile_app", "native_module", "gateway"]).optional(),
    })
    .optional(),
});

const routedContextRefSchema = z
  .object({
    kind: z.enum(["attachment", "memory_item"]),
    ref: z
      .string()
      .min(1)
      .max(CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH)
      .regex(CHAT_ROUTED_CONTEXT_REF_PATTERN, "ref contains unsupported characters")
      .refine((value) => value === value.trim(), "ref must not contain surrounding whitespace"),
    label: z
      .string()
      .min(1)
      .max(CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH)
      .refine((value) => value === value.trim(), "label must not contain surrounding whitespace")
      .refine((value) => !CHAT_ROUTED_CONTEXT_CONTROL_PATTERN.test(value), "label contains control characters")
      .optional(),
  })
  .strict();

const routedContextRefsSchema = z
  .array(routedContextRefSchema)
  .min(1)
  .max(CHAT_ROUTED_CONTEXT_MAX_REFS)
  .superRefine((refs, context) => {
    const seen = new Set<string>();
    refs.forEach((entry, index) => {
      const key = `${entry.kind}\u0000${entry.ref}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "contextRefs must not contain duplicate sources",
          path: [index],
        });
      }
      seen.add(key);
    });
  });

const sendMessageSchema = z.object({
  content: z.string().min(1),
  parts: z
    .array(
      z.union([
        z.object({
          type: z.literal("text"),
          text: z.string().min(1),
        }),
        z.object({
          type: z.literal("image_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
          detail: z.enum(["low", "high", "auto"]).optional(),
        }),
        z.object({
          type: z.literal("audio_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
        }),
        z.object({
          type: z.literal("video_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
        }),
        z.object({
          type: z.literal("file_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  mobileContext: z.array(mobileContextSchema).max(12).optional(),
  contextRefs: routedContextRefsSchema.optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  routeDecision: routeDecisionSchema.optional(),
  useMemory: z.boolean().optional(),
  attachments: z.array(z.string()).optional(),
  mode: chatOnlyModeSchema.optional(),
  permissionProfileId: z.string().min(1).optional(),
  localOperatorOverrideId: z.string().min(1).optional(),
  policyRunId: z.string().min(1).optional(),
  policyTaskId: z.string().min(1).optional(),
  fullWebAccess: z.boolean().optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  memoryMode: z.enum(["auto", "on", "off"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]).optional(),
  speedMode: z.enum(["standard", "fast"]).optional(),
  subagentPolicy: z.enum(["off", "ask_when_useful", "auto_when_useful"]).optional(),
  modelCouncil: z
    .object({
      enabled: z.literal(true),
    })
    .strict()
    .optional(),
  commandText: z.string().optional(),
  prefsOverride: z
    .object({
      mode: chatOnlyModeSchema.optional(),
      providerId: z.string().optional(),
      model: z.string().optional(),
      imageProviderId: z.string().optional(),
      imageModel: z.string().optional(),
      webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
      memoryMode: z.enum(["auto", "on", "off"]).optional(),
      thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]).optional(),
      speedMode: z.enum(["standard", "fast"]).optional(),
      subagentPolicy: z.enum(["off", "ask_when_useful", "auto_when_useful"]).optional(),
      toolAutonomy: z.enum(["safe_auto", "manual"]).optional(),
      visionFallbackModel: z.string().optional(),
      orchestrationEnabled: z.boolean().optional(),
      orchestrationIntensity: z.enum(["minimal", "balanced", "deep"]).optional(),
      orchestrationVisibility: z.enum(["hidden", "summarized", "expandable", "explicit"]).optional(),
      orchestrationProviderPreference: z.enum(["speed", "quality", "balanced", "low_cost"]).optional(),
      orchestrationReviewDepth: z.enum(["off", "standard", "strict"]).optional(),
      orchestrationParallelism: z.enum(["auto", "sequential", "parallel"]).optional(),
      codeAutoApply: z.enum(["manual", "low_risk_auto", "aggressive_auto"]).optional(),
      proactiveMode: z.enum(["off", "suggest", "auto_safe", "auto_full"]).optional(),
      autonomyBudget: z
        .object({
          maxActionsPerHour: z.coerce.number().int().positive().max(200).optional(),
          maxActionsPerTurn: z.coerce.number().int().positive().max(25).optional(),
          cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
        })
        .optional(),
      retrievalMode: z.enum(["standard", "layered"]).optional(),
      reflectionMode: z.enum(["off", "on"]).optional(),
    })
    .optional(),
  sideChatContext: sideChatContextSchema.optional(),
});

const retryTurnSchema = sendMessageSchema.partial().extend({
  content: z.string().optional(),
});

const editTurnSchema = sendMessageSchema;

function stampChatOperatorContext<TInput extends Partial<ChatSendMessageRequest>>(
  request: FastifyRequest,
  input: TInput,
): TInput {
  return {
    ...input,
    operatorId: request.authActorId,
    authActorId: request.authActorId,
    authActorSource: request.authActorSource,
  } as TInput;
}

function resolveAuthenticatedOperatorAdmissionContext(
  request: FastifyRequest,
): AuthenticatedOperatorAdmissionContext | undefined {
  if (!request.authActorId?.trim() || !["none", "token", "basic", "loopback"].includes(request.authActorSource)) {
    return undefined;
  }
  return createBrandedAuthenticatedOperatorAdmissionContext({
    actorId: request.authActorId,
    authActorSource: request.authActorSource,
  });
}

const routePreflightSchema = z.object({
  action: z.enum(["send", "retry", "edit"]),
  turnId: z.string().optional(),
  content: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  mode: chatOnlyModeSchema.optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  memoryMode: z.enum(["auto", "on", "off"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]).optional(),
  speedMode: z.enum(["standard", "fast"]).optional(),
  subagentPolicy: z.enum(["off", "ask_when_useful", "auto_when_useful"]).optional(),
  prefsOverride: sendMessageSchema.shape.prefsOverride,
  permissionProfileId: z.string().min(1).optional(),
  localOperatorOverrideId: z.string().min(1).optional(),
  policyRunId: z.string().min(1).optional(),
  policyTaskId: z.string().min(1).optional(),
  fullWebAccess: z.boolean().optional(),
});

const cancelTurnSchema = z.object({
  cancelledBy: z.string().min(1).optional(),
});

const answerUserInputPromptSchema = z.object({
  response: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("single_select"),
      optionId: z.string().trim().min(1).max(256),
    }),
    z.object({
      kind: z.literal("text"),
      text: z.string().trim().min(1).max(20_000),
    }),
  ]),
});

export function registerChatMessageRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/chat/sessions/:sessionId/messages", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = listMessagesSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const items = await fastify.services.chatMessages.listChatMessages(
        params.data.sessionId,
        query.data.limit,
        query.data.cursor,
      );
      return reply.send({ items: items.map(projectChatMessageForPublic) });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/history", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    reply.header("pragma", "no-cache");
    const params = sessionParamsSchema.safeParse(request.params);
    const query = chatHistoryReadSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      if (
        query.data.direction !== undefined &&
        query.data.cursor !== undefined &&
        query.data.cursorSequence !== undefined &&
        query.data.snapshotMaxSequence !== undefined
      ) {
        const raw = await fastify.services.chatMessages.readChatHistoryContinuation({
          workspaceId: query.data.workspaceId,
          sessionId: params.data.sessionId,
          direction: query.data.direction,
          cursorMessageId: query.data.cursor,
          cursorSequence: query.data.cursorSequence,
          snapshotMaxSequence: query.data.snapshotMaxSequence,
          limit: query.data.limit,
        });
        return reply.send(projectChatHistoryContinuation(raw, query.data.maxBytes, projectChatHistoryMessageForPublic));
      }
      if (query.data.messageId !== undefined && query.data.sequence !== undefined) {
        const raw = await fastify.services.chatMessages.readChatHistoryWindow(
          {
            workspaceId: query.data.workspaceId,
            sessionId: params.data.sessionId,
            messageId: query.data.messageId,
            sequence: query.data.sequence,
          },
          query.data.limit,
        );
        return reply.send(projectAndCapChatHistoryWindow(raw, query.data.maxBytes, projectChatHistoryMessageForPublic));
      }
      const page = await fastify.services.chatMessages.listChatMessagePage({
        workspaceId: query.data.workspaceId,
        sessionId: params.data.sessionId,
        limit: query.data.limit,
        cursor: query.data.cursor,
        offset: query.data.offset,
        snapshotMaxSequence: query.data.snapshotMaxSequence,
        snapshotMessageCount: query.data.snapshotMessageCount,
      });
      return reply.send({
        ...page,
        items: page.items.map(projectChatHistoryMessageForPublic),
      });
    } catch (error) {
      return reply.code(error instanceof NotFoundError ? 404 : 400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/thread", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const query = chatThreadQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    try {
      return reply.send(
        await fastify.services.chatMessages.getChatThread(params.data.sessionId, {
          includeDecisionTrace: query.data.includeDecisionTrace === true,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/messages", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return reply.code(410).send({
      error: "POST /messages has been removed. Use /api/v1/chat/sessions/:sessionId/agent-send instead.",
    });
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/agent-send", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const decisionRejected = await requireFreshRouteDecision(reply, fastify.services.chatMessages, {
        sessionId: params.data.sessionId,
        action: "send",
        body: body.data,
        actor: request,
      });
      if (decisionRejected) {
        return;
      }
      const sent = await fastify.services.chatMessages.agentSendChatMessage(
        params.data.sessionId,
        stampChatOperatorContext(request, body.data),
        resolveAuthenticatedOperatorAdmissionContext(request),
      );
      markMutationCommitted(request);
      return reply.send(sent);
    } catch (error) {
      markMutationCommittedFromError(request, error);
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/route-preflight", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = routePreflightSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const result = await fastify.services.chatMessages.routePreflight(params.data.sessionId, {
        ...body.data,
        operatorId: request.authActorId,
        authActorId: request.authActorId,
        authActorSource: request.authActorSource,
      });
      return reply.send(result);
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return reply.code(410).send({
      error: "POST /messages/stream has been removed. Use /api/v1/chat/sessions/:sessionId/agent-send/stream instead.",
    });
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/agent-send/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const decisionRejected = await requireFreshRouteDecision(reply, fastify.services.chatMessages, {
        sessionId: params.data.sessionId,
        action: "send",
        body: body.data,
        actor: request,
      });
      if (decisionRejected) {
        return;
      }
    } catch (error) {
      return sendChatWriteError(reply, error);
    }

    return streamSseReply(
      reply,
      request,
      params.data.sessionId,
      (signal, lifecycle) =>
        fastify.services.chatMessages.agentSendChatMessageStream(
          params.data.sessionId,
          stampChatOperatorContext(request, body.data),
          signal,
          lifecycle,
          resolveAuthenticatedOperatorAdmissionContext(request),
        ),
      { trackMutation: true },
    );
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/turns/:turnId/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const query = streamResumeQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    const headerEventId =
      typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined;
    const sinceEventId = query.data.sinceEventId ?? headerEventId;
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.services.chatMessages.resumeAgentChatTurnStream(
        params.data.sessionId,
        params.data.turnId,
        sinceEventId,
        signal,
      ),
    );
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/turns/:turnId/context-manifest", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const detail = fastify.services.chatMessages.getTurnContextManifestForSession(
        params.data.sessionId,
        params.data.turnId,
      );
      if (!detail) {
        return reply.code(404).send({ error: "Context manifest not found" });
      }
      return reply.send(projectChatContextManifestForPublic(detail));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/turns/:turnId/capability-profile", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const query = capabilityProfileQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.chatMessages.getChatTurnCapabilityProfile(params.data.sessionId, params.data.turnId, {
          workspaceId: query.data.workspaceId,
          operatorId: request.authActorId,
        }),
      );
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post(
    "/api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/respond",
    async (request, reply) => {
      const params = z
        .object({
          sessionId: z.string().min(1),
          turnId: z.string().min(1),
          promptId: z.string().trim().min(1).max(96),
        })
        .safeParse(request.params);
      const body = answerUserInputPromptSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
      }
      try {
        const result = await fastify.services.chatMessages.answerChatUserInputPrompt(
          params.data.sessionId,
          params.data.turnId,
          params.data.promptId,
          body.data.response,
          {
            actorId: request.authActorId,
            authActorSource: request.authActorSource,
          },
        );
        markMutationCommitted(request);
        return reply.send(result);
      } catch (error) {
        markMutationCommittedFromError(request, error);
        return sendChatWriteError(reply, error);
      }
    },
  );

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/select", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = await fastify.services.chatMessages.selectChatBranchTurn(
        params.data.sessionId,
        params.data.turnId,
      );
      markMutationCommitted(request);
      return reply.send(result);
    } catch (error) {
      markMutationCommittedFromError(request, error);
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/retry", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = retryTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const decisionRejected = await requireFreshRouteDecision(reply, fastify.services.chatMessages, {
        sessionId: params.data.sessionId,
        action: "retry",
        turnId: params.data.turnId,
        body: body.data,
        actor: request,
      });
      if (decisionRejected) {
        return;
      }
      const result = await fastify.services.chatMessages.retryChatTurn(
        params.data.sessionId,
        params.data.turnId,
        stampChatOperatorContext(request, body.data),
        resolveAuthenticatedOperatorAdmissionContext(request),
      );
      markMutationCommitted(request);
      return reply.send(result);
    } catch (error) {
      markMutationCommittedFromError(request, error);
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/retry/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = retryTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const decisionRejected = await requireFreshRouteDecision(reply, fastify.services.chatMessages, {
        sessionId: params.data.sessionId,
        action: "retry",
        turnId: params.data.turnId,
        body: body.data,
        actor: request,
      });
      if (decisionRejected) {
        return;
      }
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
    return streamSseReply(
      reply,
      request,
      params.data.sessionId,
      (signal, lifecycle) =>
        fastify.services.chatMessages.retryChatTurnStream(
          params.data.sessionId,
          params.data.turnId,
          stampChatOperatorContext(request, body.data),
          signal,
          lifecycle,
          resolveAuthenticatedOperatorAdmissionContext(request),
        ),
      { trackMutation: true },
    );
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/edit", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = editTurnSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const decisionRejected = await requireFreshRouteDecision(reply, fastify.services.chatMessages, {
        sessionId: params.data.sessionId,
        action: "edit",
        turnId: params.data.turnId,
        body: body.data,
        actor: request,
      });
      if (decisionRejected) {
        return;
      }
      const result = await fastify.services.chatMessages.editChatTurn(
        params.data.sessionId,
        params.data.turnId,
        stampChatOperatorContext(request, body.data),
        resolveAuthenticatedOperatorAdmissionContext(request),
      );
      markMutationCommitted(request);
      return reply.send(result);
    } catch (error) {
      markMutationCommittedFromError(request, error);
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/edit/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = editTurnSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const decisionRejected = await requireFreshRouteDecision(reply, fastify.services.chatMessages, {
        sessionId: params.data.sessionId,
        action: "edit",
        turnId: params.data.turnId,
        body: body.data,
        actor: request,
      });
      if (decisionRejected) {
        return;
      }
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
    return streamSseReply(
      reply,
      request,
      params.data.sessionId,
      (signal, lifecycle) =>
        fastify.services.chatMessages.editChatTurnStream(
          params.data.sessionId,
          params.data.turnId,
          stampChatOperatorContext(request, body.data),
          signal,
          lifecycle,
          resolveAuthenticatedOperatorAdmissionContext(request),
        ),
      { trackMutation: true },
    );
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/cancel", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = cancelTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const result = await fastify.services.chatMessages.cancelChatTurn(
        params.data.sessionId,
        params.data.turnId,
        body.data.cancelledBy,
      );
      markMutationCommitted(request);
      return reply.send(result);
    } catch (error) {
      markMutationCommittedFromError(request, error);
      return sendChatWriteError(reply, error);
    }
  });
}

async function requireFreshRouteDecision(
  reply: FastifyReply,
  chatMessages: {
    routePreflight: (sessionId: string, input: RoutingPreflightRequest) => Promise<RoutingPreflightResult>;
  },
  input: {
    sessionId: string;
    action: "send" | "retry" | "edit";
    turnId?: string;
    body: Partial<z.infer<typeof sendMessageSchema>> & { routeDecision?: z.infer<typeof routeDecisionSchema> };
    actor?: Pick<FastifyRequest, "authActorId" | "authActorSource">;
  },
) {
  const decision = input.body.routeDecision;
  if (!decision) {
    sendRouteChanged(reply, "route_decision_required");
    return true;
  }
  if (decision.action !== input.action || (decision.turnId ?? undefined) !== (input.turnId ?? undefined)) {
    sendRouteChanged(reply, "route_action_mismatch");
    return true;
  }
  const expiresAtMs = Date.parse(decision.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    sendRouteChanged(reply, "route_decision_expired");
    return true;
  }
  if (
    (input.body.providerId ?? undefined) !== (decision.effectiveProviderId ?? undefined) ||
    (input.body.model ?? undefined) !== (decision.effectiveModel ?? undefined)
  ) {
    sendRouteChanged(reply, "route_effective_mismatch");
    return true;
  }
  const shouldReplayManualSelection = decision.selectionSource === "manual";
  const shouldReplaySessionSelection = decision.selectionSource === "session";
  const replayedPrefsOverride = shouldReplaySessionSelection
    ? {
        ...(input.body.prefsOverride ?? {}),
        providerId: decision.requestedProviderId,
        model: decision.requestedModel,
      }
    : input.body.prefsOverride;
  const current = await chatMessages.routePreflight(input.sessionId, {
    action: input.action,
    turnId: input.turnId,
    content: input.body.content,
    providerId: shouldReplayManualSelection ? decision.requestedProviderId : undefined,
    model: shouldReplayManualSelection ? decision.requestedModel : undefined,
    mode: input.body.mode,
    webMode: input.body.webMode,
    memoryMode: input.body.memoryMode,
    thinkingLevel: input.body.thinkingLevel,
    speedMode: input.body.speedMode,
    subagentPolicy: input.body.subagentPolicy,
    prefsOverride: replayedPrefsOverride,
    permissionProfileId: input.body.permissionProfileId,
    localOperatorOverrideId: input.body.localOperatorOverrideId,
    policyRunId: input.body.policyRunId,
    policyTaskId: input.body.policyTaskId,
    fullWebAccess: input.body.fullWebAccess,
    operatorId: input.actor?.authActorId,
    authActorId: input.actor?.authActorId,
    authActorSource: input.actor?.authActorSource,
  });
  if (current.blockedReason) {
    sendRouteChanged(reply, "route_blocked", current.blockedReason);
    return true;
  }
  if (current.decision.fingerprint !== decision.fingerprint) {
    sendRouteChanged(reply, "route_fingerprint_mismatch");
    return true;
  }
  return false;
}

function sendRouteChanged(reply: FastifyReply, reason: string, detail?: string) {
  return reply.code(409).send({
    error: {
      code: "route_changed",
      message: "The provider route changed. Refresh route status and send again.",
      reason,
      detail,
    },
  });
}
