import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { readHermesNativeTranscript } from "./agent-comparison-hermes-transcript.mjs";

async function fixture(t, { content = "native result", sessionId = "session-1" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "goat-hermes-transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.db"),
    db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT, source TEXT, model TEXT, parent_session_id TEXT, started_at REAL,
    ended_at REAL,end_reason TEXT,message_count INTEGER,tool_call_count INTEGER,cwd TEXT,billing_provider TEXT,tool_names TEXT);
    CREATE TABLE messages (id INTEGER,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,
    tool_name TEXT,effect_disposition TEXT,timestamp REAL,finish_reason TEXT,active INTEGER);
    INSERT INTO sessions VALUES ('session-1','cli','fixture',NULL,1,2,'exit',1,1,'workspace','comparison','["terminal"]');`);
  db.prepare("INSERT INTO messages VALUES (1,?,'tool',?,'call-1',NULL,'terminal',NULL,1.5,NULL,1)").run(
    sessionId,
    content,
  );
  db.close();
  return { root, file };
}

it("retains native correlation and leaves the database bytes unchanged", async (t) => {
  const { root, file } = await fixture(t),
    before = await readFile(file);
  const result = await readHermesNativeTranscript({ stateDirectory: root });
  assert.equal(result.status, "retained");
  assert.equal(result.messages[0].tool_call_id, "call-1");
  assert.equal(result.sessions[0].source, "cli");
  assert.equal(result.approvalDecisions, "not_inferred_from_transcript");
  assert.equal(result.taskOutcome, "unverified");
  assert.deepEqual(await readFile(file), before);
});

it("rejects orphaned and oversized native records", async (t) => {
  for (const [options, message] of [
    [{ sessionId: "other" }, /unbound message/],
    [{ content: "x".repeat(1024 * 1024 + 1) }, /comparison bound/],
  ]) {
    const { root } = await fixture(t, options);
    await assert.rejects(readHermesNativeTranscript({ stateDirectory: root }), message);
  }
});

it("records missing startup state without inventing a native session", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "goat-hermes-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await readHermesNativeTranscript({ stateDirectory: root });
  assert.equal(result.status, "missing");
  assert.deepEqual(result.sessions, []);
  await assert.rejects(readHermesNativeTranscript({ stateDirectory: "relative" }), /absolute/);
});
