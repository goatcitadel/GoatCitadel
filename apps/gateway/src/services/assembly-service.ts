import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AdversarialReview,
  AdversarialSettings,
  AssemblyArtifactRecord,
  AssemblyArtifactType,
  AssemblyContextRef,
  AssemblyContributionSummaryItem,
  AssemblyDisagreementCluster,
  AssemblyProblem,
  AssemblyResult,
  AssemblyResultExportRecord,
  AssemblyRound,
  AssemblyRunDetailResponse,
  AssemblyRunRecord,
  AssemblyStopCheck,
  AssemblyUsageSummary,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ConvergenceScore,
  CreateAssemblyRunInput,
  DefenseResponse,
  ModelProposal,
  ModelReputation,
  PeerReview,
} from "@goatcitadel/contracts";
import type { AssemblyParticipantModel, AssemblyStage } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

interface StructuredInvocationInput {
  participant: AssemblyParticipantModel;
  problem: AssemblyProblem;
  stage: AssemblyStage;
  instructions: string;
  schemaLabel: string;
  budgetSlice?: AssemblyUsageSummary;
  priorArtifacts?: AssemblyArtifactRecord[];
  fallbackPayload: Record<string, unknown>;
}

interface StructuredInvocationResult {
  payload: Record<string, unknown>;
  usage?: AssemblyUsageSummary;
  providerId: string;
  modelId: string;
  modelRef: string;
}

export interface ProviderAdapter {
  invokeStructured(input: StructuredInvocationInput): Promise<StructuredInvocationResult>;
  supportsSchemaMode(participant: AssemblyParticipantModel): boolean;
  estimateBudget(input: StructuredInvocationInput): AssemblyUsageSummary;
  normalizeUsage(response: ChatCompletionResponse): AssemblyUsageSummary;
}

interface AssemblyServiceOptions {
  storage: Storage;
  rootDir: string;
  createChatCompletion: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
}

interface StageArtifacts {
  round: AssemblyRound;
  artifacts: AssemblyArtifactRecord[];
}

interface ExecutionState {
  proposals: ModelProposal[];
  peerReviews: PeerReview[];
  adversarialReviews: AdversarialReview[];
  defenses: DefenseResponse[];
  convergence?: ConvergenceScore;
}

export class ProviderAdapterRegistry implements ProviderAdapter {
  public constructor(
    private readonly createChatCompletion: AssemblyServiceOptions["createChatCompletion"],
  ) {}

  public async invokeStructured(input: StructuredInvocationInput): Promise<StructuredInvocationResult> {
    const prompt = buildStructuredPrompt(input);
    const response = await this.createChatCompletion({
      providerId: input.participant.providerId,
      model: input.participant.model,
      temperature: 0.3,
      max_tokens: 1_200,
      timeoutMs: input.budgetSlice?.latencyMs ?? 25_000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are part of GoatCitadel Assembly. Reply with strict JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      metadata: {
        surface: "assembly",
        stage: input.stage,
        schema: input.schemaLabel,
      },
    });
    const parsed = parseLooseJsonRecord(extractCompletionText(response)) ?? input.fallbackPayload;
    return {
      payload: parsed,
      usage: this.normalizeUsage(response),
      providerId: input.participant.providerId,
      modelId: response.routing?.effectiveModel ?? response.model ?? input.participant.model,
      modelRef: participantModelRef(input.participant),
    };
  }

  public supportsSchemaMode(_participant: AssemblyParticipantModel): boolean {
    return true;
  }

  public estimateBudget(input: StructuredInvocationInput): AssemblyUsageSummary {
    return {
      inputTokens: Math.max(128, Math.round(input.instructions.length / 3)),
      outputTokens: 500,
      costUsd: 0.02,
      latencyMs: input.budgetSlice?.latencyMs ?? 15_000,
    };
  }

  public normalizeUsage(response: ChatCompletionResponse): AssemblyUsageSummary {
    const usage = (response.usage ?? {}) as Record<string, unknown>;
    return {
      inputTokens: readNumericUsage(usage, ["prompt_tokens", "input_tokens", "promptTokenCount"]),
      outputTokens: readNumericUsage(usage, ["completion_tokens", "output_tokens", "candidatesTokenCount"]),
      costUsd: readNumericUsage(usage, ["cost_usd", "costUsd"]),
      latencyMs: readNumericUsage(usage, ["latency_ms", "latencyMs"]),
    };
  }
}

export class PeerReviewEngine {
  public assignBlindReviews(proposals: ModelProposal[], participants: AssemblyParticipantModel[]) {
    if (participants.length < 2) {
      return [];
    }
    return proposals.map((proposal, index) => {
      let reviewer = participants[(index + 1) % participants.length]!;
      if (participantModelRef(reviewer) === proposal.authorModelRef) {
        reviewer = participants[(index + 2) % participants.length] ?? reviewer;
      }
      return {
        proposal,
        reviewer,
      };
    });
  }

  public validateReview(review: PeerReview): boolean {
    return review.strengths.length > 0
      && review.weaknesses.length > 0
      && Number.isFinite(review.confidence)
      && review.confidence >= 0
      && review.confidence <= 1;
  }

  public detectMergeCandidates(reviews: PeerReview[]): string[] {
    return reviews
      .filter((review) => review.verdict === "merge" && review.mergeTargetProposalId)
      .map((review) => `${review.proposalId}:${review.mergeTargetProposalId}`);
  }
}

export class AdversarialEngine {
  public selectAdversaries(
    participants: AssemblyParticipantModel[],
    settings: AdversarialSettings,
    reputations: ModelReputation[],
  ): AssemblyParticipantModel[] {
    const reviewerCount = Math.max(1, Math.min(settings.reviewerCount, participants.length));
    if (settings.selectionStrategy === "rotate_among_participants") {
      return participants.slice(0, reviewerCount);
    }
    if (settings.selectionStrategy === "auto_selected_by_reputation") {
      const ranked = [...participants].sort((left, right) => {
        const leftScore = reputations.find((item) => item.modelRef === participantModelRef(left))?.adversarialUsefulness ?? 0;
        const rightScore = reputations.find((item) => item.modelRef === participantModelRef(right))?.adversarialUsefulness ?? 0;
        return rightScore - leftScore;
      });
      return ranked.slice(0, reviewerCount);
    }
    if (settings.reviewerModelRefs?.length) {
      const requested = new Set(settings.reviewerModelRefs);
      const selected = participants.filter((participant) => requested.has(participantModelRef(participant)));
      if (selected.length > 0) {
        return selected.slice(0, reviewerCount);
      }
    }
    return participants.slice(0, reviewerCount);
  }

  public dedupeObjections(reviews: AdversarialReview[]): AdversarialReview[] {
    const seen = new Set<string>();
    return reviews.map((review) => ({
      ...review,
      objections: review.objections.filter((objection) => {
        const fingerprint = fingerprintObjection(objection.title, objection.detail);
        if (seen.has(fingerprint)) {
          return false;
        }
        seen.add(fingerprint);
        return true;
      }),
    }));
  }

  public scoreChallenges(reviews: AdversarialReview[]): number {
    return reviews.reduce((total, review) => {
      return total + review.objections.reduce((sum, objection) => {
        const severity = objection.classification === "critical_flaw"
          ? 1
          : objection.classification === "moderate_risk"
            ? 0.7
            : objection.classification === "edge_case_concern"
              ? 0.4
              : 0.1;
        const evidence = objection.evidenceBasis === "evidence_based" ? 1 : 0.7;
        const actionability = objection.mitigation?.trim() ? 1 : 0.5;
        return sum + (severity * evidence * actionability);
      }, 0);
    }, 0);
  }
}

export class ConvergenceScorer {
  public scoreRound(input: {
    runId: string;
    roundIndex: number;
    proposals: ModelProposal[];
    peerReviews: PeerReview[];
    adversarialReviews: AdversarialReview[];
    previous?: ConvergenceScore;
  }): ConvergenceScore {
    const proposalSupportScores: Record<string, number> = {};
    const qualityScores = input.proposals.map((proposal) => {
      const reviews = input.peerReviews.filter((review) => review.proposalId === proposal.proposalId);
      const reviewScore = average(reviews.map((review) => weightedReviewScore(review)));
      const evidenceSupport = Math.min(1, proposal.evidence.length / 4);
      const proposalQuality = (
        (reviewScore || proposal.confidence) * 0.45
        + clamp01(proposal.confidence) * 0.2
        + clamp01(evidenceSupport) * 0.15
        + clamp01(1 - (proposal.risks.length / 10)) * 0.2
      );
      const normalized = clamp01(proposalQuality);
      proposalSupportScores[proposal.proposalId] = normalized;
      return normalized;
    });
    const disagreementClusters = buildDisagreementClusters(input.peerReviews, input.adversarialReviews);
    const compositeScore = average(qualityScores);
    const stagnationDelta = input.previous
      ? Math.abs(compositeScore - input.previous.compositeScore)
      : 1;
    return {
      runId: input.runId,
      roundIndex: input.roundIndex,
      dimensionScores: {
        rootCause: compositeScore,
        solutionDesign: compositeScore,
        riskAnalysis: clamp01(1 - (disagreementClusters.length * 0.12)),
        implementationScope: compositeScore,
        evidenceStrength: clamp01(average(input.proposals.map((proposal) => Math.min(1, proposal.evidence.length / 4)))),
        confidenceStability: clamp01(1 - stagnationDelta),
        testPlanAlignment: clamp01(average(input.proposals.map((proposal) => Math.min(1, proposal.testPlan.length / 4)))),
      },
      proposalSupportScores,
      compositeScore: clamp01(compositeScore),
      stagnationDelta,
      disagreementClusters,
      minorityFlags: this.flagMinorityPositions(input),
      createdAt: new Date().toISOString(),
    };
  }

  public detectStagnation(scores: ConvergenceScore[], window: number): number {
    const relevant = scores.slice(-Math.max(1, window));
    if (relevant.length < 2) {
      return 1;
    }
    return Math.abs(relevant[relevant.length - 1]!.compositeScore - relevant[0]!.compositeScore);
  }

  public flagMinorityPositions(input: {
    proposals: ModelProposal[];
    peerReviews: PeerReview[];
    adversarialReviews: AdversarialReview[];
  }): string[] {
    const lowSupport = input.proposals
      .filter((proposal) => {
        const reviews = input.peerReviews.filter((review) => review.proposalId === proposal.proposalId);
        return average(reviews.map((review) => weightedReviewScore(review))) < 0.55;
      })
      .map((proposal) => proposal.proposalId);
    const critical = input.adversarialReviews
      .flatMap((review) => review.objections
        .filter((objection) => objection.classification === "critical_flaw")
        .map(() => review.proposalId));
    return [...new Set([...lowSupport, ...critical])];
  }
}

export class ReputationTracker {
  public constructor(private readonly storage: Storage) {}

  public recordRunOutcome(input: {
    run: AssemblyRunRecord;
    proposals: ModelProposal[];
    peerReviews: PeerReview[];
    adversarialReviews: AdversarialReview[];
    result: AssemblyResult;
  }): ModelReputation[] {
    const existing = this.storage.assembly.listReputations(500);
    const updates = input.run.settings.participantModels.map((participant) => {
      const modelRef = participantModelRef(participant);
      const current = existing.find((item) => item.modelRef === modelRef) ?? createEmptyReputation(participant);
      const proposals = input.proposals.filter((proposal) => proposal.authorModelRef === modelRef);
      const reviews = input.peerReviews.filter((review) => review.blindedReviewerToken === blindedReviewerToken(modelRef));
      const adversarialReviews = input.adversarialReviews.filter((review) => review.blindedReviewerToken === blindedReviewerToken(modelRef));
      const sampleCount = current.sampleCount + 1;
      const next: ModelReputation = {
        ...current,
        accuracy: averageInto(current.accuracy, average(proposals.map((proposal) => proposal.confidence)), sampleCount),
        reasoningStrength: averageInto(current.reasoningStrength, average(reviews.map((review) => review.scores.reasoningStrength)), sampleCount),
        critiqueQuality: averageInto(current.critiqueQuality, average(reviews.map((review) => weightedReviewScore(review))), sampleCount),
        consensusLeadership: averageInto(
          current.consensusLeadership,
          input.result.modelContributionSummary.some((item) => item.modelRef === modelRef && item.contributionRole === "synthesis") ? 1 : 0.5,
          sampleCount,
        ),
        stability: averageInto(current.stability, clamp01(1 - (input.run.usage?.costUsd ?? 0)), sampleCount),
        adversarialUsefulness: averageInto(current.adversarialUsefulness, this.adversarialUsefulnessScore(adversarialReviews), sampleCount),
        sampleCount,
        updatedAt: new Date().toISOString(),
      };
      next.overall = average([
        next.accuracy,
        next.reasoningStrength,
        next.critiqueQuality,
        next.consensusLeadership,
        next.stability,
        next.adversarialUsefulness,
      ]);
      next.byDomain = {
        ...next.byDomain,
        [input.run.problem.domain]: {
          accuracy: next.accuracy,
          reasoningStrength: next.reasoningStrength,
          critiqueQuality: next.critiqueQuality,
          consensusLeadership: next.consensusLeadership,
          stability: next.stability,
          adversarialUsefulness: next.adversarialUsefulness,
          sampleCount,
        },
      };
      this.storage.assembly.upsertReputation(next);
      return next;
    });
    return updates;
  }

  public applyAdversarialUsefulness(current: ModelReputation, reviews: AdversarialReview[]): ModelReputation {
    return {
      ...current,
      adversarialUsefulness: averageInto(current.adversarialUsefulness, this.adversarialUsefulnessScore(reviews), current.sampleCount + 1),
    };
  }

  public selectReviewersByReputation(
    participants: AssemblyParticipantModel[],
    settings: AdversarialSettings,
  ): AssemblyParticipantModel[] {
    const reputations = this.storage.assembly.listReputations(500);
    const reviewerCount = Math.max(1, Math.min(settings.reviewerCount, participants.length));
    return [...participants]
      .sort((left, right) => {
        const leftScore = reputations.find((item) => item.modelRef === participantModelRef(left))?.overall ?? 0;
        const rightScore = reputations.find((item) => item.modelRef === participantModelRef(right))?.overall ?? 0;
        return rightScore - leftScore;
      })
      .slice(0, reviewerCount);
  }

  private adversarialUsefulnessScore(reviews: AdversarialReview[]): number {
    return clamp01(average(reviews.map((review) => average(review.objections.map((objection) => {
      const severity = objection.classification === "critical_flaw"
        ? 1
        : objection.classification === "moderate_risk"
          ? 0.7
          : objection.classification === "edge_case_concern"
            ? 0.4
            : 0.1;
      const evidence = objection.evidenceBasis === "evidence_based" ? 1 : 0.7;
      const mitigation = objection.mitigation?.trim() ? 1 : 0.5;
      return severity * evidence * mitigation;
    })))));
  }
}

export class SynthesisEngine {
  public buildConsensus(input: {
    run: AssemblyRunRecord;
    proposals: ModelProposal[];
    peerReviews: PeerReview[];
    adversarialReviews: AdversarialReview[];
    convergence: ConvergenceScore;
    exports: AssemblyResultExportRecord[];
  }): AssemblyResult {
    const winningProposal = selectWinningProposal(input.proposals, input.convergence);
    return {
      runId: input.run.runId,
      recommendation: winningProposal?.proposedSolution ?? "No consensus recommendation produced.",
      disagreements: input.convergence.disagreementClusters,
      riskAnalysis: dedupeStrings([
        ...(winningProposal?.risks ?? []),
        ...input.adversarialReviews.flatMap((review) => review.objections.map((objection) => objection.detail)),
      ]),
      implementationPlan: this.buildImplementationPlan(input.proposals),
      minorityReport: input.convergence.minorityFlags.length > 0
        ? {
          summary: "Minority objections remain unresolved.",
          proposalIds: input.convergence.minorityFlags,
          reasons: input.adversarialReviews.flatMap((review) => review.objections.map((objection) => objection.title)).slice(0, 4),
        }
        : undefined,
      modelContributionSummary: this.buildContributionSummary(
        input.proposals,
        input.peerReviews,
        input.adversarialReviews,
      ),
      exports: input.exports,
      finalUsage: input.run.usage,
      createdAt: new Date().toISOString(),
    };
  }

  public buildSplitDecision(input: {
    run: AssemblyRunRecord;
    proposals: ModelProposal[];
    peerReviews: PeerReview[];
    adversarialReviews: AdversarialReview[];
    convergence: ConvergenceScore;
    exports: AssemblyResultExportRecord[];
  }): AssemblyResult {
    const ranked = [...input.proposals].sort(
      (left, right) => (input.convergence.proposalSupportScores[right.proposalId] ?? 0) - (input.convergence.proposalSupportScores[left.proposalId] ?? 0),
    );
    const finalists = ranked.slice(0, 2);
    return {
      runId: input.run.runId,
      recommendation: finalists
        .map((proposal, index) => `${index + 1}. ${proposal.abstract}: ${proposal.proposedSolution}`)
        .join("\n\n"),
      disagreements: input.convergence.disagreementClusters,
      riskAnalysis: dedupeStrings(finalists.flatMap((proposal) => proposal.risks)),
      implementationPlan: this.buildImplementationPlan(finalists),
      minorityReport: {
        summary: "Assembly ended in a split decision because disagreement remained material.",
        proposalIds: finalists.map((proposal) => proposal.proposalId),
        reasons: input.convergence.disagreementClusters.map((cluster) => cluster.summary),
      },
      modelContributionSummary: this.buildContributionSummary(
        input.proposals,
        input.peerReviews,
        input.adversarialReviews,
      ),
      exports: input.exports,
      finalUsage: input.run.usage,
      createdAt: new Date().toISOString(),
    };
  }

  public buildContributionSummary(
    proposals: ModelProposal[],
    peerReviews: PeerReview[],
    adversarialReviews: AdversarialReview[],
  ): AssemblyContributionSummaryItem[] {
    const modelRefs = new Set<string>(proposals.map((proposal) => proposal.authorModelRef));
    return [...modelRefs].map((modelRef) => {
      const proposalCount = proposals.filter((proposal) => proposal.authorModelRef === modelRef).length;
      const reviewCount = peerReviews.filter((review) => review.blindedReviewerToken === blindedReviewerToken(modelRef)).length;
      const adversaryCount = adversarialReviews.filter((review) => review.blindedReviewerToken === blindedReviewerToken(modelRef)).length;
      const contributionRole = adversaryCount > 0
        ? "adversary"
        : reviewCount > 0
          ? "review"
          : "proposal";
      return {
        modelRef,
        contributionRole,
        summary: `${proposalCount} proposal(s), ${reviewCount} peer review(s), ${adversaryCount} adversarial review(s)`,
      };
    });
  }

  public buildImplementationPlan(proposals: ModelProposal[]): string[] {
    return dedupeStrings(
      proposals.flatMap((proposal) => proposal.testPlan.map((item) => `${item.title}: ${item.detail}`)),
    ).slice(0, 8);
  }
}

export class AssemblyOrchestrator {
  public constructor(
    private readonly storage: Storage,
    private readonly registry: ProviderAdapterRegistry,
    private readonly peerReviewEngine: PeerReviewEngine,
    private readonly adversarialEngine: AdversarialEngine,
    private readonly convergenceScorer: ConvergenceScorer,
    private readonly synthesisEngine: SynthesisEngine,
    private readonly reputationTracker: ReputationTracker,
    private readonly publishRealtime: AssemblyServiceOptions["publishRealtime"],
    private readonly rootDir: string,
  ) {}

  public async startRun(_input: CreateAssemblyRunInput): Promise<AssemblyRunRecord> {
    const runId = randomUUID();
    const problem = this.normalizeProblem(runId, _input);
    const now = new Date().toISOString();
    const run: AssemblyRunRecord = {
      runId,
      workspaceId: _input.workspaceId,
      sourceSessionId: _input.sourceSessionId,
      sourceTaskId: _input.sourceTaskId,
      title: _input.title?.trim() || problem.title,
      status: "queued",
      currentStage: _input.adversarialSettings?.enabled ? "A0_normalize" : "S0_normalize",
      currentRoundIndex: 0,
      problem,
      settings: _input.settings,
      adversarialSettings: withDefaultAdversarialSettings(_input.adversarialSettings),
      createdAt: now,
      updatedAt: now,
    };
    this.storage.assembly.createRun(run);
    this.publishRealtime("assembly_run_created", "assembly", {
      runId,
      title: run.title,
      workspaceId: run.workspaceId,
      stage: run.currentStage,
    });
    return run;
  }

  public normalizeProblem(runId: string, input: CreateAssemblyRunInput): AssemblyProblem {
    const normalizedPrompt = input.prompt.trim().replace(/\s+/g, " ");
    const objectives = normalizedPrompt.split(/[.?!]\s+/).map((item) => item.trim()).filter(Boolean).slice(0, 4);
    const contextRefs = input.contextRefs ?? [];
    return {
      runId,
      domain: input.settings.domainPreset,
      title: input.title?.trim() || titleFromPrompt(normalizedPrompt),
      originalPrompt: input.prompt,
      normalizedStatement: normalizedPrompt,
      objectives: objectives.length > 0 ? objectives : [normalizedPrompt],
      constraints: dedupeStrings([
        `Mode: ${input.settings.mode}`,
        `Participants: ${input.settings.participantModels.length}`,
        `Budget: $${input.settings.costBudgetUsd.toFixed(2)} / ${input.settings.tokenBudget} tokens`,
        ...summarizeContextRefs(contextRefs),
      ]),
      evaluationCriteria: defaultEvaluationCriteria(input.settings.domainPreset),
      contextRefs,
      createdAt: new Date().toISOString(),
    };
  }

  public async runRound(_run: AssemblyRunRecord, _roundIndex: number, _state: ExecutionState): Promise<ExecutionState> {
    const stageArtifacts: StageArtifacts[] = [];
    const submitStage = _run.adversarialSettings.enabled ? "A1_submit" : "S1_submit";
    const reviewStage = _run.adversarialSettings.enabled ? "A2_blind_review" : "S2_blind_review";
    const reviseStage = _run.adversarialSettings.enabled ? "A4_defense_and_revision" : "S3_revise";
    const convergenceStage = _run.adversarialSettings.enabled ? "A5_convergence" : "S4_convergence";

    const proposals = await this.createProposalStage(_run, _roundIndex, submitStage, _state);
    stageArtifacts.push(proposals);
    const peerReviews = await this.createPeerReviewStage(_run, _roundIndex, reviewStage, proposals.artifacts, _state);
    stageArtifacts.push(peerReviews);

    let adversarialArtifacts: StageArtifacts | undefined;
    if (_run.adversarialSettings.enabled) {
      adversarialArtifacts = await this.createAdversarialStage(_run, _roundIndex, proposals.artifacts, _state);
      stageArtifacts.push(adversarialArtifacts);
    }

    const revisionArtifacts = await this.createRevisionStage(
      _run,
      _roundIndex,
      reviseStage,
      proposals.artifacts,
      peerReviews.artifacts,
      adversarialArtifacts?.artifacts ?? [],
    );
    stageArtifacts.push(revisionArtifacts);

    const convergence = await this.createConvergenceStage(
      _run,
      _roundIndex,
      convergenceStage,
      proposals.artifacts,
      peerReviews.artifacts,
      adversarialArtifacts?.artifacts ?? [],
      revisionArtifacts.artifacts,
      _state.convergence,
    );
    stageArtifacts.push(convergence);

    const revisedProposals = revisionArtifacts.artifacts
      .filter((artifact): artifact is AssemblyArtifactRecord & { payload: ModelProposal } => artifact.artifactType === "proposal")
      .map((artifact) => artifact.payload);
    const currentProposals = revisedProposals.length > 0
      ? revisedProposals
      : proposals.artifacts
        .filter((artifact): artifact is AssemblyArtifactRecord & { payload: ModelProposal } => artifact.artifactType === "proposal")
        .map((artifact) => artifact.payload);
    const allArtifacts = stageArtifacts.flatMap((stage) => stage.artifacts);
    return {
      proposals: currentProposals,
      peerReviews: allArtifacts
        .filter((artifact): artifact is AssemblyArtifactRecord & { payload: PeerReview } => artifact.artifactType === "peer_review")
        .map((artifact) => artifact.payload),
      adversarialReviews: allArtifacts
        .filter((artifact): artifact is AssemblyArtifactRecord & { payload: AdversarialReview } => artifact.artifactType === "adversarial_review")
        .map((artifact) => artifact.payload),
      defenses: allArtifacts
        .filter((artifact): artifact is AssemblyArtifactRecord & { payload: DefenseResponse } => artifact.artifactType === "defense_response")
        .map((artifact) => artifact.payload),
      convergence: convergence.artifacts[0]?.payload as ConvergenceScore | undefined,
    };
  }

  public shouldStop(run: AssemblyRunRecord, state: ExecutionState, scores: ConvergenceScore[]): AssemblyStopCheck {
    const current = state.convergence;
    if (!current) {
      return { shouldStop: false };
    }
    const usage = summarizeUsage([
      ...state.proposals.map((proposal) => proposal.usage),
      ...state.peerReviews.map((review) => ({ latencyMs: undefined, costUsd: undefined })),
    ]);
    if ((usage.costUsd ?? 0) >= run.settings.costBudgetUsd) {
      return { shouldStop: true, reason: "budget_exceeded", details: "Cost budget exhausted." };
    }
    if ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) >= run.settings.tokenBudget) {
      return { shouldStop: true, reason: "budget_exceeded", details: "Token budget exhausted." };
    }
    if (current.compositeScore >= run.settings.convergenceThreshold && current.minorityFlags.length === 0) {
      return { shouldStop: true, reason: "converged", details: "Composite score reached threshold." };
    }
    if (scores.length >= run.settings.stagnationWindow && this.convergenceScorer.detectStagnation(scores, run.settings.stagnationWindow) < 0.02) {
      return { shouldStop: true, reason: "stagnated", details: "Convergence delta stayed below epsilon." };
    }
    const duplicateRate = calculateDuplicateObjectionRate(state.adversarialReviews);
    if (duplicateRate >= 0.65 && run.adversarialSettings.repetitiveObjectionCutoff) {
      return { shouldStop: true, reason: "repetitive_objections", details: "Objection fingerprint duplication exceeded cutoff." };
    }
    if (run.currentRoundIndex >= run.settings.maxRounds) {
      return { shouldStop: true, reason: "max_rounds", details: "Configured max rounds reached." };
    }
    return { shouldStop: false };
  }

  public async finalize(_run: AssemblyRunRecord, _state: ExecutionState): Promise<AssemblyRunRecord> {
    const result = await this.buildResult(_run, _state);
    const synthesisStage = _run.adversarialSettings.enabled ? "A6_synthesis" : "S5_synthesis";
    const resultArtifact = buildArtifactRecord({
      runId: _run.runId,
      roundIndex: _run.currentRoundIndex,
      stage: synthesisStage,
      artifactType: "result",
      payload: result,
    });
    this.storage.assembly.saveArtifacts([resultArtifact]);
    this.storage.assembly.saveRound({
      roundId: `${_run.runId}:${_run.currentRoundIndex}:${synthesisStage}`,
      runId: _run.runId,
      roundIndex: _run.currentRoundIndex,
      stage: synthesisStage,
      status: "completed",
      participantIds: _run.settings.participantModels.map((participant) => participantModelRef(participant)),
      artifactIds: [resultArtifact.artifactId],
      startedAt: resultArtifact.createdAt,
      finishedAt: resultArtifact.createdAt,
    });
    const reputations = this.reputationTracker.recordRunOutcome({
      run: _run,
      proposals: _state.proposals,
      peerReviews: _state.peerReviews,
      adversarialReviews: _state.adversarialReviews,
      result,
    });
    const next = this.storage.assembly.updateRun(_run.runId, {
      status: "completed",
      currentStage: "completed",
      result,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.publishRealtime("assembly_run_completed", "assembly", {
      runId: _run.runId,
      resultArtifactId: resultArtifact.artifactId,
      minorityReport: Boolean(result.minorityReport),
      reputationUpdates: reputations.length,
    });
    return next;
  }

  private async buildResult(run: AssemblyRunRecord, state: ExecutionState): Promise<AssemblyResult> {
    const exports = await writeAssemblyExports(this.storage, this.rootDir, run, state);
    const topScore = sortedProposalScores(state.convergence).slice(0, 2);
    const shouldSplit = topScore.length > 1
      && Math.abs(topScore[0]!.score - topScore[1]!.score) <= 0.05
        || Boolean(state.convergence?.minorityFlags.length);
    if (shouldSplit && state.convergence) {
      return this.synthesisEngine.buildSplitDecision({
        run,
        proposals: state.proposals,
        peerReviews: state.peerReviews,
        adversarialReviews: state.adversarialReviews,
        convergence: state.convergence,
        exports,
      });
    }
    return this.synthesisEngine.buildConsensus({
      run,
      proposals: state.proposals,
      peerReviews: state.peerReviews,
      adversarialReviews: state.adversarialReviews,
      convergence: state.convergence ?? this.convergenceScorer.scoreRound({
        runId: run.runId,
        roundIndex: run.currentRoundIndex,
        proposals: state.proposals,
        peerReviews: state.peerReviews,
        adversarialReviews: state.adversarialReviews,
      }),
      exports,
    });
  }

  private async createProposalStage(
    run: AssemblyRunRecord,
    roundIndex: number,
    stage: AssemblyStage,
    state: ExecutionState,
  ): Promise<StageArtifacts> {
    const artifacts = await Promise.all(run.settings.participantModels.map(async (participant, index) => {
      const fallback = fallbackProposal(run, roundIndex, participant, state.peerReviews);
      const invoked = await this.registry.invokeStructured({
        participant,
        problem: run.problem,
        stage,
        instructions: proposalInstructions(run, state.peerReviews, state.adversarialReviews, participant),
        schemaLabel: "ModelProposal",
        priorArtifacts: [],
        fallbackPayload: fallback,
      }).catch(() => ({
        payload: fallback,
        usage: undefined,
        providerId: participant.providerId,
        modelId: participant.model,
        modelRef: participantModelRef(participant),
      }));
      const proposal = mapProposalPayload(run.runId, roundIndex, participant, invoked.payload, invoked.usage, index);
      return buildArtifactRecord({
        runId: run.runId,
        roundIndex,
        stage,
        artifactType: "proposal",
        payload: proposal,
        participantModelRef: proposal.authorModelRef,
        blindedAuthorToken: proposal.blindedAuthorToken,
      });
    }));
    return this.persistStage(run, roundIndex, stage, artifacts);
  }

  private async createPeerReviewStage(
    run: AssemblyRunRecord,
    roundIndex: number,
    stage: AssemblyStage,
    proposalArtifacts: AssemblyArtifactRecord[],
    state: ExecutionState,
  ): Promise<StageArtifacts> {
    const proposals = proposalArtifacts.map((artifact) => artifact.payload as ModelProposal);
    const assignments = this.peerReviewEngine.assignBlindReviews(proposals, run.settings.participantModels);
    const artifacts = await Promise.all(assignments.map(async ({ proposal, reviewer }) => {
      const fallback = fallbackPeerReview(run.runId, roundIndex, proposal, reviewer);
      const invoked = await this.registry.invokeStructured({
        participant: reviewer,
        problem: run.problem,
        stage,
        instructions: peerReviewInstructions(proposal, state.peerReviews),
        schemaLabel: "PeerReview",
        priorArtifacts: proposalArtifacts,
        fallbackPayload: fallback,
      }).catch(() => ({
        payload: fallback,
        usage: undefined,
        providerId: reviewer.providerId,
        modelId: reviewer.model,
        modelRef: participantModelRef(reviewer),
      }));
      const review = mapPeerReviewPayload(run.runId, roundIndex, proposal, reviewer, invoked.payload);
      return buildArtifactRecord({
        runId: run.runId,
        roundIndex,
        stage,
        artifactType: "peer_review",
        payload: review,
        participantModelRef: participantModelRef(reviewer),
        blindedAuthorToken: review.blindedReviewerToken,
      });
    }));
    return this.persistStage(run, roundIndex, stage, artifacts);
  }

  private async createAdversarialStage(
    run: AssemblyRunRecord,
    roundIndex: number,
    proposalArtifacts: AssemblyArtifactRecord[],
    state: ExecutionState,
  ): Promise<StageArtifacts> {
    const proposals = proposalArtifacts.map((artifact) => artifact.payload as ModelProposal);
    const selected = this.adversarialEngine.selectAdversaries(
      run.settings.participantModels,
      run.adversarialSettings,
      this.storage.assembly.listReputations(100),
    );
    const artifacts = await Promise.all(proposals.flatMap((proposal, index) => {
      const reviewer = selected[index % selected.length];
      if (!reviewer) {
        return [];
      }
      const fallback = fallbackAdversarialReview(run.runId, roundIndex, proposal, reviewer);
      return [this.registry.invokeStructured({
        participant: reviewer,
        problem: run.problem,
        stage: "A3_adversarial_challenge",
        instructions: adversarialInstructions(proposal, run.adversarialSettings),
        schemaLabel: "AdversarialReview",
        priorArtifacts: proposalArtifacts,
        fallbackPayload: fallback,
      }).then((invoked) => buildArtifactRecord({
        runId: run.runId,
        roundIndex,
        stage: "A3_adversarial_challenge",
        artifactType: "adversarial_review",
        payload: mapAdversarialPayload(run.runId, roundIndex, proposal, reviewer, invoked.payload),
        participantModelRef: participantModelRef(reviewer),
        blindedAuthorToken: blindedReviewerToken(participantModelRef(reviewer)),
      })).catch(() => buildArtifactRecord({
        runId: run.runId,
        roundIndex,
        stage: "A3_adversarial_challenge",
        artifactType: "adversarial_review",
        payload: mapAdversarialPayload(run.runId, roundIndex, proposal, reviewer, fallback),
        participantModelRef: participantModelRef(reviewer),
        blindedAuthorToken: blindedReviewerToken(participantModelRef(reviewer)),
      }))];
    }));
    const dedupedReviews = this.adversarialEngine.dedupeObjections(
      artifacts.map((artifact) => artifact.payload as AdversarialReview),
    );
    return this.persistStage(run, roundIndex, "A3_adversarial_challenge", dedupedReviews.map((review) => buildArtifactRecord({
      runId: run.runId,
      roundIndex,
      stage: "A3_adversarial_challenge",
      artifactType: "adversarial_review",
      payload: review,
      participantModelRef: undefined,
      blindedAuthorToken: review.blindedReviewerToken,
    })));
  }

  private async createRevisionStage(
    run: AssemblyRunRecord,
    roundIndex: number,
    stage: AssemblyStage,
    proposalArtifacts: AssemblyArtifactRecord[],
    reviewArtifacts: AssemblyArtifactRecord[],
    adversarialArtifacts: AssemblyArtifactRecord[],
  ): Promise<StageArtifacts> {
    const proposals = proposalArtifacts.map((artifact) => artifact.payload as ModelProposal);
    const peerReviews = reviewArtifacts.map((artifact) => artifact.payload as PeerReview);
    if (!run.adversarialSettings.enabled) {
      const revised = proposals.map((proposal) => buildArtifactRecord({
        runId: run.runId,
        roundIndex,
        stage,
        artifactType: "proposal",
        payload: {
          ...proposal,
          proposalId: randomUUID(),
          abstract: `${proposal.abstract} (revised)`,
          updatedAt: new Date().toISOString(),
        },
        participantModelRef: proposal.authorModelRef,
        blindedAuthorToken: proposal.blindedAuthorToken,
      }));
      return this.persistStage(run, roundIndex, stage, revised);
    }
    const adversarialReviews = adversarialArtifacts.map((artifact) => artifact.payload as AdversarialReview);
    const defenses = proposals.map((proposal) => buildArtifactRecord({
      runId: run.runId,
      roundIndex,
      stage,
      artifactType: "defense_response",
      payload: buildDefenseResponse(run.runId, roundIndex, proposal, peerReviews, adversarialReviews),
      participantModelRef: proposal.authorModelRef,
      blindedAuthorToken: proposal.blindedAuthorToken,
    }));
    return this.persistStage(run, roundIndex, stage, defenses);
  }

  private async createConvergenceStage(
    run: AssemblyRunRecord,
    roundIndex: number,
    stage: AssemblyStage,
    proposalArtifacts: AssemblyArtifactRecord[],
    reviewArtifacts: AssemblyArtifactRecord[],
    adversarialArtifacts: AssemblyArtifactRecord[],
    _revisionArtifacts: AssemblyArtifactRecord[],
    previous?: ConvergenceScore,
  ): Promise<StageArtifacts> {
    const revisedProposals = _revisionArtifacts
      .filter((artifact): artifact is AssemblyArtifactRecord & { payload: ModelProposal } => artifact.artifactType === "proposal")
      .map((artifact) => artifact.payload);
    const convergence = this.convergenceScorer.scoreRound({
      runId: run.runId,
      roundIndex,
      proposals: revisedProposals.length > 0
        ? revisedProposals
        : proposalArtifacts.map((artifact) => artifact.payload as ModelProposal),
      peerReviews: reviewArtifacts.map((artifact) => artifact.payload as PeerReview),
      adversarialReviews: adversarialArtifacts.map((artifact) => artifact.payload as AdversarialReview),
      previous,
    });
    const artifact = buildArtifactRecord({
      runId: run.runId,
      roundIndex,
      stage,
      artifactType: "convergence_score",
      payload: convergence,
    });
    return this.persistStage(run, roundIndex, stage, [artifact], {
      convergenceSnapshot: convergence,
      stopCheck: this.shouldStop(run, {
        proposals: revisedProposals.length > 0
          ? revisedProposals
          : proposalArtifacts.map((item) => item.payload as ModelProposal),
        peerReviews: reviewArtifacts.map((item) => item.payload as PeerReview),
        adversarialReviews: adversarialArtifacts.map((item) => item.payload as AdversarialReview),
        defenses: [],
        convergence,
      }, previous ? [previous, convergence] : [convergence]),
    });
  }

  private persistStage(
    run: AssemblyRunRecord,
    roundIndex: number,
    stage: AssemblyStage,
    artifacts: AssemblyArtifactRecord[],
    extras?: Pick<AssemblyRound, "convergenceSnapshot" | "stopCheck">,
  ): StageArtifacts {
    const startedAt = new Date().toISOString();
    const round: AssemblyRound = {
      roundId: `${run.runId}:${roundIndex}:${stage}`,
      runId: run.runId,
      roundIndex,
      stage,
      status: "completed",
      participantIds: run.settings.participantModels.map((participant) => participantModelRef(participant)),
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
      convergenceSnapshot: extras?.convergenceSnapshot,
      stopCheck: extras?.stopCheck,
      startedAt,
      finishedAt: startedAt,
    };
    this.storage.assembly.saveRound(round);
    this.storage.assembly.saveArtifacts(artifacts);
    this.storage.assembly.updateRun(run.runId, {
      currentStage: stage,
      currentRoundIndex: roundIndex,
      updatedAt: startedAt,
    });
    this.publishRealtime("assembly_stage_completed", "assembly", {
      runId: run.runId,
      roundIndex,
      stage,
      artifactIds: round.artifactIds,
    });
    return { round, artifacts };
  }
}

export class AssemblyService {
  private readonly registry: ProviderAdapterRegistry;
  private readonly peerReviewEngine = new PeerReviewEngine();
  private readonly adversarialEngine = new AdversarialEngine();
  private readonly convergenceScorer = new ConvergenceScorer();
  private readonly reputationTracker: ReputationTracker;
  private readonly synthesisEngine = new SynthesisEngine();
  private readonly orchestrator: AssemblyOrchestrator;
  private readonly backgroundTasks = new Set<Promise<void>>();

  public constructor(private readonly options: AssemblyServiceOptions) {
    this.registry = new ProviderAdapterRegistry(options.createChatCompletion);
    this.reputationTracker = new ReputationTracker(options.storage);
    this.orchestrator = new AssemblyOrchestrator(
      options.storage,
      this.registry,
      this.peerReviewEngine,
      this.adversarialEngine,
      this.convergenceScorer,
      this.synthesisEngine,
      this.reputationTracker,
      options.publishRealtime,
      options.rootDir,
    );
  }

  public async createRun(input: CreateAssemblyRunInput): Promise<AssemblyRunRecord> {
    const run = await this.orchestrator.startRun(input);
    const task = this.executeRun(run.runId)
      .catch((error) => {
        this.options.storage.assembly.updateRun(run.runId, {
          status: "failed",
          error: (error as Error).message,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        this.options.publishRealtime("assembly_run_failed", "assembly", {
          runId: run.runId,
          error: (error as Error).message,
        });
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });
    this.backgroundTasks.add(task);
    return run;
  }

  public listRuns(limit = 50): AssemblyRunRecord[] {
    return this.options.storage.assembly.listRuns(limit);
  }

  public getRunDetail(runId: string): AssemblyRunDetailResponse {
    return {
      run: this.options.storage.assembly.getRun(runId),
      rounds: this.options.storage.assembly.listRounds(runId),
      artifacts: this.options.storage.assembly.listArtifacts(runId),
    };
  }

  public listReputations(limit = 50): ModelReputation[] {
    return this.options.storage.assembly.listReputations(limit);
  }

  public async close(): Promise<void> {
    if (this.backgroundTasks.size === 0) {
      return;
    }
    await Promise.allSettled([...this.backgroundTasks]);
    this.backgroundTasks.clear();
  }

  private async executeRun(runId: string): Promise<void> {
    let run = this.options.storage.assembly.getRun(runId);
    run = this.options.storage.assembly.updateRun(runId, {
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const state: ExecutionState = {
      proposals: [],
      peerReviews: [],
      adversarialReviews: [],
      defenses: [],
    };
    const problemArtifact = buildArtifactRecord({
      runId: run.runId,
      roundIndex: 0,
      stage: run.currentStage,
      artifactType: "problem",
      payload: run.problem,
    });
    this.options.storage.assembly.saveArtifacts([problemArtifact]);
    this.options.storage.assembly.saveRound({
      roundId: `${run.runId}:0:${run.currentStage}`,
      runId: run.runId,
      roundIndex: 0,
      stage: run.currentStage,
      status: "completed",
      participantIds: run.settings.participantModels.map((participant) => participantModelRef(participant)),
      artifactIds: [problemArtifact.artifactId],
      startedAt: problemArtifact.createdAt,
      finishedAt: problemArtifact.createdAt,
    });
    this.options.publishRealtime("assembly_stage_completed", "assembly", {
      runId: run.runId,
      stage: run.currentStage,
      artifactId: problemArtifact.artifactId,
    });
    for (let roundIndex = 1; roundIndex <= run.settings.maxRounds; roundIndex += 1) {
      run = this.options.storage.assembly.getRun(runId);
      const nextState = await this.orchestrator.runRound(run, roundIndex, state);
      state.proposals = nextState.proposals;
      state.peerReviews = nextState.peerReviews;
      state.adversarialReviews = nextState.adversarialReviews;
      state.defenses = nextState.defenses;
      state.convergence = nextState.convergence;
      run = this.options.storage.assembly.getRun(runId);
      const convergenceHistory = this.options.storage.assembly
        .listArtifacts(runId, "convergence_score")
        .map((item) => item.payload)
        .filter((item): item is ConvergenceScore => typeof item === "object" && item !== null && "compositeScore" in item);
      const stopCheck = this.orchestrator.shouldStop(run, state, convergenceHistory);
      if (stopCheck.shouldStop) {
        run = this.options.storage.assembly.updateRun(runId, {
          stopReason: stopCheck.reason,
          updatedAt: new Date().toISOString(),
        });
        break;
      }
    }
    await this.orchestrator.finalize(this.options.storage.assembly.getRun(runId), state);
  }
}

function buildArtifactRecord<T extends AssemblyArtifactRecord["payload"]>(input: {
  runId: string;
  roundIndex: number;
  stage: AssemblyStage;
  artifactType: AssemblyArtifactType;
  payload: T;
  participantModelRef?: string;
  blindedAuthorToken?: string;
}): AssemblyArtifactRecord {
  return {
    artifactId: randomUUID(),
    runId: input.runId,
    roundIndex: input.roundIndex,
    stage: input.stage,
    artifactType: input.artifactType,
    payload: input.payload,
    participantModelRef: input.participantModelRef,
    blindedAuthorToken: input.blindedAuthorToken,
    createdAt: new Date().toISOString(),
  };
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/g, " ");
  return compact.slice(0, 80) || "Assembly run";
}

function summarizeContextRefs(contextRefs: AssemblyContextRef[] | undefined): string[] {
  return (contextRefs ?? []).map((ref) => ref.label?.trim() || `${ref.kind}:${ref.ref}`);
}

function withDefaultAdversarialSettings(settings: AdversarialSettings | undefined): AdversarialSettings {
  return {
    enabled: false,
    reviewerCount: 1,
    selectionStrategy: "rotate_among_participants",
    strictness: "balanced",
    requireMitigations: true,
    requireEvidenceTags: true,
    defenseRoundEnabled: true,
    repetitiveObjectionCutoff: true,
    minorityReportRequired: false,
    ...settings,
  };
}

function defaultEvaluationCriteria(domain: AssemblyProblem["domain"]): string[] {
  const shared = ["Correctness", "Evidence quality", "Risk awareness", "Testability"];
  const domainSpecific: Record<AssemblyProblem["domain"], string[]> = {
    coding: ["Implementation practicality", "Debugging leverage"],
    architecture: ["Boundary clarity", "Migration safety"],
    writing: ["Clarity", "Audience fit"],
    seo: ["Search intent fit", "Content defensibility"],
    analysis: ["Signal quality", "Decision usefulness"],
    strategy: ["Tradeoff rigor", "Execution feasibility"],
  };
  return [...shared, ...(domainSpecific[domain] ?? [])];
}

function proposalInstructions(
  run: AssemblyRunRecord,
  peerReviews: PeerReview[],
  adversarialReviews: AdversarialReview[],
  participant: AssemblyParticipantModel,
): string {
  return [
    `Problem: ${run.problem.normalizedStatement}`,
    `Objectives: ${run.problem.objectives.join("; ")}`,
    `Constraints: ${run.problem.constraints.join("; ")}`,
    `Mode: ${run.settings.mode}`,
    `Participant: ${participant.providerId}/${participant.model}`,
    peerReviews.length > 0 ? `Prior peer review signals: ${peerReviews.map((review) => review.verdict).join(", ")}` : "No prior peer review signals.",
    adversarialReviews.length > 0 ? `Prior adversarial objections: ${adversarialReviews.flatMap((review) => review.objections.map((objection) => objection.title)).join("; ")}` : "No prior adversarial objections.",
    "Return JSON that matches ModelProposal.",
  ].join("\n");
}

function peerReviewInstructions(proposal: ModelProposal, priorReviews: PeerReview[]): string {
  return [
    `Review proposal ${proposal.proposalId}.`,
    `Abstract: ${proposal.abstract}`,
    `Diagnosis: ${proposal.diagnosis}`,
    `Solution: ${proposal.proposedSolution}`,
    priorReviews.length > 0 ? `Existing verdicts: ${priorReviews.map((review) => review.verdict).join(", ")}` : "No existing verdicts.",
    "Return JSON that matches PeerReview.",
  ].join("\n");
}

function adversarialInstructions(proposal: ModelProposal, settings: AdversarialSettings): string {
  return [
    `Challenge proposal ${proposal.proposalId}.`,
    `Strengths: ${proposal.abstract}`,
    `Strictness: ${settings.strictness}`,
    `Require mitigations: ${settings.requireMitigations ? "yes" : "no"}`,
    `Require evidence tags: ${settings.requireEvidenceTags ? "yes" : "no"}`,
    "Return JSON that matches AdversarialReview and include strengths first.",
  ].join("\n");
}

function buildStructuredPrompt(input: StructuredInvocationInput): string {
  return [
    `Schema: ${input.schemaLabel}`,
    `Stage: ${input.stage}`,
    `Problem title: ${input.problem.title}`,
    `Instructions:`,
    input.instructions,
    input.priorArtifacts?.length ? `Prior artifacts available: ${input.priorArtifacts.length}` : "Prior artifacts available: 0",
    "If uncertain, still return syntactically valid JSON.",
  ].join("\n\n");
}

function parseLooseJsonRecord(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const sliced = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        return sliced && typeof sliced === "object" && !Array.isArray(sliced) ? sliced as Record<string, unknown> : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function extractCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => {
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : "";
  }).join("");
}

function readNumericUsage(usage: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function participantModelRef(participant: AssemblyParticipantModel): string {
  return `${participant.providerId}:${participant.model}`;
}

function blindedReviewerToken(modelRef: string): string {
  return `blind:${modelRef}`;
}

function mapProposalPayload(
  runId: string,
  roundIndex: number,
  participant: AssemblyParticipantModel,
  payload: Record<string, unknown>,
  usage: AssemblyUsageSummary | undefined,
  ordinal: number,
): ModelProposal {
  const now = new Date().toISOString();
  return {
    runId,
    roundIndex,
    proposalId: stringOrFallback(payload.proposalId, randomUUID()),
    authorModelRef: participantModelRef(participant),
    blindedAuthorToken: `proposal-${ordinal + 1}`,
    abstract: stringOrFallback(payload.abstract, `Proposal from ${participant.model}`),
    diagnosis: stringOrFallback(payload.diagnosis, "Diagnosis pending."),
    proposedSolution: stringOrFallback(payload.proposedSolution, "Propose an incremental, reviewable path."),
    reasoning: stringOrFallback(payload.reasoning, "Reasoning unavailable."),
    risks: stringArrayOrFallback(payload.risks, ["Risks were not supplied."]),
    assumptions: stringArrayOrFallback(payload.assumptions, ["Assumptions were not supplied."]),
    confidence: clamp01(numberOrFallback(payload.confidence, 0.62)),
    evidence: normalizeEvidence(payload.evidence),
    testPlan: normalizeTestPlan(payload.testPlan),
    schemaVersion: 1,
    usage,
    createdAt: now,
    updatedAt: now,
  };
}

function mapPeerReviewPayload(
  runId: string,
  roundIndex: number,
  proposal: ModelProposal,
  reviewer: AssemblyParticipantModel,
  payload: Record<string, unknown>,
): PeerReview {
  return {
    runId,
    roundIndex,
    reviewId: stringOrFallback(payload.reviewId, randomUUID()),
    proposalId: proposal.proposalId,
    blindedReviewerToken: blindedReviewerToken(participantModelRef(reviewer)),
    strengths: stringArrayOrFallback(payload.strengths, ["Clear framing."]),
    weaknesses: stringArrayOrFallback(payload.weaknesses, ["Needs more supporting detail."]),
    missingAssumptions: stringArrayOrFallback(payload.missingAssumptions, ["Assumption gaps not explicitly called out."]),
    failureScenarios: stringArrayOrFallback(payload.failureScenarios, ["Edge cases need validation."]),
    scores: {
      correctness: clamp01(numberOrFallback(readRecord(payload, "scores")?.correctness, 0.66)),
      reasoningStrength: clamp01(numberOrFallback(readRecord(payload, "scores")?.reasoningStrength, 0.64)),
      practicality: clamp01(numberOrFallback(readRecord(payload, "scores")?.practicality, 0.63)),
      evidenceQuality: clamp01(numberOrFallback(readRecord(payload, "scores")?.evidenceQuality, 0.6)),
      riskAwareness: clamp01(numberOrFallback(readRecord(payload, "scores")?.riskAwareness, 0.62)),
      testability: clamp01(numberOrFallback(readRecord(payload, "scores")?.testability, 0.61)),
      clarity: clamp01(numberOrFallback(readRecord(payload, "scores")?.clarity, 0.7)),
    },
    verdict: readVerdict(payload.verdict),
    mergeTargetProposalId: typeof payload.mergeTargetProposalId === "string" ? payload.mergeTargetProposalId : undefined,
    confidence: clamp01(numberOrFallback(payload.confidence, 0.65)),
    createdAt: new Date().toISOString(),
  };
}

function mapAdversarialPayload(
  runId: string,
  roundIndex: number,
  proposal: ModelProposal,
  reviewer: AssemblyParticipantModel,
  payload: Record<string, unknown>,
): AdversarialReview {
  return {
    runId,
    roundIndex,
    reviewId: stringOrFallback(payload.reviewId, randomUUID()),
    proposalId: proposal.proposalId,
    blindedReviewerToken: blindedReviewerToken(participantModelRef(reviewer)),
    strengthsFirst: stringArrayOrFallback(payload.strengthsFirst, ["The proposal has a workable core."]),
    objections: normalizeObjections(payload.objections),
    overallAssessment: stringOrFallback(payload.overallAssessment, "Challenge remains bounded and actionable."),
    usefulnessPending: true,
    createdAt: new Date().toISOString(),
  };
}

function buildDefenseResponse(
  runId: string,
  roundIndex: number,
  proposal: ModelProposal,
  peerReviews: PeerReview[],
  adversarialReviews: AdversarialReview[],
): DefenseResponse {
  const proposalReviews = peerReviews.filter((review) => review.proposalId === proposal.proposalId);
  const challenges = adversarialReviews.filter((review) => review.proposalId === proposal.proposalId);
  return {
    runId,
    roundIndex,
    responseId: randomUUID(),
    proposalId: proposal.proposalId,
    challengedReviewIds: [...proposalReviews.map((review) => review.reviewId), ...challenges.map((review) => review.reviewId)],
    acceptedPoints: dedupeStrings([
      ...proposalReviews.flatMap((review) => review.weaknesses.slice(0, 1)),
      ...challenges.flatMap((review) => review.objections.filter((objection) => objection.classification !== "speculative_concern").map((objection) => objection.title).slice(0, 1)),
    ]),
    rejectedPoints: challenges
      .flatMap((review) => review.objections.filter((objection) => objection.classification === "speculative_concern").map((objection) => objection.title)),
    revisionsMade: proposal.testPlan.slice(0, 2).map((item) => `Expanded ${item.title}`),
    unresolvedDisputes: challenges.flatMap((review) => review.objections.filter((objection) => !objection.mitigation?.trim()).map((objection) => objection.title)),
    updatedConfidence: clamp01(proposal.confidence - (challenges.length * 0.04)),
    createdAt: new Date().toISOString(),
  };
}

function fallbackProposal(
  run: AssemblyRunRecord,
  roundIndex: number,
  participant: AssemblyParticipantModel,
  peerReviews: PeerReview[],
): Record<string, unknown> {
  return {
    proposalId: randomUUID(),
    abstract: `${participant.model} recommends an incremental ${run.problem.domain} path`,
    diagnosis: run.problem.normalizedStatement,
    proposedSolution: `Execute round ${roundIndex} with a bounded ${run.settings.mode} plan and validate the highest-risk assumptions first.`,
    reasoning: peerReviews.length > 0
      ? `Incorporate ${peerReviews.length} prior review signal(s) before converging.`
      : "Start with a bounded proposal and preserve disagreement explicitly.",
    risks: ["Budget pressure", "Premature convergence", "Insufficient evidence"],
    assumptions: ["Relevant context is already present", "Participant models are complementary"],
    confidence: 0.64,
    evidence: [
      { evidenceId: randomUUID(), label: "Prompt", detail: run.problem.originalPrompt, kind: "claim" },
    ],
    testPlan: [
      { testId: randomUUID(), title: "Review output", detail: "Inspect the proposal for correctness and scope.", kind: "review" },
      { testId: randomUUID(), title: "Validate risks", detail: "Check the top listed risks before execution.", kind: "manual" },
    ],
  };
}

function fallbackPeerReview(
  runId: string,
  roundIndex: number,
  proposal: ModelProposal,
  reviewer: AssemblyParticipantModel,
): Record<string, unknown> {
  return {
    reviewId: randomUUID(),
    proposalId: proposal.proposalId,
    strengths: [`${reviewer.model} found the proposal clear enough to evaluate.`],
    weaknesses: ["Needs more evidence backing the main recommendation."],
    missingAssumptions: ["The effect of constraints on delivery is under-specified."],
    failureScenarios: ["A hidden constraint could invalidate the current scope."],
    scores: {
      correctness: 0.66,
      reasoningStrength: 0.64,
      practicality: 0.63,
      evidenceQuality: 0.58,
      riskAwareness: 0.62,
      testability: 0.61,
      clarity: 0.71,
    },
    verdict: roundIndex > 1 ? "accept" : "revise",
    confidence: 0.65,
    runId,
  };
}

function fallbackAdversarialReview(
  runId: string,
  roundIndex: number,
  proposal: ModelProposal,
  reviewer: AssemblyParticipantModel,
): Record<string, unknown> {
  return {
    runId,
    roundIndex,
    reviewId: randomUUID(),
    proposalId: proposal.proposalId,
    strengthsFirst: [`${reviewer.model} agrees the proposal is directionally sound.`],
    objections: [
      {
        objectionId: randomUUID(),
        title: "Evidence remains thin",
        detail: "The recommendation would be stronger with a concrete validation step before rollout.",
        classification: "moderate_risk",
        evidenceBasis: "evidence_based",
        mitigation: "Add an explicit verification checkpoint.",
        predictedImpact: "Could reduce rework and false confidence.",
      },
    ],
    overallAssessment: "Challenge is actionable and limited in scope.",
  };
}

function normalizeEvidence(raw: unknown): ModelProposal["evidence"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item, index) => {
    const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      evidenceId: stringOrFallback(record.evidenceId, `evidence-${index + 1}`),
      label: stringOrFallback(record.label, `Evidence ${index + 1}`),
      detail: stringOrFallback(record.detail, "Evidence detail unavailable."),
      kind: typeof record.kind === "string" ? record.kind as ModelProposal["evidence"][number]["kind"] : "claim",
      sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
      confidence: typeof record.confidence === "number" ? clamp01(record.confidence) : undefined,
    };
  });
}

function normalizeTestPlan(raw: unknown): ModelProposal["testPlan"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item, index) => {
    const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      testId: stringOrFallback(record.testId, `test-${index + 1}`),
      title: stringOrFallback(record.title, `Validation ${index + 1}`),
      detail: stringOrFallback(record.detail, "Validation detail unavailable."),
      kind: typeof record.kind === "string" ? record.kind as ModelProposal["testPlan"][number]["kind"] : "review",
    };
  });
}

function normalizeObjections(raw: unknown): AdversarialReview["objections"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item, index) => {
    const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      objectionId: stringOrFallback(record.objectionId, `objection-${index + 1}`),
      title: stringOrFallback(record.title, `Objection ${index + 1}`),
      detail: stringOrFallback(record.detail, "No detail supplied."),
      classification: readObjectionClass(record.classification),
      evidenceBasis: record.evidenceBasis === "speculative" ? "speculative" : "evidence_based",
      mitigation: typeof record.mitigation === "string" ? record.mitigation : undefined,
      predictedImpact: typeof record.predictedImpact === "string" ? record.predictedImpact : undefined,
    };
  });
}

function weightedReviewScore(review: PeerReview): number {
  return clamp01(
    review.scores.correctness * 0.24
    + review.scores.reasoningStrength * 0.2
    + review.scores.practicality * 0.16
    + review.scores.evidenceQuality * 0.14
    + review.scores.riskAwareness * 0.12
    + review.scores.testability * 0.08
    + review.scores.clarity * 0.06,
  );
}

function buildDisagreementClusters(
  reviews: PeerReview[],
  adversarialReviews: AdversarialReview[],
): AssemblyDisagreementCluster[] {
  const fromWeaknesses = reviews.flatMap((review, index) => review.weaknesses.slice(0, 1).map((weakness) => ({
    clusterId: `review-${index + 1}`,
    topic: weakness,
    proposalIds: [review.proposalId],
    severity: "medium" as const,
    summary: weakness,
  })));
  const fromChallenges = adversarialReviews.flatMap((review, index) => review.objections.slice(0, 1).map((objection) => ({
    clusterId: `adversarial-${index + 1}`,
    topic: objection.title,
    proposalIds: [review.proposalId],
    severity: objection.classification === "critical_flaw" ? "high" as const : "medium" as const,
    summary: objection.detail,
  })));
  return dedupeBy([...fromWeaknesses, ...fromChallenges], (item) => fingerprintObjection(item.topic, item.summary));
}

function createEmptyReputation(participant: AssemblyParticipantModel): ModelReputation {
  return {
    modelRef: participantModelRef(participant),
    providerId: participant.providerId,
    modelId: participant.model,
    overall: 0,
    byDomain: {},
    accuracy: 0,
    reasoningStrength: 0,
    critiqueQuality: 0,
    consensusLeadership: 0,
    stability: 0,
    adversarialUsefulness: 0,
    sampleCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function writeAssemblyExports(
  storage: Storage,
  rootDir: string,
  run: AssemblyRunRecord,
  state: ExecutionState,
): Promise<AssemblyResultExportRecord[]> {
  const exports: AssemblyResultExportRecord[] = [];
  const requested = new Set(run.settings.exportTargets);
  const artifactDir = path.join(rootDir, "artifacts", "assembly");
  await fs.mkdir(artifactDir, { recursive: true });
  const relPath = path.posix.join("artifacts", "assembly", `${run.runId}.md`);
  const absolutePath = path.join(rootDir, relPath);
  const markdown = buildAssemblyMarkdown(run, state);
  await fs.writeFile(absolutePath, markdown, "utf8");
  exports.push({
    target: "artifact",
    status: requested.has("artifact") ? "generated" : "available",
    relPath,
    detail: "Assembly report written to markdown artifact.",
  });
  if (requested.has("task")) {
    const task = storage.tasks.create({
      workspaceId: run.workspaceId,
      title: `[Assembly] ${run.title}`,
      description: markdown.slice(0, 4_000),
      status: "inbox",
      priority: "normal",
      createdBy: "assembly",
    });
    storage.taskActivities.append(task.taskId, {
      activityType: "comment",
      message: "Assembly exported this result into a task.",
      agentId: "assembly",
    });
    storage.taskDeliverables.append(task.taskId, {
      deliverableType: "artifact",
      title: "Assembly markdown report",
      path: relPath,
      description: "Generated from Assembly of Minds run.",
    });
    exports.push({
      target: "task",
      status: "generated",
      detail: `Created task ${task.taskId}.`,
      relPath,
    });
  } else {
    exports.push({ target: "task", status: "not_requested" });
  }
  if (requested.has("chat") && run.sourceSessionId) {
    storage.chatMessages.upsert({
      messageId: randomUUID(),
      sessionId: run.sourceSessionId,
      role: "assistant",
      actorType: "system",
      actorId: "assembly",
      content: markdown.slice(0, 8_000),
      timestamp: new Date().toISOString(),
    });
    exports.push({
      target: "chat",
      status: "generated",
      detail: `Posted Assembly summary into chat session ${run.sourceSessionId}.`,
      relPath,
    });
  } else {
    exports.push({ target: "chat", status: requested.has("chat") ? "failed" : "not_requested", detail: requested.has("chat") ? "No source chat session was available." : undefined });
  }
  return exports;
}

function buildAssemblyMarkdown(run: AssemblyRunRecord, state: ExecutionState): string {
  const convergence = state.convergence;
  const topProposal = selectWinningProposal(state.proposals, convergence);
  return [
    `# ${run.title}`,
    "",
    `- Run ID: ${run.runId}`,
    `- Domain: ${run.problem.domain}`,
    `- Mode: ${run.settings.mode}`,
    `- Participants: ${run.settings.participantModels.map((participant) => participantModelRef(participant)).join(", ")}`,
    "",
    "## Recommendation",
    "",
    topProposal?.proposedSolution ?? "No recommendation generated.",
    "",
    "## Risks",
    "",
    ...dedupeStrings([
      ...(topProposal?.risks ?? []),
      ...state.adversarialReviews.flatMap((review) => review.objections.map((objection) => objection.detail)),
    ]).map((item) => `- ${item}`),
    "",
    "## Implementation Plan",
    "",
    ...dedupeStrings(topProposal?.testPlan.map((item) => `${item.title}: ${item.detail}`) ?? []).map((item) => `- ${item}`),
    "",
    "## Disagreements",
    "",
    ...(convergence?.disagreementClusters.length
      ? convergence.disagreementClusters.map((cluster) => `- ${cluster.topic}: ${cluster.summary}`)
      : ["- No material disagreement clusters remained."]),
  ].join("\n");
}

function summarizeUsage(values: Array<AssemblyUsageSummary | undefined>): AssemblyUsageSummary {
  return values.reduce<AssemblyUsageSummary>((summary, usage) => ({
    inputTokens: (summary.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
    outputTokens: (summary.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
    costUsd: roundCurrency((summary.costUsd ?? 0) + (usage?.costUsd ?? 0)),
    latencyMs: (summary.latencyMs ?? 0) + (usage?.latencyMs ?? 0),
  }), {});
}

function selectWinningProposal(proposals: ModelProposal[], convergence?: ConvergenceScore): ModelProposal | undefined {
  if (!convergence) {
    return proposals[0];
  }
  return [...proposals].sort(
    (left, right) => (convergence.proposalSupportScores[right.proposalId] ?? 0) - (convergence.proposalSupportScores[left.proposalId] ?? 0),
  )[0];
}

function sortedProposalScores(convergence?: ConvergenceScore): Array<{ proposalId: string; score: number }> {
  if (!convergence) {
    return [];
  }
  return Object.entries(convergence.proposalSupportScores)
    .map(([proposalId, score]) => ({ proposalId, score }))
    .sort((left, right) => right.score - left.score);
}

function calculateDuplicateObjectionRate(reviews: AdversarialReview[]): number {
  const all = reviews.flatMap((review) => review.objections.map((objection) => fingerprintObjection(objection.title, objection.detail)));
  if (all.length === 0) {
    return 0;
  }
  return 1 - (new Set(all).size / all.length);
}

function fingerprintObjection(title: string, detail: string): string {
  return `${title}|${detail}`.trim().toLowerCase().replace(/\s+/g, " ");
}

function readRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readVerdict(value: unknown): PeerReview["verdict"] {
  return value === "accept" || value === "reject" || value === "merge" ? value : "revise";
}

function readObjectionClass(value: unknown): AdversarialReview["objections"][number]["classification"] {
  return value === "critical_flaw" || value === "moderate_risk" || value === "edge_case_concern" || value === "speculative_concern"
    ? value
    : "moderate_risk";
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArrayOrFallback(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.some((item) => typeof item === "string")
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : fallback;
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return clamp01(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function averageInto(current: number, next: number, sampleCount: number): number {
  if (sampleCount <= 1) {
    return clamp01(next);
  }
  const previousWeight = Math.max(0, sampleCount - 1);
  return clamp01(((current * previousWeight) + next) / sampleCount);
}

function roundCurrency(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
