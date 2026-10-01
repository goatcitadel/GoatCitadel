import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative, TLS_ADAPTER_DLL, TLS_ADAPTER_SOURCES } from "./build-remote-worker-windows-tls.mjs";

test("MSVC links from the 222-character output path used by nested Fast fixtures", {
  skip: process.platform !== "win32",
  timeout: 30000,
}, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-cl-proof-")));
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith("gc-cl-proof-"));
    fs.rmSync(root, { recursive: true });
  });
  const outputDirectory = path.join(root, "x".repeat(221 - root.length));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const source = path.join(outputDirectory, "probe.cpp");
  fs.writeFileSync(source, "int main() { return 0; }\n", { flag: "wx" });
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    // Fast also nests the calling process TEMP, so the builder must use the
    // existing short per-user temp root, not merely call os.tmpdir().
    process.env.TEMP = outputDirectory;
    process.env.TMP = outputDirectory;
    const executable = compileTlsNative({ target: "windows-x64", outputDirectory,
      sources: [source], outputName: "probe.exe" });
    const result = spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.readFileSync(path.join(outputDirectory, "probe.exe.build.log"), "utf8").includes("probe.cpp"));
  } finally {
    for (const key of ["TEMP", "TMP"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("TLS adapter bytes remain reproducible with short scratch and deeply nested output", {
  skip: process.platform !== "win32",
  timeout: 60000,
}, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-cl-proof-")));
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith("gc-cl-proof-"));
    fs.rmSync(root, { recursive: true });
  });
  const sourceRoot = path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-tls-native/src");
  const sources = TLS_ADAPTER_SOURCES.filter((name) => name.endsWith(".cpp"))
    .map((name) => path.join(sourceRoot, name));
  const outputs = [path.join(root, "short"), path.join(root, "x".repeat(221 - root.length))];
  const hashes = outputs.map((outputDirectory) => {
    fs.mkdirSync(outputDirectory);
    const artifact = compileTlsNative({ target: "windows-x64", outputDirectory,
      sources, outputName: TLS_ADAPTER_DLL, dll: true });
    return createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  });
  assert.equal(hashes[0], hashes[1]);
});
