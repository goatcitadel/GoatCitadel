/**
 * HX-408 M1/M2 route surface for governed mesh capability publication.
 *
 * - Publication routes (`/manifests`, `/manifests/self`) require the
 *   admitted-node credential (`mesh-node` access class); ordinary operator or
 *   companion authority is rejected by the class enforcement.
 * - Inspection (`/publications`) and governed activation
 *   (`/activations`, `/activations/:activationId/revoke`) are operator-only
 *   and no-store; admitted-node credentials never satisfy them.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST, type MeshCapabilityKind } from "@goatcitadel/contracts";
import {
  MeshCapabilityActivationServiceError,
  type MeshCapabilityActivationService,
} from "../services/mesh-capability-activation-service.js";
import {
  toMeshCapabilityPublicationHttpError,
  type MeshCapabilityAuthenticatedNodeIdentity,
  type MeshCapabilityPublicationService,
} from "../services/mesh-capability-publication-service.js";
import { sendRouteError } from "./_error-handler.js";
import { resolveApprovalActorId } from "./approvals.js";
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
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const localId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u);
const entrySchema = z
  .object({
    localId,
    kind: z.enum(["tool", "mcp_server", "skill"]),
    descriptor: z.record(z.unknown()),
    descriptorSha256: sha256,
  })
  .strict();
const publishBodySchema = z
  .object({
    publicationKey: canonicalText(512),
    supersedesManifestSha256: sha256.optional(),
    entries: z.array(entrySchema).min(1).max(MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST),
  })
  .strict();
const inspectionQuerySchema = z
  .object({
    workspaceId: canonicalText(256).optional(),
  })
  .strict();
const emptyQuerySchema = z.object({}).strict();
const activationRequestBodySchema = z
  .object({
    workspaceId: canonicalText(256).optional(),
    capabilityId: canonicalText(512),
    manifestSha256: sha256,
    entrySha256: sha256,
    sessionId: canonicalText(256).optional(),
    turnId: canonicalText(256).optional(),
  })
  .strict();
const activationRevokeParamsSchema = z
  .object({
    activationId: z.string().regex(/^mesh-activation-[a-f0-9]{48}$/u),
  })
  .strict();
const activationRevokeBodySchema = z
  .object({
    workspaceId: canonicalText(256).optional(),
    reason: canonicalText(2_000),
  })
  .strict();

const RATE_LIMIT_MAX = 120;
const resolveRateLimitKey = (request: { authActorId?: string; ip?: string }): string =>
  request.authActorId?.trim() ? `actor:${request.authActorId.trim()}` : `ip:${request.ip ?? "unknown"}`;

export const meshCapabilityRoutes: FastifyPluginAsync = async (fastify) => {
  const nodeAccess = withRouteAccess(fastify, "mesh-node", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_MAX,
        hook: "preHandler",
        keyGenerator: resolveRateLimitKey,
      },
    },
    onSend: async (_request, reply, payload) => {
      setNoStoreHeaders(reply);
      return payload;
    },
  });
  const operatorAccess = withRouteAccess(fastify, "operator", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_MAX,
        hook: "preHandler",
        keyGenerator: resolveRateLimitKey,
      },
    },
    onSend: async (_request, reply, payload) => {
      setNoStoreHeaders(reply);
      return payload;
    },
  });

  fastify.post("/api/v1/mesh/capabilities/manifests", nodeAccess, async (request, reply) => {
    const service = resolveService(fastify);
    if (!service) return serviceUnavailable(reply);
    const identity = resolveIdentity(request);
    if (!identity) return missingIdentity(reply);
    const parsed = publishBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Mesh capability manifest submission is invalid." });
    }
    try {
      const receipt = service.publishCapabilityManifest(identity, {
        publicationKey: parsed.data.publicationKey,
        ...(parsed.data.supersedesManifestSha256 === undefined
          ? {}
          : { supersedesManifestSha256: parsed.data.supersedesManifestSha256 }),
        entries: parsed.data.entries.map((entry) => ({
          localId: entry.localId,
          kind: entry.kind as MeshCapabilityKind,
          descriptor: entry.descriptor,
          descriptorSha256: entry.descriptorSha256,
        })),
      });
      return reply.code(receipt.replayed ? 200 : 201).send(receipt);
    } catch (error) {
      const mapped = toMeshCapabilityPublicationHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/mesh/capabilities/manifests/self", nodeAccess, async (request, reply) => {
    const service = resolveService(fastify);
    if (!service) return serviceUnavailable(reply);
    const identity = resolveIdentity(request);
    if (!identity) return missingIdentity(reply);
    const query = emptyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Mesh capability publication list request is invalid." });
    }
    try {
      return reply.send(service.listOwnPublications(identity));
    } catch (error) {
      const mapped = toMeshCapabilityPublicationHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/mesh/capabilities/publications", operatorAccess, async (request, reply) => {
    const service = resolveService(fastify);
    if (!service) return serviceUnavailable(reply);
    const query = inspectionQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Mesh capability inspection request is invalid." });
    }
    try {
      return reply.send(service.listPublicationInspection(query.data.workspaceId ?? "default"));
    } catch (error) {
      const mapped = toMeshCapabilityPublicationHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/mesh/capabilities/activations", operatorAccess, async (request, reply) => {
    const activation = resolveActivationService(fastify);
    if (!activation) return serviceUnavailable(reply);
    const parsed = activationRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Mesh capability activation request is invalid." });
    }
    try {
      const result = activation.requestActivation({
        workspaceId: parsed.data.workspaceId ?? "default",
        capabilityId: parsed.data.capabilityId,
        manifestSha256: parsed.data.manifestSha256,
        entrySha256: parsed.data.entrySha256,
        actorId: resolveApprovalActorId(request),
        ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
        ...(parsed.data.turnId === undefined ? {} : { turnId: parsed.data.turnId }),
      });
      return reply.code(result.replayed ? 200 : 201).send({
        approval: result.approval,
        replayed: result.replayed,
        activationId: result.activationId,
        activationRevision: result.activationRevision,
        permissionDiff: result.permissionDiff,
        effectDiff: result.effectDiff,
      });
    } catch (error) {
      const mapped = toMeshCapabilityActivationHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/mesh/capabilities/activations/:activationId/revoke", operatorAccess, async (request, reply) => {
    const activation = resolveActivationService(fastify);
    if (!activation) return serviceUnavailable(reply);
    const params = activationRevokeParamsSchema.safeParse(request.params);
    const parsed = activationRevokeBodySchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "Mesh capability activation revoke request is invalid." });
    }
    try {
      const result = activation.revokeActivation({
        workspaceId: parsed.data.workspaceId ?? "default",
        activationId: params.data.activationId,
        reason: parsed.data.reason,
        actorId: resolveApprovalActorId(request),
      });
      return reply.code(200).send({ revocation: result.revocation, replayed: result.replayed });
    } catch (error) {
      const mapped = toMeshCapabilityActivationHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return sendRouteError(reply, error, request.log);
    }
  });
};

function toMeshCapabilityActivationHttpError(
  error: unknown,
): { statusCode: number; body: { error: string; reason: string } } | undefined {
  if (error instanceof MeshCapabilityActivationServiceError) {
    return { statusCode: error.statusCode, body: { error: error.message, reason: error.code } };
  }
  return undefined;
}

function resolveService(fastify: unknown): MeshCapabilityPublicationService | undefined {
  return (fastify as { services?: { meshCapabilityPublication?: MeshCapabilityPublicationService } }).services
    ?.meshCapabilityPublication;
}

function resolveActivationService(fastify: unknown): MeshCapabilityActivationService | undefined {
  return (fastify as { services?: { meshCapabilityActivation?: MeshCapabilityActivationService } }).services
    ?.meshCapabilityActivation;
}

function resolveIdentity(request: FastifyRequest): MeshCapabilityAuthenticatedNodeIdentity | undefined {
  return request.meshNodeIdentity;
}

function serviceUnavailable(reply: FastifyReply): ReturnType<FastifyReply["send"]> {
  return reply.code(503).send({ error: "Mesh capability publication service is unavailable." });
}

function missingIdentity(reply: FastifyReply): ReturnType<FastifyReply["send"]> {
  return reply.code(500).send({ error: "Admitted mesh-node identity was not resolved for this request." });
}

function setNoStoreHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  const current = reply.getHeader("Vary");
  const values = new Set(
    (Array.isArray(current) ? current : current === undefined ? [] : [String(current)])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add("Authorization");
  reply.header("Vary", [...values].join(", "));
}
