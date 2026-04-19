import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChatCompletionResponse,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryFreshness,
  MemoryQmdStatsResponse,
  MemoryRelationScope,
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
  type DistillationPayload,
  type MemoryFileSource,
  type MemorySourceInput,
} from "@goatcitadel/memory-core";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { LlmService } from "./llm-service.js";

export class MemoryContextService {
  public constructor(
    private readonly storage: Storage,
    private readonly llmService: LlmService,
    private readonly config: GatewayRuntimeConfig,
    private readonly publishRealtime: (eventType: string, payload: Record<string, unknown>) => void,
  ) {}

  public async compose(input: MemoryContextComposeRequest): Promise<MemoryContextPack> {
    const startedAt = Date.now();
    const memoryConfig = this.config.assistant.memory;
    const qmd = memoryConfig.qmd;
    const maxContextTokens = input.maxContextTokens ?? qmd.maxContextTokens;
    const prompt = input.prompt.trim();
    const relationScope = resolveMemoryRelationScope(input);
    const shouldShortCircuit = !memoryConfig.enabled
      || !qmd.enabled
      || prompt.length < qmd.minPromptChars;
    const queryHash = buildQueryHash(prompt);
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
    const candidates = rankMemoryCandidates(
      prompt,
      collectMemoryCandidates(sources, {
        maxTranscriptEvents: qmd.maxTranscriptEvents,
        maxFileCandidates: qmd.maxMemoryFiles,
        maxCharsPerCandidate: 1400,
      }),
      { maxCandidates: 40 },
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
        citations: fallback.citations,
        quality: {
          status: "fallback",
          reason: "no_candidates",
        },
        originalTokenEstimate,
        distilledTokenEstimate: fallback.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedFallback = enrichMemoryPack(pack, relationScope, new Map(candidates.map((candidate) => [candidate.candidateId, candidate])));
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
    const model = qmd.distiller.model
      ?? (providerId === runtime.activeProviderId ? runtime.activeModel : qmd.distiller.fallbackCheapModel);

    try {
      const response = await withTimeout(
        this.llmService.chatCompletions({
          providerId,
          model,
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: Math.max(300, Math.min(1400, maxContextTokens)),
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
      );

      const parsed = parseDistillerResponse(response);
      const integrity = validateCitations(parsed.citations, candidates);
      if (!integrity.valid) {
        throw new Error(`distiller returned invalid citations: ${integrity.invalidIds.join(", ")}`);
      }

      const composed = composeDistilledContext({
        payload: parsed.payload,
        citations: parsed.citations,
        maxContextTokens,
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
        contextText: composed.contextText,
        citations: parsed.citations,
        quality: {
          status: "generated",
        },
        originalTokenEstimate,
        distilledTokenEstimate: composed.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedGenerated = enrichMemoryPack(
        pack,
        relationScope,
        new Map(candidates.map((candidate) => [candidate.candidateId, candidate])),
      );

      this.storage.memoryQmdRuns.append({
        scope: input.scope,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        status: "generated",
        providerId,
        model,
        durationMs: Math.max(1, Date.now() - startedAt),
        candidateCount: candidates.length,
        citationsCount: enrichedGenerated.citations.length,
        originalTokenEstimate,
        distilledTokenEstimate: enrichedGenerated.distilledTokenEstimate,
        savingsPercent: calculateSavings(originalTokenEstimate, enrichedGenerated.distilledTokenEstimate),
      });

      this.publishRealtime("memory_qmd_generated", {
        contextId: enrichedGenerated.contextId,
        scope: input.scope,
        sessionId: input.sessionId,
        runId: input.runId,
        phaseId: input.phaseId,
        providerId,
        model,
      });
      return enrichedGenerated;
    } catch (error) {
      const fallback = composeFallbackContext(candidates, maxContextTokens);
      const message = truncate((error as Error).message, 500);
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
        citations: fallback.citations,
        quality: {
          status: "fallback",
          reason: message,
        },
        originalTokenEstimate,
        distilledTokenEstimate: fallback.distilledTokenEstimate,
        expiresAt: new Date(Date.now() + qmd.cacheTtlSeconds * 1000).toISOString(),
      });
      const enrichedFallback = enrichMemoryPack(
        pack,
        relationScope,
        new Map(candidates.map((candidate) => [candidate.candidateId, candidate])),
      );
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
        errorText: message,
      });
      this.publishRealtime("memory_qmd_fallback", {
        contextId: enrichedFallback.contextId,
        scope: input.scope,
        reason: message,
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

  private async collectSources(input: MemoryContextComposeRequest): Promise<MemorySourceInput[]> {
    const sources: MemorySourceInput[] = [];
    const relationScope = resolveMemoryRelationScope(input);
    for (const sessionId of await this.resolveTranscriptSessionIds(input, relationScope)) {
      const transcript = await readTranscriptOrEmpty(this.storage, sessionId);
      sources.push({
        type: "transcript",
        events: transcript,
      });
    }

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
      for (const file of files) {
        sources.push(file);
      }
    } catch {
      // Ignore missing or inaccessible memory workspace paths.
    }

    return sources;
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
}

function enrichMemoryPack(
  pack: MemoryContextPack,
  relationScope: MemoryRelationScope,
  candidatesById: Map<string, { sourceType: "transcript" | "file"; timestamp?: string; rankScore?: number }>,
): MemoryContextPack {
  return {
    ...pack,
    relationScope,
    citations: pack.citations.map((citation) => {
      const candidate = candidatesById.get(citation.candidateId);
      const selectionReason = candidate?.rankScore !== undefined
        ? `selected for lexical/recency score ${candidate.rankScore.toFixed(3)}`
        : "selected from reusable cached context";
      return {
        ...citation,
        provenance: {
          relationScope,
          freshness: classifyMemoryFreshness(candidate?.timestamp),
          selectionReason,
          sourceTimestamp: candidate?.timestamp,
        },
      };
    }),
  };
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

function classifyMemoryFreshness(timestamp?: string): MemoryFreshness {
  if (!timestamp) {
    return "unknown";
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return "unknown";
  }
  const ageHours = Math.max(0, Date.now() - parsed) / (60 * 60 * 1000);
  if (ageHours <= 1) {
    return "fresh";
  }
  if (ageHours <= 24 * 7) {
    return "recent";
  }
  return "stale";
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

function parseDistillerResponse(response: ChatCompletionResponse): {
  payload: DistillationPayload;
  citations: Array<{
    candidateId: string;
    sourceType: "transcript" | "file";
    sourceRef: string;
    snippet?: string;
    score: number;
  }>;
} {
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function calculateSavings(originalTokens: number, distilledTokens: number): number {
  if (originalTokens <= 0) {
    return 0;
  }
  return Number((((originalTokens - distilledTokens) / originalTokens) * 100).toFixed(2));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
