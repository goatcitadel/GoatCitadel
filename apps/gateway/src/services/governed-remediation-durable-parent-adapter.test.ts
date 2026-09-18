import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { createRemediationParentFixture, createRemediationResumeFixture } from "../../../../packages/storage/src/governed-remediation-parent-reservation-fixture.js";
import { buildChatTurnRuntimeAuthoritySeal } from "./chat-durable-runtime-authority.js";
import { GENERAL_CHAT_POST_COMMIT_EFFECTS } from "./chat-durable-run-service.js";
import { GovernedRemediationDurableParentAdapter } from "./governed-remediation-durable-parent-adapter.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function fixture(resuming = false) {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  cleanups.push(() => storage.close());
  const seed = resuming ? createRemediationResumeFixture(storage.db) : createRemediationParentFixture(storage.db);
  const run = storage.durableRuns.getRun(seed.runId);
  const now = storage.durableRuns.readDatabaseNow();
  const waitForEvent = { eventKey: "chat.user_input.resolved", correlationId: seed.resolution.promptId };
  const eligibility = { version: 1 as const, autonomyEnabledAtParentSettlement: false, evalIntegrityTurn: false, humanSession: true };
  const seal = buildChatTurnRuntimeAuthoritySeal({ runId: run.runId, turnId: seed.turnId, transitionKind: "waiting",
    durableStatus: "waiting", traceStatus: "waiting_for_user_input", transitionAt: now, postCommitGenerationId: "repair-wait",
    postCommitEligibility: eligibility, waitForEvent, requiredFinalizers: ["general"] });
  const metadata = { ...run.metadata, waitForEvent, chatTurnRuntimeAuthority: seal,
    generalChatPostCommit: { generationId: "repair-wait", traceStatus: "waiting_for_user_input", requestedAt: now,
      postCommitEligibility: eligibility, parentLocalEffectsStatus: "settled", parentLocalEffectsSettledAt: now,
      completedEffects: [...GENERAL_CHAT_POST_COMMIT_EFFECTS], durableEffectRunIds: {}, durableEffectOutcomes: {},
      childOutcomeAuthority: "child_durable_runs", settlementStatus: "completed", completedAt: now } };
  // Complete the shared storage fixture with canonical Gateway payload and wait evidence.
  storage.db.prepare("UPDATE durable_runs SET payload_json = @payload, metadata_json = @metadata WHERE run_id = @runId")
    .run({ runId: run.runId, payload: canonicalJsonString({ ...run.payload, userMessageId: "message-continuation",
      assistantMessageId: "assistant-continuation", branchKind: "chat", threadEventType: "message" }), metadata: canonicalJsonString(metadata) });
  storage.db.prepare("UPDATE durable_checkpoints SET state_json = @state WHERE checkpoint_id = @checkpointId")
    .run({ checkpointId: seed.input.blockedCheckpointId, state: canonicalJsonString({ waitForEvent, chatTurnRuntimeAuthority: seal }) });
  const authorize = vi.fn(async () => {});
  const adapter = new GovernedRemediationDurableParentAdapter(createSqliteAsyncStorage(storage), authorize);
  const resume = { ...seed.input, parentReservationId: "resume" in seed ? seed.resume.reservationId : "missing",
    verificationReceiptId: "resume-verification", operationId: "resume-fixture-resume", idempotencyKey: "resume-parent" };
  return { storage, seed, adapter, authorize, resume, metadata };
}

describe("governed remediation durable parent adapter", () => {
  it("reserves a settled admitted parent only after current authorization", async () => {
    const f = fixture();
    f.authorize.mockRejectedValueOnce(new Error("policy denied"));
    await expect(f.adapter.reserve(f.seed.input)).rejects.toThrow("policy denied");
    expect(f.storage.durableRuns.getRun(f.seed.runId).version).toBe(2);
    const result = await f.adapter.reserve(f.seed.input);
    expect(result.status).toBe("reserved");
    expect(f.storage.durableRuns.getRun(f.seed.runId).version).toBe(3);
    expect(await f.adapter.reserve(f.seed.input)).toEqual({ ...result, replayed: true });
  });

  it("refuses missing or unsettled waiting authority before authorization", async () => {
    const f = fixture();
    for (const metadata of [{}, { ...f.metadata, generalChatPostCommitPending: { generationId: "repair-wait" } }]) {
      f.storage.db.prepare("UPDATE durable_runs SET metadata_json = @metadata WHERE run_id = @runId")
        .run({ runId: f.seed.runId, metadata: canonicalJsonString(metadata) });
      await expect(f.adapter.reserve(f.seed.input)).rejects.toThrow();
    }
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.storage.durableRuns.getRun(f.seed.runId).version).toBe(2);
  });

  it("resumes once and observes exact completion after later run progress", async () => {
    const f = fixture(true);
    expect(await f.adapter.observeResume(f.resume)).toEqual({ observation: "unknown" });
    f.authorize.mockRejectedValueOnce(new Error("approval expired"));
    await expect(f.adapter.resume(f.resume)).rejects.toThrow("approval expired");
    expect(f.storage.durableRuns.getRun(f.seed.runId).version).toBe(3);
    const result = await f.adapter.resume(f.resume);
    expect(result).toEqual({ status: "resumed", resumedRunVersion: 4, replayed: false });
    f.storage.durableRuns.updateRun({ runId: f.seed.runId, status: "running", expectedVersion: 4 });
    expect(await f.adapter.observeResume(f.resume)).toEqual({ observation: "resume_completed", resumedRunVersion: 4 });
    f.authorize.mockRejectedValue(new Error("no new mutation allowed"));
    expect(await f.adapter.resume(f.resume)).toEqual({ ...result, replayed: true });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(await f.adapter.observeResume({ ...f.resume, operationId: "foreign" })).toEqual({ observation: "unknown" });
    await expect(f.adapter.resume({ ...f.resume, requesterActorId: "foreign" })).rejects.toThrow();
    expect(f.storage.durableRuns.getRun(f.seed.runId).version).toBe(5);
  });
});
