import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

function createRepo(): PromptPackRunRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-prompt-pack-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new PromptPackRunRepository(db);
}

describe("PromptPackRunRepository", () => {
  it("patch updates only provided fields without clobbering others", () => {
    const repo = createRepo();
    repo.create({
      runId: "run-1",
      packId: "pack-1",
      testId: "test-1",
      status: "running",
      responseText: "initial response",
      derivedResponseText: "initial derived response",
      derivedResponseSignals: ["prompt_lab_contract_fallback"],
      error: "initial error",
      startedAt: "2026-03-02T00:00:00.000Z",
    });

    const firstPatch = repo.patch("run-1", {
      status: "completed",
      responseText: "final response",
    });
    assert.equal(firstPatch.status, "completed");
    assert.equal(firstPatch.responseText, "final response");
    assert.equal(firstPatch.derivedResponseText, "initial derived response");
    assert.deepEqual(firstPatch.derivedResponseSignals, ["prompt_lab_contract_fallback"]);
    assert.equal(firstPatch.error, "initial error");

    const secondPatch = repo.patch("run-1", {
      error: "updated error",
    });
    assert.equal(secondPatch.status, "completed");
    assert.equal(secondPatch.responseText, "final response");
    assert.equal(secondPatch.derivedResponseText, "initial derived response");
    assert.deepEqual(secondPatch.derivedResponseSignals, ["prompt_lab_contract_fallback"]);
    assert.equal(secondPatch.error, "updated error");
  });

  it("round-trips derived response metadata through create and patch", () => {
    const repo = createRepo();
    const created = repo.create({
      runId: "run-derived-1",
      packId: "pack-1",
      testId: "test-1",
      status: "failed",
      derivedResponseText: "Recovered harness helper text.",
      derivedResponseSignals: ["trace_missing_output_fallback"],
      startedAt: "2026-03-02T00:00:00.000Z",
    });

    assert.equal(created.derivedResponseText, "Recovered harness helper text.");
    assert.deepEqual(created.derivedResponseSignals, ["trace_missing_output_fallback"]);

    const patched = repo.patch("run-derived-1", {
      derivedResponseText: "Updated derived text.",
      derivedResponseSignals: ["prompt_lab_contract_fallback"],
    });

    assert.equal(patched.derivedResponseText, "Updated derived text.");
    assert.deepEqual(patched.derivedResponseSignals, ["prompt_lab_contract_fallback"]);
  });

  it("round-trips execution style and diagnostic metadata through create and patch", () => {
    const repo = createRepo();
    const created = repo.create({
      runId: "run-diagnostics-1",
      packId: "pack-1",
      testId: "test-1",
      status: "running",
      executionStyle: "agentic_surface",
      diagnosticMetadata: {
        capabilityTargets: ["routing", "durable-run"],
        expectedRuntimeSignals: ["surface preset"],
        likelyFailureClasses: ["runtime"],
      },
      startedAt: "2026-03-02T00:00:00.000Z",
    });

    assert.equal(created.executionStyle, "agentic_surface");
    assert.deepEqual(created.diagnosticMetadata, {
      capabilityTargets: ["routing", "durable-run"],
      expectedRuntimeSignals: ["surface preset"],
      likelyFailureClasses: ["runtime"],
    });

    const patched = repo.patch("run-diagnostics-1", {
      executionStyle: "single_turn_harness",
      diagnosticMetadata: {
        capabilityTargets: ["truthfulness"],
        expectedRuntimeSignals: ["harness wrapper"],
        likelyFailureClasses: ["model"],
      },
    });

    assert.equal(patched.executionStyle, "single_turn_harness");
    assert.deepEqual(patched.diagnosticMetadata, {
      capabilityTargets: ["truthfulness"],
      expectedRuntimeSignals: ["harness wrapper"],
      likelyFailureClasses: ["model"],
    });
  });

  it("round-trips integrity metadata through create and patch", () => {
    const repo = createRepo();
    const created = repo.create({
      runId: "run-integrity-1",
      packId: "pack-1",
      testId: "test-1",
      status: "completed",
      responseText: "Final answer.",
      integrity: {
        validationStatus: "valid",
        signals: [],
        completionStatus: "complete",
        finishReason: "stop",
        outputTokenCount: 48,
        responseChecksumSha256: "abc123",
      },
      startedAt: "2026-03-02T00:00:00.000Z",
      finishedAt: "2026-03-02T00:00:02.000Z",
    });

    assert.deepEqual(created.integrity, {
      validationStatus: "valid",
      signals: [],
      completionStatus: "complete",
      finishReason: "stop",
      outputTokenCount: 48,
      responseChecksumSha256: "abc123",
    });

    const patched = repo.patch("run-integrity-1", {
      integrity: {
        validationStatus: "invalid",
        signals: ["output_cut_off_fragment"],
        completionStatus: "truncated",
        finishReason: "length",
        outputTokenCount: 48,
        responseChecksumSha256: "def456",
      },
    });

    assert.deepEqual(patched.integrity, {
      validationStatus: "invalid",
      signals: ["output_cut_off_fragment"],
      completionStatus: "truncated",
      finishReason: "length",
      outputTokenCount: 48,
      responseChecksumSha256: "def456",
    });
  });

  it("lists, deletes, reports missing runs, and handles malformed stored JSON", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    const trace = { traceId: "trace-1", status: "completed" } as unknown as NonNullable<
      Parameters<PromptPackRunRepository["create"]>[0]["trace"]
    >;
    const citations = [{ sourceId: "doc-1", title: "Doc" }] as unknown as NonNullable<
      Parameters<PromptPackRunRepository["create"]>[0]["citations"]
    >;

    assert.throws(() => repo.get("missing-run"), /Prompt pack run missing-run not found/);
    assert.throws(() => repo.patch("missing-run", { status: "completed" }), /Prompt pack run missing-run not found/);

    repo.create({
      runId: "run-old",
      packId: "pack-1",
      testId: "test-1",
      startedAt: "2026-03-02T00:00:00.000Z",
    });
    repo.create({
      runId: "run-new",
      packId: "pack-1",
      testId: "test-1",
      sessionId: "session-1",
      providerId: "openai",
      model: "gpt-5",
      mode: "code",
      toolTier: "explicit-tools",
      toolAutonomy: "manual",
      webMode: "deep",
      memoryMode: "on",
      thinkingLevel: "deep",
      trace,
      citations,
      startedAt: "2026-03-02T00:01:00.000Z",
      finishedAt: "2026-03-02T00:02:00.000Z",
    });

    const [latest] = repo.listByPack("pack-1", 1);
    assert.equal(latest?.runId, "run-new");
    assert.equal(latest?.providerId, "openai");
    assert.deepEqual(latest?.trace, trace);
    assert.deepEqual(latest?.citations, citations);
    assert.deepEqual(
      repo.listByTest("test-1", 10).map((run) => run.runId),
      ["run-new", "run-old"],
    );

    db.prepare(
      `
      UPDATE prompt_pack_runs
      SET
        diagnostic_metadata_json = ?,
        derived_response_signals_json = ?,
        trace_json = ?,
        citations_json = ?,
        integrity_json = ?
      WHERE run_id = ?
    `,
    ).run("{bad", "{bad", "{bad", "{bad", "{bad", "run-new");

    const malformed = repo.get("run-new");
    assert.equal(malformed.diagnosticMetadata, undefined);
    assert.equal(malformed.derivedResponseSignals, undefined);
    assert.equal(malformed.trace, undefined);
    assert.equal(malformed.citations, undefined);
    assert.equal(malformed.integrity, undefined);

    assert.equal(repo.deleteByPack("pack-1"), 2);
    assert.deepEqual(repo.listByPack("pack-1"), []);
  });
});
