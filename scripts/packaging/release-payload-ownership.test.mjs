import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  materializeHardLinkedFiles,
  pruneReleaseResidue,
  removeEmptyDirectories,
} from "./lib/release-payload-ownership.mjs";
import { removeDirectorySafely } from "./safe-cleanup.mjs";

test("bundle ownership materialization severs deployed workspace hard links", (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-payload-ownership-"));
  context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const sourceDir = path.join(tempRoot, "workspace-source");
  const deployDir = path.join(tempRoot, "deploy", "node_modules", "@goatcitadel", "contracts");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(deployDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "package.json");
  const deployedPath = path.join(deployDir, "package.json");
  fs.writeFileSync(sourcePath, '{"name":"@goatcitadel/contracts"}\n', "utf8");
  fs.linkSync(sourcePath, deployedPath);

  assert.equal(fs.statSync(sourcePath).nlink, 2);
  assert.equal(fs.statSync(deployedPath).nlink, 2);
  assert.equal(materializeHardLinkedFiles(path.join(tempRoot, "deploy")), 1);
  assert.equal(fs.statSync(sourcePath).nlink, 1);
  assert.equal(fs.statSync(deployedPath).nlink, 1);
  assert.equal(fs.readFileSync(deployedPath, "utf8"), '{"name":"@goatcitadel/contracts"}\n');
  assert.equal(materializeHardLinkedFiles(path.join(tempRoot, "deploy")), 0);
});

test("bundle ownership cleanup removes unmanifested empty directories", (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-empty-payload-"));
  context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const payloadRoot = path.join(tempRoot, "payload");
  const nestedEmpty = path.join(payloadRoot, "empty", "nested");
  const populated = path.join(payloadRoot, "populated");
  fs.mkdirSync(nestedEmpty, { recursive: true });
  fs.mkdirSync(populated, { recursive: true });
  fs.writeFileSync(path.join(populated, "runtime.js"), "export {};\n", "utf8");

  assert.equal(removeEmptyDirectories(payloadRoot), 2);
  assert.equal(fs.existsSync(path.join(payloadRoot, "empty")), false);
  assert.equal(fs.existsSync(populated), true);
  assert.equal(fs.existsSync(payloadRoot), true);
  assert.equal(removeEmptyDirectories(payloadRoot), 0);
});

test("bundles exclude nested shard coverage while preserving similarly named runtime files", (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-payload-residue-"));
  const cleanup = (target) => removeDirectorySafely(target, { repoRoot: process.cwd(), allowedRoot: tempRoot });
  context.after(() => cleanup(tempRoot));
  const payloadRoot = path.join(tempRoot, "deploy");
  const storage = path.join(payloadRoot, "node_modules", "@goatcitadel", "storage");
  const discarded = ["coverage-shard-1/tmp/v8.json", "coverage-shard-4/coverage-final.json", "coverage/snapshot.json"];
  const retained = [
    "dist/runtime.js",
    "dist/coverage-shard-1",
    "coverage-tools/index.js",
    "coverage-shard-runtime/index.js",
  ];
  for (const relative of [...discarded, ...retained]) {
    const file = path.join(storage, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture\n");
  }
  const sourceCoverage = path.join(tempRoot, "workspace-source", "coverage-shard-1", "coverage-final.json");
  fs.mkdirSync(path.dirname(sourceCoverage), { recursive: true });
  fs.writeFileSync(sourceCoverage, "keep workspace evidence\n");

  pruneReleaseResidue(payloadRoot, cleanup);

  for (const relative of discarded) assert.equal(fs.existsSync(path.join(storage, relative)), false, relative);
  for (const relative of retained)
    assert.equal(fs.readFileSync(path.join(storage, relative), "utf8"), "fixture\n", relative);
  assert.equal(fs.readFileSync(sourceCoverage, "utf8"), "keep workspace evidence\n");
});
