import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildWindowsTlsKeyAdapter, compileTlsNative, CELL_PROVISIONING_SOURCES, CELL_PROVISIONING_HOST_SOURCES } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { createWindowsWorkerCellProvisioning, encodeWindowsWorkerCellProvisioning,
  readWindowsWorkerCellControllerCustody } from "../../apps/remote-worker/dist/worker-windows-cell-provisioning.js";
import { REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION,
  remoteWorkerCellProvisioningPlanSha256, readRemoteWorkerCellProvisioningCheckpoint } from "../../packages/contracts/dist/index.js";
import { provisionWorkerCell } from "../../apps/remote-worker/dist/worker-cell-provisioning-coordinator.js";
import { createFileWorkerDurableState } from "../../apps/remote-worker/dist/worker-durable-state.js";

const repository = path.resolve(import.meta.dirname, "../..");
const source = path.join(repository, "apps/remote-worker-windows-cell-native");
const requireNative = createRequire(import.meta.url);

// This harness starts and joins only its own helper. A harness timeout is a
// failure, never a substitute for the helper's independent deadline.
async function raw(executable, input, { acknowledgement, endInput = false, env = {}, args = [] } = {}) {
  const started = Date.now();
  const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    env: { SystemRoot: process.env.SystemRoot, ...env } });
  const frames = [];
  let pending = Buffer.alloc(0), total = 0, stderr = "", failure;
  const stop = (error) => { failure ??= error; child.kill(); child.stdin.destroy(); };
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => stop(new Error("Native provisioning harness deadline exceeded.")), 8000);
  child.on("error", stop); child.stdout.on("error", stop); child.stderr.on("error", stop);
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(error); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); if (stderr.length > 8192) stop(new Error("Unbounded diagnostics.")); });
  child.stdout.on("data", (chunk) => {
    try {
      total += chunk.length; assert.ok(total <= 8192);
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const kind = pending[0], size = pending.readUInt32LE(1);
        assert.ok((kind === 1 && size === 1024) || (kind === 2 && size === 16));
        if (pending.length < size + 5) return;
        const payload = Buffer.from(pending.subarray(5, size + 5));
        pending = pending.subarray(size + 5); frames.push({ kind, payload });
        if (kind === 1 && acknowledgement) child.stdin.write(acknowledgement(payload));
      }
    } catch (error) { stop(error); }
  });
  if (endInput) child.stdin.end(input); else child.stdin.write(input);
  try {
    const result = await closed;
    if (failure) throw failure;
    assert.equal(stderr, ""); assert.equal(pending.length, 0);
    return { ...result, frames, elapsedMs: Date.now() - started };
  } finally { clearTimeout(timer); child.stdin.destroy(); await closed; }
}

test("native provisioning bridge joins canonical commits, image custody and bounded recovery", {
  skip: process.platform !== "win32", timeout: 300000,
}, async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Provisioning Bridge "));
  t.diagnostic(`Retained real native provisioning bridge evidence: ${output}`);
  const built = buildWindowsTlsKeyAdapter({ target: "windows-x64", outputDirectory: path.join(output, "native") });
  const setup = compileTlsNative({ target: "windows-x64", outputDirectory: output,
    outputName: "provisioning-parent-fixture.exe", sources: [path.join(source, "tests/provisioning_parent_fixture.cpp")] });
  const parent = () => {
    const parentPath = path.join(output, `parent-${randomUUID()}`);
    const result = spawnSync(setup, [parentPath], { windowsHide: true, encoding: "utf8", timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot } });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    return { parentPath, plan: { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
      ...JSON.parse(result.stdout), assignmentBindingSha256: "1".repeat(64), profileSha256: "2".repeat(64),
      cellName: `gc-cell-${randomUUID().replaceAll("-", "")}`, diskIdentifierHex: randomUUID().replaceAll("-", ""),
      virtualDiskBytes: 16 * 1024 * 1024, reservedDiskBytes: 80 * 1024 * 1024 } };
  };
  await t.test("real Gateway coordinator commits and recovers the helper's exact journal", () => {
    const resultFile = path.join(output, "gateway-tests.json");
    const result = spawnSync(process.execPath, [path.join(repository, "node_modules/vitest/vitest.mjs"),
      "run", "src/services/remote-worker-cell-service.test.ts", "--reporter=json", `--outputFile=${resultFile}`], {
      cwd: path.join(repository, "apps/gateway"), encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GOATCITADEL_CELL_PROVISIONING_PROOF: JSON.stringify({ output, setup, guardAddon: built.guardAddon }) },
    });
    fs.writeFileSync(path.join(output, "gateway-tests.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(report.numFailedTests, 0); assert.equal(report.numPendingTests, 0); assert.equal(report.numPassedTests, 18);
    for (const [name, count] of [["real-native-complete", 5], ["real-native-lost-ack", 2], ["real-native-cancelled", 1]]) {
      const evidence = JSON.parse(fs.readFileSync(path.join(output, `${name}.json`), "utf8"));
      assert.equal(evidence.snapshot.checkpoints.length, count);
      assert.equal(evidence.platformReady, false); assert.equal(evidence.installedService, false);
    }
  });
  await t.test("worker coordinator joins real native creation and never recreates after a lost acknowledgement", async () => {
    for (const failure of [false, true]) {
      const fixture = parent();
      const stateDirectory = path.join(output, `worker-state-${failure ? "lost-ack" : "complete"}`);
      const scope = { registryWorkspaceId: "fixture-registry", assignmentId: fixture.plan.cellName, assignmentGeneration: 1 };
      let snapshot = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, ...scope,
        leaseRevision: 1, plan: fixture.plan, planSha256: remoteWorkerCellProvisioningPlanSha256(fixture.plan), records: [] };
      let prepared = false, creations = 0;
      const input = { scope, state: createFileWorkerDurableState(stateDirectory), signal: new AbortController().signal,
        // Component fixture only: this exact temporary parent is pinned by the
        // C++ fixture and rechecked by the real native owner. It is not installed
        // service custody, Gateway authentication or platform readiness proof.
        custody: { parentPath: fixture.parentPath, parentIdentityHex: fixture.plan.parentIdentityHex, custodySha256: "1".repeat(64) },
        assertCurrent: async () => {},
        prepare: async () => {
          const decision = prepared ? "reconcile" : "create_once"; prepared = true;
          return { schemaVersion: REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION, decision,
            provisioningExpiresAt: new Date(Date.now() + 120000).toISOString(), exchange: snapshot };
        },
        exchange: async (submission) => {
          if (submission.kind === "cell.provisioning.checkpoint") {
            assert.equal(submission.expectedSequence, snapshot.records.length);
            snapshot = { ...snapshot, records: [...snapshot.records, submission.recordHex] };
            if (failure && snapshot.records.length === 2) throw new Error("Controlled Gateway acknowledgement loss after persistence.");
          }
          return snapshot;
        },
        native: (options) => {
          const native = createWindowsWorkerCellProvisioning({ ...options, parentPath: fixture.parentPath,
            assertCurrent: async () => {}, imageGuard: requireNative(built.guardAddon) });
          return { recover: native.recover, create: async (...args) => { creations += 1; return native.create(...args); } };
        },
      };
      if (failure) await assert.rejects(provisionWorkerCell(input));
      else assert.equal((await provisionWorkerCell(input)).status, "recorded");
      const journalPath = path.join(fixture.parentPath, `${fixture.plan.cellName}.provisioning`);
      const before = fs.readFileSync(journalPath);
      const restarted = { ...input, state: createFileWorkerDurableState(stateDirectory) };
      if (failure) await assert.rejects(provisionWorkerCell(restarted));
      else assert.equal((await provisionWorkerCell(restarted)).status, "recovery_verified");
      assert.equal(creations, 1); assert.deepEqual(fs.readFileSync(journalPath), before);
      assert.equal(snapshot.records.length, failure ? 2 : 5);
      fs.writeFileSync(path.join(output, `worker-native-${failure ? "lost-ack" : "complete"}.json`), JSON.stringify({
        scope, snapshot, creations, journalHex: before.toString("hex"), platformReady: false, installedService: false,
        gateway: "controlled acknowledgement fixture", stateDirectory,
      }, null, 2), { flag: "wx" });
    }
  });
  await t.test("compiled image pin refuses a modified provisioning helper before launch", () => {
    const directory = path.join(output, "changed-image"); fs.mkdirSync(directory);
    fs.copyFileSync(built.guardAddon, path.join(directory, path.basename(built.guardAddon)));
    const bytes = fs.readFileSync(built.cellProvisioningExecutor); bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(path.join(directory, path.basename(built.cellProvisioningExecutor)), bytes, { flag: "wx" });
    const guard = requireNative(path.join(directory, path.basename(built.guardAddon)));
    assert.throws(() => guard.pinCellProvisioningExecutor(), /compiled pin/u);
  });
  const asanDirectory = path.join(output, "asan"); fs.mkdirSync(asanDirectory);
  const asan = compileTlsNative({ target: "windows-x64", outputDirectory: asanDirectory, outputName: "cell-provisioning-asan.exe",
    sources: [...CELL_PROVISIONING_SOURCES, ...CELL_PROVISIONING_HOST_SOURCES]
      .filter((name) => name.endsWith(".cpp")).map((name) => path.join(output, "native/source", name)),
    asan: true, sourceBatchSize: 8 });
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const receipts = [];
  await t.test("installed custody query refuses an interactive worker without returning metadata", async () => {
    let admissions = 0;
    await assert.rejects(readWindowsWorkerCellControllerCustody({ wallMs: 3000,
      signal: new AbortController().signal, imageGuard: requireNative(built.guardAddon),
      assertCurrent: async () => { admissions += 1; } }), /refused or interrupted/u);
    assert.equal(admissions, 1);
    for (const [image, env] of [[built.cellProvisioningExecutor, {}], [asan,
      { PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" }]]) {
      const query = await raw(image, Buffer.alloc(0), { endInput: true, env, args: ["--controller-custody"] });
      assert.equal(query.code, 5); assert.deepEqual(query.frames, []);
      const mixed = await raw(image, Buffer.alloc(0), { endInput: true, env, args: ["--controller-custody", "--controller"] });
      assert.equal(mixed.code, 2); assert.deepEqual(mixed.frames, []);
    }
  });
  await t.test("installed controller selection refuses an interactive worker without falling back", async () => {
    const fixture = parent();
    let commits = 0, admissions = 0;
    const driver = createWindowsWorkerCellProvisioning({ parentPath: fixture.parentPath, wallMs: 3000,
      signal: new AbortController().signal, controllerService: true, imageGuard: requireNative(built.guardAddon),
      assertCurrent: async () => { admissions += 1; } });
    await assert.rejects(driver.create(fixture.plan, async () => { commits += 1; return "0".repeat(64); }), /refused or interrupted/u);
    assert.ok(admissions > 0); assert.equal(commits, 0);
    assert.equal(fs.existsSync(path.join(fixture.parentPath, `${fixture.plan.cellName}.provisioning`)), false);
    assert.equal(fs.existsSync(path.join(fixture.parentPath, fixture.plan.cellName)), false);
    assert.throws(() => createWindowsWorkerCellProvisioning({ parentPath: fixture.parentPath, wallMs: 3000,
      signal: new AbortController().signal, assertCurrent: async () => {}, controllerService: "false" }), /refused or interrupted/u);
  });
  for (const [name, executable, env] of [["normal", built.cellProvisioningExecutor, {}], ["asan", asan,
    { PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" }]]) {
    await t.test(`${name} refuses truncated input, incorrect acknowledgements and a stalled parent`, async () => {
      const refused = parent();
      const refusedInput = encodeWindowsWorkerCellProvisioning(refused.plan, refused.parentPath, 2000);
      const controller = await raw(executable, refusedInput, { endInput: true, env, args: ["--controller"] });
      assert.equal(controller.code, 5); assert.deepEqual(controller.frames, []);
      assert.equal(fs.existsSync(path.join(refused.parentPath, `${refused.plan.cellName}.provisioning`)), false);
      const unknownMode = await raw(executable, refusedInput, { endInput: true, env, args: ["--controller", "--foreground"] });
      assert.equal(unknownMode.code, 2); assert.deepEqual(unknownMode.frames, []);
      const malformed = await raw(executable, Buffer.from("GCPROV01"), { endInput: true, env });
      assert.equal(malformed.code, 2); assert.deepEqual(malformed.frames, []);
      const volumeInput = encodeWindowsWorkerCellProvisioning({ ...refused.plan,
        virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 }, refused.parentPath, 2000, undefined, true);
      for (const operation of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]) {
        volumeInput.writeUInt32LE(operation, 8);
        const directVolume = await raw(executable, volumeInput, { endInput: true, env });
        assert.equal(directVolume.code, 2); assert.deepEqual(directVolume.frames, []);
        const uninstalledVolume = await raw(executable, volumeInput, { endInput: true, env, args: ["--controller"] });
        assert.equal(uninstalledVolume.code, 5); assert.deepEqual(uninstalledVolume.frames, []);
        assert.equal(fs.existsSync(path.join(refused.parentPath, `${refused.plan.cellName}.provisioning`)), false);
        assert.equal(fs.existsSync(path.join(refused.parentPath, refused.plan.cellName)), false);
      }
      for (const kind of ["wrong-sequence", "wrong-digest", "stalled"]) {
        const fixture = parent();
        const input = encodeWindowsWorkerCellProvisioning(fixture.plan, fixture.parentPath, 700);
        const result = await raw(executable, input, { env, acknowledgement: kind === "stalled" ? undefined : (record) => {
          const ack = Buffer.alloc(41); ack[0] = 3; ack.writeUInt32LE(36, 1);
          ack.writeUInt32LE(kind === "wrong-sequence" ? 2 : 1, 5);
          record.subarray(992).copy(ack, 9); if (kind === "wrong-digest") ack[9] ^= 1;
          return ack;
        } });
        const records = result.frames.filter((frame) => frame.kind === 1);
        assert.equal(records.length, 1); assert.equal(readRemoteWorkerCellProvisioningCheckpoint(records[0].payload.toString("hex")).sequence, 1);
        if (kind === "stalled") {
          assert.equal(result.code, 1460); assert.equal(result.frames.length, 1);
          assert.ok(result.elapsedMs < 4000, "The native watchdog must end its own stalled process.");
        } else {
          assert.equal(result.code, 0); assert.equal(result.frames.length, 2);
          assert.equal(result.frames[1].payload.readUInt32LE(0), 13);
        }
        assert.equal(fs.existsSync(path.join(fixture.parentPath, fixture.plan.cellName)), false);
        const journalPath = path.join(fixture.parentPath, `${fixture.plan.cellName}.provisioning`);
        const journal = fs.readFileSync(journalPath); assert.deepEqual(journal, records[0].payload);
        const recovered = await raw(executable, encodeWindowsWorkerCellProvisioning(fixture.plan, fixture.parentPath, 2000,
          records[0].payload.toString("hex")), { endInput: true, env });
        assert.equal(recovered.code, 0); assert.equal(recovered.frames.length, 2);
        assert.deepEqual(recovered.frames[0].payload, journal); assert.equal(recovered.frames[1].payload.readUInt32LE(0), 0);
        assert.deepEqual(fs.readFileSync(journalPath), journal);
        receipts.push({ build: name, kind, elapsedMs: result.elapsedMs, exitCode: result.code,
          recovered: true, journalHex: journal.toString("hex"), workspaceCreated: false });
      }
    });
  }
  fs.writeFileSync(path.join(output, "native-protocol.json"), JSON.stringify(receipts, null, 2), { flag: "wx" });
});
