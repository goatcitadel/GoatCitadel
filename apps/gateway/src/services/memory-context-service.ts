import { MemoryContextQueryEmbedding } from "./memory-context-query-embedding.js";
import { isExplicitMemoryRecallPrompt } from "./memory-context-utils.js";
import { createHash } from "node:crypto";
import {
  type MemoryContextAssemblyReport,
  type MemoryContextComposeRequest,
  type MemoryContextCompositionDiagnostics,
  type MemoryContextPack,
  type MemoryQmdStatsResponse,
  type MemoryRetrievalStatusResponse,
} from "@goatcitadel/contracts";
import {
  buildCacheKey,
  buildDistillerPrompt,
  buildQueryHash,
  buildSourcesHash,
  collectMemoryCandidates,
  composeDistilledContext,
  composeFallbackContext,
  rankMemoryCandidates,
  selectMemoryCandidatesForDistillation,
  validateCitations,
} from "@goatcitadel/memory-core";
import {
  currentEmbeddingProfile,
  type AcquireLocalEmbeddingLease,
  type PrepareEmbeddingUsageDispatch,
} from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { LlmService } from "./llm-service.js";
import {
  isImplicitPerCallCliDistiller,
  MEMORY_DISTILLER_SKIPPED_PER_CALL_CLI_REASON,
  MemoryDistillerSkippedError,
} from "./memory-distiller-route.js";
import {
  MemoryContextSourceReader,
  type MemoryCorpusReadPort,
  type ReadTrustedLearnings,
} from "./memory-context-source-reader.js";
import {
  enrichMemoryCitations,
  enrichMemoryPack,
  findInvalidFactCitationIds,
  MEMORY_CONTEXT_PROMPT_INJECTION_REASON,
  sanitizeMemoryContextWrite,
} from "./memory-context-safety.js";
import {
  createUtilityModelUsageAttribution,
  type TrustedUtilityModelUsageLineage,
} from "./utility-model-usage-attribution.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";
import { runBoundedUtilityModelCall } from "./utility-model-call.js";
import { isAuthoritativeModelUsageAccountingError, logger } from "@goatcitadel/gateway-core";
import {
  resolveMemoryContextAccessReceipt,
  resolveTrustedMemoryUsageWorkspaceId,
} from "./memory-context-access-policy.js";
import {
  calculateSavings,
  isMemoryContextAbort,
  parseDistillerResponse,
  projectMemoryRetrievalStatus,
  reserveMemoryContextBudget,
  resolveMemoryRelationScope,
  throwIfMemoryContextAborted,
  toCandidateMap,
  truncate,
} from "./memory-context-utils.js";

export type { MemoryContextCompositionDiagnostics } from "@goatcitadel/contracts";

export class MemoryContextService {
  private readonly queryEmbedding: MemoryContextQueryEmbedding;
  private readonly sourceReader: MemoryContextSourceReader;
  public constructor(
    private readonly storage: Storage,
    private readonly llmService: LlmService,
    private readonly config: GatewayRuntimeConfig,
    private readonly publishRealtime: (eventType: string, payload: Record<string, unknown>) => Promise<unknown>,
    acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease,
    prepareEmbeddingUsageDispatch?: PrepareEmbeddingUsageDispatch,
    private readonly observeComposition?: (diagnostics: Readonly<MemoryContextCompositionDiagnostics>) => void,
    collectTrustedLearnings?: ReadTrustedLearnings,
    corpusRead?: MemoryCorpusReadPort,
  ) {
    this.sourceReader = new MemoryContextSourceReader(storage, config, collectTrustedLearnings, corpusRead);
    this.queryEmbedding = new MemoryContextQueryEmbedding(
      config,
      acquireLocalEmbeddingLease,
      prepareEmbeddingUsageDispatch,
    );
  }
  public async compose(
    input: MemoryContextComposeRequest,
    usageLineage?: TrustedUtilityModelUsageLineage,
    observeComposition?: (diagnostics: Readonly<MemoryContextCompositionDiagnostics>) => void,
  ): Promise<MemoryContextPack> {
    const startedAt = performance.now();
    const diagnostics: MemoryContextCompositionDiagnostics = {
      outcome: "failed",
      embeddingCacheStatus: "skipped",
      embeddingProviderIsReal: false,
      contextCacheStatus: "not_checked",
      timings: {
        totalMs: 0,
        accessMs: 0,
        embeddingMs: 0,
        sourceReadMs: 0,
        rankingMs: 0,
        contextCacheMs: 0,
        distillationMs: 0,
      },
    };
    try {
      const pack = await this.composeInternal(input, usageLineage, diagnostics);
      const result = await this.degradeUnsafeMemoryContext(input, await this.checkCurrentLearningSources(input, pack));
      diagnostics.outcome = "completed";
      diagnostics.contextStatus = result.quality.status;
      diagnostics.availableCandidateCount = result.quality.assembly?.availableCandidateCount;
      diagnostics.selectedCandidateCount = result.quality.assembly?.selectedCandidateCount;
      diagnostics.citationsCount = result.citations.length;
      diagnostics.originalTokenEstimate = result.originalTokenEstimate;
      diagnostics.retainedTokenEstimate = result.distilledTokenEstimate;
      return result;
    } catch (error) {
      diagnostics.outcome = input.signal?.aborted ? "aborted" : "failed";
      throw error;
    } finally {
      diagnostics.timings.totalMs = elapsedMs(startedAt);
      for (const observer of [this.observeComposition, observeComposition]) {
        try {
          // Observation is request-local and deliberately excludes prompts,
          // source text, file paths, access fingerprints, and provider endpoints.
          observer?.(Object.freeze({ ...diagnostics, timings: Object.freeze({ ...diagnostics.timings }) }));
        } catch {
          logger.warn("Memory context diagnostics observer failed");
        }
      }
    }
  }

  private async composeInternal(
    input: MemoryContextComposeRequest,
    usageLineage: TrustedUtilityModelUsageLineage | undefined,
    diagnostics: MemoryContextCompositionDiagnostics,
  ): Promise<MemoryContextPack> {
    throwIfMemoryContextAborted(input.signal);
    const startedAt = Date.now();
    const memoryConfig = this.config.assistant.memory;
    const qmd = memoryConfig.qmd;
    const maxContextTokens = reserveMemoryContextBudget(input.maxContextTokens ?? qmd.maxContextTokens);
    const prompt = input.prompt.trim();
    const accessStarted = performance.now();
    const accessReceipt = await resolveMemoryContextAccessReceipt(this.storage, input.sessionId).finally(() => {
      diagnostics.timings.accessMs = elapsedMs(accessStarted);
    });
    const relationScope = accessReceipt.mode === "session_only" ? "self" : resolveMemoryRelationScope(input);
    const explicitRecall = input.intent === "explicit_recall" || isExplicitMemoryRecallPrompt(prompt);
    const shouldShortCircuit =
      !memoryConfig.enabled || !qmd.enabled || (!explicitRecall && prompt.length < qmd.minPromptChars);
    // Generate a query embedding for the prompt when the caller did not supply one,
    // so semantic-vector ranking can engage. Skipped on the short-circuit path
    // (disabled/short prompt never ranks, so the legacy behavior is preserved).
    const embeddingStarted = performance.now();
    const resolvedQueryEmbedding = shouldShortCircuit
      ? {
          embedding: input.queryEmbedding,
          providerIsReal: currentEmbeddingProfile().provider !== "pseudo",
        }
      : await this.queryEmbedding
          .resolve(input, prompt, accessReceipt.fingerprint, usageLineage, diagnostics)
          .finally(() => {
            diagnostics.timings.embeddingMs = elapsedMs(embeddingStarted);
          });
    diagnostics.timings.embeddingMs = elapsedMs(embeddingStarted);
    diagnostics.embeddingProviderIsReal = resolvedQueryEmbedding.providerIsReal;
    const queryEmbedding = resolvedQueryEmbedding.embedding;
    const queryHash = buildQueryHash(prompt, queryEmbedding);
    if (shouldShortCircuit) {
      const fallback = composeFallbackContext([], maxContextTokens);
      const cacheKey = buildCacheKey({
        scope: input.scope,
        prompt,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        relationScope,
        accessFingerprint: accessReceipt.fingerprint,
        maxContextTokens,
        candidates: [],
        queryEmbedding,
      });
      const pack = await this.storage.memoryContexts.upsert({
        cacheKey,
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        queryHash,
        sourcesHash: buildSourcesHash([]),
        contextText: fallback.contextText,
        citations: fallback.citations,
        quality: {
          status: "fallback",
          reason: "qmd_disabled_or_prompt_too_short",
          accessReceipt,
        },
        originalTokenEstimate: 0,
        distilledTokenEstimate: fallback.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedFallback = enrichMemoryPack(pack, relationScope, new Map());
      await this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: "fallback",
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: 0,
        citationsCount: fallback.citations.length,
        originalTokenEstimate: 0,
        distilledTokenEstimate: fallback.distilledTokenEstimate,
        savingsPercent: 0,
      });
      await this.publishRealtime("memory_qmd_fallback", {
        contextId: pack.contextId,
        scope: input.scope,
        reason: enrichedFallback.quality.reason,
      });
      return enrichedFallback;
    }

    const sourceStarted = performance.now();
    const sources = await this.sourceReader
      .collect(
        input,
        accessReceipt,
        resolvedQueryEmbedding.providerIsReal && queryEmbedding
          ? { values: queryEmbedding, profile: currentEmbeddingProfile() }
          : undefined,
      )
      .finally(() => {
        diagnostics.timings.sourceReadMs = elapsedMs(sourceStarted);
      });
    throwIfMemoryContextAborted(input.signal);
    const rankingStarted = performance.now();
    const availableCandidates = rankMemoryCandidates(
      prompt,
      collectMemoryCandidates(sources, {
        maxCandidates: 300,
        maxTranscriptEvents: qmd.maxTranscriptEvents,
        maxFileCandidates: 300,
        maxMemoryItems: 300,
        maxCharsPerCandidate: 1400,
        query: prompt,
      }),
      {
        maxCandidates: 40,
        queryEmbedding,
        // Only let embeddings influence rank when a real provider is active;
        // the default pseudo-hash adds relevance-uncorrelated noise (see ranker).
        embeddingProviderIsReal: resolvedQueryEmbedding.providerIsReal,
      },
    );
    const selectedCandidates = selectMemoryCandidatesForDistillation({
      candidates: availableCandidates,
      maxContextTokens,
    });
    const candidates = selectedCandidates.candidates;
    const assembly = selectedCandidates.assembly;
    diagnostics.timings.rankingMs = elapsedMs(rankingStarted);

    const sourcesHash = buildSourcesHash(candidates);
    const cacheKey = buildCacheKey({
      scope: input.scope,
      prompt,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      phaseId: input.phaseId,
      relationScope,
      accessFingerprint: accessReceipt.fingerprint,
      maxContextTokens,
      candidates,
      queryEmbedding,
    });

    const runtime = this.llmService.getRuntimeConfig();
    const providerId = qmd.distiller.providerId ?? runtime.activeProviderId;
    const model =
      qmd.distiller.model ??
      (providerId === runtime.activeProviderId ? runtime.activeModel : qmd.distiller.fallbackCheapModel);
    const skipPerCallCliDistiller = isImplicitPerCallCliDistiller(
      qmd.distiller.providerId,
      providerId,
      runtime.providers,
    );

    if (!input.forceRefresh) {
      const cacheStarted = performance.now();
      const found = await this.storage.memoryContexts.findFreshByCacheKey({
        cacheKey,
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
      });
      diagnostics.timings.contextCacheMs = elapsedMs(cacheStarted);
      // A context cached because the distiller was skipped must not outlive the route that skipped it.
      const staleSkippedDistill =
        found?.quality.reason === MEMORY_DISTILLER_SKIPPED_PER_CALL_CLI_REASON && !skipPerCallCliDistiller;
      const cached = staleSkippedDistill ? undefined : found;
      diagnostics.contextCacheStatus = cached ? "hit" : staleSkippedDistill ? "refresh" : "miss";
      if (cached) {
        const enrichedCached = refreshMemoryPackAssembly(enrichMemoryPack(cached, relationScope, new Map()), assembly);
        await this.storage.memoryQmdRuns.append({
          scope: input.scope,
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          phaseId: input.phaseId,
          status: "cache_hit",
          durationMs: Math.max(1, Date.now() - startedAt),
          candidateCount: assembly.selectedCandidateCount,
          citationsCount: enrichedCached.citations.length,
          originalTokenEstimate: enrichedCached.originalTokenEstimate,
          distilledTokenEstimate: enrichedCached.distilledTokenEstimate,
          savingsPercent: calculateSavings(enrichedCached.originalTokenEstimate, enrichedCached.distilledTokenEstimate),
        });
        await this.publishRealtime("memory_qmd_cache_hit", {
          contextId: enrichedCached.contextId,
          scope: input.scope,
          sessionId: input.sessionId,
          runId: input.runId,
          phaseId: input.phaseId,
        });
        return enrichedCached;
      }
    } else {
      diagnostics.contextCacheStatus = "refresh";
    }

    const originalTokenEstimate = assembly.availableTokenEstimate;

    if (candidates.length === 0) {
      const fallback = composeFallbackContext(candidates, maxContextTokens);
      const candidateMap = toCandidateMap(candidates);
      const citations = enrichMemoryCitations(fallback.citations, relationScope, candidateMap);
      const pack = await this.storage.memoryContexts.upsert({
        cacheKey,
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        queryHash,
        sourcesHash,
        contextText: fallback.contextText,
        citations,
        quality: {
          status: "fallback",
          reason: "no_candidates",
          assembly,
          accessReceipt,
        },
        originalTokenEstimate,
        distilledTokenEstimate: fallback.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedFallback = enrichMemoryPack(pack, relationScope, candidateMap);
      await this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: "fallback",
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: assembly.selectedCandidateCount,
        citationsCount: enrichedFallback.citations.length,
        originalTokenEstimate,
        distilledTokenEstimate: enrichedFallback.distilledTokenEstimate,
        savingsPercent: calculateSavings(originalTokenEstimate, enrichedFallback.distilledTokenEstimate),
      });
      await this.publishRealtime("memory_qmd_fallback", {
        contextId: enrichedFallback.contextId,
        scope: input.scope,
        reason: enrichedFallback.quality.reason,
      });
      return enrichedFallback;
    }

    try {
      if (skipPerCallCliDistiller) throw new MemoryDistillerSkippedError();
      const attribution = createUtilityModelUsageAttribution({
        operationId: `memory-context:${encodeURIComponent(cacheKey)}:distill`,
        utilityKind: "memory_context_distillation",
        requestedProviderId: providerId,
        requestedModelId: model,
        lineage: {
          ...usageLineage,
          workspaceId: (await resolveTrustedMemoryUsageWorkspaceId(this.storage, input.sessionId)) ?? input.workspaceId,
          sessionId: input.sessionId,
          durableRunId: usageLineage?.durableRunId ?? input.runId,
          taskId: input.taskId,
          agentId: "memory-context-distiller",
          contextSnapshotId: cacheKey,
        },
      });
      const distillationStarted = performance.now();
      const response = await runBoundedUtilityModelCall({
        timeoutMs: qmd.distiller.timeoutMs,
        timeoutMessage: "memory distiller timed out",
        parentSignal: input.signal,
        start: (boundedSignal) =>
          this.llmService.chatCompletions(
            {
              providerId,
              model,
              response_format: { type: "json_object" },
              temperature: 0.1,
              max_tokens: Math.max(300, Math.min(1400, maxContextTokens)),
              signal: boundedSignal,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a context distiller. Only use provided evidence. Return strict JSON. " +
                    "Never invent citations.",
                },
                {
                  role: "user",
                  content: buildDistillerPrompt({
                    prompt,
                    candidates,
                  }),
                },
              ],
            },
            attribution,
          ),
      }).finally(() => {
        diagnostics.timings.distillationMs = elapsedMs(distillationStarted);
      });
      throwIfMemoryContextAborted(input.signal);

      const parsed = parseDistillerResponse(response);
      const integrity = validateCitations(parsed.citations, candidates);
      if (!integrity.valid) {
        throw new Error(`distiller returned invalid citations: ${integrity.invalidIds.join(", ")}`);
      }
      const invalidFactCitationIds = findInvalidFactCitationIds(parsed);
      if (invalidFactCitationIds.length > 0) {
        throw new Error(`distiller returned facts with invalid citations: ${invalidFactCitationIds.join(", ")}`);
      }

      const composed = composeDistilledContext({
        payload: parsed.payload,
        citations: parsed.citations,
        maxContextTokens,
      });

      const candidateMap = toCandidateMap(candidates);
      const citations = enrichMemoryCitations(parsed.citations, relationScope, candidateMap);
      const write = sanitizeMemoryContextWrite({
        contextText: composed.contextText,
        citations,
        quality: {
          status: "generated",
          assembly,
          accessReceipt,
        },
        distilledTokenEstimate: composed.distilledTokenEstimate,
      });
      const pack = await this.storage.memoryContexts.upsert({
        cacheKey,
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        queryHash,
        sourcesHash,
        contextText: write.contextText,
        citations: write.citations,
        quality: write.quality,
        originalTokenEstimate,
        distilledTokenEstimate: write.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedGenerated = enrichMemoryPack(pack, relationScope, candidateMap);

      await this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: write.promptInjectionDetected ? "fallback" : "generated",
        providerId,
        model,
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: assembly.selectedCandidateCount,
        citationsCount: enrichedGenerated.citations.length,
        originalTokenEstimate,
        distilledTokenEstimate: enrichedGenerated.distilledTokenEstimate,
        savingsPercent: calculateSavings(originalTokenEstimate, enrichedGenerated.distilledTokenEstimate),
        errorText: write.promptInjectionDetected
          ? `${MEMORY_CONTEXT_PROMPT_INJECTION_REASON}:${write.evidenceHash?.slice(0, 12)}`
          : undefined,
      });

      if (write.promptInjectionDetected) {
        await this.publishRealtime("memory_qmd_fallback", {
          contextId: enrichedGenerated.contextId,
          scope: input.scope,
          sessionId: input.sessionId,
          runId: input.runId,
          phaseId: input.phaseId,
          reason: MEMORY_CONTEXT_PROMPT_INJECTION_REASON,
          evidenceHash: write.evidenceHash?.slice(0, 12),
        });
      } else {
        await this.publishRealtime("memory_qmd_generated", {
          contextId: enrichedGenerated.contextId,
          scope: input.scope,
          sessionId: input.sessionId,
          runId: input.runId,
          phaseId: input.phaseId,
          providerId,
          model,
        });
      }
      return enrichedGenerated;
    } catch (error) {
      if (isAuthoritativeModelUsageAccountingError(error) || error instanceof LlmDispatchGuardRejectedError) {
        throw error;
      }
      if (isMemoryContextAbort(error, input.signal)) {
        throw error instanceof Error ? error : new Error("memory context composition aborted");
      }
      const fallback = composeFallbackContext(candidates, maxContextTokens);
      const candidateMap = toCandidateMap(candidates);
      const citations = enrichMemoryCitations(fallback.citations, relationScope, candidateMap);
      const message = truncate((error as Error).message, 500);
      const write = sanitizeMemoryContextWrite({
        contextText: fallback.contextText,
        citations,
        quality: {
          status: "fallback",
          reason: message,
          assembly,
          accessReceipt,
        },
        distilledTokenEstimate: fallback.distilledTokenEstimate,
      });
      const pack = await this.storage.memoryContexts.upsert({
        cacheKey,
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        queryHash,
        sourcesHash,
        contextText: write.contextText,
        citations: write.citations,
        quality: write.quality,
        originalTokenEstimate,
        distilledTokenEstimate: write.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedFallback = enrichMemoryPack(pack, relationScope, candidateMap);
      await this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: "fallback",
        providerId,
        model,
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: assembly.selectedCandidateCount,
        citationsCount: enrichedFallback.citations.length,
        originalTokenEstimate,
        distilledTokenEstimate: enrichedFallback.distilledTokenEstimate,
        savingsPercent: calculateSavings(originalTokenEstimate, enrichedFallback.distilledTokenEstimate),
        errorText: write.promptInjectionDetected
          ? `${MEMORY_CONTEXT_PROMPT_INJECTION_REASON}:${write.evidenceHash?.slice(0, 12)}`
          : message,
      });
      await this.publishRealtime("memory_qmd_fallback", {
        contextId: enrichedFallback.contextId,
        scope: input.scope,
        reason: write.promptInjectionDetected ? MEMORY_CONTEXT_PROMPT_INJECTION_REASON : message,
        ...(write.evidenceHash ? { evidenceHash: write.evidenceHash.slice(0, 12) } : {}),
      });
      return enrichedFallback;
    }
  }

  public async get(contextId: string): Promise<MemoryContextPack> {
    return this.storage.memoryContexts.get(contextId);
  }

  public async listRecent(limit = 60): Promise<MemoryContextPack[]> {
    return this.storage.memoryContexts.listRecent(limit);
  }

  public async listByRun(runId: string): Promise<MemoryContextPack[]> {
    return this.storage.memoryContexts.listByRun(runId);
  }

  public async stats(from: string, to: string): Promise<MemoryQmdStatsResponse> {
    return this.storage.memoryQmdRuns.stats(from, to);
  }

  public async retrievalStatus(now = new Date()): Promise<MemoryRetrievalStatusResponse> {
    const checkedAt = now.toISOString();
    const qmd = this.config.assistant.memory.qmd;
    const enabled = Boolean(this.config.assistant.memory.enabled && qmd.enabled);
    const recentContexts = await this.listRecent(20);
    const recentRuns = await this.storage.memoryQmdRuns.list(20);
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const stats = await this.storage.memoryQmdRuns.stats(from, checkedAt);
    return projectMemoryRetrievalStatus({
      checkedAt,
      enabled,
      qmd: {
        enabled: qmd.enabled,
        applyToChat: qmd.applyToChat,
        applyToOrchestration: qmd.applyToOrchestration,
        minPromptChars: qmd.minPromptChars,
        cacheTtlSeconds: qmd.cacheTtlSeconds,
        distillerProviderId: qmd.distiller.providerId,
        distillerModel: qmd.distiller.model,
        distillerTimeoutMs: qmd.distiller.timeoutMs,
      },
      recentContexts,
      recentRuns,
      stats,
    });
  }

  private async degradeUnsafeMemoryContext(
    input: MemoryContextComposeRequest,
    pack: MemoryContextPack,
  ): Promise<MemoryContextPack> {
    const write = sanitizeMemoryContextWrite({
      contextText: pack.contextText,
      citations: pack.citations,
      quality: pack.quality,
      distilledTokenEstimate: pack.distilledTokenEstimate,
    });
    if (!write.promptInjectionDetected) {
      return pack;
    }
    const degraded: MemoryContextPack = {
      ...pack,
      contextText: write.contextText,
      citations: write.citations,
      quality: write.quality,
      distilledTokenEstimate: write.distilledTokenEstimate,
    };
    await this.storage.memoryQmdRuns.append({
      scope: input.scope,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      phaseId: input.phaseId,
      status: "fallback",
      durationMs: 1,
      candidateCount: pack.citations.length,
      citationsCount: 0,
      originalTokenEstimate: pack.originalTokenEstimate,
      distilledTokenEstimate: write.distilledTokenEstimate,
      savingsPercent: calculateSavings(pack.originalTokenEstimate, write.distilledTokenEstimate),
      errorText: `${MEMORY_CONTEXT_PROMPT_INJECTION_REASON}:${write.evidenceHash?.slice(0, 12)}`,
    });
    await this.publishRealtime("memory_qmd_fallback", {
      contextId: pack.contextId,
      scope: input.scope,
      sessionId: input.sessionId,
      runId: input.runId,
      phaseId: input.phaseId,
      reason: MEMORY_CONTEXT_PROMPT_INJECTION_REASON,
      evidenceHash: write.evidenceHash?.slice(0, 12),
    });
    return degraded;
  }

  private async checkCurrentLearningSources(
    input: MemoryContextComposeRequest,
    pack: MemoryContextPack,
  ): Promise<MemoryContextPack> {
    const citations = pack.citations.filter(
      (citation) =>
        ["memory_item", "memory_learning", "knowledge_chunk"].includes(citation.sourceType) &&
        Boolean(citation.sourceHash),
    );
    if (!citations.length) return pack;
    const current = await this.sourceReader.readCurrentSources(input, citations);
    const hashes = new Map<string, string | undefined>();
    for (const source of current) {
      if (source.type === "memory_learning") hashes.set(`memory_learning:${source.learningId}`, source.sourceHash);
      if (source.type === "memory_item") hashes.set(`memory_item:${source.itemId}`, source.sourceHash);
      if (source.type === "knowledge_chunk") hashes.set(`knowledge_chunk:${source.chunkId}`, source.sourceHash);
    }
    if (
      citations.every(
        (citation) =>
          citation.sourceHash && hashes.get(`${citation.sourceType}:${citation.sourceRef}`) === citation.sourceHash,
      )
    )
      return pack;
    const contextText =
      "Memory context withheld because an admitted learning changed or became unavailable during composition.";
    return await this.storage.memoryContexts.upsert({
      cacheKey: createHash("sha256")
        .update(`${pack.contextId}|learning_source_changed|${JSON.stringify([...hashes])}`)
        .digest("hex"),
      scope: pack.scope,
      sessionId: pack.sessionId,
      taskId: pack.taskId,
      runId: pack.runId,
      phaseId: pack.phaseId,
      queryHash: pack.queryHash,
      sourcesHash: buildSourcesHash([]),
      contextText,
      citations: [],
      quality: { ...pack.quality, status: "fallback", reason: "learning_source_changed" },
      originalTokenEstimate: pack.originalTokenEstimate,
      distilledTokenEstimate: Math.ceil(contextText.length / 4),
      expiresAt: new Date().toISOString(),
    });
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
}

function refreshMemoryPackAssembly(pack: MemoryContextPack, assembly: MemoryContextAssemblyReport): MemoryContextPack {
  return {
    ...pack,
    originalTokenEstimate: assembly.availableTokenEstimate,
    quality: {
      ...pack.quality,
      assembly,
    },
  };
}
