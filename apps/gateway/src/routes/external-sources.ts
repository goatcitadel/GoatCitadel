import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH,
  normalizeExternalSessionAttachInput,
  normalizeExternalSessionAttachmentListInput,
  normalizeExternalSessionDetachInput,
  normalizeExternalSourceCatalogListInput,
  normalizeExternalSourceCreateInput,
  normalizeExternalSourceImportApplyInput,
  normalizeExternalSourceImportPlanInput,
  normalizeExternalSourceKnowledgeSnapshotRequestInput,
  normalizeExternalSourceScanInput,
  normalizeExternalSourceUpdateInput,
} from "@goatcitadel/contracts";
import type { ExternalSourceRoutePort } from "../services/external-source-route-service.js";
import { ExternalSourceAttachmentServiceError } from "../services/external-source-attachment-service.js";
import { ExternalSourceImportServiceError } from "../services/external-source-import-service.js";
import { ExternalSourceKnowledgeEffectServiceError } from "../services/external-source-knowledge-effect-service.js";
import { ExternalSourceServiceError, type ExternalSourceRequestActor } from "../services/external-source-service.js";
import { withRouteAccess } from "./route-access.js";

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

const canonicalText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.normalize("NFKC").trim() && !hasAsciiControlCharacter(value));
const identifier = canonicalText(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceKind = z.enum(["codex_sessions", "codex_memory", "claude_sessions", "claude_memory"]);
const sourceStatus = z.enum(["active", "disabled", "revoked"]);
const pathFlavor = z.enum(["windows_native", "windows_forward", "msys", "wsl", "posix"]);
const disposition = z.enum(["supported", "unsupported_variant", "quarantined", "conflicting", "blocked"]);
const producerVersions = z.array(canonicalText(128)).max(64);
const sourceParamsSchema = z.object({ sourceId: identifier }).strict();
const workspaceQuerySchema = z.object({ workspaceId: identifier }).strict();
const createBodySchema = z
  .object({
    workspaceId: identifier,
    expectedWorkspaceRevision: z.number().int().positive().safe(),
    kind: sourceKind,
    label: z.string().min(1).max(512),
    canonicalRootPath: z.string().min(1).max(EXTERNAL_SOURCE_LIMITS.rootPathBytes),
    pathBridgeSnapshotId: identifier,
    pathBridgeSnapshotSha256: sha256,
    inputFlavor: pathFlavor,
    targetFlavor: pathFlavor,
    distro: canonicalText(64).optional(),
    requireGitIdentity: z.boolean(),
    gitIdentitySha256: sha256.optional(),
    acceptedProducerVersions: producerVersions,
  })
  .strict();
const updateBodySchema = z
  .object({
    workspaceId: identifier,
    label: z.string().min(1).max(512).optional(),
    status: sourceStatus.optional(),
    acceptedProducerVersions: producerVersions.optional(),
    expectedRevision: z.number().int().positive().safe(),
  })
  .strict();
const scanBodySchema = z
  .object({
    workspaceId: identifier,
    expectedRevision: z.number().int().positive().safe(),
  })
  .strict();
const catalogQuerySchema = z
  .object({
    workspaceId: identifier,
    scanId: identifier,
    dispositions: z.union([disposition, z.array(disposition).max(5)]).optional(),
    cursor: z.string().min(1).max(EXTERNAL_SOURCE_LIMITS.encodedCursorBytes).optional(),
    limit: z.coerce.number().int().min(1).max(EXTERNAL_SOURCE_LIMITS.maxPageSize).optional(),
  })
  .strict();
const importPlanBodySchema = z
  .object({
    workspaceId: identifier,
    sourceId: identifier,
    scanId: identifier,
    selectedItemIds: z.array(identifier).min(1).max(EXTERNAL_SOURCE_LIMITS.selectedItemsPerImport),
    expectedRevision: z.number().int().positive().safe(),
  })
  .strict();
const importApplyBodySchema = z
  .object({
    workspaceId: identifier,
    planId: identifier,
    expectedPlanSha256: sha256,
    idempotencyKey: canonicalText(512),
  })
  .strict();
const importParamsSchema = z.object({ importId: identifier }).strict();
const sessionIncarnation = canonicalText(EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH);
const sessionParamsSchema = z.object({ sessionId: identifier }).strict();
const sessionAttachmentParamsSchema = z.object({ sessionId: identifier, attachmentId: identifier }).strict();
const attachmentListQuerySchema = z
  .object({
    workspaceId: identifier,
    limit: z.coerce.number().int().min(1).max(EXTERNAL_SOURCE_LIMITS.maxPageSize).optional(),
  })
  .strict();
const attachBodySchema = z
  .object({
    workspaceId: identifier,
    sessionId: identifier,
    expectedSessionIncarnationId: sessionIncarnation,
    sourceId: identifier,
    importId: identifier,
    itemId: identifier,
  })
  .strict();
const detachBodySchema = z
  .object({
    workspaceId: identifier,
    sessionId: identifier,
    attachmentId: identifier,
    expectedRevision: z.number().int().positive().safe(),
    expectedSessionIncarnationId: sessionIncarnation,
  })
  .strict();
const knowledgeSnapshotRequestBodySchema = z
  .object({
    workspaceId: identifier,
    sessionId: identifier,
    expectedSessionIncarnationId: sessionIncarnation,
    attachmentId: identifier,
    importId: identifier,
    itemId: identifier,
    expectedAttachmentRevision: z.number().int().positive().safe(),
  })
  .strict();

export interface ExternalSourceRoutesOptions {
  service: ExternalSourceRoutePort;
}

export const externalSourceRoutes: FastifyPluginAsync<ExternalSourceRoutesOptions> = async (fastify, options) => {
  if (!options.service) throw new Error("External source routes require an explicit service.");

  const operatorRead = withRouteAccess(fastify, "operator", {
    onRequest: async (_request, reply) => markReadResponse(reply),
  });
  const operatorMutation = withRouteAccess(fastify, "operator", {
    onRequest: async (_request, reply) => markNoStore(reply),
  });

  fastify.post("/api/v1/library/external-sources", operatorMutation, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid external source registration request." });
    let input;
    try {
      input = normalizeExternalSourceCreateInput(parsed.data);
    } catch {
      return reply.code(400).send({ error: "Invalid external source registration request." });
    }
    const abort = bindRequestAbort(request.raw);
    try {
      const created = await options.service.create(input, actor, abort.signal);
      reply.header(
        "Location",
        `/api/v1/library/external-sources/${encodeURIComponent(created.source.sourceId)}?workspaceId=${encodeURIComponent(created.source.workspaceId)}`,
      );
      return reply.code(201).send(created);
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    } finally {
      abort.dispose();
    }
  });

  fastify.get("/api/v1/library/external-sources", operatorRead, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid external source list query." });
    try {
      return reply.send(options.service.list(query.data.workspaceId, actor));
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    }
  });

  fastify.get("/api/v1/library/external-sources/:sourceId", operatorRead, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const params = sourceParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid external source detail query." });
    }
    try {
      return reply.send(options.service.get(query.data.workspaceId, params.data.sourceId, actor));
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    }
  });

  fastify.patch("/api/v1/library/external-sources/:sourceId", operatorMutation, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const params = sourceParamsSchema.safeParse(request.params);
    const parsed = updateBodySchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "Invalid external source update request." });
    }
    let input;
    try {
      input = normalizeExternalSourceUpdateInput(parsed.data);
    } catch {
      return reply.code(400).send({ error: "Invalid external source update request." });
    }
    try {
      return reply.send(await options.service.update(params.data.sourceId, input, actor));
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    }
  });

  fastify.post("/api/v1/library/external-sources/:sourceId/scans", operatorMutation, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const params = sourceParamsSchema.safeParse(request.params);
    const parsed = scanBodySchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "Invalid external source scan request." });
    }
    let input;
    try {
      input = normalizeExternalSourceScanInput(parsed.data);
    } catch {
      return reply.code(400).send({ error: "Invalid external source scan request." });
    }
    const abort = bindRequestAbort(request.raw);
    try {
      return reply.code(201).send(await options.service.scan(params.data.sourceId, input, actor, abort.signal));
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    } finally {
      abort.dispose();
    }
  });

  fastify.get("/api/v1/library/external-sources/:sourceId/items", operatorRead, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const params = sourceParamsSchema.safeParse(request.params);
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "Invalid external source catalog query." });
    }
    let input;
    try {
      input = normalizeExternalSourceCatalogListInput({
        ...parsed.data,
        ...(parsed.data.dispositions
          ? {
              dispositions: Array.isArray(parsed.data.dispositions)
                ? parsed.data.dispositions
                : [parsed.data.dispositions],
            }
          : {}),
      });
    } catch {
      return reply.code(400).send({ error: "Invalid external source catalog query." });
    }
    try {
      return reply.send(options.service.listCatalog(params.data.sourceId, input, actor));
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    }
  });

  fastify.post("/api/v1/library/external-source-import-plans", operatorMutation, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const parsed = importPlanBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid external source import plan request." });
    let input;
    try {
      input = normalizeExternalSourceImportPlanInput(parsed.data);
    } catch {
      return reply.code(400).send({ error: "Invalid external source import plan request." });
    }
    const abort = bindRequestAbort(request.raw);
    reply.header("x-goatcitadel-execution-authority", "none");
    try {
      const result = await options.service.createImportPlan(input, actor, abort.signal);
      return reply.code(201).send(result);
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    } finally {
      abort.dispose();
    }
  });

  fastify.post("/api/v1/library/external-source-imports", operatorMutation, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const parsed = importApplyBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid external source import request." });
    let input;
    try {
      input = normalizeExternalSourceImportApplyInput(parsed.data);
    } catch {
      return reply.code(400).send({ error: "Invalid external source import request." });
    }
    const abort = bindRequestAbort(request.raw);
    try {
      const result = await options.service.applyImport(input, actor, abort.signal);
      reply.header(
        "Location",
        `/api/v1/library/external-source-imports/${encodeURIComponent(result.intent.importId)}?workspaceId=${encodeURIComponent(result.intent.workspaceId)}`,
      );
      return reply.code(result.applyDisposition === "created" ? 201 : 200).send(result);
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    } finally {
      abort.dispose();
    }
  });

  fastify.get("/api/v1/library/external-source-imports/:importId", operatorRead, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const params = importParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid external source import detail query." });
    }
    try {
      return reply.send(options.service.getImport(query.data.workspaceId, params.data.importId, actor));
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // HX-407 C4 Chat-side attachment routes. Paths and bodies are frozen against
  // the C3 shared client; request bodies carry identifiers plus expected
  // revisions/incarnation ONLY — the frozen contract normalizers reject every
  // smuggled hash or actor field, and the server derives every hash.
  // ---------------------------------------------------------------------------

  fastify.get("/api/v1/chat/sessions/:sessionId/external-source-attachments", operatorRead, async (request, reply) => {
    const actor = resolveSpecificOperator(request, reply);
    if (!actor) return reply;
    const params = sessionParamsSchema.safeParse(request.params);
    const query = attachmentListQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid external attachment list query." });
    }
    let input;
    try {
      input = normalizeExternalSessionAttachmentListInput({
        workspaceId: query.data.workspaceId,
        sessionId: params.data.sessionId,
        ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
      });
    } catch {
      return reply.code(400).send({ error: "Invalid external attachment list query." });
    }
    try {
      return reply.send(options.service.listSessionAttachments(input, actor));
    } catch (error) {
      return sendExternalSourceError(error, request, reply);
    }
  });

  fastify.post(
    "/api/v1/chat/sessions/:sessionId/external-source-attachments",
    operatorMutation,
    async (request, reply) => {
      const actor = resolveSpecificOperator(request, reply);
      if (!actor) return reply;
      const params = sessionParamsSchema.safeParse(request.params);
      const parsed = attachBodySchema.safeParse(request.body);
      if (!params.success || !parsed.success || parsed.data.sessionId !== params.data.sessionId) {
        return reply.code(400).send({ error: "Invalid external attachment request." });
      }
      let input;
      try {
        input = normalizeExternalSessionAttachInput(parsed.data);
      } catch {
        return reply.code(400).send({ error: "Invalid external attachment request." });
      }
      const abort = bindRequestAbort(request.raw);
      try {
        const result = await options.service.attachToSession(input, actor, abort.signal);
        return reply.code(result.disposition === "created" ? 201 : 200).send(result);
      } catch (error) {
        return sendExternalSourceError(error, request, reply);
      } finally {
        abort.dispose();
      }
    },
  );

  fastify.delete(
    "/api/v1/chat/sessions/:sessionId/external-source-attachments/:attachmentId",
    operatorMutation,
    async (request, reply) => {
      const actor = resolveSpecificOperator(request, reply);
      if (!actor) return reply;
      const params = sessionAttachmentParamsSchema.safeParse(request.params);
      const parsed = detachBodySchema.safeParse(request.body);
      if (
        !params.success ||
        !parsed.success ||
        parsed.data.sessionId !== params.data.sessionId ||
        parsed.data.attachmentId !== params.data.attachmentId
      ) {
        return reply.code(400).send({ error: "Invalid external attachment detach request." });
      }
      let input;
      try {
        input = normalizeExternalSessionDetachInput(parsed.data);
      } catch {
        return reply.code(400).send({ error: "Invalid external attachment detach request." });
      }
      const abort = bindRequestAbort(request.raw);
      try {
        return reply.send(await options.service.detachFromSession(input, actor, abort.signal));
      } catch (error) {
        return sendExternalSourceError(error, request, reply);
      } finally {
        abort.dispose();
      }
    },
  );

  fastify.post(
    "/api/v1/library/external-source-imports/:importId/knowledge-snapshot-requests",
    operatorMutation,
    async (request, reply) => {
      const actor = resolveSpecificOperator(request, reply);
      if (!actor) return reply;
      const params = importParamsSchema.safeParse(request.params);
      const parsed = knowledgeSnapshotRequestBodySchema.safeParse(request.body);
      if (!params.success || !parsed.success || parsed.data.importId !== params.data.importId) {
        return reply.code(400).send({ error: "Invalid knowledge snapshot request." });
      }
      let input;
      try {
        input = normalizeExternalSourceKnowledgeSnapshotRequestInput(parsed.data);
      } catch {
        return reply.code(400).send({ error: "Invalid knowledge snapshot request." });
      }
      const abort = bindRequestAbort(request.raw);
      try {
        const receipt = await options.service.createKnowledgeSnapshotRequest(input, actor, abort.signal);
        return reply.code(receipt.disposition === "created" ? 201 : 200).send(receipt);
      } catch (error) {
        return sendExternalSourceError(error, request, reply);
      } finally {
        abort.dispose();
      }
    },
  );
};

function resolveSpecificOperator(request: FastifyRequest, reply: FastifyReply): ExternalSourceRequestActor | undefined {
  const source = request.authActorSource;
  const actorId = request.authActorId;
  if (source !== "token" && source !== "basic" && source !== "loopback") {
    void reply.code(403).send({ error: "A specific authenticated operator route is required." });
    return undefined;
  }
  if (
    typeof actorId !== "string" ||
    actorId !== actorId.normalize("NFKC").trim() ||
    actorId === "anonymous" ||
    actorId === "auth:none" ||
    actorId.length < 1 ||
    actorId.length > 256 ||
    hasAsciiControlCharacter(actorId)
  ) {
    void reply.code(401).send({ error: "A specific authenticated operator identity is required." });
    return undefined;
  }
  return { actorId, source };
}

function sendExternalSourceError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ExternalSourceAttachmentServiceError) {
    const status = {
      artifact_failure: 500,
      cancelled: 408,
      conflict: 409,
      identity_drift: 409,
      not_found: 404,
      session_incarnation_stale: 409,
      source_not_active: 409,
    }[error.code];
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof ExternalSourceKnowledgeEffectServiceError) {
    const status = {
      approval_conflict: 409,
      approval_expired: 409,
      approval_not_approved: 409,
      artifact_failure: 500,
      cancelled: 408,
      conflict: 409,
      identity_drift: 409,
      not_found: 404,
      policy_denied: 403,
      session_incarnation_stale: 409,
      source_not_active: 409,
    }[error.code];
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof ExternalSourceImportServiceError) {
    const status = {
      artifact_failure: 500,
      cancelled: 408,
      conflict: 409,
      limit_exceeded: 413,
      not_found: 404,
      repository_failure: 500,
      source_not_active: 409,
      staging_unavailable: 409,
      unsupported_item: 422,
    }[error.code];
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof ExternalSourceServiceError) {
    const status = {
      cancelled: 408,
      conflict: 409,
      identity_drift: 409,
      invalid_cursor: 400,
      limit_exceeded: 409,
      not_found: 404,
      repository_failure: 500,
      source_not_active: 409,
      unsupported_producer_version: 422,
    }[error.code];
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  request.log.error({ errorType: error instanceof Error ? error.name : typeof error }, "External source route failed.");
  return reply.code(500).send({ error: "External source request failed.", code: "repository_failure" });
}

function markNoStore(reply: Pick<FastifyReply, "header">): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

function markReadResponse(reply: Pick<FastifyReply, "header">): void {
  markNoStore(reply);
  reply.header("x-goatcitadel-execution-authority", "none");
}

function bindRequestAbort(raw: object): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const request = raw as {
    aborted?: boolean;
    once?: (event: string, listener: () => void) => unknown;
    off?: (event: string, listener: () => void) => unknown;
  };
  const onAborted = () => controller.abort();
  if (request.aborted) controller.abort();
  request.once?.("aborted", onAborted);
  return {
    signal: controller.signal,
    dispose: () => request.off?.("aborted", onAborted),
  };
}
