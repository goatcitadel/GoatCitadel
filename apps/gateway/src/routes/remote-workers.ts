import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { RemoteWorkerBudgetConflictError } from "@goatcitadel/storage";
import {
  REMOTE_WORKER_CAPABILITY_CLASSES,
  REMOTE_WORKER_MAX_ALLOWED_WORKSPACES,
  REMOTE_WORKER_MAX_BOOTSTRAP_TTL_SECONDS,
  REMOTE_WORKER_MAX_CAPABILITY_CLASSES,
  REMOTE_WORKER_MAX_LABEL_LENGTH,
  REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_MAX_TTL_SECONDS,
  REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  normalizeRemoteWorkerRuntimeBundleManifest,
} from "@goatcitadel/contracts";
import { markMutationCommitted } from "../plugins/idempotency.js";
import {
  RemoteWorkerManifestRejectedError,
  RemoteWorkerManifestVerifierUnavailableError,
} from "../services/remote-worker-manifest-verifier.js";
import { RemoteWorkerMeshNodeJoinAuthorityError } from "../services/remote-worker-mesh-node-join-authority-service.js";
import {
  RemoteWorkerOperatorControlUnavailableError,
  RemoteWorkerRegistryInputError,
  RemoteWorkerRuntimeReadUnavailableError,
  type RemoteWorkersRouteService,
} from "../services/remote-workers-route-service.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.normalize("NFKC").trim() && !/\p{Cc}/u.test(value));
const paramsSchema = z.object({ workspaceId: identifierSchema }).strict();
const detailParamsSchema = paramsSchema.extend({ workerId: identifierSchema }).strict();
const assignmentParamsSchema = paramsSchema.extend({ assignmentId: identifierSchema }).strict();
const nativeOutputParamsSchema = assignmentParamsSchema.extend({ nonce: z.string().regex(/^[0-9a-f]{64}$/u).refine(value => !/^0+$/u.test(value)) }).strict();
const nativeOutputQuerySchema = z.object({ assignmentGeneration: z.string().regex(/^[1-9]\d{0,9}$/u).transform(Number)
  .refine(value => Number.isSafeInteger(value) && value <= 2147483647) }).strict();
const nativeFileQuerySchema = nativeOutputQuerySchema.extend({ fileIndex: z.string().regex(/^(?:0|[1-9]\d?)$/u).transform(Number)
  .refine(value => value <= 63).optional() }).strict();
const nativeReviewBodySchema = z.object({ assignmentGeneration: z.number().int().min(1).max(2147483647),
  launch: z.unknown(), inventoryLimits: z.unknown(), fileStaging: z.unknown().optional(), discloseFilesToGateway: z.boolean().optional() }).strict();
const nativeInstallationReviewBodySchema = z.object({ assignmentGeneration: z.number().int().min(1).max(2147483647),
  controllerEnrollment: z.object({ publicPointHex: z.string().regex(/^04[0-9a-f]{128}$/u),
    keySha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict().optional(),
  packageSha256: z.string().regex(/^[0-9a-f]{64}$/u).refine(value => !/^0+$/u.test(value)),
  runtimeBundle: z.unknown().transform((value, context) => {
    try { return normalizeRemoteWorkerRuntimeBundleManifest(value); }
    catch { context.addIssue({ code: "custom", message: "Invalid runtime bundle manifest." }); return z.NEVER; }
  }) }).strict();
const nativeInstallationRetentionParamsSchema = assignmentParamsSchema.extend({ approvalId: identifierSchema.refine(value => value.length <= 200) }).strict();
const nativeInstallationRetentionBodySchema = z.object({ assignmentGeneration: z.number().int().min(1).max(2147483647) }).strict();
const generationParamsSchema = detailParamsSchema
  .extend({
    workerGeneration: z
      .string()
      .regex(/^[1-9]\d{0,14}$/u)
      .transform(Number)
      .refine(Number.isSafeInteger),
  })
  .strict();
const joinAuthorityParamsSchema = generationParamsSchema
  .extend({
    joinAuthorityGeneration: z
      .string()
      .regex(/^[1-9]\d{0,14}$/u)
      .transform(Number)
      .refine(Number.isSafeInteger),
  })
  .strict();
const emptyQuerySchema = z.object({}).strict();
const listLimit = z
  .string()
  .regex(/^(?:[1-9]|[1-9]\d|100)$/u)
  .transform(Number)
  .optional();
const cursorSchema = z.string().min(1).max(REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES).optional();
const listQuerySchema = z.object({ limit: listLimit, cursor: cursorSchema }).strict();
const assignmentQuerySchema = z
  .object({
    workerId: identifierSchema.optional(),
    sessionId: identifierSchema.optional(),
    turnId: identifierSchema.optional(),
    limit: listLimit,
    cursor: cursorSchema,
  })
  .strict();
const eventQuerySchema = z
  .object({
    afterSequence: z
      .string()
      .regex(/^\d{1,15}$/u)
      .transform(Number)
      .optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]\d?|1\d\d|200)$/u)
      .transform(Number)
      .optional(),
  })
  .strict();
const bootstrapBodySchema = z
  .object({
    existingWorkerId: identifierSchema.optional(),
    workerLabel: z
      .string()
      .min(1)
      .max(REMOTE_WORKER_MAX_LABEL_LENGTH)
      .refine((value) => value === value.normalize("NFKC").trim() && !/\p{Cc}/u.test(value)),
    platform: z.enum(["windows", "linux", "darwin"]),
    architecture: z.enum(["x64", "arm64"]),
    runtimeManifest: z.unknown(),
    allowedWorkspaceIds: z.array(identifierSchema).min(1).max(REMOTE_WORKER_MAX_ALLOWED_WORKSPACES),
    capabilityClasses: z
      .array(z.enum(REMOTE_WORKER_CAPABILITY_CLASSES))
      .min(1)
      .max(REMOTE_WORKER_MAX_CAPABILITY_CLASSES),
    protectedAdmissionSignerPin: z
      .object({
        schemaVersion: z.literal(REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION),
        signatureAlgorithm: z.literal("ed25519"),
        keysetGeneration: z.number().int().safe().positive(),
        keysetReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
        signerSpkiSha256: z.string().regex(/^[0-9a-f]{64}$/u),
        signerSpkiBase64Url: z
          .string()
          .length(59)
          .regex(/^[A-Za-z0-9_-]+$/u),
      })
      .strict(),
    expiresInSeconds: z.number().int().min(1).max(REMOTE_WORKER_MAX_BOOTSTRAP_TTL_SECONDS),
  })
  .strict();
const generationControlBodySchema = z
  .object({
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u),
    reason: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => value === value.normalize("NFKC").trim() && !/\p{Cc}/u.test(value)),
  })
  .strict();
const joinAuthorityIssueBodySchema = z
  .object({
    targetWorkspaceId: identifierSchema,
    expiresInSeconds: z.number().int().min(1).max(REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_MAX_TTL_SECONDS),
  })
  .strict();
const joinAuthorityRevokeBodySchema = generationControlBodySchema
  .extend({ targetWorkspaceId: identifierSchema })
  .strict();

const budgetBodySchema = z.object({
  grantId: identifierSchema,
  executionWorkspaceId: identifierSchema,
  workerId: identifierSchema,
  workerGeneration: z.number().int().safe().positive(),
  maxRequests: z.number().int().min(1).max(100_000),
  maxCostMicrousd: z.number().int().min(0).max(1_000_000_000_000),
  expiresAt: z.string().datetime(),
}).strict();
const budgetRevokeSchema = z.object({ expectedRevision: z.number().int().safe().positive() }).strict();

const RATE_LIMIT_MAX = 120;
const MUTATION_RATE_LIMIT_MAX = 30;
const BOOTSTRAP_RATE_LIMIT_MAX = 5;
const JOIN_AUTHORITY_RATE_LIMIT_MAX = 5;
const resolveRateLimitKey = (request: { authActorId?: string; ip?: string }): string =>
  request.authActorId?.trim() ? `actor:${request.authActorId.trim()}` : `ip:${request.ip ?? "unknown"}`;

export const remoteWorkersRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorRead = withRouteAccess(fastify, "operator", {
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
  const operatorMutation = withRouteAccess(fastify, "operator", {
    config: {
      rateLimit: {
        max: MUTATION_RATE_LIMIT_MAX,
        hook: "preHandler",
        keyGenerator: resolveRateLimitKey,
      },
    },
    onSend: async (_request, reply, payload) => {
      setNoStoreHeaders(reply);
      return payload;
    },
  });
  const loopbackBootstrapMutation = withRouteAccess(fastify, "loopback", {
    config: {
      rateLimit: {
        max: BOOTSTRAP_RATE_LIMIT_MAX,
        hook: "preHandler",
        keyGenerator: resolveRateLimitKey,
      },
    },
    onSend: async (_request, reply, payload) => {
      setNoStoreHeaders(reply);
      return payload;
    },
  });
  const operatorJoinAuthorityMutation = withRouteAccess(fastify, "operator", {
    config: {
      rateLimit: {
        max: JOIN_AUTHORITY_RATE_LIMIT_MAX,
        hook: "preHandler",
        keyGenerator: resolveRateLimitKey,
      },
    },
    onSend: async (_request, reply, payload) => {
      setNoStoreHeaders(reply);
      return payload;
    },
  });

  fastify.get("/api/v1/ops/workspaces/:workspaceId/remote-worker-budgets", operatorRead, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ executionWorkspaceId: identifierSchema }).strict().safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return unavailable(reply);
    try {
      return reply.send({ items: await service.budgetOperator.list(params.data.workspaceId, query.data.executionWorkspaceId) });
    } catch (error) { return sendMutationError(reply, request.log, error); }
  });

  fastify.post("/api/v1/ops/workspaces/:workspaceId/remote-worker-budgets", operatorMutation, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = emptyQuerySchema.safeParse(request.query);
    const body = budgetBodySchema.safeParse(request.body);
    const identity = mutationIdentity(request);
    if (!params.success || !query.success || !body.success || !identity) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return unavailable(reply);
    try {
      const grant = await service.budgetOperator.create({ ...body.data, registryWorkspaceId: params.data.workspaceId }, identity.actorId);
      await markMutationCommitted(request);
      return reply.send(grant);
    } catch (error) {
      if (error instanceof TypeError) return invalidRequest(reply);
      return sendMutationError(reply, request.log, error);
    }
  });

  fastify.post("/api/v1/ops/workspaces/:workspaceId/remote-worker-budgets/:grantId/revoke", operatorMutation, async (request, reply) => {
    const params = paramsSchema.extend({ grantId: identifierSchema }).strict().safeParse(request.params);
    const query = emptyQuerySchema.safeParse(request.query);
    const body = budgetRevokeSchema.safeParse(request.body);
    const identity = mutationIdentity(request);
    if (!params.success || !query.success || !body.success || !identity) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return unavailable(reply);
    try {
      const grant = await service.budgetOperator.revoke({ registryWorkspaceId: params.data.workspaceId,
        grantId: params.data.grantId, expectedRevision: body.data.expectedRevision, actorId: identity.actorId });
      await markMutationCommitted(request);
      return reply.send(grant);
    } catch (error) {
      if (error instanceof TypeError) return invalidRequest(reply);
      return sendMutationError(reply, request.log, error);
    }
  });

  fastify.post(
    "/api/v1/ops/workspaces/:workspaceId/remote-workers/bootstrap",
    loopbackBootstrapMutation,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const query = emptyQuerySchema.safeParse(request.query);
      const body = bootstrapBodySchema.safeParse(request.body);
      const identity = mutationIdentity(request);
      if (!params.success || !query.success || !body.success || !identity) return invalidRequest(reply);
      const service = resolveService(fastify.services);
      if (!service) return unavailable(reply);
      try {
        const result = await service.issueBootstrap({
          workspaceId: params.data.workspaceId,
          ...(body.data.existingWorkerId === undefined ? {} : { existingWorkerId: body.data.existingWorkerId }),
          workerLabel: body.data.workerLabel,
          platform: body.data.platform,
          architecture: body.data.architecture,
          runtimeManifest: body.data.runtimeManifest as never,
          allowedWorkspaceIds: body.data.allowedWorkspaceIds,
          capabilityClasses: body.data.capabilityClasses,
          protectedAdmissionSignerPin: body.data.protectedAdmissionSignerPin,
          expiresInSeconds: body.data.expiresInSeconds,
          actorId: identity.actorId,
          idempotencyKey: identity.idempotencyKey,
        });
        await markMutationCommitted(request);
        return reply.code(result.disposition === "created" ? 201 : 200).send(result);
      } catch (error) {
        return sendMutationError(reply, request.log, error);
      }
    },
  );

  fastify.post(
    "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/mesh-node-join-authorities",
    operatorJoinAuthorityMutation,
    async (request, reply) => {
      const params = generationParamsSchema.safeParse(request.params);
      const query = emptyQuerySchema.safeParse(request.query);
      const body = joinAuthorityIssueBodySchema.safeParse(request.body);
      const identity = mutationIdentity(request);
      if (!params.success || !query.success || !body.success || !identity) return invalidRequest(reply);
      const service = resolveService(fastify.services);
      if (!service) return unavailable(reply);
      try {
        const result = await service.issueMeshNodeJoinAuthority({
          registryWorkspaceId: params.data.workspaceId,
          workerId: params.data.workerId,
          workerGeneration: params.data.workerGeneration,
          workspaceId: body.data.targetWorkspaceId,
          expiresInSeconds: body.data.expiresInSeconds,
          actorId: identity.actorId,
          idempotencyKey: identity.idempotencyKey,
        });
        await markMutationCommitted(request);
        return reply.code(result.disposition === "created" ? 201 : 200).send(result);
      } catch (error) {
        return sendMutationError(reply, request.log, error);
      }
    },
  );

  fastify.post(
    "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/mesh-node-join-authorities/:joinAuthorityGeneration/revoke",
    operatorJoinAuthorityMutation,
    async (request, reply) => {
      const params = joinAuthorityParamsSchema.safeParse(request.params);
      const query = emptyQuerySchema.safeParse(request.query);
      const body = joinAuthorityRevokeBodySchema.safeParse(request.body);
      const identity = mutationIdentity(request);
      if (!params.success || !query.success || !body.success || !identity) return invalidRequest(reply);
      const service = resolveService(fastify.services);
      if (!service) return unavailable(reply);
      try {
        const result = await service.revokeMeshNodeJoinAuthority({
          registryWorkspaceId: params.data.workspaceId,
          workerId: params.data.workerId,
          workerGeneration: params.data.workerGeneration,
          workspaceId: body.data.targetWorkspaceId,
          joinAuthorityGeneration: params.data.joinAuthorityGeneration,
          reasonCode: body.data.reasonCode,
          reason: body.data.reason,
          actorId: identity.actorId,
          idempotencyKey: identity.idempotencyKey,
        });
        await markMutationCommitted(request);
        return reply.send(result);
      } catch (error) {
        return sendMutationError(reply, request.log, error);
      }
    },
  );

  for (const action of ["quarantine", "revoke"] as const) {
    fastify.post(
      `/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/${action}`,
      operatorMutation,
      async (request, reply) => {
        const params = generationParamsSchema.safeParse(request.params);
        const query = emptyQuerySchema.safeParse(request.query);
        const body = generationControlBodySchema.safeParse(request.body);
        const identity = mutationIdentity(request);
        if (!params.success || !query.success || !body.success || !identity) return invalidRequest(reply);
        const service = resolveService(fastify.services);
        if (!service) return unavailable(reply);
        try {
          const result = await service[`${action}Generation`]({
            workspaceId: params.data.workspaceId,
            workerId: params.data.workerId,
            workerGeneration: params.data.workerGeneration,
            reasonCode: body.data.reasonCode,
            reason: body.data.reason,
            actorId: identity.actorId,
            idempotencyKey: identity.idempotencyKey,
          });
          await markMutationCommitted(request);
          return reply.send(result);
        } catch (error) {
          return sendMutationError(reply, request.log, error);
        }
      },
    );
  }

  fastify.get("/api/v1/ops/workspaces/:workspaceId/remote-workers", operatorRead, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return reply.code(503).send({ error: "Remote worker registry service is unavailable." });
    try {
      return reply.send(
        await service.listRegistry({
          workspaceId: params.data.workspaceId,
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        }),
      );
    } catch (error) {
      if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId", operatorRead, async (request, reply) => {
    const params = detailParamsSchema.safeParse(request.params);
    const query = emptyQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return reply.code(503).send({ error: "Remote worker registry service is unavailable." });
    try {
      return reply.send(
        await service.getRegistryEntry({
          workspaceId: params.data.workspaceId,
          workerId: params.data.workerId,
        }),
      );
    } catch (error) {
      if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get(
    "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/reconciliation",
    operatorRead,
    async (request, reply) => {
      const params = detailParamsSchema.safeParse(request.params);
      const query = emptyQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) return invalidRequest(reply);
      const service = resolveService(fastify.services);
      if (!service) return reply.code(503).send({ error: "Remote worker registry service is unavailable." });
      try {
        return reply.send(
          await service.getReconciliation({
            workspaceId: params.data.workspaceId,
            workerId: params.data.workerId,
          }),
        );
      } catch (error) {
        if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.get("/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments", operatorRead, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = assignmentQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return reply.code(503).send({ error: "Remote worker registry service is unavailable." });
    try {
      return reply.send(
        await service.listAssignments({
          workspaceId: params.data.workspaceId,
          ...(query.data.workerId === undefined ? {} : { workerId: query.data.workerId }),
          ...(query.data.sessionId === undefined ? {} : { sessionId: query.data.sessionId }),
          ...(query.data.turnId === undefined ? {} : { turnId: query.data.turnId }),
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        }),
      );
    } catch (error) {
      if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get(
    "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/runtime",
    operatorRead,
    async (request, reply) => {
      const params = assignmentParamsSchema.safeParse(request.params);
      const query = emptyQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) return invalidRequest(reply);
      const service = resolveService(fastify.services);
      if (!service) return reply.code(503).send({ error: "Remote worker runtime reads are unavailable." });
      try {
        return reply.send(await service.getAssignmentRuntime(params.data));
      } catch (error) {
        if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
        if (error instanceof RemoteWorkerRuntimeReadUnavailableError) return reply.code(503).send({ error: error.message });
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post(
    "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/native-runtime-reviews",
    { ...operatorMutation, bodyLimit: 512 * 1024 },
    async (request, reply) => {
      const params = assignmentParamsSchema.safeParse(request.params), body = nativeReviewBodySchema.safeParse(request.body), query = emptyQuerySchema.safeParse(request.query);
      if (!params.success || !body.success || !query.success || body.data.launch === undefined || body.data.inventoryLimits === undefined) return invalidRequest(reply);
      const native = resolveService(fastify.services)?.nativeRuntime;
      if (!native) return reply.code(503).send({ error: "Native runtime review is unavailable." });
      const stop = new AbortController(), disconnected = () => { if (!reply.raw.writableFinished) stop.abort(); }; reply.raw.once("close", disconnected);
      try {
        const result = await native.requestReview({ registryWorkspaceId: params.data.workspaceId, assignmentId: params.data.assignmentId, ...body.data,
          launch: body.data.launch, inventoryLimits: body.data.inventoryLimits }, AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]));
        await markMutationCommitted(request); return reply.code(201).send(result);
      } catch (error) { return sendRouteError(reply, error, request.log); }
      finally { reply.raw.off("close", disconnected); }
    },
  );

  fastify.post(
    "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/native-installation-reviews",
    { ...operatorMutation, bodyLimit: 512 * 1024 },
    async (request, reply) => {
      const params = assignmentParamsSchema.safeParse(request.params), body = nativeInstallationReviewBodySchema.safeParse(request.body), query = emptyQuerySchema.safeParse(request.query);
      if (!params.success || !body.success || !query.success || body.data.runtimeBundle === undefined) return invalidRequest(reply);
      const native = resolveService(fastify.services)?.nativeRuntime;
      if (!native?.requestInstallationReview) return reply.code(503).send({ error: "Native installation review is unavailable." });
      const stop = new AbortController(), disconnected = () => { if (!reply.raw.writableFinished) stop.abort(); }; reply.raw.once("close", disconnected);
      try {
        const result = await native.requestInstallationReview({ registryWorkspaceId: params.data.workspaceId, assignmentId: params.data.assignmentId,
          ...body.data, runtimeBundle: body.data.runtimeBundle }, AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]));
        await markMutationCommitted(request); return reply.code(201).send(result);
      } catch (error) { return sendRouteError(reply, error, request.log); }
      finally { reply.raw.off("close", disconnected); }
    },
  );
  fastify.post(
    "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/native-installation-reviews/:approvalId/retention",
    { ...operatorMutation, bodyLimit: 4096 },
    async (request, reply) => {
      const params = nativeInstallationRetentionParamsSchema.safeParse(request.params), body = nativeInstallationRetentionBodySchema.safeParse(request.body), query = emptyQuerySchema.safeParse(request.query);
      if (!params.success || !body.success || !query.success) return invalidRequest(reply);
      const native = resolveService(fastify.services)?.nativeRuntime;
      if (!native?.retainInstallationReview) return reply.code(503).send({ error: "Native installation retention is unavailable." });
      const stop = new AbortController(), disconnected = () => { if (!reply.raw.writableFinished) stop.abort(); }; reply.raw.once("close", disconnected);
      try {
        const result = await native.retainInstallationReview({ registryWorkspaceId: params.data.workspaceId, assignmentId: params.data.assignmentId,
          approvalId: params.data.approvalId, assignmentGeneration: body.data.assignmentGeneration }, AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]));
        await markMutationCommitted(request); return reply.code(200).send(result);
      } catch (error) { return sendRouteError(reply, error, request.log); }
      finally { reply.raw.off("close", disconnected); }
    },
  );

  fastify.get(
    "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/native-file-artifacts/:nonce",
    operatorRead,
    async (request, reply) => {
      const params = nativeOutputParamsSchema.safeParse(request.params), query = nativeFileQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) return invalidRequest(reply);
      const files = resolveService(fastify.services)?.nativeFiles;
      if (!files) return reply.code(503).send({ error: "Native file artifacts are unavailable." });
      const scope = { registryWorkspaceId: params.data.workspaceId, assignmentId: params.data.assignmentId,
        assignmentGeneration: query.data.assignmentGeneration, nonce: params.data.nonce };
      const stop = new AbortController(), disconnected = () => { if (!reply.raw.writableFinished) stop.abort(); };
      reply.raw.once("close", disconnected);
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]);
      try {
        reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
        if (query.data.fileIndex === undefined) return reply.send(await files.list(scope, signal));
        const artifact = await files.download({ ...scope, fileIndex: query.data.fileIndex }, signal);
        return reply.header("Content-Disposition", `attachment; filename="${artifact.fileName}"`)
          .header("X-Content-SHA256", artifact.sha256).type(artifact.contentType).send(artifact.content);
      } catch (error) { return sendRouteError(reply, error, request.log); }
      finally { reply.raw.off("close", disconnected); }
    },
  );

  fastify.get(
    "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/native-output-artifacts/:nonce",
    operatorRead,
    async (request, reply) => {
      const params = nativeOutputParamsSchema.safeParse(request.params), query = nativeOutputQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) return invalidRequest(reply);
      const service = resolveService(fastify.services);
      if (!service) return reply.code(503).send({ error: "Remote worker runtime reads are unavailable." });
      try {
        const artifact = await service.getNativeOutputArtifact({ ...params.data, ...query.data });
        return reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
          .header("Content-Disposition", `attachment; filename="${artifact.fileName}"`)
          .header("X-Content-SHA256", artifact.sha256).type(artifact.contentType).send(artifact.content);
      } catch (error) {
        if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
        if (error instanceof RemoteWorkerRuntimeReadUnavailableError) return reply.code(503).send({ error: error.message });
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.get(
    "/api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/events",
    operatorRead,
    async (request, reply) => {
      const params = assignmentParamsSchema.safeParse(request.params);
      const query = eventQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) return invalidRequest(reply);
      const service = resolveService(fastify.services);
      if (!service) return reply.code(503).send({ error: "Remote worker registry service is unavailable." });
      try {
        return reply.send(
          await service.getAssignmentEvents({
            workspaceId: params.data.workspaceId,
            assignmentId: params.data.assignmentId,
            ...(query.data.afterSequence === undefined ? {} : { afterSequence: query.data.afterSequence }),
            ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
          }),
        );
      } catch (error) {
        if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
        return sendRouteError(reply, error, request.log);
      }
    },
  );
};

function resolveService(services: unknown): RemoteWorkersRouteService | undefined {
  return (services as { remoteWorkers?: RemoteWorkersRouteService }).remoteWorkers;
}

function invalidRequest(reply: FastifyReply): ReturnType<FastifyReply["send"]> {
  return reply.code(400).send({ error: "Remote worker registry request is invalid." });
}

function unavailable(reply: FastifyReply): ReturnType<FastifyReply["send"]> {
  return reply.code(503).send({ error: "Remote worker operator control is unavailable." });
}

function mutationIdentity(request: {
  readonly authActorId?: string;
  readonly idempotencyKey?: string;
}): { actorId: string; idempotencyKey: string } | undefined {
  const actorId = request.authActorId?.trim();
  const idempotencyKey = request.idempotencyKey?.trim();
  return actorId && idempotencyKey ? { actorId, idempotencyKey } : undefined;
}

function sendMutationError(
  reply: FastifyReply,
  log: Parameters<typeof sendRouteError>[2],
  error: unknown,
): ReturnType<FastifyReply["send"]> {
  if (error instanceof RemoteWorkerRegistryInputError || error instanceof RemoteWorkerManifestRejectedError) {
    return invalidRequest(reply);
  }
  if (error instanceof RemoteWorkerMeshNodeJoinAuthorityError) return invalidRequest(reply);
  if (
    error instanceof RemoteWorkerOperatorControlUnavailableError ||
    error instanceof RemoteWorkerManifestVerifierUnavailableError
) {
  if (error instanceof RemoteWorkerBudgetConflictError) {
    return reply.code(409).send({ error: "Worker budget changed or expired. Refresh its status before retrying." });
  }
    return unavailable(reply);
  }
  return sendRouteError(reply, error, log);
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
