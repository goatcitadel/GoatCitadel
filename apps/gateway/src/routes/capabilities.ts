import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const DEFAULT_WORKSPACE_ID = "default";

export const capabilitiesRoutes: FastifyPluginAsync = async (fastify) => {
  const catalogQuerySchema = z.object({
    scope: z.enum(["inspectable", "callable"]).optional(),
    workspaceId: z.string().trim().min(1).optional(),
  });

  const snapshotParamsSchema = z.object({
    snapshotId: z.string().min(1),
  });
  const compactToolDirectoryQuerySchema = z.object({
    ttlMs: z.coerce.number().int().min(1000).max(3_600_000).optional(),
  });
  const toolSchemaParamsSchema = z.object({
    toolName: z.string().min(1),
  });

  const proposalBodySchema = z.object({
    proposalKind: z.enum(["skill", "tool"]),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    payload: z.record(z.unknown()).default({}),
    candidateId: z.string().trim().min(1).optional(),
    activationTargetId: z.string().trim().min(1).optional(),
  });

  const proposalsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  const autonomyRiskSchema = z.enum(["safe", "caution", "danger", "nuclear"]);
  const autonomyActivationKindSchema = z.enum(["capability", "tool", "mcp_tool", "code_mode"]);
  const autonomyGrantQuerySchema = z.object({
    includeExpired: z.enum(["true", "false"]).optional(),
  });
  const autonomyGrantParamsSchema = z.object({
    grantId: z.string().min(1),
  });
  const autonomyGrantCreateSchema = z.object({
    workspaceId: z.string().trim().min(1).optional(),
    surfaces: z.array(z.enum(["chat", "cowork", "code", "tools", "mcp", "all"])).optional(),
    maxRiskLevel: autonomyRiskSchema,
    capabilityPatterns: z.array(z.string().trim().min(1)).optional(),
    toolPatterns: z.array(z.string().trim().min(1)).optional(),
    activationKinds: z.array(autonomyActivationKindSchema).optional(),
    maxActivations: z.number().int().positive().optional(),
    budgetUsd: z.number().nonnegative().optional(),
    grantor: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    expiresAt: z.string().trim().min(1),
  });
  const autonomyGrantRevokeSchema = z.object({
    revokedBy: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  });
  const autonomyGrantEvaluateSchema = z.object({
    workspaceId: z.string().trim().min(1).optional(),
    surface: z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]),
    riskLevel: autonomyRiskSchema,
    activationKind: autonomyActivationKindSchema,
    capabilityId: z.string().trim().min(1).optional(),
    toolName: z.string().trim().min(1).optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
  });
  const proposalParamsSchema = z.object({
    proposalId: z.string().min(1),
  });
  const candidateParamsSchema = z.object({
    candidateId: z.string().min(1),
  });
  const candidateActionBodySchema = z.object({
    versionId: z.string().trim().min(1).optional(),
  });
  const candidateRollbackBodySchema = z.object({
    targetVersionId: z.string().trim().min(1),
  });
  const chatOnlyModeSchema = z.enum(["chat", "cowork", "code"]).transform(() => "chat" as const);

  const codeModeRunBodySchema = z.object({
    language: z.enum(["javascript", "typescript"]),
    source: z.string().min(1),
    executionBackendId: z.string().trim().min(1).optional(),
    originSurface: chatOnlyModeSchema.optional(),
    input: z.record(z.unknown()).optional(),
    requestedOutputIntent: z.string().trim().min(1).optional(),
    saveCandidateOnSuccess: z.boolean().optional(),
    workspaceId: z.string().trim().min(1).optional(),
    permissionProfileId: z.string().trim().min(1).optional(),
    localOperatorOverrideId: z.string().trim().min(1).optional(),
    autonomousActivation: z.boolean().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    sessionId: z.string().trim().min(1).optional(),
    turnId: z.string().trim().min(1).optional(),
    aider: z
      .object({
        requestMarkdown: z.string().trim().min(1),
        repositoryRootRelPath: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
      })
      .optional(),
  });

  const runParamsSchema = z.object({
    runId: z.string().min(1),
  });
  const runArtifactParamsSchema = z.object({
    runId: z.string().min(1),
    artifactKind: z.enum([
      "source",
      "wrapper_manifest",
      "policy_snapshot",
      "stdout",
      "stderr",
      "aider_request",
      "aider_invocation_plan",
      "aider_result_envelope",
      "aider_patch",
      "aider_stdout",
      "aider_stderr",
    ]),
  });
  const runComparisonParamsSchema = z.object({
    runId: z.string().min(1),
    baselineRunId: z.string().min(1),
  });

  const runDetailQuerySchema = z.object({
    sessionId: z.string().trim().min(1).optional(),
    turnId: z.string().trim().min(1).optional(),
    workspaceId: z.string().trim().min(1).optional(),
  });

  const runsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    workspaceId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).optional(),
    turnId: z.string().trim().min(1).optional(),
    status: z.enum(["approval_pending", "queued", "running", "completed", "failed", "rejected", "expired"]).optional(),
  });

  fastify.get("/api/v1/capabilities/catalog", async (request, reply) => {
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const scope = parsed.data.scope ?? "inspectable";
    // Scope skill-kind catalog entries to the active workspace's effective skill set when a
    // workspaceId is supplied (mirrors GET /api/v1/skills?workspaceId). Absent → unchanged call.
    const items = parsed.data.workspaceId
      ? fastify.services.capabilities.listCapabilityCatalog(
          scope,
          fastify.services.capabilityScope.resolveEffectiveSkills(parsed.data.workspaceId),
        )
      : fastify.services.capabilities.listCapabilityCatalog(scope);
    return reply.send({ scope, items });
  });

  fastify.get("/api/v1/capabilities/tool-directory/compact", async (request, reply) => {
    const parsed = compactToolDirectoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.services.capabilities.getCompactToolDirectorySnapshot(parsed.data.ttlMs));
  });

  fastify.get("/api/v1/capabilities/tool-directory/schemas/:toolName", async (request, reply) => {
    const parsed = toolSchemaParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.capabilities.getToolSchema(parsed.data.toolName));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/snapshots/:snapshotId", async (request, reply) => {
    const parsed = snapshotParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.capabilities.getCapabilityCatalogSnapshot(parsed.data.snapshotId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/proposals", async (request, reply) => {
    const parsed = proposalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.capabilities.listCapabilityProposals(parsed.data.limit ?? 100),
    });
  });

  fastify.post("/api/v1/capabilities/proposals", async (request, reply) => {
    const parsed = proposalBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.capabilities.createCapabilityProposal(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/autonomy-grants", async (request, reply) => {
    const parsed = autonomyGrantQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.capabilities.listAutonomousActivationGrants(parsed.data.includeExpired === "true"),
    });
  });

  fastify.post("/api/v1/capabilities/autonomy-grants", async (request, reply) => {
    const parsed = autonomyGrantCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.capabilities.createAutonomousActivationGrant(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capabilities/autonomy-grants/evaluate", async (request, reply) => {
    const parsed = autonomyGrantEvaluateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.services.capabilities.evaluateAutonomousActivationGrant(parsed.data));
  });

  fastify.post("/api/v1/capabilities/autonomy-grants/:grantId/revoke", async (request, reply) => {
    const params = autonomyGrantParamsSchema.safeParse(request.params);
    const body = autonomyGrantRevokeSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.services.capabilities.revokeAutonomousActivationGrant(params.data.grantId, body.data));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/proposals/:proposalId", async (request, reply) => {
    const parsed = proposalParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.capabilities.getCapabilityProposalDetail(parsed.data.proposalId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/candidates/:candidateId", async (request, reply) => {
    const parsed = candidateParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.capabilities.getCapabilityCandidateDetail(parsed.data.candidateId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capabilities/candidates/:candidateId/promote", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    const body = candidateActionBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.capabilities.promoteCapabilityCandidate(params.data.candidateId, body.data.versionId),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capabilities/candidates/:candidateId/revoke", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    const body = candidateActionBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.capabilities.revokeCapabilityCandidate(params.data.candidateId, body.data.versionId),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capabilities/candidates/:candidateId/rollback", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    const body = candidateRollbackBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.capabilities.rollbackCapabilityCandidate(params.data.candidateId, body.data.targetVersionId),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/code-mode/runs", async (request, reply) => {
    const parsed = runsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.capabilities.listCodeModeRuns({
        ...parsed.data,
        limit: parsed.data.limit ?? 100,
        workspaceId: parsed.data.workspaceId ?? DEFAULT_WORKSPACE_ID,
      }),
    });
  });

  fastify.get("/api/v1/code-mode/execution-backends", async (_request, reply) => {
    return reply.send(fastify.services.capabilities.listCodeModeExecutionBackends());
  });

  fastify.get("/api/v1/code-mode/runs/:runId", async (request, reply) => {
    const parsed = runParamsSchema.safeParse(request.params);
    const query = runDetailQuerySchema.safeParse(request.query);
    if (!parsed.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: parsed.success ? undefined : parsed.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const workspaceId = query.data.workspaceId ?? DEFAULT_WORKSPACE_ID;
      const run = fastify.services.capabilities.getCodeModeRunInScope(parsed.data.runId, {
        workspaceId,
        ...(query.data.sessionId ? { sessionId: query.data.sessionId } : {}),
        ...(query.data.turnId ? { turnId: query.data.turnId } : {}),
      });
      return reply.send(run);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/code-mode/runs/:runId/artifacts/:artifactKind", async (request, reply) => {
    const parsed = runArtifactParamsSchema.safeParse(request.params);
    const query = runDetailQuerySchema.safeParse(request.query);
    if (!parsed.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: parsed.success ? undefined : parsed.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const workspaceId = query.data.workspaceId ?? DEFAULT_WORKSPACE_ID;
      return reply.send(
        await fastify.services.capabilities.getCodeModeRunArtifactPreview(parsed.data.runId, parsed.data.artifactKind, {
          workspaceId,
          ...(query.data.sessionId ? { sessionId: query.data.sessionId } : {}),
          ...(query.data.turnId ? { turnId: query.data.turnId } : {}),
        }),
      );
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/code-mode/runs/:runId/compare/:baselineRunId", async (request, reply) => {
    const parsed = runComparisonParamsSchema.safeParse(request.params);
    const query = runDetailQuerySchema.safeParse(request.query);
    if (!parsed.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: parsed.success ? undefined : parsed.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const workspaceId = query.data.workspaceId ?? DEFAULT_WORKSPACE_ID;
      return reply.send(
        fastify.services.capabilities.compareCodeModeRuns(parsed.data.runId, parsed.data.baselineRunId, {
          workspaceId,
          ...(query.data.sessionId ? { sessionId: query.data.sessionId } : {}),
          ...(query.data.turnId ? { turnId: query.data.turnId } : {}),
        }),
      );
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/code-mode/runs", async (request, reply) => {
    const parsed = codeModeRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(
        await fastify.services.capabilities.createCodeModeRun({
          ...parsed.data,
          operatorId: request.authActorId,
          originSurface: parsed.data.originSurface ?? readCodeModeOriginSurface(request.headers),
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};

function readCodeModeOriginSurface(
  headers: Record<string, string | string[] | undefined>,
): "chat" | "cowork" | "code" | undefined {
  const raw = headers["x-goatcitadel-origin-surface"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "chat" || value === "cowork" || value === "code" ? "chat" : undefined;
}
