import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CAPABILITY_RESOURCE_TYPES } from "@goatcitadel/contracts";
import { withRouteAccess } from "./route-access.js";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted } from "../plugins/idempotency.js";

const resourceTypeSchema = z.enum(CAPABILITY_RESOURCE_TYPES);
const citadelParams = z.object({ citadelId: z.string().min(1) });
const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const typeQuery = z.object({ type: resourceTypeSchema });
const updateBody = z.object({
  resourceType: resourceTypeSchema,
  assignments: z.array(z.object({ resourceRef: z.string().min(1), enabled: z.boolean() })),
});
const reviewedBody = z
  .object({
    resourceType: resourceTypeSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    assignments: z
      .array(z.object({ resourceRef: z.string().min(1).max(512), enabled: z.boolean() }).strict())
      .max(1000),
  })
  .strict();
const reviewedResetBody = reviewedBody
  .omit({ assignments: true })
  .transform((body): z.infer<typeof reviewedBody> => ({ ...body, assignments: [] }));

export const capabilityScopeRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const svc = fastify.services.capabilityScope;

  // Separate paths deliberately fail closed against an older Gateway. Legacy
  // replacement/reset routes keep their original contracts for existing clients.
  for (const scopeKind of ["citadel", "workspace"] as const) {
    const prefix = scopeKind === "citadel" ? "citadels" : "workspaces";
    for (const method of ["PATCH", "DELETE"] as const) {
      fastify.route({
        method,
        url: `/api/v1/${prefix}/:scopeId/capabilities/reviewed`,
        ...operatorOnly,
        handler: async (request, reply) => {
          const params = z.object({ scopeId: z.string().min(1).max(200) }).safeParse(request.params);
          const body = (method === "PATCH" ? reviewedBody : reviewedResetBody).safeParse(request.body ?? {});
          if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
          if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
          let committed = false;
          try {
            const receipt = await svc.applyReviewedSelection(scopeKind, params.data.scopeId, body.data);
            committed = true;
            await markMutationCommitted(request);
            return reply.send(receipt);
          } catch (error) {
            if (!committed && !request.mutationCommitted) return sendRouteError(reply, error, request.log);
            return reply.code(500).send({
              error: "The capability selection was committed, but its response could not be completed.",
              mutationCommitted: true,
            });
          }
        },
      });
    }
  }

  // ---- Citadel ----

  fastify.get("/api/v1/citadels/:citadelId/capabilities", operatorOnly, async (request, reply) => {
    const params = citadelParams.safeParse(request.params);
    const query = typeQuery.safeParse(request.query);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(await svc.getView("citadel", params.data.citadelId, query.data.type));
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
      return reply.send(await svc.updateScope("citadel", params.data.citadelId, body.data));
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
      return reply.send(await svc.resetScope("citadel", params.data.citadelId, query.data.type));
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
      return reply.send(await svc.getView("workspace", params.data.workspaceId, query.data.type));
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
      return reply.send(await svc.updateScope("workspace", params.data.workspaceId, body.data));
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
      return reply.send(await svc.resetScope("workspace", params.data.workspaceId, query.data.type));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
