/* eslint-disable max-lines -- Assembly orchestration remains centralized while runtime ownership is still being narrowed. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  ChatRoutedContextSnapshotRecord,
  ChatTurnCapabilityProfileRecord,
  ConvergenceScore,
  CreateAssemblyRunInput,
  DefenseResponse,
  ModelProposal,
  ModelUsageAttributionContext,
  ModelCouncilAttemptEvidence,
  ModelCouncilEvidence,
  ModelCouncilExecutionResult,
  ModelCouncilParticipantArtifact,
  ModelCouncilParticipantResolution,
  ModelCouncilResolution,
  ModelCouncilSynthesisArtifact,
  ModelReputation,
  ModelUsageEventRecord,
  LlmApiStyle,
  PeerReview,
} from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { AssemblyParticipantModel, AssemblyStage } from "@goatcitadel/contracts";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import type { Storage } from "@goatcitadel/storage";
import { resolveAnthropicEffort, resolveAnthropicMaxTokensForVisibleOutput } from "./anthropic-reasoning-budget.js";
import { resolveChatReasoningEffort } from "./chat-reasoning-controls.js";

interface StructuredInvocationInput {
  participant: AssemblyParticipantModel;
  problem: AssemblyProblem;
  stage: AssemblyStage;
  instructions: string;
  schemaLabel: string;
  budgetSlice?: AssemblyUsageSummary;
  priorArtifacts?: AssemblyArtifactRecord[];
  fallbackPayload: Record<string, unknown>;
  attribution: ModelUsageAttributionContext;
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
  createChatCompletion: (
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ) => Promise<ChatCompletionResponse>;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  runBackgroundWork?: <T>(label: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
}

export interface ModelCouncilProviderCandidate {
  providerId: string;
  model: string;
  apiStyle?: LlmApiStyle;
  contextWindowTokens: number;
  routeConfigFingerprint: string;
}

export interface ExecuteChatModelCouncilInput {
  turnId: string;
  sessionId: string;
  workspaceId: string;
  content: string;
  history: ChatCompletionRequest["messages"];
  capabilityProfile: ChatTurnCapabilityProfileRecord;
  providerCandidates: ModelCouncilProviderCandidate[];
  routedContextSnapshot?: ChatRoutedContextSnapshotRecord;
  signal?: AbortSignal;
}

const MODEL_COUNCIL_LEASE_TTL_MS = 120_000;
const MODEL_COUNCIL_LEASE_HEARTBEAT_MS = 10_000;
const MODEL_COUNCIL_MAX_PARTICIPANTS = 3;
const MODEL_COUNCIL_PARTICIPANT_MAX_TOKENS = 1_200;
const MODEL_COUNCIL_SYNTHESIS_MAX_TOKENS = 1_600;
const MODEL_COUNCIL_API_STYLES = new Set<LlmApiStyle>([
  "openai-chat-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-messages",
]);
const MODEL_COUNCIL_PARTICIPANT_INSTRUCTION =
  "You are an advisory member of a read-only model council. Answer independently. " +
  "Do not request or imply tool use, mutations, approvals, memory promotion, or external actions.";
const MODEL_COUNCIL_SYNTHESIS_INSTRUCTION =
  "Synthesize one canonical answer for Chat from the advisory council material. " +
  "Preserve material uncertainty and minority concerns, but do not expose hidden participant identities. " +
  "Do not use tools or perform mutations.";
const MODEL_COUNCIL_STAGE_ORDER = [
  "C0_resolve",
  "C1_participate",
  "C2_assemble",
  "C3_synthesize",
] as const satisfies readonly AssemblyStage[];

export interface AssemblyChatCompletionHost {
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
}

export function bindAssemblyChatCompletion(
  host: AssemblyChatCompletionHost,
): AssemblyServiceOptions["createChatCompletion"] {
  return (request, attribution) => host.createChatCompletion(request, attribution);
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
  public constructor(private readonly createChatCompletion: AssemblyServiceOptions["createChatCompletion"]) {}

  public async invokeStructured(input: StructuredInvocationInput): Promise<StructuredInvocationResult> {
    const prompt = buildStructuredPrompt(input);
    const response = await this.createChatCompletion(
      {
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
      },
      input.attribution,
    );
    const parsed = parseLooseJsonRecord(extractCompletionText(response)) ?? input.fallbackPayload;
    return {
      payload: parsed,
      usage: this.normalizeUsage(response),
      providerId: response.routing?.effectiveProviderId ?? input.participant.providerId,
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
    return (
      review.strengths.length > 0 &&
      review.weaknesses.length > 0 &&
      Number.isFinite(review.confidence) &&
      review.confidence >= 0 &&
      review.confidence <= 1
    );
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
        const leftScore =
          reputations.find((item) => item.modelRef === participantModelRef(left))?.adversarialUsefulness ?? 0;
        const rightScore =
          reputations.find((item) => item.modelRef === participantModelRef(right))?.adversarialUsefulness ?? 0;
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
      return (
        total +
        review.objections.reduce((sum, objection) => {
          const severity =
            objection.classification === "critical_flaw"
              ? 1
              : objection.classification === "moderate_risk"
                ? 0.7
                : objection.classification === "edge_case_concern"
                  ? 0.4
                  : 0.1;
          const evidence = objection.evidenceBasis === "evidence_based" ? 1 : 0.7;
          const actionability = objection.mitigation?.trim() ? 1 : 0.5;
          return sum + severity * evidence * actionability;
        }, 0)
      );
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
      const proposalQuality =
        (reviewScore || proposal.confidence) * 0.45 +
        clamp01(proposal.confidence) * 0.2 +
        clamp01(evidenceSupport) * 0.15 +
        clamp01(1 - proposal.risks.length / 10) * 0.2;
      const normalized = clamp01(proposalQuality);
      proposalSupportScores[proposal.proposalId] = normalized;
      return normalized;
    });
    const disagreementClusters = buildDisagreementClusters(input.peerReviews, input.adversarialReviews);
    const compositeScore = average(qualityScores);
    const stagnationDelta = input.previous ? Math.abs(compositeScore - input.previous.compositeScore) : 1;
    return {
      runId: input.runId,
      roundIndex: input.roundIndex,
      dimensionScores: {
        rootCause: compositeScore,
        solutionDesign: compositeScore,
        riskAnalysis: clamp01(1 - disagreementClusters.length * 0.12),
        implementationScope: compositeScore,
        evidenceStrength: clamp01(
          average(input.proposals.map((proposal) => Math.min(1, proposal.evidence.length / 4))),
        ),
        confidenceStability: clamp01(1 - stagnationDelta),
        testPlanAlignment: clamp01(
          average(input.proposals.map((proposal) => Math.min(1, proposal.testPlan.length / 4))),
        ),
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
    const critical = input.adversarialReviews.flatMap((review) =>
      review.objections
        .filter((objection) => objection.classification === "critical_flaw")
        .map(() => review.proposalId),
    );
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
      const reviews = input.peerReviews.filter(
        (review) => review.blindedReviewerToken === blindedReviewerToken(modelRef),
      );
      const adversarialReviews = input.adversarialReviews.filter(
        (review) => review.blindedReviewerToken === blindedReviewerToken(modelRef),
      );
      const sampleCount = current.sampleCount + 1;
      const next: ModelReputation = {
        ...current,
        accuracy: averageInto(current.accuracy, average(proposals.map((proposal) => proposal.confidence)), sampleCount),
        reasoningStrength: averageInto(
          current.reasoningStrength,
          average(reviews.map((review) => review.scores.reasoningStrength)),
          sampleCount,
        ),
        critiqueQuality: averageInto(
          current.critiqueQuality,
          average(reviews.map((review) => weightedReviewScore(review))),
          sampleCount,
        ),
        consensusLeadership: averageInto(
          current.consensusLeadership,
          input.result.modelContributionSummary.some(
            (item) => item.modelRef === modelRef && item.contributionRole === "synthesis",
          )
            ? 1
            : 0.5,
          sampleCount,
        ),
        stability: averageInto(current.stability, clamp01(1 - (input.run.usage?.costUsd ?? 0)), sampleCount),
        adversarialUsefulness: averageInto(
          current.adversarialUsefulness,
          this.adversarialUsefulnessScore(adversarialReviews),
          sampleCount,
        ),
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
      adversarialUsefulness: averageInto(
        current.adversarialUsefulness,
        this.adversarialUsefulnessScore(reviews),
        current.sampleCount + 1,
      ),
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
    return clamp01(
      average(
        reviews.map((review) =>
          average(
            review.objections.map((objection) => {
              const severity =
                objection.classification === "critical_flaw"
                  ? 1
                  : objection.classification === "moderate_risk"
                    ? 0.7
                    : objection.classification === "edge_case_concern"
                      ? 0.4
                      : 0.1;
              const evidence = objection.evidenceBasis === "evidence_based" ? 1 : 0.7;
              const mitigation = objection.mitigation?.trim() ? 1 : 0.5;
              return severity * evidence * mitigation;
            }),
          ),
        ),
      ),
    );
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
      minorityReport:
        input.convergence.minorityFlags.length > 0
          ? {
              summary: "Minority objections remain unresolved.",
              proposalIds: input.convergence.minorityFlags,
              reasons: input.adversarialReviews
                .flatMap((review) => review.objections.map((objection) => objection.title))
                .slice(0, 4),
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
      (left, right) =>
        (input.convergence.proposalSupportScores[right.proposalId] ?? 0) -
        (input.convergence.proposalSupportScores[left.proposalId] ?? 0),
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
      const reviewCount = peerReviews.filter(
        (review) => review.blindedReviewerToken === blindedReviewerToken(modelRef),
      ).length;
      const adversaryCount = adversarialReviews.filter(
        (review) => review.blindedReviewerToken === blindedReviewerToken(modelRef),
      ).length;
      const contributionRole = adversaryCount > 0 ? "adversary" : reviewCount > 0 ? "review" : "proposal";
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
    assertUniqueAssemblyParticipantIds(_input.settings.participantModels);
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
    const objectives = normalizedPrompt
      .split(/[.?!]\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4);
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
      .filter(
        (artifact): artifact is AssemblyArtifactRecord & { payload: ModelProposal } =>
          artifact.artifactType === "proposal",
      )
      .map((artifact) => artifact.payload);
    const currentProposals =
      revisedProposals.length > 0
        ? revisedProposals
        : proposals.artifacts
            .filter(
              (artifact): artifact is AssemblyArtifactRecord & { payload: ModelProposal } =>
                artifact.artifactType === "proposal",
            )
            .map((artifact) => artifact.payload);
    const allArtifacts = stageArtifacts.flatMap((stage) => stage.artifacts);
    return {
      proposals: currentProposals,
      peerReviews: allArtifacts
        .filter(
          (artifact): artifact is AssemblyArtifactRecord & { payload: PeerReview } =>
            artifact.artifactType === "peer_review",
        )
        .map((artifact) => artifact.payload),
      adversarialReviews: allArtifacts
        .filter(
          (artifact): artifact is AssemblyArtifactRecord & { payload: AdversarialReview } =>
            artifact.artifactType === "adversarial_review",
        )
        .map((artifact) => artifact.payload),
      defenses: allArtifacts
        .filter(
          (artifact): artifact is AssemblyArtifactRecord & { payload: DefenseResponse } =>
            artifact.artifactType === "defense_response",
        )
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
      ...state.peerReviews.map((_review) => ({ latencyMs: undefined, costUsd: undefined })),
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
    if (
      scores.length >= run.settings.stagnationWindow &&
      this.convergenceScorer.detectStagnation(scores, run.settings.stagnationWindow) < 0.02
    ) {
      return { shouldStop: true, reason: "stagnated", details: "Convergence delta stayed below epsilon." };
    }
    const duplicateRate = calculateDuplicateObjectionRate(state.adversarialReviews);
    if (duplicateRate >= 0.65 && run.adversarialSettings.repetitiveObjectionCutoff) {
      return {
        shouldStop: true,
        reason: "repetitive_objections",
        details: "Objection fingerprint duplication exceeded cutoff.",
      };
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
    const shouldSplit =
      (topScore.length > 1 && Math.abs(topScore[0]!.score - topScore[1]!.score) <= 0.05) ||
      Boolean(state.convergence?.minorityFlags.length);
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
      convergence:
        state.convergence ??
        this.convergenceScorer.scoreRound({
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
    const artifacts = await Promise.all(
      run.settings.participantModels.map(async (participant, index) => {
        const fallback = fallbackProposal(run, roundIndex, participant, state.peerReviews);
        const invoked = await this.registry
          .invokeStructured({
            participant,
            problem: run.problem,
            stage,
            instructions: proposalInstructions(run, state.peerReviews, state.adversarialReviews, participant),
            schemaLabel: "ModelProposal",
            priorArtifacts: [],
            fallbackPayload: fallback,
            attribution: buildAssemblyParticipantAttribution({
              run,
              roundIndex,
              stage,
              participant,
              workItemKind: "proposal",
              workItemId: `proposal-${index + 1}`,
            }),
          })
          .catch((error: unknown) => {
            if (isAuthoritativeModelUsageAccountingError(error)) {
              throw error;
            }
            return {
              payload: fallback,
              usage: undefined,
              providerId: participant.providerId,
              modelId: participant.model,
              modelRef: participantModelRef(participant),
            };
          });
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
      }),
    );
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
    const artifacts = await Promise.all(
      assignments.map(async ({ proposal, reviewer }) => {
        const fallback = fallbackPeerReview(run.runId, roundIndex, proposal, reviewer);
        const invoked = await this.registry
          .invokeStructured({
            participant: reviewer,
            problem: run.problem,
            stage,
            instructions: peerReviewInstructions(proposal, state.peerReviews),
            schemaLabel: "PeerReview",
            priorArtifacts: proposalArtifacts,
            fallbackPayload: fallback,
            attribution: buildAssemblyParticipantAttribution({
              run,
              roundIndex,
              stage,
              participant: reviewer,
              workItemKind: "peer-review",
              workItemId: proposal.blindedAuthorToken,
            }),
          })
          .catch((error: unknown) => {
            if (isAuthoritativeModelUsageAccountingError(error)) {
              throw error;
            }
            return {
              payload: fallback,
              usage: undefined,
              providerId: reviewer.providerId,
              modelId: reviewer.model,
              modelRef: participantModelRef(reviewer),
            };
          });
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
      }),
    );
    return this.persistStage(run, roundIndex, stage, artifacts);
  }

  private async createAdversarialStage(
    run: AssemblyRunRecord,
    roundIndex: number,
    proposalArtifacts: AssemblyArtifactRecord[],
    _state: ExecutionState,
  ): Promise<StageArtifacts> {
    const proposals = proposalArtifacts.map((artifact) => artifact.payload as ModelProposal);
    const selected = this.adversarialEngine.selectAdversaries(
      run.settings.participantModels,
      run.adversarialSettings,
      this.storage.assembly.listReputations(100),
    );
    const artifacts = await Promise.all(
      proposals.flatMap((proposal, index) => {
        const reviewer = selected[index % selected.length];
        if (!reviewer) {
          return [];
        }
        const fallback = fallbackAdversarialReview(run.runId, roundIndex, proposal, reviewer);
        return [
          this.registry
            .invokeStructured({
              participant: reviewer,
              problem: run.problem,
              stage: "A3_adversarial_challenge",
              instructions: adversarialInstructions(proposal, run.adversarialSettings),
              schemaLabel: "AdversarialReview",
              priorArtifacts: proposalArtifacts,
              fallbackPayload: fallback,
              attribution: buildAssemblyParticipantAttribution({
                run,
                roundIndex,
                stage: "A3_adversarial_challenge",
                participant: reviewer,
                workItemKind: "adversarial-review",
                workItemId: proposal.blindedAuthorToken,
              }),
            })
            .then((invoked) =>
              buildArtifactRecord({
                runId: run.runId,
                roundIndex,
                stage: "A3_adversarial_challenge",
                artifactType: "adversarial_review",
                payload: mapAdversarialPayload(run.runId, roundIndex, proposal, reviewer, invoked.payload),
                participantModelRef: participantModelRef(reviewer),
                blindedAuthorToken: blindedReviewerToken(participantModelRef(reviewer)),
              }),
            )
            .catch((error: unknown) => {
              if (isAuthoritativeModelUsageAccountingError(error)) {
                throw error;
              }
              return buildArtifactRecord({
                runId: run.runId,
                roundIndex,
                stage: "A3_adversarial_challenge",
                artifactType: "adversarial_review",
                payload: mapAdversarialPayload(run.runId, roundIndex, proposal, reviewer, fallback),
                participantModelRef: participantModelRef(reviewer),
                blindedAuthorToken: blindedReviewerToken(participantModelRef(reviewer)),
              });
            }),
        ];
      }),
    );
    const dedupedReviews = this.adversarialEngine.dedupeObjections(
      artifacts.map((artifact) => artifact.payload as AdversarialReview),
    );
    return this.persistStage(
      run,
      roundIndex,
      "A3_adversarial_challenge",
      dedupedReviews.map((review) =>
        buildArtifactRecord({
          runId: run.runId,
          roundIndex,
          stage: "A3_adversarial_challenge",
          artifactType: "adversarial_review",
          payload: review,
          participantModelRef: undefined,
          blindedAuthorToken: review.blindedReviewerToken,
        }),
      ),
    );
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
      const revised = proposals.map((proposal) =>
        buildArtifactRecord({
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
        }),
      );
      return this.persistStage(run, roundIndex, stage, revised);
    }
    const adversarialReviews = adversarialArtifacts.map((artifact) => artifact.payload as AdversarialReview);
    const defenses = proposals.map((proposal) =>
      buildArtifactRecord({
        runId: run.runId,
        roundIndex,
        stage,
        artifactType: "defense_response",
        payload: buildDefenseResponse(run.runId, roundIndex, proposal, peerReviews, adversarialReviews),
        participantModelRef: proposal.authorModelRef,
        blindedAuthorToken: proposal.blindedAuthorToken,
      }),
    );
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
      .filter(
        (artifact): artifact is AssemblyArtifactRecord & { payload: ModelProposal } =>
          artifact.artifactType === "proposal",
      )
      .map((artifact) => artifact.payload);
    const convergence = this.convergenceScorer.scoreRound({
      runId: run.runId,
      roundIndex,
      proposals:
        revisedProposals.length > 0
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
      stopCheck: this.shouldStop(
        run,
        {
          proposals:
            revisedProposals.length > 0
              ? revisedProposals
              : proposalArtifacts.map((item) => item.payload as ModelProposal),
          peerReviews: reviewArtifacts.map((item) => item.payload as PeerReview),
          adversarialReviews: adversarialArtifacts.map((item) => item.payload as AdversarialReview),
          defenses: [],
          convergence,
        },
        previous ? [previous, convergence] : [convergence],
      ),
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
    let workSignal: AbortSignal | undefined;
    const task = (
      this.options.runBackgroundWork
        ? this.options.runBackgroundWork(`assembly-run:${run.runId}`, (signal) => {
            workSignal = signal;
            return this.executeRun(run.runId, signal);
          })
        : this.executeRun(run.runId)
    )
      .catch((error) => {
        if (workSignal?.aborted) {
          this.options.publishRealtime("assembly_run_parked", "assembly", {
            runId: run.runId,
            reason: "shared_host_drain",
          });
          return;
        }
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
    const run = this.options.storage.assembly.getRun(runId);
    const artifacts = this.options.storage.assembly.listArtifacts(runId);
    let projectedRun = run;
    if (run.runKind === "chat_model_council") {
      validateCouncilRounds(run, this.options.storage.assembly.listRounds(runId));
      projectedRun = projectCouncilRunWithReconstructedEvidence(this.options.storage, run, artifacts);
      if (run.status === "completed") {
        buildCompletedModelCouncilResult(this.options.storage, run);
      }
    }
    return {
      run: projectedRun,
      rounds: this.options.storage.assembly.listRounds(runId),
      artifacts:
        run.runKind === "chat_model_council"
          ? artifacts.map((artifact) => {
              if (
                artifact.artifactType !== "model_council_participant" &&
                artifact.artifactType !== "model_council_synthesis"
              ) {
                return artifact;
              }
              const payload = artifact.payload as ModelCouncilParticipantArtifact | ModelCouncilSynthesisArtifact;
              return { ...artifact, payload: payload.attempt };
            })
          : artifacts,
    };
  }

  /**
   * Execute or recover the one-chat-surface model council on the existing
   * Assembly owner. Participant calls are advisory/read-only and never receive
   * tool schemas. All resolution and context checks finish before dispatch.
   */
  public async executeChatModelCouncil(input: ExecuteChatModelCouncilInput): Promise<ModelCouncilExecutionResult> {
    return new ModelCouncilExecutor(this.options).execute(input);
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

  private async executeRun(runId: string, signal?: AbortSignal): Promise<void> {
    throwIfAssemblyRunAborted(signal, runId);
    let run = this.options.storage.assembly.updateRun(runId, {
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
      throwIfAssemblyRunAborted(signal, runId);
      run = this.options.storage.assembly.getRun(runId);
      const nextState = await this.orchestrator.runRound(run, roundIndex, state);
      throwIfAssemblyRunAborted(signal, runId);
      state.proposals = nextState.proposals;
      state.peerReviews = nextState.peerReviews;
      state.adversarialReviews = nextState.adversarialReviews;
      state.defenses = nextState.defenses;
      state.convergence = nextState.convergence;
      run = this.options.storage.assembly.getRun(runId);
      const convergenceHistory = this.options.storage.assembly
        .listArtifacts(runId, "convergence_score")
        .map((item) => item.payload)
        .filter(
          (item): item is ConvergenceScore => typeof item === "object" && item !== null && "compositeScore" in item,
        );
      const stopCheck = this.orchestrator.shouldStop(run, state, convergenceHistory);
      if (stopCheck.shouldStop) {
        this.options.storage.assembly.updateRun(runId, {
          stopReason: stopCheck.reason,
          updatedAt: new Date().toISOString(),
        });
        break;
      }
    }
    throwIfAssemblyRunAborted(signal, runId);
    await this.orchestrator.finalize(this.options.storage.assembly.getRun(runId), state);
  }
}

function throwIfAssemblyRunAborted(signal: AbortSignal | undefined, runId: string): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`Assembly run ${runId} was interrupted by shared-host drain.`);
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
    peerReviews.length > 0
      ? `Prior peer review signals: ${peerReviews.map((review) => review.verdict).join(", ")}`
      : "No prior peer review signals.",
    adversarialReviews.length > 0
      ? `Prior adversarial objections: ${adversarialReviews.flatMap((review) => review.objections.map((objection) => objection.title)).join("; ")}`
      : "No prior adversarial objections.",
    "Return JSON that matches ModelProposal.",
  ].join("\n");
}

function peerReviewInstructions(proposal: ModelProposal, priorReviews: PeerReview[]): string {
  return [
    `Review proposal ${proposal.proposalId}.`,
    `Abstract: ${proposal.abstract}`,
    `Diagnosis: ${proposal.diagnosis}`,
    `Solution: ${proposal.proposedSolution}`,
    priorReviews.length > 0
      ? `Existing verdicts: ${priorReviews.map((review) => review.verdict).join(", ")}`
      : "No existing verdicts.",
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
    input.priorArtifacts?.length
      ? `Prior artifacts available: ${input.priorArtifacts.length}`
      : "Prior artifacts available: 0",
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const sliced = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        return sliced && typeof sliced === "object" && !Array.isArray(sliced)
          ? (sliced as Record<string, unknown>)
          : undefined;
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
  return content
    .map((part) => {
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
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

function assertUniqueAssemblyParticipantIds(participants: AssemblyParticipantModel[]): void {
  const seen = new Set<string>();
  for (const participant of participants) {
    const participantId = participant.participantId.trim();
    if (!participantId) {
      throw new Error("Assembly participantId must be a non-blank stable worker identity.");
    }
    const identityKey = participantId.normalize("NFKC").toLowerCase();
    if (seen.has(identityKey)) {
      throw new Error(
        `Assembly participantId values must be unique after trimming and normalization: ${participantId}.`,
      );
    }
    seen.add(identityKey);
  }
}

class ModelCouncilExecutor {
  public constructor(private readonly options: AssemblyServiceOptions) {}

  public async execute(input: ExecuteChatModelCouncilInput): Promise<ModelCouncilExecutionResult> {
    assertPersistedRoutedContextSnapshot(this.options.storage, input);
    let run = this.options.storage.assembly.findCouncilRunByTurn(input.turnId);
    if (!run) {
      const resolution = buildModelCouncilResolution(input);
      run = this.createChatModelCouncilRun(input, resolution);
    } else {
      assertExistingModelCouncilResolution(run, input);
      validateCouncilRounds(run, this.options.storage.assembly.listRounds(run.runId));
      projectCouncilRunWithReconstructedEvidence(
        this.options.storage,
        run,
        this.options.storage.assembly.listArtifacts(run.runId),
      );
      if (run.status === "completed") {
        return buildCompletedModelCouncilResult(this.options.storage, run);
      }
      assertLegacyCouncilReasoningRecoverySafe(this.options.storage, run, input);
    }
    const leaseOwnerId = `model-council:${randomUUID()}`;
    const now = new Date().toISOString();
    const claimed = this.options.storage.assembly.claimCouncilRun({
      runId: run.runId,
      leaseOwnerId,
      now,
      leaseExpiresAt: new Date(Date.now() + MODEL_COUNCIL_LEASE_TTL_MS).toISOString(),
    });
    if (!claimed) {
      const current = this.options.storage.assembly.getRun(run.runId);
      if (current.status === "completed") {
        return buildCompletedModelCouncilResult(this.options.storage, current);
      }
      throw new Error(`Model council ${run.runId} is owned by another unexpired Assembly lease.`);
    }
    try {
      return await this.resumeChatModelCouncil(claimed, input, leaseOwnerId);
    } catch (error) {
      this.failChatModelCouncil(claimed.runId, leaseOwnerId, error);
      throw error;
    }
  }

  private createChatModelCouncilRun(
    input: ExecuteChatModelCouncilInput,
    resolution: ModelCouncilResolution,
  ): AssemblyRunRecord {
    const runId = randomUUID();
    const now = new Date().toISOString();
    const participants = resolution.participants.map((participant) => ({
      participantId: participant.participantId,
      providerId: participant.providerId,
      model: participant.model,
      label: participant.role,
    }));
    const synthesisParticipant = resolution.participants.find(
      (participant) => participant.participantId === resolution.synthesisParticipantId,
    );
    if (!synthesisParticipant) {
      throw new Error(`Model council ${runId} has no immutable synthesis participant.`);
    }
    return this.options.storage.assembly.createRun({
      runId,
      runKind: "chat_model_council",
      sourceTurnId: input.turnId,
      workspaceId: input.workspaceId,
      sourceSessionId: input.sessionId,
      sourceTaskId: `chat-model-council:${input.turnId}`,
      title: titleFromPrompt(input.content),
      status: "queued",
      currentStage: "C0_resolve",
      currentRoundIndex: 0,
      problem: {
        runId,
        domain: "analysis",
        title: titleFromPrompt(input.content),
        originalPrompt: input.content,
        normalizedStatement: input.content.trim().replace(/\s+/g, " "),
        objectives: [input.content.trim()],
        constraints: ["advisory participants", "read-only", "no tools", "one canonical Chat answer"],
        evaluationCriteria: ["correctness", "dissent coverage", "minority preservation"],
        contextRefs: [],
        createdAt: now,
      },
      settings: {
        mode: "consensus",
        participantModels: participants,
        maxRounds: 1,
        maxCritiquePasses: 0,
        maxInterModelExchanges: 0,
        convergenceThreshold: 1,
        stagnationWindow: 1,
        timeBudgetMs: 120_000,
        tokenBudget:
          participants.length * MODEL_COUNCIL_PARTICIPANT_MAX_TOKENS +
          buildModelCouncilSynthesisThinkingOptions(
            synthesisParticipant.providerId,
            synthesisParticipant.apiStyle,
            synthesisParticipant.model,
            input.capabilityProfile.selection.thinkingLevel,
          ).max_tokens!,
        costBudgetUsd: 0,
        domainPreset: "analysis",
        synthesisStyle: "balanced",
        exportTargets: [],
      },
      adversarialSettings: withDefaultAdversarialSettings({
        enabled: false,
        reviewerCount: 0,
        selectionStrategy: "user_selected",
        strictness: "balanced",
        requireMitigations: false,
        requireEvidenceTags: false,
        defenseRoundEnabled: false,
        repetitiveObjectionCutoff: true,
        minorityReportRequired: true,
      }),
      councilResolution: resolution,
      generation: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async resumeChatModelCouncil(
    initialRun: AssemblyRunRecord,
    input: ExecuteChatModelCouncilInput,
    leaseOwnerId: string,
  ): Promise<ModelCouncilExecutionResult> {
    let run = initialRun;
    while (run.status !== "completed") {
      assertCouncilLease(run, leaseOwnerId);
      switch (run.currentStage) {
        case "C0_resolve": {
          this.saveCouncilRound(run, leaseOwnerId, "C0_resolve", 0, []);
          run = this.advanceCouncilStage(run, leaseOwnerId, "C1_participate", 1);
          break;
        }
        case "C1_participate": {
          const completed = await this.executeCouncilParticipantStage(run, input, leaseOwnerId);
          run = completed.run;
          this.saveCouncilRound(
            run,
            leaseOwnerId,
            "C1_participate",
            1,
            completed.artifacts.map((artifact) => artifact.artifactId),
          );
          run = this.advanceCouncilStage(run, leaseOwnerId, "C2_assemble", 2, {
            councilEvidence: completed.evidence,
          });
          break;
        }
        case "C2_assemble": {
          const participantArtifacts = getCouncilParticipantArtifacts(this.options.storage, run);
          const resolution = requireModelCouncilResolution(run);
          if (participantArtifacts.length !== resolution.participants.length) {
            throw new Error(`Model council ${run.runId} cannot assemble an incomplete participant set.`);
          }
          const attempts = reconstructCouncilAttempts(this.options.storage, run, participantArtifacts);
          const evidence = buildModelCouncilEvidence(run, participantArtifacts, attempts);
          this.saveCouncilRound(
            run,
            leaseOwnerId,
            "C2_assemble",
            2,
            participantArtifacts.map((artifact) => artifact.artifactId),
          );
          run = this.advanceCouncilStage(run, leaseOwnerId, "C3_synthesize", 3, { councilEvidence: evidence });
          break;
        }
        case "C3_synthesize": {
          const completed = await this.executeCouncilSynthesisStage(run, input, leaseOwnerId);
          return buildCompletedModelCouncilResult(this.options.storage, completed);
        }
        default:
          throw new Error(`Model council ${run.runId} cannot recover from Assembly stage ${run.currentStage}.`);
      }
    }
    return buildCompletedModelCouncilResult(this.options.storage, run);
  }

  private async executeCouncilParticipantStage(
    run: AssemblyRunRecord,
    input: ExecuteChatModelCouncilInput,
    leaseOwnerId: string,
  ): Promise<{
    run: AssemblyRunRecord;
    artifacts: AssemblyArtifactRecord[];
    evidence: ModelCouncilEvidence;
  }> {
    const resolution = requireModelCouncilResolution(run);
    let ownedRun = run;
    const byParticipant = new Map(
      getCouncilParticipantArtifacts(this.options.storage, run).map((artifact) => [
        (artifact.payload as ModelCouncilParticipantArtifact).attempt.participantId,
        artifact,
      ]),
    );
    const attempts = reconstructCouncilAttempts(this.options.storage, run, [...byParticipant.values()]);
    for (const participant of resolution.participants) {
      if (byParticipant.has(participant.participantId)) {
        continue;
      }
      assertPriorCouncilAttemptsRetrySafe(
        this.options.storage,
        run,
        "C1_participate",
        participant.participantId,
        attempts,
      );
      const attemptId = buildNextCouncilAttemptId(run, "C1_participate", participant.participantId, attempts);
      let observedResponse: ChatCompletionResponse | undefined;
      let providerInvocationStarted = false;
      try {
        const request: ChatCompletionRequest = {
          providerId: participant.providerId,
          model: participant.model,
          messages: [
            ...input.history,
            {
              role: "system",
              content: MODEL_COUNCIL_PARTICIPANT_INSTRUCTION,
            },
          ],
          temperature: 0.2,
          max_tokens: MODEL_COUNCIL_PARTICIPANT_MAX_TOKENS,
          timeoutMs: 45_000,
          signal: input.signal,
          metadata: { surface: "chat", runtime: "assembly_model_council", stage: "C1_participate" },
        };
        const completedCall = await this.callWithCouncilLeaseHeartbeat(ownedRun, leaseOwnerId, () => {
          providerInvocationStarted = true;
          return this.options.createChatCompletion(
            request,
            buildModelCouncilAttribution(run, participant, "C1_participate", attemptId),
          );
        });
        ownedRun = completedCall.run;
        const response = completedCall.value;
        observedResponse = response;
        assertResolvedCouncilRoute(participant, response);
        const responseText = extractCompletionText(response).trim();
        if (!responseText) {
          throw new Error(`Model council participant ${participant.participantId} returned empty output.`);
        }
        const attempt = reconcileCouncilAttemptWithHx306(
          this.options.storage,
          run,
          participant,
          buildCompletedCouncilAttempt(attemptId, participant, "C1_participate", responseText, response),
        );
        const artifact: AssemblyArtifactRecord = {
          artifactId: councilAttemptBaseId(run, "C1_participate", participant.participantId),
          runId: run.runId,
          roundIndex: 1,
          stage: "C1_participate",
          artifactType: "model_council_participant",
          participantModelRef: `${participant.providerId}:${participant.model}`,
          blindedAuthorToken: `council:${digest(participant.participantId).slice(0, 16)}`,
          payload: { attempt, responseText } satisfies ModelCouncilParticipantArtifact,
          createdAt: new Date().toISOString(),
        };
        assertCouncilLease(ownedRun, leaseOwnerId);
        this.options.storage.assembly.saveCouncilArtifactsExact([artifact]);
        byParticipant.set(participant.participantId, artifact);
        upsertCouncilAttempt(attempts, attempt);
      } catch (error) {
        const failedAttemptDraft = buildFailedCouncilAttempt(
          attemptId,
          participant,
          "C1_participate",
          error,
          observedResponse,
        );
        const failedAttempt = providerInvocationStarted
          ? reconcileCouncilAttemptWithHx306(this.options.storage, run, participant, failedAttemptDraft)
          : failedAttemptDraft;
        upsertCouncilAttempt(attempts, failedAttempt);
        this.persistFailedCouncilAttempt(run.runId, leaseOwnerId, failedAttempt);
        throw error;
      }
    }
    const artifacts = resolution.participants.map((participant) => byParticipant.get(participant.participantId)!);
    return { run: ownedRun, artifacts, evidence: buildModelCouncilEvidence(ownedRun, artifacts, attempts) };
  }

  private async executeCouncilSynthesisStage(
    run: AssemblyRunRecord,
    input: ExecuteChatModelCouncilInput,
    leaseOwnerId: string,
  ): Promise<AssemblyRunRecord> {
    const resolution = requireModelCouncilResolution(run);
    let ownedRun = run;
    const synthesisParticipant = resolution.participants.find(
      (participant) => participant.participantId === resolution.synthesisParticipantId,
    );
    if (!synthesisParticipant) {
      throw new Error(`Model council ${run.runId} lost its immutable synthesis participant.`);
    }
    const participantArtifacts = getCouncilParticipantArtifacts(this.options.storage, run);
    if (participantArtifacts.length !== resolution.participants.length) {
      throw new Error(`Model council ${run.runId} cannot synthesize an incomplete participant set.`);
    }
    const existing = getCouncilSynthesisArtifact(this.options.storage, run);
    let synthesisArtifact = existing;
    if (!synthesisArtifact) {
      const priorAttempts = reconstructCouncilAttempts(this.options.storage, ownedRun, participantArtifacts);
      assertPriorCouncilAttemptsRetrySafe(
        this.options.storage,
        run,
        "C3_synthesize",
        synthesisParticipant.participantId,
        priorAttempts,
      );
      const attemptId = buildNextCouncilAttemptId(
        run,
        "C3_synthesize",
        synthesisParticipant.participantId,
        priorAttempts,
      );
      let observedResponse: ChatCompletionResponse | undefined;
      let providerInvocationStarted = false;
      const synthesisThinkingOptions = buildModelCouncilSynthesisThinkingOptions(
        synthesisParticipant.providerId,
        resolveCouncilExecutionApiStyle(synthesisParticipant, input),
        synthesisParticipant.model,
        input.capabilityProfile.selection.thinkingLevel,
      );
      const request: ChatCompletionRequest = {
        providerId: synthesisParticipant.providerId,
        model: synthesisParticipant.model,
        messages: [
          ...input.history,
          {
            role: "system",
            content: MODEL_COUNCIL_SYNTHESIS_INSTRUCTION,
          },
          {
            role: "user",
            content: participantArtifacts
              .map((artifact, index) => {
                const payload = artifact.payload as ModelCouncilParticipantArtifact;
                return `Advisory response ${index + 1}:\n${payload.responseText}`;
              })
              .join("\n\n"),
          },
        ],
        ...synthesisThinkingOptions,
        // The synthesizer is the acting model for the council turn, so it
        // inherits the exact thinking posture frozen into the turn profile.
        // C1 participants intentionally do not inherit this value: applying a
        // global deep/max setting to every advisory call would silently
        // multiply cost and diverge from the operator's single acting-model
        // choice.
        timeoutMs: 60_000,
        signal: input.signal,
        metadata: { surface: "chat", runtime: "assembly_model_council", stage: "C3_synthesize" },
      };
      try {
        const completedCall = await this.callWithCouncilLeaseHeartbeat(ownedRun, leaseOwnerId, () => {
          providerInvocationStarted = true;
          return this.options.createChatCompletion(
            request,
            buildModelCouncilAttribution(run, synthesisParticipant, "C3_synthesize", attemptId),
          );
        });
        ownedRun = completedCall.run;
        const response = completedCall.value;
        observedResponse = response;
        assertResolvedCouncilRoute(synthesisParticipant, response);
        const answer = extractCompletionText(response).trim();
        if (!answer) {
          throw new Error(`Model council ${run.runId} synthesis returned empty output.`);
        }
        const attempt = reconcileCouncilAttemptWithHx306(
          this.options.storage,
          run,
          synthesisParticipant,
          buildCompletedCouncilAttempt(attemptId, synthesisParticipant, "C3_synthesize", answer, response),
        );
        synthesisArtifact = {
          artifactId: councilAttemptBaseId(run, "C3_synthesize", synthesisParticipant.participantId),
          runId: run.runId,
          roundIndex: 3,
          stage: "C3_synthesize",
          artifactType: "model_council_synthesis",
          participantModelRef: `${synthesisParticipant.providerId}:${synthesisParticipant.model}`,
          payload: { attempt, answer } satisfies ModelCouncilSynthesisArtifact,
          createdAt: new Date().toISOString(),
        };
        assertCouncilLease(ownedRun, leaseOwnerId);
        this.options.storage.assembly.saveCouncilArtifactsExact([synthesisArtifact]);
      } catch (error) {
        const failedAttemptDraft = buildFailedCouncilAttempt(
          attemptId,
          synthesisParticipant,
          "C3_synthesize",
          error,
          observedResponse,
        );
        const failedAttempt = providerInvocationStarted
          ? reconcileCouncilAttemptWithHx306(this.options.storage, run, synthesisParticipant, failedAttemptDraft)
          : failedAttemptDraft;
        this.persistFailedCouncilAttempt(run.runId, leaseOwnerId, failedAttempt);
        throw error;
      }
    }
    const synthesisPayload = synthesisArtifact.payload as ModelCouncilSynthesisArtifact;
    const attempts = reconstructCouncilAttempts(
      this.options.storage,
      ownedRun,
      participantArtifacts,
      synthesisArtifact,
    );
    const evidence = {
      ...buildModelCouncilEvidence(ownedRun, participantArtifacts, attempts),
      canonicalAnswerHash: digest(synthesisPayload.answer),
      updatedAt: new Date().toISOString(),
    } satisfies ModelCouncilEvidence;
    const usage = sumCouncilUsage(evidence.attempts);
    const result: AssemblyResult = {
      runId: run.runId,
      recommendation: synthesisPayload.answer,
      disagreements: [],
      riskAnalysis: [],
      implementationPlan: [],
      ...(evidence.minorityCount > 0
        ? {
            minorityReport: {
              summary: `${evidence.minorityCount} content-free minority fingerprint(s) retained in council evidence.`,
              proposalIds: evidence.minorityFingerprints,
              reasons: ["Participant response fingerprint did not recur in the council."],
            },
          }
        : {}),
      modelContributionSummary: resolution.participants.map((participant) => ({
        modelRef: `${participant.providerId}:${participant.model}`,
        contributionRole: participant.participantId === resolution.synthesisParticipantId ? "synthesis" : "proposal",
        summary: participant.role === "primary" ? "primary governed participant" : "read-only advisory participant",
      })),
      exports: [],
      finalUsage: usage,
      createdAt: new Date().toISOString(),
    };
    this.saveCouncilRound(ownedRun, leaseOwnerId, "C3_synthesize", 3, [synthesisArtifact.artifactId]);
    return this.advanceCouncilStage(ownedRun, leaseOwnerId, "completed", 3, {
      status: "completed",
      result,
      usage,
      councilEvidence: evidence,
      finishedAt: new Date().toISOString(),
    });
  }

  private saveCouncilRound(
    run: AssemblyRunRecord,
    leaseOwnerId: string,
    stage: AssemblyStage,
    roundIndex: number,
    artifactIds: string[],
  ) {
    assertCouncilLease(run, leaseOwnerId);
    const participantIds = requireModelCouncilResolution(run).participants.map(
      (participant) => participant.participantId,
    );
    const roundId = `${run.runId}:council:${stage}`;
    const existing = this.options.storage.assembly
      .listRounds(run.runId)
      .find((candidate) => candidate.roundId === roundId);
    if (existing) {
      validateCouncilRound(run, existing, stage, roundIndex, participantIds, artifactIds);
      this.options.storage.assembly.saveCouncilRoundExact(existing);
      return;
    }
    const now = new Date().toISOString();
    this.options.storage.assembly.saveCouncilRoundExact({
      roundId,
      runId: run.runId,
      roundIndex,
      stage,
      status: "completed",
      participantIds,
      artifactIds,
      startedAt: now,
      finishedAt: now,
    });
  }

  private renewCouncilLease(run: AssemblyRunRecord, leaseOwnerId: string): AssemblyRunRecord {
    assertCouncilLease(run, leaseOwnerId);
    const now = new Date().toISOString();
    const renewed = this.options.storage.assembly.renewCouncilRunLease({
      runId: run.runId,
      expectedGeneration: run.generation ?? 0,
      expectedStage: run.currentStage,
      leaseOwnerId,
      now,
      leaseExpiresAt: new Date(Date.now() + MODEL_COUNCIL_LEASE_TTL_MS).toISOString(),
    });
    if (!renewed) {
      throw new Error(`Model council ${run.runId} lost its Assembly lease heartbeat at ${run.currentStage}.`);
    }
    return renewed;
  }

  private async callWithCouncilLeaseHeartbeat<T>(
    run: AssemblyRunRecord,
    leaseOwnerId: string,
    invoke: () => Promise<T>,
  ): Promise<{ run: AssemblyRunRecord; value: T }> {
    let ownedRun = this.renewCouncilLease(run, leaseOwnerId);
    let heartbeatError: unknown;
    const timer = setInterval(() => {
      if (heartbeatError) {
        return;
      }
      try {
        ownedRun = this.renewCouncilLease(ownedRun, leaseOwnerId);
      } catch (error) {
        heartbeatError = error;
      }
    }, MODEL_COUNCIL_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    try {
      const value = await invoke();
      if (heartbeatError) {
        throw heartbeatError;
      }
      // This post-call CAS is the ownership assertion immediately before any
      // immutable artifact or round write.
      ownedRun = this.renewCouncilLease(ownedRun, leaseOwnerId);
      return { run: ownedRun, value };
    } finally {
      clearInterval(timer);
    }
  }

  private persistFailedCouncilAttempt(
    runId: string,
    leaseOwnerId: string,
    failedAttempt: ModelCouncilAttemptEvidence,
  ): void {
    const current = this.options.storage.assembly.getRun(runId);
    if (current.leaseOwnerId !== leaseOwnerId || current.status !== "running") {
      return;
    }
    assertCouncilLease(current, leaseOwnerId);
    const participantArtifacts = getCouncilParticipantArtifacts(this.options.storage, current);
    const synthesisArtifact = getCouncilSynthesisArtifact(this.options.storage, current);
    const attempts = reconstructCouncilAttempts(this.options.storage, current, participantArtifacts, synthesisArtifact);
    upsertCouncilAttempt(attempts, failedAttempt);
    const evidence = buildModelCouncilEvidence(current, participantArtifacts, attempts);
    if (synthesisArtifact) {
      evidence.canonicalAnswerHash = digest((synthesisArtifact.payload as ModelCouncilSynthesisArtifact).answer);
    }
    this.advanceCouncilStage(current, leaseOwnerId, current.currentStage, current.currentRoundIndex, {
      councilEvidence: evidence,
    });
  }

  private advanceCouncilStage(
    run: AssemblyRunRecord,
    leaseOwnerId: string,
    nextStage: AssemblyStage,
    currentRoundIndex: number,
    patch: {
      status?: AssemblyRunRecord["status"];
      result?: AssemblyResult;
      usage?: AssemblyUsageSummary;
      error?: string;
      councilEvidence?: ModelCouncilEvidence;
      finishedAt?: string;
    } = {},
  ): AssemblyRunRecord {
    const updatedAt = new Date().toISOString();
    const advanced = this.options.storage.assembly.advanceCouncilRun({
      runId: run.runId,
      expectedGeneration: run.generation ?? 0,
      expectedStage: run.currentStage,
      nextStage,
      leaseOwnerId,
      leaseExpiresAt: new Date(Date.now() + MODEL_COUNCIL_LEASE_TTL_MS).toISOString(),
      currentRoundIndex,
      status: patch.status ?? "running",
      result: patch.result,
      usage: patch.usage,
      error: patch.error,
      councilEvidence: patch.councilEvidence ?? run.councilEvidence,
      finishedAt: patch.finishedAt,
      updatedAt,
    });
    if (!advanced) {
      throw new Error(`Model council ${run.runId} lost its Assembly generation/lease CAS at ${run.currentStage}.`);
    }
    return advanced;
  }

  private failChatModelCouncil(runId: string, leaseOwnerId: string, error: unknown): void {
    const run = this.options.storage.assembly.getRun(runId);
    if (run.status === "completed" || run.leaseOwnerId !== leaseOwnerId) {
      return;
    }
    const updatedAt = new Date().toISOString();
    this.options.storage.assembly.advanceCouncilRun({
      runId,
      expectedGeneration: run.generation ?? 0,
      expectedStage: run.currentStage,
      nextStage: run.currentStage,
      leaseOwnerId,
      currentRoundIndex: run.currentRoundIndex,
      status: "failed",
      error: normalizeErrorMessage(error),
      councilEvidence: run.councilEvidence,
      finishedAt: updatedAt,
      updatedAt,
    });
  }
}

export function buildModelCouncilSynthesisThinkingOptions(
  providerId: string | undefined,
  apiStyle: LlmApiStyle | undefined,
  model: string | undefined,
  thinkingLevel: ChatTurnCapabilityProfileRecord["selection"]["thinkingLevel"] | undefined,
): Pick<ChatCompletionRequest, "max_tokens" | "reasoning" | "temperature"> {
  const effort = resolveChatReasoningEffort(thinkingLevel ?? "standard");
  const isAnthropic =
    apiStyle === "anthropic-messages" ||
    providerId?.trim().toLowerCase() === "anthropic" ||
    providerId?.trim().toLowerCase() === "claude-code";
  if (isAnthropic && !model?.trim()) {
    throw new TypeError("Anthropic council synthesis requires a resolved model before reasoning can be budgeted.");
  }
  if (isAnthropic) {
    resolveAnthropicEffort({ effort, model: model! });
  }
  return {
    // Reasoning-capable provider families can reject sampling controls
    // whenever reasoning is enabled. Keep the low deterministic sampling
    // posture only when the operator explicitly disables reasoning; for every
    // enabled effort, let the canonical LLM owner apply provider defaults and
    // compatibility validation.
    ...(effort === "none" && !isAnthropic ? { temperature: 0.1 } : {}),
    // Anthropic adaptive thinking has no wire-level budget_tokens field, but
    // max_tokens still caps thinking plus the visible answer. Preserve the
    // governed local effort allowance for both manual and adaptive modes so
    // the canonical answer cannot be squeezed to zero by hidden reasoning.
    max_tokens:
      isAnthropic && effort !== "none"
        ? resolveAnthropicMaxTokensForVisibleOutput({
            effort,
            visibleOutputTokenBudget: MODEL_COUNCIL_SYNTHESIS_MAX_TOKENS,
          })
        : MODEL_COUNCIL_SYNTHESIS_MAX_TOKENS,
    reasoning: { effort },
  };
}

function buildModelCouncilResolution(input: ExecuteChatModelCouncilInput): ModelCouncilResolution {
  assertModelCouncilInputScope(input);
  const profile = input.capabilityProfile;
  const primaryProviderId = profile.selection.effectiveProviderId;
  const primaryModel = profile.selection.effectiveModel;
  if (!primaryProviderId || !primaryModel) {
    throw new Error("Model council requires a frozen provider/model in the governed capability profile.");
  }
  const uniqueCandidates = dedupeCouncilCandidates(input.providerCandidates);
  const primary = uniqueCandidates.find(
    (candidate) => candidate.providerId === primaryProviderId && candidate.model === primaryModel,
  );
  if (!primary) {
    throw new Error("Model council primary route is not ready with trusted context-window metadata.");
  }
  const selected = [
    primary,
    ...uniqueCandidates.filter(
      (candidate) => candidate.providerId !== primary.providerId || candidate.model !== primary.model,
    ),
  ].slice(0, MODEL_COUNCIL_MAX_PARTICIPANTS);
  if (selected.length < 2) {
    throw new Error("Model council requires at least two ready, governed participant routes.");
  }
  const historyHash = digest(canonicalJsonString(input.history));
  const participants: ModelCouncilParticipantResolution[] = selected.map((candidate, index) => ({
    participantId: index === 0 ? "primary" : `advisory-${index}`,
    role: index === 0 ? "primary" : "advisory",
    providerId: candidate.providerId,
    model: candidate.model,
    ...(candidate.apiStyle ? { apiStyle: candidate.apiStyle } : {}),
    contextWindowTokens: candidate.contextWindowTokens,
    routeConfigFingerprint: candidate.routeConfigFingerprint,
    routeFingerprint: digest({
      providerId: candidate.providerId,
      model: candidate.model,
      contextWindowTokens: candidate.contextWindowTokens,
      ...(candidate.apiStyle ? { apiStyle: candidate.apiStyle } : {}),
      routeConfigFingerprint: candidate.routeConfigFingerprint,
      capabilityProfileHash: profile.hashes.profileHash,
    }),
    advisoryOnly: true,
    toolsAllowed: false,
  }));
  for (const participant of participants) {
    assertCouncilRequestBudgets(participant, input, participants.length, participants[0]!);
  }
  const draft = {
    schemaVersion: "assembly.model-council-resolution.v1" as const,
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    capabilityProfileId: profile.profileId,
    capabilityProfileHash: profile.hashes.profileHash,
    historyHash,
    participants,
    synthesisParticipantId: participants[0]!.participantId,
    ...(input.routedContextSnapshot
      ? { routedContext: buildCouncilRoutedContextBinding(input.routedContextSnapshot) }
      : {}),
    createdAt: new Date().toISOString(),
  };
  return { ...draft, resolutionHash: digest(draft) };
}

function assertExistingModelCouncilResolution(run: AssemblyRunRecord, input: ExecuteChatModelCouncilInput): void {
  assertModelCouncilInputScope(input);
  const resolution = requireModelCouncilResolution(run);
  if (
    resolution.turnId !== input.turnId ||
    resolution.sessionId !== input.sessionId ||
    resolution.workspaceId !== input.workspaceId ||
    resolution.capabilityProfileId !== input.capabilityProfile.profileId ||
    resolution.capabilityProfileHash !== input.capabilityProfile.hashes.profileHash ||
    resolution.historyHash !== digest(canonicalJsonString(input.history))
  ) {
    throw new Error(`Model council ${run.runId} recovery input conflicts with its immutable resolution.`);
  }
  const currentBinding = input.routedContextSnapshot
    ? buildCouncilRoutedContextBinding(input.routedContextSnapshot)
    : undefined;
  if (canonicalJsonString(resolution.routedContext ?? null) !== canonicalJsonString(currentBinding ?? null)) {
    throw new Error(`Model council ${run.runId} recovery attempted to change its routed-context snapshot.`);
  }
  const readyRoutes = new Map(
    dedupeCouncilCandidates(input.providerCandidates).map((candidate) => [
      `${candidate.providerId}\u0000${candidate.model}`,
      candidate,
    ]),
  );
  const synthesisParticipant = resolution.participants.find(
    (participant) => participant.participantId === resolution.synthesisParticipantId,
  );
  if (!synthesisParticipant) {
    throw new Error(`Model council ${run.runId} lost its immutable synthesis participant.`);
  }
  for (const participant of resolution.participants) {
    const current = readyRoutes.get(`${participant.providerId}\u0000${participant.model}`);
    if (
      !current ||
      current.contextWindowTokens !== participant.contextWindowTokens ||
      (participant.apiStyle !== undefined && current.apiStyle !== participant.apiStyle) ||
      current.routeConfigFingerprint !== participant.routeConfigFingerprint
    ) {
      throw new Error(
        `Model council ${run.runId} participant ${participant.participantId} is no longer ready under its frozen route.`,
      );
    }
    assertCouncilRequestBudgets(participant, input, resolution.participants.length, synthesisParticipant);
  }
}

function assertModelCouncilInputScope(input: ExecuteChatModelCouncilInput): void {
  const profile = input.capabilityProfile;
  if (
    profile.identity.turnId !== input.turnId ||
    profile.identity.sessionId !== input.sessionId ||
    profile.identity.workspaceId !== input.workspaceId
  ) {
    throw new Error("Model council capability profile does not match the current Chat turn scope.");
  }
  const providerId = profile.selection.effectiveProviderId;
  const primaryReadiness = profile.governance.authReadiness.find(
    (item) => item.kind === "provider" && item.ref === providerId,
  );
  if (!providerId || primaryReadiness?.status !== "ready") {
    throw new Error("Model council primary provider is not ready in the governed capability profile.");
  }
  if (input.history.length === 0) {
    throw new Error("Model council requires the prepared Chat history.");
  }
  if (input.routedContextSnapshot) {
    const snapshot = input.routedContextSnapshot;
    if (
      snapshot.turnId !== input.turnId ||
      snapshot.sessionId !== input.sessionId ||
      snapshot.workspaceId !== input.workspaceId ||
      snapshot.capabilityProfileId !== profile.profileId ||
      snapshot.capabilityProfileHash !== profile.hashes.profileHash
    ) {
      throw new Error("Model council routed-context snapshot does not match the frozen capability profile.");
    }
    if (!snapshot.contextText) {
      throw new Error("Model council requires non-empty admitted routed-context bytes.");
    }
    const exactContextCount = input.history.filter(
      (message) => typeof message.content === "string" && message.content === snapshot.contextText,
    ).length;
    const anyContextOccurrenceCount = input.history.filter(
      (message) => typeof message.content === "string" && message.content.includes(snapshot.contextText),
    ).length;
    if (exactContextCount !== 1 || anyContextOccurrenceCount !== 1) {
      throw new Error(
        "Model council requires strict equality for the admitted routed-context bytes and rejects every other occurrence.",
      );
    }
  }
}

function assertPersistedRoutedContextSnapshot(storage: Storage, input: ExecuteChatModelCouncilInput): void {
  if (!input.routedContextSnapshot) {
    return;
  }
  const persisted = storage.routedContextSnapshots.get(input.routedContextSnapshot.snapshotId);
  if (canonicalJsonString(persisted) !== canonicalJsonString(input.routedContextSnapshot)) {
    throw new Error("Model council routed-context snapshot differs from immutable HX-307 storage truth.");
  }
}

function buildCouncilRoutedContextBinding(snapshot: ChatRoutedContextSnapshotRecord) {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    contextTextHash: digest(snapshot.contextText),
    contextBytes: Buffer.byteLength(snapshot.contextText, "utf8"),
    usedTokens: snapshot.budget.usedTokens,
    promptReservedTokens: snapshot.budget.promptReservedTokens,
    outputReservedTokens: snapshot.budget.outputReservedTokens,
    estimatorVersion: snapshot.budget.estimatorVersion,
    budgetPolicyVersion: snapshot.budget.budgetPolicyVersion,
  };
}

function assertCouncilRequestBudgets(
  participant: Pick<ModelCouncilParticipantResolution, "participantId" | "model" | "contextWindowTokens">,
  input: ExecuteChatModelCouncilInput,
  participantCount: number,
  synthesisParticipant: Pick<ModelCouncilParticipantResolution, "providerId" | "apiStyle" | "model">,
): void {
  const model = participant.model;
  const participantPromptTokens = estimateCouncilMessagesTokens(
    [...input.history, { role: "system", content: MODEL_COUNCIL_PARTICIPANT_INSTRUCTION }],
    model,
  );
  const synthesisWrapper = Array.from(
    { length: participantCount },
    (_, index) => `Advisory response ${index + 1}:\n`,
  ).join("\n\n");
  const synthesisBasePromptTokens = estimateCouncilMessagesTokens(
    [
      ...input.history,
      { role: "system", content: MODEL_COUNCIL_SYNTHESIS_INSTRUCTION },
      { role: "user", content: synthesisWrapper },
    ],
    model,
  );
  const snapshotPromptFloor = input.routedContextSnapshot
    ? input.routedContextSnapshot.budget.usedTokens + input.routedContextSnapshot.budget.promptReservedTokens
    : 0;
  const participantRequiredTokens =
    Math.max(participantPromptTokens, snapshotPromptFloor) + MODEL_COUNCIL_PARTICIPANT_MAX_TOKENS;
  const synthesisRequiredTokens =
    Math.max(synthesisBasePromptTokens, snapshotPromptFloor) +
    participantCount * MODEL_COUNCIL_PARTICIPANT_MAX_TOKENS +
    buildModelCouncilSynthesisThinkingOptions(
      synthesisParticipant.providerId,
      synthesisParticipant.apiStyle,
      synthesisParticipant.model,
      input.capabilityProfile.selection.thinkingLevel,
    ).max_tokens!;
  const requiredTokens = Math.max(participantRequiredTokens, synthesisRequiredTokens);
  if (participant.contextWindowTokens < requiredTokens) {
    throw new Error(
      `Model council participant ${participant.participantId} cannot reuse the exact prepared context under ` +
        `the worst-case C1/C3 budget (${requiredTokens} required, ${participant.contextWindowTokens} available).`,
    );
  }
}

function estimateCouncilMessagesTokens(messages: ChatCompletionRequest["messages"], model?: string): number {
  return estimateTokensFromText(canonicalJsonString(messages), { model });
}

function dedupeCouncilCandidates(candidates: ModelCouncilProviderCandidate[]): ModelCouncilProviderCandidate[] {
  const seen = new Set<string>();
  const output: ModelCouncilProviderCandidate[] = [];
  for (const candidate of candidates) {
    if (
      !candidate.providerId.trim() ||
      candidate.providerId !== candidate.providerId.trim() ||
      containsAsciiControlCharacter(candidate.providerId) ||
      !candidate.model.trim() ||
      candidate.model !== candidate.model.trim() ||
      containsAsciiControlCharacter(candidate.model) ||
      candidate.apiStyle === undefined ||
      !MODEL_COUNCIL_API_STYLES.has(candidate.apiStyle) ||
      !Number.isSafeInteger(candidate.contextWindowTokens) ||
      candidate.contextWindowTokens <= 0 ||
      !/^[a-f0-9]{64}$/u.test(candidate.routeConfigFingerprint)
    ) {
      continue;
    }
    const key = `${candidate.providerId}\u0000${candidate.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(candidate);
    }
  }
  return output;
}

function assertLegacyCouncilReasoningRecoverySafe(
  storage: Storage,
  run: AssemblyRunRecord,
  input: ExecuteChatModelCouncilInput,
): void {
  const resolution = requireModelCouncilResolution(run);
  const synthesisParticipant = resolution.participants.find(
    (participant) => participant.participantId === resolution.synthesisParticipantId,
  );
  if (
    synthesisParticipant?.apiStyle === undefined &&
    resolveChatReasoningEffort(input.capabilityProfile.selection.thinkingLevel ?? "standard") !== "none" &&
    !getCouncilSynthesisArtifact(storage, run)
  ) {
    throw new Error(
      `Model council ${run.runId} predates the immutable provider-style/reasoning binding and cannot resume ` +
        "reasoning dispatch safely; retry as a new Chat turn.",
    );
  }
}

function resolveCouncilExecutionApiStyle(
  participant: ModelCouncilParticipantResolution,
  input: ExecuteChatModelCouncilInput,
): LlmApiStyle | undefined {
  if (participant.apiStyle !== undefined) {
    return participant.apiStyle;
  }
  const current = dedupeCouncilCandidates(input.providerCandidates).find(
    (candidate) =>
      candidate.providerId === participant.providerId &&
      candidate.model === participant.model &&
      candidate.contextWindowTokens === participant.contextWindowTokens &&
      candidate.routeConfigFingerprint === participant.routeConfigFingerprint,
  );
  return current?.apiStyle;
}

function councilStageIndex(stage: AssemblyStage): number {
  if (stage === "completed") {
    return MODEL_COUNCIL_STAGE_ORDER.length - 1;
  }
  return MODEL_COUNCIL_STAGE_ORDER.indexOf(stage as (typeof MODEL_COUNCIL_STAGE_ORDER)[number]);
}

function assertCouncilArtifactStageReachable(run: AssemblyRunRecord, artifactStage: AssemblyStage): void {
  const runStageIndex = councilStageIndex(run.currentStage);
  const artifactStageIndex = councilStageIndex(artifactStage);
  if (runStageIndex < 0 || artifactStageIndex < 0 || artifactStageIndex > runStageIndex) {
    throw new Error(
      `Model council ${run.runId} contains future ${artifactStage} artifact truth before ${run.currentStage}.`,
    );
  }
}

function councilAttemptBaseId(
  run: AssemblyRunRecord,
  stage: ModelCouncilAttemptEvidence["stage"],
  participantId: string,
): string {
  return stage === "C3_synthesize" ? `${run.runId}:C3:synthesis` : `${run.runId}:C1:${participantId}`;
}

function readCouncilAttemptOrdinal(
  run: AssemblyRunRecord,
  stage: ModelCouncilAttemptEvidence["stage"],
  participantId: string,
  attemptId: string,
): number | undefined {
  const prefix = `${councilAttemptBaseId(run, stage, participantId)}:attempt:`;
  if (!attemptId.startsWith(prefix)) {
    return undefined;
  }
  const ordinalText = attemptId.slice(prefix.length);
  if (!/^[1-9]\d*$/u.test(ordinalText)) {
    return undefined;
  }
  const ordinal = Number(ordinalText);
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}

function isExpectedCouncilAttemptId(
  run: AssemblyRunRecord,
  stage: ModelCouncilAttemptEvidence["stage"],
  participantId: string,
  attemptId: string,
): boolean {
  return readCouncilAttemptOrdinal(run, stage, participantId, attemptId) !== undefined;
}

function buildNextCouncilAttemptId(
  run: AssemblyRunRecord,
  stage: ModelCouncilAttemptEvidence["stage"],
  participantId: string,
  attempts: ModelCouncilAttemptEvidence[],
): string {
  const matchingOrdinals = attempts
    .filter((attempt) => attempt.stage === stage && attempt.participantId === participantId)
    .map((attempt) => readCouncilAttemptOrdinal(run, stage, participantId, attempt.attemptId));
  if (matchingOrdinals.some((ordinal) => ordinal === undefined)) {
    throw new Error(`Model council ${run.runId} contains an invalid durable attempt identity.`);
  }
  const nextOrdinal = Math.max(0, ...(matchingOrdinals as number[])) + 1;
  return `${councilAttemptBaseId(run, stage, participantId)}:attempt:${nextOrdinal}`;
}

function requireModelCouncilResolution(run: AssemblyRunRecord): ModelCouncilResolution {
  if (run.runKind !== "chat_model_council" || !run.councilResolution) {
    throw new Error(`Assembly run ${run.runId} is not a frozen Chat model council.`);
  }
  const { resolutionHash, ...draft } = run.councilResolution;
  if (resolutionHash !== digest(draft)) {
    throw new Error(`Model council ${run.runId} resolution hash is invalid.`);
  }
  if (
    run.councilResolution.schemaVersion !== "assembly.model-council-resolution.v1" ||
    run.councilResolution.turnId !== run.sourceTurnId ||
    run.councilResolution.sessionId !== run.sourceSessionId ||
    run.councilResolution.workspaceId !== run.workspaceId ||
    !run.councilResolution.capabilityProfileId ||
    !run.councilResolution.capabilityProfileHash ||
    !run.councilResolution.historyHash
  ) {
    throw new Error(`Model council ${run.runId} resolution is not bound to its immutable run identity.`);
  }
  if (run.councilResolution.participants.length < 2 || run.councilResolution.participants.length > 3) {
    throw new Error(`Model council ${run.runId} has an invalid immutable participant count.`);
  }
  const participantIds = new Set<string>();
  const participantRoutes = new Set<string>();
  let primaryCount = 0;
  for (const participant of run.councilResolution.participants) {
    const routeKey = `${participant.providerId}\u0000${participant.model}`;
    if (
      !participant.participantId.trim() ||
      participant.participantId !== participant.participantId.trim() ||
      containsAsciiControlCharacter(participant.participantId) ||
      !participant.providerId.trim() ||
      participant.providerId !== participant.providerId.trim() ||
      containsAsciiControlCharacter(participant.providerId) ||
      !participant.model.trim() ||
      participant.model !== participant.model.trim() ||
      containsAsciiControlCharacter(participant.model) ||
      (participant.apiStyle !== undefined && !MODEL_COUNCIL_API_STYLES.has(participant.apiStyle)) ||
      !Number.isSafeInteger(participant.contextWindowTokens) ||
      participant.contextWindowTokens <= 0 ||
      !/^[a-f0-9]{64}$/u.test(participant.routeConfigFingerprint) ||
      (participant.role !== "primary" && participant.role !== "advisory")
    ) {
      throw new Error(`Model council ${run.runId} has an invalid immutable participant binding.`);
    }
    if (participantIds.has(participant.participantId) || participantRoutes.has(routeKey)) {
      throw new Error(`Model council ${run.runId} repeats participant ${participant.participantId}.`);
    }
    participantIds.add(participant.participantId);
    participantRoutes.add(routeKey);
    primaryCount += participant.role === "primary" ? 1 : 0;
    if (!participant.advisoryOnly || participant.toolsAllowed !== false) {
      throw new Error(`Model council ${run.runId} participant ${participant.participantId} is not read-only.`);
    }
    const expectedRouteFingerprint = digest({
      providerId: participant.providerId,
      model: participant.model,
      contextWindowTokens: participant.contextWindowTokens,
      ...(participant.apiStyle ? { apiStyle: participant.apiStyle } : {}),
      routeConfigFingerprint: participant.routeConfigFingerprint,
      capabilityProfileHash: run.councilResolution.capabilityProfileHash,
    });
    if (participant.routeFingerprint !== expectedRouteFingerprint) {
      throw new Error(`Model council ${run.runId} participant ${participant.participantId} route binding is invalid.`);
    }
  }
  const synthesisParticipant = run.councilResolution.participants.find(
    (participant) => participant.participantId === run.councilResolution!.synthesisParticipantId,
  );
  if (primaryCount !== 1 || synthesisParticipant?.role !== "primary") {
    throw new Error(`Model council ${run.runId} has no immutable synthesis participant.`);
  }
  return run.councilResolution;
}

function assertCouncilLease(run: AssemblyRunRecord, leaseOwnerId: string): void {
  if (
    run.leaseOwnerId !== leaseOwnerId ||
    !run.leaseExpiresAt ||
    Date.parse(run.leaseExpiresAt) <= Date.now() ||
    !Number.isSafeInteger(run.generation)
  ) {
    throw new Error(`Model council ${run.runId} does not hold a valid Assembly lease/generation.`);
  }
}

function validateCouncilRounds(run: AssemblyRunRecord, rounds: AssemblyRound[]): void {
  const resolution = requireModelCouncilResolution(run);
  const participantIds = resolution.participants.map((participant) => participant.participantId);
  const participantArtifactIds = participantIds.map((participantId) => `${run.runId}:C1:${participantId}`);
  const seenStages = new Set<AssemblyStage>();
  for (const round of rounds) {
    if (seenStages.has(round.stage)) {
      throw new Error(`Model council ${run.runId} repeats immutable round stage ${round.stage}.`);
    }
    seenStages.add(round.stage);
    switch (round.stage) {
      case "C0_resolve":
        validateCouncilRound(run, round, round.stage, 0, participantIds, []);
        break;
      case "C1_participate":
        validateCouncilRound(run, round, round.stage, 1, participantIds, participantArtifactIds);
        break;
      case "C2_assemble":
        validateCouncilRound(run, round, round.stage, 2, participantIds, participantArtifactIds);
        break;
      case "C3_synthesize":
        validateCouncilRound(run, round, round.stage, 3, participantIds, [`${run.runId}:C3:synthesis`]);
        break;
      default:
        throw new Error(`Model council ${run.runId} contains non-council round ${round.roundId}.`);
    }
  }
  const currentStageIndex = councilStageIndex(run.currentStage);
  if (currentStageIndex < 0) {
    throw new Error(`Model council ${run.runId} has an impossible current Assembly stage ${run.currentStage}.`);
  }
  for (const stage of seenStages) {
    if (councilStageIndex(stage) > currentStageIndex) {
      throw new Error(`Model council ${run.runId} contains future round ${stage} before ${run.currentStage}.`);
    }
  }
  // A stage transition is committed only after the prior immutable round. The
  // current stage round may also exist when a process dies between its insert
  // and the following CAS transition, but no earlier gap is recoverable.
  for (let index = 0; index < currentStageIndex; index += 1) {
    const requiredStage = MODEL_COUNCIL_STAGE_ORDER[index]!;
    if (!seenStages.has(requiredStage)) {
      throw new Error(`Model council ${run.runId} is missing prior round ${requiredStage}.`);
    }
  }
  if ((run.status === "completed") !== (run.currentStage === "completed")) {
    throw new Error(`Model council ${run.runId} has inconsistent completed run/stage truth.`);
  }
  if (run.status === "completed" && seenStages.size !== MODEL_COUNCIL_STAGE_ORDER.length) {
    throw new Error(`Model council ${run.runId} completed without all durable Assembly rounds.`);
  }
}

function validateCouncilRound(
  run: AssemblyRunRecord,
  round: AssemblyRound,
  stage: AssemblyStage,
  roundIndex: number,
  participantIds: string[],
  artifactIds: string[],
): void {
  if (
    round.roundId !== `${run.runId}:council:${stage}` ||
    round.runId !== run.runId ||
    round.roundIndex !== roundIndex ||
    round.stage !== stage ||
    round.status !== "completed" ||
    canonicalJsonString(round.participantIds) !== canonicalJsonString(participantIds) ||
    canonicalJsonString(round.artifactIds) !== canonicalJsonString(artifactIds) ||
    round.convergenceSnapshot !== undefined ||
    round.stopCheck !== undefined ||
    !round.finishedAt
  ) {
    throw new Error(`Model council round ${round.roundId} conflicts with immutable ${stage} truth.`);
  }
}

function getCouncilParticipantArtifacts(storage: Storage, run: AssemblyRunRecord): AssemblyArtifactRecord[] {
  return validateCouncilArtifactSet(run, storage.assembly.listArtifacts(run.runId)).participants;
}

function getCouncilSynthesisArtifact(storage: Storage, run: AssemblyRunRecord): AssemblyArtifactRecord | undefined {
  return validateCouncilArtifactSet(run, storage.assembly.listArtifacts(run.runId)).synthesis;
}

function validateCouncilArtifactSet(
  run: AssemblyRunRecord,
  artifacts: AssemblyArtifactRecord[],
): { participants: AssemblyArtifactRecord[]; synthesis?: AssemblyArtifactRecord } {
  const resolution = requireModelCouncilResolution(run);
  const participants: AssemblyArtifactRecord[] = [];
  let synthesis: AssemblyArtifactRecord | undefined;
  const seenParticipants = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.runId !== run.runId) {
      throw new Error(`Model council ${run.runId} read an artifact from another run.`);
    }
    if (artifact.artifactType === "model_council_participant") {
      assertCouncilArtifactStageReachable(run, "C1_participate");
      const payload = artifact.payload as ModelCouncilParticipantArtifact;
      const participant = resolution.participants.find(
        (candidate) => candidate.participantId === payload.attempt?.participantId,
      );
      if (!participant) {
        throw new Error(`Model council ${run.runId} participant artifact has no immutable route binding.`);
      }
      const expectedArtifactId = `${run.runId}:C1:${participant.participantId}`;
      validateCompletedCouncilArtifact({
        run,
        artifact,
        participant,
        expectedArtifactId,
        expectedStage: "C1_participate",
        expectedRoundIndex: 1,
        expectedRole: participant.role,
        text: payload.responseText,
      });
      const expectedBlindToken = `council:${digest(participant.participantId).slice(0, 16)}`;
      if (artifact.blindedAuthorToken !== expectedBlindToken || seenParticipants.has(participant.participantId)) {
        throw new Error(`Model council ${run.runId} participant artifact identity is invalid or duplicated.`);
      }
      seenParticipants.add(participant.participantId);
      participants.push(artifact);
      continue;
    }
    if (artifact.artifactType === "model_council_synthesis") {
      assertCouncilArtifactStageReachable(run, "C3_synthesize");
      if (synthesis) {
        throw new Error(`Model council ${run.runId} has duplicate synthesis artifacts.`);
      }
      const participant = resolution.participants.find(
        (candidate) => candidate.participantId === resolution.synthesisParticipantId,
      )!;
      const payload = artifact.payload as ModelCouncilSynthesisArtifact;
      validateCompletedCouncilArtifact({
        run,
        artifact,
        participant,
        expectedArtifactId: `${run.runId}:C3:synthesis`,
        expectedStage: "C3_synthesize",
        expectedRoundIndex: 3,
        expectedRole: "synthesis",
        text: payload.answer,
      });
      if (artifact.blindedAuthorToken !== undefined) {
        throw new Error(`Model council ${run.runId} synthesis artifact has an unexpected blinded identity.`);
      }
      synthesis = artifact;
      continue;
    }
    throw new Error(`Model council ${run.runId} contains non-council artifact ${artifact.artifactId}.`);
  }
  participants.sort((left, right) => {
    const leftId = (left.payload as ModelCouncilParticipantArtifact).attempt.participantId;
    const rightId = (right.payload as ModelCouncilParticipantArtifact).attempt.participantId;
    return (
      resolution.participants.findIndex((participant) => participant.participantId === leftId) -
      resolution.participants.findIndex((participant) => participant.participantId === rightId)
    );
  });
  return { participants, ...(synthesis ? { synthesis } : {}) };
}

function validateCompletedCouncilArtifact(input: {
  run: AssemblyRunRecord;
  artifact: AssemblyArtifactRecord;
  participant: ModelCouncilParticipantResolution;
  expectedArtifactId: string;
  expectedStage: ModelCouncilAttemptEvidence["stage"];
  expectedRoundIndex: number;
  expectedRole: ModelCouncilAttemptEvidence["role"];
  text: string;
}): void {
  const { artifact, participant } = input;
  const payload = artifact.payload as ModelCouncilParticipantArtifact | ModelCouncilSynthesisArtifact;
  const attempt = payload.attempt;
  if (
    artifact.artifactId !== input.expectedArtifactId ||
    artifact.runId !== input.run.runId ||
    artifact.roundIndex !== input.expectedRoundIndex ||
    artifact.stage !== input.expectedStage ||
    !isExpectedCouncilAttemptId(input.run, input.expectedStage, participant.participantId, attempt.attemptId) ||
    attempt.stage !== input.expectedStage ||
    attempt.participantId !== participant.participantId ||
    attempt.role !== input.expectedRole ||
    attempt.status !== "completed"
  ) {
    throw new Error(`Model council artifact ${artifact.artifactId} has an invalid run/stage/attempt binding.`);
  }
  const expectedType =
    input.expectedStage === "C1_participate" ? "model_council_participant" : "model_council_synthesis";
  if (
    artifact.artifactType !== expectedType ||
    artifact.participantModelRef !== `${participant.providerId}:${participant.model}` ||
    attempt.effectiveProviderId !== participant.providerId ||
    attempt.effectiveModel !== participant.model
  ) {
    throw new Error(`Model council artifact ${artifact.artifactId} has an invalid immutable route binding.`);
  }
  if (typeof input.text !== "string" || !input.text || attempt.responseHash !== digest(input.text)) {
    throw new Error(`Model council artifact ${artifact.artifactId} failed its response hash check.`);
  }
  validateCouncilAttemptMetrics(attempt);
}

function validateCouncilAttemptMetrics(attempt: ModelCouncilAttemptEvidence): void {
  if (
    !Array.isArray(attempt.modelUsageEventIds) ||
    attempt.modelUsageEventIds.some((eventId) => typeof eventId !== "string" || !eventId) ||
    new Set(attempt.modelUsageEventIds).size !== attempt.modelUsageEventIds.length
  ) {
    throw new Error(`Model council attempt ${attempt.attemptId} has invalid HX-306 event ids.`);
  }
  for (const [label, value] of [
    ["inputTokens", attempt.inputTokens],
    ["outputTokens", attempt.outputTokens],
    ["costUsd", attempt.costUsd],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Model council attempt ${attempt.attemptId} has invalid ${label}.`);
    }
  }
}

function buildCompletedCouncilAttempt(
  attemptId: string,
  participant: ModelCouncilParticipantResolution,
  stage: ModelCouncilAttemptEvidence["stage"],
  text: string,
  response: ChatCompletionResponse,
): ModelCouncilAttemptEvidence {
  const usage = response.usage ?? {};
  return {
    attemptId,
    stage,
    participantId: participant.participantId,
    role: stage === "C3_synthesize" ? "synthesis" : participant.role,
    status: "completed",
    responseHash: digest(text),
    effectiveProviderId: response.routing?.effectiveProviderId ?? participant.providerId,
    effectiveModel: response.routing?.effectiveModel ?? response.model ?? participant.model,
    modelUsageEventIds: [...(response.modelUsageEventIds ?? [])],
    inputTokens: readNumericUsage(usage, ["prompt_tokens", "input_tokens", "promptTokenCount"]),
    outputTokens: readNumericUsage(usage, ["completion_tokens", "output_tokens", "candidatesTokenCount"]),
    costUsd: readNumericUsage(usage, ["cost_usd", "costUsd"]),
  };
}

function buildFailedCouncilAttempt(
  attemptId: string,
  participant: ModelCouncilParticipantResolution,
  stage: ModelCouncilAttemptEvidence["stage"],
  error: unknown,
  response?: ChatCompletionResponse,
): ModelCouncilAttemptEvidence {
  const usage = response?.usage ?? {};
  return {
    attemptId,
    stage,
    participantId: participant.participantId,
    role: stage === "C3_synthesize" ? "synthesis" : participant.role,
    status: "failed",
    effectiveProviderId: response?.routing?.effectiveProviderId ?? participant.providerId,
    effectiveModel: response?.routing?.effectiveModel ?? response?.model ?? participant.model,
    modelUsageEventIds: [
      ...new Set([...(response?.modelUsageEventIds ?? []), ...extractAuthoritativeUsageEventIds(error)]),
    ],
    inputTokens: readNumericUsage(usage, ["prompt_tokens", "input_tokens", "promptTokenCount"]),
    outputTokens: readNumericUsage(usage, ["completion_tokens", "output_tokens", "candidatesTokenCount"]),
    costUsd: readNumericUsage(usage, ["cost_usd", "costUsd"]),
    errorFingerprint: digest(normalizeErrorMessage(error)),
  };
}

function reconstructCouncilAttempts(
  storage: Storage,
  run: AssemblyRunRecord,
  participantArtifacts: AssemblyArtifactRecord[],
  synthesisArtifact?: AssemblyArtifactRecord,
): ModelCouncilAttemptEvidence[] {
  const attempts: ModelCouncilAttemptEvidence[] = [];
  const persistedAttempts = run.councilEvidence?.attempts ?? [];
  const seenPersisted = new Set<string>();
  for (const attempt of persistedAttempts) {
    if (seenPersisted.has(attempt.attemptId)) {
      throw new Error(`Model council ${run.runId} repeats attempt evidence ${attempt.attemptId}.`);
    }
    seenPersisted.add(attempt.attemptId);
    if (attempt.status === "failed") {
      validateFailedCouncilAttempt(run, attempt);
      attempts.push(attempt);
    }
  }
  const completedAttempts = [
    ...participantArtifacts.map((artifact) => (artifact.payload as ModelCouncilParticipantArtifact).attempt),
    ...(synthesisArtifact ? [(synthesisArtifact.payload as ModelCouncilSynthesisArtifact).attempt] : []),
  ];
  for (const attempt of completedAttempts) {
    const persisted = persistedAttempts.find((candidate) => candidate.attemptId === attempt.attemptId);
    if (persisted && canonicalJsonString(persisted) !== canonicalJsonString(attempt)) {
      throw new Error(`Model council ${run.runId} attempt ${attempt.attemptId} conflicts with its artifact truth.`);
    }
    upsertCouncilAttempt(attempts, attempt);
  }
  for (const persisted of persistedAttempts.filter((attempt) => attempt.status === "completed")) {
    if (!completedAttempts.some((attempt) => attempt.attemptId === persisted.attemptId)) {
      throw new Error(`Model council ${run.runId} has completed evidence without an immutable artifact.`);
    }
  }
  const ordered = attempts.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  validateCouncilAttemptSequences(run, ordered, participantArtifacts, synthesisArtifact);
  validateCouncilAttemptsAgainstHx306(storage, run, ordered);
  return ordered;
}

function projectCouncilRunWithReconstructedEvidence(
  storage: Storage,
  run: AssemblyRunRecord,
  artifacts: AssemblyArtifactRecord[],
): AssemblyRunRecord {
  const resolution = requireModelCouncilResolution(run);
  const artifactSet = validateCouncilArtifactSet(run, artifacts);
  const attempts = reconstructCouncilAttempts(storage, run, artifactSet.participants, artifactSet.synthesis);
  const reconstructedCanonicalAnswerHash = artifactSet.synthesis
    ? digest((artifactSet.synthesis.payload as ModelCouncilSynthesisArtifact).answer)
    : undefined;
  if (
    run.councilEvidence &&
    (run.councilEvidence.schemaVersion !== "assembly.model-council-evidence.v1" ||
      run.councilEvidence.resolutionHash !== resolution.resolutionHash ||
      run.councilEvidence.participantCount !== resolution.participants.length ||
      (run.councilEvidence.canonicalAnswerHash !== undefined &&
        run.councilEvidence.canonicalAnswerHash !== reconstructedCanonicalAnswerHash))
  ) {
    throw new Error(`Model council ${run.runId} persisted evidence has an invalid resolution/answer binding.`);
  }
  const evidence = {
    ...buildModelCouncilEvidence(run, artifactSet.participants, attempts),
    ...(reconstructedCanonicalAnswerHash ? { canonicalAnswerHash: reconstructedCanonicalAnswerHash } : {}),
    updatedAt: run.councilEvidence?.updatedAt ?? run.updatedAt,
  } satisfies ModelCouncilEvidence;
  return {
    ...run,
    councilEvidence: evidence,
    usage: sumCouncilUsage(attempts),
  };
}

function validateFailedCouncilAttempt(run: AssemblyRunRecord, attempt: ModelCouncilAttemptEvidence): void {
  const resolution = requireModelCouncilResolution(run);
  const participant = resolution.participants.find((candidate) => candidate.participantId === attempt.participantId);
  const isSynthesis = attempt.stage === "C3_synthesize";
  if (
    (attempt.stage !== "C1_participate" && attempt.stage !== "C3_synthesize") ||
    attempt.status !== "failed" ||
    !participant ||
    (isSynthesis && participant.participantId !== resolution.synthesisParticipantId) ||
    !isExpectedCouncilAttemptId(run, attempt.stage, attempt.participantId, attempt.attemptId) ||
    attempt.role !== (isSynthesis ? "synthesis" : participant.role) ||
    !attempt.errorFingerprint ||
    attempt.responseHash !== undefined ||
    attempt.effectiveProviderId !== participant.providerId ||
    attempt.effectiveModel !== participant.model
  ) {
    throw new Error(`Model council ${run.runId} has invalid failed-attempt evidence ${attempt.attemptId}.`);
  }
  validateCouncilAttemptMetrics(attempt);
}

function validateCouncilAttemptSequences(
  run: AssemblyRunRecord,
  attempts: ModelCouncilAttemptEvidence[],
  participantArtifacts: AssemblyArtifactRecord[],
  synthesisArtifact?: AssemblyArtifactRecord,
): void {
  const resolution = requireModelCouncilResolution(run);
  const completedParticipantIds = new Set(
    participantArtifacts.map((artifact) => (artifact.payload as ModelCouncilParticipantArtifact).attempt.participantId),
  );
  const groups = [
    ...resolution.participants.map((participant) => ({
      stage: "C1_participate" as const,
      participantId: participant.participantId,
      completedExpected: completedParticipantIds.has(participant.participantId),
    })),
    {
      stage: "C3_synthesize" as const,
      participantId: resolution.synthesisParticipantId,
      completedExpected: Boolean(synthesisArtifact),
    },
  ];
  for (const group of groups) {
    const relevant = attempts
      .filter((attempt) => attempt.stage === group.stage && attempt.participantId === group.participantId)
      .map((attempt) => ({
        attempt,
        ordinal: readCouncilAttemptOrdinal(run, group.stage, group.participantId, attempt.attemptId),
      }))
      .sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
    for (let index = 0; index < relevant.length; index += 1) {
      if (relevant[index]!.ordinal !== index + 1) {
        throw new Error(
          `Model council ${run.runId} has a non-contiguous ${group.stage} attempt sequence for ${group.participantId}.`,
        );
      }
    }
    const completed = relevant.filter(({ attempt }) => attempt.status === "completed");
    if (completed.length !== (group.completedExpected ? 1 : 0)) {
      throw new Error(
        `Model council ${run.runId} has completed attempt evidence without exact immutable artifact truth.`,
      );
    }
    if (completed.length === 1 && completed[0] !== relevant.at(-1)) {
      throw new Error(`Model council ${run.runId} has a retry after a completed immutable attempt.`);
    }
    if (relevant.length > 0) {
      assertCouncilArtifactStageReachable(run, group.stage);
    }
  }
}

function extractAuthoritativeUsageEventIds(error: unknown): string[] {
  if (!error || typeof error !== "object") {
    return [];
  }
  const eventIds = Array.isArray((error as { modelUsageEventIds?: unknown }).modelUsageEventIds)
    ? (error as { modelUsageEventIds: unknown[] }).modelUsageEventIds.filter(
        (eventId): eventId is string => typeof eventId === "string" && Boolean(eventId.trim()),
      )
    : [];
  const authoritativeEventId = isAuthoritativeModelUsageAccountingError(error)
    ? (error as { eventId?: unknown }).eventId
    : undefined;
  if (typeof authoritativeEventId === "string" && authoritativeEventId.trim()) {
    eventIds.push(authoritativeEventId);
  }
  return [...new Set(eventIds)];
}

function listCouncilModelUsageEvents(storage: Storage, runId: string): ModelUsageEventRecord[] | undefined {
  const repository = storage.modelUsageEvents as Storage["modelUsageEvents"] | undefined;
  if (!repository || typeof repository.list !== "function") {
    // Narrow unit hosts predating HX-306 do not own its repository. Production
    // Storage always does; those hosts retain response-carried evidence only.
    return undefined;
  }
  const events: ModelUsageEventRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = repository.list({ assemblyRunId: runId, limit: 200, ...(cursor ? { cursor } : {}) });
    events.push(...response.items);
    cursor = response.nextCursor;
    if (!cursor) {
      return events;
    }
  }
  throw new Error(`Model council ${runId} exceeded the bounded HX-306 reconciliation window.`);
}

function reconcileCouncilAttemptWithHx306(
  storage: Storage,
  run: AssemblyRunRecord,
  participant: ModelCouncilParticipantResolution,
  attempt: ModelCouncilAttemptEvidence,
): ModelCouncilAttemptEvidence {
  const allEvents = listCouncilModelUsageEvents(storage, run.runId);
  if (!allEvents) {
    return attempt;
  }
  const canonicalEvents = allEvents.filter((event) => event.operationId === attempt.attemptId);
  const canonicalEventIds = canonicalEvents.map((event) => event.eventId);
  const responseEventIds = [...new Set(attempt.modelUsageEventIds)];
  if (
    responseEventIds.length > 0 &&
    canonicalJsonString([...responseEventIds].sort()) !== canonicalJsonString([...canonicalEventIds].sort())
  ) {
    throw new Error(`Model council attempt ${attempt.attemptId} differs from canonical HX-306 event truth.`);
  }
  if (canonicalEvents.length === 0) {
    throw new Error(`Model council attempt ${attempt.attemptId} has no canonical HX-306 evidence.`);
  }
  for (const event of canonicalEvents) {
    if (
      event.callKind !== "assembly_participant" ||
      event.assemblyRunId !== run.runId ||
      event.assemblyRoundIndex !== (attempt.stage === "C1_participate" ? 1 : 3) ||
      event.assemblyStage !== attempt.stage ||
      event.workspaceId !== run.workspaceId ||
      event.sessionId !== run.sourceSessionId ||
      event.turnId !== run.sourceTurnId ||
      event.taskId !== run.sourceTaskId ||
      event.agentId !== participant.participantId ||
      event.workerId !== participant.participantId ||
      event.requestedProviderId !== participant.providerId ||
      event.requestedModelId !== participant.model ||
      (event.effectiveProviderId !== undefined && event.effectiveProviderId !== participant.providerId) ||
      (event.dispatchedModelId !== undefined && event.dispatchedModelId !== participant.model) ||
      (event.effectiveModelId !== undefined && event.effectiveModelId !== participant.model)
    ) {
      throw new Error(`Model council attempt ${attempt.attemptId} has foreign or unfrozen HX-306 attribution.`);
    }
  }
  if (
    attempt.status === "completed" &&
    !canonicalEvents.some((event) => event.terminalOutcome === "succeeded" && event.transportStatus === "accepted")
  ) {
    throw new Error(`Model council attempt ${attempt.attemptId} has no successful canonical HX-306 dispatch.`);
  }
  const summed = canonicalEvents.reduce<{
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }>((total, event) => {
    if (event.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + event.inputTokens;
    if (event.outputTokens !== undefined) total.outputTokens = (total.outputTokens ?? 0) + event.outputTokens;
    if (event.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + event.costUsd;
    return total;
  }, {});
  const {
    modelUsageEventIds: _modelUsageEventIds,
    inputTokens: _inputTokens,
    outputTokens: _outputTokens,
    costUsd: _costUsd,
    ...stableAttempt
  } = attempt;
  return {
    ...stableAttempt,
    modelUsageEventIds: canonicalEventIds,
    ...summed,
  };
}

function validateCouncilAttemptsAgainstHx306(
  storage: Storage,
  run: AssemblyRunRecord,
  attempts: ModelCouncilAttemptEvidence[],
): void {
  const resolution = requireModelCouncilResolution(run);
  for (const attempt of attempts) {
    const participant = resolution.participants.find((candidate) => candidate.participantId === attempt.participantId);
    if (!participant) {
      throw new Error(`Model council attempt ${attempt.attemptId} has no immutable participant route.`);
    }
    const reconciled = reconcileCouncilAttemptWithHx306(storage, run, participant, attempt);
    if (canonicalJsonString(reconciled) !== canonicalJsonString(attempt)) {
      throw new Error(`Model council attempt ${attempt.attemptId} differs from canonical HX-306 accounting truth.`);
    }
  }
}

function assertPriorCouncilAttemptsRetrySafe(
  storage: Storage,
  run: AssemblyRunRecord,
  stage: ModelCouncilAttemptEvidence["stage"],
  participantId: string,
  attempts: ModelCouncilAttemptEvidence[],
): void {
  const repository = storage.modelUsageEvents as Storage["modelUsageEvents"] | undefined;
  if (!repository || typeof repository.findByEventId !== "function") {
    return;
  }
  for (const attempt of attempts.filter(
    (candidate) =>
      candidate.stage === stage && candidate.participantId === participantId && candidate.status === "failed",
  )) {
    for (const eventId of attempt.modelUsageEventIds) {
      const event = repository.findByEventId(eventId);
      if (!event || event.operationId !== attempt.attemptId || event.assemblyRunId !== run.runId) {
        throw new Error(`Model council attempt ${attempt.attemptId} lost canonical HX-306 retry evidence.`);
      }
      if (
        event.terminalOutcome === "in_flight" ||
        (event.transportStatus === "dispatch_unknown" && !event.dispatchReconciliation)
      ) {
        throw new Error(
          `Model council attempt ${attempt.attemptId} requires HX-306 dispatch reconciliation before retry.`,
        );
      }
    }
  }
}

function assertResolvedCouncilRoute(
  participant: ModelCouncilParticipantResolution,
  response: ChatCompletionResponse,
): void {
  const effectiveProviderId = response.routing?.effectiveProviderId ?? participant.providerId;
  const effectiveModel = response.routing?.effectiveModel ?? response.model ?? participant.model;
  if (effectiveProviderId !== participant.providerId || effectiveModel !== participant.model) {
    throw new Error(
      `Model council participant ${participant.participantId} crossed an unfrozen provider/model route boundary.`,
    );
  }
}

function buildModelCouncilEvidence(
  run: AssemblyRunRecord,
  artifacts: AssemblyArtifactRecord[],
  attempts: ModelCouncilAttemptEvidence[],
): ModelCouncilEvidence {
  const responseHashes = artifacts
    .map((artifact) => (artifact.payload as ModelCouncilParticipantArtifact).attempt.responseHash)
    .filter((value): value is string => Boolean(value));
  const hashCounts = new Map<string, number>();
  for (const hash of responseHashes) {
    hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
  }
  const primaryHash = artifacts
    .map((artifact) => artifact.payload as ModelCouncilParticipantArtifact)
    .find((payload) => payload.attempt.role === "primary")?.attempt.responseHash;
  const dissentFingerprints = [
    ...new Set(responseHashes.filter((hash) => Boolean(primaryHash) && hash !== primaryHash)),
  ];
  const minorityFingerprints = [...hashCounts.entries()].filter(([, count]) => count === 1).map(([hash]) => hash);
  return {
    schemaVersion: "assembly.model-council-evidence.v1",
    resolutionHash: requireModelCouncilResolution(run).resolutionHash,
    participantCount: requireModelCouncilResolution(run).participants.length,
    completedParticipantCount: artifacts.length,
    dissentCount: dissentFingerprints.length,
    minorityCount: minorityFingerprints.length,
    dissentFingerprints,
    minorityFingerprints,
    attempts: [...attempts].sort((left, right) => left.attemptId.localeCompare(right.attemptId)),
    updatedAt: new Date().toISOString(),
  };
}

function buildModelCouncilAttribution(
  run: AssemblyRunRecord,
  participant: ModelCouncilParticipantResolution,
  stage: ModelCouncilAttemptEvidence["stage"],
  attemptId: string,
): ModelUsageAttributionContext {
  return {
    operationId: attemptId,
    parentOperationId: `assembly:${encodeURIComponent(run.runId)}`,
    callKind: "assembly_participant",
    requestedProviderId: participant.providerId,
    requestedModelId: participant.model,
    workspaceId: run.workspaceId,
    sessionId: run.sourceSessionId,
    turnId: run.sourceTurnId,
    taskId: run.sourceTaskId,
    agentId: participant.participantId,
    workerId: participant.participantId,
    assemblyRunId: run.runId,
    assemblyRoundIndex: stage === "C1_participate" ? 1 : 3,
    assemblyStage: stage,
  };
}

function upsertCouncilAttempt(attempts: ModelCouncilAttemptEvidence[], attempt: ModelCouncilAttemptEvidence): void {
  const index = attempts.findIndex((candidate) => candidate.attemptId === attempt.attemptId);
  if (index >= 0) {
    if (canonicalJsonString(attempts[index]) !== canonicalJsonString(attempt)) {
      throw new Error(`Model council attempt ${attempt.attemptId} conflicts with immutable attempt truth.`);
    }
  } else {
    attempts.push(attempt);
  }
}

function sumCouncilUsage(attempts: ModelCouncilAttemptEvidence[]): AssemblyUsageSummary {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let costUsd: number | undefined;
  for (const attempt of attempts) {
    if (attempt.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + attempt.inputTokens;
    if (attempt.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + attempt.outputTokens;
    if (attempt.costUsd !== undefined) costUsd = (costUsd ?? 0) + attempt.costUsd;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function buildCompletedModelCouncilResult(storage: Storage, run: AssemblyRunRecord): ModelCouncilExecutionResult {
  const result = run.result;
  const evidence = run.councilEvidence;
  if (run.status !== "completed" || run.currentStage !== "completed" || !result?.recommendation || !evidence) {
    throw new Error(`Model council ${run.runId} has no canonical completed result.`);
  }
  const artifactSet = validateCouncilArtifactSet(run, storage.assembly.listArtifacts(run.runId));
  const resolution = requireModelCouncilResolution(run);
  if (artifactSet.participants.length !== resolution.participants.length || !artifactSet.synthesis) {
    throw new Error(`Model council ${run.runId} completed without its full immutable artifact set.`);
  }
  const synthesisPayload = artifactSet.synthesis.payload as ModelCouncilSynthesisArtifact;
  const attempts = reconstructCouncilAttempts(storage, run, artifactSet.participants, artifactSet.synthesis);
  const expectedCanonicalAnswerHash = digest(synthesisPayload.answer);
  if (
    result.runId !== run.runId ||
    result.recommendation !== synthesisPayload.answer ||
    evidence.canonicalAnswerHash !== expectedCanonicalAnswerHash
  ) {
    throw new Error(`Model council ${run.runId} canonical answer binding is invalid.`);
  }
  const expectedEvidence = {
    ...buildModelCouncilEvidence(run, artifactSet.participants, attempts),
    canonicalAnswerHash: expectedCanonicalAnswerHash,
    updatedAt: evidence.updatedAt,
  } satisfies ModelCouncilEvidence;
  if (canonicalJsonString(expectedEvidence) !== canonicalJsonString(evidence)) {
    throw new Error(`Model council ${run.runId} evidence differs from reconstructed immutable artifact truth.`);
  }
  const expectedUsage = sumCouncilUsage(attempts);
  if (
    canonicalJsonString(run.usage ?? {}) !== canonicalJsonString(expectedUsage) ||
    canonicalJsonString(result.finalUsage ?? {}) !== canonicalJsonString(expectedUsage)
  ) {
    throw new Error(`Model council ${run.runId} usage differs from reconstructed HX-306 attempt truth.`);
  }
  return {
    runId: run.runId,
    answer: synthesisPayload.answer,
    usage: expectedUsage,
    modelUsageEventIds: [...new Set(attempts.flatMap((attempt) => attempt.modelUsageEventIds))],
    evidence: expectedEvidence,
  };
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function digest(value: unknown): string {
  const content = typeof value === "string" ? value : canonicalJsonString(value);
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildAssemblyParticipantAttribution(input: {
  run: AssemblyRunRecord;
  roundIndex: number;
  stage: AssemblyStage;
  participant: AssemblyParticipantModel;
  workItemKind: "proposal" | "peer-review" | "adversarial-review";
  workItemId: string;
}): ModelUsageAttributionContext {
  const participantId = input.participant.participantId.trim() || participantModelRef(input.participant);
  const operationId = [
    "assembly",
    input.run.runId,
    `round-${input.roundIndex}`,
    input.stage,
    participantId,
    input.workItemKind,
    input.workItemId,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
  return {
    operationId,
    parentOperationId: `assembly:${encodeURIComponent(input.run.runId)}`,
    callKind: "assembly_participant",
    requestedProviderId: input.participant.providerId,
    requestedModelId: input.participant.model,
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sourceSessionId,
    taskId: input.run.sourceTaskId,
    agentId: participantId,
    workerId: participantId,
    assemblyRunId: input.run.runId,
    assemblyRoundIndex: input.roundIndex,
    assemblyStage: input.stage,
  };
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
    missingAssumptions: stringArrayOrFallback(payload.missingAssumptions, [
      "Assumption gaps not explicitly called out.",
    ]),
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
    mergeTargetProposalId:
      typeof payload.mergeTargetProposalId === "string" ? payload.mergeTargetProposalId : undefined,
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
    challengedReviewIds: [
      ...proposalReviews.map((review) => review.reviewId),
      ...challenges.map((review) => review.reviewId),
    ],
    acceptedPoints: dedupeStrings([
      ...proposalReviews.flatMap((review) => review.weaknesses.slice(0, 1)),
      ...challenges.flatMap((review) =>
        review.objections
          .filter((objection) => objection.classification !== "speculative_concern")
          .map((objection) => objection.title)
          .slice(0, 1),
      ),
    ]),
    rejectedPoints: challenges.flatMap((review) =>
      review.objections
        .filter((objection) => objection.classification === "speculative_concern")
        .map((objection) => objection.title),
    ),
    revisionsMade: proposal.testPlan.slice(0, 2).map((item) => `Expanded ${item.title}`),
    unresolvedDisputes: challenges.flatMap((review) =>
      review.objections.filter((objection) => !objection.mitigation?.trim()).map((objection) => objection.title),
    ),
    updatedConfidence: clamp01(proposal.confidence - challenges.length * 0.04),
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
    reasoning:
      peerReviews.length > 0
        ? `Incorporate ${peerReviews.length} prior review signal(s) before converging.`
        : "Start with a bounded proposal and preserve disagreement explicitly.",
    risks: ["Budget pressure", "Premature convergence", "Insufficient evidence"],
    assumptions: ["Relevant context is already present", "Participant models are complementary"],
    confidence: 0.64,
    evidence: [{ evidenceId: randomUUID(), label: "Prompt", detail: run.problem.originalPrompt, kind: "claim" }],
    testPlan: [
      {
        testId: randomUUID(),
        title: "Review output",
        detail: "Inspect the proposal for correctness and scope.",
        kind: "review",
      },
      {
        testId: randomUUID(),
        title: "Validate risks",
        detail: "Check the top listed risks before execution.",
        kind: "manual",
      },
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
      kind: typeof record.kind === "string" ? (record.kind as ModelProposal["evidence"][number]["kind"]) : "claim",
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
      kind: typeof record.kind === "string" ? (record.kind as ModelProposal["testPlan"][number]["kind"]) : "review",
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
    review.scores.correctness * 0.24 +
      review.scores.reasoningStrength * 0.2 +
      review.scores.practicality * 0.16 +
      review.scores.evidenceQuality * 0.14 +
      review.scores.riskAwareness * 0.12 +
      review.scores.testability * 0.08 +
      review.scores.clarity * 0.06,
  );
}

function buildDisagreementClusters(
  reviews: PeerReview[],
  adversarialReviews: AdversarialReview[],
): AssemblyDisagreementCluster[] {
  const fromWeaknesses = reviews.flatMap((review, index) =>
    review.weaknesses.slice(0, 1).map((weakness) => ({
      clusterId: `review-${index + 1}`,
      topic: weakness,
      proposalIds: [review.proposalId],
      severity: "medium" as const,
      summary: weakness,
    })),
  );
  const fromChallenges = adversarialReviews.flatMap((review, index) =>
    review.objections.slice(0, 1).map((objection) => ({
      clusterId: `adversarial-${index + 1}`,
      topic: objection.title,
      proposalIds: [review.proposalId],
      severity: objection.classification === "critical_flaw" ? ("high" as const) : ("medium" as const),
      summary: objection.detail,
    })),
  );
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
    exports.push({
      target: "chat",
      status: requested.has("chat") ? "failed" : "not_requested",
      detail: requested.has("chat") ? "No source chat session was available." : undefined,
    });
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
    ...dedupeStrings(topProposal?.testPlan.map((item) => `${item.title}: ${item.detail}`) ?? []).map(
      (item) => `- ${item}`,
    ),
    "",
    "## Disagreements",
    "",
    ...(convergence?.disagreementClusters.length
      ? convergence.disagreementClusters.map((cluster) => `- ${cluster.topic}: ${cluster.summary}`)
      : ["- No material disagreement clusters remained."]),
  ].join("\n");
}

function summarizeUsage(values: Array<AssemblyUsageSummary | undefined>): AssemblyUsageSummary {
  return values.reduce<AssemblyUsageSummary>(
    (summary, usage) => ({
      inputTokens: (summary.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
      outputTokens: (summary.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
      costUsd: roundCurrency((summary.costUsd ?? 0) + (usage?.costUsd ?? 0)),
      latencyMs: (summary.latencyMs ?? 0) + (usage?.latencyMs ?? 0),
    }),
    {},
  );
}

function selectWinningProposal(proposals: ModelProposal[], convergence?: ConvergenceScore): ModelProposal | undefined {
  if (!convergence) {
    return proposals[0];
  }
  return [...proposals].sort(
    (left, right) =>
      (convergence.proposalSupportScores[right.proposalId] ?? 0) -
      (convergence.proposalSupportScores[left.proposalId] ?? 0),
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
  const all = reviews.flatMap((review) =>
    review.objections.map((objection) => fingerprintObjection(objection.title, objection.detail)),
  );
  if (all.length === 0) {
    return 0;
  }
  return 1 - new Set(all).size / all.length;
}

function fingerprintObjection(title: string, detail: string): string {
  return `${title}|${detail}`.trim().toLowerCase().replace(/\s+/g, " ");
}

function readRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readVerdict(value: unknown): PeerReview["verdict"] {
  return value === "accept" || value === "reject" || value === "merge" ? value : "revise";
}

function readObjectionClass(value: unknown): AdversarialReview["objections"][number]["classification"] {
  return value === "critical_flaw" ||
    value === "moderate_risk" ||
    value === "edge_case_concern" ||
    value === "speculative_concern"
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
  return clamp01((current * previousWeight + next) / sampleCount);
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

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
