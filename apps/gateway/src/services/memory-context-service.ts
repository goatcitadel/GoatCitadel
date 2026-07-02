import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChatCompletionResponse,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryQmdStatsResponse,
  MemoryRelationScope,
  MemoryRetrievalMatchSignals,
  MemoryRetrievalStatusResponse,
  MemoryRetrievalStrategy,
} from "@goatcitadel/contracts";
import {
  buildCacheKey,
  buildDistillerPrompt,
  buildQueryHash,
  buildSourcesHash,
  collectMemoryCandidates,
  composeDistilledContext,
  composeFallbackContext,
  estimateTokensFromText,
  parseDistillerJson,
  rankMemoryCandidates,
  validateCitations,
  type MemoryFileSource,
  type MemoryItemSource,
  type MemorySourceInput,
  type ParsedDistillation,
} from "@goatcitadel/memory-core";
import { assertWritePathInJail, currentEmbeddingProfile, generateEmbedding } from "@goatcitadel/policy-engine";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { LlmService } from "./llm-service.js";
import {
  enrichMemoryCitations,
  enrichMemoryPack,
  findInvalidFactCitationIds,
  MEMORY_CONTEXT_PROMPT_INJECTION_REASON,
  sanitizeMemoryContextWrite,
} from "./memory-context-safety.js";

export class MemoryContextService {
  public constructor(
    private readonly storage: Storage,
    private readonly llmService: LlmService,
    private readonly config: GatewayRuntimeConfig,
    private readonly publishRealtime: (eventType: string, payload: Record<string, unknown>) => void,
  ) {}
  public async compose(input: MemoryContextComposeRequest): Promise<MemoryContextPack> {
    const pack = await this.composeInternal(input);
    return this.degradeUnsafeMemoryContext(input, pack);
  }

  private async composeInternal(input: MemoryContextComposeRequest): Promise<MemoryContextPack> {
    throwIfMemoryContextAborted(input.signal);
    const startedAt = Date.now();
    const memoryConfig = this.config.assistant.memory;
    const qmd = memoryConfig.qmd;
    const maxContextTokens = reserveMemoryContextBudget(input.maxContextTokens ?? qmd.maxContextTokens);
    const prompt = input.prompt.trim();
    const relationScope = resolveMemoryRelationScope(input);
    const shouldShortCircuit = !memoryConfig.enabled || !qmd.enabled || prompt.length < qmd.minPromptChars;
    // Generate a query embedding for the prompt when the caller did not supply one,
    // so semantic-vector ranking can engage. Skipped on the short-circuit path
    // (disabled/short prompt never ranks, so the legacy behavior is preserved).
    const resolvedQueryEmbedding = shouldShortCircuit
      ? {
          embedding: input.queryEmbedding,
          providerIsReal: currentEmbeddingProfile().provider !== "pseudo",
        }
      : await this.resolveQueryEmbedding(input, prompt);
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
        maxContextTokens,
        candidates: [],
        queryEmbedding,
      });
      const pack = this.storage.memoryContexts.upsert({
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
        },
        originalTokenEstimate: 0,
        distilledTokenEstimate: fallback.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedFallback = enrichMemoryPack(pack, relationScope, new Map());
      this.storage.memoryQmdRuns.append({
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
      this.publishRealtime("memory_qmd_fallback", {
        contextId: pack.contextId,
        scope: input.scope,
        reason: enrichedFallback.quality.reason,
      });
      return enrichedFallback;
    }

    const sources = await this.collectSources(input);
    throwIfMemoryContextAborted(input.signal);
    const candidates = rankMemoryCandidates(
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

    const sourcesHash = buildSourcesHash(candidates);
    const cacheKey = buildCacheKey({
      scope: input.scope,
      prompt,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      phaseId: input.phaseId,
      relationScope,
      maxContextTokens,
      candidates,
      queryEmbedding,
    });

    if (!input.forceRefresh) {
      const cached = this.storage.memoryContexts.findFreshByCacheKey({
        cacheKey,
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
      });
      if (cached) {
        const enrichedCached = enrichMemoryPack(cached, relationScope, new Map());
        this.storage.memoryQmdRuns.append({
          scope: input.scope,
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          phaseId: input.phaseId,
          status: "cache_hit",
          durationMs: Math.max(1, Date.now() - startedAt),
          candidateCount: candidates.length,
          citationsCount: enrichedCached.citations.length,
          originalTokenEstimate: enrichedCached.originalTokenEstimate,
          distilledTokenEstimate: enrichedCached.distilledTokenEstimate,
          savingsPercent: calculateSavings(enrichedCached.originalTokenEstimate, enrichedCached.distilledTokenEstimate),
        });
        this.publishRealtime("memory_qmd_cache_hit", {
          contextId: enrichedCached.contextId,
          scope: input.scope,
          sessionId: input.sessionId,
          runId: input.runId,
          phaseId: input.phaseId,
        });
        return enrichedCached;
      }
    }

    const originalTokenEstimate = estimateTokensFromText(candidates.map((candidate) => candidate.text).join("\n"));

    if (candidates.length === 0) {
      const fallback = composeFallbackContext(candidates, maxContextTokens);
      const candidateMap = toCandidateMap(candidates);
      const citations = enrichMemoryCitations(fallback.citations, relationScope, candidateMap);
      const pack = this.storage.memoryContexts.upsert({
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
        },
        originalTokenEstimate,
        distilledTokenEstimate: fallback.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedFallback = enrichMemoryPack(pack, relationScope, candidateMap);
      this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: "fallback",
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: candidates.length,
        citationsCount: enrichedFallback.citations.length,
        originalTokenEstimate,
        distilledTokenEstimate: enrichedFallback.distilledTokenEstimate,
        savingsPercent: calculateSavings(originalTokenEstimate, enrichedFallback.distilledTokenEstimate),
      });
      this.publishRealtime("memory_qmd_fallback", {
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
    const distillerAbortController = new AbortController();
    const distillerSignal = input.signal
      ? AbortSignal.any([input.signal, distillerAbortController.signal])
      : distillerAbortController.signal;

    try {
      const response = await withTimeout(
        this.llmService.chatCompletions({
          providerId,
          model,
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: Math.max(300, Math.min(1400, maxContextTokens)),
          signal: distillerSignal,
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
        }),
        qmd.distiller.timeoutMs,
        "memory distiller timed out",
        input.signal,
        () => {
          distillerAbortController.abort(new Error("memory distiller timed out"));
        },
      );
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
        },
        distilledTokenEstimate: composed.distilledTokenEstimate,
      });
      const pack = this.storage.memoryContexts.upsert({
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

      this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: write.promptInjectionDetected ? "fallback" : "generated",
        providerId,
        model,
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: candidates.length,
        citationsCount: enrichedGenerated.citations.length,
        originalTokenEstimate,
        distilledTokenEstimate: enrichedGenerated.distilledTokenEstimate,
        savingsPercent: calculateSavings(originalTokenEstimate, enrichedGenerated.distilledTokenEstimate),
        errorText: write.promptInjectionDetected
          ? `${MEMORY_CONTEXT_PROMPT_INJECTION_REASON}:${write.evidenceHash?.slice(0, 12)}`
          : undefined,
      });

      if (write.promptInjectionDetected) {
        this.publishRealtime("memory_qmd_fallback", {
          contextId: enrichedGenerated.contextId,
          scope: input.scope,
          sessionId: input.sessionId,
          runId: input.runId,
          phaseId: input.phaseId,
          reason: MEMORY_CONTEXT_PROMPT_INJECTION_REASON,
          evidenceHash: write.evidenceHash?.slice(0, 12),
        });
      } else {
        this.publishRealtime("memory_qmd_generated", {
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
        },
        distilledTokenEstimate: fallback.distilledTokenEstimate,
      });
      const pack = this.storage.memoryContexts.upsert({
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
      this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: "fallback",
        providerId,
        model,
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: candidates.length,
        citationsCount: enrichedFallback.citations.length,
        originalTokenEstimate,
        distilledTokenEstimate: enrichedFallback.distilledTokenEstimate,
        savingsPercent: calculateSavings(originalTokenEstimate, enrichedFallback.distilledTokenEstimate),
        errorText: write.promptInjectionDetected
          ? `${MEMORY_CONTEXT_PROMPT_INJECTION_REASON}:${write.evidenceHash?.slice(0, 12)}`
          : message,
      });
      this.publishRealtime("memory_qmd_fallback", {
        contextId: enrichedFallback.contextId,
        scope: input.scope,
        reason: write.promptInjectionDetected ? MEMORY_CONTEXT_PROMPT_INJECTION_REASON : message,
        ...(write.evidenceHash ? { evidenceHash: write.evidenceHash.slice(0, 12) } : {}),
      });
      return enrichedFallback;
    }
  }

  public get(contextId: string): MemoryContextPack {
    return this.storage.memoryContexts.get(contextId);
  }

  public listRecent(limit = 60): MemoryContextPack[] {
    return this.storage.memoryContexts.listRecent(limit);
  }

  public listByRun(runId: string): MemoryContextPack[] {
    return this.storage.memoryContexts.listByRun(runId);
  }

  public stats(from: string, to: string): MemoryQmdStatsResponse {
    return this.storage.memoryQmdRuns.stats(from, to);
  }

  public retrievalStatus(now = new Date()): MemoryRetrievalStatusResponse {
    const checkedAt = now.toISOString();
    const qmd = this.config.assistant.memory.qmd;
    const enabled = Boolean(this.config.assistant.memory.enabled && qmd.enabled);
    const recentContexts = this.listRecent(20);
    const recentRuns = this.storage.memoryQmdRuns.list(20);
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const stats = this.storage.memoryQmdRuns.stats(from, checkedAt);
    const retrievalStrategies = collectRecentRetrievalStrategies(recentContexts);
    const retrievalMode = resolveMemoryRetrievalMode(enabled, retrievalStrategies);
    const rerankMode = resolveMemoryRerankMode(enabled, retrievalStrategies);
    const lastError = recentRuns.find((run) => run.errorText?.trim())?.errorText;
    const lastRefresh = recentRuns[0]?.createdAt ?? recentContexts[0]?.createdAt;
    const fallbackMode = resolveMemoryFallbackMode(
      enabled,
      recentRuns[0]?.errorText,
      recentContexts[0]?.quality.reason,
    );
    return {
      checkedAt,
      enabled,
      retrievalMode,
      rerankAvailable: rerankMode !== "none",
      rerankMode,
      fallbackMode,
      lastRefresh,
      lastError,
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
      recent: {
        totalRuns: stats.totalRuns,
        generatedRuns: stats.generatedRuns,
        cacheHitRuns: stats.cacheHitRuns,
        fallbackRuns: stats.fallbackRuns,
        failedRuns: stats.failedRuns,
        retrievalStrategies,
      },
    };
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
  ): Promise<{ embedding?: number[]; providerIsReal: boolean }> {
    if (input.queryEmbedding && input.queryEmbedding.length > 0) {
      return {
        embedding: input.queryEmbedding,
        providerIsReal: currentEmbeddingProfile().provider !== "pseudo",
      };
    }
    if (!prompt) {
      return { providerIsReal: false };
    }
    try {
      const generated = await generateEmbedding(prompt);
      return {
        ...(generated.embedding.length > 0 ? { embedding: generated.embedding } : {}),
        providerIsReal: generated.metadata.provider !== "pseudo",
      };
    } catch {
      return { providerIsReal: false };
    }
  }

  private async collectSources(input: MemoryContextComposeRequest): Promise<MemorySourceInput[]> {
    const sources: MemorySourceInput[] = [];
    const relationScope = resolveMemoryRelationScope(input);
    for (const sessionId of await this.resolveTranscriptSessionIds(input, relationScope)) {
      throwIfMemoryContextAborted(input.signal);
      const transcript = await readTranscriptOrEmpty(this.storage, sessionId);
      sources.push({
        type: "transcript",
        events: transcript,
      });
    }

    throwIfMemoryContextAborted(input.signal);
    for (const item of this.collectMemoryItemSources(input.workspaceId)) {
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

  private collectMemoryItemSources(workspaceId?: string): MemoryItemSource[] {
    try {
      return this.storage.memoryMaintenance
        .listActiveMemoryItems(this.config.assistant.memory.qmd.maxMemoryFiles, normalizeMemoryWorkspaceId(workspaceId))
        .map((item) => ({
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
  ): Promise<string[]> {
    const sessionIds = new Set<string>();
    if (input.sessionId) {
      sessionIds.add(input.sessionId);
    }
    if ((relationScope === "peer" || relationScope === "project") && input.runId) {
      for (const step of this.storage.chatDelegationSteps.listByRun(input.runId)) {
        if (step.childSessionId) {
          sessionIds.add(step.childSessionId);
        }
      }
    }
    return [...sessionIds];
  }

  private degradeUnsafeMemoryContext(input: MemoryContextComposeRequest, pack: MemoryContextPack): MemoryContextPack {
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
    this.storage.memoryQmdRuns.append({
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
    this.publishRealtime("memory_qmd_fallback", {
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

function collectRecentRetrievalStrategies(recentContexts: MemoryContextPack[]): MemoryRetrievalStrategy[] {
  const strategies = new Set<MemoryRetrievalStrategy>();
  for (const context of recentContexts) {
    for (const citation of context.citations) {
      const strategy = citation.provenance?.retrievalStrategy;
      if (strategy) {
        strategies.add(strategy);
      }
    }
  }
  return [...strategies].sort();
}

function resolveMemoryRetrievalMode(
  enabled: boolean,
  retrievalStrategies: MemoryRetrievalStrategy[],
): MemoryRetrievalStatusResponse["retrievalMode"] {
  if (!enabled) {
    return "disabled";
  }
  if (retrievalStrategies.includes("hybrid_rank")) {
    return "hybrid_rank";
  }
  if (retrievalStrategies.includes("semantic_vector")) {
    return "semantic_vector";
  }
  if (retrievalStrategies.includes("semantic_hints")) {
    return "semantic_hints";
  }
  if (retrievalStrategies.includes("lexical_recency")) {
    return "lexical_recency";
  }
  // Honest default: with no observed semantic/hybrid strategy (e.g. the default
  // pseudo provider, which no longer contributes an embedding score), report
  // lexical_recency rather than implying a hybrid rerank that didn't happen.
  return "lexical_recency";
}

function resolveMemoryRerankMode(
  enabled: boolean,
  retrievalStrategies: MemoryRetrievalStrategy[],
): MemoryRetrievalStatusResponse["rerankMode"] {
  if (!enabled) {
    return "none";
  }
  return retrievalStrategies.includes("hybrid_rank") ? "hybrid_rank" : "none";
}

function resolveMemoryFallbackMode(
  enabled: boolean,
  latestRunError: string | undefined,
  latestQualityReason: string | undefined,
): MemoryRetrievalStatusResponse["fallbackMode"] {
  if (!enabled) {
    return "disabled";
  }
  const reason = latestRunError ?? latestQualityReason ?? "";
  if (/qmd_disabled|prompt_too_short/i.test(reason)) {
    return "short_prompt_or_disabled";
  }
  if (/no_candidates/i.test(reason)) {
    return "no_candidates";
  }
  if (reason.trim()) {
    return "distiller_fallback";
  }
  return "available";
}

function toCandidateMap(
  candidates: Array<{
    candidateId: string;
    sourceType: "transcript" | "file" | "memory_item";
    timestamp?: string;
    rankScore?: number;
    rankSignals?: MemoryRetrievalMatchSignals;
  }>,
) {
  return new Map(candidates.map((candidate) => [candidate.candidateId, candidate] as const));
}

function extractMemoryRetrievalHints(metadata: Record<string, unknown>): string[] | undefined {
  const hints = new Set<string>();
  for (const key of ["retrievalHints", "semanticTerms", "tags", "aliases", "keywords"]) {
    for (const value of readStringList(metadata[key])) {
      hints.add(value);
    }
  }
  return hints.size > 0 ? [...hints] : undefined;
}

function extractMemoryEmbedding(metadata: Record<string, unknown>): number[] | undefined {
  for (const key of ["embedding", "contentEmbedding", "semanticEmbedding"]) {
    const value = metadata[key];
    if (Array.isArray(value) && value.length > 0 && value.every((item) => Number.isFinite(item))) {
      return value.map((item) => Number(item));
    }
  }
  return undefined;
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function resolveMemoryRelationScope(input: MemoryContextComposeRequest): MemoryRelationScope {
  if (input.relationScope) {
    return input.relationScope;
  }
  if (input.phaseId || input.runId) {
    return "project";
  }
  if (input.taskId) {
    return "peer";
  }
  return "self";
}

function normalizeMemoryWorkspaceId(workspaceId?: string): string | undefined {
  const trimmed = workspaceId?.trim();
  return trimmed || undefined;
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

interface WalkOptions {
  maxFiles: number;
  maxBytesPerFile: number;
  allowedExtensions: string[];
}

async function walkMemoryFiles(
  baseDir: string,
  workspaceRoot: string,
  options: WalkOptions,
): Promise<MemoryFileSource[]> {
  const out: MemoryFileSource[] = [];
  await walkRecursive(baseDir, workspaceRoot, out, options);
  return out;
}

async function walkRecursive(
  currentDir: string,
  workspaceRoot: string,
  out: MemoryFileSource[],
  options: WalkOptions,
): Promise<void> {
  if (out.length >= options.maxFiles) {
    return;
  }
  let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= options.maxFiles) {
      return;
    }
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkRecursive(fullPath, workspaceRoot, out, options);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!options.allowedExtensions.includes(ext)) {
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.size > options.maxBytesPerFile) {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const relativePath = path.relative(workspaceRoot, fullPath).replaceAll("\\", "/");
    out.push({
      type: "file",
      relativePath,
      content,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
}

function parseDistillerResponse(response: ChatCompletionResponse): ParsedDistillation {
  const content = extractMessageContent(response);
  if (!content.trim()) {
    throw new Error("memory distiller returned empty content");
  }
  return parseDistillerJson(content);
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!message) {
    return "";
  }

  const raw = (message as Record<string, unknown>).content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") {
          return text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return "";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  throwIfMemoryContextAborted(signal);
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);
  });
  const abort = new Promise<never>((_, reject) => {
    if (!signal) {
      return;
    }
    abortHandler = () => reject(toMemoryContextAbortError(signal));
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([promise, timeout, abort]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function throwIfMemoryContextAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toMemoryContextAbortError(signal);
  }
}

function toMemoryContextAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("memory context composition aborted");
  error.name = "AbortError";
  return error;
}

function isMemoryContextAbort(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (error === signal.reason) {
    return true;
  }
  const record = error as { name?: unknown; message?: unknown };
  return (
    record.name === "AbortError" ||
    String(record.message ?? "")
      .toLowerCase()
      .includes("abort")
  );
}

function calculateSavings(originalTokens: number, distilledTokens: number): number {
  if (originalTokens <= 0) {
    return 0;
  }
  return Number((((originalTokens - distilledTokens) / originalTokens) * 100).toFixed(2));
}

function reserveMemoryContextBudget(maxContextTokens: number): number {
  if (maxContextTokens <= 160) {
    return maxContextTokens;
  }
  const reserved = Math.max(96, Math.ceil(maxContextTokens * 0.12));
  return Math.max(128, maxContextTokens - reserved);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
