import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import {
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  type CronAgentTurnConfig,
  type CronRunRecord,
} from "@goatcitadel/contracts";
import { AgentCommitmentRepository } from "./agent-commitment-repo.js";
import { commitmentSha256 } from "./commitment-creator-receipt.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { CronRunRepository } from "./cron-run-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import type { DatabaseClient } from "./db.js";

const files = new TempSqliteFiles();
function configFor(run: CronRunRecord): CronAgentTurnConfig {
  return (run.actionSnapshot.actionConfig as { agentTurn: CronAgentTurnConfig }).agentTurn;
}
afterEach(() => files.cleanup());
const input = {
  commitmentId: "commitment",
  sessionId: "session",
  workspaceId: "workspace",
  kind: "check_in" as const,
  dueAt: "2020-01-01T00:00:00.000Z",
  confidence: 0.9,
  dedupeKey: "follow-up",
  suggestedText: "How did it go?",
};

function source(db: DatabaseClient, profileId: string | undefined = "profile") {
  new ChatSessionLifecycleRepository(db).initialize({
    workspaceId: "workspace",
    sessionId: "session",
    actorId: "operator",
    idempotencyKey: "init",
    correlationId: "init",
  });
  const request = { content: "Please check in later", ...(profileId ? { permissionProfileId: profileId } : {}) };
  const materialSha256 = commitmentSha256({ version: 2, request });
  const admissions = new SessionMutationAdmissionRepository(db);
  const admission = admissions.admit({
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "source",
    runtimeOwnerId: "test",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator",
    operation: "chat.turn.execute",
    materialSha256,
    idempotencyKey: "admit",
    correlationId: "admit",
  }).admission;
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    admissionMaterialSha256: materialSha256,
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "source",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    request,
    requestActor: { actorKind: "operator", actorId: "operator" },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "source-run" },
    userMessageId: "source-user",
    assistantMessageId: "source-assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    effectiveRequestMaterialSha256: commitmentSha256({ version: 1, admissionMaterialSha256: materialSha256, request }),
  };
  assert.ok(
    readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: "chat.turn.execute",
      durableRunId: "source-run",
      payload,
    }),
  );
  new DurableRunRepository(db).createRun({
    runId: "source-run",
    workflowKey: "chat.turn.execute",
    status: "queued",
    payload,
  });
  admissions.bindDurableRun({
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "source",
    durableRunId: "source-run",
    requestRuntimeClaim: { runtimeOwnerId: admission.runtimeOwnerId!, leaseRevision: admission.runtimeLeaseRevision! },
  });
  db.prepare("UPDATE durable_runs SET status = 'completed' WHERE run_id = 'source-run'").run();
  return { payload, admission };
}

it("derives creator authority from the exact canonical completed Chat turn and freezes one occurrence", () => {
  const db = files.open({ dbPath: ":memory:" });
  source(db);
  const repo = new AgentCommitmentRepository(db);
  const row = repo.upsertByDedupe({ ...input, sourceTurnId: "source" });
  assert.equal(row.creatorReceipt?.actorId, "operator");
  assert.equal(row.creatorReceipt?.permissionProfileId, "profile");
  const run = repo.claimScheduledOccurrence({
    commitmentId: row.commitmentId,
    expectedRevision: row.revision!,
    deliveryChannel: { channelKey: "test", target: "recipient" },
  });
  const config = configFor(run);
  assert.equal(config.inertInboxFallback, undefined);
  assert.equal(config.createdBy?.operatorId, "operator");
  assert.equal(repo.assertScheduledOccurrence(run.runId, config).commitmentId, row.commitmentId);
  assert.equal(
    new AgentCommitmentRepository(db).claimScheduledOccurrence({
      commitmentId: row.commitmentId,
      expectedRevision: 999,
    }).runId,
    run.runId,
  );
  const refreshed = repo.upsertByDedupe({ ...input, sourceTurnId: "source", suggestedText: "Changed after claim" });
  assert.equal(refreshed.suggestedText, input.suggestedText);
  assert.equal(refreshed.revision, 1);
  assert.throws(() => db.prepare("UPDATE agent_commitments SET suggested_text = 'tampered'").run(), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM agent_commitments").run(), /deleted/u);
  assert.throws(() => repo.assertScheduledOccurrence("foreign", config), /stale/u);
  assert.throws(() => repo.assertScheduledOccurrence(run.runId, { ...config, prompt: "Changed" }), /stale/u);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cron_runs").get<{ n: number }>()?.n, 1);
});

it("keeps historical and wrong-scope commitments Inbox-only with no invented creator", () => {
  const db = files.open({ dbPath: ":memory:" });
  source(db);
  const repo = new AgentCommitmentRepository(db);
  const row = repo.upsertByDedupe({ ...input, sourceTurnId: "foreign" });
  assert.equal(row.creatorReceipt, undefined);
  const run = repo.claimScheduledOccurrence({
    commitmentId: row.commitmentId,
    expectedRevision: 1,
    deliveryChannel: { channelKey: "test" },
  });
  assert.equal(configFor(run).inertInboxFallback, true);
  assert.equal(configFor(run).createdBy, undefined);
  assert.throws(() => repo.assertScheduledOccurrence(run.runId, configFor(run)), /stale/u);
});

it("rejects stale revisions and future due times before reserving a cron owner", () => {
  const db = files.open({ dbPath: ":memory:" });
  const repo = new AgentCommitmentRepository(db);
  repo.upsertByDedupe(input);
  const revised = repo.upsertByDedupe({ ...input, suggestedText: "Updated" });
  assert.equal(revised.revision, 2);
  assert.throws(
    () => repo.claimScheduledOccurrence({ commitmentId: input.commitmentId, expectedRevision: 1 }),
    /stale/u,
  );
  repo.upsertByDedupe({ ...input, dueAt: "2099-01-01T00:00:00.000Z" });
  assert.throws(
    () => repo.claimScheduledOccurrence({ commitmentId: input.commitmentId, expectedRevision: 3 }),
    /not due/u,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM cron_runs").get<{ n: number }>()?.n, 0);
});

it("rejects creator payload drift and never treats Inbox settlement as a channel send", () => {
  const db = files.open({ dbPath: ":memory:" });
  const fixture = source(db);
  const repo = new AgentCommitmentRepository(db);
  repo.upsertByDedupe({ ...input, sourceTurnId: "source" });
  const run = repo.claimScheduledOccurrence({
    commitmentId: input.commitmentId,
    expectedRevision: 1,
    deliveryChannel: { channelKey: "test" },
  });
  db.prepare("UPDATE durable_runs SET payload_json = ? WHERE run_id = 'source-run'").run(
    canonicalJsonString({ ...fixture.payload, requestActor: { actorKind: "operator", actorId: "impostor" } }),
  );
  assert.throws(() => repo.assertScheduledOccurrence(run.runId, configFor(run)), /stale/u);
  new CronRunRepository(db).terminalize(run, { status: "completed", outcome: { mode: "inbox", taskId: "task" } });
  assert.equal(repo.reconcileScheduled(), 1);
  assert.equal(repo.get(input.commitmentId)?.status, "dismissed");
  assert.equal(repo.get(input.commitmentId)?.sentAt, undefined);
  assert.equal(
    repo.claimScheduledOccurrence({ commitmentId: input.commitmentId, expectedRevision: 1 }).runId,
    run.runId,
  );
});

it("refuses overlapping commitment occurrences across independent database connections", () => {
  const dbPath = files.path("commitment-overlap");
  const db = files.open({ dbPath });
  const first = new AgentCommitmentRepository(db);
  first.upsertByDedupe(input);
  first.upsertByDedupe({ ...input, commitmentId: "second", dedupeKey: "second" });
  const run = first.claimScheduledOccurrence({ commitmentId: input.commitmentId, expectedRevision: 1 });
  const second = new AgentCommitmentRepository(files.open({ dbPath }));
  assert.equal(
    second.claimScheduledOccurrence({ commitmentId: input.commitmentId, expectedRevision: 1 }).runId,
    run.runId,
  );
  assert.throws(
    () => second.claimScheduledOccurrence({ commitmentId: "second", expectedRevision: 1 }),
    /already active/u,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM cron_runs").get<{ n: number }>()?.n, 1);
});

it("does not invent default profile authority and does not call unacknowledged completion sent", () => {
  const db = files.open({ dbPath: ":memory:" });
  source(db, "");
  const repo = new AgentCommitmentRepository(db);
  const row = repo.upsertByDedupe({ ...input, sourceTurnId: "source" });
  assert.equal(row.creatorReceipt, undefined);
  const run = repo.claimScheduledOccurrence({
    commitmentId: input.commitmentId,
    expectedRevision: 1,
    deliveryChannel: { channelKey: "test" },
  });
  assert.equal(configFor(run).inertInboxFallback, true);
  new CronRunRepository(db).terminalize(run, { status: "completed", outcome: { childDurableRunId: "child" } });
  repo.reconcileScheduled();
  assert.equal(repo.get(input.commitmentId)?.status, "delivery_failed");
  assert.equal(repo.get(input.commitmentId)?.sentAt, undefined);
});
