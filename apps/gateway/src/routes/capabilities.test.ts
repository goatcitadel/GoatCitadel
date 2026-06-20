import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
      listCapabilityCatalog: vi.fn((scope: "inspectable" | "callable") => [
        {
          capabilityId: `cap-${scope}`,
          name: `Catalog ${scope}`,
          kind: "tool",
          category: "built_in",
          callable: scope === "callable",
        },
      ]),
      getCapabilityCatalogSnapshot: vi.fn((snapshotId: string) => ({
        snapshotId,
        items: [],
      })),
      getCompactToolDirectorySnapshot: vi.fn((ttlMs?: number) => ({
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
        schema: { type: "object", properties: { path: { type: "string" } } },
      })),
      getCapabilityCandidateDetail: vi.fn((candidateId: string) => ({
        candidateId,
        versions: [],
        relatedProposals: [],
        activationBlocked: false,
        activationBlockers: [],
      })),
      getCapabilityProposalDetail: vi.fn((proposalId: string) => ({
        proposalId,
        status: "proposal",
      })),
      promoteCapabilityCandidate: vi.fn((candidateId: string, versionId?: string) => ({
        action: "promote",
        candidateId,
        selectedVersionId: versionId,
      })),
      revokeCapabilityCandidate: vi.fn((candidateId: string, versionId?: string) => ({
        action: "revoke",
        candidateId,
        selectedVersionId: versionId,
      })),
      rollbackCapabilityCandidate: vi.fn((candidateId: string, targetVersionId: string) => ({
        action: "rollback",
        candidateId,
        targetVersionId,
      })),
      createCapabilityProposal: vi.fn((payload: Record<string, unknown>) => ({
        proposalId: "proposal-created",
        ...payload,
      })),
      listCapabilityProposals: vi.fn((limit: number) => [{ proposalId: `proposal-${limit}` }]),
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
      listCodeModeRuns: vi.fn((input: number | { limit?: number; workspaceId?: string }) => [
        {
          runId: `code-run-${typeof input === "number" ? input : input.limit}`,
          workspaceId: typeof input === "number" ? undefined : input.workspaceId,
        },
      ]),
      listCodeModeExecutionBackends: vi.fn(() => ({
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
        (runId: string, scope: { workspaceId?: string; sessionId?: string; turnId?: string }) => {
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
        (
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
    const listCapabilityCatalog = vi.fn((scope: "inspectable" | "callable") => [
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
      schema: { properties: { path: { type: "string" } } },
    });
  });

  it("creates a capability proposal through the capability route service", async () => {
    const createCapabilityProposal = vi.fn((payload: Record<string, unknown>) => ({
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
    expect(createCapabilityProposal).toHaveBeenCalledWith({
      proposalKind: "skill",
      title: "Summarizer Upgrade",
      summary: "Promote a better summarizer candidate",
      payload: {
        candidateId: "candidate-1",
      },
    });
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
      originSurface: "code",
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

  it("falls back to the Code Mode origin surface header when the request body omits it", async () => {
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
      originSurface: "code",
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
    const getCapabilityCandidateDetail = vi.fn((candidateId: string) => ({
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
    const promoteCapabilityCandidate = vi.fn((candidateId: string, versionId?: string) => ({
      action: "promote",
      candidateId,
      selectedVersionId: versionId,
      changedVersionIds: [versionId],
      occurredAt: "2026-04-10T01:00:00.000Z",
      detail: {
        candidateId,
        versions: [],
        relatedProposals: [],
        activationBlocked: false,
        activationBlockers: [],
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
        versionId: "version-2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(promoteCapabilityCandidate).toHaveBeenCalledWith("candidate-1", "version-2");
    expect(response.json()).toMatchObject({
      action: "promote",
      candidateId: "candidate-1",
      selectedVersionId: "version-2",
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

  it("defaults Code Mode run detail reads to the default workspace", async () => {
    await registerCapabilitiesService({
      getCodeModeRunInScope: vi.fn((runId: string, scope: { workspaceId?: string }) => {
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
      getCapabilityCatalogSnapshot: vi.fn(() => {
        throw new Error("snapshot missing");
      }),
      getCapabilityProposalDetail: vi.fn(() => {
        throw new Error("proposal missing");
      }),
      getCodeModeRunInScope: vi.fn(() => {
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
        versionId: "version-2",
      },
    });
    const rollbackResponse = await app!.inject({
      method: "POST",
      url: "/api/v1/capabilities/candidates/candidate-1/rollback",
      payload: {
        targetVersionId: "version-1",
      },
    });

    expect(revokeResponse.statusCode).toBe(200);
    expect(rollbackResponse.statusCode).toBe(200);
    expect(service.revokeCapabilityCandidate).toHaveBeenCalledWith("candidate-1", "version-2");
    expect(service.rollbackCapabilityCandidate).toHaveBeenCalledWith("candidate-1", "version-1");
    expect(revokeResponse.json()).toMatchObject({
      action: "revoke",
      selectedVersionId: "version-2",
    });
    expect(rollbackResponse.json()).toMatchObject({
      action: "rollback",
      targetVersionId: "version-1",
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
