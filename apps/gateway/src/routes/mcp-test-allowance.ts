import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { markMutationCommitted } from "../plugins/idempotency.js";
import { isLoopbackHost } from "../startup-guard.js";
import { sendRouteError } from "./_error-handler.js";

const url = "/api/v1/settings/mcp-test-allowance";
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const selection = z
  .object({
    serverId: z.string().uuid(),
    serverRevision: revision,
    connectionRevision: revision,
    toolName: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
    workspaceId: z.string().min(1).max(128),
    sessionId: z
      .string()
      .regex(/^sess_[a-f0-9]+$/u)
      .max(128),
  })
  .strict();
const revocation = z.object({ allowanceId: z.string().uuid() }).strict();
const options = { config: { rateLimit: { max: 60 } } };

function readActor(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const socketAddress = request.raw.socket.remoteAddress?.replace(/^::ffff:/u, "") ?? "";
  if (request.authActorSource !== "token" || !request.authActorId || !isLoopbackHost(socketAddress)) {
    reply.code(403).send({ error: "Temporary MCP allowances require local Gateway token sign-in." });
    return undefined;
  }
  return request.authActorId;
}

export const mcpTestAllowanceRoutes: FastifyPluginAsync = async (app) => {
  const service = app.gatewayRuntime.localMcpFixtureTest;

  app.get(url, options, async (request, reply) => {
    const actor = readActor(request, reply);
    if (!actor) return;
    reply.header("Cache-Control", "no-store");
    return service.status(actor);
  });

  app.post(url, options, async (request, reply) => {
    const actor = readActor(request, reply);
    if (!actor) return;
    const input = selection.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Choose a Chat and an eligible MCP test tool." });
    try {
      const allowance = await service.activate(actor, input.data);
      await markMutationCommitted(request);
      request.log.info({ actor, ...allowance }, "Temporary MCP test allowance activated");
      return reply.code(201).send(allowance);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  app.post(url + "/revoke", options, async (request, reply) => {
    const actor = readActor(request, reply);
    if (!actor) return;
    const input = revocation.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "A current allowance is required." });
    const { allowanceId } = input.data;
    if (!service.revoke(actor, allowanceId)) {
      return reply.code(409).send({ error: "The temporary allowance is no longer active." });
    }
    await markMutationCommitted(request);
    request.log.info({ actor, allowanceId }, "Temporary MCP test allowance revoked");
    return { revoked: true };
  });
};
