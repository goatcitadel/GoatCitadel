import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const createSchema = z.object({
  kind: z.string().min(1),
  riskLevel: z.enum(["safe", "caution", "danger", "nuclear"]),
  payload: z.record(z.unknown()),
  preview: z.record(z.unknown()),
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

export const approvalsRoutes: FastifyPluginAsync = async (fastify) => {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
  const operatorOnly = withRouteAccess(fastify, "operator");
  const approvals = fastify.services.approvals;

  fastify.post("/api/v1/approvals", withRouteAccess(fastify, "public"), async (request, reply) => {
    const allowRemoteCreate = isTruthy(process.env.GOATCITADEL_ALLOW_REMOTE_APPROVAL_CREATE);
    if (!allowRemoteCreate && !isLoopbackRequest(request)) {
      return reply.code(403).send({
        error: "Approval creation is restricted to loopback callers.",
      });
    }

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const approval = await approvals.createApproval(parsed.data);
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

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
