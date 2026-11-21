import path from "node:path";
import { redactSecretText, redactStructuredSecrets } from "@goatcitadel/contracts";
import type {
  MemoryContextAccessReceipt,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryCorpusSearchRequest,
  MemoryCorpusSearchResult,
  MemoryRecallSourceType,
  MemoryRelationScope,
  RecallHit,
} from "@goatcitadel/contracts";
import type { MemoryItemSource, MemorySourceInput } from "@goatcitadel/memory-core";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { walkMemoryFiles } from "./memory-file-walk.js";
import {
  extractMemoryEmbedding,
  extractMemoryRetrievalHints,
  resolveMemoryRelationScope,
  throwIfMemoryContextAborted,
} from "./memory-context-utils.js";

const DEFAULT_MEMORY_WORKSPACE_ID = "default";

export interface MemoryCorpusReadPort {
  enabled?: () => Promise<boolean>;
  search(input: MemoryCorpusSearchRequest): Promise<MemoryCorpusSearchResult>;
  validate(input: {
    workspaceId: string;
    sessionId: string;
    sources: Array<{ sourceType: MemoryRecallSourceType; sourceRef: string }>;
  }): Promise<RecallHit[]>;
}

export type ReadTrustedLearnings = (input: { workspaceId: string; sessionId: string }) => Promise<MemorySourceInput[]>;

/** Collects prompt sources and resolves the current canonical versions of their citations. */
export class MemoryContextSourceReader {
  public constructor(
    private readonly storage: Pick<Storage, "memoryRecall" | "chatSessionMeta" | "chatDelegationSteps" | "transcripts">,
    private readonly config: Pick<GatewayRuntimeConfig, "rootDir" | "assistant" | "toolPolicy">,
    private readonly collectTrustedLearnings?: ReadTrustedLearnings,
    private readonly corpusRead?: MemoryCorpusReadPort,
  ) {}

  public async collect(
    input: MemoryContextComposeRequest,
    accessReceipt: MemoryContextAccessReceipt,
    queryEmbedding?: MemoryCorpusSearchRequest["queryEmbedding"],
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
    if (this.corpusRead && (await this.corpusRead.enabled?.()) !== false) {
      if (input.sessionId) {
        const result = await this.corpusRead.search({
          workspaceId: await this.resolveMemoryItemWorkspaceId(input),
          sessionId: input.sessionId,
          query: input.prompt,
          limit: 300,
          queryEmbedding,
        });
        sources.push(...result.hits.filter(isTrustedRecallHit).map(recallHitSource));
      }
    } else {
      for (const item of await this.collectMemoryItemSources(input)) sources.push(item);
      if (input.sessionId && this.collectTrustedLearnings) {
        sources.push(
          ...(await this.collectTrustedLearnings({
            workspaceId: await this.resolveMemoryItemWorkspaceId(input),
            sessionId: input.sessionId,
          })),
        );
      }
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

  private async collectMemoryItemSources(input: MemoryContextComposeRequest): Promise<MemoryItemSource[]> {
    if (!input.sessionId || !this.storage.memoryRecall?.listEligibleMemoryItemSources) return [];
    try {
      const items = await this.storage.memoryRecall.listEligibleMemoryItemSources({
        workspaceId: await this.resolveMemoryItemWorkspaceId(input),
        sessionId: input.sessionId,
        limit: 300,
      });
      return items.filter(isTrustedRecallHit).map((item) => ({
        type: "memory_item",
        itemId: item.sourceRef,
        sourceHash: item.sourceHash,
        namespace: item.namespace ?? "memory",
        title: item.title,
        content: item.snippet,
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

  public async readCurrentSources(
    input: MemoryContextComposeRequest,
    citations: MemoryContextPack["citations"],
  ): Promise<MemorySourceInput[]> {
    return input.sessionId && this.corpusRead
      ? (
          await this.corpusRead.validate({
            workspaceId: await this.resolveMemoryItemWorkspaceId(input),
            sessionId: input.sessionId,
            sources: citations.map((citation) => ({
              sourceType: citation.sourceType as MemoryRecallSourceType,
              sourceRef: citation.sourceRef,
            })),
          })
        ).map(recallHitSource)
      : input.sessionId
        ? [
            ...(this.storage.memoryRecall?.getEligibleSources
              ? (
                  await this.storage.memoryRecall.getEligibleSources({
                    workspaceId: await this.resolveMemoryItemWorkspaceId(input),
                    sessionId: input.sessionId,
                    sources: citations
                      .filter((citation) => citation.sourceType === "memory_item")
                      .map((citation) => ({ sourceType: "memory_item" as const, sourceRef: citation.sourceRef })),
                  })
                )
                  .filter(isTrustedRecallHit)
                  .map(recallHitSource)
              : []),
            ...(this.collectTrustedLearnings
              ? await this.collectTrustedLearnings({
                  workspaceId: await this.resolveMemoryItemWorkspaceId(input),
                  sessionId: input.sessionId,
                })
              : []),
          ]
        : [];
  }
}

function recallHitSource(hit: RecallHit): MemorySourceInput {
  const common = {
    title: hit.title,
    content: hit.snippet,
    updatedAt: hit.updatedAt,
    sourceHash: hit.sourceHash,
    indexedSemanticScore: hit.semanticScore,
  };
  if (hit.sourceType === "memory_learning") return { type: "memory_learning", learningId: hit.sourceRef, ...common };
  if (hit.sourceType === "knowledge_chunk") return { type: "knowledge_chunk", chunkId: hit.sourceRef, ...common };
  return { type: "memory_item", itemId: hit.sourceRef, namespace: "memory", ...common };
}

function isTrustedRecallHit(hit: RecallHit): boolean {
  return (
    hit.trustLevel !== "untrusted_external" &&
    hit.trustLevel !== "mixed_untrusted" &&
    redactSecretText(`${hit.title}\n${hit.snippet}`.normalize("NFKC"), { env: process.env }).redactionCount === 0 &&
    redactStructuredSecrets("metadata" in hit ? hit.metadata : {}, { env: process.env }).redactionCount === 0
  );
}

async function readTranscriptOrEmpty(storage: Pick<Storage, "transcripts">, sessionId: string) {
  try {
    return await storage.transcripts.read(sessionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
