import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const createDeviceRequestSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(120).optional(),
  deviceType: z.enum(["mobile", "desktop", "tablet", "browser", "unknown"]).optional(),
  platform: z.string().trim().min(1).max(120).optional(),
});

const deviceRequestParamsSchema = z.object({
  requestId: z.string().uuid(),
});

const deviceGrantParamsSchema = z.object({
  grantId: z.string().uuid(),
});

const deviceGrantListQuerySchema = z.object({
  view: z.enum(["active", "all"]).default("active"),
});

const deviceRequestSecretHeaderSchema = z.object({
  "x-goatcitadel-device-request-secret": z.string().trim().min(16).max(256),
});

const installTokenSchema = z.object({
  token: z.string().trim().min(16).max(4096).optional(),
  generateWhenMissing: z.boolean().optional(),
  persistToEnv: z.boolean().optional(),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/auth/sse-token", async (_request, reply) => {
    const authMode = fastify.gatewayConfig.assistant.auth.mode;
    if (authMode === "none") {
      return reply.code(400).send({
        error: "SSE token bridge is not needed when auth mode is none",
      });
    }
    const token = fastify.issueSseToken("events:stream");
    return reply.send(token);
  });

  fastify.post("/api/v1/auth/device-requests", async (request, reply) => {
    const parsed = createDeviceRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const created = await fastify.gateway.createDeviceAccessRequest(parsed.data, {
        requestedOrigin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        requestedIp: request.raw.socket.remoteAddress ?? request.ip,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
        correlationId: readHeaderValue(request.headers["x-goatcitadel-correlation-id"]),
        traceId: readTraceId(request.headers.traceparent, request.headers["x-goatcitadel-correlation-id"]),
        originSurface: readHeaderValue(request.headers["x-goatcitadel-origin-surface"]),
      });
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({
        error: (error as Error).message,
      });
    }
  });

  fastify.get("/api/v1/auth/plan", async (_request, reply) => {
    return reply.send(fastify.gateway.getAuthCredentialPlan());
  });

  fastify.get("/api/v1/auth/devices", async (request, reply) => {
    const parsed = deviceGrantListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const items = fastify.gateway
      .listDeviceAccessGrants()
      .filter((item) => parsed.data.view === "all" || !item.revokedAt);
    return reply.send({ items });
  });

  fastify.post("/api/v1/auth/devices/:grantId/revoke", async (request, reply) => {
    const params = deviceGrantParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }

    try {
      const grant = await fastify.gateway.revokeDeviceAccessGrant(
        params.data.grantId,
        request.authActorId,
      );
      return reply.send({ grant });
    } catch (error) {
      const message = (error as Error).message;
      const statusCode = /not found/i.test(message) ? 404 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  fastify.post("/api/v1/auth/install-token", async (request, reply) => {
    const parsed = installTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(await fastify.gateway.resolveGatewayInstallToken(parsed.data));
    } catch (error) {
      return reply.code(400).send({
        error: (error as Error).message,
      });
    }
  });

  fastify.get("/api/v1/auth/device-requests/:requestId/status", async (request, reply) => {
    const params = deviceRequestParamsSchema.safeParse(request.params);
    const headers = deviceRequestSecretHeaderSchema.safeParse(request.headers);
    if (!params.success || !headers.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          headers: headers.success ? undefined : headers.error.flatten(),
        },
      });
    }

    try {
      const status = await fastify.gateway.getDeviceAccessRequestStatus(
        params.data.requestId,
        headers.data["x-goatcitadel-device-request-secret"],
      );
      return reply.send(status);
    } catch (error) {
      return reply.code(404).send({
        error: "Device access request not found.",
      });
    }
  });
};

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTraceId(
  traceparent: string | string[] | undefined,
  correlationId: string | string[] | undefined,
): string | undefined {
  const rawTraceparent = readHeaderValue(traceparent);
  if (rawTraceparent) {
    const parts = rawTraceparent.split("-");
    if (parts.length >= 4 && parts[1]?.length === 32) {
      return parts[1];
    }
  }
  return readHeaderValue(correlationId);
}
