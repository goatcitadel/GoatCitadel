import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildWindowsCellControllerPayload, CELL_CONTROLLER_IMAGE } from "./build-remote-worker-windows-cell-controller.mjs";

test("controller payload builds reproducibly for each Windows package target", { skip: process.platform !== "win32", timeout: 180000 }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Controller Payload "));
  console.log(`Retained controller payload evidence: ${output}`);
  const results = [];
  for (const [target, machine] of [["windows-x64", 0x8664], ["windows-arm64", 0xaa64]]) {
    const builds = ["first", "second"].map((name) => buildWindowsCellControllerPayload({ target, outputDirectory: path.join(output, `${target}-${name}`) }));
    assert.deepEqual(builds[0].receipt, builds[1].receipt);
    for (const { executable, receipt } of builds) {
      const bytes = fs.readFileSync(executable);
      assert.equal(path.basename(executable), CELL_CONTROLLER_IMAGE);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.artifact.sha256);
      assert.equal(bytes.length, receipt.artifact.bytes);
      assert.equal(bytes.readUInt16LE(0), 0x5a4d);
      const pe = bytes.readUInt32LE(0x3c);
      assert.equal(bytes.readUInt32LE(pe), 0x4550);
      assert.equal(bytes.readUInt16LE(pe + 4), machine);
      assert.equal(receipt.sourceManifest.length, 43);
      for (const input of receipt.sourceManifest) assert.equal(
        createHash("sha256").update(fs.readFileSync(path.resolve(import.meta.dirname, "../..", input.name))).digest("hex"), input.sha256,
        `Controller source changed during build: ${input.name}`,
      );
    }
    assert.throws(() => buildWindowsCellControllerPayload({ target, outputDirectory: path.dirname(builds[0].executable) }), /EEXIST/u);
    results.push({ target, sha256: builds[0].receipt.artifact.sha256, bytes: builds[0].receipt.artifact.bytes });
  }
  assert.notEqual(results[0].sha256, results[1].sha256);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ results, installedService: false, arm64Executed: false }, null, 2), { flag: "wx" });
});
