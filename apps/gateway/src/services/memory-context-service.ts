import { createHash } from "node:crypto";
import path from "node:path";
import {
  ConflictError,
  type MemoryContextAccessReceipt,
  type MemoryContextAssemblyReport,
  type MemoryContextComposeRequest,
  type MemoryContextCompositionDiagnostics,
  type MemoryContextPack,
  type MemoryQmdStatsResponse,
  type MemoryRelationScope,
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
  type MemoryItemSource,
  type MemorySourceInput,
} from "@goatcitadel/memory-core";
import {
  assertWritePathInJail,
  currentEmbeddingProfile,
  EmbeddingUsageSettlementError,
  generateEmbedding,
  type AcquireLocalEmbeddingLease,
  type PrepareEmbeddingUsageDispatch,
} from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { LlmService } from "./llm-service.js";
import { isImplicitPerCallCliDistiller, MemoryDistillerSkippedError } from "./memory-distiller-route.js";
import { walkMemoryFiles } from "./memory-file-walk.js";
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
  extractMemoryEmbedding,
  extractMemoryRetrievalHints,
  isMemoryContextAbort,
  parseDistillerResponse,
  projectMemoryRetrievalStatus,
  reserveMemoryContextBudget,
  resolveMemoryRelationScope,
  throwIfMemoryContextAborted,
  toCandidateMap,
  truncate,
} from "./memory-context-utils.js";

const DEFAULT_MEMORY_WORKSPACE_ID = "default";

export type { MemoryContextCompositionDiagnostics } from "@goatcitadel/contracts";

interface QueryEmbeddingResult {
  embedding?: number[];
  providerIsReal: boolean;
}
interface PendingQueryEmbedding {
  controller: AbortController;
  promise: Promise<QueryEmbeddingResult>;
  waiters: number;
  settled: boolean;
}

export class MemoryContextService {
  private readonly pendingQueryEmbeddings = new Map<string, PendingQueryEmbedding>();
  private readonly queryEmbeddingCache = new Map<
    string,
    {
      embedding: number[];
      providerIsReal: boolean;
      expiresAt: number;
    }
  >();
  public constructor(
    private readonly storage: Storage,
    private readonly llmService: LlmService,
    private readonly config: GatewayRuntimeConfig,
    private readonly publishRealtime: (eventType: string, payload: Record<string, unknown>) => Promise<unknown>,
    private readonly acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease,
    private readonly prepareEmbeddingUsageDispatch?: PrepareEmbeddingUsageDispatch,
    private readonly observeComposition?: (diagnostics: Readonly<MemoryContextCompositionDiagnostics>) => void,
  ) {}
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
      const result = await this.degradeUnsafeMemoryContext(input, pack);
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
    const shouldShortCircuit = !memoryConfig.enabled || !qmd.enabled || prompt.length < qmd.minPromptChars;
    // Generate a query embedding for the prompt when the caller did not supply one,
    // so semantic-vector ranking can engage. Skipped on the short-circuit path
    // (disabled/short prompt never ranks, so the legacy behavior is preserved).
    const embeddingStarted = performance.now();
    const resolvedQueryEmbedding = shouldShortCircuit
      ? {
          embedding: input.queryEmbedding,
          providerIsReal: currentEmbeddingProfile().provider !== "pseudo",
        }
      : await this.resolveQueryEmbedding(input, prompt, accessReceipt.fingerprint, usageLineage, diagnostics).finally(
          () => {
            diagnostics.timings.embeddingMs = elapsedMs(embeddingStarted);
          },
        );
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
    const sources = await this.collectSources(input, accessReceipt).finally(() => {
      diagnostics.timings.sourceReadMs = elapsedMs(sourceStarted);
    });
    throwIfMemoryContextAborted(input.signal);
    const rankingStarted = performance.now();
    const availableCandidates = rankMemoryCandidates(
      prompt,
      collectMemoryCandidates(sources, {
        maxTranscriptEvents: qmd.maxTranscriptEvents,
        maxFileCandidates: qmd.maxMemoryFiles,
        maxMemoryItems: qmd.maxMemoryFiles,
        maxCharsPerCandidate: 1400,
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

    if (!input.forceRefresh) {
      const cacheStarted = performance.now();
      const cached = await this.storage.memoryContexts.findFreshByCacheKey({
        cacheKey,
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
      });
      diagnostics.timings.contextCacheMs = elapsedMs(cacheStarted);
      diagnostics.contextCacheStatus = cached ? "hit" : "miss";
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

  /**
   * Resolve the query embedding used for semantic-vector ranking. Honors an
   * explicit `input.queryEmbedding`; otherwise generates one from the prompt.
   * The returned `providerIsReal` follows the actual generated vector metadata,
   * not only the configured provider: real providers can fall back to pseudo
   * vectors on network/config errors, and those fallback vectors must not affect
   * semantic ranking.
   */
  private async resolveQueryEmbedding(
    input: MemoryContextComposeRequest,
    prompt: string,
    accessFingerprint: string,
    usageLineage?: TrustedUtilityModelUsageLineage,
    diagnostics?: MemoryContextCompositionDiagnostics,
  ): Promise<{ embedding?: number[]; providerIsReal: boolean }> {
    if (input.queryEmbedding && input.queryEmbedding.length > 0) {
      if (diagnostics) diagnostics.embeddingCacheStatus = "supplied";
      return {
        embedding: input.queryEmbedding,
        providerIsReal: currentEmbeddingProfile().provider !== "pseudo",
      };
    }
    if (!prompt) {
      return { providerIsReal: false };
    }
    // Cache only the query computation. Sources and canonical access are still
    // read on every composition so edits, deletions and access changes take effect.
    // Hash exact prompt bytes: embedding providers need not be case-insensitive.
    const profile = currentEmbeddingProfile();
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify({
          prompt,
          profile,
          endpoint: process.env.GOATCITADEL_EMBEDDINGS_URL,
          scope: input.scope,
          citadelId: input.citadelId,
          workspaceId: input.workspaceId,
          workspace: input.workspace,
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          phaseId: input.phaseId,
          accessFingerprint,
        }),
      )
      .digest("hex");
    const now = Date.now();
    for (const [key, entry] of this.queryEmbeddingCache) {
      if (entry.expiresAt <= now) this.queryEmbeddingCache.delete(key);
    }
    const cached = this.queryEmbeddingCache.get(cacheKey);
    if (!input.forceRefresh && cached) {
      throwIfMemoryContextAborted(input.signal);
      if (diagnostics) diagnostics.embeddingCacheStatus = "hit";
      return { embedding: [...cached.embedding], providerIsReal: cached.providerIsReal };
    }
    this.queryEmbeddingCache.delete(cacheKey);
    if (diagnostics) diagnostics.embeddingCacheStatus = input.forceRefresh ? "refresh" : "miss";
    // A shared network attempt must have one exact accounting lineage. Cache
    // reuse itself is free, but an in-flight call cannot borrow another turn's
    // provider reservation or dispatch attribution.
    const pendingKey = createHash("sha256")
      .update(
        JSON.stringify({
          cacheKey,
          lineage: Object.entries(usageLineage ?? {}).sort(([left], [right]) => left.localeCompare(right)),
        }),
      )
      .digest("hex");
    const existing = input.forceRefresh ? undefined : this.pendingQueryEmbeddings.get(pendingKey);
    if (existing && !existing.controller.signal.aborted) {
      if (diagnostics) diagnostics.embeddingCacheStatus = "shared";
      return this.waitForQueryEmbedding(pendingKey, existing, input.signal);
    }
    // Force refresh owns its dispatch and cancellation. At the bounded map
    // limit, continue safely without retaining another single-flight entry.
    if (input.forceRefresh || this.pendingQueryEmbeddings.size >= 128) {
      return this.generateQueryEmbedding(input, prompt, profile, cacheKey, usageLineage);
    }
    const controller = new AbortController();
    const pending: PendingQueryEmbedding = {
      controller,
      waiters: 0,
      settled: false,
      promise: this.generateQueryEmbedding(
        { ...input, signal: controller.signal },
        prompt,
        profile,
        cacheKey,
        usageLineage,
      ).finally(() => {
        pending.settled = true;
        if (this.pendingQueryEmbeddings.get(pendingKey) === pending) this.pendingQueryEmbeddings.delete(pendingKey);
      }),
    };
    this.pendingQueryEmbeddings.set(pendingKey, pending);
    return this.waitForQueryEmbedding(pendingKey, pending, input.signal);
  }

  private waitForQueryEmbedding(
    pendingKey: string,
    pending: PendingQueryEmbedding,
    signal?: AbortSignal,
  ): Promise<QueryEmbeddingResult> {
    pending.waiters += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        pending.waiters -= 1;
        if (pending.waiters === 0 && !pending.settled) {
          if (this.pendingQueryEmbeddings.get(pendingKey) === pending) this.pendingQueryEmbeddings.delete(pendingKey);
          pending.controller.abort(new Error("memory embedding has no remaining retrieval waiters"));
        }
        return true;
      };
      const onAbort = () => {
        if (!release()) return;
        try {
          throwIfMemoryContextAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.promise.then(
        (result) => {
          if (release()) resolve({ ...result, ...(result.embedding ? { embedding: [...result.embedding] } : {}) });
        },
        (error) => {
          if (release()) reject(error);
        },
      );
      if (signal?.aborted) onAbort();
    });
  }

  private async generateQueryEmbedding(
    input: MemoryContextComposeRequest,
    prompt: string,
    profile: ReturnType<typeof currentEmbeddingProfile>,
    cacheKey: string,
    usageLineage?: TrustedUtilityModelUsageLineage,
  ): Promise<QueryEmbeddingResult> {
    throwIfMemoryContextAborted(input.signal);
    try {
      const generated = await generateEmbedding(prompt, undefined, undefined, {
        purpose: "embedding_query",
        ...(input.signal ? { signal: input.signal } : {}),
        ...(this.acquireLocalEmbeddingLease ? { acquireLocalServiceLease: this.acquireLocalEmbeddingLease } : {}),
        ...(this.prepareEmbeddingUsageDispatch
          ? { prepareModelUsageDispatch: this.prepareEmbeddingUsageDispatch }
          : {}),
        modelUsageAttribution: {
          ...usageLineage,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          durableRunId: usageLineage?.durableRunId ?? input.runId,
          taskId: input.taskId,
          utilityKind: "memory_context_query_embedding",
        },
      });
      throwIfMemoryContextAborted(input.signal);
      const ttlMs = Math.min(300_000, this.config.assistant.memory.qmd.cacheTtlSeconds * 1000);
      // Never retain a degraded result: a recovered provider must be retried.
      if (
        ttlMs > 0 &&
        generated.embedding.length > 0 &&
        profile.status === "active" &&
        generated.profile.status === "active" &&
        generated.metadata.provider === profile.provider
      ) {
        if (this.queryEmbeddingCache.size >= 128) {
          const oldest = this.queryEmbeddingCache.keys().next().value;
          if (oldest !== undefined) this.queryEmbeddingCache.delete(oldest);
        }
        this.queryEmbeddingCache.set(cacheKey, {
          embedding: [...generated.embedding],
          providerIsReal: generated.metadata.provider !== "pseudo",
          expiresAt: Date.now() + ttlMs,
        });
      }
      return {
        ...(generated.embedding.length > 0 ? { embedding: generated.embedding } : {}),
        providerIsReal: generated.metadata.provider !== "pseudo",
      };
    } catch (error) {
      throwIfMemoryContextAborted(input.signal);
      if (error instanceof ConflictError || error instanceof EmbeddingUsageSettlementError) {
        throw error;
      }
      return { providerIsReal: false };
    }
  }

  private async collectSources(
    input: MemoryContextComposeRequest,
    accessReceipt: MemoryContextAccessReceipt,
  ): Promise<MemorySourceInput[]> {
    const sources: MemorySourceInput[] = [];
    const relationScope = accessReceipt.mode === "session_only" ? "self" : resolveMemoryRelationScope(input);
    for (const sessionId of await this.resolveTranscriptSessionIds(input, relationScope, accessReceipt)) {
      throwIfMemoryContextAborted(input.signal);
      const transcript = await readTranscriptOrEmpty(this.storage, sessionId);
      sources.push({
        type: "transcript",
        events: transcript,
      });
    }

    if (accessReceipt.mode === "session_only") {
      return sources;
    }

    throwIfMemoryContextAborted(input.signal);
    for (const item of await this.collectMemoryItemSources(await this.resolveMemoryItemWorkspaceId(input))) {
      sources.push(item);
    }

    throwIfMemoryContextAborted(input.signal);
    const workspaceRelative = input.workspace?.trim() || "memory";
    const workspaceRoot = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir);
    const basePath = path.resolve(workspaceRoot, workspaceRelative);
    try {
      assertWritePathInJail(basePath, this.config.toolPolicy.sandbox.writeJailRoots);
      const files = await walkMemoryFiles(basePath, workspaceRoot, {
        maxFiles: this.config.assistant.memory.qmd.maxMemoryFiles,
        maxBytesPerFile: this.config.assistant.memory.qmd.maxBytesPerFile,
        allowedExtensions: this.config.assistant.memory.qmd.allowedExtensions,
      });
      throwIfMemoryContextAborted(input.signal);
      for (const file of files) {
        sources.push(file);
      }
    } catch {
      // Ignore missing or inaccessible memory workspace paths.
    }

    return sources;
  }

  // Finding 1 hardening: the DB memory-item retrieval choke-point must ALWAYS be
  // workspace-scoped. Resolve from the explicit workspaceId, else the session's
  // owning workspace, else the default workspace — never undefined, which would
  // trigger the unfiltered cross-workspace query in listActiveMemoryItems.
  private async resolveMemoryItemWorkspaceId(input: MemoryContextComposeRequest): Promise<string> {
    const explicit = input.workspaceId?.trim();
    if (explicit) {
      return explicit;
    }
    const sessionId = input.sessionId?.trim();
    if (sessionId) {
      const metaWorkspaceId = (await this.storage.chatSessionMeta?.get(sessionId))?.workspaceId?.trim();
      if (metaWorkspaceId) {
        return metaWorkspaceId;
      }
    }
    return DEFAULT_MEMORY_WORKSPACE_ID;
  }

  private async collectMemoryItemSources(workspaceId?: string): Promise<MemoryItemSource[]> {
    try {
      return (
        await this.storage.memoryMaintenance.listActiveMemoryItems(
          this.config.assistant.memory.qmd.maxMemoryFiles,
          normalizeMemoryWorkspaceId(workspaceId),
        )
      ).map((item) => ({
        type: "memory_item",
        itemId: item.itemId,
        namespace: item.namespace,
        title: item.title,
        content: item.content,
        updatedAt: item.updatedAt,
        pinned: item.pinned,
        retrievalHints: extractMemoryRetrievalHints(item.metadata),
        embedding: extractMemoryEmbedding(item.metadata),
      }));
    } catch {
      return [];
    }
  }

  private async resolveTranscriptSessionIds(
    input: MemoryContextComposeRequest,
    relationScope: MemoryRelationScope,
    accessReceipt: MemoryContextAccessReceipt,
  ): Promise<string[]> {
    const sessionIds = new Set<string>();
    if (input.sessionId) {
      sessionIds.add(input.sessionId);
    }
    if (
      accessReceipt.mode === "workspace_private" &&
      (relationScope === "peer" || relationScope === "project") &&
      input.runId
    ) {
      for (const step of await this.storage.chatDelegationSteps.listByRun(input.runId)) {
        if (step.childSessionId) {
          sessionIds.add(step.childSessionId);
        }
      }
    }
    return [...sessionIds];
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

// Finding 1: never return undefined — an undefined workspaceId makes
// listActiveMemoryItems fall back to the unfiltered cross-workspace query. A
// concrete workspace is resolved upstream (resolveMemoryItemWorkspaceId); this is
// the final backstop.
function normalizeMemoryWorkspaceId(workspaceId?: string): string {
  const trimmed = workspaceId?.trim();
  return trimmed || DEFAULT_MEMORY_WORKSPACE_ID;
}

async function readTranscriptOrEmpty(storage: Storage, sessionId: string) {
  try {
    return await storage.transcripts.read(sessionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
