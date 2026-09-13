import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseWorkerCellAcceptanceArguments } from "./run-remote-worker-cell-acceptance.mjs";
import { CELL_ACCEPTANCE_FILES, CELL_ACCEPTANCE_MANIFEST, CELL_ACCEPTANCE_SCHEMA,
  stageWorkerCellAcceptance, verifyWorkerCellAcceptance } from "./lib/remote-worker-cell-acceptance-files.mjs";
import { inventoryWorkerPackage, readPackageFile, workerPackageSha256,
  WORKER_PACKAGE_NODE_SHA256, WORKER_PACKAGE_NODE_VERSION } from "./lib/remote-worker-package-files.mjs";

const hash = "a".repeat(64);
test("cell acceptance requires an independent hash and explicit mutually exclusive privileged modes", () => {
  assert.deepEqual(parseWorkerCellAcceptanceArguments(["--manifest-sha256", hash]), { expectedManifestSha256: hash, mode: "boundary" });
  for (const mode of ["attachment", "preflight"])
    assert.equal(parseWorkerCellAcceptanceArguments(["--manifest-sha256", hash, `--${mode}`]).mode, mode);
  for (const args of [[], ["--attachment"], ["--manifest-sha256", "bad"], ["--manifest-sha256"],
    ["--manifest-sha256", hash, "--attachment", "--preflight"], ["--manifest-sha256", hash, "--attachment", "--attachment"],
    ["--manifest-sha256", hash, "--manifest-sha256", hash], ["--manifest-sha256", hash, "--execute", "anything"]])
    assert.throws(() => parseWorkerCellAcceptanceArguments(args));
});

test("acceptance inventory, bytes and staging remain bound to the supplied manifest", async (t) => {
  if (process.platform !== "win32" || workerPackageSha256(readPackageFile(process.execPath)) !== WORKER_PACKAGE_NODE_SHA256["windows-x64"]) {
    t.skip("The fixture needs the independently pinned Windows Node binary; the packaged native lane supplies it.");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Package Unit "));
  for (const name of CELL_ACCEPTANCE_FILES) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (name === "app/runtime/node.exe") fs.copyFileSync(process.execPath, file, fs.constants.COPYFILE_EXCL);
    else fs.writeFileSync(file, `controlled inventory fixture: ${name}\n`, { flag: "wx" });
  }
  const manifest = { schemaVersion: CELL_ACCEPTANCE_SCHEMA, target: "windows-x64", testingOnly: true,
    nodeVersion: WORKER_PACKAGE_NODE_VERSION, files: inventoryWorkerPackage(root, { manifestName: CELL_ACCEPTANCE_MANIFEST }) };
  const body = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const metadata = path.join(root, CELL_ACCEPTANCE_MANIFEST);
  fs.writeFileSync(metadata, body, { flag: "wx" });
  const reference = { root, expectedManifestSha256: workerPackageSha256(body) };
  await t.test("verified package stages separate copies and records the exact inventory", () => {
    assert.equal(verifyWorkerCellAcceptance(reference).files.length, CELL_ACCEPTANCE_FILES.length);
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Package Stage "));
    const staged = stageWorkerCellAcceptance(reference, output);
    assert.equal(fs.readFileSync(staged.controller, "utf8"), "controlled inventory fixture: app/native/cell-job-test.exe\n");
    assert.equal(fs.statSync(staged.controller).nlink, 1);
    assert.throws(() => stageWorkerCellAcceptance(reference, output));
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, "acceptance-package.json"), "utf8")).manifestSha256, reference.expectedManifestSha256);
  });
  await t.test("wrong or absent independent hashes reject before staging", () => {
    assert.throws(() => verifyWorkerCellAcceptance({ root }));
    assert.throws(() => verifyWorkerCellAcceptance({ root, expectedManifestSha256: hash }));
  });
  await t.test("modified executables and unexpected files cannot pass a still-pinned manifest", () => {
    const file = path.join(root, "app/native/cell-job-test.exe"), original = fs.readFileSync(file);
    fs.writeFileSync(file, "changed executable");
    assert.throws(() => verifyWorkerCellAcceptance(reference));
    fs.writeFileSync(file, original);
    const extra = path.join(root, "app/native/unlisted.dll");
    fs.writeFileSync(extra, "unexpected input", { flag: "wx" });
    assert.throws(() => verifyWorkerCellAcceptance(reference));
    fs.unlinkSync(extra); // Only the just-created fixture file.
    assert.equal(verifyWorkerCellAcceptance(reference).manifestSha256, reference.expectedManifestSha256);
  });
  await t.test("a replacement manifest cannot change mode or leave out required runtime inputs", () => {
    for (const changed of [{ ...manifest, testingOnly: false }, { ...manifest, target: "windows-arm64" },
      { ...manifest, files: manifest.files.slice(1) }]) {
      const bytes = Buffer.from(JSON.stringify(changed));
      fs.writeFileSync(metadata, bytes);
      assert.throws(() => verifyWorkerCellAcceptance({ root, expectedManifestSha256: workerPackageSha256(bytes) }));
    }
    fs.writeFileSync(metadata, body);
    assert.equal(verifyWorkerCellAcceptance(reference).files.length, CELL_ACCEPTANCE_FILES.length);
  });
});
