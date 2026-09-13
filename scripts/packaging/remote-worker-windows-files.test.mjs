import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildWindowsTlsKeyAdapter, compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { createWindowsWorkerFileExecutor } from "../../apps/remote-worker/src/worker-windows-file-executor.ts";

const requireNative = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;

test("pinned Windows file executor performs bounded CAS writes and refuses path escapes", {
  skip: process.platform !== "win32", timeout: 180000,
}, async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Files "));
  const built = buildWindowsTlsKeyAdapter({ target: "windows-x64", outputDirectory: path.join(output, "native") });
  const guard = requireNative(built.guardAddon);
  const executor = createWindowsWorkerFileExecutor(guard);
  const root = path.join(output, "documents");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "nested"));
  const identity = await executor.inspect(root, signal());
  const outcomes = [];
  const write = (name, content, expectedContent, changes = {}) => executor.write({ rootPath: root,
    rootIdentity: identity, path: name, content, expectedContent, ...changes }, signal());
  await t.test("creates and replaces real UTF-8 bytes with checked receipts", async () => {
    for (const [name, content, expected, created] of [
      ["nested/note.txt", "Orion 7.\n", null, true],
      ["nested/note.txt", "héllo ☄\n", "Orion 7.\n", false],
      ["nested/note.txt", "", "héllo ☄\n", false],
      ["nested/note.txt", "a\0b", "", false],
      ["empty.txt", "", null, true],
      ["full.txt", "x".repeat(32768), null, true],
    ]) {
      const result = await write(name, content, expected);
      assert.deepEqual(result, { error: 0, effectStarted: true, created, bytes: Buffer.byteLength(content),
        rootIdentity: identity, sha256: hash(content) });
      assert.equal(fs.readFileSync(path.join(root, name), "utf8"), content);
      outcomes.push({ kind: "write", name, bytes: result.bytes, created });
    }
  });
  await t.test("existing-file creation and stale content refuse without effects", async () => {
    for (const expected of [null, "different", "a\0c"]) {
      const result = await write("nested/note.txt", "must not write", expected);
      assert.notEqual(result.error, 0);
      assert.equal(result.effectStarted, false);
      assert.equal(fs.readFileSync(path.join(root, "nested/note.txt"), "utf8"), "a\0b");
    }
    const missing = await write("missing.txt", "must not create", "old");
    assert.notEqual(missing.error, 0); assert.equal(missing.effectStarted, false);
    assert.equal(fs.existsSync(path.join(root, "missing.txt")), false);
  });
  await t.test("literal names, missing parents, directories and size limits", async () => {
    for (const name of ["../outside.txt", "nested/../outside.txt", "/outside.txt", "C:/outside.txt", "note.txt:stream",
      "nested\\note.txt", "NUL", "COM1.txt", "x.", "x ", "nested//x", "nested/", "nested", "absent/x", "x\0z"]) {
      const result = await write(name, "x", name === "nested" ? "" : null);
      assert.notEqual(result.error, 0, name); assert.equal(result.effectStarted, false, name);
    }
    await assert.rejects(write("large.txt", "x".repeat(32769), null));
    await assert.rejects(write("large.txt", "x", "x".repeat(32769)));
    await assert.rejects(write("illformed.txt", "\ud800", null));
    assert.equal(fs.existsSync(path.join(root, "large.txt")), false);
  });
  await t.test("junction, hard link, stream and open-writer targets cannot be changed", async () => {
    const outside = path.join(output, "outside"); fs.mkdirSync(outside);
    const secret = path.join(outside, "secret.txt"); fs.writeFileSync(secret, "outside", { flag: "wx" });
    fs.symlinkSync(outside, path.join(root, "junction"), "junction");
    fs.linkSync(secret, path.join(root, "linked.txt"));
    const streamed = path.join(root, "streamed.txt"); fs.writeFileSync(streamed, "before", { flag: "wx" });
    fs.writeFileSync(streamed + ":extra", "retained");
    const opened = path.join(root, "opened.txt"); fs.writeFileSync(opened, "before", { flag: "wx" });
    const handle = fs.openSync(opened, "r+");
    try {
      for (const [name, expected] of [["junction/secret.txt", "outside"], ["junction/new.txt", null],
        ["linked.txt", "outside"], ["streamed.txt", "before"], ["opened.txt", "before"]]) {
        const result = await write(name, "overwrite", expected);
        assert.notEqual(result.error, 0, name); assert.equal(result.effectStarted, false, name);
      }
    } finally { fs.closeSync(handle); }
    assert.equal(fs.readFileSync(secret, "utf8"), "outside");
    assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
    assert.equal(fs.readFileSync(streamed, "utf8"), "before");
    assert.equal(fs.readFileSync(streamed + ":extra", "utf8"), "retained");
    assert.equal(fs.readFileSync(opened, "utf8"), "before");
  });
  await t.test("changed root identity and cancelled work refuse before effects", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(executor.write({ rootPath: root, rootIdentity: identity, path: "cancelled.txt", content: "x", expectedContent: null }, cancelled.signal));
    fs.renameSync(root, root + "-original"); fs.mkdirSync(root);
    const result = await write("replacement.txt", "x", null);
    assert.notEqual(result.error, 0); assert.equal(result.effectStarted, false);
    assert.equal(fs.existsSync(path.join(root, "replacement.txt")), false);
    assert.equal(fs.existsSync(path.join(root, "cancelled.txt")), false);
  });
  await t.test("native protocol and ASAN enforce the same path and byte boundary", () => {
    const asanOutput = path.join(output, "asan"); fs.mkdirSync(asanOutput);
    const source = path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-cell-native/src");
    const asan = compileTlsNative({ target: "windows-x64", outputDirectory: asanOutput,
      sources: ["cell_tool_main.cpp", "cell_filesystem.cpp"].map((name) => path.join(source, name)),
      outputName: "files-asan.exe", asan: true });
    const toolchain = resolveExactWindowsToolchain("windows-x64");
    const request = (operation, name = "", expected = null, content = "", rootIdentity = Buffer.alloc(24)) => {
      const rootBytes = Buffer.from(root), relative = Buffer.from(name), body = Buffer.from(content);
      const old = expected === null ? undefined : Buffer.from(expected);
      const header = Buffer.alloc(52); header.write("GCFILES1"); header.writeUInt32LE(operation, 8);
      header.writeUInt32LE(rootBytes.length, 12); header.writeUInt32LE(relative.length, 16);
      header.writeUInt32LE(body.length, 20); header.writeUInt32LE(old?.length ?? 0xffffffff, 24);
      rootIdentity.copy(header, 28);
      return Buffer.concat([header, rootBytes, relative, body, old ?? Buffer.alloc(0)]);
    };
    for (const executable of [built.fileExecutor, asan]) {
      const call = (input) => {
        const result = spawnSync(executable, [], { input, windowsHide: true, timeout: 10000, maxBuffer: 4096,
          env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
        assert.equal(result.error, undefined); assert.equal(result.status, 0);
        assert.equal(result.stderr.length, 0, result.stderr.toString());
        assert.equal(result.stdout.length, 80); assert.equal(result.stdout.toString("ascii", 0, 8), "GCFILER1");
        return result.stdout;
      };
      const inspection = call(request(1)); assert.equal(inspection.readUInt32LE(8), 0);
      const admitted = inspection.subarray(24, 48);
      const name = path.basename(executable) + ".txt";
      for (const [expected, content] of [[null, "initial"], ["initial", "short"], ["short", ""]]) {
        const result = call(request(2, name, expected, content, admitted));
        assert.equal(result.readUInt32LE(8), 0); assert.equal(result.readUInt32LE(12), 1);
        assert.equal(fs.readFileSync(path.join(root, name), "utf8"), content);
      }
      for (const input of [Buffer.alloc(1), Buffer.from("GCFILES1"), Buffer.alloc(80000),
        Buffer.concat([request(1), Buffer.from([0])]), request(9), request(2, "../escape.txt", null, "x", admitted)]) {
        const result = call(input); assert.notEqual(result.readUInt32LE(8), 0); assert.equal(result.readUInt32LE(12), 0);
      }
      outcomes.push({ kind: "native-protocol", asan: executable === asan });
    }
  });
  await t.test("image guard rejects extra arguments and a replaced executable", () => {
    assert.throws(() => guard.pinFileExecutor("arbitrary.exe"));
    const drift = path.join(output, "drift"); fs.mkdirSync(drift);
    const addon = path.join(drift, path.basename(built.guardAddon));
    const helper = path.join(drift, path.basename(built.fileExecutor));
    fs.copyFileSync(built.guardAddon, addon, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(built.fileExecutor, helper, fs.constants.COPYFILE_EXCL);
    fs.appendFileSync(helper, Buffer.from([1]));
    assert.throws(() => requireNative(addon).pinFileExecutor(), /compiled pin/);
  });
  await t.test("cancellation joins the exact running helper before reporting uncertainty", async () => {
    const fixtureRoot = path.join(output, "cancel-fixture"); fs.mkdirSync(fixtureRoot);
    const executable = compileTlsNative({ target: "windows-x64", outputDirectory: fixtureRoot,
      sources: [path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-cell-native/tests/cell_tool_hang_fixture.cpp")],
      outputName: "GoatCitadelRemoteWorkerFiles.exe" });
    // Only this test's trusted constructor port substitutes the controlled hang.
    const controlled = createWindowsWorkerFileExecutor({ pinFileExecutor: () => ({ executorPath: executable, lease: {} }) });
    const stop = new AbortController();
    const operation = controlled.write({ rootPath: root, rootIdentity: identity, path: "cancelled.txt", content: "x", expectedContent: null }, stop.signal);
    const rejected = assert.rejects(operation, /requires reconciliation/);
    try {
      const deadline = Date.now() + 5000;
      const marker = path.join(fixtureRoot, "started.pid");
      while (!fs.existsSync(marker) && Date.now() < deadline) await delay(10);
      assert.ok(fs.existsSync(marker), "The exact helper must start before cancellation.");
      const pid = Number(fs.readFileSync(marker, "utf8")); assert.ok(Number.isSafeInteger(pid) && pid > 0);
      process.kill(pid, 0);
      stop.abort();
      await rejected;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(fs.existsSync(path.join(root, "cancelled.txt")), false);
      outcomes.push({ kind: "joined-helper-cancellation", pid });
    } finally { stop.abort(); await rejected; }
  });
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ source: "native fixed-image filesystem owner",
    outcomes, artifact: built.receipt.fileExecutor, liveProvider: false, installedService: false }, null, 2), { flag: "wx" });
  console.log("Native file executor proof: " + output);
});
