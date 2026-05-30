import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { LlmEvalProofRepository } from "./llm-eval-proof-repo.js";
import { LlmRuntimeMeasurementRepository } from "./llm-runtime-measurement-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup
    }
  }
});

function createRepos() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-llm-runtime-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    runtime: new LlmRuntimeMeasurementRepository(db),
    evalProof: new LlmEvalProofRepository(db),
  };
}

describe("LLM runtime truth repositories", () => {
  it("stores source-labeled runtime measurements and latest lookups", () => {
    const repos = createRepos();
    repos.runtime.insert({
      measurementId: "m-1",
      providerId: "ollama",
      model: "llama3",
      engineKind: "ollama",
      source: "live",
      status: "completed",
      stream: false,
      sessionId: "sess-1",
      collectedAt: "2026-05-29T01:00:00.000Z",
      metrics: { latencyMs: 1200, totalTokens: 42, estimatedCostUsd: 0 },
      provenance: { collector: "gateway", path: "chat_completion" },
    });
    repos.runtime.insert({
      measurementId: "m-2",
      providerId: "ollama",
      model: "llama3",
      engineKind: "ollama",
      source: "live",
      status: "partial",
      stream: true,
      sessionId: "sess-1",
      collectedAt: "2026-05-29T02:00:00.000Z",
      metrics: { latencyMs: 2400 },
      provenance: { collector: "gateway", path: "chat_completion_stream" },
    });

    assert.equal(repos.runtime.latest("ollama", "llama3")?.measurementId, "m-2");
    assert.equal(repos.runtime.list({ source: "live", status: "completed" }).length, 1);
    assert.equal(repos.runtime.list({ providerId: "ollama", limit: 1 })[0]?.measurementId, "m-2");
  });

  it("stores eval proof evidence records", () => {
    const repos = createRepos();
    repos.evalProof.insert({
      runId: "run-1",
      promptHash: "hash",
      sessionId: "sess-1",
      status: "completed_with_warnings",
      createdAt: "2026-05-29T03:00:00.000Z",
      candidates: [{ providerId: "ollama", model: "llama3", qualityScore: 0.8 }],
      results: [
        {
          providerId: "ollama",
          model: "llama3",
          qualityScore: 0.8,
          measurementSource: "unavailable",
          qualityScoreSource: "operator",
          paretoOptimal: true,
          notes: ["No runtime measurement is available for this provider/model."],
        },
      ],
      warnings: ["No provider call was performed."],
    });

    assert.equal(repos.evalProof.get("run-1")?.results[0]?.paretoOptimal, true);
    assert.equal(repos.evalProof.list(1)[0]?.runId, "run-1");
  });
});
