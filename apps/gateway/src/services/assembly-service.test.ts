import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AdversarialReview,
  AssemblyArtifactRecord,
  AssemblyParticipantModel,
  AssemblyRound,
  AssemblyRunRecord,
  AssemblySettings,
  ConvergenceScore,
  CreateAssemblyRunInput,
  ModelProposal,
  ModelReputation,
  PeerReview,
} from "@goatcitadel/contracts";
import {
  AdversarialEngine,
  AssemblyService,
  ConvergenceScorer,
  PeerReviewEngine,
  SynthesisEngine,
} from "./assembly-service.js";

const participants: AssemblyParticipantModel[] = [
  { participantId: "p1", providerId: "openai", model: "gpt-5.1" },
  { participantId: "p2", providerId: "anthropic", model: "claude-sonnet-5" },
  { participantId: "p3", providerId: "google", model: "gemini-3-pro" },
];

function createSettings(overrides: Partial<AssemblySettings> = {}): AssemblySettings {
  return {
    mode: "consensus",
    participantModels: participants,
    maxRounds: 1,
    maxCritiquePasses: 1,
    maxInterModelExchanges: 1,
    convergenceThreshold: 0.72,
    stagnationWindow: 2,
    timeBudgetMs: 30_000,
    tokenBudget: 20_000,
    costBudgetUsd: 10,
    domainPreset: "architecture",
    synthesisStyle: "balanced",
    exportTargets: ["artifact"],
    ...overrides,
  };
}

function createProposal(overrides: Partial<ModelProposal> = {}): ModelProposal {
  return {
    runId: "run-1",
    roundIndex: 1,
    proposalId: "proposal-a",
    authorModelRef: "openai:gpt-5.1",
    blindedAuthorToken: "proposal-1",
    abstract: "Extract the runtime collaborator behind a narrow port",
    diagnosis: "The runtime has too many direct responsibilities.",
    proposedSolution: "Introduce a small collaborator and migrate one call path at a time.",
    reasoning: "This preserves behavior while shrinking the surface.",
    risks: ["Hidden coupling", "Partial migration"],
    assumptions: ["Current contracts are stable"],
    confidence: 0.8,
    evidence: [
      { evidenceId: "ev-1", label: "Call graph", detail: "The service owns routing and streaming.", kind: "code" },
      { evidenceId: "ev-2", label: "Tests", detail: "Existing tests pin route behavior.", kind: "claim" },
    ],
    testPlan: [
      { testId: "test-1", title: "Unit route", detail: "Exercise the collaborator boundary.", kind: "unit" },
      { testId: "test-2", title: "Stream path", detail: "Replay the agent stream path.", kind: "integration" },
    ],
    schemaVersion: 1,
    usage: { inputTokens: 250, outputTokens: 120, costUsd: 0.03 },
    createdAt: "2026-05-14T10:00:00.000Z",
    updatedAt: "2026-05-14T10:00:00.000Z",
    ...overrides,
  };
}

function createReview(overrides: Partial<PeerReview> = {}): PeerReview {
  return {
    runId: "run-1",
    roundIndex: 1,
    reviewId: "review-1",
    proposalId: "proposal-a",
    blindedReviewerToken: "blind:anthropic:claude-sonnet-5",
    strengths: ["Bounded migration"],
    weaknesses: ["Needs explicit fallback behavior"],
    missingAssumptions: ["Rollback trigger is not named"],
    failureScenarios: ["The collaborator could duplicate route logic"],
    scores: {
      correctness: 0.82,
      reasoningStrength: 0.78,
      practicality: 0.76,
      evidenceQuality: 0.72,
      riskAwareness: 0.8,
      testability: 0.74,
      clarity: 0.88,
    },
    verdict: "accept",
    confidence: 0.77,
    createdAt: "2026-05-14T10:01:00.000Z",
    ...overrides,
  };
}

function createAdversarialReview(overrides: Partial<AdversarialReview> = {}): AdversarialReview {
  return {
    runId: "run-1",
    roundIndex: 1,
    reviewId: "adv-1",
    proposalId: "proposal-a",
    blindedReviewerToken: "blind:google:gemini-3-pro",
    strengthsFirst: ["The direction is practical"],
    objections: [
      {
        objectionId: "obj-1",
        title: "Fallback is unclear",
        detail: "The plan needs a concrete rollback condition.",
        classification: "critical_flaw",
        evidenceBasis: "evidence_based",
        mitigation: "Pin fallback semantics in a regression test.",
        predictedImpact: "Reduces migration risk.",
      },
    ],
    overallAssessment: "Useful challenge with a bounded fix.",
    usefulnessPending: true,
    createdAt: "2026-05-14T10:02:00.000Z",
    ...overrides,
  };
}

function createConvergence(overrides: Partial<ConvergenceScore> = {}): ConvergenceScore {
  return {
    runId: "run-1",
    roundIndex: 1,
    dimensionScores: {
      rootCause: 0.8,
      solutionDesign: 0.8,
      riskAnalysis: 0.7,
      implementationScope: 0.78,
      evidenceStrength: 0.5,
      confidenceStability: 0.9,
      testPlanAlignment: 0.5,
    },
    proposalSupportScores: { "proposal-a": 0.82 },
    compositeScore: 0.8,
    stagnationDelta: 1,
    disagreementClusters: [],
    minorityFlags: [],
    createdAt: "2026-05-14T10:03:00.000Z",
    ...overrides,
  };
}

function createStorage() {
  const runs = new Map<string, AssemblyRunRecord>();
  const rounds = new Map<string, AssemblyRound[]>();
  const artifacts = new Map<string, AssemblyArtifactRecord[]>();
  const reputations = new Map<string, ModelReputation>();
  const tasks = new Map<string, { taskId: string }>();
  return {
    assembly: {
      createRun: vi.fn((run: AssemblyRunRecord) => {
        runs.set(run.runId, run);
        return run;
      }),
      updateRun: vi.fn((runId: string, patch: Partial<AssemblyRunRecord>) => {
        const next = { ...runs.get(runId), ...patch } as AssemblyRunRecord;
        runs.set(runId, next);
        return next;
      }),
      getRun: vi.fn((runId: string) => runs.get(runId)),
      listRuns: vi.fn((limit = 50) => [...runs.values()].slice(0, limit)),
      saveRound: vi.fn((round: AssemblyRound) => {
        rounds.set(round.runId, [...(rounds.get(round.runId) ?? []), round]);
        return round;
      }),
      listRounds: vi.fn((runId: string) => rounds.get(runId) ?? []),
      saveArtifacts: vi.fn((items: AssemblyArtifactRecord[]) => {
        for (const item of items) {
          artifacts.set(item.runId, [...(artifacts.get(item.runId) ?? []), item]);
        }
      }),
      listArtifacts: vi.fn((runId: string, artifactType?: AssemblyArtifactRecord["artifactType"]) =>
        (artifacts.get(runId) ?? []).filter((item) => !artifactType || item.artifactType === artifactType),
      ),
      listReputations: vi.fn((limit = 50) => [...reputations.values()].slice(0, limit)),
      upsertReputation: vi.fn((reputation: ModelReputation) => {
        reputations.set(reputation.modelRef, reputation);
        return reputation;
      }),
    },
    tasks: {
      create: vi.fn(() => {
        const task = { taskId: `task-${tasks.size + 1}` };
        tasks.set(task.taskId, task);
        return task;
      }),
    },
    taskActivities: { append: vi.fn() },
    taskDeliverables: { append: vi.fn() },
    chatMessages: { upsert: vi.fn() },
  };
}

function createRunInput(overrides: Partial<CreateAssemblyRunInput> = {}): CreateAssemblyRunInput {
  return {
    workspaceId: "workspace-1",
    sourceSessionId: "session-1",
    title: "Runtime decomposition",
    prompt: "Decompose the gateway runtime safely. Preserve existing route behavior.",
    contextRefs: [{ kind: "file", ref: "apps/gateway/src/services/gateway-service.ts", label: "Gateway service" }],
    settings: createSettings(),
    ...overrides,
  };
}

describe("assembly service engines", () => {
  it("assigns blind peer reviews without assigning a proposal to its own author", () => {
    const proposals = [
      createProposal({ proposalId: "proposal-a", authorModelRef: "openai:gpt-5.1" }),
      createProposal({ proposalId: "proposal-b", authorModelRef: "anthropic:claude-sonnet-5" }),
    ];

    const assignments = new PeerReviewEngine().assignBlindReviews(proposals, participants);

    expect(assignments).toHaveLength(2);
    expect(assignments.map((assignment) => assignment.reviewer.providerId)).toEqual(["anthropic", "google"]);
    expect(
      new PeerReviewEngine().detectMergeCandidates([
        createReview({ verdict: "merge", mergeTargetProposalId: "proposal-b" }),
        createReview({ proposalId: "proposal-b", verdict: "accept" }),
      ]),
    ).toEqual(["proposal-a:proposal-b"]);
  });

  it("selects useful adversaries, dedupes repeated objections, and scores challenge quality", () => {
    const engine = new AdversarialEngine();
    const selected = engine.selectAdversaries(
      participants,
      {
        enabled: true,
        reviewerCount: 2,
        selectionStrategy: "auto_selected_by_reputation",
        strictness: "aggressive",
        requireMitigations: true,
        requireEvidenceTags: true,
        defenseRoundEnabled: true,
        repetitiveObjectionCutoff: true,
        minorityReportRequired: true,
      },
      [
        {
          modelRef: "google:gemini-3-pro",
          providerId: "google",
          modelId: "gemini-3-pro",
          overall: 0.5,
          byDomain: {},
          accuracy: 0.5,
          reasoningStrength: 0.5,
          critiqueQuality: 0.5,
          consensusLeadership: 0.5,
          stability: 0.5,
          adversarialUsefulness: 0.95,
          sampleCount: 3,
          updatedAt: "2026-05-14T10:00:00.000Z",
        },
      ],
    );

    const deduped = engine.dedupeObjections([
      createAdversarialReview({
        objections: [
          createAdversarialReview().objections[0]!,
          { ...createAdversarialReview().objections[0]!, objectionId: "obj-duplicate" },
        ],
      }),
    ]);

    expect(selected[0]?.model).toBe("gemini-3-pro");
    expect(deduped[0]?.objections).toHaveLength(1);
    expect(engine.scoreChallenges(deduped)).toBeGreaterThan(0.9);
  });

  it("scores convergence with disagreement clusters and minority flags", () => {
    const scorer = new ConvergenceScorer();
    const score = scorer.scoreRound({
      runId: "run-1",
      roundIndex: 2,
      proposals: [
        createProposal({ proposalId: "proposal-a", confidence: 0.8 }),
        createProposal({ proposalId: "proposal-b", authorModelRef: "google:gemini-3-pro", confidence: 0.25 }),
      ],
      peerReviews: [
        createReview({ proposalId: "proposal-a", verdict: "accept" }),
        createReview({
          proposalId: "proposal-b",
          verdict: "reject",
          scores: { ...createReview().scores, correctness: 0.1, reasoningStrength: 0.2 },
        }),
      ],
      adversarialReviews: [createAdversarialReview({ proposalId: "proposal-b" })],
      previous: createConvergence({ compositeScore: 0.78 }),
    });

    expect(score.proposalSupportScores["proposal-a"]).toBeGreaterThan(score.proposalSupportScores["proposal-b"] ?? 1);
    expect(score.disagreementClusters).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "high" })]));
    expect(score.minorityFlags).toContain("proposal-b");
    expect(scorer.detectStagnation([createConvergence({ compositeScore: 0.8 }), score], 2)).toBeCloseTo(
      Math.abs(score.compositeScore - 0.8),
    );
  });

  it("builds consensus and split-decision summaries from proposal support", () => {
    const engine = new SynthesisEngine();
    const run = {
      runId: "run-1",
      title: "Runtime decomposition",
      problem: { domain: "architecture" },
      settings: createSettings(),
      usage: { costUsd: 0.05 },
    } as AssemblyRunRecord;
    const proposalA = createProposal({ proposalId: "proposal-a", proposedSolution: "Migrate the stream path first." });
    const proposalB = createProposal({
      proposalId: "proposal-b",
      authorModelRef: "anthropic:claude-sonnet-5",
      abstract: "Start with approval lifecycle",
      proposedSolution: "Move approval lifecycle first.",
      risks: ["Approval drift"],
    });
    const convergence = createConvergence({
      proposalSupportScores: { "proposal-a": 0.8, "proposal-b": 0.79 },
      minorityFlags: ["proposal-b"],
      disagreementClusters: [
        {
          clusterId: "cluster-1",
          topic: "Migration order",
          proposalIds: ["proposal-a", "proposal-b"],
          severity: "medium",
          summary: "The first slice is disputed.",
        },
      ],
    });

    const consensus = engine.buildConsensus({
      run,
      proposals: [proposalA, proposalB],
      peerReviews: [createReview()],
      adversarialReviews: [createAdversarialReview()],
      convergence: createConvergence(),
      exports: [{ target: "artifact", status: "generated", relPath: "artifacts/assembly/run-1.md" }],
    });
    const split = engine.buildSplitDecision({
      run,
      proposals: [proposalA, proposalB],
      peerReviews: [createReview()],
      adversarialReviews: [createAdversarialReview()],
      convergence,
      exports: [],
    });

    expect(consensus.recommendation).toBe("Migrate the stream path first.");
    expect(consensus.riskAnalysis).toContain("The plan needs a concrete rollback condition.");
    expect(split.minorityReport?.proposalIds).toEqual(["proposal-a", "proposal-b"]);
    expect(split.recommendation).toContain("Start with approval lifecycle");
  });
});

describe("AssemblyService", () => {
  it("executes a consensus run, exports markdown, and records model reputation", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembly-service-"));
    const storage = createStorage();
    const published: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const createChatCompletion = vi.fn(async (request: { metadata?: { schema?: string } }) => {
      const schema = request.metadata?.schema;
      const payload =
        schema === "PeerReview"
          ? {
              strengths: ["Reviewable migration"],
              weaknesses: ["Needs rollback language"],
              scores: createReview().scores,
              verdict: "accept",
              confidence: 0.8,
            }
          : {
              abstract: "Extract one gateway collaborator",
              diagnosis: "Runtime ownership is crowded.",
              proposedSolution: "Move one runtime path behind a narrow collaborator.",
              reasoning: "Small migrations preserve operator-visible truth.",
              risks: ["Unexpected route coupling"],
              assumptions: ["Tests cover the route"],
              confidence: 0.82,
              evidence: createProposal().evidence,
              testPlan: createProposal().testPlan,
            };
      return {
        model: "test-model",
        choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01, latency_ms: 25 },
        routing: { effectiveModel: "effective-test-model" },
      };
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir,
      createChatCompletion: createChatCompletion as never,
      publishRealtime: (eventType, _source, payload) => published.push({ eventType, payload }),
    });

    try {
      const run = await service.createRun(createRunInput());
      await service.close();
      const detail = service.getRunDetail(run.runId);

      expect(detail.run.status).toBe("completed");
      expect(detail.rounds.map((round) => round.stage)).toEqual([
        "S0_normalize",
        "S1_submit",
        "S2_blind_review",
        "S3_revise",
        "S4_convergence",
        "S5_synthesis",
      ]);
      expect(detail.artifacts.map((artifact) => artifact.artifactType)).toContain("result");
      expect(service.listReputations()).toHaveLength(3);
      expect(published.map((event) => event.eventType)).toContain("assembly_run_completed");
      const artifactPath = path.join(rootDir, "artifacts", "assembly", `${run.runId}.md`);
      await expect(fs.readFile(artifactPath, "utf8")).resolves.toContain("# Runtime decomposition");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("runs adversarial stages and exports to task and chat targets when requested", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembly-service-adversarial-"));
    const storage = createStorage();
    const service = new AssemblyService({
      storage: storage as never,
      rootDir,
      createChatCompletion: vi.fn(async (request: { metadata?: { schema?: string } }) => {
        const schema = request.metadata?.schema;
        const payload =
          schema === "AdversarialReview"
            ? {
                strengthsFirst: ["The proposal is scoped"],
                objections: createAdversarialReview().objections,
                overallAssessment: "Useful risk remains.",
              }
            : schema === "PeerReview"
              ? { ...createReview(), reviewId: undefined }
              : { ...createProposal(), proposalId: undefined };
        return {
          choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
          usage: { input_tokens: 80, output_tokens: 40, costUsd: 0.02, latencyMs: 20 },
        };
      }) as never,
      publishRealtime: vi.fn(),
    });

    try {
      const run = await service.createRun(
        createRunInput({
          settings: createSettings({ exportTargets: ["artifact", "task", "chat"] }),
          adversarialSettings: {
            enabled: true,
            reviewerCount: 1,
            selectionStrategy: "user_selected",
            strictness: "aggressive",
            requireMitigations: true,
            requireEvidenceTags: true,
            defenseRoundEnabled: true,
            repetitiveObjectionCutoff: true,
            minorityReportRequired: true,
            reviewerModelRefs: ["google:gemini-3-pro"],
          },
        }),
      );
      await service.close();
      const detail = service.getRunDetail(run.runId);

      expect(detail.run.status).toBe("completed");
      expect(detail.rounds.map((round) => round.stage)).toEqual(
        expect.arrayContaining([
          "A0_normalize",
          "A1_submit",
          "A2_blind_review",
          "A3_adversarial_challenge",
          "A4_defense_and_revision",
          "A5_convergence",
          "A6_synthesis",
        ]),
      );
      expect(detail.artifacts.map((artifact) => artifact.artifactType)).toContain("defense_response");
      expect(storage.tasks.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: "[Assembly] Runtime decomposition" }),
      );
      expect(storage.chatMessages.upsert).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
