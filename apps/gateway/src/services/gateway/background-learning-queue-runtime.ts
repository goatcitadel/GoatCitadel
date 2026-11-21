import type { AsyncStorage } from "@goatcitadel/storage";
import type { BackgroundLearningReadinessRuntime } from "../background-learning-readiness.js";
import { BackgroundLearningQueueService } from "../background-learning-queue-service.js";
import { estimateBackgroundReviewReservation, type BackgroundReviewService } from "../background-review-service.js";
import type { BackgroundSkillDraftService } from "../background-skill-draft-service.js";
import { collectChatContinuityLinks } from "../chat-continuity-links.js";
import type { LlmService } from "../llm-service.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service.js";

interface BackgroundLearningQueueRuntimeDeps {
  storage: Pick<
    AsyncStorage,
    | keyof ConstructorParameters<typeof BackgroundLearningQueueService>[0]["storage"]
    | keyof Parameters<typeof collectChatContinuityLinks>[0]
  >;
  review: Pick<BackgroundReviewService, "extractTurnMemoryFacts" | "suggestTurnSkill">;
  readiness: Pick<BackgroundLearningReadinessRuntime, "resolve" | "readDestinations">;
  resolveBackgroundModel(): Promise<{ providerId: string; model: string } | undefined>;
  readDailyUsdHardCap(): number;
  llm: Pick<LlmService, "getRuntimeConfig">;
  hasForegroundExecution(): boolean;
  memory: Pick<MemoryLifecycleService, "prepareMemoryMaintenancePlan" | "proposeTraceMemoryCandidate">;
  skillDrafts: Pick<BackgroundSkillDraftService, "proposeBackgroundSkillDraft">;
  publishRealtime(eventType: "system", source: "memory" | "skills", payload: Record<string, unknown>): Promise<unknown>;
}

export function createBackgroundLearningQueueRuntime(
  deps: BackgroundLearningQueueRuntimeDeps,
): BackgroundLearningQueueService {
  return new BackgroundLearningQueueService({
    storage: deps.storage,
    backgroundReview: deps.review,
    readiness: (input) => deps.readiness.resolve(input),
    readDestinations: (input) => deps.readiness.readDestinations(input),
    estimateBudget: async (input) => {
      const defaults = await deps.resolveBackgroundModel();
      return defaults
        ? estimateBackgroundReviewReservation({
            ...input,
            ...defaults,
            dailyCostCeilingUsd: deps.readDailyUsdHardCap(),
          })
        : undefined;
    },
    admitQueueWrite: async (input) => {
      const destination = await deps.readiness.readDestinations(input);
      return input.kind === "maintenance" ? destination.maintenance : destination.memory || destination.skill;
    },
    isSharedLocalModel: async () => {
      const defaults = await deps.resolveBackgroundModel();
      const provider = deps.llm
        .getRuntimeConfig({ useCache: true })
        .providers.find((item) => item.providerId === defaults?.providerId);
      if (!provider) return true;
      try {
        return (
          provider.providerId === "llamacpp" ||
          ["localhost", "127.0.0.1", "[::1]"].includes(new URL(provider.baseUrl).hostname)
        );
      } catch {
        return true;
      }
    },
    hasForegroundExecution: () => deps.hasForegroundExecution(),
    inspectSource: async (input, allowSettlingChild) =>
      deps.storage.backgroundLearningJobs.readEligibleSource(input, allowSettlingChild),
    sourceEffectsAreSettled: async (source) => {
      const evidence = await collectChatContinuityLinks(deps.storage, source.sessionId, [source.sourceTurnId]);
      return evidence.complete && !evidence.links.some((link) => link.kind === "effect" && !link.completed);
    },
    proposeMemory: async (job, sources, facts) => {
      const ids: string[] = [];
      for (const fact of facts) {
        const first = sources[0]!;
        const governedMemoryPlan =
          job.kind === "maintenance"
            ? await deps.memory.prepareMemoryMaintenancePlan({
                jobId: job.jobId,
                workspaceId: job.workspaceId,
                sources,
                proposedInsight: fact.content,
                preference: fact.kind === "preference",
              })
            : undefined;
        const candidate = await deps.memory.proposeTraceMemoryCandidate(
          {
            workspaceId: job.workspaceId,
            candidateType: fact.kind === "preference" ? "operator_preference" : "fact",
            proposedInsight: governedMemoryPlan?.proposedInsight ?? fact.content,
            confidence: fact.confidence,
            sourceText: "Completed private Chat work. Canonical source identities and hashes are retained for review.",
            sourceSessionId: job.sessionId,
            sourceRunId: first.parentRunId,
            sourceTurnId: first.sourceTurnId,
            sourceRefs: sources.flatMap((source) => [
              { sourceType: "turn" as const, sourceRef: source.sourceTurnId },
              { sourceType: "run" as const, sourceRef: source.parentRunId },
            ]),
            metadata: {
              source: "background_learning_queue",
              learningJobId: job.jobId,
              learningReviewSources: sources,
              operatorProfileReviewCandidate: true,
              operatorProfileFactKind: fact.kind,
              ...(governedMemoryPlan ? { governedMemoryPlan } : {}),
            },
          },
          "background-reviewer",
          "agent_proposed",
          { deferEmbedding: true, deferNotification: true },
        );
        ids.push(candidate.candidateId);
      }
      return ids;
    },
    proposeSkill: async (job, sources, suggestion) => {
      if (!suggestion.shouldAuthor || !suggestion.draftMarkdown) return [];
      const draft = await deps.skillDrafts.proposeBackgroundSkillDraft({
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        sessionId: job.sessionId,
        sources,
        markdown: suggestion.draftMarkdown,
      });
      return [draft.proposalId];
    },
    publishCommittedProposals: async (input) => {
      const signals = input.candidateIds.map((candidateId) =>
        deps.publishRealtime("system", "memory", {
          type: "memory_trace_candidate_proposed",
          candidateId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        }),
      );
      if (input.skillProposalIds.length)
        signals.push(
          deps.publishRealtime("system", "skills", {
            type: "capability_proposals_updated",
            proposalIds: input.skillProposalIds,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
          }),
        );
      const results = await Promise.allSettled(signals);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Learning proposal refresh delivery was incomplete.");
    },
  });
}
