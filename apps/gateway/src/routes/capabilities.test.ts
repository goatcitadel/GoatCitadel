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

  it("returns the requested catalog scope from the gateway", async () => {
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
    app.decorate("gateway", {
      listCapabilityCatalog,
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

  it("creates a capability proposal through the gateway", async () => {
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
    app.decorate("gateway", {
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
      createCodeModeRun: vi.fn(),
      getCapabilityCatalogSnapshot: vi.fn(),
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

  it("creates a Code Mode run through the gateway", async () => {
    const createCodeModeRun = vi.fn(async (payload: Record<string, unknown>) => ({
      runId: "code-run-1",
      status: "approval_pending",
      language: payload.language,
      requestedOutputIntent: payload.requestedOutputIntent,
      saveCandidateOnSuccess: payload.saveCandidateOnSuccess,
      capabilitySnapshotId: "cap-snap-1",
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
    app.decorate("gateway", {
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
      getCapabilityCatalogSnapshot: vi.fn(),
    } as never);
    await app.register(capabilitiesRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/code-mode/runs",
      payload: {
        language: "typescript",
        source: "return { ok: true };",
        input: { path: "/tmp/demo" },
        requestedOutputIntent: "Summarize files",
        saveCandidateOnSuccess: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createCodeModeRun).toHaveBeenCalledWith({
      language: "typescript",
      source: "return { ok: true };",
      input: { path: "/tmp/demo" },
      requestedOutputIntent: "Summarize files",
      saveCandidateOnSuccess: true,
    });
    expect(response.json()).toMatchObject({
      runId: "code-run-1",
      status: "approval_pending",
      capabilitySnapshotId: "cap-snap-1",
    });
  });

  it("returns candidate detail through the gateway", async () => {
    const getCapabilityCandidateDetail = vi.fn((candidateId: string) => ({
      candidateId,
      versions: [],
      relatedProposals: [],
      activationBlocked: true,
      activationBlockers: ["No candidate version has been promoted into an approved or trusted lifecycle state."],
    }));

    app = Fastify();
    app.decorate("gateway", {
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
      createCodeModeRun: vi.fn(),
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

  it("promotes a candidate through the gateway", async () => {
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
    app.decorate("gateway", {
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
      createCodeModeRun: vi.fn(),
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
});
