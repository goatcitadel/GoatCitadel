import assert from "node:assert/strict";
import test from "node:test";

import { assertOwnedGatewayRestart, assertRuntimeTruthApprovalLifecycle } from "./runtime-truth-lane.mjs";
import { assertRuntimeTruthToolCompletion, RUNTIME_TRUTH_NOTE } from "./runtime-truth-approval.mjs";

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
