import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeControlsBaseline } from "./cockpit-runtime-controls-proof.mjs";
const input = () => ({ before: { source: "manual", catalog: [{ id: "base" }] }, after: { source: "manual", catalog: [{ id: "base" }] }, request: { modelId: "base", activate: true }, modelId: "base", writes: 1, daemonBefore: { pid: 123 }, daemonAfter: { pid: 123 } });
test("accepts an unchanged actual owner with exact intercepted request", () => assert.doesNotThrow(() => assertRuntimeControlsBaseline(input())));
test("rejects actual voice mutation, substituted model and duplicate write", () => {
  for (const changed of [{ after: { source: "managed" } }, { request: { modelId: "foreign", activate: true } }, { writes: 2 }]) assert.throws(() => assertRuntimeControlsBaseline({ ...input(), ...changed }));
});
test("rejects a changed Gateway process or daemon command record", () => {
  for (const daemonAfter of [{ pid: 456 }, { pid: 123, lastCommandAt: "unexpected" }]) assert.throws(() => assertRuntimeControlsBaseline({ ...input(), daemonAfter }));
});
