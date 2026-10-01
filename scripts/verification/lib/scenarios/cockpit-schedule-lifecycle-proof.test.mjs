import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertScheduleToggle, scheduleConfiguration } from "./cockpit-schedule-lifecycle-proof.mjs";
import { assertWorkDraftFields, assertWorkDraftTransition } from "./cockpit-work-draft-proof.mjs";
const before = { jobId: "owned", revision: 2, name: "Owned", action: "task", enabled: true, schedule: "0 0 1 1 *" };
const owner = { ...before, revision: 3, enabled: false };
const proof = () => ({ before, owner, receipt: owner, enabled: false, request: { expectedRevision: 2 } });
describe("schedule browser proof binding", () => {
  it("accepts exact CAS configuration and independent owner receipt", () => assert.doesNotThrow(() => assertScheduleToggle(proof())));
  it("rejects substituted jobs, revisions, request payloads and changed execution telemetry", () => {
    for (const patch of [{ jobId: "foreign" }, { revision: 2 }, { action: "backup" }, { schedule: "* * * * *" }, { enabled: true }, { lastRunId: "unexpected" }]) {
      assert.throws(() => assertScheduleToggle({ ...proof(), owner: { ...owner, ...patch }, receipt: { ...owner, ...patch } }));
    }
    assert.throws(() => assertScheduleToggle({ ...proof(), request: { expectedRevision: 2, force: true } }));
    assert.throws(() => assertScheduleToggle({ ...proof(), receipt: { ...owner, revision: 4 } }));
  });
  it("preserves prior configuration without pretending changing telemetry is configuration", () => {
    assert.deepEqual(scheduleConfiguration(before), scheduleConfiguration({ ...before, lastRunAt: "new" }));
    assert.notDeepEqual(scheduleConfiguration(before), scheduleConfiguration({ ...before, actionConfig: { command: "other" } }));
  });
});

describe("Work schedule draft browser fences", () => {
  it("retains all unsent controls and clears only to the exact new-form defaults", () => {
    const retained = { Name: "Unsent schedule", "Cron schedule": "0 12 * * 1 UTC", Action: "cost_report" };
    const cleared = { Name: "", "Cron schedule": "0 9 * * *", Action: "task" };
    assert.doesNotThrow(() => assertWorkDraftFields(structuredClone(retained), retained));
    assert.doesNotThrow(() => assertWorkDraftFields(structuredClone(cleared), cleared));
    for (const field of Object.keys(retained))
      assert.throws(() => assertWorkDraftFields({ ...retained, [field]: cleared[field] }, retained));
    for (const field of Object.keys(cleared))
      assert.throws(() => assertWorkDraftFields({ ...cleared, [field]: retained[field] }, cleared));
    assert.throws(() => assertWorkDraftFields({ Name: "" }, cleared));
    assert.throws(() => assertWorkDraftFields({ ...cleared, jobId: "unintended" }, cleared));
  });

  it("withholds a schedule draft proof on write, installation, selection, or document changes", () => {
    const initial = { url: "http://127.0.0.1:5173/work/schedules?shell=cockpit", writes: 0, documents: 1,
      timeOrigin: 12345, marker: "owned-document", sameRoot: true,
      selection: { workspace: "owned-workspace", citadel: "owned-citadel" } };
    const targetUrl = "http://127.0.0.1:5173/work/history?shell=cockpit";
    for (const decision of ["cancel", "keep", "discard"]) {
      const after = { ...initial, url: decision === "cancel" ? initial.url : targetUrl };
      const exact = { before: initial, after, targetUrl, decision };
      assert.doesNotThrow(() => assertWorkDraftTransition(exact));
      for (const patch of [{ writes: 1 }, { documents: 2 }, { marker: "foreign" }, { sameRoot: false },
        { selection: { workspace: "other", citadel: "owned-citadel" } },
        { url: "http://127.0.0.1:5173/work/history" }, { url: "http://127.0.0.1:5173/work/history?shell=classic" }])
        assert.throws(() => assertWorkDraftTransition({ ...exact, after: { ...after, ...patch } }));
      assert.throws(() => assertWorkDraftTransition({ ...exact, targetUrl: "http://127.0.0.1:6173/work/history" }));
    }
  });
});
