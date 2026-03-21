import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

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

const remoteTokenSchema = z.object({
  connectorId: z.string().min(1),
  expiresInMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
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

  fastify.post("/api/v1/approvals", async (request, reply) => {
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

    const approval = await fastify.gateway.createApproval(parsed.data);
    return reply.code(201).send(approval);
  });

  fastify.get("/api/v1/approvals", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const approvals = fastify.gateway.listApprovals(parsed.data.status, parsed.data.limit);
    return reply.send({ items: approvals });
  });

  fastify.post("/api/v1/approvals/:approvalId/resolve", async (request, reply) => {
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
      const result = await fastify.gateway.resolveApproval(approvalId, parsed.data);
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/approvals/:approvalId/remote-token", async (request, reply) => {
    const params = z.object({ approvalId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid approval ID format." });
    }
    const parsed = remoteTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const token = fastify.gateway.createApprovalRemoteActionToken(params.data.approvalId, {
        connectorId: parsed.data.connectorId,
        expiresInMs: parsed.data.expiresInMs,
        issuedBy: resolveActorId(request),
      });
      return reply.code(201).send(token);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/approvals/remote-resolve", async (request, reply) => {
    const parsed = remoteResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const result = await fastify.gateway.resolveApprovalWithRemoteToken(parsed.data);
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/approvals/:approvalId/replay", async (request, reply) => {
    const params = z.object({ approvalId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid approval ID format." });
    }
    const approvalId = params.data.approvalId;
    const query = request.query as { replayedBy?: string };
    const replay = fastify.gateway.getApprovalReplay(approvalId, query.replayedBy ?? "operator");
    return reply.send(replay);
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
