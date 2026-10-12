import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import test from "node:test";
import {
  observeProofWorkerCompletion,
  unwrapProofWorkerCompletion,
  waitForProofWorkerReady,
} from "./proof-worker-completion.js";

test("worker failure before the proof await preserves its original error without an unhandled rejection", async () => {
  const failure = new Error("injected worker startup failure");
  const observed = observeProofWorkerCompletion(
    new Promise<never>((_resolve, reject) => setImmediate(() => reject(failure))),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(
    () => observed.throwIfFailed(),
    (error) => error === failure,
  );
  const outcome = await observed.completion;
  assert.throws(
    () => unwrapProofWorkerCompletion(outcome),
    (error) => error === failure,
  );
});

test("successful worker evidence stays available without changing its value", async () => {
  const receipt = { summary: "committed summary", state: "canceled" };
  const observed = observeProofWorkerCompletion(Promise.resolve(receipt));
  await observed.completion;
  assert.doesNotThrow(() => observed.throwIfFailed());
  assert.equal(unwrapProofWorkerCompletion(await observed.completion), receipt);
});

test("readiness ignores unrelated signals and removes listeners after actual initialization", async () => {
  const worker = new EventEmitter();
  const ready = waitForProofWorkerReady(worker as unknown as Worker);
  let settled = false;
  void ready.then(() => {
    settled = true;
  });
  worker.emit("message", { type: "progress" });
  await Promise.resolve();
  assert.equal(settled, false);
  worker.emit("message", { type: "ready" });
  await ready;
  for (const event of ["message", "error", "exit"]) assert.equal(worker.listenerCount(event), 0);
});
test("readiness preserves worker errors and rejects early exits with bounded diagnostics", async () => {
  const worker = new EventEmitter();
  const failure = new Error("original initialization failure");
  const ready = waitForProofWorkerReady(worker as unknown as Worker);
  worker.emit("error", failure);
  await assert.rejects(ready, (error) => error === failure);
  const exited = new EventEmitter();
  const exitReady = waitForProofWorkerReady(exited as unknown as Worker);
  exited.emit("exit", 7);
  await assert.rejects(exitReady, /exited before readiness.*7/);
  for (const event of ["message", "error", "exit"]) {
    assert.equal(worker.listenerCount(event), 0);
    assert.equal(exited.listenerCount(event), 0);
  }
});
