import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";
import { sendChatWriteError } from "./chat.shared.js";

const secureConfigurationParamsSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  promptId: z.string().trim().min(1).max(96),
});

const secureConfigurationSubmitSchema = z
  .object({
    secret: z.string().min(1).max(8_192),
  })
  .strict();

export function registerChatSecureConfigurationRoute(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/secure-configuration",
    {
      logLevel: "silent",
      bodyLimit: 10_240,
      config: {
        rateLimit: {
          // This credential-bearing endpoint must remain bounded even though
          // ordinary loopback traffic is exempt from the global limiter.
          allowList: () => false,
          // One actor/IP bucket covers every secure prompt. Including path
          // parameters would let an attacker split the quota across arbitrary
          // session, turn, or prompt IDs before validation.
          keyGenerator: (request) => `${request.ip}:${request.authActorId || "unauthenticated"}:secure-configuration`,
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      if (!isStrictLoopbackSecureSubmission(request)) {
        return reply.code(403).send({
          error: "Secure Chat configuration is currently limited to a direct loopback Mission Control connection.",
        });
      }
      const params = secureConfigurationParamsSchema.safeParse(request.params);
      const body = secureConfigurationSubmitSchema.safeParse(request.body);
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
          { kind: "secure_configuration", secret: body.data.secret },
          {
            actorId: request.authActorId,
            authActorSource: request.authActorSource,
          },
        );
        await markMutationCommitted(request);
        return reply.send(result);
      } catch (error) {
        await markMutationCommittedFromError(request, error);
        return sendChatWriteError(reply, error);
      }
    },
  );
}

function isStrictLoopbackSecureSubmission(request: FastifyRequest): boolean {
  const hasProxyProvenance =
    "x-forwarded-for" in request.headers ||
    "x-real-ip" in request.headers ||
    "forwarded" in request.headers ||
    (Array.isArray(request.ips) && request.ips.length > 1);
  if (hasProxyProvenance) return false;
  const remoteAddress = (request.raw.socket.remoteAddress ?? request.ip ?? "")
    .replace("::ffff:", "")
    .trim()
    .toLowerCase();
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1";
}
