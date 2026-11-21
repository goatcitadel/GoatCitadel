import { createHash } from "node:crypto";
import {
  ConflictError,
  type MemoryContextComposeRequest,
  type MemoryContextCompositionDiagnostics,
} from "@goatcitadel/contracts";
import {
  currentEmbeddingProfile,
  EmbeddingUsageSettlementError,
  generateEmbedding,
  type AcquireLocalEmbeddingLease,
  type PrepareEmbeddingUsageDispatch,
} from "@goatcitadel/policy-engine";
import type { GatewayRuntimeConfig } from "../config.js";
import type { TrustedUtilityModelUsageLineage } from "./utility-model-usage-attribution.js";
import { throwIfMemoryContextAborted } from "./memory-context-utils.js";

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

export class MemoryContextQueryEmbedding {
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
    private readonly config: GatewayRuntimeConfig,
    private readonly acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease,
    private readonly prepareEmbeddingUsageDispatch?: PrepareEmbeddingUsageDispatch,
  ) {}

  public async resolve(
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
}
