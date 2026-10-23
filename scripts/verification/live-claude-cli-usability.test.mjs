import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLAUDE_CLI_USABILITY_TASKS } from "./lib/scenarios/claude-cli-usability-tasks.mjs";
import {
  LANE,
  buildClaudeCliChatMutation,
  classifyUsabilityOutcome,
  findSecretTextLeaks,
  isSettledTurnStatus,
} from "./live-claude-cli-usability.mjs";

const byId = (id) => CLAUDE_CLI_USABILITY_TASKS.find((task) => task.id === id);
const base = Object.freeze({
  status: "completed",
  toolRuns: [],
  citations: [],
  routing: { effectiveProviderId: "claude-code-cli" },
});
const turn = (trace = {}, content = "") => ({ trace: { ...base, ...trace }, assistantMessage: { content } });

test("the lane has a stable name", () => {
  assert.equal(LANE, "claude-cli-usability");
});

test("isSettledTurnStatus never treats a waiting state as settled", () => {
  for (const s of ["completed", "partial", "failed", "cancelled"]) assert.equal(isSettledTurnStatus(s), true);
  for (const s of [
    "queued",
    "running",
    "waiting_for_tool",
    "waiting_for_approval",
    "waiting_for_user_input",
    undefined,
  ]) {
    assert.equal(isSettledTurnStatus(s), false);
  }
});

test("buildClaudeCliChatMutation carries the CLI provider and the task prefs", () => {
  const { action, body, preflight } = buildClaudeCliChatMutation(byId("R-01"), "claude-sonnet-5-5");
  assert.equal(action, "send");
  assert.equal(body.providerId, "claude-code-cli");
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.webMode, "quick");
  assert.equal(body.prefsOverride.toolAutonomy, "manual");
  assert.equal(body.prefsOverride.orchestrationEnabled, false);
  assert.equal(preflight.action, "send");
  assert.equal(body.content, byId("R-01").prompt);
});

test("buildClaudeCliChatMutation sends the edit content for an edit and rejects unknown actions", () => {
  const c03 = byId("C-03");
  const { action, body } = buildClaudeCliChatMutation(c03, "claude-sonnet-5-5", "edit");
  assert.equal(action, "edit");
  assert.equal(body.content, "Reply with exactly: EDIT_OK");
  assert.throws(() => buildClaudeCliChatMutation(c03, "claude-sonnet-5-5", "fork"), /unsupported/);
});

test("classifyUsabilityOutcome separates a model that declined from a product failure", () => {
  const d01 = byId("D-01");
  assert.equal(classifyUsabilityOutcome(turn(), d01).verdict, "model_declined");
  assert.equal(
    classifyUsabilityOutcome(turn({ toolRuns: [{ toolName: "documents.create", status: "executed" }] }), d01).verdict,
    "passed",
  );
  assert.equal(
    classifyUsabilityOutcome(turn({ toolRuns: [{ toolName: "fs.write", status: "executed" }] }), d01).verdict,
    "failed",
  );
  assert.equal(classifyUsabilityOutcome(turn({ status: "failed" }), d01).verdict, "failed");
  assert.equal(classifyUsabilityOutcome(turn({ routing: { effectiveProviderId: "openai" } }), d01).verdict, "failed");
});

test("classifyUsabilityOutcome enforces citations, Code Mode runs and forbidden executed args", () => {
  const r01 = byId("R-01");
  const k03 = byId("K-03");
  const k02 = byId("K-02");
  const k01 = byId("K-01");
  const hosts = { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" };
  assert.equal(classifyUsabilityOutcome(turn({ citations: [{}] }), r01).verdict, "failed");
  assert.equal(classifyUsabilityOutcome(turn({ citations: [{}, {}] }), r01).verdict, "passed");
  assert.equal(
    classifyUsabilityOutcome(turn({ toolRuns: [{ toolName: "fs.read", status: "executed", args: hosts }] }), k03)
      .verdict,
    "failed",
  );
  assert.equal(
    classifyUsabilityOutcome(turn({ toolRuns: [{ toolName: "fs.read", status: "blocked", args: hosts }] }), k03)
      .verdict,
    "passed",
  );
  assert.equal(classifyUsabilityOutcome(turn({ codeModeRunId: "run-1" }), k02).verdict, "passed");
  assert.equal(
    classifyUsabilityOutcome(turn({ toolRuns: [{ toolName: "code.run", status: "executed" }] }), k02).verdict,
    "failed",
  );
  assert.equal(classifyUsabilityOutcome(turn({ codeModeRunId: "run-1" }), k01).verdict, "passed");
  assert.equal(classifyUsabilityOutcome(turn(), k01).verdict, "failed");
});

test("classifyUsabilityOutcome checks exact replies and reports every reason", () => {
  const c01 = byId("C-01");
  assert.equal(classifyUsabilityOutcome(turn({}, " CLI_OK\n"), c01).verdict, "passed");
  const wrong = classifyUsabilityOutcome(turn({ status: "partial" }, "Sure: CLI_OK"), c01);
  assert.equal(wrong.verdict, "failed");
  assert.equal(wrong.reasons.length, 2);
});

test("findSecretTextLeaks reports files containing the needle and ignores empty needles", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-cli-usability-leaks-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "nested"));
  await fs.writeFile(path.join(dir, "a.json"), '{"who":"Person@Example.test"}');
  await fs.writeFile(path.join(dir, "nested", "b.json"), '{"who":"nobody"}');
  assert.deepEqual(await findSecretTextLeaks(dir, ["person@example.test"]), ["a.json"]);
  assert.deepEqual(await findSecretTextLeaks(dir, ["", undefined]), []);
});
