import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type {
  MemoryCorpusSearchRequest,
  MemoryCorpusSearchResult,
  MemoryLearningRecord,
  MemoryRecallSourceType,
  RecallHit,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { MemorySourceInput } from "@goatcitadel/memory-core";
import { prepareMemoryToolWrite } from "@goatcitadel/policy-engine";
import type { AsyncStorage, WriteMemoryNoteInput } from "@goatcitadel/storage";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";

interface MemoryCorpusDependencies {
  readonly noteRepository?: Pick<AsyncStorage["memoryNotes"], "prepareWrite" | "write">;
  readonly recallRepository?: Pick<AsyncStorage["memoryRecall"], "searchEligibleCorpus" | "getEligibleSources">;
  readonly recallStorage?: Pick<AsyncStorage, "sessions" | "chatSessionMeta" | "chatSessionProjects" | "chatProjects">;
  readonly learnings?: Pick<AsyncStorage["memoryLearnings"], "list">;
  readonly writeGate?: MemoryWriteGateService;
  isMemoryRecallEnabled?: () => boolean;
  isCorpusRecallEnabled?: () => Promise<boolean>;
  isLearningRecallEnabled?: () => Promise<boolean>;
  augmentCorpusRecall?: (
    input: MemoryCorpusSearchRequest,
    result: MemoryCorpusSearchResult,
  ) => Promise<MemoryCorpusSearchResult>;
  resolveLearnedMemoryPolicy(sessionId: string): Promise<{ allowWrite: boolean }>;
}

/** Canonical corpus retrieval and tool lookup through the memory lifecycle owner. */
export class MemoryCorpusService {
  private readonly writeGate: MemoryWriteGateService;

  public constructor(private readonly deps: MemoryCorpusDependencies) {
    this.writeGate = deps.writeGate ?? new MemoryWriteGateService();
  }

  public async collectTrustedRecallSources(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<MemorySourceInput[]> {
    if (!this.deps.learnings || !this.deps.recallStorage || !(await this.deps.isLearningRecallEnabled?.())) return [];
    const storage = this.deps.recallStorage;
    let session;
    try {
      session = await storage.sessions.getBySessionId(input.sessionId);
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
    const meta = await storage.chatSessionMeta.get(input.sessionId);
    if (
      session.sessionId !== input.sessionId ||
      session.kind !== "dm" ||
      !meta ||
      meta.workspaceId !== input.workspaceId ||
      meta.lifecycleStatus !== "active"
    )
      return [];
    const assignment = await storage.chatSessionProjects.get(input.sessionId);
    const project = assignment ? await storage.chatProjects.find(assignment.projectId) : undefined;
    const records = await this.deps.learnings.list({ workspaceId: meta.workspaceId, status: "trusted", limit: 2000 });
    return records
      .filter((record) => {
        if (record.authority !== "operator" && record.authority !== "trusted_lifecycle") return false;
        const scope = record.claim?.identity.scope;
        if (scope?.kind === "session" && scope.id !== input.sessionId) return false;
        if (
          scope?.kind === "project" &&
          (scope.id !== project?.projectId ||
            project.workspaceId !== meta.workspaceId ||
            project.lifecycleStatus !== "active")
        )
          return false;
        return (
          this.writeGate.evaluate({
            authority: "trusted_lifecycle",
            content: record.insight,
          }).decision !== "blocked"
        );
      })
      .map((record) => ({
        type: "memory_learning",
        learningId: record.learningId,
        sourceHash: record.sourceHash!,
        title: record.key,
        content: record.insight,
        updatedAt: record.updatedAt,
        retrievalHints: [record.type, record.claim?.identity.predicate ?? ""],
      }));
  }

  public async searchEligibleCorpus(input: MemoryCorpusSearchRequest): Promise<MemoryCorpusSearchResult> {
    if (
      !this.deps.recallRepository ||
      this.deps.isMemoryRecallEnabled?.() === false ||
      (await this.deps.isCorpusRecallEnabled?.()) === false
    )
      return {
        hits: [],
        coverage: {
          generation: 0,
          indexedCount: 0,
          unindexedCount: 0,
          lexicalStatus: "unavailable",
          semanticStatus: "unavailable",
          reason: "Memory recall is unavailable.",
        },
      };
    const learningEnabled = (await this.deps.isLearningRecallEnabled?.()) === true;
    const sourceTypes = (input.sourceTypes ?? ["memory_item", "memory_learning", "knowledge_chunk"]).filter(
      (kind) => kind !== "memory_learning" || learningEnabled,
    );
    const lexical = await this.deps.recallRepository.searchEligibleCorpus({ ...input, sourceTypes });
    const result = this.deps.augmentCorpusRecall
      ? await this.deps.augmentCorpusRecall({ ...input, sourceTypes }, lexical)
      : lexical;
    return { ...result, hits: this.filterRecallSecrets(result.hits) };
  }

  public async validateRecallSources(input: {
    workspaceId: string;
    sessionId: string;
    sources: Array<{ sourceType: MemoryRecallSourceType; sourceRef: string }>;
  }): Promise<RecallHit[]> {
    if (!this.deps.recallRepository || this.deps.isMemoryRecallEnabled?.() === false) return [];
    const learningEnabled = (await this.deps.isLearningRecallEnabled?.()) === true;
    const sources = input.sources.filter((source) => source.sourceType !== "memory_learning" || learningEnabled);
    return this.filterRecallSecrets(await this.deps.recallRepository.getEligibleSources({ ...input, sources }));
  }

  private filterRecallSecrets(hits: RecallHit[]): RecallHit[] {
    return hits.filter(
      (hit) =>
        this.writeGate.evaluate({ authority: "trusted_lifecycle", content: `${hit.title}\n${hit.snippet}` })
          .decision !== "blocked",
    );
  }

  public async prepareMemoryWriteTool(
    request: ToolInvokeRequest,
  ): Promise<NonNullable<ToolInvokeRequest["memoryWriteBinding"]>> {
    if (
      !this.deps.noteRepository ||
      this.deps.isMemoryRecallEnabled?.() === false ||
      !(await this.deps.resolveLearnedMemoryPolicy(request.sessionId)).allowWrite
    )
      throw new ConflictError({
        message: "The canonical memory lifecycle write owner is unavailable for this session.",
      });
    const material = prepareMemoryToolWrite(request);
    return this.deps.noteRepository.prepareWrite({
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      namespace: material.namespace,
      title: material.title,
      trustLevel: material.trustLevel,
      upsert: request.toolName === "memory.upsert",
      ...(typeof request.args.expectedItemId === "string" ? { expectedItemId: request.args.expectedItemId } : {}),
      ...(typeof request.args.expectedSourceHash === "string"
        ? { expectedSourceHash: request.args.expectedSourceHash }
        : {}),
    });
  }

  public async writeMemoryTool(request: ToolInvokeRequest, input: Omit<WriteMemoryNoteInput, "binding" | "actorId">) {
    if (
      !request.memoryWriteBinding ||
      !this.deps.noteRepository ||
      this.deps.isMemoryRecallEnabled?.() === false ||
      !(await this.deps.resolveLearnedMemoryPolicy(request.sessionId)).allowWrite
    )
      throw new ConflictError({ message: "The reviewed memory write is unavailable for this session." });
    const material = prepareMemoryToolWrite(request);
    if (
      input.namespace !== material.namespace ||
      input.title !== material.title ||
      input.content !== material.content ||
      JSON.stringify(input.metadata) !== JSON.stringify(material.metadata) ||
      input.upsert !== (request.toolName === "memory.upsert")
    )
      throw new ConflictError({ message: "Memory material changed after review." });
    return this.deps.noteRepository.write({ ...input, binding: request.memoryWriteBinding, actorId: request.agentId });
  }

  public async readMemoryTool(request: ToolInvokeRequest): Promise<Record<string, unknown>> {
    const meta = await this.deps.recallStorage?.chatSessionMeta.get(request.sessionId);
    if (!meta || (request.workspaceId !== undefined && request.workspaceId !== meta.workspaceId)) {
      return { items: [], unavailable: true, reason: "The calling session has no matching memory workspace." };
    }
    const args = request.args;
    const query = [args.query, args.title, args.key].find((value) => typeof value === "string") as string | undefined;
    if (request.toolName === "memory.search" && !query?.trim()) throw new Error("memory.search requires a query");
    const limit = Math.max(
      1,
      Math.min(
        request.toolName === "memory.read" ? 50 : 100,
        Number.isFinite(args.limit) ? Math.floor(Number(args.limit)) : request.toolName === "memory.read" ? 5 : 12,
      ),
    );
    const result = await this.searchEligibleCorpus({
      workspaceId: meta.workspaceId,
      sessionId: request.sessionId,
      query: query?.slice(0, 8000) ?? "",
      namespace: typeof args.namespace === "string" ? args.namespace : undefined,
      limit,
    });
    const current = await this.validateRecallSources({
      workspaceId: meta.workspaceId,
      sessionId: request.sessionId,
      sources: result.hits,
    });
    const currentHashes = new Map(current.map((hit) => [`${hit.sourceType}:${hit.sourceRef}`, hit.sourceHash]));
    return {
      namespace: args.namespace ?? "all",
      query: query ?? "",
      coverage: result.coverage,
      ...(result.coverage.lexicalStatus === "unavailable" ? { unavailable: true } : {}),
      items: result.hits
        .filter((hit) => currentHashes.get(`${hit.sourceType}:${hit.sourceRef}`) === hit.sourceHash)
        .slice(0, limit)
        .map((hit) => ({
          sourceType: hit.sourceType,
          sourceRef: hit.sourceRef,
          sourceHash: hit.sourceHash,
          ...(hit.docId ? { docId: hit.docId, chunkId: hit.sourceRef } : {}),
          title: hit.title,
          snippet: hit.snippet.slice(0, 1200),
          score: hit.lexicalScore,
          attribution: {
            sourceType: "memory",
            sourceRef: hit.documentSourceRef ?? hit.sourceRef,
            title: hit.title,
            trustLevel: hit.trustLevel ?? "trusted_workspace",
          },
        })),
    };
  }

  public async collectTrustedStandingLearnings(workspaceId: string): Promise<MemoryLearningRecord[]> {
    if (!workspaceId.trim() || !this.deps.learnings || !(await this.deps.isLearningRecallEnabled?.())) return [];
    return (await this.deps.learnings.list({ workspaceId, status: "trusted", limit: 2000 })).filter(
      (record) =>
        record.type === "operator_preference" &&
        (record.authority === "operator" || record.authority === "trusted_lifecycle") &&
        (!record.claim ||
          (record.claim.identity.scope.kind === "workspace" && record.claim.identity.scope.id === workspaceId)),
    );
  }
}
