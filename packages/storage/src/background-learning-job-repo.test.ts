import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { BackgroundLearningJobRepository } from "./background-learning-job-repo.js";
import type { LearningReviewSource } from "@goatcitadel/contracts";
import { SessionRepository } from "./session-repo.js";
import { SessionControlRepository } from "./session-control-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
function fixture() {
  const db = files.open({ dbPath: files.path("learning-queue") });
  const settings = new SystemSettingsRepository(db),
    runs = new DurableRunRepository(db);
  return { db, settings, runs, repo: new BackgroundLearningJobRepository(db, settings, runs) };
}
const source = (index: number): LearningReviewSource => ({
  workspaceId: "A",
  sessionId: "s",
  sessionIncarnationId: "incarnation-1",
  controllerGeneration: 1,
  parentRunId: `parent-${index}`,
  postCommitGenerationId: `generation-${index}`,
  sourceTurnId: `turn-${index}`,
  effectExecutionId: `effect-${index}`,
  sourceHash: "a".repeat(64),
});
it("coalesces pending sources, deduplicates effect settlement and freezes a running source revision", () => {
  const f = fixture(),
    first = f.repo.enqueue({ source: source(1), kind: "review", due: true });
  assert.equal(f.repo.enqueue({ source: source(1), kind: "review", due: true }).disposition, "deduplicated");
  for (const index of [2, 3])
    assert.equal(f.repo.enqueue({ source: source(index), kind: "review", due: false }).jobId, first.jobId);
  const pending = f.repo.get(first.jobId)!;
  assert.equal(pending.sources.length, 3);
  assert.deepEqual(f.repo.listForSourceTurn("A","s","turn-1").map(job=>job.jobId),[first.jobId]);
  assert.deepEqual(f.repo.listForSourceTurn("foreign","s","turn-1"),[]);
  const claimed = f.runs.tryClaimQueuedRunWithDatabaseClock({
    runId: pending.runId,
    workerId: "worker",
    leaseDurationMs: 60_000,
  })!;
  const claim = { runId: claimed.runId, leaseOwnerId: claimed.leaseOwnerId! };
  const frozen = f.repo.freeze(first.jobId, claim);
  assert.equal(frozen.sources.length, 3);
  const fourth = f.repo.enqueue({ source: source(4), kind: "review", due: false });
  assert.notEqual(fourth.jobId, first.jobId);
  assert.equal(f.repo.get(first.jobId)!.sources.length, 3);
  const restarted = new BackgroundLearningJobRepository(f.db, f.settings, f.runs);
  assert.equal(restarted.get(fourth.jobId)!.sources[0]!.sourceTurnId, "turn-4");
  assert.throws(() =>
    restarted.enqueue({ source: { ...source(1), sourceHash: "b".repeat(64) }, kind: "review", due: true }),
  );
});
it("bounds source sets at fifty, preserves enqueue age and fences dispatch checkpoints", () => {
  const f = fixture();
  const first = f.repo.enqueue({ source: source(1), kind: "review", due: true, now: "2026-11-18T01:00:00.000Z" });
  for (let index = 2; index <= 50; index++)
    assert.equal(f.repo.enqueue({ source: source(index), kind: "review", due: false }).jobId, first.jobId);
  assert.notEqual(f.repo.enqueue({ source: source(51), kind: "review", due: true }).jobId, first.jobId);
  const job = f.repo.get(first.jobId)!;
  assert.equal(job.firstQueuedAt, "2026-11-18T01:00:00.000Z");
  assert.equal(job.sources.length, 50);
  assert.throws(() => f.repo.freeze(first.jobId, { runId: job.runId, leaseOwnerId: "other" }));
  const run = f.runs.tryClaimQueuedRunWithDatabaseClock({
    runId: job.runId,
    workerId: "worker",
    leaseDurationMs: 60_000,
  })!;
  const claim = { runId: run.runId, leaseOwnerId: "worker" };
  const frozen = f.repo.freeze(first.jobId, claim);
  const dispatch = f.repo.beginDispatch(
    first.jobId,
    claim,
    { operationId: "review-operation", stage: "memory", from: 0, through: 3 },
    frozen.revision,
  );
  assert.ok(dispatch);
  assert.equal(dispatch.operation?.status, "dispatching");
  assert.throws(() =>
    f.repo.beginDispatch(
      first.jobId,
      claim,
      { operationId: "replacement", stage: "memory", from: 0, through: 3 },
      frozen.revision,
    ),
  );
  f.repo.settleDispatch(first.jobId, claim, dispatch.revision, "unknown");
  assert.equal(f.repo.get(first.jobId)!.status, "awaiting_reconciliation");
  assert.throws(() =>
    f.repo.beginDispatch(
      first.jobId,
      claim,
      { operationId: "replayed-paid-call", stage: "memory", from: 0, through: 3 },
      f.repo.get(first.jobId)!.revision,
    ),
  );
});
it("binds source bytes to the current private session incarnation, controller and completed parent effect", () => {
  const f = fixture(),
    now = new Date().toISOString();
  new SessionRepository(f.db).upsert({
    sessionId: "s",
    sessionKey: "s",
    kind: "dm",
    channel: "web",
    account: "operator",
    timestamp: now,
  });
  const meta = new ChatSessionMetaRepository(f.db);
  meta.ensure("s", now, "default");
  meta.patch("s", { origin: "operator" });
  new SessionControlRepository(f.db).initializeExistingSession({
    workspaceId: "default",
    sessionId: "s",
    idempotencyKey: "init-queue",
    correlationId: "init-queue",
  });
  const messages = new ChatMessageRepository(f.db);
  messages.upsert({
    messageId: "u",
    sessionId: "s",
    role: "user",
    actorType: "user",
    actorId: "operator",
    sourceAuthority: "operator",
    content: "I prefer concise replies.",
    timestamp: now,
  });
  messages.upsert({
    messageId: "a",
    sessionId: "s",
    role: "assistant",
    actorType: "agent",
    actorId: "assistant",
    sourceAuthority: "agent_proposed",
    content: "Understood.",
    timestamp: now,
  });
  new ChatTurnTraceRepository(f.db).create({
    turnId: "turn-1",
    sessionId: "s",
    userMessageId: "u",
    assistantMessageId: "a",
    status: "completed",
    mode: "chat",
    webMode: "off",
    memoryMode: "auto",
    thinkingLevel: "standard",
    finishedAt: now,
  });
  const { sourceHash: _hash, ...input } = {
    ...source(1),
    workspaceId: "default",
    sessionIncarnationId: meta.get("s")!.lifecycleIntentId ?? "legacy-session-incarnation:s",
  };
  f.runs.createRun({
    runId: input.parentRunId,
    workflowKey: "chat.turn.execute",
    status: "completed",
    payload: {
      version: "chat.turn.execute.v2",
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.sourceTurnId,
      sessionIncarnationId: input.sessionIncarnationId,
      admissionControllerGeneration: 1,
    },
  });
  f.runs.createRun({
    runId: input.effectExecutionId,
    workflowKey: "chat.post_commit.effect",
    status: "completed",
    metadata: {
      parentRunId: input.parentRunId,
      postCommitGenerationId: input.postCommitGenerationId,
      turnId: input.sourceTurnId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    },
  });
  const packet = f.repo.readEligibleSource(input);
  assert.equal(packet?.source.sourceHash.length, 64);
  assert.equal(packet?.userText, "I prefer concise replies.");
  assert.equal(f.repo.readEligibleSource({ ...input, workspaceId: "foreign" }), undefined);
  assert.equal(f.repo.readEligibleSource({ ...input, sessionIncarnationId: "old-incarnation" }), undefined);
  assert.equal(f.repo.readEligibleSource({ ...input, controllerGeneration: 2 }), undefined);
  f.db.prepare("UPDATE chat_messages SET content = 'I prefer detailed replies.' WHERE message_id = 'u'").run();
  assert.notEqual(f.repo.readEligibleSource(input)?.source.sourceHash, packet?.source.sourceHash);
  f.db.prepare("UPDATE chat_messages SET source_authority = 'external_channel' WHERE message_id = 'u'").run();
  assert.equal(f.repo.readEligibleSource(input), undefined);
});

it("reserves concurrent background cost before dispatch and never refunds unknown usage",()=>{
  const f=fixture();
  const budget={providerId:"openai",model:"fixture",pricingCatalogVersion:"fixture",pricingCatalogHash:"b".repeat(64),reservedCostUsd:.6,dailyCostCeilingUsd:1};
  const dispatches=[];
  for(const index of [1,2]) {
    const queued=f.repo.enqueue({source:{...source(index),sessionId:`session-${index}`},kind:"review",due:true});
    const job=f.repo.get(queued.jobId)!;
    const run=f.runs.tryClaimQueuedRunWithDatabaseClock({runId:job.runId,workerId:`worker-${index}`,leaseDurationMs:60_000})!;
    const claim={runId:job.runId,leaseOwnerId:run.leaseOwnerId!};const frozen=f.repo.freeze(job.jobId,claim);
    const dispatch=f.repo.beginDispatch(job.jobId,claim,{operationId:`priced-${index}`,stage:"memory",from:0,through:1,budget},frozen.revision);
    dispatches.push(dispatch);
    if(index===1) f.repo.settleDispatch(job.jobId,claim,dispatch!.revision,"unknown");
  }
  assert.ok(dispatches[0]);assert.equal(dispatches[1],undefined);
});
