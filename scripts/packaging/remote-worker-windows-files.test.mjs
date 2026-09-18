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
import { createWindowsWorkerFileExecutor, createWindowsWorkerDirectoryExecutor } from "../../apps/remote-worker/dist/worker-windows-file-executor.js";

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
  const directoryExecutor = createWindowsWorkerDirectoryExecutor(guard);
  const root = path.join(output, "documents");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "nested"));
  const identity = await executor.inspect(root, signal());
  const outcomes = [];
  const write = (name, content, expectedContent, changes = {}) => executor.write({ rootPath: root,
    rootIdentity: identity, path: name, content, expectedContent, ...changes }, signal());
  const list = (name = ".", changes = {}) => directoryExecutor.list({ rootPath: root, rootIdentity: identity, path: name, ...changes }, signal());
  await t.test("lists bounded real directory names and never traverses junctions", async () => {
    const directory = path.join(root, "listing"); fs.mkdirSync(directory);
    fs.mkdirSync(path.join(directory, "child"));
    fs.writeFileSync(path.join(directory, "héllo ☄.txt"), "private bytes are not returned", { flag: "wx" });
    fs.writeFileSync(path.join(directory, "\ufeffnote.txt"), "other private bytes", { flag: "wx" });
    const outside = path.join(output, "list-outside"); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "private.txt"), "private", { flag: "wx" });
    fs.symlinkSync(outside, path.join(directory, "junction"), "junction");
    assert.deepEqual(await list("listing"), { rootIdentity: identity, truncated: false, entries: [
      { name: "child", type: "directory" }, { name: "héllo ☄.txt", type: "file" },
      { name: "junction", type: "unavailable" }, { name: "\ufeffnote.txt", type: "file" },
    ] });
    assert.deepEqual((await list("listing/child")).entries, []);
    assert.ok((await list()).entries.some(entry => entry.name === "listing" && entry.type === "directory"));
    for (const name of ["listing/junction", "listing/junction/..", "../list-outside", "C:/", "listing/héllo ☄.txt", "listing/", "listing//child", "NUL", "listing:stream"])
      await assert.rejects(list(name));
    outcomes.push({ kind: "native-directory-list", entries: 4, junctionTraversal: false });
  });
  await t.test("marks entry and byte truncation explicitly without unbounded enumeration", async () => {
    const many = path.join(root, "many"); fs.mkdirSync(many);
    for (let index = 0; index < 129; index++) fs.writeFileSync(path.join(many, `file-${String(index).padStart(3, "0")}`), "", { flag: "wx" });
    const limited = await list("many"); assert.equal(limited.truncated, true); assert.equal(limited.entries.length, 128);
    const long = path.join(root, "long"); fs.mkdirSync(long);
    for (let index = 0; index < 100; index++) fs.writeFileSync(path.join(long, `${String(index).padStart(3, "0")}${"界".repeat(170)}`), "", { flag: "wx" });
    const bytes = await list("long"); assert.equal(bytes.truncated, true); assert.ok(bytes.entries.length > 0 && bytes.entries.length < 100);
    assert.ok(Buffer.byteLength(JSON.stringify(bytes)) < 65536);
    outcomes.push({ kind: "directory-truncation", entryLimit: limited.entries.length, byteLimitEntries: bytes.entries.length });
  });
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
    await assert.rejects(directoryExecutor.list({ rootPath: root, rootIdentity: identity, path: "." }, cancelled.signal));
    fs.renameSync(root, root + "-original"); fs.mkdirSync(root);
    const result = await write("replacement.txt", "x", null);
    await assert.rejects(list());
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
        const result = spawnSync(executable, [], { input, windowsHide: true, timeout: 10000, maxBuffer: 35000,
          env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
        assert.equal(result.error, undefined); assert.equal(result.status, 0);
        assert.equal(result.stderr.length, 0, result.stderr.toString());
        const listing = input.length >= 12 && input.subarray(0, 8).equals(Buffer.from("GCFILES1")) && input.readUInt32LE(8) === 3;
        if (listing) {
          assert.ok(result.stdout.length >= 44 && result.stdout.length <= 32812);
          assert.equal(result.stdout.toString("ascii", 0, 8), "GCFLIST1");
        } else { assert.equal(result.stdout.length, 80); assert.equal(result.stdout.toString("ascii", 0, 8), "GCFILER1"); }
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
      const listed = call(request(3, "", null, "", admitted));
      assert.equal(listed.readUInt32LE(8), 0); assert.equal(listed.readUInt32LE(12), 0);
      assert.deepEqual(listed.subarray(20, 44), admitted);
      const names = []; let offset = 44;
      for (let index = 0; index < listed.readUInt32LE(16); index++) {
        assert.equal(listed.readUInt32LE(offset), 1);
        const length = listed.readUInt32LE(offset + 4);
        names.push(listed.toString("utf8", offset + 8, offset + 8 + length)); offset += 8 + length;
      }
      assert.equal(offset, listed.length); assert.ok(names.includes(name));
      for (const input of [request(3, "../outside", null, "", admitted), request(3, "", null, "forbidden", admitted),
        request(3, "", "unexpected", "", admitted), request(3), Buffer.concat([request(3, "", null, "", admitted), Buffer.from([0])])]) {
        const invalid = call(input); assert.notEqual(invalid.readUInt32LE(8), 0);
        assert.equal(invalid.readUInt32LE(16), 0); assert.equal(invalid.length, 44);
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
