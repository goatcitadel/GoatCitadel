import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { assertOwnedGatewayRestart, assertRuntimeTruthApprovalLifecycle, observeRecoveredThreadResponse } from "./runtime-truth-lane.mjs";
import { assertRuntimeTruthToolCompletion, RUNTIME_TRUTH_NOTE } from "./runtime-truth-approval.mjs";

test("recovered-thread observation retains the actual response before readiness and disposes its listener", () => {
  const page = new EventEmitter();
  const observe = observeRecoveredThreadResponse(page, "recovered/session");
  const response = (session, status = 200, method = "GET") => ({
    url: () => `http://127.0.0.1:43210/api/v1/chat/sessions/${encodeURIComponent(session)}/thread`,
    status: () => status,
    request: () => ({ method: () => method }),
  });
  for (const ignored of [response("foreign"), response("recovered/session", 401), response("recovered/session", 200, "POST")]) {
    page.emit("response", ignored);
    assert.equal(observe.read(), undefined);
  }
  const exact = response("recovered/session");
  page.emit("response", exact);
  assert.equal(observe.read(), exact);
  page.emit("response", response("recovered/session"));
  assert.equal(observe.read(), exact, "a later read must not replace the first identity-bearing response");
  observe.dispose();
  observe.dispose();
  assert.equal(page.listenerCount("response"), 0);
});

test("recovered-thread observation accepts the Cockpit core-state read and unwraps its thread", async () => {
  const page = new EventEmitter();
  const observe = observeRecoveredThreadResponse(page, "session");
  const thread = { sessionId: "session", turns: [{ trace: { status: "completed", durable: { runId: "run-one" } } }] };
  const response = (suffix, body) => ({
    url: () => `http://127.0.0.1:43210/api/v1/chat/sessions/session/${suffix}`,
    status: () => 200,
    request: () => ({ method: () => "GET" }),
    json: async () => body,
  });
  page.emit("response", response("core-state?includeThread=false", { sessionId: "session" }));
  page.emit("response", response("control", thread));
  assert.equal(observe.read(), undefined, "a thread-less core-state read or another session read is not identity");
  const coreState = response("core-state", { sessionId: "session", thread, binding: null, prefs: {} });
  page.emit("response", coreState);
  assert.equal(observe.read(), coreState);
  assert.deepEqual(await observe.readThread(coreState), thread);
  assert.deepEqual(await observe.readThread(response("thread", thread)), thread);
  observe.dispose();
});

const batchedThread = { sessionId: "session", turns: [{ trace: { status: "completed", durable: { runId: "run-one" } } }] };
function startupReadsPage() {
  const page = new EventEmitter();
  page.waitForResponse = (predicate, { timeout }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { page.off("response", listener); reject(new Error("timeout")); }, timeout);
    const listener = response => {
      if (!predicate(response)) return;
      clearTimeout(timer);
      page.off("response", listener);
      resolve(response);
    };
    page.on("response", listener);
  });
  return page;
}
function getResponse(pathAndQuery, body) {
  return {
    url: () => `http://127.0.0.1:43210${pathAndQuery}`,
    status: () => 200,
    request: () => ({ method: () => "GET" }),
    json: async () => body,
  };
}
const startupReads = (paths, items) =>
  getResponse(`/api/v1/startup-reads?${new URLSearchParams({
    reads: JSON.stringify(paths.map((path, index) => ({ path, correlationId: `c${index}` }))),
  })}`, { items });

test("recovered-thread observation reads the thread from a batched startup read", async () => {
  const page = startupReadsPage();
  const observe = observeRecoveredThreadResponse(page, "session");
  page.emit("response", startupReads(["/api/v1/settings", "/api/v1/chat/sessions/other/core-state"], []));
  assert.equal(observe.read(), undefined, "a batch without this session's thread read is not identity");
  const batch = startupReads(
    ["/api/v1/settings", "/api/v1/chat/sessions/session/control", "/api/v1/chat/sessions/session/core-state"],
    [
      { status: 200, bodyText: "{}", headers: {} },
      { status: 200, bodyText: "{}", headers: {} },
      { status: 200, bodyText: JSON.stringify({ sessionId: "session", thread: batchedThread }), headers: {} },
    ],
  );
  page.emit("response", batch);
  assert.equal(observe.read(), batch);
  assert.deepEqual(await observe.resolveThread(1000), batchedThread);
  observe.dispose();
  assert.equal(page.listenerCount("response"), 0);
});

test("recovered-thread observation follows a batch entry's direct-read fallback", async () => {
  const page = startupReadsPage();
  const observe = observeRecoveredThreadResponse(page, "session");
  page.emit("response", startupReads(
    ["/api/v1/chat/sessions/session/core-state"],
    [{ status: 409, bodyText: "", headers: {}, directReadRequired: true }],
  ));
  page.emit("response", startupReads(["/api/v1/chat/sessions/session/core-state?includeThread=false"], [
    { status: 200, bodyText: JSON.stringify({ sessionId: "session" }), headers: {} },
  ]));
  const pending = observe.resolveThread(1000);
  setTimeout(() => page.emit("response", getResponse("/api/v1/chat/sessions/session/core-state", {
    sessionId: "session", thread: batchedThread,
  })), 0);
  assert.deepEqual(await pending, batchedThread);
  await assert.rejects(observeRecoveredThreadResponse(startupReadsPage(), "session").resolveThread(20), /deadline|timeout/u);
  observe.dispose();
});

test("the startup-read batch path mirrors the contracts owner", async () => {
  const { readFile } = await import("node:fs/promises");
  const contracts = await readFile(new URL("../../../../packages/contracts/src/gateway-startup-reads.ts", import.meta.url), "utf8");
  const lane = await readFile(new URL("./runtime-truth-lane.mjs", import.meta.url), "utf8");
  const owner = contracts.match(/STARTUP_READ_BATCH_PATH = "([^"]+)"/u)?.[1];
  assert.ok(owner);
  assert.match(lane, new RegExp(`const STARTUP_READ_BATCH_PATH = "${owner.replaceAll("/", "\\/")}";`, "u"));
});

test("recovered-thread observation does not invent a response or survive failed navigation cleanup", () => {
  const page = new EventEmitter();
  const observe = observeRecoveredThreadResponse(page, "session");
  assert.equal(observe.read(), undefined);
  observe.dispose();
  page.emit("response", { url: () => "http://127.0.0.1/api/v1/chat/sessions/session/thread",
    status: () => 200, request: () => ({ method: () => "GET" }) });
  assert.equal(observe.read(), undefined);
  assert.equal(page.listenerCount("response"), 0);
});

test("runtime truth requires the original approved read and persisted response, not a completed run alone", () => {
  const approval = {
    turnId: "turn-one",
    toolRunId: "read-one",
    approvalId: "approval-one",
    chatTurnDurableRunId: "run-one",
  };
  const fixture = () => ({
    turns: [
      {
        turnId: approval.turnId,
        trace: { status: "completed", durable: { runId: approval.chatTurnDurableRunId } },
        assistantMessage: { messageId: "assistant-one" },
        toolRuns: [
          {
            toolRunId: approval.toolRunId,
            toolName: "fs.read",
            approvalId: approval.approvalId,
            status: "executed",
            args: { path: "fixture.txt" },
            result: { content: RUNTIME_TRUTH_NOTE },
          },
        ],
      },
    ],
  });
  assert.deepEqual(assertRuntimeTruthToolCompletion(fixture(), approval, "fixture.txt"), {
    turnId: "turn-one",
    assistantMessageId: "assistant-one",
    toolRunId: "read-one",
    toolStatus: "executed",
  });
  for (const mutate of [
    (turn) => {
      turn.trace.durable.runId = "replacement-run";
    },
    (turn) => {
      delete turn.assistantMessage;
    },
    (turn) => {
      turn.toolRuns.push({ ...turn.toolRuns[0], toolRunId: "repeated-read" });
    },
    (turn) => {
      turn.toolRuns[0].approvalId = "unrelated-approval";
    },
    (turn) => {
      turn.toolRuns[0].status = "approval_required";
    },
    (turn) => {
      turn.toolRuns[0].result = { content: "unrelated file" };
    },
    (turn) => {
      turn.toolRuns[0].args.path = "another-file.txt";
    },
  ]) {
    const invalid = fixture();
    mutate(invalid.turns[0]);
    assert.throws(() => assertRuntimeTruthToolCompletion(invalid, approval, "fixture.txt"));
  }
});

test("runtime truth accepts a new owned process on the same isolated Gateway endpoint", () => {
  assert.doesNotThrow(() =>
    assertOwnedGatewayRestart(
      { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
      { pid: 4102, gatewayUrl: "http://127.0.0.1:43111" },
    ),
  );
});

test("runtime truth rejects a restart without a distinct owned Gateway process", () => {
  assert.throws(
    () =>
      assertOwnedGatewayRestart(
        { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
        { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
      ),
    /reused process 4101/,
  );
});

test("runtime truth rejects a restart that moves away from the original loopback endpoint", () => {
  assert.throws(
    () =>
      assertOwnedGatewayRestart(
        { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
        { pid: 4102, gatewayUrl: "http://127.0.0.1:43112" },
      ),
    /changed endpoint/,
  );
});

test("runtime truth binds approval recovery to its wait run and the original resumed Chat run", () => {
  const fixture = () => ({
    canonical: { runId: "approval-wait" },
    approval: { approvalId: "approval-one", status: "approved", linkage: { runId: "chat-one", durableRunId: "approval-wait" } },
    durableRun: { runId: "approval-wait", status: "completed" },
  });
  assert.equal(assertRuntimeTruthApprovalLifecycle(fixture(), "approval-one", "chat-one"), "approval-wait");
  for (const mutate of [
    (value) => { value.approval.approvalId = "unrelated"; },
    (value) => { value.approval.status = "rejected"; },
    (value) => { value.approval.linkage.runId = "another-chat"; },
    (value) => { value.approval.linkage.durableRunId = "another-wait"; },
    (value) => { value.canonical.runId = "chat-one"; },
    (value) => { value.durableRun.runId = "chat-one"; },
    (value) => { value.durableRun.status = "waiting"; },
  ]) {
    const invalid = fixture();
    mutate(invalid);
    assert.throws(() => assertRuntimeTruthApprovalLifecycle(invalid, "approval-one", "chat-one"));
  }
});
