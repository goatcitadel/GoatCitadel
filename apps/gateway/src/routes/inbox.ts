import type { FastifyRequest, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { projectPublicSecretValue } from "../services/public-secret-projection.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const inboxQuerySchema = z
  .object({
    workspaceId: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9._-]+$/),
  })
  .strict();

const readSchema = z
  .object({
    workspaceId: inboxQuerySchema.shape.workspaceId,
    updates: z
      .array(
        z
          .object({
            id: z.string().min(1).max(240),
            version: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
/** Access is enforced first; configured auth mode does not establish identity. */
function inboxActor(request: FastifyRequest): string | undefined {
  return ["token", "basic"].includes(request.authActorSource) &&
    !request.authPrincipalPurpose &&
    request.authActorId &&
    request.authActorId !== "anonymous"
    ? JSON.stringify([request.authActorSource, request.authActorId])
    : undefined;
}
export const inboxRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.get("/api/v1/inbox", operatorOnly, async (request, reply) => {
    const parsed = inboxQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid inbox query." });
    try {
      try {
        await fastify.services.workspaces.getWorkspace(parsed.data.workspaceId);
      } catch {
        return reply.code(404).send({ error: "Workspace not found." });
      }
      reply.header("Cache-Control", "private, no-store");
      const projection = await fastify.services.inbox.getReadProjection(
        parsed.data.workspaceId,
        inboxActor(request),
        (source, error) => {
          request.log.warn(
            { source, errorName: error instanceof Error ? error.name : "unknown" },
            "Inbox owner unavailable",
          );
        },
      );
      return reply.send(projectPublicSecretValue(projection));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
  fastify.post("/api/v1/inbox/updates/read", operatorOnly, async (request, reply) => {
    const parsed = readSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid inbox read request." });
    try {
      try {
        await fastify.services.workspaces.getWorkspace(parsed.data.workspaceId);
      } catch {
        return reply.code(404).send({ error: "Workspace not found." });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(
        await fastify.services.inbox.acknowledgeUpdates(
          parsed.data.workspaceId,
          inboxActor(request),
          parsed.data.updates,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
