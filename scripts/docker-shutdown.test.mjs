import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// Exercise the entrypoint's actual supervisor without importing its service-start side effects.
function supervisor(children) {
  const source = fs.readFileSync(new URL("./docker-start.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function shutdown(exitCode)");
  const end = source.indexOf("\nfunction launch(", start);
  assert.ok(start >= 0 && end > start);
  let now = 0, nextId = 0;
  const timers = new Map();
  const exits = [];
  const context = vm.createContext({ children: new Set(children), shuttingDown: false,
    process: { exit: (code) => exits.push(code) },
    console: { error: () => undefined },
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source.slice(start, end) + "\nthis.stop = shutdown;", context);
  return { stop: context.stop, exits, async advance(ms) {
    // Real event loops drain already-settled promises before the next timer fires.
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    }
    now = target;
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  } };
}

function child() {
  const result = new EventEmitter();
  result.pid = 123;
  result.exitCode = null;
  result.signalCode = null;
  result.killed = false;
  result.signals = [];
  result.kill = (signal) => {
    result.killed = true;
    result.signals.push(signal);
    if (signal === "SIGKILL") result.finish(null, signal);
    return true;
  };
  result.finish = (code = 0, signal = null) => {
    result.exitCode = code; result.signalCode = signal; result.emit("exit", code, signal);
  };
  return result;
}

test("Docker supervisor waits for both services instead of exiting after 1.5 seconds", async () => {
  const gateway = child(), ui = child();
  const run = supervisor([gateway, ui]);
  const pending = run.stop(0);
  await run.advance(1500);
  assert.deepEqual(run.exits, [], "Gateway still owns its graceful cleanup window");
  gateway.finish();
  await run.advance(100);
  assert.deepEqual(run.exits, [], "UI is still live");
  ui.finish();
  await run.advance(0);
  await pending;
  assert.deepEqual(run.exits, [0]);
});

test("Docker supervisor hard-kills a live child even after SIGTERM was delivered", async () => {
  const gateway = child();
  const run = supervisor([gateway]);
  const pending = run.stop(0);
  await run.advance(10_500);
  await pending;
  assert.deepEqual(gateway.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(run.exits, [1], "A forced shutdown is not a graceful success");
});

test("Docker supervisor leaves an already exited child alone", async () => {
  const gateway = child(); gateway.finish();
  const run = supervisor([gateway]);
  const pending = run.stop(0);
  await run.advance(11_000);
  await pending;
  assert.deepEqual(gateway.signals, []);
  assert.deepEqual(run.exits, [0]);
});
test("Docker supervisor never treats a signalling error as child exit and bounds failed termination", async () => {
  const gateway = child();
  gateway.kill = (signal) => {
    gateway.signals.push(signal);
    gateway.emit("error", new Error("fixture signal refused"));
    return false;
  };
  const run = supervisor([gateway]);
  const pending = run.stop(0);
  await run.advance(0);
  assert.deepEqual(run.exits, [], "A live child emitting error is not an exited child");
  await run.advance(12_000);
  await pending;
  assert.deepEqual(gateway.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(run.exits, [1], "Incomplete termination must be a bounded failure");
});
test("Compose leaves time for Gateway drain and supervisor termination acknowledgement", () => {
  const compose = fs.readFileSync(new URL("../docker-compose.yaml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const service = compose.split("\n  goatcitadel:\n")[1]?.split("\nvolumes:")[0];
  const grace = service?.match(/^    stop_grace_period: (\d+)s$/m);
  assert.ok(grace && Number(grace[1]) >= 12, "Compose must outlast the supervisor's 10.5 s + 1 s termination window");
});