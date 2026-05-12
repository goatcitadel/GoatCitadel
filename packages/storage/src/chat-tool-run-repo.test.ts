import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
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

function createStore(): { db: DatabaseClient; repo: ChatToolRunRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-tool-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatToolRunRepository(db) };
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

    assert.equal(full.status, "approval_required");
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

    assert.deepEqual(
      repo.listByTurn("turn-a").map((item) => item.toolRunId),
      ["tool-run-b", "tool-run-a"],
    );
    assert.equal(repo.listBySession("session-a", 0).length, 1);
    assert.equal(repo.listBySession("session-a", 3000).length, 3);

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
        .listByTurnIds(["turn-a", "turn-b"])
        .get("turn-a")
        ?.map((item) => item.toolRunId),
      ["tool-run-a", "tool-run-b"],
    );
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
});
