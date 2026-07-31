import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatCitationRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatDelegationStepRepository } from "./chat-delegation-step-repo.js";
import { ToolGrantRepository } from "./tool-grant-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; dbPath: string; repo: ChatDelegationStepRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-delegation-step-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, dbPath, repo: new ChatDelegationStepRepository(db) };
}

function citation(): ChatCitationRecord {
  return {
    citationId: "citation-a",
    title: "Trace",
    url: "https://example.test/trace",
    sourceType: "tool",
  };
}

function setStepField(db: DatabaseClient, stepId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_delegation_steps SET ${field} = ? WHERE step_id = ?`).run(value, stepId);
}

function createSessionMeta(db: DatabaseClient, sessionId: string, workspaceId: string): void {
  const meta = new ChatSessionMetaRepository(db);
  meta.ensure(sessionId, "2026-03-26T00:00:00.000Z", workspaceId);
  meta.patch(sessionId, { title: sessionId, origin: "operator" }, "2026-03-26T00:00:00.000Z");
}

function createDelegationRun(db: DatabaseClient, runId: string, sessionId: string, startedAt: string): void {
  db.prepare(
    `
      INSERT INTO chat_delegation_runs (
        run_id, session_id, task_id, objective, roles_json, mode, provider_id, model, status,
        citations_json, started_at, finished_at
      ) VALUES (?, ?, ?, 'Cover storage', '["QA"]', 'parallel', 'openai', 'gpt-test', 'running', '[]', ?, NULL)
    `,
  ).run(runId, sessionId, `task-${runId}`, startedAt);
}

describe("ChatDelegationStepRepository", () => {
  it("creates, patches, gets, and lists delegation steps", () => {
    const { repo } = createStore();

    const full = repo.create({
      stepId: "step-b",
      runId: "run-a",
      role: "QA",
      label: "Review",
      index: 1,
      status: "running",
      parallelizable: false,
      dependsOnStepIds: ["step-a"],
      providerId: "openai",
      model: "gpt-test",
      summary: "Working",
      output: "Partial output",
      error: "none",
      failureGuidance: "Retry narrower",
      durableRunId: "durable-a",
      childSessionId: "child-a",
      childTurnId: "child-turn-a",
      citations: [citation()],
      degradedHandoffStepIds: ["step-researcher"],
      startedAt: "2026-03-26T00:00:02.000Z",
      finishedAt: "2026-03-26T00:00:03.000Z",
      durationMs: 1000,
    });
    const minimal = repo.create({
      stepId: "step-a",
      runId: "run-a",
      role: "Researcher",
      index: 0,
      startedAt: "2026-03-26T00:00:01.000Z",
    });

    assert.equal(full.status, "running");
    assert.equal(full.parallelizable, false);
    assert.deepEqual(full.dependsOnStepIds, ["step-a"]);
    assert.equal(full.providerId, "openai");
    assert.equal(full.model, "gpt-test");
    assert.equal(full.label, "Review");
    assert.equal(full.summary, "Working");
    assert.equal(full.output, "Partial output");
    assert.equal(full.error, "none");
    assert.equal(full.failureGuidance, "Retry narrower");
    assert.equal(full.durableRunId, "durable-a");
    assert.equal(full.childSessionId, "child-a");
    assert.equal(full.childTurnId, "child-turn-a");
    assert.deepEqual(full.citations, [citation()]);
    assert.deepEqual(full.degradedHandoffStepIds, ["step-researcher"]);
    assert.equal(full.durationMs, 1000);
    assert.equal(minimal.status, "pending");
    assert.equal(minimal.parallelizable, false);
    assert.deepEqual(minimal.dependsOnStepIds, []);
    assert.equal(minimal.citations, undefined);
    assert.equal(minimal.degradedHandoffStepIds, undefined);

    const patched = repo.patch("step-b", {
      status: "completed",
      parallelizable: true,
      dependsOnStepIds: [],
      providerId: "anthropic",
      model: "claude-test",
      label: "Reviewed",
      summary: "Done",
      output: "Final output",
      error: "",
      failureGuidance: "",
      durableRunId: "durable-b",
      childSessionId: "child-b",
      childTurnId: "child-turn-b",
      citations: [],
      degradedHandoffStepIds: ["step-researcher", "step-reviewer"],
      finishedAt: "2026-03-26T00:00:04.000Z",
      durationMs: 2000,
    });
    assert.equal(patched.status, "completed");
    assert.equal(patched.parallelizable, true);
    assert.deepEqual(patched.dependsOnStepIds, []);
    assert.equal(patched.providerId, "anthropic");
    assert.equal(patched.model, "claude-test");
    assert.equal(patched.label, "Reviewed");
    assert.equal(patched.summary, "Done");
    assert.equal(patched.output, "Final output");
    assert.equal(patched.error, "");
    assert.equal(patched.failureGuidance, "");
    assert.equal(patched.durableRunId, "durable-b");
    assert.equal(patched.childSessionId, "child-b");
    assert.equal(patched.childTurnId, "child-turn-b");
    assert.deepEqual(patched.citations, []);
    assert.deepEqual(patched.degradedHandoffStepIds, ["step-researcher", "step-reviewer"]);
    assert.equal(patched.durationMs, 2000);

    const preserved = repo.patch("step-b", {});
    assert.equal(preserved.status, "completed");
    assert.equal(preserved.model, "claude-test");
    assert.deepEqual(preserved.citations, []);
    assert.deepEqual(preserved.degradedHandoffStepIds, ["step-researcher", "step-reviewer"]);

    assert.deepEqual(
      repo.listByRun("run-a").map((step) => step.stepId),
      ["step-a", "step-b"],
    );
    assert.throws(() => repo.get("missing-step"), /Delegation step missing-step not found/);
    assert.throws(() => repo.patch("missing-step", { status: "failed" }), /Delegation step missing-step not found/);
  });

  it("reconstructs delegated scope and child tool grants from durable SQLite state", () => {
    const { db, dbPath, repo } = createStore();
    const grants = new ToolGrantRepository(db);
    const childSessionId = "child-scope-restart";
    const delegatedScope = {
      rootPath: "C:/workspace",
      approvedPaths: ["C:/workspace/src"],
      scopeHash: "scope-hash-restart",
      dispatchGeneration: "delegation-dispatch-generation-restart",
      updatedAt: "2026-04-19T00:00:00.000Z",
    };

    repo.create({
      stepId: "step-scope-restart",
      runId: "run-scope-restart",
      role: "Coder",
      index: 0,
      status: "running",
      childSessionId,
      startedAt: "2026-04-19T00:00:00.000Z",
    });
    repo.patch("step-scope-restart", { scopeControl: delegatedScope });
    grants.create({
      toolPattern: "browser.search",
      decision: "allow",
      scope: "session",
      scopeRef: childSessionId,
      grantType: "persistent",
      constraints: { allowedHosts: ["docs.example.test"] },
      createdBy: "system-delegated-session-inherit",
    });
    grants.createTtlForDuration(
      {
        toolPattern: "submit_work_result",
        decision: "allow",
        scope: "session",
        scopeRef: childSessionId,
        createdBy: "delegated-work-result-envelope",
      },
      5 * 60 * 1000,
    );
    db.close();

    const restartedDb = createDatabase({ dbPath });
    try {
      const rawScope = restartedDb
        .prepare("SELECT scope_control_json FROM chat_delegation_steps WHERE step_id = ?")
        .get("step-scope-restart") as { scope_control_json: string } | undefined;
      assert.equal(rawScope?.scope_control_json, JSON.stringify(delegatedScope));

      const restartedSteps = new ChatDelegationStepRepository(restartedDb);
      assert.deepEqual(restartedSteps.get("step-scope-restart").scopeControl, delegatedScope);

      const restartedGrants = new ToolGrantRepository(restartedDb).listActive("session", childSessionId);
      const inheritedGrant = restartedGrants.find((grant) => grant.toolPattern === "browser.search");
      assert.ok(inheritedGrant);
      assert.equal(inheritedGrant.decision, "allow");
      assert.equal(inheritedGrant.grantType, "persistent");
      assert.deepEqual(inheritedGrant.constraints, { allowedHosts: ["docs.example.test"] });
      assert.equal(inheritedGrant.createdBy, "system-delegated-session-inherit");

      const resultGrant = restartedGrants.find((grant) => grant.toolPattern === "submit_work_result");
      assert.ok(resultGrant);
      assert.equal(resultGrant.decision, "allow");
      assert.equal(resultGrant.grantType, "ttl");
      assert.equal(resultGrant.createdBy, "delegated-work-result-envelope");
    } finally {
      restartedDb.close();
    }
  });

  it("preserves a disjoint writer that commits between a generic patch read and write", () => {
    const { db, repo } = createStore();
    const competingRepo = new ChatDelegationStepRepository(db);
    repo.create({
      stepId: "step-generic-race",
      runId: "run-generic-race",
      role: "QA",
      index: 0,
      status: "running",
      summary: "Initial summary",
      startedAt: "2026-03-26T00:00:00.000Z",
    });

    const internal = repo as unknown as {
      getStmt: { get: (stepId: string) => unknown };
    };
    const originalGet = internal.getStmt.get.bind(internal.getStmt);
    let injectedConcurrentWrite = false;
    internal.getStmt.get = (stepId) => {
      const snapshot = originalGet(stepId);
      if (!injectedConcurrentWrite) {
        injectedConcurrentWrite = true;
        competingRepo.patch(stepId, { summary: "Concurrent summary" });
      }
      return snapshot;
    };

    repo.patch("step-generic-race", { status: "completed" });

    const final = repo.get("step-generic-race");
    assert.equal(final.status, "completed");
    assert.equal(final.summary, "Concurrent summary");
  });

  it("materializes an approval outcome only for the exact unowned waiting child generation", () => {
    const { db, repo } = createStore();
    repo.create({
      stepId: "step-approval-materialization",
      runId: "run-approval-materialization",
      role: "Coder",
      index: 0,
      status: "running",
      summary: "Waiting for approval",
      output: "Approval is required.",
      error: "approval_required",
      failureGuidance: "Approve or reject.",
      durableRunId: "durable-child",
      childSessionId: "child-session",
      childTurnId: "child-turn",
      startedAt: "2026-03-26T00:00:00.000Z",
    });

    const applied = repo.materializeApprovalOutcome({
      stepId: "step-approval-materialization",
      expectedChildSessionId: "child-session",
      expectedChildTurnId: "child-turn",
      status: "completed",
      output: "Approved output",
      summary: "Approved output",
      durableRunId: "durable-child",
      citations: [citation()],
      finishedAt: "2026-03-26T00:00:03.000Z",
      durationMs: 3_000,
    });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.step.status, "completed");
    assert.equal(applied.step.output, "Approved output");
    assert.equal(applied.step.error, undefined);
    assert.equal(applied.step.failureGuidance, undefined);
    assert.deepEqual(applied.step.citations, [citation()]);

    const converged = repo.materializeApprovalOutcome({
      stepId: "step-approval-materialization",
      expectedChildSessionId: "child-session",
      expectedChildTurnId: "child-turn",
      status: "completed",
      output: "Late replacement",
      summary: "Late replacement",
      citations: [],
      finishedAt: "2026-03-26T00:00:04.000Z",
      durationMs: 4_000,
    });
    assert.equal(converged.outcome, "converged");
    assert.equal(converged.step.output, "Approved output");

    repo.create({
      stepId: "step-cancellation-winner",
      runId: "run-approval-materialization",
      role: "QA",
      index: 1,
      status: "cancelled",
      summary: "Operator cancelled",
      childSessionId: "child-cancelled",
      childTurnId: "turn-cancelled",
      startedAt: "2026-03-26T00:00:00.000Z",
      finishedAt: "2026-03-26T00:00:01.000Z",
    });
    const cancellationLoser = repo.materializeApprovalOutcome({
      stepId: "step-cancellation-winner",
      expectedChildSessionId: "child-cancelled",
      expectedChildTurnId: "turn-cancelled",
      status: "failed",
      summary: "Late failure",
      error: "Late failure",
      citations: [],
      finishedAt: "2026-03-26T00:00:04.000Z",
      durationMs: 4_000,
    });
    assert.equal(cancellationLoser.outcome, "rejected");
    assert.equal(cancellationLoser.step.status, "cancelled");
    assert.equal(cancellationLoser.step.summary, "Operator cancelled");

    repo.create({
      stepId: "step-foreign-child",
      runId: "run-approval-materialization",
      role: "Ops",
      index: 2,
      status: "running",
      childSessionId: "replacement-session",
      childTurnId: "replacement-turn",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    const foreignChild = repo.materializeApprovalOutcome({
      stepId: "step-foreign-child",
      expectedChildSessionId: "stale-session",
      expectedChildTurnId: "stale-turn",
      status: "completed",
      output: "Stale output",
      summary: "Stale output",
      citations: [],
      finishedAt: "2026-03-26T00:00:04.000Z",
      durationMs: 4_000,
    });
    assert.equal(foreignChild.outcome, "rejected");
    assert.equal(foreignChild.step.status, "running");
    assert.equal(foreignChild.step.childSessionId, "replacement-session");
    assert.equal(foreignChild.step.childTurnId, "replacement-turn");

    repo.create({
      stepId: "step-active-owner",
      runId: "run-approval-materialization",
      role: "Researcher",
      index: 3,
      status: "running",
      childSessionId: "active-session",
      childTurnId: "active-turn",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    db.prepare(
      `
        UPDATE chat_delegation_steps
        SET dispatch_claim_token = 'replacement-owner',
            dispatch_claim_expires_at = '2099-01-01T00:00:00.000Z'
        WHERE step_id = 'step-active-owner'
      `,
    ).run();
    const activeOwner = repo.materializeApprovalOutcome({
      stepId: "step-active-owner",
      expectedChildSessionId: "active-session",
      expectedChildTurnId: "active-turn",
      status: "completed",
      output: "Stale output",
      summary: "Stale output",
      citations: [],
      finishedAt: "2026-03-26T00:00:04.000Z",
      durationMs: 4_000,
    });
    assert.equal(activeOwner.outcome, "rejected");
    assert.equal(activeOwner.step.status, "running");
    assert.equal(repo.getDispatchClaim("step-active-owner")?.token, "replacement-owner");
  });

  it("atomically owns, links, reclaims, and finalizes child dispatch", () => {
    const { db, repo } = createStore();
    const competingRepo = new ChatDelegationStepRepository(db);
    const activeExpiresAt = "2099-01-01T00:00:00.000Z";
    assert.equal(Number.isFinite(Date.parse(repo.readDatabaseNow())), true);
    repo.create({
      stepId: "step-dispatch",
      runId: "run-dispatch",
      role: "Coder",
      index: 0,
      status: "pending",
      startedAt: "2026-03-26T00:00:00.000Z",
    });

    const winner = repo.claimPendingForDispatch(
      "step-dispatch",
      "delegation-claim:v1:1000:turn-stable:owner-a",
      activeExpiresAt,
      "2026-03-26T00:00:01.000Z",
    );
    const loser = competingRepo.claimPendingForDispatch(
      "step-dispatch",
      "delegation-claim:v1:1000:turn-stable:owner-b",
      activeExpiresAt,
      "2026-03-26T00:00:01.000Z",
    );
    assert.equal(winner?.status, "running");
    assert.equal(winner?.childSessionId, undefined);
    assert.equal(winner?.childTurnId, undefined);
    assert.deepEqual(repo.getDispatchClaim("step-dispatch"), {
      token: "delegation-claim:v1:1000:turn-stable:owner-a",
      expiresAt: activeExpiresAt,
    });
    assert.equal(repo.listByRun("run-dispatch")[0]?.childSessionId, undefined);
    assert.equal(repo.listByRun("run-dispatch")[0]?.childTurnId, undefined);
    assert.equal(loser, undefined);

    assert.equal(
      competingRepo.linkClaimedDispatch(
        "step-dispatch",
        "delegation-claim:v1:1000:turn-stable:owner-b",
        "child-loser",
        "delegation-dispatch:v1:2000:turn-stable:owner-b",
        activeExpiresAt,
      ),
      undefined,
    );
    const linked = repo.linkClaimedDispatch(
      "step-dispatch",
      "delegation-claim:v1:1000:turn-stable:owner-a",
      "child-stable",
      "delegation-dispatch:v1:2000:turn-stable:owner-a",
      activeExpiresAt,
    );
    assert.equal(linked?.childSessionId, "child-stable");
    assert.equal(linked?.childTurnId, undefined);
    assert.equal(repo.getDispatchClaim("step-dispatch")?.token, "delegation-dispatch:v1:2000:turn-stable:owner-a");

    assert.equal(
      repo.reclaimLinkedDispatch(
        "step-dispatch",
        "child-stable",
        "delegation-dispatch:v1:2000:turn-stable:owner-b",
        "delegation-dispatch:v1:3000:turn-stable:owner-b",
        activeExpiresAt,
        "2026-03-26T00:00:02.000Z",
      ),
      undefined,
    );
    const reclaimed = competingRepo.reclaimLinkedDispatch(
      "step-dispatch",
      "child-stable",
      "delegation-dispatch:v1:2000:turn-stable:owner-a",
      "delegation-dispatch:v1:3000:turn-stable:owner-b",
      activeExpiresAt,
      "2026-03-26T00:00:02.000Z",
    );
    assert.equal(reclaimed?.childSessionId, "child-stable");
    assert.equal(reclaimed?.childTurnId, undefined);
    assert.equal(
      repo.ownsLinkedDispatch("step-dispatch", "child-stable", "delegation-dispatch:v1:2000:turn-stable:owner-a"),
      false,
    );
    assert.equal(
      competingRepo.ownsLinkedDispatch(
        "step-dispatch",
        "child-stable",
        "delegation-dispatch:v1:3000:turn-stable:owner-b",
      ),
      true,
    );

    assert.equal(
      repo.finalizeLinkedDispatch(
        "step-dispatch",
        "child-stable",
        "delegation-dispatch:v1:2000:turn-stable:owner-a",
        "turn-stable",
      ),
      undefined,
    );
    const finalized = competingRepo.finalizeLinkedDispatch(
      "step-dispatch",
      "child-stable",
      "delegation-dispatch:v1:3000:turn-stable:owner-b",
      "turn-stable",
    );
    assert.equal(finalized?.childTurnId, "turn-stable");
    assert.equal(competingRepo.getDispatchClaim("step-dispatch"), undefined);
    assert.equal(
      competingRepo.ownsLinkedDispatch(
        "step-dispatch",
        "child-stable",
        "delegation-dispatch:v1:3000:turn-stable:owner-b",
      ),
      false,
    );

    const reconcileClaim = repo.claimLinkedForDispatch(
      "step-dispatch",
      "child-stable",
      "turn-stable",
      "delegation-dispatch:v1:3500:turn-stable:owner-c",
      activeExpiresAt,
      "2026-03-26T00:00:02.500Z",
    );
    assert.equal(reconcileClaim?.childTurnId, "turn-stable");
    assert.equal(
      repo.finalizeLinkedDispatch(
        "step-dispatch",
        "child-stable",
        "delegation-dispatch:v1:3500:turn-stable:owner-c",
        "turn-stable",
      )?.childTurnId,
      "turn-stable",
    );

    repo.create({
      stepId: "step-linked-without-turn",
      runId: "run-dispatch",
      role: "QA",
      index: 1,
      status: "running",
      childSessionId: "child-linked",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    const legacyClaim = repo.claimLinkedForDispatch(
      "step-linked-without-turn",
      "child-linked",
      undefined,
      "delegation-dispatch:v1:4000:turn-linked:owner-a",
      activeExpiresAt,
      "2026-03-26T00:00:03.000Z",
    );
    assert.equal(legacyClaim?.childSessionId, "child-linked");
    assert.equal(legacyClaim?.childTurnId, undefined);
    assert.equal(
      competingRepo.claimLinkedForDispatch(
        "step-linked-without-turn",
        "child-linked",
        undefined,
        "delegation-dispatch:v1:4000:turn-linked:owner-b",
        activeExpiresAt,
        "2026-03-26T00:00:03.000Z",
      ),
      undefined,
    );
  });

  it("terminalizes an error only for the exact database-fresh dispatch owner", () => {
    const { db, repo } = createStore();
    repo.create({
      stepId: "step-owned-error",
      runId: "run-owned-error",
      role: "Coder",
      index: 0,
      status: "running",
      childSessionId: "child-owned",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    db.prepare(
      `
      UPDATE chat_delegation_steps
      SET dispatch_claim_token = 'dispatch-owner-b',
          dispatch_claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
      WHERE step_id = 'step-owned-error'
    `,
    ).run();

    assert.equal(
      repo.finishOwnedDispatchWithError({
        stepId: "step-owned-error",
        expectedDispatchToken: "dispatch-owner-a",
        expectedChildSessionId: "child-owned",
        status: "failed",
        label: "Coder",
        error: "stale worker failed",
        failureGuidance: "Retry",
        finishedAt: "2026-03-26T00:00:01.000Z",
        durationMs: 1_000,
      }),
      undefined,
    );
    assert.equal(repo.get("step-owned-error").status, "running");
    assert.equal(repo.getDispatchClaim("step-owned-error")?.token, "dispatch-owner-b");

    db.prepare(
      `
      UPDATE chat_delegation_steps
      SET dispatch_claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
      WHERE step_id = 'step-owned-error'
    `,
    ).run();
    assert.equal(
      repo.finishOwnedDispatchWithError({
        stepId: "step-owned-error",
        expectedDispatchToken: "dispatch-owner-b",
        expectedChildSessionId: "child-owned",
        status: "failed",
        label: "Coder",
        error: "late failure",
        failureGuidance: "Retry",
        finishedAt: "2026-03-26T00:00:02.000Z",
        durationMs: 2_000,
      }),
      undefined,
    );
    assert.equal(repo.get("step-owned-error").status, "running");

    db.prepare(
      `
      UPDATE chat_delegation_steps
      SET dispatch_claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
      WHERE step_id = 'step-owned-error'
    `,
    ).run();
    const failed = repo.finishOwnedDispatchWithError({
      stepId: "step-owned-error",
      expectedDispatchToken: "dispatch-owner-b",
      expectedChildSessionId: "child-owned",
      status: "failed",
      label: "Coder",
      summary: "Child failed.",
      error: "provider rejected",
      failureGuidance: "Retry",
      finishedAt: "2026-03-26T00:00:03.000Z",
      durationMs: 3_000,
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "provider rejected");
    assert.equal(repo.getDispatchClaim("step-owned-error"), undefined);
  });

  it("commits a child response only for the exact live dispatch token", () => {
    const { repo } = createStore();
    repo.create({
      stepId: "step-owned-response",
      runId: "run-owned-response",
      role: "Researcher",
      index: 0,
      status: "pending",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    assert.ok(
      repo.claimPendingForDispatch(
        "step-owned-response",
        "claim-owner-a",
        "2099-01-01T00:00:00.000Z",
        "2026-03-26T00:00:01.000Z",
      ),
    );
    assert.ok(
      repo.linkClaimedDispatch(
        "step-owned-response",
        "claim-owner-a",
        "child-response",
        "dispatch-owner-a",
        "2099-01-01T00:00:00.000Z",
      ),
    );
    assert.ok(
      repo.reclaimLinkedDispatch(
        "step-owned-response",
        "child-response",
        "dispatch-owner-a",
        "dispatch-owner-b",
        "2099-01-01T00:00:00.000Z",
        "2026-03-26T00:00:02.000Z",
      ),
    );

    assert.equal(
      repo.finishOwnedDispatchWithResponse({
        stepId: "step-owned-response",
        expectedDispatchToken: "dispatch-owner-a",
        childSessionId: "child-response",
        childTurnId: "turn-response",
        status: "completed",
        providerId: "openai",
        model: "gpt-test",
        label: "Researcher",
        summary: "Done",
        output: "Replacement output",
        citations: [citation()],
        durableRunId: "durable-response",
        finishedAt: "2026-03-26T00:00:03.000Z",
        durationMs: 3_000,
      }),
      undefined,
    );
    assert.equal(repo.get("step-owned-response").status, "running");
    assert.equal(repo.getDispatchClaim("step-owned-response")?.token, "dispatch-owner-b");

    const completed = repo.finishOwnedDispatchWithResponse({
      stepId: "step-owned-response",
      expectedDispatchToken: "dispatch-owner-b",
      childSessionId: "child-response",
      childTurnId: "turn-response",
      status: "completed",
      providerId: "openai",
      model: "gpt-test",
      label: "Researcher",
      summary: "Done",
      output: "Replacement output",
      citations: [citation()],
      durableRunId: "durable-response",
      finishedAt: "2026-03-26T00:00:03.000Z",
      durationMs: 3_000,
    });
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.childTurnId, "turn-response");
    assert.equal(completed?.output, "Replacement output");
    assert.deepEqual(completed?.citations, [citation()]);
    assert.equal(repo.getDispatchClaim("step-owned-response"), undefined);
  });

  it("retains a waiting response claim until the exact owner releases its projection fence", () => {
    const { repo } = createStore();
    repo.create({
      stepId: "step-waiting-response",
      runId: "run-waiting-response",
      role: "Researcher",
      index: 0,
      status: "pending",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    assert.ok(
      repo.claimPendingForDispatch(
        "step-waiting-response",
        "claim-waiting-owner",
        "2099-01-01T00:00:00.000Z",
        "2026-03-26T00:00:01.000Z",
      ),
    );
    assert.ok(
      repo.linkClaimedDispatch(
        "step-waiting-response",
        "claim-waiting-owner",
        "child-waiting",
        "dispatch-waiting-owner",
        "2099-01-01T00:00:00.000Z",
      ),
    );

    const waiting = repo.finishOwnedDispatchWithResponse({
      stepId: "step-waiting-response",
      expectedDispatchToken: "dispatch-waiting-owner",
      childSessionId: "child-waiting",
      childTurnId: "turn-waiting",
      status: "running",
      providerId: "openai",
      model: "gpt-test",
      label: "Researcher",
      summary: "Waiting for approval",
      output: "Needs filesystem approval.",
      citations: [],
      durableRunId: "durable-waiting",
    });
    assert.equal(waiting?.status, "running");
    assert.equal(waiting?.childTurnId, "turn-waiting");
    assert.equal(repo.getDispatchClaim("step-waiting-response")?.token, "dispatch-waiting-owner");

    assert.equal(
      repo.releaseOwnedWaitingDispatch({
        stepId: "step-waiting-response",
        expectedDispatchToken: "stale-dispatch-owner",
        childSessionId: "child-waiting",
        childTurnId: "turn-waiting",
      }),
      undefined,
    );
    assert.equal(repo.getDispatchClaim("step-waiting-response")?.token, "dispatch-waiting-owner");

    const released = repo.releaseOwnedWaitingDispatch({
      stepId: "step-waiting-response",
      expectedDispatchToken: "dispatch-waiting-owner",
      childSessionId: "child-waiting",
      childTurnId: "turn-waiting",
    });
    assert.equal(released?.status, "running");
    assert.equal(released?.childTurnId, "turn-waiting");
    assert.equal(repo.getDispatchClaim("step-waiting-response"), undefined);
  });

  it("terminalizes a pre-claim error only while the step is still unowned and pending", () => {
    const { repo } = createStore();
    repo.create({
      stepId: "step-preclaim-race",
      runId: "run-preclaim-race",
      role: "QA",
      index: 0,
      status: "pending",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    assert.ok(
      repo.claimPendingForDispatch(
        "step-preclaim-race",
        "replacement-claim",
        "2099-01-01T00:00:00.000Z",
        "2026-03-26T00:00:01.000Z",
      ),
    );

    assert.equal(
      repo.finishUnclaimedPendingWithError({
        stepId: "step-preclaim-race",
        status: "cancelled",
        label: "QA",
        summary: "Child cancelled.",
        error: "stale pre-claim abort",
        failureGuidance: "Retry",
        finishedAt: "2026-03-26T00:00:02.000Z",
        durationMs: 2_000,
      }),
      undefined,
    );
    assert.equal(repo.get("step-preclaim-race").status, "running");
    assert.equal(repo.getDispatchClaim("step-preclaim-race")?.token, "replacement-claim");

    repo.create({
      stepId: "step-preclaim-unowned",
      runId: "run-preclaim-race",
      role: "Ops",
      index: 1,
      status: "pending",
      startedAt: "2026-03-26T00:00:00.000Z",
    });
    const cancelled = repo.finishUnclaimedPendingWithError({
      stepId: "step-preclaim-unowned",
      status: "cancelled",
      label: "Ops",
      summary: "Child cancelled.",
      error: "operator abort",
      failureGuidance: "Retry",
      finishedAt: "2026-03-26T00:00:02.000Z",
      durationMs: 2_000,
    });
    assert.equal(cancelled?.status, "cancelled");
  });

  it("maps latest parent delegation runs for child sessions with workspace filtering", () => {
    const { db, repo } = createStore();
    createSessionMeta(db, "parent-a", "workspace-a");
    createSessionMeta(db, "parent-b", "workspace-a");
    createSessionMeta(db, "parent-c", "workspace-b");
    createSessionMeta(db, "child-a", "workspace-a");
    createSessionMeta(db, "child-b", "workspace-a");
    createSessionMeta(db, "child-c", "workspace-b");
    createDelegationRun(db, "run-a", "parent-a", "2026-03-26T00:00:01.000Z");
    createDelegationRun(db, "run-b", "parent-b", "2026-03-26T00:00:02.000Z");
    createDelegationRun(db, "run-c", "parent-c", "2026-03-26T00:00:03.000Z");

    repo.create({
      stepId: "step-old",
      runId: "run-a",
      role: "Researcher",
      label: "Older",
      index: 0,
      childSessionId: "child-a",
      startedAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      stepId: "step-new",
      runId: "run-b",
      role: "QA",
      label: "Newer",
      index: 1,
      childSessionId: "child-a",
      startedAt: "2026-03-26T00:00:04.000Z",
    });
    repo.create({
      stepId: "step-b",
      runId: "run-b",
      role: "Coder",
      index: 2,
      childSessionId: "child-b",
      startedAt: "2026-03-26T00:00:02.000Z",
    });
    repo.create({
      stepId: "step-c",
      runId: "run-c",
      role: "Ops",
      index: 0,
      childSessionId: "child-c",
      startedAt: "2026-03-26T00:00:03.000Z",
    });
    repo.create({
      stepId: "step-without-child",
      runId: "run-c",
      role: "Ops",
      index: 1,
      startedAt: "2026-03-26T00:00:05.000Z",
    });

    assert.equal(repo.listParentsByChildSessionIds([]).size, 0);
    const unrestricted = repo.listParentsByChildSessionIds([" child-a ", "", "child-a", "child-c"]);
    assert.deepEqual(unrestricted.get("child-a"), {
      parentSessionId: "parent-b",
      runId: "run-b",
      stepId: "step-new",
      role: "QA",
      label: "Newer",
      index: 1,
    });
    assert.equal(unrestricted.get("child-c")?.parentSessionId, "parent-c");

    const workspaceScoped = repo.listParentsByChildSessionIds(["child-a", "child-c"], " workspace-a ");
    assert.equal(workspaceScoped.get("child-a")?.parentSessionId, "parent-b");
    assert.equal(workspaceScoped.has("child-c"), false);
    assert.equal(repo.listParentsByChildSessionIds(["child-a"], "workspace-missing").size, 0);
  });

  it("filters malformed rows and coerces malformed citation payloads", () => {
    const { db, repo } = createStore();
    repo.create({
      stepId: "step-a",
      runId: "run-a",
      role: "QA",
      index: 0,
      citations: [citation()],
      startedAt: "2026-03-26T00:00:01.000Z",
    });

    setStepField(db, "step-a", "citations_json", "{}");
    assert.deepEqual(repo.get("step-a").citations, []);
    setStepField(db, "step-a", "citations_json", "{bad json");
    assert.deepEqual(repo.get("step-a").citations, []);
    setStepField(db, "step-a", "degraded_handoff_step_ids_json", JSON.stringify(["step-failed", 123, "step-other"]));
    assert.deepEqual(repo.get("step-a").degradedHandoffStepIds, ["step-failed", "step-other"]);
    setStepField(db, "step-a", "degraded_handoff_step_ids_json", "{}");
    assert.deepEqual(repo.get("step-a").degradedHandoffStepIds, []);

    setStepField(db, "step-a", "started_at", new Uint8Array([1]));
    assert.throws(() => repo.get("step-a"), /Delegation step step-a not found/);
    assert.deepEqual(repo.listByRun("run-a"), []);

    createDelegationRun(db, "run-a", "parent-a", "2026-03-26T00:00:01.000Z");
    setStepField(db, "step-a", "started_at", "2026-03-26T00:00:01.000Z");
    setStepField(db, "step-a", "child_session_id", "child-a");
    db.prepare("UPDATE chat_delegation_runs SET session_id = zeroblob(1) WHERE run_id = ?").run("run-a");
    assert.equal(repo.listParentsByChildSessionIds(["child-a"]).size, 0);
  });
});
