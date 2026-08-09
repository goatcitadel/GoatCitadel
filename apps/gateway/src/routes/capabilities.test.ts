import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { capabilitiesRoutes } from "./capabilities.js";

describe("capabilities routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function createCapabilitiesService(overrides: Record<string, unknown> = {}) {
    return {
      listCapabilityCatalog: vi.fn(async (scope: "inspectable" | "callable") => [
        {
          capabilityId: `cap-${scope}`,
          name: `Catalog ${scope}`,
          kind: "tool",
          category: "built_in",
          callable: scope === "callable",
        },
      ]),
      getCapabilityCatalogSnapshot: vi.fn(async (snapshotId: string) => ({
        snapshotId,
        items: [],
      })),
      getCapabilityCatalogDriftMetrics: vi.fn(async () => ({
        observedAt: "2026-08-08T00:00:00.000Z",
        inspectableCount: 3,
        callableCount: 1,
        inspectableOnlyCount: 2,
        reviewWarningCount: 1,
        inspectableSha256: "a".repeat(64),
        callableSha256: "b".repeat(64),
        callableSubsetValid: true,
        orphanCallableCapabilityIds: [],
        kinds: [],
      })),
      getCapabilityAuditExport: vi.fn(async (snapshotId: string, input: Record<string, unknown>) => ({
        version: "goatcitadel.capability-audit.v1",
        exportedAt: "2026-08-08T00:00:00.000Z",
        snapshot: { snapshotId, inspectableEntries: [], callableEntries: [], createdAt: "2026-08-08T00:00:00.000Z" },
        catalogMetrics: { snapshotId },
        codeModeRuns: [],
        exportSha256: "c".repeat(64),
        claimBoundary: "hash_and_reference_export_not_artifact_content_verification",
        input,
      })),
      getCompactToolDirectorySnapshot: vi.fn(async (ttlMs?: number) => ({
        snapshotId: "compact-tools-abc123",
        version: "compact-tool-directory.v1",
        source: "callable_catalog",
        createdAt: "2026-04-10T00:00:00.000Z",
        expiresAt: "2026-04-10T00:05:00.000Z",
        ttlMs: ttlMs ?? 300_000,
        hash: "abc123",
        toolCount: 1,
        tools: [
          {
            capabilityId: "tool:tool.safe_read",
            toolName: "tool.safe_read",
            title: "tool.safe_read",
            summary: "Read files safely.",
            riskLabel: "safe",
            schemaRef: {
              refId: "tool-schema:schema123",
              toolName: "tool.safe_read",
              schemaHash: "schema123",
              schemaUri: "/api/v1/capabilities/tool-directory/schemas/tool.safe_read",
            },
            readOnly: true,
            deterministic: true,
            codeModeAllowed: true,
          },
        ],
        omitted: { inspectableOnlyCount: 2, reason: "callable_only" },
      })),
      getToolSchema: vi.fn((toolName: string) => ({
        toolName,
        schemaHash: "schema123",
        schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            password: {
              type: "string",
              default: "schema-password-secret",
              enum: ["schema-password-alpha", "schema-password-beta"],
              examples: ["schema-password-example"],
            },
            token: { type: "string" },
          },
          required: ["path", "password", "token"],
        },
      })),
      getCapabilityCandidateDetail: vi.fn(async (candidateId: string) => ({
        candidateId,
        revision: 1,
        versions: [],
        relatedProposals: [],
        activationBlocked: false,
        activationBlockers: [],
      })),
      getCapabilityProposalDetail: vi.fn(async (proposalId: string) => ({
        proposalId,
        status: "proposal",
      })),
      // HX-402 P2: candidate lifecycle verbs answer pending capability.lifecycle
      // approval envelopes; the recovered approval effect is the only executor.
      promoteCapabilityCandidate: vi.fn((candidateId: string) => ({
        pendingApproval: {
          kind: "capability.lifecycle",
          action: "candidate_promoted",
          candidateId,
          status: "pending",
          approvalId: "promote-approval",
        },
      })),
      revokeCapabilityCandidate: vi.fn((candidateId: string) => ({
        pendingApproval: {
          kind: "capability.lifecycle",
          action: "candidate_revoked",
          candidateId,
          status: "pending",
          approvalId: "revoke-approval",
        },
      })),
      rollbackCapabilityCandidate: vi.fn((candidateId: string) => ({
        pendingApproval: {
          kind: "capability.lifecycle",
          action: "candidate_rolled_back",
          candidateId,
          status: "pending",
          approvalId: "rollback-approval",
        },
      })),
      createCapabilityProposal: vi.fn(async (payload: Record<string, unknown>) => ({
        proposalId: "proposal-created",
        ...payload,
      })),
      listCapabilityProposals: vi.fn(async (limit: number) => [{ proposalId: `proposal-${limit}` }]),
      listAutonomousActivationGrants: vi.fn((includeExpired: boolean) => [
        { grantId: includeExpired ? "grant-all" : "grant-active", status: "active" },
      ]),
      createAutonomousActivationGrant: vi.fn((payload: Record<string, unknown>) => ({
        grantId: "grant-created",
        status: "active",
        ...payload,
      })),
      revokeAutonomousActivationGrant: vi.fn((grantId: string, payload: Record<string, unknown>) => ({
        grantId,
        status: "revoked",
        ...payload,
      })),
      evaluateAutonomousActivationGrant: vi.fn((payload: Record<string, unknown>) => ({
        allowed: true,
        matchedGrantId: "grant-created",
        blockers: [],
        governance: ["grant matched"],
        ...payload,
      })),
      listCodeModeRuns: vi.fn(async (input: number | { limit?: number; workspaceId?: string }) => [
        {
          runId: `code-run-${typeof input === "number" ? input : input.limit}`,
          workspaceId: typeof input === "number" ? undefined : input.workspaceId,
        },
      ]),
      listCodeModeExecutionBackends: vi.fn(async () => ({
        generatedAt: "2026-05-31T00:00:00.000Z",
        readOnly: true,
        mutationSemantics: "none",
        defaultBackendId: "trusted-code-host",
        activeBackendId: "trusted-code-host",
        items: [
          {
            backendId: "trusted-code-host",
            kind: "host",
            label: "Trusted-code host runner",
            status: "active",
            runtimeSupport: "active_runner",
            default: true,
            callable: true,
            description: "Current runner",
            blockers: [],
            governance: ["approval required"],
            evidence: {},
          },
          {
            backendId: "docker-container",
            kind: "docker",
            label: "Docker execution backend",
            status: "preview",
            runtimeSupport: "preview_only",
            default: false,
            callable: false,
            description: "Preview only",
            blockers: ["not wired"],
            governance: ["preserve policy"],
            evidence: {},
          },
        ],
      })),
      getCodeModeRun: vi.fn((runId: string) => ({
        runId,
        status: "completed",
        sessionId: "session-1",
        turnId: "turn-1",
        workspaceId: "default",
      })),
      getCodeModeRunInScope: vi.fn(
        async (runId: string, scope: { workspaceId?: string; sessionId?: string; turnId?: string }) => {
          const run = {
            runId,
            status: "completed",
            sessionId: "session-1",
            turnId: "turn-1",
            workspaceId: "default",
          };
          if (
            (scope.workspaceId && run.workspaceId !== scope.workspaceId) ||
            (scope.sessionId && run.sessionId !== scope.sessionId) ||
            (scope.turnId && run.turnId !== scope.turnId)
          ) {
            throw new Error(`Code Mode run ${runId} not found in requested scope`);
          }
          return run;
        },
      ),
      getCodeModeRunArtifactPreview: vi.fn(
        async (
          runId: string,
          artifactKind: string,
          scope: { workspaceId?: string; sessionId?: string; turnId?: string },
        ) => ({
          runId,
          artifactKind,
          scope,
          content: "return { ok: true };",
          artifact: { relPath: "data/code-mode-artifacts/code-run-1/source.ts", sha256: "code-hash" },
          sha256: "code-hash",
          verifiedAt: "2026-04-10T00:00:00.000Z",
          truncated: false,
        }),
      ),
      compareCodeModeRuns: vi.fn(
        async (
          runId: string,
          baselineRunId: string,
          scope: { workspaceId?: string; sessionId?: string; turnId?: string },
        ) => ({
          runId,
          baselineRunId,
          scope,
          matches: { policySnapshot: false },
          comparedAt: "2026-04-10T00:00:00.000Z",
        }),
      ),
      createCodeModeRun: vi.fn(async (payload: Record<string, unknown>) => ({
        runId: "code-run-created",
        status: "completed",
        ...payload,
      })),
      verifyCodeModeRun: vi.fn(
        async (runId: string, input: Record<string, unknown>, scope: Record<string, unknown>, operatorId?: string) => ({
          run: { runId, status: "completed", verification: { status: "verified" } },
          evidence: {
            evidenceId: "proof-1",
            runId,
            status: "verified",
            input,
            scope,
            operatorId,
          },
        }),
      ),
      listCodeModeRunVerificationEvidence: vi.fn(
        async (runId: string, scope: Record<string, unknown>, limit: number) => [
          { evidenceId: "proof-1", runId, scope, limit },
        ],
      ),
      ...overrides,
    };
  }

  async function registerCapabilitiesService(overrides: Record<string, unknown> = {}) {
    const service = createCapabilitiesService(overrides);
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      capabilities: service,
    } as never);
    await app.register(capabilitiesRoutes);
    return service;
  }

  it("returns the requested catalog scope from the capability route service", async () => {
    const listCapabilityCatalog = vi.fn(async (scope: "inspectable" | "callable") => [
      {
        capabilityId: `cap-${scope}`,
        name: `Catalog ${scope}`,
        kind: "tool",
        category: "built_in",
        callable: scope === "callable",
      },
    ]);

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      capabilities: {
        listCapabilityCatalog,
      },
    } as never);
    await app.register(capabilitiesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/catalog?scope=callable",
    });

    expect(response.statusCode).toBe(200);
    expect(listCapabilityCatalog).toHaveBeenCalledWith("callable");
    expect(response.json()).toMatchObject({
      scope: "callable",
      items: [{ capabilityId: "cap-callable" }],
    });
  });

  it("scopes the catalog by the workspace's effective skill set when workspaceId is supplied", async () => {
    const effective = new Set(["skill-a"]);
    const resolveEffectiveSkills = vi.fn((_workspaceId: string) => effective);
    const listCapabilityCatalog = vi.fn(async (scope: "inspectable" | "callable") => [
      { capabilityId: `cap-${scope}`, name: `Catalog ${scope}`, kind: "tool", category: "built_in", callable: false },
    ]);

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      capabilities: { listCapabilityCatalog },
      capabilityScope: { resolveEffectiveSkills },
    } as never);
    await app.register(capabilitiesRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/capabilities/catalog?workspaceId=ws-1" });

    expect(response.statusCode).toBe(200);
    expect(resolveEffectiveSkills).toHaveBeenCalledWith("ws-1");
    expect(listCapabilityCatalog).toHaveBeenCalledWith("inspectable", effective);
  });

  it("leaves the catalog call unscoped (argument-identical) when workspaceId is absent", async () => {
    const resolveEffectiveSkills = vi.fn();
    const listCapabilityCatalog = vi.fn(async () => []);

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      capabilities: { listCapabilityCatalog },
      capabilityScope: { resolveEffectiveSkills },
    } as never);
    await app.register(capabilitiesRoutes);

    await app.inject({ method: "GET", url: "/api/v1/capabilities/catalog" });

    expect(resolveEffectiveSkills).not.toHaveBeenCalled();
    expect(listCapabilityCatalog).toHaveBeenCalledWith("inspectable");
  });

  it("returns workspace-scoped catalog drift metrics and bounded snapshot audit exports", async () => {
    const effective = new Set(["skill-a"]);
    const service = createCapabilitiesService();
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      capabilities: service,
      capabilityScope: { resolveEffectiveSkills: vi.fn(async () => effective) },
    } as never);
    await app.register(capabilitiesRoutes);

    const metrics = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/catalog-metrics?workspaceId=workspace-a",
    });
    const exported = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/snapshots/snapshot-a/audit-export?workspaceId=workspace-a&runIds=run-2,run-1",
    });

    expect(metrics.statusCode).toBe(200);
    expect(service.getCapabilityCatalogDriftMetrics).toHaveBeenCalledWith(effective);
    expect(metrics.json()).toMatchObject({ inspectableCount: 3, callableCount: 1, inspectableOnlyCount: 2 });
    expect(exported.statusCode).toBe(200);
    expect(service.getCapabilityAuditExport).toHaveBeenCalledWith("snapshot-a", {
      workspaceId: "workspace-a",
      runIds: ["run-2", "run-1"],
    });
    expect(exported.json()).toMatchObject({
      version: "goatcitadel.capability-audit.v1",
      snapshot: { snapshotId: "snapshot-a" },
    });
  });

  it("returns compact tool-directory snapshots and fetches full schemas by ref", async () => {
    const service = await registerCapabilitiesService();

    const compact = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/tool-directory/compact?ttlMs=120000",
    });
    const schema = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/tool-directory/schemas/tool.safe_read",
    });

    expect(compact.statusCode).toBe(200);
    expect(service.getCompactToolDirectorySnapshot).toHaveBeenCalledWith(120_000);
    expect(compact.json()).toMatchObject({
      version: "compact-tool-directory.v1",
      source: "callable_catalog",
      tools: [
        {
          toolName: "tool.safe_read",
          schemaRef: {
            schemaUri: "/api/v1/capabilities/tool-directory/schemas/tool.safe_read",
          },
        },
      ],
      omitted: {
        reason: "callable_only",
      },
    });
    expect(JSON.stringify(compact.json())).not.toContain("properties");
    expect(schema.statusCode).toBe(200);
    expect(service.getToolSchema).toHaveBeenCalledWith("tool.safe_read");
    expect(schema.json()).toMatchObject({
      toolName: "tool.safe_read",
      schema: {
        properties: {
          path: { type: "string" },
          password: {
            type: "string",
            default: "[REDACTED]",
            enum: ["[REDACTED]", "[REDACTED]"],
            examples: ["[REDACTED]"],
          },
          token: { type: "string" },
        },
        required: ["path", "password", "token"],
      },
    });
    expect(schema.body).not.toContain("schema-password-secret");
    expect(Array.isArray(schema.json().schema.properties.password.enum)).toBe(true);
    expect(Array.isArray(schema.json().schema.properties.password.examples)).toBe(true);
  });

  it("creates a capability proposal through the capability route service", async () => {
    const createCapabilityProposal = vi.fn(async (payload: Record<string, unknown>) => ({
      proposalId: "proposal-1",
      proposalKind: payload.proposalKind,
      status: "proposal",
      title: payload.title,
      summary: payload.summary,
      payload: payload.payload,
      createdAt: "2026-04-09T20:00:00.000Z",
      updatedAt: "2026-04-09T20:00:00.000Z",
    }));

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      capabilities: {
        createCapabilityProposal,
        listCapabilityCatalog: vi.fn(() => []),
        getCapabilityCandidateDetail: vi.fn(),
        getCapabilityProposalDetail: vi.fn(),
        promoteCapabilityCandidate: vi.fn(),
        revokeCapabilityCandidate: vi.fn(),
        rollbackCapabilityCandidate: vi.fn(),
        listCapabilityProposals: vi.fn(() => []),
        listCodeModeRuns: vi.fn(() => []),
        getCodeModeRun: vi.fn(),
        getCodeModeRunArtifactPreview: vi.fn(),
        compareCodeModeRuns: vi.fn(),
        createCodeModeRun: vi.fn(),
        getCapabilityCatalogSnapshot: vi.fn(),
      },
    } as never);
    await app.register(capabilitiesRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/proposals",
      payload: {
        proposalKind: "skill",
        title: "Summarizer Upgrade",
        summary: "Promote a better summarizer candidate",
        payload: {
          candidateId: "candidate-1",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createCapabilityProposal).toHaveBeenCalledWith(
      {
        proposalKind: "skill",
        title: "Summarizer Upgrade",
        summary: "Promote a better summarizer candidate",
        payload: {
          candidateId: "candidate-1",
        },
      },
      "operator-test",
    );
    expect(response.json()).toMatchObject({
      proposalId: "proposal-1",
      proposalKind: "skill",
      status: "proposal",
    });
  });

  it("routes autonomous activation grants through governed create, evaluate, and revoke endpoints", async () => {
    const service = await registerCapabilitiesService();
    const expiresAt = "2026-06-03T00:00:00.000Z";

    const listResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/autonomy-grants?includeExpired=true",
    });
    const createResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/autonomy-grants",
      payload: {
        workspaceId: "default",
        surfaces: ["cowork"],
        maxRiskLevel: "danger",
        capabilityPatterns: ["capability.*"],
        toolPatterns: ["mcp.*"],
        activationKinds: ["tool"],
        maxActivations: 2,
        grantor: "operator",
        reason: "allow governed activation for this task",
        expiresAt,
      },
    });
    const evaluateResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/autonomy-grants/evaluate",
      payload: {
        workspaceId: "default",
        surface: "cowork",
        riskLevel: "danger",
        activationKind: "tool",
        toolName: "mcp.remote.fetch",
      },
    });
    const revokeResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/autonomy-grants/grant-created/revoke",
      payload: {
        revokedBy: "operator",
        reason: "stop",
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(createResponse.statusCode).toBe(201);
    expect(evaluateResponse.statusCode).toBe(200);
    expect(revokeResponse.statusCode).toBe(200);
    expect(service.listAutonomousActivationGrants).toHaveBeenCalledWith(true);
    expect(service.createAutonomousActivationGrant).toHaveBeenCalledWith(
      expect.objectContaining({ maxRiskLevel: "danger", expiresAt }),
    );
    expect(service.evaluateAutonomousActivationGrant).toHaveBeenCalledWith(
      expect.objectContaining({ activationKind: "tool", toolName: "mcp.remote.fetch" }),
    );
    expect(service.revokeAutonomousActivationGrant).toHaveBeenCalledWith("grant-created", {
      revokedBy: "operator",
      reason: "stop",
    });
  });

  it("creates a Code Mode run through the capability route service", async () => {
    const createCodeModeRun = vi.fn(async (payload: Record<string, unknown>) => ({
      runId: "code-run-1",
      status: "approval_pending",
      language: payload.language,
      requestedOutputIntent: payload.requestedOutputIntent,
      saveCandidateOnSuccess: payload.saveCandidateOnSuccess,
      capabilitySnapshotId: "cap-snap-1",
      codeModeInputHash: "input-hash",
      wrapperManifestHash: "wrap-hash",
      policySnapshotHash: "policy-hash",
      codeHash: "code-hash",
      codeArtifact: {
        artifactId: "artifact-code",
        path: "data/code-mode-artifacts/code-run-1/source.ts",
        mediaType: "text/typescript",
        sha256: "code-hash",
      },
      wrapperManifestArtifact: {
        artifactId: "artifact-wrappers",
        path: "data/code-mode-artifacts/code-run-1/wrappers.json",
        mediaType: "application/json",
        sha256: "wrap-hash",
      },
      policySnapshotArtifact: {
        artifactId: "artifact-policy",
        path: "data/code-mode-artifacts/code-run-1/policy.json",
        mediaType: "application/json",
        sha256: "policy-hash",
      },
      stdoutTruncated: false,
      stderrTruncated: false,
      createdAt: "2026-04-09T20:00:00.000Z",
    }));

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      capabilities: {
        createCodeModeRun,
        listCapabilityCatalog: vi.fn(() => []),
        getCapabilityCandidateDetail: vi.fn(),
        getCapabilityProposalDetail: vi.fn(),
        promoteCapabilityCandidate: vi.fn(),
        revokeCapabilityCandidate: vi.fn(),
        rollbackCapabilityCandidate: vi.fn(),
        createCapabilityProposal: vi.fn(),
        listCapabilityProposals: vi.fn(() => []),
        listCodeModeRuns: vi.fn(() => []),
        getCodeModeRun: vi.fn(),
        getCodeModeRunArtifactPreview: vi.fn(),
        compareCodeModeRuns: vi.fn(),
        getCapabilityCatalogSnapshot: vi.fn(),
      },
    } as never);
    await app.register(capabilitiesRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs",
      payload: {
        language: "typescript",
        source: "return { ok: true };",
        originSurface: "code",
        input: { path: "/tmp/demo" },
        requestedOutputIntent: "Summarize files",
        saveCandidateOnSuccess: true,
        permissionProfileId: "trusted-local-power",
        localOperatorOverrideId: "override-1",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createCodeModeRun).toHaveBeenCalledWith({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "chat",
      input: { path: "/tmp/demo" },
      requestedOutputIntent: "Summarize files",
      saveCandidateOnSuccess: true,
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
      operatorId: "operator-test",
    });
    expect(response.json()).toMatchObject({
      runId: "code-run-1",
      status: "approval_pending",
      capabilitySnapshotId: "cap-snap-1",
    });
  });

  it("normalizes the legacy Code Mode origin surface header when the request body omits it", async () => {
    const service = await registerCapabilitiesService();

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs",
      headers: {
        "x-goatcitadel-origin-surface": "code",
      },
      payload: {
        language: "typescript",
        source: "return { ok: true };",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.createCodeModeRun).toHaveBeenCalledWith({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "chat",
      operatorId: "operator-test",
    });
  });

  it("passes explicit Aider backend requests through Code Mode run creation", async () => {
    const service = await registerCapabilitiesService();

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs",
      payload: {
        language: "typescript",
        source: "return { ok: true };",
        executionBackendId: "aider-cli-adapter",
        aider: {
          requestMarkdown: "Refactor this safely.",
          repositoryRootRelPath: "workspace",
          model: "local/aider",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.createCodeModeRun).toHaveBeenCalledWith({
      language: "typescript",
      source: "return { ok: true };",
      executionBackendId: "aider-cli-adapter",
      aider: {
        requestMarkdown: "Refactor this safely.",
        repositoryRootRelPath: "workspace",
        model: "local/aider",
      },
      operatorId: "operator-test",
    });
  });

  it("returns candidate detail through the capability route service", async () => {
    const getCapabilityCandidateDetail = vi.fn(async (candidateId: string) => ({
      candidateId,
      versions: [],
      relatedProposals: [],
      activationBlocked: true,
      activationBlockers: ["No candidate version has been promoted into an approved or trusted lifecycle state."],
    }));

    app = Fastify();
    app.decorate("services", {
      capabilities: {
        listCapabilityCatalog: vi.fn(() => []),
        getCapabilityCatalogSnapshot: vi.fn(),
        getCapabilityCandidateDetail,
        getCapabilityProposalDetail: vi.fn(),
        promoteCapabilityCandidate: vi.fn(),
        revokeCapabilityCandidate: vi.fn(),
        rollbackCapabilityCandidate: vi.fn(),
        createCapabilityProposal: vi.fn(),
        listCapabilityProposals: vi.fn(() => []),
        listCodeModeRuns: vi.fn(() => []),
        getCodeModeRun: vi.fn(),
        getCodeModeRunArtifactPreview: vi.fn(),
        compareCodeModeRuns: vi.fn(),
        createCodeModeRun: vi.fn(),
      },
    } as never);
    await app.register(capabilitiesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/candidates/candidate-1",
    });

    expect(response.statusCode).toBe(200);
    expect(getCapabilityCandidateDetail).toHaveBeenCalledWith("candidate-1");
    expect(response.json()).toMatchObject({
      candidateId: "candidate-1",
      activationBlocked: true,
    });
  });

  it("promotes a candidate through the capability route service", async () => {
    // HX-402 P2: the promote verb answers with a pending capability.lifecycle
    // approval envelope; the recovered approval effect is the only executor.
    const promoteCapabilityCandidate = vi.fn((candidateId: string) => ({
      pendingApproval: {
        approvalId: "22222222-3333-4444-5555-666677778888",
        status: "pending",
        kind: "capability.lifecycle",
        action: "candidate_promoted",
        candidateId,
        requestSha256: "a".repeat(64),
        expectedStateSha256: "b".repeat(64),
        createdAt: "2026-04-10T01:00:00.000Z",
        replayed: false,
      },
    }));

    app = Fastify();
    app.decorate("services", {
      capabilities: {
        listCapabilityCatalog: vi.fn(() => []),
        getCapabilityCatalogSnapshot: vi.fn(),
        getCapabilityCandidateDetail: vi.fn(),
        getCapabilityProposalDetail: vi.fn(),
        promoteCapabilityCandidate,
        revokeCapabilityCandidate: vi.fn(),
        rollbackCapabilityCandidate: vi.fn(),
        createCapabilityProposal: vi.fn(),
        listCapabilityProposals: vi.fn(() => []),
        listCodeModeRuns: vi.fn(() => []),
        getCodeModeRun: vi.fn(),
        getCodeModeRunArtifactPreview: vi.fn(),
        compareCodeModeRuns: vi.fn(),
        createCodeModeRun: vi.fn(),
      },
    } as never);
    await app.register(capabilitiesRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/candidates/candidate-1/promote",
      payload: {
        expectedRevision: 3,
        versionId: "version-2",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(promoteCapabilityCandidate).toHaveBeenCalledWith("candidate-1", 3, "version-2", "ip:127.0.0.1");
    expect(response.json().pendingApproval).toMatchObject({
      kind: "capability.lifecycle",
      action: "candidate_promoted",
      candidateId: "candidate-1",
    });
  });

  it("requires candidate revisions and returns structured stale-write conflicts", async () => {
    const promoteCapabilityCandidate = vi.fn(() => {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "candidate_skill candidate-1 changed since revision 2",
        details: {
          resourceKind: "candidate_skill",
          resourceId: "candidate-1",
          expectedRevision: 2,
          currentRevision: 3,
        },
      });
    });
    app = Fastify();
    app.decorate("services", { capabilities: { promoteCapabilityCandidate } } as never);
    await app.register(capabilitiesRoutes);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/candidates/candidate-1/promote",
      payload: { versionId: "version-1" },
    });
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/candidates/candidate-1/promote",
      payload: { expectedRevision: 2, versionId: "version-1" },
    });

    expect(missing.statusCode).toBe(400);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: "candidate_skill candidate-1 changed since revision 2",
      code: "WRITE_CONFLICT",
      details: {
        resourceKind: "candidate_skill",
        resourceId: "candidate-1",
        expectedRevision: 2,
        currentRevision: 3,
      },
    });
  });

  it("uses default read scopes and forwards list limits", async () => {
    const service = await registerCapabilitiesService();

    const catalogResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/catalog",
    });
    const proposalsResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/proposals?limit=2",
    });
    const runsResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs?limit=3",
    });
    const backendsResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/execution-backends",
    });

    expect(catalogResponse.statusCode).toBe(200);
    expect(proposalsResponse.statusCode).toBe(200);
    expect(runsResponse.statusCode).toBe(200);
    expect(backendsResponse.statusCode).toBe(200);
    expect(service.listCapabilityCatalog).toHaveBeenCalledWith("inspectable");
    expect(service.listCapabilityProposals).toHaveBeenCalledWith(2);
    expect(service.listCodeModeRuns).toHaveBeenCalledWith({ limit: 3, workspaceId: "default" });
    expect(service.listCodeModeExecutionBackends).toHaveBeenCalledWith();
    expect(catalogResponse.json()).toMatchObject({
      scope: "inspectable",
      items: [{ capabilityId: "cap-inspectable" }],
    });
    expect(proposalsResponse.json()).toEqual({ items: [{ proposalId: "proposal-2" }] });
    expect(runsResponse.json()).toEqual({ items: [{ runId: "code-run-3", workspaceId: "default" }] });
    expect(backendsResponse.json()).toMatchObject({
      readOnly: true,
      defaultBackendId: "trusted-code-host",
      items: [
        expect.objectContaining({ backendId: "trusted-code-host", callable: true }),
        expect.objectContaining({ backendId: "docker-container", callable: false }),
      ],
    });
  });

  it("forwards Code Mode run filters when listing runs", async () => {
    const service = await registerCapabilitiesService();

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs?limit=5&workspaceId=workspace-1&sessionId=session-1&turnId=turn-1&status=approval_pending",
    });

    expect(response.statusCode).toBe(200);
    expect(service.listCodeModeRuns).toHaveBeenCalledWith({
      limit: 5,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "approval_pending",
    });
  });

  it("runs only a named Code Mode proof in the authenticated actor scope", async () => {
    const service = await registerCapabilitiesService();

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs/code-run-1/verification?workspaceId=workspace-1&sessionId=session-1&turnId=turn-1",
      payload: { commandName: "typecheck" },
    });

    expect(response.statusCode).toBe(200);
    expect(service.verifyCodeModeRun).toHaveBeenCalledWith(
      "code-run-1",
      { commandName: "typecheck" },
      { workspaceId: "workspace-1", sessionId: "session-1", turnId: "turn-1" },
      "operator-test",
    );
    expect(response.json()).toMatchObject({
      run: { runId: "code-run-1", verification: { status: "verified" } },
      evidence: { evidenceId: "proof-1", status: "verified" },
    });
  });

  it("rejects arbitrary Code Mode verification commands", async () => {
    const service = await registerCapabilitiesService();

    const rawCommand = await app!.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs/code-run-1/verification",
      payload: { commandName: "powershell", command: "Remove-Item", args: ["-Recurse"] },
    });
    const missingName = await app!.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs/code-run-1/verification",
      payload: { command: "pnpm", args: ["test"] },
    });

    expect(rawCommand.statusCode).toBe(400);
    expect(missingName.statusCode).toBe(400);
    expect(service.verifyCodeModeRun).not.toHaveBeenCalled();
  });

  it("lists bounded verification evidence in the requested run scope", async () => {
    const service = await registerCapabilitiesService();

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1/verification/evidence?workspaceId=workspace-1&sessionId=session-1&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(service.listCodeModeRunVerificationEvidence).toHaveBeenCalledWith(
      "code-run-1",
      { workspaceId: "workspace-1", sessionId: "session-1" },
      25,
    );
    expect(response.json()).toMatchObject({ items: [{ evidenceId: "proof-1", runId: "code-run-1" }] });
  });

  it("reads snapshot, proposal, and Code Mode details by id", async () => {
    const service = await registerCapabilitiesService();

    const snapshotResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/snapshots/snapshot-1",
    });
    const proposalResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/proposals/proposal-1",
    });
    const runResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1",
    });

    expect(snapshotResponse.statusCode).toBe(200);
    expect(proposalResponse.statusCode).toBe(200);
    expect(runResponse.statusCode).toBe(200);
    expect(service.getCapabilityCatalogSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(service.getCapabilityProposalDetail).toHaveBeenCalledWith("proposal-1");
    expect(service.getCodeModeRunInScope).toHaveBeenCalledWith("code-run-1", { workspaceId: "default" });
    expect(snapshotResponse.json()).toEqual({ snapshotId: "snapshot-1", items: [] });
    expect(proposalResponse.json()).toMatchObject({ proposalId: "proposal-1" });
    expect(runResponse.json()).toMatchObject({ runId: "code-run-1" });
  });

  it("scopes Code Mode run details by session, turn, and workspace query", async () => {
    const service = await registerCapabilitiesService({
      getCodeModeRunInScope: vi.fn(
        (runId: string, scope: { workspaceId?: string; sessionId?: string; turnId?: string }) => {
          const run = {
            runId,
            status: "completed",
            sessionId: "session-1",
            turnId: "turn-1",
            workspaceId: "workspace-1",
          };
          if (
            (scope.workspaceId && run.workspaceId !== scope.workspaceId) ||
            (scope.sessionId && run.sessionId !== scope.sessionId) ||
            (scope.turnId && run.turnId !== scope.turnId)
          ) {
            throw new Error(`Code Mode run ${runId} not found in requested scope`);
          }
          return run;
        },
      ),
    });

    const okResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1?sessionId=session-1&turnId=turn-1&workspaceId=workspace-1",
    });
    const wrongTurnResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1?sessionId=session-1&turnId=turn-other&workspaceId=workspace-1",
    });

    expect(okResponse.statusCode).toBe(200);
    expect(wrongTurnResponse.statusCode).toBe(404);
    expect(service.getCodeModeRunInScope).toHaveBeenCalledWith("code-run-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
  });

  it("reads verified Code Mode artifacts and compares scoped runs", async () => {
    const service = await registerCapabilitiesService();

    const artifactResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1/artifacts/source?sessionId=session-1&turnId=turn-1&workspaceId=workspace-1",
    });
    const aiderArtifactResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1/artifacts/aider_result_envelope?sessionId=session-1&turnId=turn-1&workspaceId=workspace-1",
    });
    const comparisonResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1/compare/code-run-0?sessionId=session-1&turnId=turn-1&workspaceId=workspace-1",
    });

    expect(artifactResponse.statusCode).toBe(200);
    expect(aiderArtifactResponse.statusCode).toBe(200);
    expect(comparisonResponse.statusCode).toBe(200);
    expect(service.getCodeModeRunArtifactPreview).toHaveBeenCalledWith("code-run-1", "source", {
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
    expect(service.getCodeModeRunArtifactPreview).toHaveBeenCalledWith("code-run-1", "aider_result_envelope", {
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
    expect(service.compareCodeModeRuns).toHaveBeenCalledWith("code-run-1", "code-run-0", {
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
    expect(artifactResponse.json()).toMatchObject({
      runId: "code-run-1",
      artifactKind: "source",
      content: "return { ok: true };",
    });
    expect(comparisonResponse.json()).toMatchObject({
      runId: "code-run-1",
      baselineRunId: "code-run-0",
      matches: { policySnapshot: false },
    });
  });

  it("projects proposal, candidate, lifecycle, and Code Mode evidence without mutating runtime truth", async () => {
    const rawProposal = {
      proposalId: "proposal-secret",
      proposalKind: "skill",
      status: "proposed",
      title: "Secret-bearing proposal",
      summary: "Review before activation.",
      payload: {
        token: "proposal-short",
        endpoint: "https://proposal.example.test/token/proposal-path?mode=review",
      },
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };
    const rawRun = {
      runId: "code-run-secret",
      status: "failed",
      language: "typescript",
      workspaceId: "default",
      saveCandidateOnSuccess: false,
      capabilitySnapshotId: "snapshot-1",
      codeModeInputHash: "sha256:input",
      wrapperManifestHash: "sha256:wrapper",
      policySnapshotHash: "sha256:policy",
      codeHash: "sha256:code",
      codeArtifact: {
        artifactId: "code",
        relPath: "code.ts",
        sha256: "sha256:code",
        bytes: 1,
        mimeType: "text/plain",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      wrapperManifestArtifact: {
        artifactId: "wrapper",
        relPath: "wrapper.json",
        sha256: "sha256:wrapper",
        bytes: 1,
        mimeType: "application/json",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      policySnapshotArtifact: {
        artifactId: "policy",
        relPath: "policy.json",
        sha256: "sha256:policy",
        bytes: 1,
        mimeType: "application/json",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      stdoutPreview: "Authorization: Bearer stdout-short",
      stderrPreview: "password=stderr-short",
      stdoutTruncated: false,
      stderrTruncated: false,
      result: { apiKey: "result-short", requestCount: 2 },
      error: "Authorization: Bearer error-short",
      errorDetails: { webhookUrl: "https://hooks.example.test/services/team/error-path" },
      createdAt: "2026-07-09T00:00:00.000Z",
    };
    const rawCandidate = {
      candidateId: "candidate-secret",
      revision: 7,
      versions: [],
      relatedProposals: [rawProposal],
      originatingRun: rawRun,
      activationBlocked: true,
      activationBlockers: ["Approval required."],
    };
    const rawEvent = {
      eventId: "event-secret",
      proposalId: rawProposal.proposalId,
      eventType: "created",
      actorId: "operator",
      payload: { password: "event-short", result: { token: "event-result-short" } },
      createdAt: "2026-07-09T00:00:00.000Z",
    };
    const rawArtifactPreview = {
      runId: rawRun.runId,
      artifactKind: "stdout",
      artifact: {
        artifactId: "stdout-artifact",
        relPath: "data/code-mode/stdout.txt",
        sha256: "sha256:stored-raw",
        bytes: 80,
        mimeType: "text/plain",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      content: '{"token":"artifact-short","endpoint":"https://artifact.example.test/token/artifact-path"}',
      sha256: "sha256:stored-raw",
      verifiedAt: "2026-07-09T00:00:00.000Z",
      truncated: false,
    };
    const rawComparison = {
      runId: rawRun.runId,
      baselineRunId: "code-run-baseline",
      comparedAt: "2026-07-09T00:00:00.000Z",
      matches: { source: false },
      diagnostics: { token: "comparison-short" },
    };
    const createCapabilityProposal = vi.fn(async (input: Record<string, unknown>) => ({
      ...rawProposal,
      payload: input.payload,
    }));
    const createCodeModeRun = vi.fn(async (input: Record<string, unknown>) => ({
      ...rawRun,
      input: input.input,
    }));
    await registerCapabilitiesService({
      listCapabilityProposals: vi.fn(async () => [rawProposal]),
      createCapabilityProposal,
      getCapabilityProposalDetail: vi.fn(async () => ({
        proposal: rawProposal,
        events: [rawEvent],
        candidate: rawCandidate,
      })),
      getCapabilityCandidateDetail: vi.fn(async () => rawCandidate),
      promoteCapabilityCandidate: vi.fn(() => ({
        action: "promote",
        candidateId: rawCandidate.candidateId,
        revision: 8,
        selectedVersionId: "version-1",
        changedVersionIds: ["version-1"],
        occurredAt: "2026-07-09T00:00:00.000Z",
        detail: rawCandidate,
      })),
      revokeCapabilityCandidate: vi.fn(() => ({
        action: "revoke",
        candidateId: rawCandidate.candidateId,
        revision: 8,
        selectedVersionId: "version-1",
        changedVersionIds: ["version-1"],
        occurredAt: "2026-07-09T00:00:00.000Z",
        detail: rawCandidate,
      })),
      rollbackCapabilityCandidate: vi.fn(() => ({
        action: "rollback",
        candidateId: rawCandidate.candidateId,
        revision: 8,
        selectedVersionId: "version-1",
        changedVersionIds: ["version-1"],
        occurredAt: "2026-07-09T00:00:00.000Z",
        detail: rawCandidate,
      })),
      listCodeModeRuns: vi.fn(async () => [rawRun]),
      getCodeModeRunInScope: vi.fn(async () => rawRun),
      getCodeModeRunArtifactPreview: vi.fn(async () => rawArtifactPreview),
      compareCodeModeRuns: vi.fn(async () => rawComparison),
      createCodeModeRun,
    });

    const responses = await Promise.all([
      app!.inject({ method: "GET", url: "/api/v1/capabilities/proposals" }),
      app!.inject({
        method: "POST",
        url: "/api/v1/capabilities/proposals",
        payload: {
          proposalKind: "skill",
          title: "Secret-bearing proposal",
          summary: "Review before activation.",
          payload: { token: "create-proposal-short" },
        },
      }),
      app!.inject({ method: "GET", url: `/api/v1/capabilities/proposals/${rawProposal.proposalId}` }),
      app!.inject({ method: "GET", url: `/api/v1/capabilities/candidates/${rawCandidate.candidateId}` }),
      app!.inject({
        method: "POST",
        url: `/api/v1/capabilities/candidates/${rawCandidate.candidateId}/promote`,
        payload: { expectedRevision: rawCandidate.revision, versionId: "version-1" },
      }),
      app!.inject({
        method: "POST",
        url: `/api/v1/capabilities/candidates/${rawCandidate.candidateId}/revoke`,
        payload: { expectedRevision: rawCandidate.revision, versionId: "version-1" },
      }),
      app!.inject({
        method: "POST",
        url: `/api/v1/capabilities/candidates/${rawCandidate.candidateId}/rollback`,
        payload: { expectedRevision: rawCandidate.revision, targetVersionId: "version-1" },
      }),
      app!.inject({ method: "GET", url: "/api/v1/code-mode/runs" }),
      app!.inject({ method: "GET", url: `/api/v1/code-mode/runs/${rawRun.runId}` }),
      app!.inject({
        method: "GET",
        url: `/api/v1/code-mode/runs/${rawRun.runId}/artifacts/stdout`,
      }),
      app!.inject({
        method: "GET",
        url: `/api/v1/code-mode/runs/${rawRun.runId}/compare/${rawComparison.baselineRunId}`,
      }),
      app!.inject({
        method: "POST",
        url: "/api/v1/code-mode/runs",
        payload: {
          language: "typescript",
          source: "return input;",
          input: { token: "code-input-short" },
        },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
    }
    const publicBodies = responses.map((response) => response.body).join("\n");
    for (const secret of [
      "proposal-short",
      "proposal-path",
      "event-short",
      "event-result-short",
      "stdout-short",
      "stderr-short",
      "result-short",
      "error-short",
      "error-path",
      "comparison-short",
      "artifact-short",
      "artifact-path",
      "create-proposal-short",
      "code-input-short",
    ]) {
      expect(publicBodies).not.toContain(secret);
    }
    expect(responses[9]!.json()).toMatchObject({
      artifact: { sha256: "sha256:stored-raw" },
      sha256: "sha256:stored-raw",
      publicProjection: {
        contentRedacted: true,
        canonicalSha256RefersToStoredArtifact: true,
      },
    });
    expect(createCapabilityProposal.mock.calls[0]?.[0]).toMatchObject({
      payload: { token: "create-proposal-short" },
    });
    expect(createCodeModeRun.mock.calls[0]?.[0]).toMatchObject({
      input: { token: "code-input-short" },
    });
    expect(rawProposal.payload.token).toBe("proposal-short");
    expect(rawRun.stdoutPreview).toContain("stdout-short");
    expect(rawArtifactPreview.content).toContain("artifact-short");
  });

  it("projects catalog snapshots and autonomy-grant evidence without mutating service inputs", async () => {
    const catalogItem = {
      capabilityId: "cap-secret",
      name: "Catalog capability",
      kind: "skill",
      category: "candidate",
      callable: false,
      summary: "Authorization: Bearer catalog-secret",
    };
    const rawGrant = {
      grantId: "grant-secret",
      status: "active",
      reason: "password=list-grant-secret",
    };
    const createAutonomousActivationGrant = vi.fn((input: Record<string, unknown>) => ({
      grantId: "grant-created-secret",
      status: "active",
      ...input,
    }));
    const revokeAutonomousActivationGrant = vi.fn((grantId: string, input: Record<string, unknown>) => ({
      grantId,
      status: "revoked",
      ...input,
    }));
    await registerCapabilitiesService({
      listCapabilityCatalog: vi.fn(() => [catalogItem]),
      getCapabilityCatalogSnapshot: vi.fn(async () => ({ snapshotId: "snapshot-secret", items: [catalogItem] })),
      listAutonomousActivationGrants: vi.fn(() => [rawGrant]),
      createAutonomousActivationGrant,
      evaluateAutonomousActivationGrant: vi.fn(() => ({
        allowed: false,
        blockers: ["Authorization: Bearer evaluate-secret"],
        governance: [],
      })),
      revokeAutonomousActivationGrant,
    });

    const responses = await Promise.all([
      app!.inject({ method: "GET", url: "/api/v1/capabilities/catalog" }),
      app!.inject({ method: "GET", url: "/api/v1/capabilities/snapshots/snapshot-secret" }),
      app!.inject({ method: "GET", url: "/api/v1/capabilities/autonomy-grants" }),
      app!.inject({
        method: "POST",
        url: "/api/v1/capabilities/autonomy-grants",
        payload: {
          workspaceId: "default",
          surfaces: ["chat"],
          maxRiskLevel: "safe",
          capabilityPatterns: ["capability.*"],
          toolPatterns: ["tool.*"],
          activationKinds: ["tool"],
          maxActivations: 1,
          grantor: "operator",
          reason: "Authorization: Bearer create-grant-secret",
          expiresAt: "2026-07-11T00:00:00.000Z",
        },
      }),
      app!.inject({
        method: "POST",
        url: "/api/v1/capabilities/autonomy-grants/evaluate",
        payload: {
          workspaceId: "default",
          surface: "chat",
          riskLevel: "safe",
          activationKind: "tool",
          toolName: "tool.safe_read",
        },
      }),
      app!.inject({
        method: "POST",
        url: "/api/v1/capabilities/autonomy-grants/grant-secret/revoke",
        payload: { revokedBy: "operator", reason: "Authorization: Bearer revoke-grant-secret" },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
    }
    const publicBodies = responses.map((response) => response.body).join("\n");
    for (const secret of [
      "catalog-secret",
      "list-grant-secret",
      "create-grant-secret",
      "evaluate-secret",
      "revoke-grant-secret",
    ]) {
      expect(publicBodies).not.toContain(secret);
    }
    expect(createAutonomousActivationGrant.mock.calls[0]?.[0]).toMatchObject({
      reason: "Authorization: Bearer create-grant-secret",
    });
    expect(revokeAutonomousActivationGrant.mock.calls[0]?.[1]).toMatchObject({
      reason: "Authorization: Bearer revoke-grant-secret",
    });
    expect(catalogItem.summary).toContain("catalog-secret");
    expect(rawGrant.reason).toContain("list-grant-secret");
  });

  it("defaults Code Mode run detail reads to the default workspace", async () => {
    await registerCapabilitiesService({
      getCodeModeRunInScope: vi.fn(async (runId: string, scope: { workspaceId?: string }) => {
        const run = {
          runId,
          status: "completed",
          sessionId: "session-1",
          turnId: "turn-1",
          workspaceId: "workspace-2",
        };
        if (scope.workspaceId && run.workspaceId !== scope.workspaceId) {
          throw new Error(`Code Mode run ${runId} not found in requested scope`);
        }
        return run;
      }),
    });

    const defaultResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1",
    });
    const scopedResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/code-run-1?workspaceId=workspace-2",
    });

    expect(defaultResponse.statusCode).toBe(404);
    expect(scopedResponse.statusCode).toBe(200);
  });

  it("maps missing read details to 404 responses", async () => {
    await registerCapabilitiesService({
      getCapabilityCatalogSnapshot: vi.fn(async () => {
        throw new Error("snapshot missing");
      }),
      getCapabilityProposalDetail: vi.fn(async () => {
        throw new Error("proposal missing");
      }),
      getCodeModeRunInScope: vi.fn(async () => {
        throw new Error("run missing");
      }),
    });

    const snapshotResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/snapshots/missing",
    });
    const proposalResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/proposals/missing",
    });
    const runResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/code-mode/runs/missing",
    });

    expect(snapshotResponse.statusCode).toBe(404);
    expect(proposalResponse.statusCode).toBe(404);
    expect(runResponse.statusCode).toBe(404);
    expect(snapshotResponse.json()).toMatchObject({ error: "snapshot missing" });
    expect(proposalResponse.json()).toMatchObject({ error: "proposal missing" });
    expect(runResponse.json()).toMatchObject({ error: "run missing" });
  });

  it("revokes and rolls back capability candidates with selected versions", async () => {
    const service = await registerCapabilitiesService();

    const revokeResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/candidates/candidate-1/revoke",
      payload: {
        expectedRevision: 4,
        versionId: "version-2",
      },
    });
    const rollbackResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/candidates/candidate-1/rollback",
      payload: {
        expectedRevision: 4,
        targetVersionId: "version-1",
      },
    });

    expect(revokeResponse.statusCode).toBe(202);
    expect(rollbackResponse.statusCode).toBe(202);
    expect(service.revokeCapabilityCandidate).toHaveBeenCalledWith("candidate-1", 4, "version-2", "operator-test");
    expect(service.rollbackCapabilityCandidate).toHaveBeenCalledWith("candidate-1", "version-1", 4, "operator-test");
    expect(revokeResponse.json().pendingApproval).toMatchObject({
      action: "candidate_revoked",
      candidateId: "candidate-1",
    });
    expect(rollbackResponse.json().pendingApproval).toMatchObject({
      action: "candidate_rolled_back",
      candidateId: "candidate-1",
    });
  });

  it("rejects malformed capability route inputs before calling services", async () => {
    const service = await registerCapabilitiesService();

    const catalogResponse = await app!.inject({
      method: "GET",
      url: "/api/v1/capabilities/catalog?scope=runtime",
    });
    const proposalResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/proposals",
      payload: {
        proposalKind: "skill",
        title: "",
        summary: "bad proposal",
      },
    });
    const rollbackResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/candidates/candidate-1/rollback",
      payload: {},
    });
    const runResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs",
      payload: {
        language: "python",
        source: "print('nope')",
      },
    });

    expect(catalogResponse.statusCode).toBe(400);
    expect(proposalResponse.statusCode).toBe(400);
    expect(rollbackResponse.statusCode).toBe(400);
    expect(runResponse.statusCode).toBe(400);
    expect(service.createCapabilityProposal).not.toHaveBeenCalled();
    expect(service.rollbackCapabilityCandidate).not.toHaveBeenCalled();
    expect(service.createCodeModeRun).not.toHaveBeenCalled();
  });
});
