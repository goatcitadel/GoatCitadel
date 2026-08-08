import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TOOL_EFFECT_CLASSIFICATION_VERSION } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { __sqliteInternals, createDatabase } from "./sqlite.js";
import { ChatToolRunRepository } from "./chat-tool-run-repo.js";

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

function createStore(): { db: DatabaseClient; dbPath: string; repo: ChatToolRunRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-tool-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, dbPath, repo: new ChatToolRunRepository(db) };
}

function setRawField(db: DatabaseClient, toolRunId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_tool_runs SET ${field} = ? WHERE tool_run_id = ?`).run(value, toolRunId);
}

function setStartedAtBlob(db: DatabaseClient, toolRunId: string): void {
  db.prepare("UPDATE chat_tool_runs SET started_at = zeroblob(1) WHERE tool_run_id = ?").run(toolRunId);
}

describe("ChatToolRunRepository", () => {
  it("creates, patches, lists, and groups tool runs", () => {
    const { repo } = createStore();
    const full = repo.create({
      toolRunId: "tool-run-b",
      turnId: "turn-a",
      sessionId: "session-a",
      toolName: "browser.search",
      status: "approval_required",
      approvalId: "approval-a",
      args: { query: "goat" },
      result: { ok: true },
      reused: true,
      reusedFromToolRunId: "tool-run-a",
      reuseReason: "same query",
      error: "none",
      failureGuidance: "retry later",
      startedAt: "2026-03-26T00:00:01.000Z",
      finishedAt: "2026-03-26T00:00:02.000Z",
    });
    const minimal = repo.create({
      toolRunId: "tool-run-a",
      turnId: "turn-a",
      sessionId: "session-a",
      toolName: "shell.run",
      startedAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      toolRunId: "tool-run-c",
      turnId: "turn-b",
      sessionId: "session-a",
      toolName: "file.read",
      status: "executed",
      reused: false,
      startedAt: "not-a-date",
    });
    repo.create({
      toolRunId: "tool-run-d",
      turnId: "turn-c",
      sessionId: "session-a",
      toolName: "file.read",
      startedAt: "2026-03-26T00:00:04.000Z",
    });
    repo.create({
      toolRunId: "tool-run-e",
      turnId: "turn-c",
      sessionId: "session-a",
      toolName: "file.write",
      startedAt: "2026-03-26T00:00:03.000Z",
    });

    assert.equal(full.status, "approval_required");
    assert.equal(full.effectPotential, "unknown");
    assert.equal(full.effectDisposition, "unknown");
    assert.equal(full.effectOutcomeKind, "uncertain");
    assert.equal(full.approvalId, "approval-a");
    assert.deepEqual(full.args, { query: "goat" });
    assert.deepEqual(full.result, { ok: true });
    assert.equal(full.reused, true);
    assert.equal(full.reusedFromToolRunId, "tool-run-a");
    assert.equal(full.reuseReason, "same query");
    assert.equal(full.error, "none");
    assert.equal(full.failureGuidance, "retry later");
    assert.equal(minimal.status, "started");
    assert.equal(minimal.reused, undefined);

    const patched = repo.patch("tool-run-b", {
      status: "failed",
      result: { ok: false },
      reused: false,
      error: "boom",
      failureGuidance: "inspect logs",
      finishedAt: "2026-03-26T00:00:03.000Z",
    });
    assert.equal(patched.status, "failed");
    assert.deepEqual(patched.result, { ok: false });
    assert.equal(patched.reused, false);
    assert.equal(patched.error, "boom");
    assert.equal(patched.failureGuidance, "inspect logs");

    const preserved = repo.patch("tool-run-b", {});
    assert.deepEqual(preserved.result, { ok: false });
    assert.equal(preserved.reused, false);
    assert.equal(preserved.finishedAt, "2026-03-26T00:00:03.000Z");

    const minimalPreserved = repo.patch("tool-run-a", {});
    assert.equal(minimalPreserved.result, undefined);
    assert.equal(minimalPreserved.reused, undefined);
    const minimalReused = repo.patch("tool-run-a", { reused: true });
    assert.equal(minimalReused.reused, true);
    assert.equal(repo.patch("tool-run-a", {}).reused, true);

    assert.deepEqual(
      repo.listByTurn("turn-a").map((item) => item.toolRunId),
      ["tool-run-b", "tool-run-a"],
    );
    assert.equal(repo.listBySession("session-a", 0).length, 1);
    assert.equal(repo.listBySession("session-a", 3000).length, 5);

    assert.equal(repo.listByTurnIds([]).size, 0);
    const grouped = repo.listByTurnIds([" turn-b ", "turn-a", "", "turn-a"]);
    assert.deepEqual(
      grouped.get("turn-a")?.map((item) => item.toolRunId),
      ["tool-run-a", "tool-run-b"],
    );
    assert.deepEqual(
      grouped.get("turn-b")?.map((item) => item.toolRunId),
      ["tool-run-c"],
    );
    assert.deepEqual(
      repo
        .listByTurnIds(["turn-c"])
        .get("turn-c")
        ?.map((item) => item.toolRunId),
      ["tool-run-e", "tool-run-d"],
    );
    assert.deepEqual(
      repo
        .listByTurnIds(["turn-a", "turn-b"])
        .get("turn-a")
        ?.map((item) => item.toolRunId),
      ["tool-run-a", "tool-run-b"],
    );
  });

  it("compare-and-swaps an exact result only once", () => {
    const { repo } = createStore();
    const original = { status: "configuration_required", targetId: "search.brave" };
    const firstSeal = {
      ...original,
      runtimeConfigurationPromptAuthority: { promptId: "prompt-1", expiresAt: "2026-08-08T00:15:00.000Z" },
    };
    repo.create({
      toolRunId: "runtime-configure-run",
      turnId: "turn-runtime-configure",
      sessionId: "session-runtime-configure",
      toolName: "runtime.configure",
      status: "executed",
      result: original,
    });

    assert.deepEqual(repo.compareAndSwapResult("runtime-configure-run", original, firstSeal)?.result, firstSeal);
    assert.equal(
      repo.compareAndSwapResult("runtime-configure-run", original, {
        ...original,
        runtimeConfigurationPromptAuthority: {
          promptId: "prompt-2",
          expiresAt: "2026-08-08T00:30:00.000Z",
        },
      }),
      undefined,
    );
    assert.deepEqual(repo.get("runtime-configure-run").result, firstSeal);
  });

  it("handles missing rows and malformed stored payloads defensively", () => {
    const { db, repo } = createStore();
    repo.create({
      toolRunId: "tool-run-a",
      turnId: "turn-a",
      sessionId: "session-a",
      toolName: "browser.search",
      args: { query: "goat" },
      result: { ok: true },
      startedAt: "2026-03-26T00:00:00.000Z",
    });

    assert.throws(() => repo.get("missing-run"), /Chat tool run missing-run not found/);
    assert.throws(() => repo.patch("missing-run", { status: "failed" }), /Chat tool run missing-run not found/);

    setRawField(db, "tool-run-a", "args_json", "[]");
    setRawField(db, "tool-run-a", "result_json", "{bad json");
    const malformedPayload = repo.get("tool-run-a");
    assert.equal(malformedPayload.args, undefined);
    assert.equal(malformedPayload.result, undefined);

    setStartedAtBlob(db, "tool-run-a");
    assert.throws(() => repo.get("tool-run-a"), /Chat tool run tool-run-a not found/);
    assert.deepEqual(repo.listByTurn("turn-a"), []);
    assert.deepEqual(repo.listBySession("session-a"), []);
    assert.equal(repo.listByTurnIds(["turn-a"]).size, 0);
  });

  it("projects legacy rows conservatively after migration without persisting invented evidence", () => {
    const { db, dbPath, repo } = createStore();
    const migrated = repo.create({
      toolRunId: "legacy-run",
      turnId: "legacy-turn",
      sessionId: "legacy-session",
      toolName: "plugin:mutate",
      status: "executed",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    });
    assert.equal(migrated.effectPotential, "unknown");
    assert.equal(migrated.effectDisposition, "unknown");
    assert.equal(migrated.effectOutcomeKind, "uncertain");
    assert.equal(migrated.effectEvidence?.reason, "legacy_or_malformed_effect_truth");
    db.prepare("DELETE FROM schema_migrations WHERE version = 157").run();
    db.close();

    const raw = new DatabaseSync(dbPath);
    __sqliteInternals.applySchemaMigrationForTest(157, raw);
    const stored = raw
      .prepare(
        `SELECT effect_potential, effect_disposition, effect_outcome_kind, effect_evidence_json
         FROM chat_tool_runs WHERE tool_run_id = 'legacy-run'`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...stored },
      {
        effect_potential: null,
        effect_disposition: null,
        effect_outcome_kind: null,
        effect_evidence_json: null,
      },
    );
    raw.close();

    const reopened = createDatabase({ dbPath });
    const projected = new ChatToolRunRepository(reopened).get("legacy-run");
    assert.equal(projected.effectPotential, "unknown");
    assert.equal(projected.effectDisposition, "unknown");
    assert.equal(projected.effectOutcomeKind, "uncertain");
    assert.equal(projected.effectEvidence?.reason, "legacy_or_malformed_effect_truth");
    reopened.close();
  });

  it("projects a legacy plugin block as unknown because status is not dispatch proof", () => {
    const { repo } = createStore();
    const legacyBlocked = repo.create({
      toolRunId: "legacy-plugin-blocked",
      turnId: "legacy-plugin-turn",
      sessionId: "legacy-plugin-session",
      toolName: "plugin:mutate",
      status: "blocked",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    });

    assert.equal(legacyBlocked.effectPotential, "unknown");
    assert.equal(legacyBlocked.effectDisposition, "unknown");
    assert.equal(legacyBlocked.effectOutcomeKind, "uncertain");
    assert.equal(legacyBlocked.effectEvidence?.reason, "legacy_or_malformed_effect_truth");
  });

  it("rejects incoherent persisted effect combinations and derives from trusted status", () => {
    const { db, repo } = createStore();
    repo.create({
      toolRunId: "safe-read",
      turnId: "turn-effects",
      sessionId: "session-effects",
      toolName: "time.now",
      status: "executed",
      effectPotential: "none",
      effectDisposition: "none",
      effectOutcomeKind: "none",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "none",
        reason: "trusted_safe_read",
        refs: [],
      },
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    });
    assert.equal(repo.get("safe-read").effectEvidence?.reason, "trusted_safe_read");

    setRawField(db, "safe-read", "effect_potential", "unknown");
    const mismatchedSafeRead = repo.get("safe-read");
    assert.equal(mismatchedSafeRead.effectOutcomeKind, "uncertain");
    assert.equal(mismatchedSafeRead.effectEvidence?.reason, "legacy_or_malformed_effect_truth");

    setRawField(db, "safe-read", "effect_potential", "none");
    setRawField(db, "safe-read", "effect_disposition", null);
    setRawField(db, "safe-read", "effect_outcome_kind", "concrete");
    setRawField(
      db,
      "safe-read",
      "effect_evidence_json",
      JSON.stringify({
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "concrete",
        reason: "canonical_effect_receipt_linked",
        refs: [{ owner: "external_side_effect", refId: "unrelated-valid-owner" }],
      }),
    );
    const concreteFromNone = repo.get("safe-read");
    assert.equal(concreteFromNone.effectOutcomeKind, "uncertain");
    assert.equal(concreteFromNone.effectEvidence?.reason, "legacy_or_malformed_effect_truth");

    setRawField(db, "safe-read", "effect_potential", "none");
    setRawField(db, "safe-read", "effect_disposition", "none");
    setRawField(db, "safe-read", "effect_outcome_kind", "none");
    setRawField(
      db,
      "safe-read",
      "effect_evidence_json",
      JSON.stringify({
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "none",
        reason: "legacy_or_malformed_effect_truth",
        refs: [],
      }),
    );
    const selfAssertedLegacy = repo.get("safe-read");
    assert.equal(selfAssertedLegacy.effectOutcomeKind, "uncertain");
    assert.equal(selfAssertedLegacy.effectEvidence?.reason, "legacy_or_malformed_effect_truth");
  });

  it("requires reason/status/reuse/approval phase coherence", () => {
    const { db, repo } = createStore();
    repo.create({
      toolRunId: "phase-run",
      turnId: "turn-phase",
      sessionId: "session-phase",
      toolName: "browser.search",
      status: "executed",
      reused: false,
      effectPotential: "unknown",
      effectDisposition: "none",
      effectOutcomeKind: "none",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "none",
        reason: "reused_without_dispatch",
        refs: [],
      },
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    });
    assert.equal(repo.get("phase-run").effectEvidence?.reason, "legacy_or_malformed_effect_truth");

    setRawField(db, "phase-run", "status", "approval_required");
    setRawField(db, "phase-run", "reused", 0);
    setRawField(db, "phase-run", "effect_disposition", "none");
    setRawField(db, "phase-run", "effect_outcome_kind", "none");
    setRawField(
      db,
      "phase-run",
      "effect_evidence_json",
      JSON.stringify({
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "none",
        reason: "approval_wait_before_dispatch",
        refs: [],
      }),
    );
    const missingApproval = repo.get("phase-run");
    assert.equal(missingApproval.effectDisposition, "unknown");
    assert.equal(missingApproval.effectOutcomeKind, "uncertain");
    assert.equal(missingApproval.effectEvidence?.reason, "legacy_or_malformed_effect_truth");
  });

  it("preserves uncertain approval wait after an auxiliary hook dispatch", () => {
    const { repo } = createStore();
    const record = repo.create({
      toolRunId: "approval-after-hook",
      turnId: "turn-approval-after-hook",
      sessionId: "session-approval-after-hook",
      toolName: "shell.exec",
      status: "approval_required",
      approvalId: "approval-hook-1",
      effectPotential: "unknown",
      effectDisposition: "unknown",
      effectOutcomeKind: "uncertain",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "uncertain",
        reason: "approval_wait_after_auxiliary_dispatch",
        refs: [],
      },
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    });

    assert.equal(record.status, "approval_required");
    assert.equal(record.approvalId, "approval-hook-1");
    assert.equal(record.effectDisposition, "unknown");
    assert.equal(record.effectOutcomeKind, "uncertain");
    assert.equal(record.effectEvidence?.reason, "approval_wait_after_auxiliary_dispatch");
  });

  it("keeps a post-dispatch output rejection coherent instead of degrading to legacy", () => {
    const { repo } = createStore();
    const record = repo.create({
      toolRunId: "output-rejected",
      turnId: "turn-output-rejected",
      sessionId: "session-output-rejected",
      toolName: "shell.exec",
      status: "failed",
      effectPotential: "unknown",
      effectDisposition: "unknown",
      effectOutcomeKind: "uncertain",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "uncertain",
        reason: "dispatch_may_have_occurred",
        refs: [],
      },
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    });

    assert.equal(record.effectEvidence?.reason, "dispatch_may_have_occurred");
    assert.equal(record.effectOutcomeKind, "uncertain");
  });
});
