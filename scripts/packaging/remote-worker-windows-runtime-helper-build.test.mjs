import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CELL_PROVISIONING_SOURCES, CELL_PROVISIONING_HOST_SOURCES, CELL_PROVISIONING_EXE, compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { assertNoRemoteWorkerBuildPathLeak } from "./lib/remote-worker-windows-toolchain.mjs";

test("the packaged runtime helper links its complete production closure reproducibly for x64 and ARM64", { skip: process.platform !== "win32" }, () => {
  const repository = path.resolve(import.meta.dirname, "../.."), output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Helper Build "));
  console.log(`Retained production runtime helper build: ${output}`);
  const source = path.join(output, "source"); fs.mkdirSync(source);
  const names = [...CELL_PROVISIONING_SOURCES, ...CELL_PROVISIONING_HOST_SOURCES];
  assert.equal(new Set(names).size, names.length);
  for (const name of ["cell_capacity_wire.cpp", "cell_capacity_wire.hpp", "cell_joined_capacity_wire.cpp", "cell_joined_capacity_wire.hpp"]) assert.ok(names.includes(name),
    `Packaged runtime helper must retain its capacity wire input: ${name}`);
  const manifest = names.map(name => {
    const relative = `apps/${CELL_PROVISIONING_HOST_SOURCES.includes(name) ? "remote-worker-windows-host-native" : "remote-worker-windows-cell-native"}/src/${name}`;
    const bytes = fs.readFileSync(path.join(repository, relative)); fs.writeFileSync(path.join(source, name), bytes, { flag: "wx" });
    return { name, relative, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const results = [];
  for (const target of ["windows-x64", "windows-arm64"]) {
    const hashes = [];
    for (const attempt of [1, 2]) {
      const directory = path.join(output, `${target}-${attempt}`); fs.mkdirSync(directory);
      const image = compileTlsNative({ target, outputDirectory: directory, outputName: CELL_PROVISIONING_EXE,
        sources: names.filter(name => name.endsWith(".cpp")).map(name => path.join(source, name)), includes: [source] });
      const bytes = fs.readFileSync(image); assertNoRemoteWorkerBuildPathLeak(bytes, [repository, output]);
      hashes.push(createHash("sha256").update(bytes).digest("hex"));
    }
    assert.equal(hashes[0], hashes[1]); results.push({ target, sha256: hashes[0], reproducible: true, executed: false });
  }
  for (const entry of manifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, entry.relative))).digest("hex"), entry.sha256);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ manifest, results, installedService: false,
    boundary: "Exact production helper source closure and reproducible x64/ARM64 binaries. No helper, service or disk operation was run." }, null, 2), { flag: "wx" });
});
