import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  FAST_LANE_STAGES,
  fastLaneStageCommandIds,
  resolveFastLaneStageConcurrency,
  runFastLane,
  selectFastLaneStages,
  serializeFastLaneStages,
} from "./fast-lane.mjs";

const createdRoots = [];
const savedEnv = {};
const ISOLATED_ENV = [
  "GOATCITADEL_VERIFY_TEMP_ROOT",
  "GOATCITADEL_TEST_POSTGRES_URL",
  "GOATCITADEL_VERIFY_STORAGE_SHARD_CONCURRENCY",
  "GOATCITADEL_VERIFY_FAST_TRACKS",
  "GOATCITADEL_VERIFY_SERIAL",
  "GOATCITADEL_VERIFY_FAIL_FAST",
];

before(async () => {
  for (const key of ISOLATED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fast-schedule-temp-"));
  createdRoots.push(tempRoot);
  process.env.GOATCITADEL_VERIFY_TEMP_ROOT = tempRoot;
});

after(async () => {
  for (const key of ISOLATED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const root of createdRoots) await fs.rm(root, { recursive: true, force: true });
});

async function createContext() {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fast-schedule-run-"));
  createdRoots.push(artifactRoot);
  await fs.mkdir(path.join(artifactRoot, "diagnostics"), { recursive: true });
  return {
    runId: `schedule-${path.basename(artifactRoot)}`,
    lane: "fast",
    artifactRoot,
    manifest: {
      runId: "schedule-test",
      lane: "fast",
      startedAt: new Date().toISOString(),
      repoRoot: "repo",
      artifactRoot,
      metadata: {},
      counts: { passed: 0, failed: 0, skipped: 0, degraded: 0, notConfigured: 0 },
      scenarios: [],
    },
  };
}

/** Records each command's start/end so the test can check ordering and overlap. */
function createRecordingRunner(context, { failLog } = {}) {
  const events = [];
  const runCommand = async (_command, _args, options) => {
    events.push({ id: options.logName, type: "start", at: events.length });
    await new Promise((resolve) => setTimeout(resolve, 40));
    events.push({ id: options.logName, type: "end", at: events.length });
    const stdoutPath = path.join(context.artifactRoot, "diagnostics", `${options.logName}.stdout.log`);
    const failed = options.logName === failLog;
    return {
      code: failed ? 1 : 0,
      stdout: "",
      stderr: failed ? "tsc exploded" : "",
      stdoutPath,
      stderrPath: stdoutPath.replace(".stdout.", ".stderr."),
      durationMs: 40,
    };
  };
  return { events, runCommand };
}

const indexOf = (events, id, type) => events.findIndex((event) => event.id === id && event.type === type);
const overlaps = (events, a, b) =>
  indexOf(events, a, "start") < indexOf(events, b, "end") && indexOf(events, b, "start") < indexOf(events, a, "end");

const STORAGE_AND_GATEWAY = new Set(["fast.test.gateway.shard1", "fast.test.storage.shard1", "fast.test.storage.shard2"]);

describe("fast lane scheduling", () => {
  it("by default builds storage once, then runs gateway and storage one command at a time", async () => {
    const context = await createContext();
    const { events, runCommand } = createRecordingRunner(context);
    await runFastLane(context, { selection: STORAGE_AND_GATEWAY, runCommand });

    assert.equal(events[0].id, "fast.test.storage.build", "the storage build runs before any suite");
    for (let index = 0; index < events.length; index += 2) {
      assert.equal(events[index + 1].id, events[index].id, "no command may overlap another by default");
    }
    assert.equal(context.manifest.scenarios.length, STORAGE_AND_GATEWAY.size);
  });

  it("with tracks and shard concurrency opted in, builds storage before the fork and overlaps suites", async () => {
    const context = await createContext();
    const { events, runCommand } = createRecordingRunner(context);
    process.env.GOATCITADEL_VERIFY_STORAGE_SHARD_CONCURRENCY = "2";
    try {
      await runFastLane(context, { selection: STORAGE_AND_GATEWAY, runCommand, tracks: true });
    } finally {
      delete process.env.GOATCITADEL_VERIFY_STORAGE_SHARD_CONCURRENCY;
    }

    const prepareEnd = indexOf(events, "fast.test.storage.build", "end");
    assert.ok(prepareEnd >= 0, "storage build must run");
    for (const id of STORAGE_AND_GATEWAY) {
      assert.ok(indexOf(events, id, "start") > prepareEnd, `${id} must start after the storage build finished`);
    }
    assert.ok(overlaps(events, "fast.test.gateway.shard1", "fast.test.storage.shard1"), "tracks must overlap");
    assert.ok(overlaps(events, "fast.test.storage.shard1", "fast.test.storage.shard2"), "storage shards must overlap");
    assert.deepEqual(
      context.manifest.scenarios.map((scenario) => scenario.id).sort(),
      [...STORAGE_AND_GATEWAY].sort(),
      "the build is a setup step, not a manifest scenario",
    );
  });

  it("serial mode keeps the storage build but never overlaps commands", async () => {
    const context = await createContext();
    const { events, runCommand } = createRecordingRunner(context);
    await runFastLane(context, { selection: STORAGE_AND_GATEWAY, runCommand, serial: true });

    assert.ok(indexOf(events, "fast.test.storage.build", "end") < indexOf(events, "fast.test.storage.shard1", "start"));
    for (let index = 0; index < events.length; index += 2) {
      assert.equal(events[index].type, "start");
      assert.equal(events[index + 1].id, events[index].id, "each command must finish before the next starts");
    }
  });

  it("a failed storage build fails every shard without running it and leaves other tracks running", async () => {
    const context = await createContext();
    const { events, runCommand } = createRecordingRunner(context, { failLog: "fast.test.storage.build" });
    await runFastLane(context, { selection: STORAGE_AND_GATEWAY, runCommand, tracks: true });

    assert.equal(indexOf(events, "fast.test.storage.shard1", "start"), -1);
    assert.ok(indexOf(events, "fast.test.gateway.shard1", "end") >= 0, "gateway must still run");
    const byId = new Map(context.manifest.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const id of ["fast.test.storage.shard1", "fast.test.storage.shard2"]) {
      assert.equal(byId.get(id)?.status, "failed");
      assert.match(byId.get(id)?.error ?? "", /Storage build for coverage shards failed/);
    }
    assert.equal(byId.get("fast.test.gateway.shard1")?.status, "passed");
  });
});

describe("fast lane stage planning", () => {
  const storageStage = FAST_LANE_STAGES.flatMap((stage) => stage.tracks?.flatMap((track) => track.stages) ?? []).find(
    (stage) => stage.id === "fast.test.storage",
  );

  it("runs storage shards one at a time unless opted in, and always with a live PostgreSQL URL", () => {
    const optIn = { GOATCITADEL_VERIFY_STORAGE_SHARD_CONCURRENCY: "2" };
    assert.equal(resolveFastLaneStageConcurrency(storageStage, {}), 1);
    assert.equal(resolveFastLaneStageConcurrency(storageStage, optIn), 2);
    assert.equal(resolveFastLaneStageConcurrency(storageStage, { ...optIn, GOATCITADEL_TEST_POSTGRES_URL: "postgres://x" }), 1);
    assert.equal(resolveFastLaneStageConcurrency(storageStage, { ...optIn, GOATCITADEL_TEST_POSTGRES_URL: "  " }), 2);
    assert.equal(resolveFastLaneStageConcurrency(storageStage, { GOATCITADEL_VERIFY_STORAGE_SHARD_CONCURRENCY: "0" }), 1);
    assert.equal(resolveFastLaneStageConcurrency({ mode: "serial", commands: [] }, {}), 1);
  });

  it("selection descends into tracks and drops tracks with nothing selected", () => {
    const selected = selectFastLaneStages(FAST_LANE_STAGES, new Set(["fast.test.storage.shard3", "fast.build"]));
    assert.deepEqual(selected.flatMap(fastLaneStageCommandIds), ["fast.test.storage.shard3", "fast.build"]);
    const tracks = selected.find((stage) => stage.mode === "tracks");
    assert.deepEqual(
      tracks.tracks.map((track) => track.id),
      ["fast.track.storage-and-ui"],
    );
    assert.ok(tracks.tracks[0].stages[0].prepare, "a selected storage shard keeps its build");
  });

  it("serialization flattens tracks in order and keeps every prepare step", () => {
    const serial = serializeFastLaneStages(FAST_LANE_STAGES);
    assert.ok(serial.every((stage) => stage.mode === "serial"));
    assert.deepEqual(serial.flatMap(fastLaneStageCommandIds), FAST_LANE_STAGES.flatMap(fastLaneStageCommandIds));
    assert.ok(serial.find((stage) => stage.id === "fast.test.storage")?.prepare);
  });
});
