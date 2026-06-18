import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MOBILE_NATIVE_CAPABILITY_IDS, type ChatSendMessageRequest } from "@goatcitadel/contracts";
import { z } from "zod";
import {
  sessionParamsSchema,
  turnParamsSchema,
  streamResumeQuerySchema,
  streamSseReply,
  sendChatWriteError,
} from "./chat.shared.js";

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
});

const chatThreadQuerySchema = z.object({
  includeDecisionTrace: z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1")
    .optional(),
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
  fingerprint: z.string().min(1),
});

const mobileCapabilityIdSchema = z.enum(MOBILE_NATIVE_CAPABILITY_IDS);

const sideChatContextSchema = z.object({
  parentSessionId: z.string().min(1),
  originSurface: z.enum(["chat", "cowork", "code"]),
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
  providerId: z.string().optional(),
  model: z.string().optional(),
  routeDecision: routeDecisionSchema.optional(),
  useMemory: z.boolean().optional(),
  attachments: z.array(z.string()).optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  permissionProfileId: z.string().min(1).optional(),
  localOperatorOverrideId: z.string().min(1).optional(),
  policyRunId: z.string().min(1).optional(),
  policyTaskId: z.string().min(1).optional(),
  fullWebAccess: z.boolean().optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  memoryMode: z.enum(["auto", "on", "off"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep"]).optional(),
  speedMode: z.enum(["standard", "fast"]).optional(),
  subagentPolicy: z.enum(["off", "ask_when_useful", "auto_when_useful"]).optional(),
  commandText: z.string().optional(),
  prefsOverride: z
    .object({
      mode: z.enum(["chat", "cowork", "code"]).optional(),
      providerId: z.string().optional(),
      model: z.string().optional(),
      imageProviderId: z.string().optional(),
      imageModel: z.string().optional(),
      webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
      memoryMode: z.enum(["auto", "on", "off"]).optional(),
      thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep"]).optional(),
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

const routePreflightSchema = z.object({
  action: z.enum(["send", "retry", "edit"]),
  turnId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep"]).optional(),
  speedMode: z.enum(["standard", "fast"]).optional(),
  subagentPolicy: z.enum(["off", "ask_when_useful", "auto_when_useful"]).optional(),
  prefsOverride: sendMessageSchema.shape.prefsOverride,
});

const cancelTurnSchema = z.object({
  cancelledBy: z.string().min(1).optional(),
});

const answerUserInputPromptSchema = z.object({
  response: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("single_select"),
      optionId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("text"),
      text: z.string().trim().min(1),
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
      return reply.send({ items });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
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
      });
      if (decisionRejected) {
        return;
      }
      const sent = await fastify.services.chatMessages.agentSendChatMessage(
        params.data.sessionId,
        stampChatOperatorContext(request, body.data),
      );
      return reply.send(sent);
    } catch (error) {
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
      const result = await fastify.services.chatMessages.routePreflight(params.data.sessionId, body.data);
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
      });
      if (decisionRejected) {
        return;
      }
    } catch (error) {
      return sendChatWriteError(reply, error);
    }

    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.services.chatMessages.agentSendChatMessageStream(
        params.data.sessionId,
        stampChatOperatorContext(request, body.data),
        signal,
      ),
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
      return reply.send(detail);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post(
    "/api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/respond",
    async (request, reply) => {
      const params = z
        .object({
          sessionId: z.string().min(1),
          turnId: z.string().min(1),
          promptId: z.string().min(1),
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
        return reply.send(
          await fastify.services.chatMessages.answerChatUserInputPrompt(
            params.data.sessionId,
            params.data.turnId,
            params.data.promptId,
            body.data.response,
          ),
        );
      } catch (error) {
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
      return reply.send(
        await fastify.services.chatMessages.selectChatBranchTurn(params.data.sessionId, params.data.turnId),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
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
      });
      if (decisionRejected) {
        return;
      }
      return reply.send(
        await fastify.services.chatMessages.retryChatTurn(
          params.data.sessionId,
          params.data.turnId,
          stampChatOperatorContext(request, body.data),
        ),
      );
    } catch (error) {
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
      });
      if (decisionRejected) {
        return;
      }
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.services.chatMessages.retryChatTurnStream(
        params.data.sessionId,
        params.data.turnId,
        stampChatOperatorContext(request, body.data),
        signal,
      ),
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
      });
      if (decisionRejected) {
        return;
      }
      return reply.send(
        await fastify.services.chatMessages.editChatTurn(
          params.data.sessionId,
          params.data.turnId,
          stampChatOperatorContext(request, body.data),
        ),
      );
    } catch (error) {
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
      });
      if (decisionRejected) {
        return;
      }
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.services.chatMessages.editChatTurnStream(
        params.data.sessionId,
        params.data.turnId,
        stampChatOperatorContext(request, body.data),
        signal,
      ),
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
      return reply.send(
        await fastify.services.chatMessages.cancelChatTurn(
          params.data.sessionId,
          params.data.turnId,
          body.data.cancelledBy,
        ),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}

async function requireFreshRouteDecision(
  reply: FastifyReply,
  chatMessages: {
    routePreflight: (
      sessionId: string,
      input: z.infer<typeof routePreflightSchema>,
    ) => Promise<{ decision: { fingerprint: string }; blockedReason?: string }>;
  },
  input: {
    sessionId: string;
    action: "send" | "retry" | "edit";
    turnId?: string;
    body: Partial<z.infer<typeof sendMessageSchema>> & { routeDecision?: z.infer<typeof routeDecisionSchema> };
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
    providerId: shouldReplayManualSelection ? decision.requestedProviderId : undefined,
    model: shouldReplayManualSelection ? decision.requestedModel : undefined,
    mode: input.body.mode,
    webMode: input.body.webMode,
    thinkingLevel: input.body.thinkingLevel,
    speedMode: input.body.speedMode,
    subagentPolicy: input.body.subagentPolicy,
    prefsOverride: replayedPrefsOverride,
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
