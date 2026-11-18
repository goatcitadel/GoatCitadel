import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { resolveAuthenticatedOperatorAdmissionContext } from "./session-control-request-context.js";
import { markMutationCommitted } from "../plugins/idempotency.js";
import { redactSecretText } from "@goatcitadel/contracts";

const SCRIPT_PREVIEW_LIMIT = 64 * 1024;
const scope = z.object({ workspaceId: z.string().trim().min(1).max(256) });
const retention = scope
  .extend({
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    retention: z.enum(["temporary", "permanent"]),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
/** Local operator inventory: preserves Managed Files' local-operator boundary. */
export const scriptsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preValidation", async (request, reply) => {
    if (!resolveAuthenticatedOperatorAdmissionContext(request)?.directLocal)
      return reply.code(403).send({ error: "Scripts requires a local operator connection." });
  });
  app.get("/api/v1/scripts", { config: { rateLimit: { max: 120 } } }, async (request, reply) => {
    const input = scope.safeParse(request.query);
    if (!input.success) return reply.code(400).send({ error: "Choose a workspace." });
    try {
      return reply.header("Cache-Control", "no-store").send(await app.services.scripts!.list(input.data.workspaceId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
  app.patch("/api/v1/scripts/retention", { config: { rateLimit: { max: 60 } } }, async (request, reply) => {
    const input = retention.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Invalid retention change." });
    try {
      const item = await app.services.scripts!.update(input.data, request.authActorId);
      await markMutationCommitted(request);
      return reply.send(item);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
  app.get("/api/v1/scripts/:id/preview", { config: { rateLimit: { max: 120 } } }, async (request, reply) => {
    const query = scope.safeParse(request.query);
    const params = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u) }).safeParse(request.params);
    if (!query.success || !params.success) return reply.code(400).send({ error: "Invalid preview request." });
    try {
      const item = (await app.services.scripts!.list(query.data.workspaceId)).items.find(
        (item) => item.id === params.data.id,
      );
      if (!item) return reply.code(404).send({ error: "This item is no longer in Scripts. Refresh the list." });
      let content: string;
      let truncated = false;
      reply.header("Cache-Control", "no-store");
      if (item.kind === "generated")
        content = (
          await app.services.chatSessions.getChatGeneratedArtifact(item.sourceId, { workspaceId: item.workspaceId })
        ).content;
      else if (item.kind === "tool")
        content = (
          await app.services.chatTools.getChatToolArtifactContent(item.sourceId, { workspaceId: item.workspaceId })
        ).content;
      else if (item.kind === "code" && item.runId)
        content = (
          await app.services.capabilities.getCodeModeRunArtifactPreview(item.runId, "source", {
            workspaceId: item.workspaceId,
          })
        ).content;
      else if (item.kind === "managed" && item.sessionId && item.path && item.revision) {
        const file = await app.services.chatSessions.downloadManagedProjectFile(item.sessionId, request.authActorId, {
          path: item.path,
          revisionId: item.revision,
        });
        truncated = file.bytes.length > SCRIPT_PREVIEW_LIMIT;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes.subarray(0, SCRIPT_PREVIEW_LIMIT), {
            stream: truncated,
          });
        } catch {
          content = "This file is not UTF-8 text. Open its source conversation to use the original download.";
          truncated = false;
        }
      } else if (item.kind === "workspace" && item.path) {
        const file = await app.services.files.downloadWorkspaceFile(item.path, {
          maxBytes: SCRIPT_PREVIEW_LIMIT,
          readPrefix: true,
        });
        if (!file.isText)
          return reply.send({
            content:
              "This file needs its native application. Open its source conversation to use the original download.",
          });
        content = String(file.content);
        truncated = file.truncated ?? false;
      } else
        return reply.code(409).send({
          error:
            "Preview is unavailable here. Open the source or project to inspect this item with its existing access controls.",
        });
      return reply.header("Cache-Control", "no-store").send({
        content: redactSecretText(content.slice(0, SCRIPT_PREVIEW_LIMIT)).value,
        truncated: truncated || content.length > SCRIPT_PREVIEW_LIMIT,
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
