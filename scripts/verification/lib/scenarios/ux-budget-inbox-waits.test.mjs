import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNativeInboxOwner, assertCompletedBackgroundOwner } from "./ux-budget-inbox-waits.mjs";

const question = { id: "user_input:prompt-a", kind: "user_input",
  source: { workspaceId: "isolated", sessionId: "session-a", turnId: "turn-a", promptId: "prompt-a" } };
const questionHref = "/inbox?item=user_input%3Aprompt-a&sessionId=session-a&turnId=turn-a&workspaceId=isolated&shell=cockpit";
const update = { id: "completed_background_run:watcher-a", kind: "completed_background_run",
  source: { workspaceId: "isolated", runId: "child-a" } };
const updateHref = "/work/runs/child-a?runId=child-a&workspaceId=isolated&shell=cockpit";

describe("native Inbox owner evidence", () => {
  it("accepts native owners independent of query serialization order and retains exact identities", () => {
    assert.equal(assertNativeInboxOwner(question, questionHref, "isolated").pathname, "/inbox");
    assert.equal(assertNativeInboxOwner(update, updateHref, "isolated").pathname, "/work/runs/child-a");
    assertNativeInboxOwner(question,
      "/inbox?shell=cockpit&workspaceId=isolated&turnId=turn-a&sessionId=session-a&item=user_input%3Aprompt-a", "isolated");
  });
  it("rejects a same-title row's substituted item, conversation, turn, workspace or Classic owner", () => {
    for (const [key, value] of [["item", "user_input:prompt-b"], ["sessionId", "session-b"],
      ["turnId", "turn-b"], ["workspaceId", "other"], ["shell", "classic"]]) {
      const changed = new URL(questionHref, "http://verification.invalid");
      changed.searchParams.set(key, value);
      assert.throws(() => assertNativeInboxOwner(question, changed.pathname + changed.search, "isolated"));
    }
    assert.throws(() => assertNativeInboxOwner(question, "//external.invalid" + questionHref, "isolated"));
    assert.throws(() => assertNativeInboxOwner(question, "/\\external.invalid" + questionHref, "isolated"));
    assert.throws(() => assertNativeInboxOwner({ ...question, source: { ...question.source, workspaceId: "other" } }, questionHref, "isolated"));
  });
  it("rejects a forged background run even if either its query or path still matches", () => {
    assert.throws(() => assertNativeInboxOwner(update, updateHref.replace("/child-a", "/orphan-a"), "isolated"));
    assert.throws(() => assertNativeInboxOwner(update, updateHref.replace("runId=child-a", "runId=orphan-a"), "isolated"));
    assert.throws(() => assertNativeInboxOwner(update, updateHref.replace("/work/runs/child-a", "/ops/runtime"), "isolated"));
  });
  it("requires the response and canonical owner to agree on exact completed run and workspace", () => {
    const trace = { runId: "child-a", run: { runId: "child-a", status: "completed", payload: { workspaceId: "isolated" } } };
    assertCompletedBackgroundOwner(trace, "child-a", "isolated");
    for (const changed of [
      { ...trace, runId: "orphan-a" },
      { ...trace, run: { ...trace.run, runId: "orphan-a" } },
      { ...trace, run: { ...trace.run, status: "running" } },
      { ...trace, run: { ...trace.run, payload: { workspaceId: "other" } } },
    ]) assert.throws(() => assertCompletedBackgroundOwner(changed, "child-a", "isolated"));
  });
});
