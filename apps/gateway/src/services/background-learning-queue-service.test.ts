import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import type { BackgroundLearningReadiness, LearningReviewSource } from "@goatcitadel/contracts";
import {
  BackgroundLearningQueueService,
  type BackgroundLearningQueueDeps,
} from "./background-learning-queue-service.js";
const fixtures: Array<{ storage: Storage; root: string }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.storage.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
const source = (index: number): LearningReviewSource => ({
  workspaceId: "default",
  sessionId: "s",
  sessionIncarnationId: "incarnation",
  controllerGeneration: 1,
  parentRunId: `parent-${index}`,
  postCommitGenerationId: `generation-${index}`,
  sourceTurnId: `turn-${index}`,
  effectExecutionId: `effect-${index}`,
  sourceHash: "a".repeat(64),
});
const ready = (): BackgroundLearningReadiness => ({
  source: { state: "ready" },
  provider: { state: "ready" },
  budget: { state: "ready" },
  memory: { state: "ready" },
  skill: { state: "disabled" },
  maintenance: { state: "disabled" },
  canExtractMemory: true,
  canDraftSkill: false,
  canEvaluateMaintenance: false,
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-learning-queue-"));
  const storage = new Storage({
    dbPath: path.join(root, "fixture.sqlite"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  fixtures.push({ storage, root });
  let now = Date.now(),
    foreground = false;
  const asynchronous = createSqliteAsyncStorage(storage);
  const extract = vi.fn(async () => [
    { kind: "preference" as const, content: "Prefer concise replies", confidence: 0.9 },
  ]);
  const propose = vi.fn(async () => ["candidate-1"]);
  const deps: BackgroundLearningQueueDeps = {
    storage: asynchronous,
    backgroundReview: {
      extractTurnMemoryFacts: extract,
      suggestTurnSkill: vi.fn(async () => ({ shouldAuthor: false })),
    },
    readiness: async () => ready(),
    readDestinations:async()=>({memory:true,skill:false,maintenance:false}),
    estimateBudget:async()=>({providerId:"llamacpp",model:"fixture",pricingCatalogVersion:"fixture",pricingCatalogHash:"b".repeat(64),reservedCostUsd:0,dailyCostCeilingUsd:1}),
    isSharedLocalModel: async () => true,
    hasForegroundExecution: () => foreground,
    now: () => now,
    inspectSource: async (input) => ({
      source: { ...input, sourceHash: "a".repeat(64) },
      userText: `I prefer concise replies from ${input.sourceTurnId}.`,
      assistantText: "Acknowledged.",
    }),
    sourceEffectsAreSettled: async () => true,
    proposeMemory: propose,
    readSettlement: async () => "settled",
  };
  return {
    storage,
    asynchronous,
    deps,
    extract,
    propose,
    clock: (value: number) => {
      now = value;
    },
    foreground: (value: boolean) => {
      foreground = value;
    },
    service: () => new BackgroundLearningQueueService(deps),
  };
}
it("coalesces three pending turns into one bounded extraction and replays proposals without another provider call", async () => {
  const f = fixture(),
    service = f.service();
  const queued = f.storage.backgroundLearningJobs.enqueue({ source: source(1), kind: "review", due: true });
  for (const index of [2, 3])
    f.storage.backgroundLearningJobs.enqueue({ source: source(index), kind: "review", due: false });
  const job = f.storage.backgroundLearningJobs.get(queued.jobId)!;
  const run = f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
    runId: job.runId,
    workerId: "worker",
    leaseDurationMs: 60_000,
  })!;
  expect(await service.process(run)).toMatchObject({ disposition: "complete", candidateIds: ["candidate-1"] });
  expect(f.extract).toHaveBeenCalledTimes(1);
  for (const index of [1, 2, 3]) expect(f.extract.mock.calls[0]![0]).toContain(`turn-${index}`);
  expect(f.propose).toHaveBeenCalledWith(
    expect.anything(),
    expect.arrayContaining([source(1), source(2), source(3)]),
    expect.anything(),
  );
  expect(await f.service().process(run)).toMatchObject({ disposition: "complete" });
  expect(f.extract).toHaveBeenCalledTimes(1);
  expect(f.propose).toHaveBeenCalledTimes(1);
});
it("publishes proposal references only after their stage commits; an SSE outage never repeats paid work",async()=>{
  const f=fixture();let insideTransaction=false;
  const original=f.asynchronous.runImmediateTransaction.bind(f.asynchronous);
  f.deps.storage=new Proxy(f.asynchronous,{get:(target,key)=>key==="runImmediateTransaction" ? async(callback:any)=>{insideTransaction=true;try{return await original(callback);}finally{insideTransaction=false;}}:Reflect.get(target,key)});
  const notify=vi.fn(async(input:any)=>{expect(insideTransaction).toBe(false);expect(f.storage.backgroundLearningJobs.get(input.jobId)!.candidateIds).toContain("candidate-1");throw new Error("synthetic realtime outage");});Object.assign(f.deps,{publishCommittedProposals:notify});
  const queued=f.storage.backgroundLearningJobs.enqueue({source:source(1),kind:"review",due:true}),job=f.storage.backgroundLearningJobs.get(queued.jobId)!,run=f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({runId:job.runId,workerId:"worker",leaseDurationMs:60_000})!;
  expect(await f.service().process(run)).toMatchObject({disposition:"complete",candidateIds:["candidate-1"]});expect(notify).toHaveBeenCalledExactlyOnceWith({jobId:job.jobId,workspaceId:"default",sessionId:"s",candidateIds:["candidate-1"],skillProposalIds:[]});
  expect(await f.service().process(run)).toMatchObject({disposition:"complete"});expect(f.extract).toHaveBeenCalledTimes(1);expect(f.propose).toHaveBeenCalledTimes(1);expect(notify).toHaveBeenCalledTimes(1);
});
it("a rolled-back filing publishes nothing and its retry reuses the settled inference",async()=>{
  const f=fixture(),notify=vi.fn(async()=>{});Object.assign(f.deps,{publishCommittedProposals:notify});f.deps.proposeMemory=async()=>{throw new Error("synthetic filing failure");};
  const queued=f.storage.backgroundLearningJobs.enqueue({source:source(1),kind:"review",due:true}),job=f.storage.backgroundLearningJobs.get(queued.jobId)!,run=f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({runId:job.runId,workerId:"worker",leaseDurationMs:60_000})!;
  await expect(f.service().process(run)).rejects.toThrow("synthetic filing failure");expect(notify).not.toHaveBeenCalled();expect(f.storage.backgroundLearningJobs.get(job.jobId)!.candidateIds).toEqual([]);
  f.deps.proposeMemory=f.propose;expect(await f.service().process(run)).toMatchObject({disposition:"complete"});expect(f.extract).toHaveBeenCalledTimes(1);expect(notify).toHaveBeenCalledTimes(1);
});
it("waits for fifteen seconds of local foreground quiet and age never overrides a live turn", async () => {
  const f = fixture(),
    service = f.service(),
    now = Date.now();
  f.clock(now);
  f.storage.durableRuns.createRun({
    runId: "foreground",
    workflowKey: "chat.turn.execute",
    status: "completed",
    now: new Date(now).toISOString(),
  });
  const queued = f.storage.backgroundLearningJobs.enqueue({ source: source(1), kind: "review", due: true });
  const job = f.storage.backgroundLearningJobs.get(queued.jobId)!;
  const run = f.storage.durableRuns.getRun(job.runId);
  expect(await service.isReadyToClaim(run)).toBe(false);
  f.clock(now + 14999);
  expect(await service.isReadyToClaim(run)).toBe(false);
  f.clock(now + 15000);
  expect(await service.isReadyToClaim(run)).toBe(true);
  f.foreground(true);
  f.clock(now + 31 * 60_000);
  expect(await service.isReadyToClaim(run)).toBe(false);
  expect(f.extract).not.toHaveBeenCalled();
});
it("foreground_preemption_does_not_retry_an_unknown_paid_dispatch", async () => {
  const f = fixture(),
    service = f.service();
  f.deps.readSettlement = async () => "unknown";
  f.deps.backgroundReview.extractTurnMemoryFacts = vi.fn(async (_user, _assistant, signal) => {
    service.notifyForegroundActivity();
    signal!.throwIfAborted();
    return [];
  });
  const queued = f.storage.backgroundLearningJobs.enqueue({ source: source(1), kind: "review", due: true }),
    job = f.storage.backgroundLearningJobs.get(queued.jobId)!;
  const run = f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
    runId: job.runId,
    workerId: "worker",
    leaseDurationMs: 60_000,
  })!;
  expect(await service.process(run)).toMatchObject({
    disposition: "deferred",
    reasonCode: "usage_reconciliation_required",
  });
  expect(f.storage.backgroundLearningJobs.get(job.jobId)!.status).toBe("awaiting_reconciliation");
  expect(await f.service().isReadyToClaim(run)).toBe(false);
  expect(await f.service().process(run)).toMatchObject({
    disposition: "deferred",
    reasonCode: "usage_reconciliation_required",
  });
  expect(f.deps.backgroundReview.extractTurnMemoryFacts).toHaveBeenCalledTimes(1);
  expect(f.propose).not.toHaveBeenCalled();
});
it.each(["changed","oversized"])("records a %s coalesced source and drains valid neighbors across service restarts",async(reason)=>{
  const f=fixture(),queued=f.storage.backgroundLearningJobs.enqueue({source:source(1),kind:"review",due:true});
  for(const index of [2,3])f.storage.backgroundLearningJobs.enqueue({source:source(index),kind:"review",due:false});
  f.deps.inspectSource=async identity=>identity.sourceTurnId==="turn-2" && reason==="changed" ? undefined : {source:{...identity,sourceHash:"a".repeat(64)},userText:identity.sourceTurnId==="turn-2" ? "ordinary evidence ".repeat(600):`Valid evidence ${identity.sourceTurnId}`,assistantText:"Completed"};
  const run=f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({runId:f.storage.backgroundLearningJobs.get(queued.jobId)!.runId,workerId:"worker",leaseDurationMs:60_000})!;
  for(let restart=0;restart<6;restart++){if((await f.service().process(run)).disposition==="complete")break;}
  const job=f.storage.backgroundLearningJobs.get(queued.jobId)!;
  expect(job.status).toBe("completed");expect(job.cursor).toBe(3);
  expect(job).toMatchObject({sourceDispositions:[expect.objectContaining({sourceIndex:1,sourceTurnId:"turn-2",sourceHash:"a".repeat(64),reason:reason==="changed"?"source_changed":"source_size_limit"})]});
  expect(f.extract).toHaveBeenCalledTimes(2);
  expect(f.extract.mock.calls.map(call=>String(call[0])).join("\n")).toContain("turn-1");
  expect(f.extract.mock.calls.map(call=>String(call[0])).join("\n")).toContain("turn-3");
  expect(f.propose.mock.calls.flatMap(call=>(call[1] as LearningReviewSource[]).map(item=>item.sourceTurnId))).toEqual(["turn-1","turn-3"]);
  await f.service().process(run);expect(f.extract).toHaveBeenCalledTimes(2);
});
it("reclaims an older oversized-source deferral",async()=>{
  const f=fixture(),queued=f.storage.backgroundLearningJobs.enqueue({source:source(1),kind:"review",due:true});
  const run=f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({runId:f.storage.backgroundLearningJobs.get(queued.jobId)!.runId,workerId:"worker",leaseDurationMs:60_000})!;
  const claim={runId:run.runId,leaseOwnerId:run.leaseOwnerId!},frozen=f.storage.backgroundLearningJobs.freeze(queued.jobId,claim);
  f.storage.backgroundLearningJobs.defer(queued.jobId,claim,frozen.revision,"source_requires_expansion");
  f.deps.inspectSource=async identity=>({source:{...identity,sourceHash:"a".repeat(64)},userText:"ordinary evidence ".repeat(600),assistantText:"Completed"});
  expect(await f.service().isReadyToClaim(run)).toBe(true);
  expect(await f.service().process(run)).toMatchObject({disposition:"complete",reasonCode:"source_size_limit"});
  expect(f.extract).not.toHaveBeenCalled();
});
it.each(["turn-1","turn-2"])("discards settled output from a changed %s batch before separately reviewing its valid neighbor",async(staleTurn)=>{
  const f=fixture(),queued=f.storage.backgroundLearningJobs.enqueue({source:source(1),kind:"review",due:true});
  f.storage.backgroundLearningJobs.enqueue({source:source(2),kind:"review",due:false});
  let destination=true,changed=false,calls=0;
  f.deps.readDestinations=async()=>({memory:destination,skill:false,maintenance:false});
  f.extract.mockImplementation(async()=>{if(++calls===1)destination=false;return [{kind:"preference",content:"Prefer concise replies",confidence:.9}];});
  const inspect=f.deps.inspectSource;f.deps.inspectSource=async identity=>changed && identity.sourceTurnId===staleTurn ? undefined:inspect(identity);
  const run=f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({runId:f.storage.backgroundLearningJobs.get(queued.jobId)!.runId,workerId:"worker",leaseDurationMs:60_000})!;
  expect(await f.service().process(run)).toMatchObject({disposition:"deferred",reasonCode:"learning_not_ready"});
  const operation=f.storage.backgroundLearningJobs.get(queued.jobId)!.operation!;expect(operation.status).toBe("settled");
  destination=true;changed=true;
  for(let restart=0;restart<8;restart++){if((await f.service().process(run)).disposition==="complete")break;}
  const job=f.storage.backgroundLearningJobs.get(queued.jobId)!;
  expect(job.status).toBe("completed");expect(job.discardedBatches).toContainEqual(expect.objectContaining({from:0,through:2,operationId:operation.operationId,reason:"source_batch_changed"}));
  expect(job.sourceDispositions).toContainEqual(expect.objectContaining({sourceTurnId:staleTurn,reason:"source_changed"}));
  expect(f.propose.mock.calls.flatMap(call=>(call[1] as LearningReviewSource[]).map(item=>item.sourceTurnId))).toEqual([staleTurn==="turn-1" ? "turn-2":"turn-1"]);
  expect(f.extract).toHaveBeenCalledTimes(2);await f.service().process(run);expect(f.extract).toHaveBeenCalledTimes(2);
});
it("cancels changed sources and holds disabled destinations without model dispatch", async () => {
  const f = fixture(),
    service = f.service(),
    queued = f.storage.backgroundLearningJobs.enqueue({ source: source(1), kind: "review", due: true }),
    job = f.storage.backgroundLearningJobs.get(queued.jobId)!;
  f.deps.readiness = async () => ({ ...ready(), canExtractMemory: false });
  expect(await service.isReadyToClaim(f.storage.durableRuns.getRun(job.runId))).toBe(false);
  f.deps.readiness = async () => ready();
  f.deps.inspectSource = async () => undefined;
  const run = f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
    runId: job.runId,
    workerId: "worker",
    leaseDurationMs: 60_000,
  })!;
  expect(await service.process(run)).toMatchObject({ disposition: "complete", reasonCode: "source_changed" });
  expect(f.extract).not.toHaveBeenCalled();
  expect(f.propose).not.toHaveBeenCalled();
});

it("retains inactive extraction output while usage is unknown and reuses it after accounting reconciliation",async()=>{
  const f=fixture();let settlement:"unknown"|"settled"="unknown";
  f.deps.readSettlement=async()=>settlement;
  const queued=f.storage.backgroundLearningJobs.enqueue({source:source(1),kind:"review",due:true});
  const job=f.storage.backgroundLearningJobs.get(queued.jobId)!;
  const run=f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({runId:job.runId,workerId:"worker",leaseDurationMs:60_000})!;
  expect(await f.service().process(run)).toMatchObject({disposition:"deferred",reasonCode:"usage_reconciliation_required"});
  expect(f.storage.backgroundLearningJobs.get(job.jobId)!.operation?.result).toHaveProperty("facts");
  expect(f.propose).not.toHaveBeenCalled();settlement="settled";
  f.deps.readiness=async()=>({...ready(),budget:{state:"blocked",reasonCode:"budget_exhausted"},canExtractMemory:false});
  expect(await f.service().process(run)).toMatchObject({disposition:"complete",candidateIds:["candidate-1"]});
  expect(f.extract).toHaveBeenCalledTimes(1);expect(f.propose).toHaveBeenCalledTimes(1);
});

it("files an already settled proposal when the last model call consumed the remaining budget",async()=>{
  const f=fixture();
  f.deps.backgroundReview.extractTurnMemoryFacts=vi.fn(async()=>{
    f.deps.readiness=async()=>({...ready(),budget:{state:"blocked",reasonCode:"budget_exhausted"},canExtractMemory:false});
    return [{kind:"preference" as const,content:"Prefer concise replies",confidence:.9}];
  });
  const queued=f.storage.backgroundLearningJobs.enqueue({source:source(1),kind:"review",due:true}),job=f.storage.backgroundLearningJobs.get(queued.jobId)!;
  const run=f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({runId:job.runId,workerId:"worker",leaseDurationMs:60_000})!;
  expect(await f.service().process(run)).toMatchObject({disposition:"complete",candidateIds:["candidate-1"]});
  expect(f.propose).toHaveBeenCalledTimes(1);
});
