import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  ValidationError,
  type LearningReviewJob,
  type LearningReviewSource,
  type LearningReviewClaim,
  type LearningDispatchBudget,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import type { SystemSettingsRepository } from "./system-settings-repo.js";
import type { DurableRunRepository } from "./durable-run-repo.js";
import {CostLedgerRepository} from "./cost-ledger-repo.js";
import {BackgroundLearningBudgetRepository,LearningBudgetDenied} from "./background-learning-budget-repo.js";

/** Existing transactional settings and durable-run authorities store data-only
 * job records. No model call, timer, grants or callback crosses this repository. */
export class BackgroundLearningJobRepository {
  private readonly budgets:BackgroundLearningBudgetRepository;
  public constructor(
    private readonly db: DatabaseClient,
    private readonly settings: SystemSettingsRepository,
    private readonly runs: DurableRunRepository,
    costs?:CostLedgerRepository,
  ) {this.budgets=new BackgroundLearningBudgetRepository(settings,costs ?? new CostLedgerRepository(db));}
  public get(jobId: string): LearningReviewJob | undefined {
    identifier(jobId);
    const value = this.settings.get<LearningReviewJob>(jobKey(jobId))?.value;
    if (
      value &&
      (value.version !== 1 ||
        value.jobId !== jobId ||
        !Array.isArray(value.sources) ||
        value.sources.length > 50 ||
        JSON.stringify(value).length > 256_000)
    )
      throw new ValidationError({ message: "Invalid persisted learning job." });
    return value;
  }
  public readBudgetSnapshot(now:string) {return this.budgets.readSnapshot(now);}
  /** Bounded, scoped receipt lookup; returns one extra row for honest coverage. */
  public listForSourceTurn(workspaceId:string,sessionId:string,turnId:string):LearningReviewJob[]{
    const predicate=this.db.dialect==="postgres" ? `(value_json::jsonb->>'workspaceId')=@workspaceId AND (value_json::jsonb->>'sessionId')=@sessionId AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(value_json::jsonb->'sources')='array' THEN value_json::jsonb->'sources' ELSE '[]'::jsonb END) AS source WHERE source->>'sourceTurnId'=@turnId)`:`json_extract(value_json,'$.workspaceId')=@workspaceId AND json_extract(value_json,'$.sessionId')=@sessionId AND EXISTS(SELECT 1 FROM json_each(value_json,'$.sources') AS source WHERE json_extract(source.value,'$.sourceTurnId')=@turnId)`;
    const rows=this.db.prepare(`SELECT setting_key FROM system_settings WHERE setting_key LIKE 'background_learning_job_v1:%' AND ${predicate} ORDER BY updated_at DESC,setting_key DESC LIMIT 51`).all<{setting_key:string}>({workspaceId,sessionId,turnId});
    return rows.flatMap(row=>{const job=this.get(row.setting_key.slice("background_learning_job_v1:".length));return job && job.workspaceId===workspaceId && job.sessionId===sessionId && job.sources.some(source=>source.sourceTurnId===turnId) ? [job]:[];});
  }
  public enqueue(input: { source: LearningReviewSource; kind: "review" | "maintenance";destinations?:("memory"|"skill")[]; due: boolean; now?: string }): {
    jobId: string;
    disposition: "queued" | "deduplicated";
  } {
    validateSource(input.source);
    if (!["review", "maintenance"].includes(input.kind))
      throw new ValidationError({ message: "Invalid learning destination." });
    const now = input.now ?? new Date().toISOString(),
      source = input.source;
    const destinations=[...new Set(input.destinations ?? ["memory"] as const)].sort();
    if(!destinations.length || destinations.some(value=>value !== "memory" && value !== "skill")) throw new ValidationError({message:"Invalid learning destinations."});
    let result!: { jobId: string; disposition: "queued" | "deduplicated" };
    this.db.transaction("immediate", () => {
      this.settings.mutate<{ pendingJobId?: string }>(
        partitionKey({ ...source, kind: input.kind,destinations }),
        {},
        (current) => {
          const sourceKey = `background_learning_source_v1:${encodeURIComponent(source.effectExecutionId)}:${input.kind}`;
          const linked = this.settings.get<{ jobId: string; source: LearningReviewSource }>(sourceKey)?.value;
          if (linked) {
            if (canonicalJsonString(linked.source) !== canonicalJsonString(source))
              throw new ConflictError({ message: "Learning source binding changed." });
            result = { jobId: linked.jobId, disposition: "deduplicated" };
            return current;
          }
          let job = current.pendingJobId ? this.get(current.pendingJobId) : undefined;
          if (
            !job ||
            job.frozenAt ||
            !["pending", "deferred", "delayed"].includes(job.status) ||
            job.sources.length >= 50
          ) {
            const jobId = `blj-${hash(`${partitionKey({ ...source, kind: input.kind,destinations })}:${source.effectExecutionId}`).slice(0, 40)}`,
              runId = `learning-review:${jobId}`;
            job = {
              version: 1,
              jobId,
              runId,
              workspaceId: source.workspaceId,
              sessionId: source.sessionId,
              sessionIncarnationId: source.sessionIncarnationId,
              controllerGeneration: source.controllerGeneration,
              kind: input.kind,
              destinations,
              status: "pending",
              revision: 0,
              sources: [],
              due: false,
              firstQueuedAt: now,
              updatedAt: now,
              cursor: 0,
              dispatchGeneration: 0,
              candidateIds: [],
              skillProposalIds: [],
              completedStages: [],
            };
            this.runs.createRun({
              runId,
              workflowKey: "learning.review",
              payload: { version: "learning.review.v1", jobId },
              metadata: {
                workspaceId: source.workspaceId,
                sessionId: source.sessionId,
                jobId,
                authority: "system_proposal_only",
              },
              maxAttempts: 3,
              now,
            });
          }
          job = {
            ...job,
            sources: [...job.sources, source],
            due: job.due || input.due,
            revision: job.revision + 1,
            updatedAt: now,
          };
          this.settings.set(jobKey(job.jobId), job, now);
          this.settings.set(sourceKey, { jobId: job.jobId, source }, now);
          result = { jobId: job.jobId, disposition: "queued" };
          return { pendingJobId: job.jobId };
        },
        now,
      );
    });
    return result;
  }
  public freeze(jobId: string, claim: LearningReviewClaim): LearningReviewJob {
    return this.update(jobId, claim, undefined, (job) =>
      job.status === "completed" || job.status === "cancelled"
        ? job
        : {
            ...job,
            frozenAt: job.frozenAt ?? new Date().toISOString(),
            status: job.status === "awaiting_reconciliation" ? job.status : "running",
          },
    );
  }
  public beginDispatch(
    jobId: string,
    claim: LearningReviewClaim,
    input: Pick<NonNullable<LearningReviewJob["operation"]>, "operationId" | "stage" | "from" | "through">&{budget?:LearningDispatchBudget},
    expectedRevision: number,
  ): LearningReviewJob|undefined {
    try {return this.update(jobId, claim, expectedRevision, (job) => {
      if (
        job.status !== "running" ||
        (job.operation &&
          ((job.operation.status !== "settled" && job.operation.status !== "not_started") ||
            (job.operation.status === "settled" && !job.completedStages.includes(stageKey(job.operation)))))
      )
        throw new ConflictError({ message: "Learning dispatch requires settled previous work." });
      if (
        !input.operationId ||
        input.operationId.length > 500 ||
        !Number.isInteger(input.from) ||
        !Number.isInteger(input.through) ||
        input.from < job.cursor ||
        input.through <= input.from ||
        input.through > job.sources.length ||
        !["memory", "skill"].includes(input.stage)
      )
        throw new ValidationError({ message: "Invalid learning dispatch window." });
      const budgetDay=input.budget ? this.budgets.reserve(jobId,input.operationId,input.budget,this.runs.readDatabaseNow()):undefined;
      return {
        ...job,
        dispatchGeneration: job.dispatchGeneration + 1,
        operation: { ...input,...(budgetDay ? {budgetDay}: {}), generation: job.dispatchGeneration + 1, status: "dispatching" },
      };
    });} catch(error) {if(error instanceof LearningBudgetDenied) return undefined;throw error;}
  }
  public settleDispatch(
    jobId: string,
    claim: LearningReviewClaim,
    expectedRevision: number,
    status: "settled" | "not_started" | "unknown",
    result?: Record<string, unknown>,
  ): LearningReviewJob {
    return this.update(jobId, claim, expectedRevision, (job) => {
      if (!job.operation || !["dispatching", "unknown"].includes(job.operation.status))
        throw new ConflictError({ message: "No matching learning dispatch to settle." });
      if(job.operation.budget && job.operation.budgetDay) {
        let actualCostUsd:number|undefined;
        if(status === "settled") {
          if(job.operation.budget.reservedCostUsd === 0) actualCostUsd=0;
          else {
            if(this.readOperationSettlement(job.operation.operationId)!=="settled") throw new ConflictError({message:"Paid learning usage remains unsettled."});
            const row=this.db.prepare(`SELECT SUM(cost_usd) AS cost FROM model_usage_events WHERE operation_id = ? AND transport_status = 'accepted'`).get<{cost:number|null}>(job.operation.operationId);
            actualCostUsd=row?.cost === null ? undefined:Number(row?.cost);
          }
        }
        if(status === "not_started" && this.readOperationSettlement(job.operation.operationId)!=="not_started") throw new ConflictError({message:"A dispatched learning request cannot be refunded without reconciliation."});
        this.budgets.settle(jobId,job.operation.operationId,job.operation.budgetDay,status,actualCostUsd);
      }
      return {
        ...job,
        status: status === "unknown" ? "awaiting_reconciliation" : "running",
        operation: { ...job.operation, status,result:status === "not_started" ? undefined:result ?? job.operation.result },
      };
    });
  }
  /** Call in the same owner transaction as the proposal writes. */
  public recordStageResult(
    jobId: string,
    claim: LearningReviewClaim,
    expectedRevision: number,
    input: {
      stage: "memory" | "skill";
      from: number;
      through: number;
      candidateIds?: string[];
      skillProposalIds?: string[];
    },
  ): LearningReviewJob {
    return this.update(jobId, claim, expectedRevision, (job) => {
      const key = stageKey(input);
      if (job.completedStages.includes(key)) return job;
      return {
        ...job,
        completedStages: [...job.completedStages, key],
        stageResults:[...(job.stageResults ?? []),{stage:input.stage,from:input.from,through:input.through,candidateIds:input.candidateIds ?? [],skillProposalIds:input.skillProposalIds ?? []}],
        candidateIds: [...new Set([...job.candidateIds, ...(input.candidateIds ?? [])])],
        skillProposalIds: [...new Set([...job.skillProposalIds, ...(input.skillProposalIds ?? [])])],
      };
    });
  }
  public advance(
    jobId: string,
    claim: LearningReviewClaim,
    expectedRevision: number,
    through: number,
  ): LearningReviewJob {
    return this.update(jobId, claim, expectedRevision, (job) => {
      if (
        !Number.isInteger(through) ||
        through < job.cursor ||
        through > job.sources.length ||
        !["memory", "skill"].every((stage) =>
          job.completedStages.includes(stageKey({ stage, from: job.cursor, through })),
        )
      )
        throw new ConflictError({ message: "Learning source window is not fully settled." });
      return {
        ...job,
        cursor: through,
        status: through === job.sources.length ? "completed" : "running",
        operation: undefined,
      };
    });
  }
  /** Exact frozen source dispositions do not cancel unrelated sources in the same job. */
  public excludeCurrentSource(jobId:string,claim:LearningReviewClaim,expectedRevision:number,reason:"source_changed"|"source_size_limit"):LearningReviewJob {
    return this.update(jobId,claim,expectedRevision,job=>{
      if(job.operation && ["dispatching","unknown"].includes(job.operation.status)) throw new ConflictError({message:"Unsettled learning usage must be reconciled first."});
      const source=job.sources[job.cursor];
      if(!source) throw new ConflictError({message:"Learning source cursor changed."});
      const cursor=job.cursor+1;
      return {...job,cursor,status:cursor===job.sources.length ? "completed":"running",operation:undefined,reasonCode:reason,
        sourceDispositions:[...(job.sourceDispositions ?? []),{sourceIndex:job.cursor,sourceTurnId:source.sourceTurnId,sourceHash:source.sourceHash,reason,recordedAt:new Date().toISOString()}]};
    });
  }
  /** A settled result influenced by a stale source is retained as a discard receipt, never reused. */
  public discardSourceBatch(jobId:string,claim:LearningReviewClaim,expectedRevision:number):LearningReviewJob {
    return this.update(jobId,claim,expectedRevision,job=>{
      if(!job.operation || job.operation.status!=="settled") throw new ConflictError({message:"Only settled learning output can be discarded."});
      return {...job,status:"running",operation:undefined,reasonCode:"source_batch_changed",discardedBatches:[...(job.discardedBatches ?? []),{
        from:job.operation.from,through:job.operation.through,operationId:job.operation.operationId,reason:"source_batch_changed",recordedAt:new Date().toISOString()}]};
    });
  }
  public defer(
    jobId: string,
    claim: LearningReviewClaim,
    expectedRevision: number,
    reasonCode: string,
    cancel = false,
  ): LearningReviewJob {
    if (!/^[a-z_]{1,80}$/u.test(reasonCode)) throw new ValidationError({ message: "Invalid learning disposition." });
    return this.update(jobId, claim, expectedRevision, (job) => ({
      ...job,
      status: cancel ? "cancelled" : "deferred",
      reasonCode,
    }));
  }
  public lockForProcessing(jobId: string, claim: LearningReviewClaim): LearningReviewJob {
    return this.update(jobId, claim, undefined, (job) => job);
  }
  private update(
    jobId: string,
    claim: LearningReviewClaim,
    expectedRevision: number | undefined,
    change: (job: LearningReviewJob) => LearningReviewJob,
  ): LearningReviewJob {
    return this.db.transaction("immediate", () => {
      const initial = this.get(jobId);
      if (!initial) throw new ConflictError({ message: "Learning job is missing." });
      let next!: LearningReviewJob;
      // Enqueue and freeze share this lock: a source cannot be appended from a
      // stale pre-freeze read while another worker is sealing the source set.
      this.settings.mutate<{ pendingJobId?: string }>(partitionKey(initial), {}, (partition) => {
        const run = this.runs.lockFreshActiveLeaseForUpdate(claim.runId, claim.leaseOwnerId);
        if (!run || run.workflowKey !== "learning.review" || run.payload.jobId !== jobId)
          throw new ConflictError({ message: "Learning worker lease changed." });
        this.settings.mutate<LearningReviewJob>(jobKey(jobId), initial, (job) => {
          if (
            !job ||
            job.runId !== claim.runId ||
            (expectedRevision !== undefined && expectedRevision !== job.revision)
          )
            throw new ConflictError({ message: "Learning job revision changed." });
          next = { ...change(job), revision: job.revision + 1, updatedAt: new Date().toISOString() };
          if (
            JSON.stringify(next).length > 256_000 ||
            next.completedStages.length > 100 ||
            next.candidateIds.length > 400 ||
            next.skillProposalIds.length > 50
          )
            throw new ValidationError({ message: "Learning job exceeds its bound." });
          return next;
        });
        return partition;
      });
      return next;
    });
  }
  public readForegroundActivity(): { active: boolean; lastActivityAt?: string } {
    const recent = this.db
      .prepare(
        `SELECT updated_at FROM durable_runs WHERE workflow_key = 'chat.turn.execute' ORDER BY updated_at DESC LIMIT 1`,
      )
      .get<{ updated_at: string }>();
    const active = this.db
      .prepare(
        `SELECT run_id FROM durable_runs WHERE workflow_key = 'chat.turn.execute' AND status IN ('queued','running') LIMIT 1`,
      )
      .get<{ run_id: string }>();
    return { active: Boolean(active), ...(recent ? { lastActivityAt: recent.updated_at } : {}) };
  }
  public readOperationSettlement(operationId: string): "settled" | "not_started" | "unknown" {
    if (!operationId || operationId.length > 500) throw new ValidationError({ message: "Invalid learning operation." });
    const rows = this.db
      .prepare(
        `SELECT transport_status,dispatch_reconciliation,terminal_outcome,input_tokens,output_tokens,cost_usd FROM model_usage_events WHERE operation_id = ? ORDER BY started_at LIMIT 65`,
      )
      .all<{
        transport_status: string;
        dispatch_reconciliation: string | null;
        terminal_outcome: string;
        input_tokens: number | null;
        output_tokens: number | null;
        cost_usd: number | null;
      }>(operationId);
    if (rows.length > 64) return "unknown";
    const dispatched = rows.filter((row) => row.dispatch_reconciliation !== "confirmed_not_dispatched");
    if (!dispatched.length) return "not_started";
    return dispatched.every(
      (row) =>
        row.transport_status === "accepted" &&
        row.terminal_outcome !== "in_flight" &&
        row.input_tokens !== null &&
        row.output_tokens !== null &&
        row.cost_usd !== null,
    )
      ? "settled"
      : "unknown";
  }
  public readEligibleSource(
    input: Omit<LearningReviewSource, "sourceHash">,
    allowSettlingChild = false,
  ): { source: LearningReviewSource; userText: string; assistantText: string } | undefined {
    validateSource({ ...input, sourceHash: "0".repeat(64) });
    return this.db.transaction("immediate",()=>{
      // Match session mutation authority's lock order before touching message,
      // parent or child rows. Multi-table FOR SHARE alone has no fixed order.
      const suffix=this.db.dialect === "postgres" ? " FOR SHARE":"";
      const meta=this.db.prepare(`SELECT session_id FROM chat_session_meta WHERE session_id = ? AND workspace_id = ?${suffix}`).get(input.sessionId,input.workspaceId);
      if(!meta) return undefined;
      const control=this.db.prepare(`SELECT session_id FROM chat_session_control_grants WHERE session_id = ? AND workspace_id = ? AND is_current = 1${suffix}`).get(input.sessionId,input.workspaceId);
      if(!control) return undefined;
      return this.readEligibleSourceLocked(input,allowSettlingChild);
    });
  }
  private readEligibleSourceLocked(
    input:Omit<LearningReviewSource,"sourceHash">,allowSettlingChild:boolean,
  ):{source:LearningReviewSource;userText:string;assistantText:string}|undefined {
    validateSource({ ...input, sourceHash: "0".repeat(64) });
    const row = this.db
      .prepare(
        `SELECT u.message_id AS user_id,u.content AS user_text,a.message_id AS assistant_id,a.content AS assistant_text,
      meta.lifecycle_intent_id,control.generation AS control_generation,parent.payload_json AS parent_payload,parent.status AS parent_status,
      child.metadata_json AS child_metadata,child.status AS child_status,t.finished_at
      FROM chat_turn_traces t JOIN chat_messages u ON u.message_id = t.user_message_id AND u.session_id = t.session_id
      JOIN chat_messages a ON a.message_id = t.assistant_message_id AND a.session_id = t.session_id
      JOIN chat_session_meta meta ON meta.session_id = t.session_id JOIN sessions s ON s.session_id = t.session_id
      JOIN chat_session_control_grants control ON control.session_id = t.session_id AND control.is_current = 1
      JOIN durable_runs parent ON parent.run_id = @parentRunId JOIN durable_runs child ON child.run_id = @effectExecutionId
      WHERE t.turn_id = @sourceTurnId AND t.session_id = @sessionId AND t.status = 'completed' AND t.finished_at IS NOT NULL AND t.memory_mode <> 'off'
        AND meta.workspace_id = @workspaceId AND meta.lifecycle_status = 'active' AND meta.origin = 'operator' AND meta.deletion_intent_id IS NULL
        AND s.kind = 'dm' AND control.owner_kind = 'operator' AND control.lease_state = 'operator_active'
        AND u.role = 'user' AND u.actor_type = 'user' AND u.source_authority = 'operator' AND u.parent_delegation_step_id IS NULL
        AND a.role = 'assistant' AND a.actor_type = 'agent' AND a.parent_delegation_step_id IS NULL
      ${this.db.dialect === "postgres" ? "FOR SHARE OF t,u,a,meta,s,control,parent,child" : ""}`,
      )
      .get<{
        user_id: string;
        user_text: string;
        assistant_id: string;
        assistant_text: string;
        lifecycle_intent_id: string | null;
        control_generation: number | string;
        parent_payload: string;
        parent_status: string;
        child_metadata: string | null;
        child_status: string;
        finished_at: string;
      }>({
        parentRunId: input.parentRunId,
        effectExecutionId: input.effectExecutionId,
        sourceTurnId: input.sourceTurnId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
      });
    if (
      !row ||
      row.parent_status !== "completed" ||
      !(row.child_status === "completed" || (allowSettlingChild && row.child_status === "running")) ||
      Number(row.control_generation) !== input.controllerGeneration ||
      (row.lifecycle_intent_id ?? `legacy-session-incarnation:${input.sessionId}`) !== input.sessionIncarnationId
    )
      return undefined;
    const parent = JSON.parse(row.parent_payload) as Record<string, unknown>,
      child = JSON.parse(row.child_metadata ?? "{}") as Record<string, unknown>;
    if (
      parent.version !== "chat.turn.execute.v2" ||
      parent.workspaceId !== input.workspaceId ||
      parent.sessionId !== input.sessionId ||
      parent.turnId !== input.sourceTurnId ||
      parent.sessionIncarnationId !== input.sessionIncarnationId ||
      parent.admissionControllerGeneration !== input.controllerGeneration ||
      child.parentRunId !== input.parentRunId ||
      child.postCommitGenerationId !== input.postCommitGenerationId ||
      child.turnId !== input.sourceTurnId ||
      child.workspaceId !== input.workspaceId ||
      child.sessionId !== input.sessionId
    )
      return undefined;
    const sourceHash = hash(
      canonicalJsonString([input, row.user_id, row.user_text, row.assistant_id, row.assistant_text, row.finished_at]),
    );
    return { source: { ...input, sourceHash }, userText: row.user_text, assistantText: row.assistant_text };
  }
}
export function learningReviewStageKey(input: { stage: string; from: number; through: number }): string {
  return stageKey(input);
}
function stageKey(input: { stage: string; from: number; through: number }): string {
  return `${input.stage}:${input.from}:${input.through}`;
}
function identifier(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 300)
    throw new ValidationError({ message: "Invalid learning identity." });
}
function validateSource(source: LearningReviewSource): void {
  for (const key of [
    "workspaceId",
    "sessionId",
    "sessionIncarnationId",
    "parentRunId",
    "postCommitGenerationId",
    "sourceTurnId",
    "effectExecutionId",
  ] as const)
    identifier(source[key]);
  if (
    !Number.isSafeInteger(source.controllerGeneration) ||
    source.controllerGeneration < 1 ||
    !/^[a-f0-9]{64}$/u.test(source.sourceHash)
  )
    throw new ValidationError({ message: "Invalid learning source version." });
}
function jobKey(jobId: string): string {
  identifier(jobId);
  return `background_learning_job_v1:${jobId}`;
}
function partitionKey(
  value: Pick<
    LearningReviewJob,
    "workspaceId" | "sessionId" | "sessionIncarnationId" | "controllerGeneration" | "kind" | "destinations"
  >,
): string {
  return `background_learning_partition_v1:${hash(JSON.stringify([value.workspaceId, value.sessionId, value.sessionIncarnationId, value.controllerGeneration, value.kind,value.destinations ?? ["memory"]]))}`;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
