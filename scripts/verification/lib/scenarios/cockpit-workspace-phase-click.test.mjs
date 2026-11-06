import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { beginWorkspaceClickPhase, readWorkspaceClickPhase } from "./cockpit-workspaces-proof.mjs";
function fixture(archive = 0, restore = 0) {
  const browser = vm.createContext({ window: { __workspaceLifecycleClickCounts: { archive: { pointerdown: archive, click: archive }, restore: { pointerdown: restore, click: restore } } }, performance: { timeOrigin: 1 } });
  const page = { evaluate: async (fn, arg) => {
    browser.argument = arg;
    const result = vm.runInContext(`(${fn.toString()})(argument)`, browser);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  } };
  const click = action => { browser.window.__workspaceLifecycleClickCounts[action].pointerdown++;browser.window.__workspaceLifecycleClickCounts[action].click++; };
  return { browser, page, click };
}
test("RED: prior stale archive click is zero in the fresh archive phase before its new confirmation", async () => {
  const f = fixture(1);const phase = await beginWorkspaceClickPhase(f.page, "archive", 1);
  const snapshot = await readWorkspaceClickPhase(f.page, phase);
  assert.deepEqual(snapshot.counts, { pointerdown: 0, click: 0 });assert.equal(snapshot.diagnosticGap, false);
});
test("RED: one fresh archive confirmation after the stale review reports exactly one, not lifetime two", async () => {
  const f = fixture(1);const phase = await beginWorkspaceClickPhase(f.page, "archive", 1);f.click("archive");
  const snapshot = await readWorkspaceClickPhase(f.page, phase);
  assert.deepEqual(snapshot.counts, { pointerdown: 1, click: 1 });assert.equal(snapshot.diagnosticGap, false);
});
test("first restore click remains one and is not evidence that the historical restore was miscounted", async () => {
  const f = fixture(2);const phase = await beginWorkspaceClickPhase(f.page, "restore", 2);f.click("restore");
  assert.deepEqual((await readWorkspaceClickPhase(f.page, phase)).counts, { pointerdown: 1, click: 1 });
});
test("RED: old or unowned generation tokens cannot fabricate a complete current phase", async () => {
  const f = fixture();const old = await beginWorkspaceClickPhase(f.page, "archive", 1);
  await beginWorkspaceClickPhase(f.page, "archive", 2);
  for (const token of [old, { action: "archive", generation: 0 }]) {
    const snapshot = await readWorkspaceClickPhase(f.page, token);assert.equal(snapshot.diagnosticGap, true);
    assert.deepEqual(snapshot.counts, { pointerdown: null, click: null });
  }
});
test("RED: saturation and decreasing lifetime counters are gaps rather than precise zero or counts", async () => {
  for (const initial of [10_000, 10]) {
    const f = fixture(initial);const phase = await beginWorkspaceClickPhase(f.page, "archive", 1);
    if (initial === 10) f.browser.window.__workspaceLifecycleClickCounts.archive = { pointerdown: 9, click: 9 };
    const snapshot = await readWorkspaceClickPhase(f.page, phase);assert.equal(snapshot.diagnosticGap, true);
    assert.deepEqual(snapshot.counts, { pointerdown: null, click: null });
  }
});
test("missing browser ledger remains explicit unavailable evidence", async () => {
  const f = fixture();const phase = await beginWorkspaceClickPhase(f.page, "restore", 1);delete f.browser.window.__workspaceLifecycleClickCounts;
  const snapshot = await readWorkspaceClickPhase(f.page, phase);assert.equal(snapshot.diagnosticGap, true);
  assert.deepEqual(snapshot.counts, { pointerdown: null, click: null });
});
test("RED: removed phase ownership or a changed document cannot be read as the original phase", async () => {
  for (const change of [f => { delete f.browser.window.__workspaceLifecycleDiagnosticPhase; }, f => { f.browser.performance.timeOrigin = 2; }]) {
    const f = fixture();const phase = await beginWorkspaceClickPhase(f.page, "archive", 1);change(f);
    const snapshot = await readWorkspaceClickPhase(f.page, phase);assert.equal(snapshot.diagnosticGap, true);
    assert.deepEqual(snapshot.counts, { pointerdown: null, click: null });
  }
});
test("RED: phase acquisition failure remains a closed gap and cannot replace the owner journey", async () => {
  const page = { evaluate: async () => { throw new Error("private-phase-error-canary"); } };
  const phase = await beginWorkspaceClickPhase(page, "restore", 1);
  const snapshot = await readWorkspaceClickPhase(page, phase);
  assert.equal(snapshot.diagnosticGap, true);assert.deepEqual(snapshot.counts, { pointerdown: null, click: null });
  assert.ok(!JSON.stringify(snapshot).includes("private-phase-error-canary"));
});
