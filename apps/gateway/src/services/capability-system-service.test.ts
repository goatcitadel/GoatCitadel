import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  CapabilityArtifactRecord,
  CapabilityCatalogSnapshotRecord,
  CapabilityProposalEventRecord,
  CapabilityProposalRecord,
  CandidateSkillVersionRecord,
  CodeModeRunRecord,
  PendingApprovalAction,
  ToolCatalogEntry,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { CapabilitySystemService, __internal } from "./capability-system-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("CapabilitySystemService", () => {
  it("freezes sandbox metadata and emits callable-only wrapper manifests for Code Mode runs", async () => {
    const harness = await createHarness({
      toolCatalog: [
        createTool("tool.safe_read", {
          readOnly: true,
          deterministic: true,
          codeModeAllowed: true,
        }),
        createTool("tool.mutate", {
          readOnly: false,
          deterministic: false,
          codeModeAllowed: false,
        }),
      ],
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      requestedOutputIntent: "Summarize a file tree",
      saveCandidateOnSuccess: true,
    });

    expect(run.sandbox).toMatchObject({
      required: true,
      available: false,
    });
    expect(run.sandbox?.checksFailed).toContain("best_effort_host_disabled");
    expect(harness.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sandbox: expect.objectContaining({
            available: false,
          }),
        }),
      }),
    );
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_run_created",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        sandbox: expect.objectContaining({
          available: false,
          required: true,
        }),
      }),
    );

    const manifest = JSON.parse(
      await fs.readFile(path.resolve(harness.rootDir, run.wrapperManifestArtifact.relPath), "utf8"),
    ) as {
      wrappers: Array<{ name: string }>;
    };
    expect(manifest.wrappers).toHaveLength(1);
    expect(manifest.wrappers[0]).toMatchObject({ name: "tool.safe_read" });
  });

  it("returns candidate and proposal detail and supports promotion, rollback, and revoke", async () => {
    const harness = await createHarness();
    const run = harness.storage.codeModeRuns.upsert({
      runId: "code-run-existing",
      status: "completed",
      language: "typescript",
      saveCandidateOnSuccess: true,
      capabilitySnapshotId: "cap-snap-1",
      wrapperManifestHash: "wrap-hash",
      policySnapshotHash: "policy-hash",
      codeHash: "code-hash",
      sandbox: {
        runnerId: "goatcitadel.best-effort-host",
        runnerVersion: "0.1.0",
        platform: "win32",
        isolationProfile: "best_effort_host/temp_only/no_network",
        required: true,
        available: false,
        checksPassed: ["mode_best_effort_host"],
        checksFailed: ["win32_adapter_unimplemented"],
        failClosedReason: "Code Mode sandbox failed closed on win32: win32_adapter_unimplemented.",
      },
      codeArtifact: createArtifact("code.json"),
      wrapperManifestArtifact: createArtifact("wrapper.json"),
      policySnapshotArtifact: createArtifact("policy.json"),
      stdoutTruncated: false,
      stderrTruncated: false,
      createdAt: "2026-04-10T00:00:00.000Z",
      startedAt: "2026-04-10T00:00:01.000Z",
      finishedAt: "2026-04-10T00:00:02.000Z",
      result: { ok: true },
    });

    harness.storage.candidateSkillVersions.upsert(
      createCandidateVersion({
        candidateId: "candidate-demo",
        versionId: "version-a",
        lifecycleState: "candidate",
        originatingRunId: run.runId,
        updatedAt: "2026-04-10T00:01:00.000Z",
      }),
    );
    harness.storage.candidateSkillVersions.upsert(
      createCandidateVersion({
        candidateId: "candidate-demo",
        versionId: "version-b",
        lifecycleState: "candidate",
        originatingRunId: run.runId,
        updatedAt: "2026-04-10T00:02:00.000Z",
      }),
    );

    const proposal = harness.service.createProposal({
      proposalKind: "skill",
      title: "Promote candidate-demo",
      summary: "Review the generated candidate",
      payload: { candidateId: "candidate-demo" },
      candidateId: "candidate-demo",
    });

    expect(harness.service.getCandidateDetail("candidate-demo")).toMatchObject({
      candidateId: "candidate-demo",
      activationBlocked: true,
      originatingRun: expect.objectContaining({ runId: "code-run-existing" }),
    });

    const promoted = harness.service.promoteCandidate("candidate-demo", "version-b");
    expect(promoted.detail.activeVersion?.versionId).toBe("version-b");
    expect(promoted.detail.activationBlocked).toBe(false);

    const rolledBack = harness.service.rollbackCandidate("candidate-demo", "version-a");
    expect(rolledBack.detail.activeVersion?.versionId).toBe("version-a");

    const revoked = harness.service.revokeCandidate("candidate-demo", "version-a");
    expect(revoked.detail.activationBlocked).toBe(true);

    const proposalDetail = harness.service.getProposalDetail(proposal.proposalId);
    expect(proposalDetail).toMatchObject({
      proposal: expect.objectContaining({ proposalId: proposal.proposalId }),
      candidate: expect.objectContaining({ candidateId: "candidate-demo" }),
    });
    expect(proposalDetail.events).toHaveLength(1);
    expect(proposalDetail.events[0]?.eventType).toBe("created");
  });

  it("lists catalog snapshots, runs, proposals, and inline approval queue items", async () => {
    const harness = await createHarness({
      toolCatalog: [createTool("tool.safe_read"), createTool("tool.write", { readOnly: false })],
    });

    expect(harness.service.listCatalog("callable").map((entry) => entry.capabilityId)).toEqual([
      "tool:tool.safe_read",
      "tool:tool.write",
    ]);

    const snapshot = harness.service.freezeCatalogSnapshot();
    expect(harness.service.getCatalogSnapshot(snapshot.snapshotId)).toBe(snapshot);
    expect(snapshot.callableEntries.map((entry) => entry.toolName)).toEqual(["tool.safe_read", "tool.write"]);

    const runRecord: CodeModeRunRecord = {
      runId: "code-run-list",
      status: "approval_pending",
      language: "typescript",
      requestedOutputIntent: "Listable run",
      saveCandidateOnSuccess: false,
      capabilitySnapshotId: snapshot.snapshotId,
      wrapperManifestHash: "wrapper-hash",
      policySnapshotHash: "policy-hash",
      codeHash: "code-hash",
      approvalId: "approval-live",
      sandbox: {
        runnerId: "goatcitadel.best-effort-host",
        runnerVersion: "0.1.0",
        platform: "win32",
        isolationProfile: "best_effort_host/temp_only/no_network",
        required: true,
        available: false,
        checksPassed: [],
        checksFailed: ["best_effort_host_disabled"],
      },
      codeArtifact: createArtifact("list-code.ts"),
      wrapperManifestArtifact: createArtifact("list-wrapper.json"),
      policySnapshotArtifact: createArtifact("list-policy.json"),
      stdoutTruncated: false,
      stderrTruncated: false,
      createdAt: "2026-04-10T00:00:00.000Z",
    };
    harness.storage.codeModeRuns.upsert(runRecord);
    expect(harness.service.listCodeModeRuns(5)).toEqual([runRecord]);
    expect(harness.service.getCodeModeRun("code-run-list")).toBe(runRecord);

    const proposal = harness.service.createProposal({
      proposalKind: "skill",
      title: "Review generated skill",
      summary: "Promote once validated",
      payload: { runId: "code-run-list" },
    });
    expect(harness.service.listProposals(10)).toEqual([proposal]);

    const liveApproval: ApprovalRequest = {
      approvalId: "approval-live",
      kind: "tool.invoke",
      riskLevel: "caution",
      status: "pending",
      payload: {},
      preview: {
        toolName: "fs.write",
        description: "Write the generated candidate.",
        reason: "Operator requested Code Mode execution.",
      },
      linkage: { sessionId: "session-1", toolName: "fs.write" },
      createdAt: "2026-04-10T00:00:01.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      explanationStatus: "not_requested",
    };
    const resolvedApproval: ApprovalRequest = {
      ...liveApproval,
      approvalId: "approval-resolved",
      status: "approved",
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    vi.mocked(harness.storage.approvals.get).mockImplementation((approvalId: string) => {
      if (approvalId === "approval-live") {
        return liveApproval;
      }
      if (approvalId === "approval-resolved") {
        return resolvedApproval;
      }
      throw new Error(`Missing approval ${approvalId}`);
    });
    vi.mocked(harness.storage.chatInlineApprovals.listBySession).mockReturnValue([
      {
        approvalId: "approval-live",
        sessionId: "session-1",
        turnId: "turn-1",
        status: "pending",
        createdAt: "2026-04-10T00:00:01.000Z",
        details: {},
      },
      {
        approvalId: "approval-resolved",
        sessionId: "session-1",
        turnId: "turn-2",
        status: "pending",
        createdAt: "2026-04-10T00:00:02.000Z",
        details: {},
      },
      {
        approvalId: "approval-orphan",
        sessionId: "session-1",
        turnId: "turn-3",
        status: "failed",
        createdAt: "2026-04-10T00:00:03.000Z",
        details: { toolName: "code_mode.run", description: "Missing durable approval row" },
      },
    ] as never);

    expect(harness.service.listChatPendingApprovals("session-1")).toEqual([
      expect.objectContaining({
        approvalId: "approval-live",
        toolName: "fs.write",
        reason: "Write the generated candidate.",
        stale: false,
      }),
      expect.objectContaining({
        approvalId: "approval-resolved",
        stale: true,
        staleReason: "approved",
      }),
      expect.objectContaining({
        approvalId: "approval-orphan",
        toolName: "code_mode.run",
        reason: "Missing durable approval row",
        stale: true,
        staleReason: "failed",
      }),
    ]);
  });

  it("publishes an explicit advisory event when Code Mode runs without available host isolation", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, mode: 'advisory' };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        sandbox: expect.objectContaining({
          available: false,
          required: false,
        }),
      }),
    });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_sandbox_unavailable",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        sandbox: expect.objectContaining({
          available: false,
          required: false,
        }),
      }),
    );
  });

  it("does not pass provider or gateway secrets into Code Mode child environments", () => {
    const priorOpenAi = process.env.OPENAI_API_KEY;
    const priorGatewayToken = process.env.GOATCITADEL_AUTH_TOKEN;
    try {
      process.env.OPENAI_API_KEY = "sk-code-mode-secret";
      process.env.GOATCITADEL_AUTH_TOKEN = "gateway-token-secret";
      const env = __internal.createMinimalSyntheticEnv();

      expect(env.GOATCITADEL_CODE_MODE).toBe("1");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GOATCITADEL_AUTH_TOKEN).toBeUndefined();
    } finally {
      if (priorOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = priorOpenAi;
      }
      if (priorGatewayToken === undefined) {
        delete process.env.GOATCITADEL_AUTH_TOKEN;
      } else {
        process.env.GOATCITADEL_AUTH_TOKEN = priorGatewayToken;
      }
    }
  });

  it("fails closed before child execution when required host isolation is unavailable", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: true,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, shouldNotExecute: true };",
      requestedOutputIntent: "Return a JSON object.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "failed",
        error: expect.stringContaining("Code Mode sandbox failed closed"),
        sandbox: expect.objectContaining({
          available: false,
          required: true,
        }),
      }),
    });
    expect(storedRun).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Code Mode sandbox failed closed"),
    });
    expect(harness.invokeTool).not.toHaveBeenCalled();
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "code_mode_sandbox_unavailable",
      "capabilities",
      expect.objectContaining({
        runId: run.runId,
        sandbox: expect.objectContaining({
          available: false,
          required: true,
        }),
      }),
    );
  });

  it("stages a candidate bundle after approval and execution when candidate save is enabled", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: "return { ok: true, bundle: 'candidate' };",
      requestedOutputIntent: "Generate a reusable helper skill.",
      saveCandidateOnSuccess: true,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");

    const candidates = harness.storage.candidateSkillVersions.list(10);
    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "completed",
      }),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKind: "code_mode_generated",
      originatingRunId: run.runId,
      lifecycleState: "candidate",
    });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "candidate_skill_staged",
      "capabilities",
      expect.objectContaining({
        originatingRunId: run.runId,
      }),
    );
  });

  it("persists truncation markers when stdout/stderr exceed the capture budget", async () => {
    const harness = await createHarness({
      sandboxConfig: {
        required: false,
        bestEffortHostEnabled: false,
      },
    });

    const run = await harness.service.createCodeModeRun({
      language: "typescript",
      source: `
        console.log("x".repeat(70000));
        console.error("y".repeat(70000));
        return { ok: true };
      `,
      requestedOutputIntent: "Exercise bounded output capture.",
      saveCandidateOnSuccess: false,
    });

    const result = await harness.service.executeApprovedCodeModeRun("approval-1");
    const storedRun = harness.storage.codeModeRuns.get(run.runId);
    const stdoutArtifactPath = path.resolve(harness.rootDir, storedRun.stdoutArtifact!.relPath);
    const stderrArtifactPath = path.resolve(harness.rootDir, storedRun.stderrArtifact!.relPath);
    const stdout = await fs.readFile(stdoutArtifactPath, "utf8");
    const stderr = await fs.readFile(stderrArtifactPath, "utf8");

    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        runId: run.runId,
        status: "completed",
      }),
    });
    expect(storedRun.stdoutTruncated).toBe(true);
    expect(storedRun.stderrTruncated).toBe(true);
    expect(stdout).toContain("...[truncated]");
    expect(stderr).toContain("...[truncated]");
    expect(storedRun.stdoutPreview).toContain("...[truncated]");
    expect(storedRun.stderrPreview).toContain("...[truncated]");
  });
});

async function createHarness(input?: {
  toolCatalog?: ToolCatalogEntry[];
  sandboxConfig?: {
    required?: boolean;
    bestEffortHostEnabled?: boolean;
  };
}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-capability-system-"));
  tempRoots.push(rootDir);
  const storage = createFakeStorage();
  const publishRealtime = vi.fn();
  const invokeTool = vi.fn(
    async (): Promise<ToolInvokeResult> => ({
      outcome: "executed",
      policyReason: "executed",
      auditEventId: "audit-1",
      result: { ok: true },
    }),
  );
  const createApproval = vi.fn(
    async (request: ApprovalCreateInput): Promise<ApprovalRequest> => ({
      approvalId: "approval-1",
      kind: request.kind,
      riskLevel: request.riskLevel,
      status: "pending",
      payload: request.payload,
      preview: request.preview,
      linkage: request.linkage,
      createdAt: "2026-04-10T00:00:00.000Z",
      expiresAt: request.expiresAt ?? undefined,
      explanationStatus: "not_requested",
    }),
  );

  const service = new CapabilitySystemService({
    rootDir,
    runtimeConfig: {
      candidateRoot: "./data/capability-candidates",
      codeModeArtifactRoot: "./data/code-mode-artifacts",
      tempRoot: "./data/code-mode-temp",
      codeModeSandbox: {
        mode: "best_effort_host",
        required: input?.sandboxConfig?.required ?? true,
        bestEffortHostEnabled: input?.sandboxConfig?.bestEffortHostEnabled ?? false,
      },
    },
    storage: storage as never,
    readFeatureFlags: () => ({
      codeModeV1Enabled: true,
    }),
    listToolCatalog: () => input?.toolCatalog ?? [createTool("tool.safe_read")],
    listLoadedSkills: () => [],
    readSkillStates: () => new Map(),
    invokeTool,
    createApproval,
    publishRealtime,
    readPolicySnapshot: () => ({ mode: "test" }),
  });

  return {
    rootDir,
    storage,
    service,
    createApproval,
    publishRealtime,
    invokeTool,
  };
}

function createFakeStorage() {
  const snapshots = new Map<string, CapabilityCatalogSnapshotRecord>();
  const proposals = new Map<string, CapabilityProposalRecord>();
  const proposalEvents = new Map<string, CapabilityProposalEventRecord[]>();
  const codeModeRuns = new Map<string, CodeModeRunRecord>();
  const candidateVersions = new Map<string, CandidateSkillVersionRecord>();
  const pendingActions = new Map<string, PendingApprovalAction>();

  return {
    capabilityCatalogSnapshots: {
      create(snapshot: CapabilityCatalogSnapshotRecord) {
        snapshots.set(snapshot.snapshotId, snapshot);
        return snapshot;
      },
      get(snapshotId: string) {
        const snapshot = snapshots.get(snapshotId);
        if (!snapshot) {
          throw new Error(`Missing snapshot ${snapshotId}`);
        }
        return snapshot;
      },
    },
    skillLifecycle: {
      find: () => undefined,
      upsert: vi.fn(),
    },
    capabilityProposals: {
      upsert(record: CapabilityProposalRecord) {
        proposals.set(record.proposalId, record);
        return record;
      },
      list(limit = 100) {
        return [...proposals.values()].slice(0, limit);
      },
      get(proposalId: string) {
        const proposal = proposals.get(proposalId);
        if (!proposal) {
          throw new Error(`Missing proposal ${proposalId}`);
        }
        return proposal;
      },
    },
    capabilityProposalEvents: {
      append(record: CapabilityProposalEventRecord) {
        const items = proposalEvents.get(record.proposalId) ?? [];
        items.push(record);
        proposalEvents.set(record.proposalId, items);
        return record;
      },
      listByProposalId(proposalId: string) {
        return proposalEvents.get(proposalId) ?? [];
      },
    },
    approvals: {
      get: vi.fn((approvalId: string) => {
        throw new Error(`Missing approval ${approvalId}`);
      }),
    },
    codeModeRuns: {
      upsert(record: CodeModeRunRecord) {
        codeModeRuns.set(record.runId, record);
        return record;
      },
      get(runId: string) {
        const run = codeModeRuns.get(runId);
        if (!run) {
          throw new Error(`Missing run ${runId}`);
        }
        return run;
      },
      find(runId: string) {
        return codeModeRuns.get(runId);
      },
      list(limit = 100) {
        return [...codeModeRuns.values()].slice(0, limit);
      },
    },
    candidateSkillVersions: {
      upsert(record: CandidateSkillVersionRecord) {
        candidateVersions.set(record.versionId, record);
        return record;
      },
      get(versionId: string) {
        const version = candidateVersions.get(versionId);
        if (!version) {
          throw new Error(`Missing candidate version ${versionId}`);
        }
        return version;
      },
      list(limit = 100) {
        return [...candidateVersions.values()].slice(0, limit);
      },
      listByCandidateId(candidateId: string, limit = 100) {
        return [...candidateVersions.values()]
          .filter((version) => version.candidateId === candidateId)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, limit);
      },
      findLatestByCandidateId(candidateId: string) {
        return this.listByCandidateId(candidateId, 1)[0];
      },
      updateLifecycleState(
        versionId: string,
        lifecycleState: CandidateSkillVersionRecord["lifecycleState"],
        updatedAt: string,
      ) {
        const current = this.get(versionId);
        const next = {
          ...current,
          lifecycleState,
          updatedAt,
        };
        candidateVersions.set(versionId, next);
        return next;
      },
    },
    pendingApprovalActions: {
      upsertPending(input: PendingApprovalAction) {
        pendingActions.set(input.approvalId, {
          ...input,
          resolutionStatus: "pending",
        });
      },
      find(approvalId: string) {
        return pendingActions.get(approvalId);
      },
      markResolved: vi.fn(),
    },
    approvalEvents: {
      append: vi.fn(),
    },
    chatInlineApprovals: {
      upsert: vi.fn(),
      listBySession: vi.fn(() => []),
    },
    runImmediateTransaction<T>(callback: () => T): T {
      return callback();
    },
  };
}

function createTool(
  toolName: string,
  overrides?: Partial<Pick<ToolCatalogEntry, "readOnly" | "deterministic" | "codeModeAllowed">>,
): ToolCatalogEntry {
  return {
    toolName,
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: `${toolName} description`,
    argSchema: { type: "object" },
    examples: [],
    pack: "core",
    readOnly: overrides?.readOnly ?? true,
    deterministic: overrides?.deterministic ?? true,
    codeModeAllowed: overrides?.codeModeAllowed ?? true,
  };
}

function createArtifact(filename: string): CapabilityArtifactRecord {
  return {
    artifactId: `artifact-${filename}`,
    relPath: `data/${filename}`,
    sha256: `sha-${filename}`,
    bytes: 32,
    mimeType: "application/json",
    createdAt: "2026-04-10T00:00:00.000Z",
  };
}

function createCandidateVersion(
  input: Pick<CandidateSkillVersionRecord, "candidateId" | "versionId" | "lifecycleState" | "originatingRunId"> & {
    updatedAt: string;
  },
): CandidateSkillVersionRecord {
  return {
    candidateId: input.candidateId,
    versionId: input.versionId,
    sourceKind: "code_mode_generated",
    title: input.versionId,
    summary: `${input.versionId} summary`,
    bundleRoot: `data/capability-candidates/${input.candidateId}/${input.versionId}`,
    originatingRunId: input.originatingRunId,
    wrapperManifestHash: "wrap-hash",
    lifecycleState: input.lifecycleState,
    manifestArtifact: createArtifact(`${input.versionId}-manifest.json`),
    instructionArtifact: createArtifact(`${input.versionId}-skill.md`),
    proofArtifact: createArtifact(`${input.versionId}-proof.json`),
    programArtifact: createArtifact(`${input.versionId}-program.ts`),
    schemaArtifact: createArtifact(`${input.versionId}-schemas.json`),
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: input.updatedAt,
    lastSuccessfulExecutionAt: "2026-04-10T00:00:00.000Z",
  };
}
