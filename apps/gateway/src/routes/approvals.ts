import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const createSchema = z.object({
  kind: z.string().min(1),
  riskLevel: z.enum(["safe", "caution", "danger", "nuclear"]),
  payload: z.record(z.unknown()),
  preview: z.record(z.unknown()),
  linkage: z
    .object({
      sessionId: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      workspaceId: z.string().min(1).optional(),
      durableRunId: z.string().min(1).optional(),
      proactiveRunId: z.string().min(1).optional(),
      connectorId: z.string().min(1).optional(),
      traceId: z.string().min(1).optional(),
    })
    .optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  sourceConnectorId: z.string().min(1).optional(),
  sourceTraceId: z.string().min(1).optional(),
});

const resolveSchema = z.object({
  decision: z.enum(["approve", "reject", "edit"]),
  editedPayload: z.record(z.unknown()).optional(),
  resolutionNote: z.string().optional(),
  resolvedBy: z.string().min(1),
});

const bulkResolveSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  resolutionNote: z.string().optional(),
  resolvedBy: z.string().min(1).optional(),
  status: z.literal("pending").optional(),
});

const remoteTokenSchema = z.object({
  connectorId: z.string().min(1),
  expiresInMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional(),
});

const remoteResolveSchema = z.object({
  token: z.string().min(1),
  decision: z.enum(["approve", "reject", "edit"]),
  editedPayload: z.record(z.unknown()).optional(),
  resolutionNote: z.string().optional(),
});

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "edited"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const REMOTE_APPROVAL_CREATE_TOKEN_HEADER = "x-goatcitadel-approval-create-token";

export const approvalsRoutes: FastifyPluginAsync = async (fastify) => {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
  const operatorOnly = withRouteAccess(fastify, "operator");
  const approvals = fastify.services.approvals;

  fastify.post("/api/v1/approvals", withRouteAccess(fastify, "webhook"), async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const ingress = validateApprovalCreateIngress(request, parsed.data);
    if (!ingress.ok) {
      return reply.code(ingress.statusCode).send({ error: ingress.error });
    }

    if (!request.idempotencyKey?.trim()) {
      return reply.code(400).send({
        error: "Idempotency-Key header is required for approval creation.",
      });
    }

    if (ingress.kind === "remote" && (!parsed.data.sourceConnectorId || !parsed.data.sourceTraceId)) {
      return reply.code(400).send({
        error: "Remote approval creation requires sourceConnectorId and sourceTraceId.",
      });
    }

    if (ingress.kind !== "remote" && !isLoopbackRequest(request) && !isOperatorAuthenticatedRequest(request)) {
      return reply.code(403).send({
        error:
          "Approval creation is restricted to loopback, operator-authenticated, or scoped remote-connector callers.",
      });
    }

    const { sourceConnectorId, sourceTraceId, ...approvalInput } = parsed.data;
    const linkage = {
      ...(approvalInput.linkage ?? {}),
      ...(sourceConnectorId ? { connectorId: sourceConnectorId } : {}),
      ...(sourceTraceId ? { traceId: sourceTraceId } : {}),
    };

    try {
      const approval = await approvals.createApproval({
        ...approvalInput,
        ...(Object.keys(linkage).length > 0 ? { linkage } : {}),
      });
      return reply.code(201).send(approval);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/approvals", operatorOnly, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send({ items: approvals.listApprovals(parsed.data.status, parsed.data.limit) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/approvals/bulk-resolve", operatorOnly, async (request, reply) => {
    const parsed = bulkResolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const result = await approvals.resolveApprovalsBulk({
        ...parsed.data,
        resolvedBy: parsed.data.resolvedBy ?? resolveActorId(request),
      });
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/approvals/:approvalId/resolve", operatorOnly, async (request, reply) => {
    const params = z.object({ approvalId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid approval ID format." });
    }
    const approvalId = params.data.approvalId;
    const parsed = resolveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const result = await approvals.resolveApproval(approvalId, parsed.data);
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/approvals/:approvalId/remote-token", operatorOnly, async (request, reply) => {
    const params = z.object({ approvalId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid approval ID format." });
    }
    const parsed = remoteTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const token = approvals.createApprovalRemoteActionToken(params.data.approvalId, {
        connectorId: parsed.data.connectorId,
        expiresInMs: parsed.data.expiresInMs,
        issuedBy: resolveActorId(request),
      });
      return reply.code(201).send(token);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/approvals/remote-resolve", withRouteAccess(fastify, "public"), async (request, reply) => {
    const parsed = remoteResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const result = await approvals.resolveApprovalWithRemoteToken(parsed.data);
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/approvals/:approvalId/replay", operatorOnly, async (request, reply) => {
    const params = z.object({ approvalId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid approval ID format." });
    }
    const approvalId = params.data.approvalId;
    const query = request.query as { replayedBy?: string };
    try {
      return reply.send(approvals.getApprovalReplay(approvalId, query.replayedBy ?? "operator"));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};

function isLoopbackRequest(request: {
  ip?: string;
  raw: { socket: { remoteAddress?: string | null } };
  headers: Record<string, unknown>;
}): boolean {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return false;
  }
  const remoteAddress = request.raw.socket.remoteAddress ?? request.ip ?? "";
  const normalized = remoteAddress.replace("::ffff:", "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1";
}

function isOperatorAuthenticatedRequest(request: { authActorSource?: string }): boolean {
  return (
    request.authActorSource === "token" || request.authActorSource === "basic" || request.authActorSource === "loopback"
  );
}

function validateApprovalCreateIngress(
  request: {
    headers: Record<string, unknown>;
    authActorSource?: string;
    ip?: string;
    raw: { socket: { remoteAddress?: string | null } };
  },
  input: { sourceConnectorId?: string; sourceTraceId?: string },
): { ok: true; kind: "local" | "operator" | "remote" } | { ok: false; statusCode: 401 | 403; error: string } {
  if (isLoopbackRequest(request)) {
    return { ok: true, kind: "local" };
  }
  if (isOperatorAuthenticatedRequest(request)) {
    return { ok: true, kind: "operator" };
  }

  const configuredToken = resolveRemoteApprovalCreateToken();
  if (!configuredToken) {
    return {
      ok: false,
      statusCode: 403,
      error: "Remote approval creation is disabled because no scoped approval-create token is configured.",
    };
  }

  const providedToken = readHeader(request.headers[REMOTE_APPROVAL_CREATE_TOKEN_HEADER]);
  if (!providedToken || !timingSafeStringEqual(providedToken, configuredToken)) {
    return {
      ok: false,
      statusCode: 401,
      error: "A valid scoped approval-create token is required for remote approval creation.",
    };
  }

  if (!input.sourceConnectorId || !input.sourceTraceId) {
    return {
      ok: false,
      statusCode: 403,
      error: "Remote approval creation requires sourceConnectorId and sourceTraceId.",
    };
  }

  return { ok: true, kind: "remote" };
}

function resolveRemoteApprovalCreateToken(): string | undefined {
  const envName = process.env.GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN_ENV?.trim();
  const fromNamedEnv = envName ? process.env[envName]?.trim() : undefined;
  return fromNamedEnv || process.env.GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN?.trim() || undefined;
}

function readHeader(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    const comparableLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
    const leftComparable = Buffer.alloc(comparableLength);
    const rightComparable = Buffer.alloc(comparableLength);
    leftBuffer.copy(leftComparable);
    rightBuffer.copy(rightComparable);
    timingSafeEqual(leftComparable, rightComparable);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
