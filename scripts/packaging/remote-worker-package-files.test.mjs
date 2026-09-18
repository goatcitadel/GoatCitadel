import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { resolveWorkerDependencyPins } from "./lib/remote-worker-dependency-policy.mjs";
import {
  copyWorkerPackageTree,
  inventoryWorkerPackage,
  verifyRemoteWorkerWindowsPackage,
  workerPackageSha256,
  WORKER_PACKAGE_SCHEMA,
  WORKER_PACKAGE_MANIFEST_NAME,
  readPackageFile,
} from "./lib/remote-worker-package-files.mjs";
import { buildRemoteWorkerWindowsPackage, createWorkerPackageDeployment } from "./build-remote-worker-windows-package.mjs";

test("worker dependency staging stays beside the workspace and preserves prior runs", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-deployment-")));
  const first = createWorkerPackageDeployment(root);
  assert.equal(path.relative(root, first).split(path.sep)[0], ".tmp");
  assert.equal(path.isAbsolute(path.relative(root, first)), false);
  assert.equal(fs.existsSync(first), false);
  fs.mkdirSync(first);
  const marker = path.join(first, "retained.txt");
  fs.writeFileSync(marker, "previous staging", { flag: "wx" });
  const second = createWorkerPackageDeployment(root);
  assert.notEqual(first, second);
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.readFileSync(marker, "utf8"), "previous staging");
  assert.throws(() => createWorkerPackageDeployment("relative"), /absolute repository/);
});

test("worker dependency staging refuses a redirected scratch directory", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-deployment-alias-")));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-deployment-outside-"));
  fs.symlinkSync(outside, path.join(root, ".tmp"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createWorkerPackageDeployment(root), /linked scratch/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("worker package accepts only the exact installed schema runtime graph", () => {
  const require = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
  const pending = ["ajv", "ajv-formats"].map((name) => require.resolve(name + "/package.json"));
  const seen = new Set();
  for (let index = 0; index < pending.length; index += 1) {
    const metadataFile = pending[index];
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    if (seen.has(metadata.name)) continue;
    seen.add(metadata.name);
    const pins = resolveWorkerDependencyPins(metadata);
    const local = createRequire(metadataFile);
    for (const name of Object.keys(metadata.dependencies ?? {})) {
      const dependencyFile = local.resolve(name + "/package.json");
      const dependency = JSON.parse(fs.readFileSync(dependencyFile, "utf8"));
      assert.equal(dependency.version, pins[name]);
      pending.push(dependencyFile);
    }
  }
  assert.deepEqual([...seen].sort(), ["ajv", "ajv-formats", "fast-deep-equal", "fast-uri",
    "json-schema-traverse", "require-from-string"].sort());
});

test("worker package rejects schema dependency, version and peer drift", () => {
  const require = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
  const original = require("ajv-formats/package.json");
  for (const update of [
    { version: "3.0.2" },
    { dependencies: { ajv: "*" } },
    { dependencies: { ...original.dependencies, unexpected: "1.0.0" } },
    { optionalDependencies: { unexpected: "1.0.0" } },
    { peerDependenciesMeta: { ajv: { optional: false } } },
    { peerDependencies: { ajv: "^9.0.0" } },
  ]) assert.throws(() => resolveWorkerDependencyPins({ ...original, ...update }), /packaging policy|reviewed graph/);
  assert.throws(() => resolveWorkerDependencyPins({ name: "unreviewed", peerDependencies: { ajv: "^8.0.0" } }),
    /packaging policy/);
  const pins = resolveWorkerDependencyPins(original);
  assert.equal(pins.ajv, "8.20.0");
  assert.ok(Object.isFrozen(pins));
  const ajvRequire = createRequire(require.resolve("ajv/package.json"));
  const uri = ajvRequire("fast-uri/package.json");
  assert.equal(uri.version, "3.1.6");
  for (const version of ["3.1.5", "3.1.7"]) {
    assert.throws(() => resolveWorkerDependencyPins({ ...uri, version }), /reviewed graph/);
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-package-files-"));
  for (const name of [
    "app/worker/dist/main.js",
    "app/runtime/node.exe",
    "bin/GoatCitadelRemoteWorkerHost.exe",
    "app/runtime/worker-host-receipt.json",
    "app/worker/dist/index.js",
    "app/install/install-worker-service.ps1",
    "app/install/uninstall-worker-service.ps1",
    "app/install/enroll-worker-service.ps1",
    "app/install/worker-enrollment-common.ps1",
    "app/install/worker-install-common.ps1",
    "app/install/worker-install-native.cs",
    "app/install/worker-controller-key.cs",
    "app/install/configure-worker-mesh-registry.ps1",
    "app/install/worker-mesh-registry-common.ps1",
    "app/install/broker-coordinator-common.ps1",
    "app/install/broker-state-common.ps1",
    "app/install/broker-state-native.cs",
    "app/install/install-broker-coordinator.ps1",
    "app/install/uninstall-broker-coordinator.ps1",
    "bin/worker.ps1",
    "app/pnpm-lock.yaml",
    "app/worker/native/GoatCitadelRemoteWorkerImageGuard.node",
    "app/worker/native/GoatCitadelRemoteWorkerTlsKey.dll",
    "app/worker/native/GoatCitadelRemoteWorkerFiles.exe",
    "app/worker/native/GoatCitadelRemoteWorkerStdio.exe",
    "app/worker/native/GoatCitadelRemoteWorkerCellProvisioning.exe",
    "app/worker/native/GoatCitadelRemoteWorkerCellController.exe",
    "app/provisioner/GoatCitadelRemoteWorkerProvisioner.exe",
    "app/provisioner/GoatCitadelRemoteWorkerProvisionerClient.exe",
    "app/provisioner/GoatCitadelRemoteWorkerProvisionerAvailability.exe",
  ]) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${name}`, { flag: "wx" });
  }
  const manifest = {
    schemaVersion: WORKER_PACKAGE_SCHEMA,
    target: "windows-x64",
    nodeVersion: "24.19.0",
    opensslVersion: "3.5.7",
    entrypoint: "app/worker/dist/main.js",
    nodeExecutable: "app/runtime/node.exe",
    hostExecutable: "bin/GoatCitadelRemoteWorkerHost.exe",
    files: inventoryWorkerPackage(root),
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, WORKER_PACKAGE_MANIFEST_NAME), bytes, { flag: "wx" });
  return { root, expectedManifestSha256: workerPackageSha256(bytes) };
}

test("worker package verifies after an independent copy to another directory", () => {
  const original = fixture();
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-package-copy-")), "payload");
  copyWorkerPackageTree(original.root, root);
  assert.deepEqual(verifyRemoteWorkerWindowsPackage({ ...original, root }), verifyRemoteWorkerWindowsPackage(original));
});
for (const mode of ["changed", "missing", "extra", "hardlink", "manifest", "untrusted-hash"]) {
  test(`worker package refuses ${mode}`, () => {
    const input = fixture();
    const main = path.join(input.root, "app/worker/dist/main.js");
    if (mode === "changed") fs.appendFileSync(main, "drift");
    if (mode === "missing")
      fs.renameSync(main, path.join(path.dirname(input.root), `${path.basename(input.root)}-main.js`));
    if (mode === "extra") fs.writeFileSync(path.join(input.root, "app/extra.js"), "unexpected");
    if (mode === "hardlink")
      fs.linkSync(main, path.join(path.dirname(input.root), `${path.basename(input.root)}-link.js`));
    if (mode === "manifest") fs.appendFileSync(path.join(input.root, WORKER_PACKAGE_MANIFEST_NAME), " ");
    if (mode === "untrusted-hash") input.expectedManifestSha256 = undefined;
    assert.throws(() => verifyRemoteWorkerWindowsPackage(input));
  });
}
test(
  "worker package refuses dependency junctions and copy-time aliases",
  { skip: process.platform !== "win32" },
  () => {
    const input = fixture();
    fs.symlinkSync(path.join(input.root, "app/runtime"), path.join(input.root, "app/alias"), "junction");
    assert.throws(() => verifyRemoteWorkerWindowsPackage(input), /link|alias/);
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-package-alias-")), "payload");
    assert.throws(() => copyWorkerPackageTree(input.root, copy), /link/);
  },
);

for (const mode of ["grow", "truncate"]) {
  test(`worker package refuses a file that changes during a bounded read: ${mode}`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-read-race-"));
    const file = path.join(root, "input.bin");
    fs.writeFileSync(file, Buffer.alloc(128 * 1024, 1));
    const originalRead = fs.readSync;
    let changed = false;
    context.mock.method(fs, "readSync", (...args) => {
      const count = originalRead(...args);
      if (!changed) {
        changed = true;
        if (mode === "grow") fs.appendFileSync(file, Buffer.alloc(1));
        else fs.truncateSync(file, 1);
      }
      return count;
    });
    assert.throws(() => readPackageFile(file), /grew|truncated|changed/);
  });
}

test("worker package bounds a manifest read before allocating its contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-worker-read-limit-"));
  const file = path.join(root, "input.bin");
  fs.writeFileSync(file, Buffer.alloc(1025));
  assert.throws(() => readPackageFile(file, { maxBytes: 1024 }), /oversized/);
});

for (const mode of ["obsolete-schema", "obsolete-v2-schema", "missing-native-host", "redirected-host"]) {
  test(`worker package refuses a freshly hashed ${mode} manifest`, () => {
    const input = fixture();
    const file = path.join(input.root, WORKER_PACKAGE_MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (mode === "obsolete-schema") manifest.schemaVersion = "goatcitadel.remote-worker-windows-package.v1";
    if (mode === "obsolete-v2-schema") manifest.schemaVersion = "goatcitadel.remote-worker-windows-package.v2";
    if (mode === "redirected-host") manifest.hostExecutable = "app/runtime/node.exe";
    if (mode === "missing-native-host") {
      fs.renameSync(path.join(input.root, manifest.hostExecutable), `${input.root}-removed-host.exe`);
      manifest.files = inventoryWorkerPackage(input.root);
    }
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(file, bytes);
    input.expectedManifestSha256 = workerPackageSha256(bytes);
    assert.throws(() => verifyRemoteWorkerWindowsPackage(input), /runtime contract|required runtime component/);
  });
}

for (const name of [
  "install-worker-service.ps1",
  "uninstall-worker-service.ps1",
  "enroll-worker-service.ps1",
  "worker-enrollment-common.ps1",
  "worker-install-common.ps1",
  "worker-install-native.cs",
  "worker-controller-key.cs",
  "configure-worker-mesh-registry.ps1",
  "worker-mesh-registry-common.ps1",
  "broker-state-common.ps1",
  "broker-state-native.cs",
]) {
  test(`worker package refuses a rehashed inventory missing ${name}`, () => {
    const input = fixture();
    const manifestFile = path.join(input.root, WORKER_PACKAGE_MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    fs.renameSync(path.join(input.root, "app/install", name), `${input.root}-${name}`);
    manifest.files = inventoryWorkerPackage(input.root);
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(manifestFile, bytes);
    input.expectedManifestSha256 = workerPackageSha256(bytes);
    assert.throws(() => verifyRemoteWorkerWindowsPackage(input), /required runtime component/);
  });
}

for (const helper of ["GoatCitadelRemoteWorkerStdio.exe", "GoatCitadelRemoteWorkerCellProvisioning.exe", "GoatCitadelRemoteWorkerCellController.exe"]) {
  test(`worker package refuses a rehashed inventory missing ${helper}`, () => {
    const input = fixture();
    const manifestFile = path.join(input.root, WORKER_PACKAGE_MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    fs.renameSync(path.join(input.root, "app/worker/native", helper), `${input.root}-${helper}`);
    manifest.files = inventoryWorkerPackage(input.root);
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(manifestFile, bytes);
    input.expectedManifestSha256 = workerPackageSha256(bytes);
    assert.throws(() => verifyRemoteWorkerWindowsPackage(input), /required runtime component/);
  });
}

test("worker package builder refuses unreviewed targets and Node image pins", async () => {
  await assert.rejects(buildRemoteWorkerWindowsPackage({ target: "other" }), /supported Windows target/);
  if (process.platform === "win32")
    await assert.rejects(
      buildRemoteWorkerWindowsPackage({
        target: "windows-x64",
        outputDirectory: path.join(os.tmpdir(), "unused-output"),
        nodeExecutableSha256: "11".repeat(32),
      }),
      /reviewed runtime release/,
    );
});
