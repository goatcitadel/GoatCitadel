import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type {
  AdversarialReview,
  AssemblyArtifactRecord,
  AssemblyParticipantModel,
  AssemblyProblem,
  AssemblyRound,
  AssemblyRunRecord,
  AssemblySettings,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatRoutedContextSnapshotRecord,
  ChatTurnCapabilityProfileRecord,
  ConvergenceScore,
  CreateAssemblyRunInput,
  ModelProposal,
  ModelReputation,
  ModelUsageAttributionContext,
  ModelUsageEventRecord,
  PeerReview,
} from "@goatcitadel/contracts";
import {
  AdversarialEngine,
  AssemblyService,
  ConvergenceScorer,
  PeerReviewEngine,
  ProviderAdapterRegistry,
  SynthesisEngine,
  bindAssemblyChatCompletion,
  buildModelCouncilSynthesisThinkingOptions,
  type ExecuteChatModelCouncilInput,
} from "./assembly-service.js";
import { buildAnthropicMessagesPayload } from "./llm-provider-anthropic.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("model council synthesis thinking controls", () => {
  it("retains deterministic sampling only when reasoning is explicitly off", () => {
    expect(buildModelCouncilSynthesisThinkingOptions("openai", "openai-responses", "gpt-5.4", "off")).toEqual({
      temperature: 0.1,
      max_tokens: 1_600,
      reasoning: { effort: "none" },
    });
    expect(buildModelCouncilSynthesisThinkingOptions("openai", "openai-responses", "gpt-5.4", "deep")).toEqual({
      max_tokens: 1_600,
      reasoning: { effort: "xhigh" },
    });
    expect(
      buildModelCouncilSynthesisThinkingOptions("anthropic", "anthropic-messages", "claude-sonnet-4-6", "standard"),
    ).toEqual({
      max_tokens: 5_696,
      reasoning: { effort: "medium" },
    });
    expect(
      buildModelCouncilSynthesisThinkingOptions("anthropic", "anthropic-messages", "claude-opus-4-8", "deep"),
    ).toEqual({
      max_tokens: 17_984,
      reasoning: { effort: "xhigh" },
    });
    expect(
      buildAnthropicMessagesPayload(
        {
          messages: [{ role: "user", content: "Synthesize." }],
          ...buildModelCouncilSynthesisThinkingOptions(
            "custom-claude",
            "anthropic-messages",
            "claude-opus-4-8",
            "deep",
          ),
        },
        "claude-opus-4-8",
      ),
    ).toMatchObject({
      max_tokens: 17_984,
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    });
    expect(() =>
      buildModelCouncilSynthesisThinkingOptions("anthropic", "anthropic-messages", "claude-sonnet-4-6", "deep"),
    ).toThrow(/does not support xhigh/i);
    expect(() =>
      buildModelCouncilSynthesisThinkingOptions("anthropic", "anthropic-messages", "claude-fable-5", "off"),
    ).toThrow(/cannot honor an explicit reasoning-off/i);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function testDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

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
    __state: { runs, rounds, artifacts },
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
      findCouncilRunByTurn: vi.fn((turnId: string) =>
        [...runs.values()].find((run) => run.runKind === "chat_model_council" && run.sourceTurnId === turnId),
      ),
      claimCouncilRun: vi.fn((input: { runId: string; leaseOwnerId: string; now: string; leaseExpiresAt: string }) => {
        const current = runs.get(input.runId);
        if (!current || current.status === "completed") return undefined;
        if (
          current.leaseOwnerId &&
          current.leaseOwnerId !== input.leaseOwnerId &&
          current.leaseExpiresAt &&
          current.leaseExpiresAt > input.now
        ) {
          return undefined;
        }
        const next: AssemblyRunRecord = {
          ...current,
          status: "running",
          startedAt: current.startedAt ?? input.now,
          leaseOwnerId: input.leaseOwnerId,
          leaseExpiresAt: input.leaseExpiresAt,
          generation: (current.generation ?? 0) + 1,
          updatedAt: input.now,
        };
        runs.set(input.runId, next);
        return next;
      }),
      renewCouncilRunLease: vi.fn((input: Record<string, unknown>) => {
        const runId = String(input.runId);
        const current = runs.get(runId);
        if (
          !current ||
          current.status !== "running" ||
          current.generation !== input.expectedGeneration ||
          current.currentStage !== input.expectedStage ||
          current.leaseOwnerId !== input.leaseOwnerId ||
          !current.leaseExpiresAt ||
          current.leaseExpiresAt <= String(input.now)
        ) {
          return undefined;
        }
        const next: AssemblyRunRecord = {
          ...current,
          generation: (current.generation ?? 0) + 1,
          leaseExpiresAt: String(input.leaseExpiresAt),
          updatedAt: String(input.now),
        };
        runs.set(runId, next);
        return next;
      }),
      advanceCouncilRun: vi.fn((input: Record<string, unknown>) => {
        const runId = String(input.runId);
        const current = runs.get(runId);
        if (
          !current ||
          current.generation !== input.expectedGeneration ||
          current.currentStage !== input.expectedStage ||
          current.leaseOwnerId !== input.leaseOwnerId
        ) {
          return undefined;
        }
        const next: AssemblyRunRecord = {
          ...current,
          status: input.status as AssemblyRunRecord["status"],
          currentStage: input.nextStage as AssemblyRunRecord["currentStage"],
          currentRoundIndex: Number(input.currentRoundIndex),
          generation: (current.generation ?? 0) + 1,
          leaseExpiresAt: input.leaseExpiresAt as string,
          result: input.result as AssemblyRunRecord["result"],
          usage: input.usage as AssemblyRunRecord["usage"],
          error: input.error as string | undefined,
          councilEvidence: input.councilEvidence as AssemblyRunRecord["councilEvidence"],
          finishedAt: input.finishedAt as string | undefined,
          updatedAt: String(input.updatedAt),
        };
        runs.set(runId, next);
        return next;
      }),
      listRuns: vi.fn((limit = 50) => [...runs.values()].slice(0, limit)),
      saveRound: vi.fn((round: AssemblyRound) => {
        rounds.set(round.runId, [...(rounds.get(round.runId) ?? []), round]);
        return round;
      }),
      saveCouncilRoundExact: vi.fn((round: AssemblyRound) => {
        const existing = (rounds.get(round.runId) ?? []).find((candidate) => candidate.roundId === round.roundId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(round)) {
          throw new Error(`Model council round ${round.roundId} conflicts with its immutable canonical bytes.`);
        }
        if (!existing) rounds.set(round.runId, [...(rounds.get(round.runId) ?? []), round]);
        return existing ?? round;
      }),
      listRounds: vi.fn((runId: string) => rounds.get(runId) ?? []),
      saveArtifacts: vi.fn((items: AssemblyArtifactRecord[]) => {
        for (const item of items) {
          artifacts.set(item.runId, [...(artifacts.get(item.runId) ?? []), item]);
        }
      }),
      saveCouncilArtifactsExact: vi.fn((items: AssemblyArtifactRecord[]) => {
        for (const item of items) {
          const existing = (artifacts.get(item.runId) ?? []).find(
            (candidate) => candidate.artifactId === item.artifactId,
          );
          if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
            throw new Error(`Model council artifact ${item.artifactId} conflicts with its immutable canonical bytes.`);
          }
          if (!existing) artifacts.set(item.runId, [...(artifacts.get(item.runId) ?? []), item]);
        }
        return items;
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
    routedContextSnapshots: { get: vi.fn() },
  };
}

function createCouncilCapabilityProfile(turnId = "turn-1"): ChatTurnCapabilityProfileRecord {
  return {
    profileId: `profile-${turnId}`,
    identity: { turnId, sessionId: "session-1", workspaceId: "default" },
    selection: { effectiveProviderId: "openai", effectiveModel: "gpt-5.4" },
    governance: {
      authReadiness: [{ kind: "provider", ref: "openai", status: "ready", reasonCodes: [] }],
    },
    hashes: { profileHash: "a".repeat(64) },
  } as ChatTurnCapabilityProfileRecord;
}

function createCouncilExecutionInput(
  overrides: Partial<ExecuteChatModelCouncilInput> = {},
): ExecuteChatModelCouncilInput {
  const turnId = overrides.turnId ?? "turn-1";
  return {
    turnId,
    sessionId: "session-1",
    workspaceId: "default",
    content: "Compare the two approaches.",
    history: [{ role: "user", content: "Compare the two approaches." }],
    capabilityProfile: createCouncilCapabilityProfile(turnId),
    providerCandidates: [
      {
        providerId: "openai",
        model: "gpt-5.4",
        apiStyle: "openai-responses",
        contextWindowTokens: 128_000,
        routeConfigFingerprint: "1".repeat(64),
      },
      {
        providerId: "anthropic",
        model: "claude-sonnet-5",
        apiStyle: "anthropic-messages",
        contextWindowTokens: 200_000,
        routeConfigFingerprint: "2".repeat(64),
      },
    ],
    ...overrides,
  };
}

function createCouncilCompletion(
  request: ChatCompletionRequest,
  content: string,
  eventId: string,
): ChatCompletionResponse {
  return {
    model: request.model,
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 },
    modelUsageEventIds: [eventId],
    routing: {
      effectiveProviderId: request.providerId,
      effectiveModel: request.model,
      fallbackUsed: false,
    },
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

function createProblem(overrides: Partial<AssemblyProblem> = {}): AssemblyProblem {
  return {
    runId: "run-1",
    domain: "architecture",
    title: "Runtime decomposition",
    originalPrompt: "Decompose the gateway runtime safely.",
    normalizedStatement: "Decompose the gateway runtime safely.",
    objectives: ["Decompose the gateway runtime safely"],
    constraints: ["Preserve behavior"],
    evaluationCriteria: ["Correctness"],
    contextRefs: [],
    createdAt: "2026-05-14T10:00:00.000Z",
    ...overrides,
  };
}

function createStructuredAssemblyCompletion(request: ChatCompletionRequest): ChatCompletionResponse {
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
    model: request.model ?? "assembly-test-model",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) } }],
    usage: { input_tokens: 80, output_tokens: 40 },
  };
}

const authoritativeAccountingErrorNames = [
  "ModelUsageSettlementError",
  "ModelUsageDispatchPersistenceError",
  "ModelUsageDispatchUncertainError",
] as const;

const authoritativeAssemblyStageCases = [
  { stage: "proposal", schema: "ModelProposal", artifactType: "proposal" },
  { stage: "peer review", schema: "PeerReview", artifactType: "peer_review" },
  {
    stage: "adversarial review",
    schema: "AdversarialReview",
    artifactType: "adversarial_review",
  },
].flatMap((stageCase) => authoritativeAccountingErrorNames.map((errorName) => ({ ...stageCase, errorName })));

describe("assembly service engines", () => {
  it("binds the Gateway completion host without dropping exact attribution arg2", async () => {
    const request: ChatCompletionRequest = {
      providerId: "openai",
      model: "gpt-5.1",
      messages: [{ role: "user", content: "Propose a bounded change." }],
    };
    const attribution: ModelUsageAttributionContext = {
      operationId: "assembly:run-1:round-1:A1_submit:p1:proposal:proposal-1",
      callKind: "assembly_participant",
      assemblyRunId: "run-1",
      assemblyRoundIndex: 1,
      assemblyStage: "A1_submit",
      workerId: "p1",
    };
    const response: ChatCompletionResponse = {
      choices: [{ index: 0, message: { role: "assistant", content: "{}" } }],
    };
    const host = {
      createChatCompletion: vi.fn(
        async (_request: ChatCompletionRequest, _attribution: ModelUsageAttributionContext) => response,
      ),
    };

    const result = await bindAssemblyChatCompletion(host)(request, attribution);

    expect(result).toBe(response);
    expect(host.createChatCompletion).toHaveBeenCalledOnce();
    expect(host.createChatCompletion).toHaveBeenCalledWith(request, attribution);
    expect(host.createChatCompletion.mock.calls[0]?.[1]).toBe(attribution);
  });

  it("keeps requested participant attribution while exposing an effective provider fallback", async () => {
    const attribution: ModelUsageAttributionContext = {
      operationId: "assembly:run-1:round-1:A1_submit:p1:proposal:proposal-1",
      callKind: "assembly_participant",
      requestedProviderId: "openai",
      requestedModelId: "gpt-5.1",
      assemblyRunId: "run-1",
      assemblyRoundIndex: 1,
      assemblyStage: "A1_submit",
      workerId: "p1",
      agentId: "p1",
    };
    const createChatCompletion = vi.fn(
      async (_request: ChatCompletionRequest, _attribution: ModelUsageAttributionContext) =>
        ({
          model: "fallback-model",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ abstract: "ok" }) } }],
          routing: {
            primaryProviderId: "openai",
            primaryModel: "gpt-5.1",
            effectiveProviderId: "fallback-provider",
            effectiveModel: "fallback-model",
            fallbackProviderId: "fallback-provider",
            fallbackModel: "fallback-model",
            fallbackReason: "primary unavailable",
            fallbackUsed: true,
          },
        }) satisfies ChatCompletionResponse,
    );
    const registry = new ProviderAdapterRegistry(createChatCompletion);

    const result = await registry.invokeStructured({
      participant: participants[0]!,
      problem: createProblem(),
      stage: "A1_submit",
      instructions: "Propose a bounded change.",
      schemaLabel: "ModelProposal",
      fallbackPayload: { abstract: "fallback" },
      attribution,
    });

    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", model: "gpt-5.1" }),
      attribution,
    );
    expect(result).toMatchObject({
      providerId: "fallback-provider",
      modelId: "fallback-model",
      modelRef: "openai:gpt-5.1",
    });
  });

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
  it("leaves a durable Assembly run queued when shared-host admission is closed", async () => {
    const storage = createStorage();
    const createChatCompletion = vi.fn();
    const runBackgroundWork = vi.fn(async () => undefined);
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: ".",
      createChatCompletion,
      publishRealtime: vi.fn(),
      runBackgroundWork,
    });

    const run = await service.createRun(createRunInput());
    await service.close();

    expect(runBackgroundWork).toHaveBeenCalledWith(`assembly-run:${run.runId}`, expect.any(Function));
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(storage.assembly.getRun(run.runId)).toMatchObject({ status: "queued" });
  });

  it.each([
    {
      name: "blank",
      participantModels: [participants[0]!, { ...participants[1]!, participantId: "   " }],
      expected: /non-blank stable worker identity/,
    },
    {
      name: "duplicate",
      participantModels: [participants[0]!, { ...participants[1]!, participantId: "p1" }],
      expected: /unique after trimming and normalization/,
    },
    {
      name: "whitespace collision",
      participantModels: [participants[0]!, { ...participants[1]!, participantId: "  p1  " }],
      expected: /unique after trimming and normalization/,
    },
    {
      name: "case-normalized collision",
      participantModels: [participants[0]!, { ...participants[1]!, participantId: "P1" }],
      expected: /unique after trimming and normalization/,
    },
  ])("rejects $name participant worker identities before admitting a run", async ({ participantModels, expected }) => {
    const storage = createStorage();
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: ".",
      createChatCompletion: vi.fn(),
      publishRealtime: vi.fn(),
    });

    await expect(
      service.createRun(
        createRunInput({
          settings: createSettings({ participantModels }),
        }),
      ),
    ).rejects.toThrow(expected);
    expect(storage.assembly.createRun).not.toHaveBeenCalled();
  });

  it.each(authoritativeAssemblyStageCases)(
    "fails the run instead of persisting a $stage fallback for $errorName",
    async ({ schema, artifactType, errorName }) => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembly-service-accounting-fault-"));
      const storage = createStorage();
      const publishRealtime = vi.fn();
      let injected = false;
      const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
        if (!injected && request.metadata?.schema === schema) {
          injected = true;
          const error = new Error(`injected ${errorName} during ${schema}`);
          error.name = errorName;
          throw error;
        }
        return createStructuredAssemblyCompletion(request);
      });
      const service = new AssemblyService({
        storage: storage as never,
        rootDir,
        createChatCompletion,
        publishRealtime,
      });

      try {
        const run = await service.createRun(
          createRunInput({
            adversarialSettings: {
              enabled: true,
              reviewerCount: 1,
              selectionStrategy: "user_selected",
              strictness: "aggressive",
              requireMitigations: true,
              requireEvidenceTags: true,
              defenseRoundEnabled: false,
              repetitiveObjectionCutoff: true,
              minorityReportRequired: true,
              reviewerModelRefs: ["google:gemini-3-pro"],
            },
          }),
        );
        await service.close();

        expect(injected).toBe(true);
        expect(storage.assembly.getRun(run.runId)).toMatchObject({
          status: "failed",
          error: `injected ${errorName} during ${schema}`,
        });
        expect(
          storage.assembly.listArtifacts(run.runId, artifactType as AssemblyArtifactRecord["artifactType"]),
        ).toEqual([]);
        expect(publishRealtime).toHaveBeenCalledWith(
          "assembly_run_failed",
          "assembly",
          expect.objectContaining({
            runId: run.runId,
            error: `injected ${errorName} during ${schema}`,
          }),
        );
      } finally {
        await service.close();
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    },
  );

  it("preserves ordinary participant failure fallbacks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembly-service-ordinary-fallback-"));
    const storage = createStorage();
    let injected = false;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      if (!injected && request.metadata?.schema === "ModelProposal") {
        injected = true;
        throw new Error("ordinary participant outage");
      }
      return createStructuredAssemblyCompletion(request);
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir,
      createChatCompletion,
      publishRealtime: vi.fn(),
    });

    try {
      const run = await service.createRun(createRunInput());
      await service.close();

      expect(injected).toBe(true);
      expect(storage.assembly.getRun(run.runId)).toMatchObject({ status: "completed" });
      const proposals = storage.assembly.listArtifacts(run.runId, "proposal");
      expect(proposals.length).toBeGreaterThanOrEqual(participants.length);
      expect(
        proposals.some((artifact) =>
          String((artifact.payload as ModelProposal).abstract).includes("recommends an incremental"),
        ),
      ).toBe(true);
    } finally {
      await service.close();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("attributes every charged participant work item with stable Assembly source scope", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembly-service-attribution-"));
    const storage = createStorage();
    const invocations: Array<{
      request: ChatCompletionRequest;
      attribution: ModelUsageAttributionContext;
    }> = [];
    const createChatCompletion = vi.fn(
      async (
        request: ChatCompletionRequest,
        attribution: ModelUsageAttributionContext,
      ): Promise<ChatCompletionResponse> => {
        invocations.push({ request, attribution });
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
          model: `effective-${request.model}`,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) } }],
          usage: { input_tokens: 80, output_tokens: 40 },
          routing: {
            primaryProviderId: request.providerId,
            primaryModel: request.model,
            effectiveProviderId: `fallback-${request.providerId}`,
            effectiveModel: `effective-${request.model}`,
            fallbackProviderId: `fallback-${request.providerId}`,
            fallbackModel: `effective-${request.model}`,
            fallbackUsed: true,
          },
        };
      },
    );
    const service = new AssemblyService({
      storage: storage as never,
      rootDir,
      createChatCompletion,
      publishRealtime: vi.fn(),
    });

    try {
      const run = await service.createRun(
        createRunInput({
          sourceTaskId: "source-task-1",
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

      expect(invocations).toHaveLength(9);
      expect(new Set(invocations.map(({ attribution }) => attribution.operationId)).size).toBe(9);
      expect(invocations.map(({ attribution }) => attribution.assemblyStage)).not.toContain("A6_synthesis");
      expect(invocations.map(({ attribution }) => attribution.callKind)).not.toContain("assembly_synthesis");

      for (const { request, attribution } of invocations) {
        const participant = participants.find(
          (candidate) => candidate.providerId === request.providerId && candidate.model === request.model,
        );
        expect(participant).toBeDefined();
        expect(attribution).toMatchObject({
          callKind: "assembly_participant",
          requestedProviderId: request.providerId,
          requestedModelId: request.model,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          taskId: "source-task-1",
          agentId: participant!.participantId,
          workerId: participant!.participantId,
          assemblyRunId: run.runId,
          assemblyRoundIndex: 1,
          parentOperationId: `assembly:${encodeURIComponent(run.runId)}`,
        });
      }

      const proposals = invocations.filter(({ attribution }) => attribution.assemblyStage === "A1_submit");
      const peerReviews = invocations.filter(({ attribution }) => attribution.assemblyStage === "A2_blind_review");
      const adversarialReviews = invocations.filter(
        ({ attribution }) => attribution.assemblyStage === "A3_adversarial_challenge",
      );
      expect(proposals).toHaveLength(3);
      expect(peerReviews).toHaveLength(3);
      expect(adversarialReviews).toHaveLength(3);
      expect(new Set(peerReviews.map(({ attribution }) => attribution.operationId)).size).toBe(3);
      expect(new Set(adversarialReviews.map(({ attribution }) => attribution.operationId)).size).toBe(3);
      expect(new Set(adversarialReviews.map(({ attribution }) => attribution.workerId))).toEqual(new Set(["p3"]));
      expect(proposals.map(({ attribution }) => attribution.operationId).sort()).toEqual(
        [
          `assembly:${run.runId}:round-1:A1_submit:p1:proposal:proposal-1`,
          `assembly:${run.runId}:round-1:A1_submit:p2:proposal:proposal-2`,
          `assembly:${run.runId}:round-1:A1_submit:p3:proposal:proposal-3`,
        ].sort(),
      );
      expect(peerReviews.map(({ attribution }) => attribution.operationId).sort()).toEqual(
        [
          `assembly:${run.runId}:round-1:A2_blind_review:p2:peer-review:proposal-1`,
          `assembly:${run.runId}:round-1:A2_blind_review:p3:peer-review:proposal-2`,
          `assembly:${run.runId}:round-1:A2_blind_review:p1:peer-review:proposal-3`,
        ].sort(),
      );
      expect(adversarialReviews.map(({ attribution }) => attribution.operationId).sort()).toEqual(
        [
          `assembly:${run.runId}:round-1:A3_adversarial_challenge:p3:adversarial-review:proposal-1`,
          `assembly:${run.runId}:round-1:A3_adversarial_challenge:p3:adversarial-review:proposal-2`,
          `assembly:${run.runId}:round-1:A3_adversarial_challenge:p3:adversarial-review:proposal-3`,
        ].sort(),
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

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

  it("executes a read-only Chat model council with one canonical answer and content-free inspection", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembly-model-council-"));
    const storage = createStorage();
    const routedContextSnapshot = {
      snapshotId: "snapshot-success",
      snapshotHash: "b".repeat(64),
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "default",
      capabilityProfileId: "profile-turn-1",
      capabilityProfileHash: "a".repeat(64),
      contextText: "[routed-context] exact admitted bytes",
      budget: {
        usedTokens: 80,
        promptReservedTokens: 30,
        outputReservedTokens: 20,
        estimatorVersion: "gc-approx-tokens.v1",
        budgetPolicyVersion: "chat.routed-context-budget.v1",
      },
    } as ChatRoutedContextSnapshotRecord;
    storage.routedContextSnapshots.get.mockReturnValue(routedContextSnapshot);
    const exactHistory = [
      { role: "system" as const, content: routedContextSnapshot.contextText },
      { role: "user" as const, content: "Compare the two approaches." },
    ];
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const stage = request.metadata?.stage;
      const content =
        stage === "C3_synthesize"
          ? "Canonical council answer with the minority risk preserved."
          : request.providerId === "openai"
            ? "Primary analysis."
            : "Advisory dissent.";
      return {
        model: request.model,
        choices: [{ index: 0, message: { role: "assistant", content } }],
        usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 },
        modelUsageEventIds: [`usage-${stage}-${request.providerId}`],
        routing: {
          effectiveProviderId: request.providerId,
          effectiveModel: request.model,
          fallbackUsed: false,
        },
      };
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir,
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const capabilityProfile = {
      profileId: "profile-turn-1",
      identity: { turnId: "turn-1", sessionId: "session-1", workspaceId: "default" },
      selection: { effectiveProviderId: "openai", effectiveModel: "gpt-5.4", thinkingLevel: "deep" },
      governance: {
        authReadiness: [{ kind: "provider", ref: "openai", status: "ready", reasonCodes: [] }],
      },
      hashes: { profileHash: "a".repeat(64) },
    } as ChatTurnCapabilityProfileRecord;

    try {
      const result = await service.executeChatModelCouncil({
        turnId: "turn-1",
        sessionId: "session-1",
        workspaceId: "default",
        content: "Compare the two approaches.",
        history: exactHistory,
        capabilityProfile,
        providerCandidates: [
          {
            providerId: "openai",
            model: "gpt-5.4",
            apiStyle: "openai-responses",
            contextWindowTokens: 128_000,
            routeConfigFingerprint: "1".repeat(64),
          },
          {
            providerId: "anthropic",
            model: "claude-sonnet-5",
            apiStyle: "anthropic-messages",
            contextWindowTokens: 200_000,
            routeConfigFingerprint: "2".repeat(64),
          },
        ],
        routedContextSnapshot,
      });

      expect(result.answer).toBe("Canonical council answer with the minority risk preserved.");
      expect(createChatCompletion).toHaveBeenCalledTimes(3);
      for (const [request, attribution] of createChatCompletion.mock.calls) {
        expect(request.tools).toBeUndefined();
        expect(request.providerId).toBeTruthy();
        expect(request.messages.slice(0, exactHistory.length)).toEqual(exactHistory);
        expect(attribution).toEqual(
          expect.objectContaining({
            callKind: "assembly_participant",
            assemblyRunId: result.runId,
            turnId: "turn-1",
            requestedProviderId: request.providerId,
            requestedModelId: request.model,
          }),
        );
      }
      const participantRequests = createChatCompletion.mock.calls
        .map(([request]) => request)
        .filter((request) => request.metadata?.stage === "C1_participate");
      const synthesisRequest = createChatCompletion.mock.calls
        .map(([request]) => request)
        .find((request) => request.metadata?.stage === "C3_synthesize");
      expect(participantRequests).toHaveLength(2);
      expect(participantRequests.every((request) => request.reasoning === undefined)).toBe(true);
      expect(synthesisRequest?.reasoning).toEqual({ effort: "xhigh" });
      expect(synthesisRequest?.temperature).toBeUndefined();
      const detail = service.getRunDetail(result.runId);
      expect(detail.run.status).toBe("completed");
      expect(detail.rounds.map((round) => round.stage)).toEqual([
        "C0_resolve",
        "C1_participate",
        "C2_assemble",
        "C3_synthesize",
      ]);
      const councilPayloads = detail.artifacts
        .filter((artifact) => artifact.artifactType.startsWith("model_council"))
        .map((artifact) => artifact.payload as Record<string, unknown>);
      expect(councilPayloads).toHaveLength(3);
      expect(councilPayloads.every((payload) => !("responseText" in payload) && !("answer" in payload))).toBe(true);
      expect(result.evidence.dissentFingerprints).toHaveLength(1);
      expect(result.modelUsageEventIds).toHaveLength(3);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails before provider dispatch when any frozen council route cannot reuse the HX-307 snapshot", async () => {
    const storage = createStorage();
    const snapshot = {
      snapshotId: "snapshot-1",
      snapshotHash: "b".repeat(64),
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "default",
      capabilityProfileId: "profile-turn-1",
      capabilityProfileHash: "a".repeat(64),
      contextText: "[routed-context] exact bytes",
      budget: {
        usedTokens: 80,
        promptReservedTokens: 30,
        outputReservedTokens: 20,
        estimatorVersion: "gc-approx-tokens.v1",
        budgetPolicyVersion: "chat.routed-context-budget.v1",
      },
    } as never;
    storage.routedContextSnapshots.get.mockReturnValue(snapshot);
    const createChatCompletion = vi.fn();
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const capabilityProfile = {
      profileId: "profile-turn-1",
      identity: { turnId: "turn-1", sessionId: "session-1", workspaceId: "default" },
      selection: { effectiveProviderId: "openai", effectiveModel: "gpt-5.4" },
      governance: {
        authReadiness: [{ kind: "provider", ref: "openai", status: "ready", reasonCodes: [] }],
      },
      hashes: { profileHash: "a".repeat(64) },
    } as ChatTurnCapabilityProfileRecord;

    await expect(
      service.executeChatModelCouncil({
        turnId: "turn-1",
        sessionId: "session-1",
        workspaceId: "default",
        content: "Use routed context.",
        history: [{ role: "system", content: "[routed-context] exact bytes" }],
        capabilityProfile,
        providerCandidates: [
          {
            providerId: "openai",
            model: "gpt-5.4",
            apiStyle: "openai-responses",
            contextWindowTokens: 128,
            routeConfigFingerprint: "1".repeat(64),
          },
          {
            providerId: "anthropic",
            model: "claude-sonnet-5",
            apiStyle: "anthropic-messages",
            contextWindowTokens: 200_000,
            routeConfigFingerprint: "2".repeat(64),
          },
        ],
        routedContextSnapshot: snapshot,
      }),
    ).rejects.toThrow(/cannot reuse the exact prepared context/i);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects endpoint or auth-route configuration drift before council recovery dispatch", async () => {
    const storage = createStorage();
    let ordinal = 0;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      ordinal += 1;
      return createCouncilCompletion(
        request,
        request.metadata?.stage === "C3_synthesize" ? "Canonical answer." : `Advisory ${ordinal}.`,
        `usage-${ordinal}`,
      );
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const input = createCouncilExecutionInput();
    await service.executeChatModelCouncil(input);
    expect(createChatCompletion).toHaveBeenCalledTimes(3);

    await expect(
      service.executeChatModelCouncil({
        ...input,
        providerCandidates: input.providerCandidates.map((candidate) =>
          candidate.providerId === "anthropic" ? { ...candidate, routeConfigFingerprint: "f".repeat(64) } : candidate,
        ),
      }),
    ).rejects.toThrow(/no longer ready under its frozen route/i);
    expect(createChatCompletion).toHaveBeenCalledTimes(3);

    await expect(
      service.executeChatModelCouncil({
        ...input,
        providerCandidates: input.providerCandidates.map((candidate) =>
          candidate.providerId === "openai" ? { ...candidate, apiStyle: "openai-chat-completions" } : candidate,
        ),
      }),
    ).rejects.toThrow(/no longer ready under its frozen route/i);
    expect(createChatCompletion).toHaveBeenCalledTimes(3);
  });

  it("fails before provider dispatch when a legacy council lacks the immutable reasoning route binding", async () => {
    const storage = createStorage();
    const createChatCompletion = vi.fn(async () => {
      throw new Error("first advisory interrupted");
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const input = createCouncilExecutionInput({
      capabilityProfile: {
        ...createCouncilCapabilityProfile("turn-1"),
        selection: {
          effectiveProviderId: "custom-claude",
          effectiveModel: "claude-opus-4-8",
          thinkingLevel: "standard",
        },
        governance: {
          authReadiness: [{ kind: "provider", ref: "custom-claude", status: "ready", reasonCodes: [] }],
        },
      } as ChatTurnCapabilityProfileRecord,
      providerCandidates: [
        {
          providerId: "custom-claude",
          model: "claude-opus-4-8",
          apiStyle: "anthropic-messages",
          contextWindowTokens: 200_000,
          routeConfigFingerprint: "3".repeat(64),
        },
        {
          providerId: "openai",
          model: "gpt-5.4",
          apiStyle: "openai-responses",
          contextWindowTokens: 128_000,
          routeConfigFingerprint: "1".repeat(64),
        },
      ],
    });

    await expect(service.executeChatModelCouncil(input)).rejects.toThrow("first advisory interrupted");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);

    const current = [...storage.__state.runs.values()][0]!;
    const resolution = current.councilResolution!;
    const legacyParticipants = resolution.participants.map((participant) => {
      const { apiStyle: _removedApiStyle, ...legacy } = participant;
      return {
        ...legacy,
        routeFingerprint: testDigest({
          providerId: legacy.providerId,
          model: legacy.model,
          contextWindowTokens: legacy.contextWindowTokens,
          routeConfigFingerprint: legacy.routeConfigFingerprint,
          capabilityProfileHash: resolution.capabilityProfileHash,
        }),
      };
    });
    const { resolutionHash: _oldResolutionHash, ...legacyResolutionBase } = resolution;
    const legacyResolutionDraft = { ...legacyResolutionBase, participants: legacyParticipants };
    const legacyResolution = {
      ...legacyResolutionDraft,
      resolutionHash: testDigest(legacyResolutionDraft),
    };
    storage.__state.runs.set(current.runId, {
      ...current,
      settings: {
        ...current.settings,
        tokenBudget: legacyParticipants.length * 1_200 + 1_600,
      },
      councilResolution: legacyResolution,
      councilEvidence: current.councilEvidence
        ? { ...current.councilEvidence, resolutionHash: legacyResolution.resolutionHash }
        : undefined,
    });
    createChatCompletion.mockClear();

    await expect(service.executeChatModelCouncil(input)).rejects.toThrow(
      /predates the immutable provider-style\/reasoning binding.*retry as a new Chat turn/i,
    );
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("renews the Assembly lease during a provider call beyond the former TTL and blocks takeover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const storage = createStorage();
    const firstCall = createDeferred<ChatCompletionResponse>();
    let callIndex = 0;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      callIndex += 1;
      if (callIndex === 1) return await firstCall.promise;
      return createCouncilCompletion(
        request,
        request.metadata?.stage === "C3_synthesize" ? "Canonical answer." : "Advisory answer.",
        `usage-${callIndex}`,
      );
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });

    const execution = service.executeChatModelCouncil(createCouncilExecutionInput());
    await vi.advanceTimersByTimeAsync(31_000);
    const run = storage.assembly.listRuns(1)[0]!;
    const takeover = storage.assembly.claimCouncilRun({
      runId: run.runId,
      leaseOwnerId: "takeover-worker",
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(takeover).toBeUndefined();
    expect(storage.assembly.renewCouncilRunLease).toHaveBeenCalledTimes(4);

    const firstRequest = createChatCompletion.mock.calls[0]![0];
    firstCall.resolve(createCouncilCompletion(firstRequest, "Primary answer.", "usage-primary"));
    const result = await execution;
    expect(result.answer).toBe("Canonical answer.");
    expect(createChatCompletion).toHaveBeenCalledTimes(3);
  });

  it("rejects a provider result after lease ownership is lost and performs no immutable write", async () => {
    const storage = createStorage();
    const renew = storage.assembly.renewCouncilRunLease;
    const renewImplementation = renew.getMockImplementation()!;
    renew.mockImplementationOnce(renewImplementation).mockImplementationOnce(() => undefined);
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) =>
      createCouncilCompletion(request, "Primary answer.", "usage-primary"),
    );
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });

    await expect(service.executeChatModelCouncil(createCouncilExecutionInput())).rejects.toThrow(/lease heartbeat/i);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(storage.assembly.saveCouncilArtifactsExact).not.toHaveBeenCalled();
  });

  it("persists failed post-response HX-306 attribution before surfacing the provider failure", async () => {
    const storage = createStorage();
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) =>
      createCouncilCompletion(request, "   ", "usage-failed-response"),
    );
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });

    await expect(service.executeChatModelCouncil(createCouncilExecutionInput())).rejects.toThrow(/empty output/i);
    const failedRun = storage.assembly.listRuns(1)[0]!;
    expect(failedRun.councilEvidence?.attempts).toEqual([
      expect.objectContaining({
        participantId: "primary",
        status: "failed",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.4",
        modelUsageEventIds: ["usage-failed-response"],
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.01,
        errorFingerprint: expect.any(String),
      }),
    ]);
  });

  it("recovers partial C1 artifacts, persists failed evidence, and reconstructs HX-306 usage", async () => {
    const storage = createStorage();
    let failAdvisory = true;
    let ordinal = 0;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      ordinal += 1;
      if (request.metadata?.stage === "C1_participate" && request.providerId === "anthropic" && failAdvisory) {
        throw new Error("advisory provider failed");
      }
      const content =
        request.metadata?.stage === "C3_synthesize"
          ? "Recovered canonical answer."
          : request.providerId === "openai"
            ? "Primary answer."
            : "Recovered advisory answer.";
      return createCouncilCompletion(request, content, `usage-${ordinal}`);
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const input = createCouncilExecutionInput();

    await expect(service.executeChatModelCouncil(input)).rejects.toThrow(/advisory provider failed/i);
    const failedRun = storage.assembly.listRuns(1)[0]!;
    expect(failedRun.councilEvidence?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: "primary", status: "completed", modelUsageEventIds: ["usage-1"] }),
        expect.objectContaining({
          participantId: "advisory-1",
          status: "failed",
          errorFingerprint: expect.any(String),
        }),
      ]),
    );
    expect(storage.__state.artifacts.get(failedRun.runId)).toHaveLength(1);

    // Simulate a process crash after the first immutable C1 artifact but before
    // the evidence side record is available to the recovering owner.
    storage.__state.runs.set(failedRun.runId, {
      ...failedRun,
      status: "failed",
      councilEvidence: undefined,
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
    });
    failAdvisory = false;
    const recovered = await service.executeChatModelCouncil(input);
    expect(recovered.answer).toBe("Recovered canonical answer.");
    expect(
      createChatCompletion.mock.calls.filter(
        ([request]) => request.metadata?.stage === "C1_participate" && request.providerId === "openai",
      ),
    ).toHaveLength(1);
    expect(recovered.modelUsageEventIds).toHaveLength(3);
    expect(recovered.usage).toEqual({ inputTokens: 300, outputTokens: 60, costUsd: 0.03 });
  });

  it("retains every failed and successful retry as a distinct durable HX-306 attempt", async () => {
    const storage = createStorage();
    let advisoryShouldFail = true;
    let ordinal = 0;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      ordinal += 1;
      const isAdvisory = request.metadata?.stage === "C1_participate" && request.providerId === "anthropic";
      const content =
        isAdvisory && advisoryShouldFail
          ? "   "
          : request.metadata?.stage === "C3_synthesize"
            ? "Canonical answer after retry."
            : `Participant answer ${ordinal}.`;
      return createCouncilCompletion(request, content, `usage-${ordinal}`);
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const input = createCouncilExecutionInput();

    await expect(service.executeChatModelCouncil(input)).rejects.toThrow(/empty output/i);
    advisoryShouldFail = false;
    const recovered = await service.executeChatModelCouncil(input);

    const advisoryAttempts = recovered.evidence.attempts.filter(
      (attempt) => attempt.stage === "C1_participate" && attempt.participantId === "advisory-1",
    );
    expect(advisoryAttempts).toEqual([
      expect.objectContaining({
        attemptId: expect.stringMatching(/:C1:advisory-1:attempt:1$/u),
        status: "failed",
        modelUsageEventIds: ["usage-2"],
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.01,
      }),
      expect.objectContaining({
        attemptId: expect.stringMatching(/:C1:advisory-1:attempt:2$/u),
        status: "completed",
        modelUsageEventIds: ["usage-3"],
      }),
    ]);
    expect(recovered.modelUsageEventIds).toHaveLength(4);
    expect(recovered.modelUsageEventIds).toEqual(expect.arrayContaining(["usage-1", "usage-2", "usage-3", "usage-4"]));
    expect(recovered.usage).toEqual({ inputTokens: 400, outputTokens: 80, costUsd: 0.04 });
  });

  it("reconciles every council call from canonical HX-306 rows and rejects later scope drift", async () => {
    const storage = createStorage();
    const usageEvents: ModelUsageEventRecord[] = [];
    Object.assign(storage, {
      modelUsageEvents: {
        list: vi.fn((query: { assemblyRunId?: string }) => ({
          items: usageEvents.filter((event) => event.assemblyRunId === query.assemblyRunId),
          summary: {
            attemptCount: usageEvents.length,
            uncertainDispatchCount: 0,
            trackedAttemptCount: usageEvents.length,
            unknownAttemptCount: 0,
            metricAvailability: {
              inputTokens: { knownAttemptCount: usageEvents.length, unknownAttemptCount: 0, complete: true },
              outputTokens: { knownAttemptCount: usageEvents.length, unknownAttemptCount: 0, complete: true },
              cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: usageEvents.length, complete: false },
              costUsd: { knownAttemptCount: usageEvents.length, unknownAttemptCount: 0, complete: true },
            },
          },
        })),
        findByEventId: vi.fn((eventId: string) => usageEvents.find((event) => event.eventId === eventId)),
      },
    });
    const createChatCompletion = vi.fn(
      async (
        request: ChatCompletionRequest,
        attribution: ModelUsageAttributionContext,
      ): Promise<ChatCompletionResponse> => {
        const eventId = `usage-canonical-${usageEvents.length + 1}`;
        const now = "2026-07-13T00:00:00.000Z";
        usageEvents.push({
          eventId,
          idempotencyKey: `idempotency-${eventId}`,
          source: "llm_service",
          callKind: "assembly_participant",
          requestedProviderId: request.providerId,
          requestedModelId: request.model,
          dispatchedModelId: request.model,
          effectiveProviderId: request.providerId,
          effectiveModelId: request.model,
          operationId: attribution.operationId!,
          parentOperationId: attribution.parentOperationId,
          dispatchGeneration: attribution.dispatchGeneration ?? `generation-${eventId}`,
          attemptIndex: attribution.attemptIndex ?? 0,
          transportAttemptIndex: 0,
          transportStatus: "accepted",
          dispatchOwnerId: "assembly-test-owner",
          dispatchLeaseExpiresAt: "2026-07-13T00:02:00.000Z",
          fallbackIndex: attribution.fallbackIndex ?? 0,
          repairIndex: attribution.repairIndex ?? 0,
          workspaceId: attribution.workspaceId,
          sessionId: attribution.sessionId,
          turnId: attribution.turnId,
          taskId: attribution.taskId,
          agentId: attribution.agentId,
          assemblyRunId: attribution.assemblyRunId,
          assemblyRoundIndex: attribution.assemblyRoundIndex,
          assemblyStage: attribution.assemblyStage,
          workerId: attribution.workerId,
          credentialType: "api_key",
          usagePool: "standard",
          credentialSource: "env",
          pricingSource: "provider_reported",
          costSource: "provider_reported",
          availability: "tracked",
          terminalOutcome: "succeeded",
          startedAt: now,
          finishedAt: now,
          durationMs: 1,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.001,
        });
        return {
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  request.metadata?.stage === "C3_synthesize"
                    ? "Canonical HX-306-backed answer."
                    : `Advisory ${usageEvents.length}.`,
              },
            },
          ],
          // Deliberately forged response-carried metrics: repository truth must win.
          usage: { input_tokens: 999, output_tokens: 999, cost_usd: 0.999 },
          modelUsageEventIds: [eventId],
          routing: {
            effectiveProviderId: request.providerId,
            effectiveModel: request.model,
            fallbackUsed: false,
          },
        };
      },
    );
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });

    const result = await service.executeChatModelCouncil(createCouncilExecutionInput());

    expect(createChatCompletion).toHaveBeenCalledTimes(3);
    expect([...result.modelUsageEventIds].sort()).toEqual([
      "usage-canonical-1",
      "usage-canonical-2",
      "usage-canonical-3",
    ]);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15, costUsd: 0.003 });
    expect(result.evidence.attempts.every((attempt) => attempt.inputTokens === 10 && attempt.outputTokens === 5)).toBe(
      true,
    );

    usageEvents[0] = { ...usageEvents[0]!, turnId: "foreign-turn" };
    expect(() => service.getRunDetail(result.runId)).toThrow(/foreign or unfrozen HX-306 attribution/i);
  });

  it("fails closed when a started council call has no canonical HX-306 row", async () => {
    const storage = createStorage();
    Object.assign(storage, {
      modelUsageEvents: {
        list: vi.fn(() => ({ items: [], summary: {} })),
        findByEventId: vi.fn(() => undefined),
      },
    });
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) =>
      createCouncilCompletion(request, "Unreconciled provider output.", "usage-missing-from-hx306"),
    );
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });

    await expect(service.executeChatModelCouncil(createCouncilExecutionInput())).rejects.toThrow(
      /differs from canonical HX-306 event truth/i,
    );
    const failedRun = storage.assembly.listRuns(1)[0]!;
    expect(failedRun.status).toBe("failed");
    expect(storage.assembly.listArtifacts(failedRun.runId)).toEqual([]);
  });

  it("recovers a validated C3 artifact without another provider call and rejects artifact/result tampering", async () => {
    const storage = createStorage();
    let ordinal = 0;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      ordinal += 1;
      return createCouncilCompletion(
        request,
        request.metadata?.stage === "C3_synthesize" ? "Canonical recovered answer." : `Participant ${ordinal}.`,
        `usage-${ordinal}`,
      );
    });
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const input = createCouncilExecutionInput();
    const completed = await service.executeChatModelCouncil(input);
    const completedRun = storage.__state.runs.get(completed.runId)!;
    const completedRounds = storage.__state.rounds.get(completed.runId)!;
    const callCount = createChatCompletion.mock.calls.length;

    storage.__state.runs.set(completed.runId, {
      ...completedRun,
      status: "failed",
      currentStage: "C3_synthesize",
      currentRoundIndex: 3,
      result: undefined,
      usage: undefined,
      councilEvidence: undefined,
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
      finishedAt: undefined,
    });
    storage.__state.rounds.set(
      completed.runId,
      completedRounds.filter((round) => round.stage !== "C3_synthesize"),
    );
    const recovered = await service.executeChatModelCouncil(input);
    expect(recovered.answer).toBe("Canonical recovered answer.");
    expect(createChatCompletion).toHaveBeenCalledTimes(callCount);

    const artifacts = storage.__state.artifacts.get(completed.runId)!;
    const participantIndex = artifacts.findIndex((artifact) => artifact.artifactType === "model_council_participant");
    const originalParticipant = artifacts[participantIndex]!;
    artifacts[participantIndex] = { ...originalParticipant, participantModelRef: "tampered:model" };
    expect(() => service.getRunDetail(completed.runId)).toThrow(/route binding/i);
    artifacts[participantIndex] = originalParticipant;

    const recoveredRun = storage.__state.runs.get(completed.runId)!;
    storage.__state.runs.set(completed.runId, {
      ...recoveredRun,
      result: { ...recoveredRun.result!, recommendation: "tampered answer" },
    });
    expect(() => service.getRunDetail(completed.runId)).toThrow(/canonical answer binding/i);
  });

  it("rejects non-exact or repeated HX-307 context occurrences before dispatch", async () => {
    const storage = createStorage();
    const snapshot = {
      snapshotId: "snapshot-strict",
      snapshotHash: "b".repeat(64),
      turnId: "turn-strict",
      sessionId: "session-1",
      workspaceId: "default",
      capabilityProfileId: "profile-turn-strict",
      capabilityProfileHash: "a".repeat(64),
      contextText: "[routed-context] strict bytes",
      budget: {
        usedTokens: 20,
        promptReservedTokens: 20,
        outputReservedTokens: 20,
        estimatorVersion: "gc-approx-tokens.v1",
        budgetPolicyVersion: "chat.routed-context-budget.v1",
      },
    } as ChatRoutedContextSnapshotRecord;
    storage.routedContextSnapshots.get.mockReturnValue(snapshot);
    const createChatCompletion = vi.fn();
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion,
      publishRealtime: vi.fn(),
    });
    const base = createCouncilExecutionInput({
      turnId: "turn-strict",
      capabilityProfile: createCouncilCapabilityProfile("turn-strict"),
      routedContextSnapshot: snapshot,
    });

    await expect(
      service.executeChatModelCouncil({
        ...base,
        history: [{ role: "system", content: `prefix ${snapshot.contextText}` }],
      }),
    ).rejects.toThrow(/strict equality/i);
    await expect(
      service.executeChatModelCouncil({
        ...base,
        history: [
          { role: "system", content: snapshot.contextText },
          { role: "user", content: `repeat ${snapshot.contextText}` },
        ],
      }),
    ).rejects.toThrow(/rejects every other occurrence/i);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects future rounds, missing prior rounds, and future artifacts during restart recovery", async () => {
    const storage = createStorage();
    let ordinal = 0;
    const service = new AssemblyService({
      storage: storage as never,
      rootDir: os.tmpdir(),
      createChatCompletion: vi.fn(async (request: ChatCompletionRequest) => {
        ordinal += 1;
        return createCouncilCompletion(
          request,
          request.metadata?.stage === "C3_synthesize" ? "Canonical answer." : `Participant ${ordinal}.`,
          `usage-${ordinal}`,
        );
      }),
      publishRealtime: vi.fn(),
    });
    const completed = await service.executeChatModelCouncil(createCouncilExecutionInput());
    const completedRun = storage.__state.runs.get(completed.runId)!;
    const completedRounds = storage.__state.rounds.get(completed.runId)!;
    const completedArtifacts = storage.__state.artifacts.get(completed.runId)!;

    storage.__state.runs.set(completed.runId, {
      ...completedRun,
      status: "failed",
      currentStage: "C1_participate",
      currentRoundIndex: 1,
      result: undefined,
      usage: undefined,
      finishedAt: undefined,
    });
    expect(() => service.getRunDetail(completed.runId)).toThrow(/future round C2_assemble/i);

    storage.__state.runs.set(completed.runId, {
      ...completedRun,
      status: "failed",
      currentStage: "C3_synthesize",
      currentRoundIndex: 3,
      result: undefined,
      usage: undefined,
      finishedAt: undefined,
    });
    storage.__state.rounds.set(
      completed.runId,
      completedRounds.filter((round) => round.stage !== "C1_participate" && round.stage !== "C3_synthesize"),
    );
    expect(() => service.getRunDetail(completed.runId)).toThrow(/missing prior round C1_participate/i);

    storage.__state.runs.set(completed.runId, {
      ...completedRun,
      status: "failed",
      currentStage: "C1_participate",
      currentRoundIndex: 1,
      result: undefined,
      usage: undefined,
      finishedAt: undefined,
    });
    storage.__state.rounds.set(
      completed.runId,
      completedRounds.filter((round) => round.stage === "C0_resolve" || round.stage === "C1_participate"),
    );
    storage.__state.artifacts.set(completed.runId, completedArtifacts);
    expect(() => service.getRunDetail(completed.runId)).toThrow(/future C3_synthesize artifact truth/i);
  });
});
