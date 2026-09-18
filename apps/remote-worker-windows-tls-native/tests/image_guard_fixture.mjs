import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
const require = createRequire(import.meta.url);
let retained;
process.once("message", (input) => {
  try {
    const guard = require(input.guard);
    for (const name of ["startStateWriterGate", "pauseStateWriterGate", "resumeStateWriterGate"]) {
      assert.equal(typeof guard[name], "function");
      assert.throws(() => guard[name](), { code: "REMOTE_WORKER_IMAGE_PIN_REJECTED" });
    }
    retained = guard.pin(input.identifier);
    process.send({ ready: true, adapterPath: retained.adapterPath, frozen: Object.isFrozen(retained) });
    process.once("message", async (command) => {
      // Keep the native lease strongly reachable until the parent has attempted replacement.
      if (command.release) {
        retained = undefined;
        for (let attempt = 0; attempt < 20; attempt++) {
          globalThis.gc();
          await nextTurn();
        }
        process.once("message", () => process.send({ completed: true }, () => process.disconnect()));
        process.send({ released: true });
        return;
      }
      process.send({ completed: Boolean(retained.lease) }, () => process.disconnect());
    });
  } catch (error) {
    process.send({ ready: false, error: String(error.message).slice(0, 500) }, () => process.disconnect());
  }
});
