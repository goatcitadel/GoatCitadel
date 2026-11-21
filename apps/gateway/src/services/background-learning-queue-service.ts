import {
  redactSecretText,
  type BackgroundLearningReadiness,
  type DurableRunRecord,
  type LearningReviewJob,
  type LearningReviewSource,
  type LearningReviewClaim,
  type OperatorProfileFact,
  type LearningDispatchBudget,
} from "@goatcitadel/contracts";
import { learningReviewStageKey, type AsyncStorage } from "@goatcitadel/storage";
import {logger} from "@goatcitadel/gateway-core";
import {
  buildBackgroundReviewOperationId,
  type BackgroundReviewService,
  type BackgroundReviewSkillSuggestion,
} from "./background-review-service.js";

type SourceInput = Omit<LearningReviewSource, "sourceHash">;
type SourcePacket = { source: LearningReviewSource; userText: string; assistantText: string };
export interface LearningReviewOutcome {
  disposition: "complete" | "deferred";
  reasonCode?: string;
  jobId: string;
  candidateIds: string[];
  skillProposalIds: string[];
}
export interface BackgroundLearningQueueDeps {
  storage: Pick<AsyncStorage, "backgroundLearningJobs" | "durableRuns" | "runImmediateTransaction">;
  backgroundReview: Pick<BackgroundReviewService, "extractTurnMemoryFacts" | "suggestTurnSkill">;
  readiness(input: { workspaceId: string; sessionId: string }): Promise<BackgroundLearningReadiness>;
  readDestinations?(input:{workspaceId:string;sessionId:string}):Promise<{memory:boolean;skill:boolean;maintenance:boolean}>;
  estimateBudget(input:{stage:"memory"|"skill";userText:string;assistantText:string}):Promise<LearningDispatchBudget|undefined>;
  /** Storage/config-only fence used inside the parent's enqueue transaction. */
  admitQueueWrite?(input: {
    workspaceId: string;
    sessionId: string;
    kind?: "review" | "maintenance";
  }): Promise<boolean>;
  isSharedLocalModel(): Promise<boolean>;
  hasForegroundExecution(): boolean;
  inspectSource(input: SourceInput, allowSettlingChild?: boolean): Promise<SourcePacket | undefined>;
  sourceEffectsAreSettled(source: LearningReviewSource): Promise<boolean>;
  proposeMemory(
    job: LearningReviewJob,
    sources: LearningReviewSource[],
    facts: OperatorProfileFact[],
  ): Promise<string[]>;
  proposeSkill?(
    job: LearningReviewJob,
    sources: LearningReviewSource[],
    suggestion: BackgroundReviewSkillSuggestion,
  ): Promise<string[]>;
  /** Read-only refresh signal after canonical proposal and stage persistence. */
  publishCommittedProposals?(input:{jobId:string;workspaceId:string;sessionId:string;candidateIds:string[];skillProposalIds:string[]}):Promise<void>;
  /** Tests may supply an explicit accounting fixture; production reads its repository. */
  readSettlement?(operationId: string): Promise<"settled" | "not_started" | "unknown">;
  now?: () => number;
}

/** Runs only through the existing durable worker. No independent scheduler. */
export class BackgroundLearningQueueService {
  private readonly activeLocalReviews = new Set<AbortController>();
  public constructor(private readonly deps: BackgroundLearningQueueDeps) {}
  public notifyForegroundActivity(): void {
    for (const controller of this.activeLocalReviews) controller.abort(new Error("Foreground work has priority."));
  }
  public close(): void {
    this.notifyForegroundActivity();
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  public async enqueueLearningReview(
    input: SourceInput & { kind?: "review" | "maintenance"; due: boolean },
  ): Promise<{ jobId?: string; disposition: "queued" | "deduplicated" | "disabled" }> {
    const admitted = this.deps.admitQueueWrite
      ? await this.deps.admitQueueWrite(input)
      : await this.deps
          .readiness(input)
          .then((readiness) =>
            input.kind === "maintenance"
              ? readiness.canEvaluateMaintenance
              : readiness.canExtractMemory || readiness.canDraftSkill,
          );
    if (!admitted) return { disposition: "disabled" };
    const { kind = "review", due, ...identity } = input;
    const packet = await this.deps.inspectSource(identity, true);
    if (!packet || containsSecret(packet) || !(await this.deps.sourceEffectsAreSettled(packet.source)))
      return { disposition: "disabled" };
    const destinations=await this.destinations({workspaceId:identity.workspaceId,sessionId:identity.sessionId});
    const requested:Array<"memory"|"skill">=[];
    if(kind === "maintenance" ? destinations.maintenance:destinations.memory) requested.push("memory");
    if(kind === "review" && destinations.skill) requested.push("skill");
    if(!requested.length) return {disposition:"disabled"};
    return await this.deps.storage.backgroundLearningJobs.enqueue({
      source: packet.source,
      kind,
      due,
      destinations:requested,
      now: new Date(this.now()).toISOString(),
    });
  }
  public async isReadyToClaim(run: DurableRunRecord): Promise<boolean> {
    const job = await this.readJob(run);
    if (!job || ["completed", "cancelled"].includes(job.status)) return true;
    if (job.reasonCode === "paid_result_unavailable") return false;
    if (job.operation && ["dispatching", "unknown"].includes(job.operation.status))
      return (await this.settlement(job.operation.operationId)) !== "unknown";
    if (job.status === "awaiting_reconciliation") return false;
    if(hasPendingSettledOutput(job) && await this.destinationEnabled(job,job.operation!.stage)) return !(await this.foregroundBusy());
    const readiness = await this.deps.readiness(job);
    // An invalid source must be allowed to settle as cancelled, without a model.
    if (readiness.source.state === "blocked") return readiness.source.reasonCode !== "autonomy_disabled";
    if (
      !(job.kind === "maintenance"
        ? readiness.canEvaluateMaintenance
        : readiness.canExtractMemory || readiness.canDraftSkill)
    )
      return false;
    if (!job.due && this.now() - Date.parse(job.firstQueuedAt) < 30 * 60_000) return false;
    return !(await this.foregroundBusy());
  }
  public async process(run: DurableRunRecord, signal?: AbortSignal): Promise<LearningReviewOutcome> {
    const original = await this.readJob(run);
    if (!original || !run.leaseOwnerId)
      throw new Error("Learning workflow is missing its canonical job or worker lease.");
    const claim = { runId: run.runId, leaseOwnerId: run.leaseOwnerId };
    if (["completed", "cancelled"].includes(original.status)) return outcome(original, "complete");
    if (await this.foregroundBusy()) return outcome(original, "deferred", "foreground_priority");
    let job = await this.deps.storage.backgroundLearningJobs.freeze(original.jobId, claim);
    if (job.operation && ["dispatching", "unknown"].includes(job.operation.status)) {
      const settlement = await this.settlement(job.operation.operationId);
      if (settlement === "settled" && !job.operation.result) {
        // Known cost is not the lost model output. Reconcile/review before a
        // new paid generation; never invent an empty successful extraction.
        job = await this.deps.storage.backgroundLearningJobs.defer(
          job.jobId,
          claim,
          job.revision,
          "paid_result_unavailable",
        );
        return outcome(job, "deferred", "paid_result_unavailable");
      }
      job = await this.deps.storage.backgroundLearningJobs.settleDispatch(
        job.jobId,
        claim,
        job.revision,
        settlement,
        job.operation.result,
      );
      if (settlement === "unknown") return outcome(job, "deferred", "usage_reconciliation_required");
    }
    const readiness = await this.deps.readiness(job);
    if (readiness.source.state === "blocked") {
      if(readiness.source.reasonCode === "autonomy_disabled") return outcome(job,"deferred","autonomy_disabled");
      job = await this.deps.storage.backgroundLearningJobs.defer(
        job.jobId,
        claim,
        job.revision,
        "source_ineligible",
        true,
      );
      return outcome(job, "complete", "source_ineligible");
    }
    if (
      !hasPendingSettledOutput(job) && !(job.kind === "maintenance"
        ? readiness.canEvaluateMaintenance
        : readiness.canExtractMemory || readiness.canDraftSkill)
    )
      return outcome(job, "deferred", "learning_not_ready");
    const packets: SourcePacket[] = [];
    let chars = 0;
    for (const source of job.sources.slice(job.cursor)) {
      const packet = await this.currentSource(source);
      if (!packet) {
        if(job.operation?.status==="settled") {
          job=await this.deps.storage.backgroundLearningJobs.discardSourceBatch(job.jobId,claim,job.revision);
          return outcome(job,"deferred","source_batch_changed");
        }
        if(packets.length) break;
        job = await this.deps.storage.backgroundLearningJobs.excludeCurrentSource(job.jobId,claim,job.revision,"source_changed");
        return outcome(job,job.status==="completed" ? "complete":"deferred","source_changed");
      }
      const length = packet.userText.length + packet.assistantText.length + 2 * packet.source.sourceTurnId.length + 120;
      if (chars + length > 7200) {
        if(packets.length)break;
        if(job.operation?.status==="settled") {
          job=await this.deps.storage.backgroundLearningJobs.discardSourceBatch(job.jobId,claim,job.revision);
          return outcome(job,"deferred","source_batch_changed");
        }
        job=await this.deps.storage.backgroundLearningJobs.excludeCurrentSource(job.jobId,claim,job.revision,"source_size_limit");
        return outcome(job,job.status==="completed" ? "complete":"deferred","source_size_limit");
      }
      packets.push(packet);
      chars += length;
    }
    if (!packets.length) {
      job = await this.deps.storage.backgroundLearningJobs.defer(
        job.jobId,
        claim,
        job.revision,
        "source_requires_expansion",
      );
      return outcome(job, "deferred", "source_requires_expansion");
    }
    const from = job.cursor,
      through = from + packets.length;
    if(job.operation?.status==="settled" && (job.operation.from!==from || job.operation.through!==through)) {
      job=await this.deps.storage.backgroundLearningJobs.discardSourceBatch(job.jobId,claim,job.revision);
      return outcome(job,"deferred","source_batch_changed");
    }
    const userText = packets
      .map((packet) => `[Operator source ${packet.source.sourceTurnId}]\n${packet.userText}`)
      .join("\n\n");
    const assistantText = packets
      .map((packet) => `[Assistant context; proposal only; ${packet.source.sourceTurnId}]\n${packet.assistantText}`)
      .join("\n\n");
    for (const stage of ["memory", "skill"] as const) {
      if (job.completedStages.includes(learningReviewStageKey({ stage, from, through }))) continue;
      if (!(job.destinations ?? ["memory"]).includes(stage)) {
        job = await this.deps.storage.backgroundLearningJobs.recordStageResult(job.jobId, claim, job.revision, {
          stage,
          from,
          through,
        });
        continue;
      }
      if(!(await this.destinationEnabled(job,stage))) return outcome(job,"deferred","learning_not_ready");
      if(stage === "skill" && !this.deps.proposeSkill) return outcome(job,"deferred","skill_writer_unavailable");
      if (await this.foregroundBusy()) return outcome(job, "deferred", "foreground_priority");
      signal?.throwIfAborted();
      const utilityKind = stage === "memory" ? "background_memory_extraction" : "background_skill_suggestion";
      let operation = job.operation;
      if (
        !operation ||
        operation.stage !== stage ||
        operation.from !== from ||
        operation.through !== through ||
        operation.status === "not_started"
      ) {
        const current=await this.deps.readiness(job);
        if(stage === "memory" ? !(job.kind === "maintenance" ? current.canEvaluateMaintenance:current.canExtractMemory):!current.canDraftSkill) return outcome(job,"deferred","learning_not_ready");
        const operationRoot = `learning:${job.jobId}:batch:${from}:${through}:dispatch:${job.dispatchGeneration + 1}`;
        const operationId = buildBackgroundReviewOperationId(utilityKind, "", { operationId: operationRoot });
        const budget=await this.deps.estimateBudget({stage,userText,assistantText});
        if(!budget) return outcome(job,"deferred","pricing_unavailable");
        const admitted = await this.deps.storage.backgroundLearningJobs.beginDispatch(
          job.jobId,
          claim,
          { operationId, stage, from, through,budget },
          job.revision,
        );
        if(!admitted) return outcome(job,"deferred","budget_exhausted");
        job=admitted;
        operation = job.operation!;
        const controller = new AbortController();
        const sharedLocal = await this.deps.isSharedLocalModel();
        if (sharedLocal) this.activeLocalReviews.add(controller);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let result: Record<string, unknown> | undefined;
        try {
          // Recheck source hashes immediately before dispatch. Extraction is
          // tool-free and happens outside every database transaction.
          for (const packet of packets)
            if (!(await this.currentSource(packet.source))) throw new Error("Learning source changed before dispatch.");
          if (await this.foregroundBusy()) controller.abort(new Error("Foreground work has priority."));
          combined.throwIfAborted();
          const lineage = {
            workspaceId: job.workspaceId,
            sessionId: job.sessionId,
            sourceTurnId: packets[0]!.source.sourceTurnId,
            effectExecutionId: job.runId,
            operationId: operationRoot,
            admittedModel:{providerId:budget.providerId,model:budget.model},
          };
          result =
            stage === "memory"
              ? {
                  facts: await this.deps.backgroundReview.extractTurnMemoryFacts(
                    userText,
                    assistantText,
                    combined,
                    lineage,
                  ),
                }
              : {
                  suggestion: await this.deps.backgroundReview.suggestTurnSkill(
                    userText,
                    assistantText,
                    combined,
                    lineage,
                  ),
                };
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          this.activeLocalReviews.delete(controller);
          const settlement = await this.settlement(operation.operationId);
          job = await this.deps.storage.backgroundLearningJobs.settleDispatch(
            job.jobId,
            claim,
            job.revision,
            settlement,
            result,
          );
        }
        if (job.operation?.status !== "settled")
          return outcome(
            job,
            "deferred",
            job.operation?.status === "unknown" ? "usage_reconciliation_required" : "dispatch_not_started",
          );
      }
      if (!job.operation?.result) return outcome(job, "deferred", "paid_result_unavailable");
      // Filing already-settled proposal data needs current destination/source
      // authority, not another provider slot or another inference budget.
      if(!(await this.destinationEnabled(job,stage))) return outcome(job,"deferred","learning_not_ready");
      let committedReferences:{candidateIds:string[];skillProposalIds:string[]}|undefined;
      job = await this.deps.storage.runImmediateTransaction(async () => {
        // Session/source locks precede the queue partition and worker locks,
        // matching the parent post-commit admission order.
        let sourcesCurrent=true;
        for(const packet of packets) if(!(await this.currentSource(packet.source))) sourcesCurrent=false;
        const locked = await this.deps.storage.backgroundLearningJobs.lockForProcessing(job.jobId, claim);
        if (locked.completedStages.includes(learningReviewStageKey({ stage, from, through }))) return locked;
        if(!sourcesCurrent) return await this.deps.storage.backgroundLearningJobs.discardSourceBatch(locked.jobId,claim,locked.revision);
        if(!(await this.destinationEnabled(locked,stage))) return locked;
        const result = locked.operation!.result!;
        const candidateIds =
          stage === "memory"
            ? await this.deps.proposeMemory(
                locked,
                packets.map((packet) => packet.source),
                result.facts as OperatorProfileFact[],
              )
            : [];
        const skillProposalIds =
          stage === "skill"
            ? await this.deps.proposeSkill!(
                locked,
                packets.map((packet) => packet.source),
                result.suggestion as BackgroundReviewSkillSuggestion,
              )
            : [];
        const recorded=await this.deps.storage.backgroundLearningJobs.recordStageResult(locked.jobId, claim, locked.revision, {
          stage,
          from,
          through,
          candidateIds,
          skillProposalIds,
        });
        committedReferences={candidateIds,skillProposalIds};
        return recorded;
      });
      if(committedReferences && (committedReferences.candidateIds.length || committedReferences.skillProposalIds.length)){
        try{await this.deps.publishCommittedProposals?.({jobId:job.jobId,workspaceId:job.workspaceId,sessionId:job.sessionId,...committedReferences});}
        catch{logger.warn("Learning proposals saved; realtime refresh unavailable",{jobId:job.jobId,stage});}
      }
      if(job.status === "cancelled") return outcome(job,"complete",job.reasonCode);
      if(job.reasonCode === "source_batch_changed" && !job.operation) return outcome(job,"deferred","source_batch_changed");
      if(!job.completedStages.includes(learningReviewStageKey({stage,from,through}))) return outcome(job,"deferred","learning_not_ready");
    }
    job = await this.deps.storage.backgroundLearningJobs.advance(job.jobId, claim, job.revision, through);
    return outcome(
      job,
      job.status === "completed" ? "complete" : "deferred",
      job.status === "completed" ? undefined : "remaining_sources",
    );
  }
  /** Reuses durable retry readiness; policy deferral consumes no failed attempt. */
  public async releaseForRetry(run: DurableRunRecord, result: LearningReviewOutcome): Promise<void> {
    await this.deps.storage.runImmediateTransaction(async () => {
      const current = await this.deps.storage.durableRuns.lockFreshActiveLeaseForUpdate(run.runId, run.leaseOwnerId!);
      if (!current) throw new Error("Learning worker lease changed before yield.");
      await this.deps.storage.durableRuns.upsertRetryWithDatabaseClock({
        runId: run.runId,
        attemptNo: Math.max(1, current.attemptCount),
        reason: result.reasonCode ?? "learning_deferred",
        delayMs: result.reasonCode === "remaining_sources" ? 1000 : 15_000,
      });
      await this.deps.storage.durableRuns.createCheckpoint({
        runId: run.runId,
        checkpointKind: "run_waiting",
        state: { ...result, kind: "learning_review_deferral", authority: "system_proposal_only" },
      });
      await this.deps.storage.durableRuns.updateRun({
        runId: run.runId,
        status: "queued",
        clearLease: true,
        metadata: { ...current.metadata, learningReviewDisposition: result.reasonCode },
        expectedVersion: current.version,
      });
    });
  }
  private async currentSource(source: LearningReviewSource): Promise<SourcePacket | undefined> {
    const { sourceHash, ...identity } = source;
    const packet = await this.deps.inspectSource(identity);
    return packet &&
      packet.source.sourceHash === sourceHash &&
      !containsSecret(packet) &&
      (await this.deps.sourceEffectsAreSettled(source))
      ? packet
      : undefined;
  }
  private async readJob(run: DurableRunRecord): Promise<LearningReviewJob | undefined> {
    if (
      run.workflowKey !== "learning.review" ||
      run.payload.version !== "learning.review.v1" ||
      typeof run.payload.jobId !== "string"
    )
      return undefined;
    const job = await this.deps.storage.backgroundLearningJobs.get(run.payload.jobId);
    if (job && job.runId !== run.runId) throw new Error("Learning workflow binding changed.");
    return job;
  }
  private async settlement(operationId: string) {
    return await (this.deps.readSettlement?.(operationId) ??
      this.deps.storage.backgroundLearningJobs.readOperationSettlement(operationId));
  }
  private async destinations(input:{workspaceId:string;sessionId:string}) {
    if(this.deps.readDestinations) return await this.deps.readDestinations(input);
    const current=await this.deps.readiness(input);
    return {memory:current.canExtractMemory,skill:current.canDraftSkill,maintenance:current.canEvaluateMaintenance};
  }
  private async destinationEnabled(job:LearningReviewJob,stage:"memory"|"skill"):Promise<boolean> {
    const current=await this.destinations(job);
    return stage === "memory" ? job.kind === "maintenance" ? current.maintenance:current.memory : current.skill;
  }
  private async foregroundBusy(): Promise<boolean> {
    if (!(await this.deps.isSharedLocalModel())) return false;
    const state = await this.deps.storage.backgroundLearningJobs.readForegroundActivity();
    return (
      this.deps.hasForegroundExecution() ||
      state.active ||
      Boolean(state.lastActivityAt && this.now() - Date.parse(state.lastActivityAt) < 15_000)
    );
  }
}
function hasPendingSettledOutput(job:LearningReviewJob):boolean {
  return job.operation?.status === "settled" && Boolean(job.operation.result) && !job.completedStages.includes(learningReviewStageKey(job.operation));
}
function containsSecret(packet: SourcePacket): boolean {
  return (
    redactSecretText(`${packet.userText}\n${packet.assistantText}`.normalize("NFKC"), { env: process.env })
      .redactionCount > 0
  );
}
function outcome(
  job: LearningReviewJob,
  disposition: LearningReviewOutcome["disposition"],
  reasonCode?: string,
): LearningReviewOutcome {
  return {
    disposition,
    jobId: job.jobId,
    candidateIds: job.candidateIds,
    skillProposalIds: job.skillProposalIds,
    ...(reasonCode ? { reasonCode } : {}),
  };
}
