import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { RuntimeDecisionTraceRepository } from "./runtime-decision-trace-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): { db: ReturnType<typeof createDatabase>; repo: RuntimeDecisionTraceRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-decision-traces-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new RuntimeDecisionTraceRepository(db) };
}

describe("RuntimeDecisionTraceRepository", () => {
  it("appends, lists, orders, and filters decision traces by linked runtime ids", () => {
    const { repo } = createRepo();

    repo.append({
      decisionId: "decision-2",
      kind: "tool_selected",
      scope: {
        citadelId: "company",
        workspaceId: "default",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        planId: "plan-1",
        toolRunId: "tool-1",
      },
      selected: "Use browser.search",
      rationale: "The turn needed fresh external context.",
      signals: [{ source: "capability", key: "tool_available", value: true }],
      evidenceRefs: [{ refType: "tool_run", refId: "tool-1" }],
      createdAt: "2026-06-18T00:00:02.000Z",
    });
    repo.append({
      decisionId: "decision-1",
      kind: "workflow_choice",
      scope: {
        citadelId: "company",
        workspaceId: "default",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        planId: "plan-1",
      },
      selected: "Use Cowork orchestration",
      rationale: "The operator requested implementation and validation.",
      alternatives: [
        {
          label: "Direct answer",
          outcome: "not_chosen",
          reasonNotChosen: "No code changes would be made.",
        },
      ],
      createdAt: "2026-06-18T00:00:01.000Z",
    });
    repo.append({
      decisionId: "decision-other",
      kind: "direct_answer",
      scope: { sessionId: "session-2", turnId: "turn-2" },
      selected: "Answer directly",
      rationale: "No tools or memory were needed.",
      createdAt: "2026-06-18T00:00:00.000Z",
    });

    const byTurn = repo.list({ sessionId: "session-1", turnId: "turn-1" });
    assert.deepEqual(
      byTurn.map((item) => item.decisionId),
      ["decision-1", "decision-2"],
    );
    assert.equal(byTurn[0]?.alternatives[0]?.label, "Direct answer");
    assert.equal(byTurn[1]?.signals[0]?.source, "capability");
    assert.equal(byTurn[0]?.scope.citadelId, "company");

    const byRun = repo.list({ runId: "run-1" });
    assert.deepEqual(
      byRun.map((item) => item.decisionId),
      ["decision-1", "decision-2"],
    );

    const byTool = repo.list({ toolRunId: "tool-1" });
    assert.deepEqual(
      byTool.map((item) => item.decisionId),
      ["decision-2"],
    );

    const byCitadel = repo.list({ citadelId: "company" });
    assert.deepEqual(
      byCitadel.map((item) => item.decisionId),
      ["decision-1", "decision-2"],
    );
  });

  it("caps arrays, truncates strings, and keeps payloads inside the fixed budget", () => {
    const { db, repo } = createRepo();
    const longText = "x".repeat(20_000);

    repo.append({
      decisionId: "decision-long",
      kind: "execution_plan_revised",
      scope: { sessionId: "session-1", turnId: "turn-1", planId: "plan-1" },
      selected: longText,
      rationale: longText,
      alternatives: Array.from({ length: 20 }, (_, index) => ({
        label: `alternative-${index}-${longText}`,
        outcome: "not_chosen",
        reasonNotChosen: longText,
      })),
      signals: Array.from({ length: 20 }, (_, index) => ({
        source: "routing",
        key: `signal-${index}-${longText}`,
        value: longText,
      })),
      evidenceRefs: Array.from({ length: 20 }, (_, index) => ({
        refType: "turn",
        refId: `turn-${index}-${longText}`,
      })),
    });

    const row = db
      .prepare("SELECT payload_json FROM runtime_decision_traces WHERE decision_id = ?")
      .get("decision-long") as { payload_json: string } | undefined;
    assert.ok(row);
    assert.ok(Buffer.byteLength(row.payload_json, "utf8") <= 16 * 1024);

    const [record] = repo.list({ sessionId: "session-1" });
    assert.ok(record);
    assert.equal(record.alternatives.length <= 5, true);
    assert.equal(record.signals.length <= 12, true);
    assert.equal(record.evidenceRefs.length <= 12, true);
    assert.match(record.rationale, /\[truncated\]|compacted/);
  });

  it("recovers malformed JSON payloads without dropping index linkage", () => {
    const { db, repo } = createRepo();
    db.prepare(
      `
      INSERT INTO runtime_decision_traces (
        decision_id, kind, session_id, turn_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run("decision-bad", "not-a-known-kind", "session-1", "turn-1", "{bad-json", "2026-06-18T00:00:00.000Z");

    const [record] = repo.list({ sessionId: "session-1", turnId: "turn-1" });

    assert.ok(record);
    assert.equal(record.decisionId, "decision-bad");
    assert.equal(record.kind, "unknown");
    assert.equal(record.scope.sessionId, "session-1");
    assert.equal(record.signals[0]?.key, "payload_malformed");
  });

  it("deletes traces by chat session", () => {
    const { repo } = createRepo();
    repo.append({
      kind: "memory_context",
      scope: { sessionId: "session-1", turnId: "turn-1" },
      selected: "Use scoped memory context",
      rationale: "Memory mode was enabled for the turn.",
    });
    repo.append({
      kind: "memory_context",
      scope: { sessionId: "session-2", turnId: "turn-2" },
      selected: "Use scoped memory context",
      rationale: "Memory mode was enabled for another turn.",
    });

    assert.equal(repo.deleteBySession("session-1"), 1);
    assert.equal(repo.list({ sessionId: "session-1" }).length, 0);
    assert.equal(repo.list({ sessionId: "session-2" }).length, 1);
  });
});
