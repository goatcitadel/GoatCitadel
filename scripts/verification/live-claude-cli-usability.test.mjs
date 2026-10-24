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
  runLane,
  runUsabilityTask,
  streamClosedWithoutTurnError,
} from "./live-claude-cli-usability.mjs";

const byId = (id) => CLAUDE_CLI_USABILITY_TASKS.find((task) => task.id === id);
// No catalog task expects a Code Mode run any more (#494), so the grading rule is covered with a synthetic one.
const codeModeTask = Object.freeze({
  ...byId("K-02"),
  id: "CODE-MODE",
  expect: { status: ["completed"], codeModeRun: true },
});
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
  assert.equal(body.prefsOverride.toolAutonomy, "safe_auto");
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
  const k01 = codeModeTask;
  const hosts = { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" };
  const browsed = [{ toolName: "browser.navigate", status: "executed" }];
  assert.equal(classifyUsabilityOutcome(turn({ citations: [{}], toolRuns: browsed }), r01).verdict, "failed");
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
    classifyUsabilityOutcome(turn({ toolRuns: [{ toolName: "code_mode.run", status: "executed" }] }), k02).verdict,
    "failed",
  );
  assert.equal(classifyUsabilityOutcome(turn({ codeModeRunId: "run-1" }), k01).verdict, "passed");
  assert.equal(
    classifyUsabilityOutcome(turn({ toolRuns: [{ toolName: "fs.list", status: "executed" }] }), k01).verdict,
    "failed",
  );
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

test("runUsabilityTask settles the turn (and its approvals) while the stream is still open, then closes the stream", async () => {
  const order = [];
  const deps = {
    createTaskSession: async () => "s1",
    openTurnStream: async () => ({
      turnId: "t1",
      started: performance.now(),
      finish: async () => {
        order.push("finish");
        return { sseEventTypes: ["delta"], firstDeltaSeconds: 1.5 };
      },
    }),
    cancelTurn: async () => order.push("cancel"),
    settleTurn: async (_gatewayUrl, input) => {
      order.push(`settle:${input.turnId}:${input.approval}`);
      return { turn: { trace: { status: "completed" } }, approvalsResolved: 1 };
    },
  };
  const result = await runUsabilityTask("http://gateway.test", byId("D-01"), { deps });
  assert.deepEqual(order, ["settle:t1:approve", "finish"]);
  assert.equal(result.approvalsResolved, 1);
  assert.equal(result.secondsToFirstDelta, 1.5);
  assert.equal(result.sessionId, "s1");

  order.length = 0;
  await runUsabilityTask("http://gateway.test", byId("C-02"), { deps });
  assert.deepEqual(order, ["cancel", "settle:t1:none", "finish"]);
});

test("classifyUsabilityOutcome fails a reply that is raw tool-call markup, even when nothing else was expected", () => {
  const markup = '<invoke name="fs.list">\n<parameter name="path">C:\tmp</parameter>\n</invoke>';
  const k02 = classifyUsabilityOutcome(turn({}, markup), byId("K-02"));
  assert.equal(k02.verdict, "failed");
  assert.match(k02.reasons.join(";"), /raw tool-call markup/);
  assert.equal(
    classifyUsabilityOutcome(turn({}, "The invoke keyword is described below."), byId("K-02")).verdict,
    "passed",
  );
});

test("streamClosedWithoutTurnError carries the stream's own error events", () => {
  const plain = streamClosedWithoutTurnError("C-03", []);
  assert.equal(plain.message, "C-03 stream closed without naming its turn");
  const withErrors = streamClosedWithoutTurnError("C-03", [
    { type: "error", code: "STATE_CONFLICT", error: "Turn is not editable" },
    { type: "error", message: "second" },
  ]);
  assert.match(
    withErrors.message,
    /C-03 stream closed without naming its turn: STATE_CONFLICT Turn is not editable; second/,
  );
});

test("runUsabilityTask lets the stream end on its own after the turn settles, so the session write lock is released", async () => {
  const order = [];
  const deps = {
    createTaskSession: async () => "s1",
    openTurnStream: async () => ({
      turnId: "t1",
      started: performance.now(),
      ended: new Promise((resolve) =>
        setTimeout(() => {
          order.push("ended");
          resolve();
        }, 20),
      ),
      finish: async () => {
        order.push("finish");
        return { sseEventTypes: ["done"], firstDeltaSeconds: 1 };
      },
    }),
    cancelTurn: async () => undefined,
    settleTurn: async () => {
      order.push("settle");
      return { turn: { trace: { status: "completed" } }, approvalsResolved: 0 };
    },
  };
  await runUsabilityTask("http://gateway.test", byId("C-01"), { deps });
  assert.deepEqual(order, ["settle", "ended", "finish"]);
});

test("a cancelled turn must still have been routed to the CLI", () => {
  const c02 = byId("C-02");
  assert.equal(
    classifyUsabilityOutcome({ trace: { ...base, status: "cancelled", routing: {} } }, c02).verdict,
    "failed",
  );
  assert.equal(classifyUsabilityOutcome({ trace: { ...base, status: "cancelled" } }, c02).verdict, "passed");
});

function fakeLaneDeps(order, overrides = {}) {
  return {
    readAuth: () => ({ ready: true, reason: "ready", accountEmail: "person@example.test" }),
    runScenario: async (_context, definition, fn) => {
      order.push(definition.id);
      try {
        const result = await fn();
        order.push(`${definition.id}:${result?.status}`);
      } catch {
        order.push(`${definition.id}:failed`);
      }
    },
    startSandbox: async () => {
      order.push("start");
      return { gatewayUrl: "http://gateway.test" };
    },
    stopSandbox: async () => order.push("stop"),
    runTasks: async () => order.push("tasks"),
    assertRedaction: async () => order.push("redaction-scan"),
    findLeaks: async () => {
      order.push("email-scan");
      return [];
    },
    completeSourceState: async () => ({ status: "passed" }),
    ...overrides,
  };
}

test("runLane stops the sandbox, so its logs exist, before the evidence scans run", async () => {
  const order = [];
  await runLane({ artifactRoot: "root" }, {}, fakeLaneDeps(order));
  assert.ok(order.indexOf("stop") > order.indexOf("tasks"));
  assert.ok(order.indexOf("stop") < order.indexOf("redaction-scan"));
  assert.ok(order.indexOf("stop") < order.indexOf("email-scan"));
  assert.ok(order.includes("claude-cli-usability.startup:passed"));
});

test("runLane records a failed startup and still runs every evidence scenario", async () => {
  const order = [];
  const deps = fakeLaneDeps(order, {
    startSandbox: async () => {
      throw new Error("gateway did not start");
    },
  });
  await runLane({ artifactRoot: "root" }, {}, deps);
  assert.ok(order.includes("claude-cli-usability.startup:failed"));
  assert.ok(!order.includes("tasks"));
  for (const id of ["artifact-redaction", "account-email", "source-integrity"]) {
    assert.ok(order.includes(`claude-cli-usability.${id}`), id);
  }
});

test("runLane skips the sandbox when the CLI is not signed in, and reports the email scan as skipped without an email", async () => {
  const order = [];
  await runLane(
    { artifactRoot: "root" },
    {},
    fakeLaneDeps(order, { readAuth: () => ({ ready: false, reason: "not_logged_in" }) }),
  );
  assert.ok(order.includes("claude-cli-usability.preflight:failed"));
  assert.ok(!order.includes("start"));
  assert.ok(order.includes("claude-cli-usability.account-email:skipped"));
});

test("runUsabilityTask cancels a stop task only after the turn has streamed text", async () => {
  const order = [];
  const deps = {
    createTaskSession: async () => "s1",
    openTurnStream: async () => ({
      turnId: "t1",
      started: performance.now(),
      firstDelta: new Promise((resolve) =>
        setTimeout(() => {
          order.push("delta");
          resolve();
        }, 20),
      ),
      finish: async () => ({ sseEventTypes: ["delta"], firstDeltaSeconds: 0.02 }),
    }),
    cancelTurn: async () => order.push("cancel"),
    settleTurn: async () => {
      order.push("settle");
      return { turn: { trace: { status: "cancelled" } }, approvalsResolved: 0 };
    },
  };
  await runUsabilityTask("http://gateway.test", byId("C-02"), { deps });
  assert.deepEqual(order, ["delta", "cancel", "settle"]);
});

test("a completed turn that used no tools and only missed citations or a Code Mode run is model_declined", () => {
  const r01 = classifyUsabilityOutcome(turn({ citations: [{}] }, "HTTP/3 runs over QUIC."), byId("R-01"));
  assert.equal(r01.verdict, "model_declined");
  assert.match(r01.reasons.join(";"), /citation/);
  assert.equal(
    classifyUsabilityOutcome(turn({}, "Here is the script: print(1)"), codeModeTask).verdict,
    "model_declined",
  );
  const markup = '<invoke name="fs.list">\n</invoke>';
  assert.equal(classifyUsabilityOutcome(turn({}, markup), codeModeTask).verdict, "failed");
  assert.equal(classifyUsabilityOutcome(turn({ status: "partial" }, "prose"), codeModeTask).verdict, "failed");
});

test("a failed turn's reasons carry the trace failure class and message", () => {
  const failure = { failureClass: "provider_timeout", message: "Claude Code CLI did not answer in time." };
  const graded = classifyUsabilityOutcome(turn({ status: "failed", failure }), byId("C-01"));
  assert.equal(graded.verdict, "failed");
  assert.match(graded.reasons.join(";"), /provider_timeout: Claude Code CLI did not answer in time\./);
});

test("an expected tool only counts when it executed, so a failed or unapproved PDF is not a pass", () => {
  const d01 = byId("D-01");
  for (const status of ["failed", "blocked", "approval_required"]) {
    const graded = classifyUsabilityOutcome(
      turn({ status: "partial", toolRuns: [{ toolName: "documents.create", status }] }),
      d01,
    );
    assert.equal(graded.verdict, "failed", status);
    assert.ok(graded.reasons.join(";").includes(`documents.create did not execute (${status})`), status);
  }
});

test("K-01 runs on Safe Auto and passes only as a plain decline that names the switch and saves no code (#494)", () => {
  const k01 = byId("K-01");
  // The shipped policy denies fs.write and shell.exec and Code Mode is not a model tool, so the lane must
  // exercise the bridged path (manual autonomy gives the CLI no tools) and grade the honest outcome.
  assert.equal(k01.prefs.toolAutonomy, "safe_auto");
  assert.equal(k01.expect.codeModeRun, undefined);
  const listed = [{ toolName: "fs.list", status: "executed", args: { path: "." } }];
  const decline =
    "I can't write or run the script here: this workspace's tool policy turns off file writes and shell commands. " +
    "An operator can set fs.write to Available in Settings › Tools › Global filesystem tool access.";
  assert.equal(classifyUsabilityOutcome(turn({ toolRuns: listed }, decline), k01).verdict, "passed");
  const vague = classifyUsabilityOutcome(turn({ toolRuns: listed }, "I could not run that, sorry."), k01);
  assert.equal(vague.verdict, "failed");
  assert.match(vague.reasons.join(";"), /reply does not match/);
  const savedCode = [
    ...listed,
    { toolName: "documents.create", status: "executed", args: { path: "fibonacci.py", format: "txt" } },
  ];
  assert.equal(classifyUsabilityOutcome(turn({ toolRuns: savedCode }, decline), k01).verdict, "failed");
});

test("only code_mode.run counts as a Code Mode run; code search tools do not", () => {
  const search = { toolRuns: [{ toolName: "code.search", status: "executed" }] };
  assert.equal(classifyUsabilityOutcome(turn(search), codeModeTask).verdict, "failed");
  assert.equal(classifyUsabilityOutcome(turn(search), byId("K-02")).verdict, "passed");
  const run = { toolRuns: [{ toolName: "code_mode.run", status: "executed" }] };
  assert.equal(classifyUsabilityOutcome(turn(run), codeModeTask).verdict, "passed");
  assert.equal(classifyUsabilityOutcome(turn(run), byId("K-02")).verdict, "failed");
});

test("streamClosedWithoutTurnError keeps a stream read failure as the cause", () => {
  const readError = Object.assign(new Error("terminated"), { name: "TypeError" });
  const error = streamClosedWithoutTurnError("C-01", [], readError);
  assert.match(error.message, /C-01 stream closed without naming its turn: stream read failed: TypeError: terminated/);
  assert.equal(error.cause, readError);
  const both = streamClosedWithoutTurnError("C-01", [{ type: "error", error: "Conflict" }], readError);
  assert.match(both.message, /Conflict; stream read failed: TypeError: terminated/);
});
