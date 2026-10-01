import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertTaskChanged, assertTaskCreated, waitForTaskDetailsOwner } from "./cockpit-task-lifecycle-proof.mjs";
import { assertWorkDraftFields, assertWorkDraftTransition, keepWorkDraftOnLeave } from "./cockpit-work-draft-proof.mjs";

const request = { workspaceId: "owned-workspace", title: "Owned task", description: "Evidence", priority: "normal" };
const task = { ...request, taskId: "owned-task", revision: 1, status: "inbox",
  createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" };
const createProof = () => ({ request, receipt: task, owner: task, workspaceId: request.workspaceId });
const fields = { description: "Reviewed change", priority: "high", title: task.title };
const saved = { ...task, ...fields, revision: 2, updatedAt: "2026-09-30T00:00:01.000Z" };
const changeProof = () => ({ before: task, fields, request: { workspaceId: task.workspaceId, expectedRevision: 1, ...fields },
  receipt: saved, owner: saved, workspaceId: task.workspaceId });

describe("task lifecycle browser proof owner binding", () => {
  it("accepts an exact plain create and numeric-CAS metadata receipt with independent owner readback", () => {
    assert.doesNotThrow(() => assertTaskCreated(createProof()));
    assert.doesNotThrow(() => assertTaskChanged(changeProof()));
  });
  it("rejects a create that changes scope, default state, identity, timestamps or runtime ownership", () => {
    for (const patch of [{ workspaceId: "foreign" }, { revision: 2 }, { status: "running" }, { assignedAgentId: "agent" },
      { updatedAt: "2026-09-30T00:00:01.000Z" }, { taskId: "" }, { agenticContext: {} }, { proactiveContext: {} }]) {
      const wrong = { ...task, ...patch };
      assert.throws(() => assertTaskCreated({ ...createProof(), receipt: wrong, owner: wrong }));
    }
    assert.throws(() => assertTaskCreated({ ...createProof(), owner: { ...task, taskId: "other" } }));
    assert.throws(() => assertTaskCreated({ ...createProof(), request: { ...request, launch: true } }));
  });
  it("rejects stale CAS, extra request fields, substituted owner records and unrelated canonical changes", () => {
    for (const patch of [{ taskId: "other" }, { workspaceId: "foreign" }, { revision: 3 }, { status: "blocked" },
      { createdAt: saved.updatedAt }, { updatedAt: "invalid" }, { agenticContext: {} }, { proactiveContext: {} }]) {
      const wrong = { ...saved, ...patch };
      assert.throws(() => assertTaskChanged({ ...changeProof(), receipt: wrong, owner: wrong }));
    }
    assert.throws(() => assertTaskChanged({ ...changeProof(), request: { ...changeProof().request, expectedRevision: 2 } }));
    assert.throws(() => assertTaskChanged({ ...changeProof(), request: { ...changeProof().request, run: true } }));
    assert.throws(() => assertTaskChanged({ ...changeProof(), owner: { ...saved, revision: 3 } }));
  });
  it("records status and actual catalog assignment as exact board-only changes", () => {
    for (const change of [{ status: "blocked" }, { assignedAgentId: "actual-catalog-agent" }]) {
      const owner = { ...task, ...change, revision: 2, updatedAt: saved.updatedAt };
      assert.doesNotThrow(() => assertTaskChanged({ before: task, fields: change,
        request: { workspaceId: task.workspaceId, expectedRevision: 1, ...change }, receipt: owner, owner, workspaceId: task.workspaceId }));
    }
  });
});

describe("task detail browser settlement", () => {
  it("waits for the verified own-save acknowledgement without clicking its transient stale button", async () => {
    let release;
    const acknowledgement = new Promise(resolve => { release = resolve; });
    const calls = [];
    const details = {
      getByText(text, options) {
        assert.match(text, /^Gateway recorded the task details\./);
        assert.deepEqual(options, { exact: true });
        return { waitFor: async () => { calls.push("acknowledgement"); await acknowledgement; } };
      },
      getByRole() { throw new Error("Own receipt must not click the ephemeral stale button"); },
    };
    const page = { waitForFunction: async (_predicate, expected) => {
      assert.equal(expected, saved); calls.push("exact editor readiness");
    } };
    const pending = waitForTaskDetailsOwner({ page, details, owner: saved, confirmedSave: true });
    assert.deepEqual(calls, ["acknowledgement"]);
    release(); await pending;
    assert.deepEqual(calls, ["acknowledgement", "exact editor readiness"]);
  });

  it("keeps explicit external-owner adoption and checks all fields plus exact selected task identity", async () => {
    const calls = [];
    const controls = {
      'input[maxlength="160"]': { value: saved.title, disabled: false },
      'textarea[aria-label="Description"]': { value: saved.description, disabled: false },
      'select[aria-label="Priority"]': { value: saved.priority, disabled: false },
    };
    const details = { getByRole(role, options) {
      assert.equal(role, "button"); assert.deepEqual(options, { name: "Load current details", exact: true });
      return { isVisible: async () => true, click: async () => { calls.push("explicit adoption"); } };
    } };
    const originalDocument = globalThis.document, originalWindow = globalThis.window;
    try {
      globalThis.document = { querySelector: selector => {
        assert.equal(selector, 'section[aria-label="Task details editor"]');
        return { querySelector: name => controls[name] };
      } };
      globalThis.window = { location: { pathname: `/work/tasks/${saved.taskId}` } };
      const page = { waitForFunction: async (predicate, expected) => {
        assert.deepEqual(calls, ["explicit adoption"]);
        assert.equal(predicate(expected), true);
        for (const control of Object.values(controls)) {
          control.disabled = true; assert.equal(predicate(expected), false); control.disabled = false;
          const before = control.value; control.value = "foreign";
          assert.equal(predicate(expected), false); control.value = before;
        }
        globalThis.window.location.pathname = "/work/tasks/foreign";
        assert.equal(predicate(expected), false);
      } };
      await waitForTaskDetailsOwner({ page, details, owner: saved });
    } finally {
      if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    }
  });
});

describe("Work task draft browser fences", () => {
  const before = { url: "http://127.0.0.1:5173/work/tasks/owned-task?shell=cockpit",
    writes: 2, documents: 1, timeOrigin: 12345, marker: "owned-document", sameRoot: true,
    selection: { workspace: "owned-workspace", citadel: "owned-citadel" } };
  const targetUrl = "http://127.0.0.1:5173/work?shell=cockpit";
  const proof = decision => ({ before, decision, targetUrl,
    after: { ...before, url: decision === "cancel" ? before.url : targetUrl } });

  it("requires exact Cancel URL and same-document Keep/Discard destinations with zero writes", () => {
    for (const decision of ["cancel", "keep", "discard"]) assert.doesNotThrow(() => assertWorkDraftTransition(proof(decision)));
    for (const decision of ["cancel", "keep", "discard"]) {
      const value = proof(decision);
      for (const patch of [{ writes: 3 }, { documents: 2 }, { timeOrigin: 67890 }, { marker: "foreign-document" },
        { sameRoot: false }, { selection: { workspace: "foreign", citadel: "owned-citadel" } },
        { selection: { workspace: "owned-workspace", citadel: "foreign" } }, { url: targetUrl + "&foreign=true" },
        { url: "http://127.0.0.1:5173/work" }, { url: "http://127.0.0.1:5173/work?shell=classic" }])
        assert.throws(() => assertWorkDraftTransition({ ...value, after: { ...value.after, ...patch } }));
    }
    assert.throws(() => assertWorkDraftTransition({ ...proof("keep"), targetUrl: "http://127.0.0.1:9787/work",
      after: { ...before, url: "http://127.0.0.1:9787/work" } }));
  });

  it("retains every exact task field and discards to the actual original detail owner", () => {
    const retained = { Title: "Unsent task", Description: "Unsent evidence", Priority: "urgent" };
    const cleared = { Title: task.title, Description: task.description, Priority: task.priority };
    assert.doesNotThrow(() => assertWorkDraftFields(structuredClone(retained), retained));
    assert.doesNotThrow(() => assertWorkDraftFields(structuredClone(cleared), cleared));
    for (const patch of [{ Title: "" }, { Description: "" }, { Priority: "normal" }, { Extra: "unbound" }])
      assert.throws(() => assertWorkDraftFields({ ...retained, ...patch }, retained));
    assert.throws(() => assertWorkDraftFields(retained, cleared));
    assert.throws(() => assertWorkDraftFields({ Title: "", Description: "", Priority: "normal" }, cleared));
  });

  it("requires an explicit Keep decision for dirty unknown-outcome transitions", async () => {
    const calls = [];
    const dialog = {
      waitFor: async options => { calls.push(options?.state === "hidden" ? "dialog hidden" : "dialog visible"); },
      count: async () => 1,
      innerText: async () => "You have unsaved changes in Task details.",
      getByRole: (role, options) => {
        assert.equal(role, "button"); assert.deepEqual(options, { name: "Keep draft and close", exact: true });
        return { click: async () => { calls.push("keep"); } };
      },
    };
    const page = { getByRole: (role, options) => {
      assert.equal(role, "dialog"); assert.deepEqual(options, { name: "Unsaved changes", exact: true }); return dialog;
    } };
    await keepWorkDraftOnLeave({ page, label: "Task details", action: async () => { calls.push("request leave"); } });
    assert.deepEqual(calls, ["request leave", "dialog visible", "keep", "dialog hidden"]);
    for (const invalid of [{ count: async () => 2 }, { innerText: async () => "Another editor" }]) {
      const wrong = { getByRole: () => ({ ...dialog, ...invalid }) };
      await assert.rejects(keepWorkDraftOnLeave({ page: wrong, label: "Task details", action: async () => {} }));
    }
  });
});
