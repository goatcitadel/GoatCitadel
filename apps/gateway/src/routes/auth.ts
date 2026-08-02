import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { markMutationCommitted } from "../plugins/idempotency.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

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

const companionSessionExchangeSchema = z.object({
  signingPublicKeyPem: z.string().trim().min(1).max(4096),
  clientName: z.string().trim().min(1).max(120).optional(),
  appVersion: z.string().trim().min(1).max(80).optional(),
});

const companionSessionRefreshSchema = z.object({
  refreshToken: z.string().trim().min(1).max(4096),
});

const companionSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

const companionSessionListQuerySchema = z.object({
  view: z.enum(["active", "all"]).default("active"),
  grantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const companionAuditQuerySchema = z.object({
  sessionId: z.string().uuid().optional(),
  grantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const sseTokenIssueSchema = z.object({
  scope: z.enum(["events:stream", "dev:diagnostics:stream"]).default("events:stream"),
});

const RATE_LIMIT_READ_MAX = 500;
const RATE_LIMIT_MUTATION_MAX = 180;
const RATE_LIMIT_AUTH_MAX = 60;

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorReadRoute = withRouteAccess(fastify, "operator", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_READ_MAX,
      },
    },
  });
  const operatorMutationRoute = withRouteAccess(fastify, "operator", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_MUTATION_MAX,
      },
    },
  });
  const operatorAuthRoute = withRouteAccess(fastify, "operator", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_AUTH_MAX,
      },
    },
  });
  const publicReadRoute = withRouteAccess(fastify, "public", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_READ_MAX,
      },
    },
  });
  const publicAuthRoute = withRouteAccess(fastify, "public", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_AUTH_MAX,
      },
    },
  });
  const deviceSessionExchangeRoute = withRouteAccess(fastify, "device-session-exchange", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_AUTH_MAX,
      },
    },
  });
  const companionReadRoute = withRouteAccess(fastify, "companion", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_READ_MAX,
      },
    },
  });
  const authAdmin = fastify.services.authAdmin;

  fastify.post("/api/v1/auth/sse-token", operatorAuthRoute, async (request, reply) => {
    const authMode = fastify.gatewayConfig.assistant.auth.mode;
    if (authMode === "none") {
      return reply.send({
        scope: "events:stream",
        authMode: "none",
      });
    }
    const parsed = sseTokenIssueSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const token = fastify.issueSseToken(parsed.data.scope, undefined, request.authActorId);
    return reply.send(token);
  });

  fastify.post(
    "/api/v1/auth/device-requests",
    withRouteAccess(fastify, "public", {
      config: {
        rateLimit: {
          max: 5,
        },
      },
    }),
    async (request, reply) => {
      const parsed = createDeviceRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        const created = await authAdmin.createDeviceAccessRequest(parsed.data, {
          requestedOrigin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
          requestedIp: request.raw.socket.remoteAddress ?? request.ip,
          userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
          correlationId: readHeaderValue(request.headers["x-goatcitadel-correlation-id"]),
          traceId: readTraceId(request.headers.traceparent, request.headers["x-goatcitadel-correlation-id"]),
          originSurface: readHeaderValue(request.headers["x-goatcitadel-origin-surface"]),
        });
        markMutationCommitted(request);
        return reply.code(201).send(created);
      } catch (error) {
        return reply.code(400).send({
          error: (error as Error).message,
        });
      }
    },
  );

  fastify.post("/api/v1/auth/companion/session/exchange", deviceSessionExchangeRoute, async (request, reply) => {
    if (request.authActorSource !== "device" || !request.authGrantId) {
      return reply.code(403).send({
        error: "Companion session exchange requires an approved device grant.",
      });
    }
    const parsed = companionSessionExchangeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await authAdmin.exchangeCompanionSessionFromDeviceGrant(request.authGrantId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/auth/companion/session/refresh", publicAuthRoute, async (request, reply) => {
    const parsed = companionSessionRefreshSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await authAdmin.rotateCompanionSession(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/auth/companion/session", companionReadRoute, async (request, reply) => {
    if (request.authActorSource !== "companion" || !request.authCompanionSessionId) {
      return reply.code(403).send({
        error: "Companion session access requires companion authentication.",
      });
    }
    try {
      return reply.send(authAdmin.getCompanionSessionInfo(request.authCompanionSessionId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/auth/companion/sessions", operatorReadRoute, async (request, reply) => {
    const parsed = companionSessionListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(authAdmin.listCompanionSessions(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/auth/companion/sessions/:sessionId", operatorReadRoute, async (request, reply) => {
    const params = companionSessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(authAdmin.getCompanionSessionRecord(params.data.sessionId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/auth/companion/sessions/:sessionId/revoke", operatorMutationRoute, async (request, reply) => {
    const params = companionSessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      // C0/C run inside the auth-revoke transaction (revokeByAuthBinding). The
      // HTTP mutation is only marked complete once that canonical commit returns,
      // so a later transport failure cannot revive the Idempotency-Key.
      const result = await authAdmin.revokeCompanionSession(params.data.sessionId, request.authActorId, {
        correlationId: readHeaderValue(request.headers["x-goatcitadel-correlation-id"]),
      });
      // Runs AFTER the service's post-commit publishRealtime: if that publish
      // throws, this is skipped and the Idempotency-Key is revived, so a retry
      // re-runs the revoke — safe only because revoke is idempotent (COALESCE
      // guards make re-revoking an already-revoked session a no-op).
      markMutationCommitted(request);
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/auth/companion/audit", operatorReadRoute, async (request, reply) => {
    const parsed = companionAuditQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: await authAdmin.listCompanionAuditEvents(parsed.data),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/auth/plan", publicReadRoute, async (_request, reply) => {
    return reply.send(authAdmin.getAuthCredentialPlan());
  });

  fastify.get("/api/v1/auth/devices", operatorReadRoute, async (request, reply) => {
    const parsed = deviceGrantListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const items = authAdmin.listDeviceAccessGrants().filter((item) => parsed.data.view === "all" || !item.revokedAt);
    return reply.send({ items });
  });

  fastify.post("/api/v1/auth/devices/:grantId/revoke", operatorMutationRoute, async (request, reply) => {
    const params = deviceGrantParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }

    try {
      // C0/C run inside the auth-revoke transaction (revokeByAuthBinding). Only
      // once that canonical commit returns is the HTTP mutation marked complete.
      const grant = await authAdmin.revokeDeviceAccessGrant(params.data.grantId, request.authActorId, {
        correlationId: readHeaderValue(request.headers["x-goatcitadel-correlation-id"]),
      });
      // Runs AFTER the service's post-commit publishRealtime: if that publish
      // throws, this is skipped and the Idempotency-Key is revived, so a retry
      // re-runs the revoke — safe only because revoke is idempotent (COALESCE
      // guards make re-revoking an already-revoked grant a no-op).
      markMutationCommitted(request);
      return reply.send({ grant });
    } catch (error) {
      const message = (error as Error).message;
      const statusCode = /not found/i.test(message) ? 404 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  fastify.post(
    "/api/v1/auth/install-token",
    withRouteAccess(fastify, "operator", {
      config: {
        rateLimit: {
          max: 5,
        },
      },
    }),
    async (request, reply) => {
      const parsed = installTokenSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        return reply.send(await authAdmin.resolveGatewayInstallToken(parsed.data));
      } catch (error) {
        return reply.code(400).send({
          error: (error as Error).message,
        });
      }
    },
  );

  fastify.get("/api/v1/auth/device-requests/:requestId/status", publicAuthRoute, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const existingVary = reply.getHeader("Vary");
    reply.header(
      "Vary",
      typeof existingVary === "string" && existingVary.trim()
        ? `${existingVary}, x-goatcitadel-device-request-secret`
        : "x-goatcitadel-device-request-secret",
    );
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
      const status = await authAdmin.getDeviceAccessRequestStatus(
        params.data.requestId,
        headers.data["x-goatcitadel-device-request-secret"],
      );
      return reply.send(status);
    } catch {
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
