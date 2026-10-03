import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "./sqlite.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import {
  SessionMutationAdmissionRepository,
  readDurableChatOptionalInputMailbox,
} from "./session-mutation-admission-repo.js";
import { createOptionalInputFixture } from "./chat-optional-input-test-fixture.js";

function makeRunning(db: ReturnType<typeof createDatabase>, fixture: ReturnType<typeof createOptionalInputFixture>) {
  db.prepare(
    `UPDATE durable_runs SET status = 'running', lease_owner_id = 'worker-optional',
    lease_expires_at = @expiresAt WHERE run_id = @runId`,
  ).run({ runId: fixture.runId, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  db.prepare(
    `UPDATE chat_turn_traces SET status = 'running', pending_user_input_json = NULL WHERE turn_id = @turnId`,
  ).run({ turnId: fixture.turnId });
  return {
    promptId: fixture.resolution.promptId,
    turnId: fixture.turnId,
    kind: "text" as const,
    title: "Preference",
    question: "Which style should I use?",
    required: false,
    delivery: "background" as const,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

describe("durable optional Chat input", () => {
  it("issues, projects, and answers during tool work without changing trace phase or lease", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const fixture = createOptionalInputFixture(db),
        prompt = makeRunning(db, fixture);
      const traceStatus = (status: string) =>
        db
          .prepare("UPDATE chat_turn_traces SET status = @status WHERE turn_id = @turnId")
          .run({ status, turnId: fixture.turnId });
      const issue = {
        admissionIdentity: fixture.resolution.admissionIdentity,
        durableRunId: fixture.runId,
        expectedRunVersion: 2,
        prompt,
      };
      for (const status of [
        "queued",
        "waiting_for_approval",
        "waiting_for_user_input",
        "completed",
        "failed",
        "cancelled",
      ]) {
        traceStatus(status);
        assert.throws(() => fixture.repo.registerDurableChatOptionalInput(issue));
        assert.equal(new DurableRunRepository(db).getRun(fixture.runId)!.version, 2);
      }
      traceStatus("waiting_for_tool");
      fixture.repo.registerDurableChatOptionalInput(issue);
      const identity = { admissionIdentity: issue.admissionIdentity, durableRunId: fixture.runId };
      assert.equal(fixture.repo.projectDurableChatOptionalInput(identity).prompts[0]!.promptId, prompt.promptId);
      const answer = { ...fixture.resolution, expectedWaitingRunVersion: 3 };
      traceStatus("waiting_for_approval");
      assert.throws(() => fixture.repo.answerDurableChatOptionalInput(answer));
      traceStatus("waiting_for_tool");
      fixture.repo.answerDurableChatOptionalInput(answer);
      assert.equal(fixture.repo.projectDurableChatOptionalInput(identity).replies.length, 1);
      const trace = db
        .prepare("SELECT status, pending_user_input_json FROM chat_turn_traces WHERE turn_id = @turnId")
        .get<{ status: string; pending_user_input_json: string | null }>({ turnId: fixture.turnId })!;
      assert.equal(trace.status, "waiting_for_tool");
      assert.equal(trace.pending_user_input_json, null);
      assert.equal(new DurableRunRepository(db).getRun(fixture.runId)!.leaseOwnerId, "worker-optional");
    } finally {
      db.close();
    }
  });

  for (const durableJson of [null, "null"])
    it(`uses canonical admission for absent projection (${durableJson === null ? "SQL null" : "JSON null"}) and rejects foreign projections`, () => {
      const db = createDatabase({ dbPath: ":memory:" });
      try {
        const fixture = createOptionalInputFixture(db),
          prompt = makeRunning(db, fixture);
        const issue = {
          admissionIdentity: fixture.resolution.admissionIdentity,
          durableRunId: fixture.runId,
          expectedRunVersion: 2,
          prompt,
        };
        db.prepare("UPDATE chat_turn_traces SET durable_json = @json WHERE turn_id = @turnId").run({
          turnId: fixture.turnId,
          json: JSON.stringify({ runId: "foreign-run", status: "running" }),
        });
        assert.throws(() => fixture.repo.registerDurableChatOptionalInput(issue));
        assert.equal(new DurableRunRepository(db).getRun(fixture.runId)!.version, 2);
        db.prepare("UPDATE chat_turn_traces SET durable_json = @json WHERE turn_id = @turnId").run({
          turnId: fixture.turnId,
          json: durableJson,
        });
        fixture.repo.registerDurableChatOptionalInput(issue);
        const trace = db
          .prepare("SELECT durable_json FROM chat_turn_traces WHERE turn_id = @turnId")
          .get<{ durable_json: string }>({ turnId: fixture.turnId })!;
        assert.deepEqual(JSON.parse(trace.durable_json), { runId: fixture.runId, status: "running" });
        assert.equal(
          fixture.repo.answerDurableChatOptionalInput({ ...fixture.resolution, expectedWaitingRunVersion: 3 }).run
            .status,
          "running",
        );
      } finally {
        db.close();
      }
    });

  it("keeps the active lease, records one exact answer, survives reopen, and rejects altered replay", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goat-optional-input-"));
    const dbPath = path.join(directory, "fixture.db");
    let db = createDatabase({ dbPath });
    try {
      const fixture = createOptionalInputFixture(db);
      const prompt = makeRunning(db, fixture);
      fixture.repo.registerDurableChatOptionalInput({
        admissionIdentity: fixture.resolution.admissionIdentity,
        durableRunId: fixture.runId,
        expectedRunVersion: 2,
        prompt,
      });
      const answer = { ...fixture.resolution, expectedWaitingRunVersion: 3 };
      const result = fixture.repo.answerDurableChatOptionalInput(answer);
      assert.equal(result.run.status, "running");
      assert.equal(result.run.version, 4);
      assert.equal(new DurableRunRepository(db).getRun(fixture.runId)?.leaseOwnerId, "worker-optional");
      db.close();
      db = createDatabase({ dbPath });
      const repo = new SessionMutationAdmissionRepository(db);
      const run = new DurableRunRepository(db).getRun(fixture.runId)!;
      const mailbox = readDurableChatOptionalInputMailbox(run.payload, run.runId);
      assert.deepEqual(mailbox.replies, [result.responseRecord]);
      repo.projectDurableChatOptionalInput({ admissionIdentity: answer.admissionIdentity, durableRunId: run.runId });
      assert.equal(
        db
          .prepare("SELECT pending_user_input_json FROM chat_turn_traces WHERE turn_id = @turnId")
          .get<{ pending_user_input_json: string | null }>({ turnId: fixture.turnId })?.pending_user_input_json,
        null,
      );
      assert.equal(repo.answerDurableChatOptionalInput(answer).disposition, "replayed");
      assert.throws(() =>
        repo.answerDurableChatOptionalInput({ ...answer, response: { kind: "text", text: "Changed answer" } }),
      );
      assert.throws(() =>
        repo.answerDurableChatOptionalInput({ ...answer, responder: { actorId: "foreign", authActorSource: "token" } }),
      );
      assert.throws(() => readDurableChatOptionalInputMailbox(run.payload, "foreign-run"));
      assert.throws(() =>
        readDurableChatOptionalInputMailbox(
          { ...run.payload, optionalUserInputReplies: [result.responseRecord, result.responseRecord] },
          run.runId,
        ),
      );
      assert.throws(() =>
        readDurableChatOptionalInputMailbox(
          { ...run.payload, optionalUserInputPrompts: [{ ...prompt, question: "Altered issued question" }] },
          run.runId,
        ),
      );
      new DurableRunRepository(db).updateRun({ runId: run.runId, status: "completed", expectedVersion: 4 });
      assert.equal(repo.answerDurableChatOptionalInput(answer).disposition, "replayed");
      assert.equal(new DurableRunRepository(db).getRun(run.runId)?.version, 5);
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on scope, version, actor, expired lease, cancellation, and prompt bounds", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const fixture = createOptionalInputFixture(db);
      const prompt = makeRunning(db, fixture);
      const registration = {
        admissionIdentity: fixture.resolution.admissionIdentity,
        durableRunId: fixture.runId,
        expectedRunVersion: 2,
        prompt,
      };
      for (const patch of [
        { workspaceId: "foreign" },
        { sessionId: "foreign" },
        { turnId: "foreign" },
        { sessionIncarnationId: "foreign" },
        { controllerGeneration: 9 },
        { aggregateRevision: 9 },
        { materialSha256: "b".repeat(64) },
      ]) {
        assert.throws(() =>
          fixture.repo.registerDurableChatOptionalInput({
            ...registration,
            admissionIdentity: { ...registration.admissionIdentity, ...patch },
          }),
        );
      }
      assert.throws(() => fixture.repo.registerDurableChatOptionalInput({ ...registration, expectedRunVersion: 1 }));
      for (const patch of [
        { required: true },
        { delivery: undefined },
        { question: "x".repeat(1001) },
        { expiresAt: "2000-01-01T00:00:00.000Z" },
      ]) {
        assert.throws(() =>
          fixture.repo.registerDurableChatOptionalInput({ ...registration, prompt: { ...prompt, ...patch } } as never),
        );
      }
      fixture.repo.registerDurableChatOptionalInput(registration);
      assert.throws(() =>
        fixture.repo.registerDurableChatOptionalInput({
          ...registration,
          expectedRunVersion: 3,
          prompt: { ...prompt, promptId: "second" },
        }),
      );
      const answer = { ...fixture.resolution, expectedWaitingRunVersion: 3 };
      assert.throws(() =>
        fixture.repo.answerDurableChatOptionalInput({
          ...answer,
          responder: { actorId: "operator-a", authActorSource: "agent" },
        } as never),
      );
      assert.throws(() =>
        fixture.repo.answerDurableChatOptionalInput({ ...answer, response: { kind: "text", text: "x".repeat(4001) } }),
      );
      assert.throws(() => fixture.repo.answerDurableChatOptionalInput({ ...answer, expectedWaitingRunVersion: 2 }));
      db.prepare(`UPDATE durable_runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE run_id = @runId`).run({
        runId: fixture.runId,
      });
      assert.throws(() => fixture.repo.answerDurableChatOptionalInput(answer));
      new DurableRunRepository(db).updateRun({ runId: fixture.runId, status: "cancelled", expectedVersion: 3 });
      assert.throws(() => fixture.repo.answerDurableChatOptionalInput(answer));
      assert.equal(new DurableRunRepository(db).getRun(fixture.runId)?.payload.optionalUserInputReplies, undefined);
    } finally {
      db.close();
    }
  });

  it("rolls back issuance and run version together when trace persistence fails", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const fixture = createOptionalInputFixture(db);
      const prompt = makeRunning(db, fixture);
      db.exec(`CREATE TRIGGER fail_optional_trace BEFORE UPDATE OF pending_user_input_json ON chat_turn_traces
        BEGIN SELECT RAISE(ABORT, 'injected optional trace failure'); END`);
      assert.throws(
        () =>
          fixture.repo.registerDurableChatOptionalInput({
            admissionIdentity: fixture.resolution.admissionIdentity,
            durableRunId: fixture.runId,
            expectedRunVersion: 2,
            prompt,
          }),
        /injected optional trace failure/,
      );
      const run = new DurableRunRepository(db).getRun(fixture.runId)!;
      assert.equal(run.version, 2);
      assert.equal(run.payload.optionalUserInputPrompts, undefined);
    } finally {
      db.close();
    }
  });
});
