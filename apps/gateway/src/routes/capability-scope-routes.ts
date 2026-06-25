import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CAPABILITY_RESOURCE_TYPES } from "@goatcitadel/contracts";
import { withRouteAccess } from "./route-access.js";
import { sendRouteError } from "./_error-handler.js";

const resourceTypeSchema = z.enum(CAPABILITY_RESOURCE_TYPES);
const citadelParams = z.object({ citadelId: z.string().min(1) });
const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const typeQuery = z.object({ type: resourceTypeSchema });
const updateBody = z.object({
  resourceType: resourceTypeSchema,
  assignments: z.array(z.object({ resourceRef: z.string().min(1), enabled: z.boolean() })),
});

export const capabilityScopeRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const svc = fastify.services.capabilityScope;

  // ---- Citadel ----

  fastify.get("/api/v1/citadels/:citadelId/capabilities", operatorOnly, async (request, reply) => {
    const params = citadelParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.getView("citadel", params.data.citadelId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/citadels/:citadelId/capabilities", operatorOnly, async (request, reply) => {
    const params = citadelParams.safeParse(request.params);
    const body = updateBody.safeParse(request.body ?? {});
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return reply.send(svc.updateScope("citadel", params.data.citadelId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/capabilities", operatorOnly, async (request, reply) => {
    const params = citadelParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.resetScope("citadel", params.data.citadelId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // ---- Workspace ----

  fastify.get("/api/v1/workspaces/:workspaceId/capabilities", operatorOnly, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.getView("workspace", params.data.workspaceId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/workspaces/:workspaceId/capabilities", operatorOnly, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const body = updateBody.safeParse(request.body ?? {});
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return reply.send(svc.updateScope("workspace", params.data.workspaceId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/workspaces/:workspaceId/capabilities", operatorOnly, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(svc.resetScope("workspace", params.data.workspaceId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
