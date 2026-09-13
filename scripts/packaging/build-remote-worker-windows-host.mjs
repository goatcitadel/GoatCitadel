import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import {
  assertNoRemoteWorkerBuildPathLeak,
  resolveExactWindowsToolchain,
} from "./lib/remote-worker-windows-toolchain.mjs";
import { CONNECTED_WORKER_ENV, WORKER_HOST_CONTROL_PROTOCOL } from "../../apps/remote-worker/src/worker-environment.ts";

const repository = path.resolve(import.meta.dirname, "../..");
export const WORKER_HOST_IMAGE = "GoatCitadelRemoteWorkerHost.exe";
const sources = [
  "main.cpp",
  "worker_host.cpp",
  "worker_host.hpp",
  "service_identity.cpp",
  "service_identity.hpp",
  "installed_worker_files.cpp",
  "installed_worker_files.hpp",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function buildWindowsWorkerHost({ target, outputDirectory, nodeSha256, entrypointSha256 }) {
  resolveExactWindowsToolchain(target);
  for (const value of [nodeSha256, entrypointSha256])
    if (!/^[a-f0-9]{64}$/u.test(value ?? "") || /^0+$/u.test(value))
      throw new Error("Exact Node and entrypoint image pins are required.");
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory))
    throw new Error("An absolute fresh output directory is required.");
  fs.mkdirSync(outputDirectory);
  const sourceDirectory = path.join(outputDirectory, "source");
  fs.mkdirSync(sourceDirectory);
  const sourceManifest = sources.map((name) => {
    const bytes = fs.readFileSync(path.join(repository, "apps/remote-worker-windows-host-native/src", name));
    fs.writeFileSync(path.join(sourceDirectory, name), bytes, { flag: "wx" });
    return { name, sha256: sha(bytes) };
  });
  const forwarded = Object.values(CONNECTED_WORKER_ENV).filter(
    (name) => name !== CONNECTED_WORKER_ENV.clientKeyFile && name !== CONNECTED_WORKER_ENV.hostControl,
  );
  const pins = [
    "#pragma once",
    "#include <array>",
    "#include <cstdint>",
    `constexpr std::array<std::uint8_t,32> kNodeSha256{${[...Buffer.from(nodeSha256, "hex")].join(",")}};`,
    `constexpr std::array<std::uint8_t,32> kEntrypointSha256{${[...Buffer.from(entrypointSha256, "hex")].join(",")}};`,
    `constexpr const wchar_t* kForwardedEnvironment[]{${forwarded.map((name) => `L"${name}"`).join(",")}};`,
    `constexpr wchar_t kHostControlEntry[] = L"${CONNECTED_WORKER_ENV.hostControl}=${WORKER_HOST_CONTROL_PROTOCOL}";`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(sourceDirectory, "worker_host_pins.hpp"), pins, { flag: "wx" });
  sourceManifest.push({ name: "worker_host_pins.hpp", sha256: sha(pins) });
  const executable = compileTlsNative({
    target,
    outputDirectory,
    outputName: WORKER_HOST_IMAGE,
    sources: sources.filter((name) => name.endsWith(".cpp")).map((name) => path.join(sourceDirectory, name)),
    includes: [sourceDirectory],
  });
  const bytes = fs.readFileSync(executable);
  assertNoRemoteWorkerBuildPathLeak(bytes, [repository, outputDirectory]);
  const receipt = {
    schemaVersion: "goatcitadel.remote-worker.windows-host.v3",
    target,
    sourceManifest,
    artifact: { name: WORKER_HOST_IMAGE, sha256: sha(bytes), bytes: bytes.length },
    nodeSha256,
    entrypointSha256,
    serviceName: "GoatCitadelRemoteWorker",
    serviceIdentity: {
      account: "NT SERVICE\\GoatCitadelRemoteWorker",
      sid: "S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905",
      start: "demand",
      privileges: ["SeChangeNotifyPrivilege"],
      workerServiceAccess: "query_config_query_status_read_control",
      signerAccess: "not_granted",
      installedRoot: "system_drive/ProgramData/GoatCitadel/RemoteWorker",
      configuration: "configuration/worker.environment",
      meshRegistrySelection: "configuration/mesh-registry.sha256",
      payloadPermissions: "system_owned_worker_read_execute",
      statePermissions: "system_owned_worker_modify",
    },
    processLifetime: {
      jobMembership: "creation_attribute",
      maximumProcesses: 64,
      maximumJobBytes: 4 * 1024 ** 3,
      gracefulStopMs: 10000,
      terminationMs: 5000,
      exitedChildDrainMs: 1000,
    },
    acceptance: { installedService: "unproven", protectedCustody: "unproven", hostileCodeIsolation: "not_claimed" },
  };
  fs.writeFileSync(path.join(outputDirectory, "worker-host-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  return { executable, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 8 ||
      args[0] !== "--target" ||
      args[2] !== "--output-dir" ||
      args[4] !== "--node-sha256" ||
      args[6] !== "--entrypoint-sha256"
    )
      throw new Error(
        "Usage: --target windows-x64|windows-arm64 --output-dir <fresh absolute directory> --node-sha256 <hash> --entrypoint-sha256 <hash>",
      );
    console.log(
      JSON.stringify(
        buildWindowsWorkerHost({
          target: args[1],
          outputDirectory: args[3],
          nodeSha256: args[5],
          entrypointSha256: args[7],
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
