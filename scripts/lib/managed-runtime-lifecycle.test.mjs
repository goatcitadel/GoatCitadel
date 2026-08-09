import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  atomicCompareAndPublishJson,
  atomicCompareAndRemove,
  inspectLifecycleLockHolder,
  inspectProcessBinding,
  inspectProcessBindingWithRetry,
  queryProcessCreationIdentity,
  readManagedStateFile,
  withManagedLifecycleLock,
} from "./managed-runtime-lifecycle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerPath = path.join(repoRoot, "scripts", "lib", "fixtures", "managed-runtime-lifecycle-worker.mjs");
const viteCliPath = path.join(repoRoot, "apps", "mission-control-next", "node_modules", "vite", "bin", "vite.js");

test("metadata publication and removal are atomic and compare-aware", () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const metadataPath = path.join(fixtureRoot, "gateway.pid");
    const missing = readManagedStateFile(metadataPath);
    const first = atomicCompareAndPublishJson({
      filePath: metadataPath,
      expectedFingerprint: missing.fingerprint,
      value: { generation: 1 },
    });
    assert.equal(first.published, true);

    const stalePublish = atomicCompareAndPublishJson({
      filePath: metadataPath,
      expectedFingerprint: missing.fingerprint,
      value: { generation: 2 },
    });
    assert.deepEqual(stalePublish, {
      published: false,
      reason: "compare_conflict",
      currentFingerprint: first.fingerprint,
    });
    assert.deepEqual(JSON.parse(readManagedStateFile(metadataPath).raw), { generation: 1 });

    const staleRemove = atomicCompareAndRemove({ filePath: metadataPath, expectedFingerprint: missing.fingerprint });
    assert.equal(staleRemove.removed, false);
    assert.equal(fs.existsSync(metadataPath), true);
    const remove = atomicCompareAndRemove({ filePath: metadataPath, expectedFingerprint: first.fingerprint });
    assert.equal(remove.removed, true);
    assert.equal(fs.existsSync(metadataPath), false);
  } finally {
    removeFixtureRoot(fixtureRoot);
  }
});

test("concurrent launch decisions serialize across processes and publish one owner", async () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const first = runWorker("launch", fixtureRoot, 400);
    const second = runWorker("launch", fixtureRoot, 50);
    const results = await Promise.all([first.completion, second.completion]);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr || result.stdout);
    }

    const events = readEvents(fixtureRoot);
    assert.equal(events.filter((event) => event.phase === "spawn").length, 1);
    assert.equal(events.filter((event) => event.phase === "attach").length, 1);
    assertSerialized(events);
    const metadata = JSON.parse(readManagedStateFile(path.join(fixtureRoot, "gateway.pid")).raw);
    assert.ok(results.some((result) => result.pid === metadata.launchedBy));
  } finally {
    removeFixtureRoot(fixtureRoot);
  }
});

test("a concurrent launch-versus-stop race is ordered by one lifecycle lock", async () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const launch = runWorker("launch", fixtureRoot, 500);
    await waitForEvent(fixtureRoot, (event) => event.mode === "launch" && event.phase === "spawn");
    const stop = runWorker("stop", fixtureRoot, 0);
    const [launchResult, stopResult] = await Promise.all([launch.completion, stop.completion]);
    assert.equal(launchResult.code, 0, launchResult.stderr || launchResult.stdout);
    assert.equal(stopResult.code, 0, stopResult.stderr || stopResult.stdout);

    const events = readEvents(fixtureRoot);
    assertSerialized(events);
    const launchExit = events.find((event) => event.mode === "launch" && event.phase === "exit");
    const stopEnter = events.find((event) => event.mode === "stop" && event.phase === "enter");
    assert.ok(launchExit && stopEnter && stopEnter.at >= launchExit.at);
    assert.equal(events.filter((event) => event.phase === "remove").length, 1);
    assert.equal(fs.existsSync(path.join(fixtureRoot, "gateway.pid")), false);
  } finally {
    removeFixtureRoot(fixtureRoot);
  }
});

test("a dead lock owner is recovered after the bounded stale heartbeat window", async () => {
  const fixtureRoot = createFixtureRoot();
  let holder;
  try {
    holder = runWorker("hold", fixtureRoot, 60_000);
    await waitForEvent(fixtureRoot, (event) => event.mode === "hold" && event.phase === "enter");
    holder.child.kill("SIGKILL");
    await holder.completion;

    const replacement = runWorker("launch", fixtureRoot, 0);
    const result = await replacement.completion;
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(readEvents(fixtureRoot).filter((event) => event.phase === "spawn").length, 1);
  } finally {
    if (holder?.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill("SIGKILL");
    }
    removeFixtureRoot(fixtureRoot);
  }
});

test("a live lock owner with a starved heartbeat is never reclaimed", async () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const lockPath = path.join(fixtureRoot, "gateway.lifecycle.lock");
    const identity = queryProcessCreationIdentity(process.pid);
    assert.equal(identity.status, "running");
    const owner = buildLockOwnerFixture({ processIdentity: identity.identity });
    writeLockOwnerFixture(lockPath, owner);

    await assert.rejects(
      withManagedLifecycleLock(
        { lockPath, service: "gateway-fixture", timeoutMs: 750, staleHeartbeatMs: 100 },
        async () => {
          throw new Error("The lifecycle lock must not be stolen from a live owner.");
        },
      ),
      /Timed out waiting for the gateway-fixture lifecycle lock held by PID/u,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")), owner);
  } finally {
    removeFixtureRoot(fixtureRoot);
  }
});

test("a transiently unreadable lock owner record does not authorize reclaim", async () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const lockPath = path.join(fixtureRoot, "gateway.lifecycle.lock");
    fs.mkdirSync(path.join(lockPath, "owner.json"), { recursive: true });
    const staleMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleMtime, staleMtime);

    await assert.rejects(
      withManagedLifecycleLock(
        { lockPath, service: "gateway-fixture", timeoutMs: 600, staleHeartbeatMs: 100 },
        async () => {
          throw new Error("An unreadable owner record must not be treated as a dead owner.");
        },
      ),
      /Timed out waiting for the gateway-fixture lifecycle lock/u,
    );
    assert.equal(fs.existsSync(path.join(lockPath, "owner.json")), true);
  } finally {
    removeFixtureRoot(fixtureRoot);
  }
});

test("a dead lock owner is reclaimed without waiting on identity probes", async () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const exited = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
    const exitedPid = await new Promise((resolve, reject) => {
      exited.once("error", reject);
      exited.once("close", () => resolve(exited.pid));
    });
    assert.ok(exitedPid);
    const lockPath = path.join(fixtureRoot, "gateway.lifecycle.lock");
    writeLockOwnerFixture(lockPath, buildLockOwnerFixture({ pid: exitedPid }));

    const outcome = await withManagedLifecycleLock(
      { lockPath, service: "gateway-fixture", timeoutMs: 5_000, staleHeartbeatMs: 100 },
      async (lock) => lock.owner.pid,
    );
    assert.equal(outcome, process.pid);
  } finally {
    removeFixtureRoot(fixtureRoot);
  }
});

test("a recorded owner whose PID now belongs to another process is reclaimed", async () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const lockPath = path.join(fixtureRoot, "gateway.lifecycle.lock");
    writeLockOwnerFixture(lockPath, buildLockOwnerFixture({ pid: process.pid, processIdentity: "windows:1" }));
    const outcome = await withManagedLifecycleLock(
      { lockPath, service: "gateway-fixture", timeoutMs: 5_000, staleHeartbeatMs: 100 },
      async () => "acquired",
    );
    assert.equal(outcome, "acquired");
  } finally {
    removeFixtureRoot(fixtureRoot);
  }
});

test("lifecycle lock holder inspection reports only a live non-self owner of the same service", async () => {
  const fixtureRoot = createFixtureRoot();
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  try {
    await new Promise((resolve, reject) => {
      sentinel.once("spawn", resolve);
      sentinel.once("error", reject);
    });
    assert.ok(sentinel.pid);
    const sentinelIdentity = queryProcessCreationIdentity(sentinel.pid);
    assert.equal(sentinelIdentity.status, "running");
    const lockPath = path.join(fixtureRoot, "gateway.lifecycle.lock");

    assert.equal((await inspectLifecycleLockHolder({ lockPath, service: "gateway-fixture" })).held, false);

    const owner = buildLockOwnerFixture({ pid: sentinel.pid, processIdentity: sentinelIdentity.identity });
    writeLockOwnerFixture(lockPath, owner);
    assert.deepEqual(await inspectLifecycleLockHolder({ lockPath, service: "other-service" }), {
      held: false,
      reason: "service_mismatch",
      pid: sentinel.pid,
    });
    const held = await inspectLifecycleLockHolder({ lockPath, service: "gateway-fixture" });
    assert.equal(held.held, true);
    assert.match(held.reason, /^owner_(identity_verified|alive_identity_unverified)$/u);

    writeLockOwnerFixture(lockPath, buildLockOwnerFixture({ pid: process.pid }));
    assert.equal((await inspectLifecycleLockHolder({ lockPath, service: "gateway-fixture" })).reason, "self_owned");

    const closed = new Promise((resolve) => sentinel.once("close", resolve));
    sentinel.kill("SIGKILL");
    await closed;
    writeLockOwnerFixture(lockPath, owner);
    assert.deepEqual(await inspectLifecycleLockHolder({ lockPath, service: "gateway-fixture" }), {
      held: false,
      reason: "owner_exited",
      pid: sentinel.pid,
    });
  } finally {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      sentinel.kill("SIGKILL");
    }
    removeFixtureRoot(fixtureRoot);
  }
});

test("process binding retry re-queries only unavailable readings within its bound", async () => {
  const readings = [
    { status: "unavailable" },
    { status: "verified", rootIdentity: "windows:1", servingIdentity: "windows:1", depth: 0 },
  ];
  const calls = [];
  const recovered = await inspectProcessBindingWithRetry(
    { rootPid: 41, servingPid: 41 },
    {
      delayMs: 1,
      probe: (options) => {
        calls.push(options);
        return readings[Math.min(calls.length - 1, readings.length - 1)];
      },
    },
  );
  assert.equal(recovered.status, "verified");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { rootPid: 41, servingPid: 41 });

  calls.length = 0;
  const exhausted = await inspectProcessBindingWithRetry(
    { rootPid: 41, servingPid: 41 },
    {
      attempts: 3,
      delayMs: 1,
      probe: (options) => {
        calls.push(options);
        return { status: "unavailable" };
      },
    },
  );
  assert.equal(exhausted.status, "unavailable");
  assert.equal(calls.length, 3);

  calls.length = 0;
  const immediate = await inspectProcessBindingWithRetry(
    { rootPid: 41, servingPid: 41 },
    {
      delayMs: 1,
      probe: (options) => {
        calls.push(options);
        return { status: "missing" };
      },
    },
  );
  assert.equal(immediate.status, "missing");
  assert.equal(calls.length, 1);
});

test("OS creation identity binds a serving descendant to its live wrapper only", async () => {
  const descendantCode = "setInterval(() => {}, 1000)";
  const wrapperCode = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { detached: true, stdio: "ignore", windowsHide: true });`,
    "child.unref();",
    "process.stdout.write(String(child.pid) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const wrapper = spawn(process.execPath, ["-e", wrapperCode], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const descendantPid = Number(await readFirstLine(wrapper));
  assert.ok(wrapper.pid && Number.isSafeInteger(descendantPid));

  try {
    const binding = inspectProcessBinding({ rootPid: wrapper.pid, servingPid: descendantPid });
    assert.equal(binding.status, "verified");
    assert.equal(binding.depth, 1);
    assert.equal(queryProcessCreationIdentity(wrapper.pid).identity, binding.rootIdentity);
    assert.equal(queryProcessCreationIdentity(descendantPid).identity, binding.servingIdentity);

    const wrapperClosed = new Promise((resolve) => wrapper.once("close", resolve));
    wrapper.kill("SIGKILL");
    await wrapperClosed;
    const orphaned = inspectProcessBinding({ rootPid: wrapper.pid, servingPid: descendantPid });
    assert.notEqual(orphaned.status, "verified");
    assert.equal(queryProcessCreationIdentity(descendantPid).status, "running");
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) {
      wrapper.kill("SIGKILL");
    }
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // The owned descendant already exited.
    }
  }
});

test("Vite strictPort rejects a TCP-only listener without replacing it", async () => {
  const listener = net.createServer((socket) => socket.destroy());
  await listen(listener);
  try {
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const result = await runProcess(
      process.execPath,
      [viteCliPath, "--host", "127.0.0.1", "--port", String(address.port), "--strictPort"],
      {
        cwd: path.join(repoRoot, "apps", "mission-control-next"),
        timeoutMs: 15_000,
      },
    );
    assert.notEqual(result.code, 0, result.stdout || result.stderr);
    assert.match(`${result.stdout}\n${result.stderr}`, /Port \d+ is already in use/u);
    await connect(address.port);
  } finally {
    await close(listener);
  }
});

function runWorker(mode, fixtureRoot, holdMs) {
  const child = spawn(process.execPath, [workerPath, mode, fixtureRoot, String(holdMs)], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    child,
    completion: collectChild(child).then((result) => ({ ...result, pid: child.pid })),
  };
}

function collectChild(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Child process timed out. ${Buffer.concat(stderr).toString("utf8")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function runProcess(command, args, { cwd, timeoutMs }) {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return collectChild(child, timeoutMs);
}

function readFirstLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const stderr = [];
    const timer = setTimeout(() => reject(new Error("Wrapper did not publish its descendant PID.")), 10_000);
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        resolve(stdout.slice(0, newline).trim());
      }
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Wrapper exited before publishing a PID (${code}). ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function waitForEvent(fixtureRoot, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = readEvents(fixtureRoot).find(predicate);
    if (event) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for lifecycle worker event.");
}

function readEvents(fixtureRoot) {
  const eventsPath = path.join(fixtureRoot, "events.ndjson");
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs
    .readFileSync(eventsPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertSerialized(events) {
  const intervals = new Map();
  for (const event of events) {
    const interval = intervals.get(event.pid) ?? { pid: event.pid };
    if (event.phase === "enter") {
      interval.enter = event.at;
    }
    if (event.phase === "exit") {
      interval.exit = event.at;
    }
    intervals.set(event.pid, interval);
  }
  const ordered = [...intervals.values()].sort((left, right) => left.enter - right.enter);
  assert.equal(ordered.length, 2);
  assert.ok(ordered.every((interval) => Number.isFinite(interval.enter) && Number.isFinite(interval.exit)));
  assert.ok(ordered[1].enter >= ordered[0].exit, JSON.stringify(events));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function createFixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-managed-lifecycle-"));
}

function removeFixtureRoot(root) {
  const resolved = path.resolve(root);
  const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}goatcitadel-managed-lifecycle-`;
  assert.ok(resolved.startsWith(expectedPrefix));
  fs.rmSync(resolved, { recursive: true, force: true });
}

function buildLockOwnerFixture(overrides = {}) {
  return {
    lockId: "11111111-2222-4333-8444-555555555555",
    pid: process.pid,
    processIdentity: "windows:1",
    service: "gateway-fixture",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function writeLockOwnerFixture(lockPath, owner) {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
}
