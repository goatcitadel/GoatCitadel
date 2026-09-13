import fs from "node:fs";
import { renderWorkerWindowsLauncher } from "./lib/remote-worker-windows-launcher.mjs";
import { resolveWorkerDependencyPins } from "./lib/remote-worker-dependency-policy.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWindowsTlsKeyAdapter } from "./build-remote-worker-windows-tls.mjs";
import { buildRemoteWorkerWindowsProvisioner } from "./build-remote-worker-provisioner-windows-native.mjs";
import { buildWindowsWorkerHost, WORKER_HOST_IMAGE } from "./build-remote-worker-windows-host.mjs";
import { buildWindowsCellControllerPayload } from "./build-remote-worker-windows-cell-controller.mjs";
import {
  copyWorkerPackageTree,
  inventoryWorkerPackage,
  readPackageFile,
  verifyRemoteWorkerWindowsPackage,
  workerPackageSha256,
  WORKER_PACKAGE_SCHEMA,
  WORKER_PACKAGE_MANIFEST_NAME,
  WORKER_PACKAGE_NODE_VERSION,
  WORKER_PACKAGE_OPENSSL_VERSION,
  WORKER_PACKAGE_NODE_SHA256,
} from "./lib/remote-worker-package-files.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspacePackages = Object.freeze({
  "@goatcitadel/remote-worker": "apps/remote-worker",
  "@goatcitadel/remote-worker-provisioner": "apps/remote-worker-provisioner",
  "@goatcitadel/contracts": "packages/contracts",
});
const sha = workerPackageSha256;

function runPnpm(args, log) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/corepack/dist/pnpm.js"),
  ];
  const entry = candidates.find(
    (value) => typeof value === "string" && /pnpm\.(?:c?js)$/u.test(value) && fs.existsSync(value),
  );
  if (!entry) throw new Error("A local pnpm entrypoint is required for offline worker packaging.");
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: repository,
    windowsHide: true,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 2 * 1024 * 1024,
  });
  fs.writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
  if (result.error || result.status !== 0) throw new Error(`Worker package command failed; inspect ${log}.`);
}

function copyFile(source, destination, expectedSha256) {
  const bytes = readPackageFile(source);
  if (expectedSha256 !== undefined && sha(bytes) !== expectedSha256)
    throw new Error("A package input differs from its expected hash.");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { flag: "wx" });
  return { sha256: sha(bytes), sizeBytes: bytes.length };
}

function productionDistribution(source, destination) {
  copyWorkerPackageTree(
    source,
    destination,
    (file, stat) =>
      !path.basename(file).includes(".test") && (stat.isDirectory() || file.endsWith(".js") || file.endsWith(".json")),
  );
}

function copyProductionPackages(deployment, destination) {
  const pending = [{ name: "@goatcitadel/remote-worker", directory: deployment }];
  const copied = new Map();
  fs.mkdirSync(destination);
  for (let index = 0; index < pending.length; index++) {
    const { name, directory } = pending[index];
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/u.test(name))
      throw new Error("Unsupported package name in worker dependency graph.");
    const metadataBytes = readPackageFile(path.join(directory, "package.json"));
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    if (metadata.name !== name || typeof metadata.version !== "string")
      throw new Error("Worker package dependency identity differs.");
    if (copied.has(name)) {
      if (copied.get(name) !== metadata.version)
        throw new Error("Worker package dependency graph requires conflicting versions.");
      continue;
    }
    const dependencyPins = resolveWorkerDependencyPins(metadata);
    copied.set(name, metadata.version);
    const target = name === "@goatcitadel/remote-worker" ? destination : path.join(destination, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const workspacePath = Object.hasOwn(workspacePackages, name) ? workspacePackages[name] : undefined;
    if (workspacePath) {
      const liveMetadata = readPackageFile(path.join(repository, workspacePath, "package.json"));
      if (!metadataBytes.equals(liveMetadata)) throw new Error("Staged workspace package metadata is stale.");
      if (target !== destination) fs.mkdirSync(target);
      copyFile(path.join(directory, "package.json"), path.join(target, "package.json"));
      productionDistribution(path.join(repository, workspacePath, "dist"), path.join(target, "dist"));
    } else {
      copyWorkerPackageTree(directory, target, (file) => path.basename(file) !== "node_modules");
    }
    for (const [dependency, version] of Object.entries(metadata.dependencies ?? {})) {
      if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/u.test(dependency)) throw new Error("Unsupported package dependency name.");
      const dependencyDirectory = path.join(deployment, "node_modules", dependency);
      const dependencyMetadata = JSON.parse(
        readPackageFile(path.join(dependencyDirectory, "package.json")).toString("utf8"),
      );
      if (
        Object.hasOwn(workspacePackages, dependency)
          ? version !== "workspace:*"
          : (dependencyPins[dependency] ?? version) !== dependencyMetadata.version
      )
        throw new Error("Worker package dependencies must use the reviewed workspace or exact installed version.");
      pending.push({ name: dependency, directory: dependencyDirectory });
    }
  }
  return [...copied.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({ name, version }));
}

export async function buildRemoteWorkerWindowsPackage({
  target,
  outputDirectory,
  nodeExecutablePath,
  nodeExecutableSha256,
  nodeLicensePath,
}) {
  const machine = { "windows-x64": 0x8664, "windows-arm64": 0xaa64 }[target];
  if (!machine || process.platform !== "win32")
    throw new Error("Worker packaging requires a supported Windows target.");
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory))
    throw new Error("A fresh absolute output directory is required.");
  if (nodeExecutableSha256 !== WORKER_PACKAGE_NODE_SHA256[target])
    throw new Error("The Node executable pin must match the reviewed runtime release.");
  for (const value of [nodeExecutablePath, nodeLicensePath])
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new Error("Node runtime and license paths must be absolute.");
  const nodeBytes = readPackageFile(nodeExecutablePath);
  if (sha(nodeBytes) !== nodeExecutableSha256 || nodeBytes.length < 512 || nodeBytes.readUInt16LE(0) !== 0x5a4d)
    throw new Error("Node runtime differs from its expected image hash or format.");
  const pe = nodeBytes.readUInt32LE(0x3c);
  if (pe > nodeBytes.length - 24 || nodeBytes.readUInt32LE(pe) !== 0x4550 || nodeBytes.readUInt16LE(pe + 4) !== machine)
    throw new Error("Node runtime PE target differs from the package target.");
  const license = readPackageFile(nodeLicensePath);
  if (license.length < 100 || license.length > 1024 * 1024)
    throw new Error("The Node distribution license is missing or unbounded.");
  fs.mkdirSync(outputDirectory); // Keep failed/partial output; never replace another run.
  const payload = path.join(outputDirectory, "payload");
  fs.mkdirSync(payload);
  const app = path.join(payload, "app");
  fs.mkdirSync(app);
  console.log("Building the worker and its declared workspace dependencies.");
  runPnpm(["--filter", "@goatcitadel/remote-worker...", "typecheck"], path.join(outputDirectory, "typecheck.log"));
  console.log("Staging production dependencies offline with lifecycle scripts disabled.");
  const deployment = path.join(outputDirectory, "deployment");
  runPnpm(
    [
      "--filter",
      "@goatcitadel/remote-worker",
      "deploy",
      "--prod",
      "--legacy",
      "--offline",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--config.allow-unused-patches=true",
      "--config.node-linker=hoisted",
      "--config.package-import-method=copy",
      deployment,
    ],
    path.join(outputDirectory, "deployment.log"),
  );
  const worker = path.join(app, "worker");
  const dependencies = copyProductionPackages(deployment, worker);
  copyFile(path.join(repository, "pnpm-lock.yaml"), path.join(app, "pnpm-lock.yaml"));
  copyFile(nodeExecutablePath, path.join(app, "runtime/node.exe"), nodeExecutableSha256);
  copyFile(nodeLicensePath, path.join(app, "licenses/Node-LICENSE.txt"), sha(license));
  copyFile(path.join(repository, "LICENSE"), path.join(app, "licenses/GoatCitadel-LICENSE.txt"));
  copyFile(
    path.join(repository, "vendor/monocypher/4.0.3/LICENCE.md"),
    path.join(app, "licenses/Monocypher-LICENCE.md"),
  );
  console.log("Building the pinned native TLS adapter and image guard.");
  const tls = buildWindowsTlsKeyAdapter({ target, outputDirectory: path.join(outputDirectory, "tls-build") });
  for (const [source, expected] of [
    [tls.dll, tls.receipt.artifact.sha256],
    [tls.guardAddon, tls.receipt.guardAddon.sha256],
    [tls.fileExecutor, tls.receipt.fileExecutor.sha256],
    [tls.stdioExecutor, tls.receipt.stdioExecutor.sha256],
    [tls.cellProvisioningExecutor, tls.receipt.cellProvisioningExecutor.sha256],
  ])
    copyFile(source, path.join(worker, "native", path.basename(source)), expected);
  console.log("Building the dedicated native cell controller.");
  const controller = buildWindowsCellControllerPayload({ target, outputDirectory: path.join(outputDirectory, "controller-build") });
  copyFile(controller.executable, path.join(worker, "native", controller.receipt.artifact.name), controller.receipt.artifact.sha256);
  console.log("Building and verifying the native provisioner service, client and availability broker.");
  const provisioner = buildRemoteWorkerWindowsProvisioner({
    target,
    outDir: path.join(outputDirectory, "provisioner-build"),
  });
  for (const image of [provisioner.service, provisioner.client, provisioner.availability])
    copyFile(image.path, path.join(app, "provisioner", path.basename(image.path)), image.sha256);
  fs.writeFileSync(path.join(outputDirectory, "provisioner-build-result.json"), JSON.stringify(provisioner, null, 2), {
    flag: "wx",
  });
  const installReceipt = {
    schemaVersion: "goatcitadel.remote-worker.provisioner-install.v1",
    target,
    service: { sha256: provisioner.service.sha256, targetClientSha256: provisioner.service.targetClientSha256 },
    client: { sha256: provisioner.client.sha256 },
    availability: {
      sha256: provisioner.availability.sha256,
      targetServiceSha256: provisioner.availability.targetServiceSha256,
    },
  };
  fs.writeFileSync(path.join(app, "provisioner/install-receipt.json"), `${JSON.stringify(installReceipt, null, 2)}\n`, {
    flag: "wx",
  });
  for (const name of [
    "install-broker-coordinator.ps1",
    "uninstall-broker-coordinator.ps1",
    "broker-coordinator-common.ps1",
    "install-worker-service.ps1",
    "uninstall-worker-service.ps1",
    "enroll-worker-service.ps1",
    "worker-enrollment-common.ps1",
    "worker-install-common.ps1",
    "worker-install-native.cs",
    "configure-worker-mesh-registry.ps1",
    "worker-mesh-registry-common.ps1",
  ])
    copyFile(path.join(repository, "scripts/remote-worker", name), path.join(app, "install", name));
  const host = buildWindowsWorkerHost({
    target,
    outputDirectory: path.join(outputDirectory, "host-build"),
    nodeSha256: nodeExecutableSha256,
    entrypointSha256: sha(readPackageFile(path.join(worker, "dist/main.js"))),
  });
  copyFile(host.executable, path.join(payload, "bin", WORKER_HOST_IMAGE), host.receipt.artifact.sha256);
  fs.writeFileSync(path.join(app, "runtime/worker-host-receipt.json"), `${JSON.stringify(host.receipt, null, 2)}\n`, {
    flag: "wx",
  });
  const launcher = renderWorkerWindowsLauncher();
  fs.writeFileSync(path.join(payload, "bin/worker.ps1"), launcher, { flag: "wx" });
  const files = inventoryWorkerPackage(payload);
  const manifest = {
    schemaVersion: WORKER_PACKAGE_SCHEMA,
    target,
    nodeVersion: WORKER_PACKAGE_NODE_VERSION,
    opensslVersion: WORKER_PACKAGE_OPENSSL_VERSION,
    entrypoint: "app/worker/dist/main.js",
    nodeExecutable: "app/runtime/node.exe",
    hostExecutable: `bin/${WORKER_HOST_IMAGE}`,
    dependencies,
    files,
    acceptance: {
      signature: "unsigned_candidate",
      installedService: "unproven",
      protectedCustody: "unproven",
      physicalWorker: "unproven",
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(payload, WORKER_PACKAGE_MANIFEST_NAME), manifestBytes, { flag: "wx" });
  const proof = verifyRemoteWorkerWindowsPackage({ root: payload, expectedManifestSha256: sha(manifestBytes) });
  const result = {
    payload,
    ...proof,
    dependencies,
    nodeExecutableSha256,
    tlsReceiptSha256: sha(Buffer.from(JSON.stringify(tls.receipt))),
    provisionerSourceSha256: provisioner.sourceManifest.sha256,
    hostSha256: host.receipt.artifact.sha256,
    controllerSha256: controller.receipt.artifact.sha256,
    acceptance: manifest.acceptance,
  };
  fs.writeFileSync(path.join(outputDirectory, "worker-package-result.json"), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const keys = {
      "--target": "target",
      "--output-dir": "outputDirectory",
      "--node-executable": "nodeExecutablePath",
      "--node-sha256": "nodeExecutableSha256",
      "--node-license": "nodeLicensePath",
    };
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const name = keys[process.argv[index]],
        value = process.argv[index + 1];
      if (!name || !value || Object.hasOwn(options, name))
        throw new Error("Expected unique target, output-dir, node-executable, node-sha256 and node-license options.");
      options[name] = value;
    }
    console.log(JSON.stringify(await buildRemoteWorkerWindowsPackage(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
