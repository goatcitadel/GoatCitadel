import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveExactWindowsToolchain,
  assertNoRemoteWorkerBuildPathLeak,
} from "./lib/remote-worker-windows-toolchain.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TLS_ADAPTER_DLL = "GoatCitadelRemoteWorkerTlsKey.dll";
export const TLS_IMAGE_GUARD_ADDON = "GoatCitadelRemoteWorkerImageGuard.node";
export const FILE_EXECUTOR_EXE = "GoatCitadelRemoteWorkerFiles.exe";
export const STDIO_EXECUTOR_EXE = "GoatCitadelRemoteWorkerStdio.exe";
export const CELL_PROVISIONING_EXE = "GoatCitadelRemoteWorkerCellProvisioning.exe";
export const CELL_PROVISIONING_SOURCES = Object.freeze([
  "cell_provisioning_main.cpp", "cell_provisioning_journal.cpp", "cell_provisioning_journal.hpp",
  "cell_virtual_disk.cpp", "cell_virtual_disk.hpp", "cell_workspace.cpp", "cell_workspace.hpp",
  "cell_virtual_disk_device.cpp", "cell_virtual_disk_device.hpp", "cell_virtual_disk_layout.cpp", "cell_virtual_disk_layout.hpp",
  "cell_virtual_disk_volume.cpp", "cell_virtual_disk_volume.hpp", "cell_ntfs_format.cpp", "cell_ntfs_format.hpp",
  "cell_ntfs_format_wmi.cpp", "cell_ntfs_format_wmi.hpp",
  "cell_volume_protection.cpp", "cell_volume_protection.hpp",
  "cell_volume_mount.cpp", "cell_volume_mount.hpp", "cell_volume_mount_target.cpp", "cell_volume_mount_target.hpp",
  "cell_mounted_workspace.cpp", "cell_mounted_workspace.hpp",
  "cell_filesystem.cpp", "cell_filesystem.hpp", "cell_security.cpp", "cell_security.hpp",
  "cell_controller_identity.cpp", "cell_controller_identity.hpp",
  "cell_controller_transport.cpp", "cell_controller_transport.hpp",
  "cell_controller_protocol.cpp", "cell_controller_protocol.hpp",
  "cell_controller_client_identity.cpp", "cell_controller_client_identity.hpp",
  "cell_controller_client_protocol.cpp", "cell_controller_client_protocol.hpp",
]);
export const CELL_PROVISIONING_HOST_SOURCES = Object.freeze(["service_identity.cpp", "service_identity.hpp", "worker_host.hpp"]);
export const STDIO_EXECUTOR_SOURCES = Object.freeze([
  "cell_stdio_main.cpp", "cell_stdio_protocol.cpp", "cell_stdio_protocol.hpp",
  "cell_job.cpp", "cell_job.hpp", "cell_job_stdio.cpp", "cell_job_stdio.hpp", "cell_job_stdio_internal.hpp",
  "cell_filesystem.cpp", "cell_filesystem.hpp", "cell_runtime_bundle.cpp", "cell_runtime_bundle.hpp",
  "cell_workspace.cpp", "cell_workspace.hpp", "cell_security.cpp", "cell_security.hpp",
]);
export const FILE_EXECUTOR_SOURCES = Object.freeze([
  "cell_tool_main.cpp", "cell_filesystem.cpp", "cell_filesystem.hpp", "cell_runtime_bundle.hpp", "cell_job.hpp", "cell_job_stdio.hpp", "cell_workspace.hpp",
]);
export const TLS_IMAGE_GUARD_SOURCES = Object.freeze(["node_image_guard.cpp", "node_image_guard_api.hpp"]);
export const TLS_ADAPTER_SOURCES = Object.freeze([
  "helper_process.cpp",
  "openssl_engine_api.hpp",
  "tls_engine.cpp",
  "tls_key.hpp",
  "tls_key_codec.cpp",
]);

export function compileTlsNative({
  target,
  outputDirectory,
  sources,
  outputName,
  includes = [],
  defines = [],
  dll = false,
  asan = false,
  compilerTimeoutMs = 60000,
}) {
  if (!Number.isSafeInteger(compilerTimeoutMs) || compilerTimeoutMs < 1000 || compilerTimeoutMs > 120000) {
    throw new Error("Native compiler timeout must be an integer from 1000 to 120000 milliseconds.");
  }
  const toolchain = resolveExactWindowsToolchain(target);
  const architecture = toolchain.definition.toolArchitecture;
  const include = [
    path.join(toolchain.vcToolsRoot, "include"),
    ...["ucrt", "shared", "um"].map((part) => path.join(toolchain.sdkIncludeRoot, part)),
    ...includes,
  ];
  const libraries = [
    toolchain.vcLibraryRoot,
    ...["ucrt", "um"].map((part) => path.join(toolchain.sdkLibraryRoot, part, architecture)),
  ];
  const args = [
    "/nologo",
    "/MT",
    "/std:c++20",
    "/W4",
    "/WX",
    "/wd4191",
    "/EHsc",
    "/O2",
    "/GS",
    "/sdl",
    "/guard:cf",
    "/Gy",
    "/Brepro",
    "/DWIN32_LEAN_AND_MEAN",
    "/DNOMINMAX",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_WIN32_WINNT=0x0a00",
    ...defines.map((value) => `/D${value}`),
    ...(dll ? ["/LD"] : []),
    ...(asan ? ["/fsanitize=address", "/Zi"] : []),
    ...include.map((value) => `/I${value}`),
    ...sources,
    "/link",
    "/Brepro",
    "/INCREMENTAL:NO",
    "/DYNAMICBASE",
    "/HIGHENTROPYVA",
    "/NXCOMPAT",
    "/guard:cf",
    "/OPT:REF",
    "/OPT:ICF",
    ...libraries.map((value) => `/LIBPATH:${value}`),
    "bcrypt.lib",
    `/OUT:${path.join(outputDirectory, outputName)}`,
  ];
  const result = spawnSync(toolchain.compilerPath, args, {
    cwd: outputDirectory,
    encoding: "utf8",
    windowsHide: true,
    timeout: compilerTimeoutMs,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: path.dirname(toolchain.compilerPath),
      TEMP: outputDirectory,
      TMP: outputDirectory,
    },
  });
  fs.writeFileSync(
    path.join(outputDirectory, `${outputName}.build.log`),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    { flag: "wx" },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Native TLS build failed (${result.status ?? result.error?.code}): ${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  return path.join(outputDirectory, outputName);
}

export function buildWindowsTlsKeyAdapter({ target, outputDirectory }) {
  resolveExactWindowsToolchain(target);
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory))
    throw new Error("An absolute fresh output directory is required.");
  // Never replace an earlier artifact, including one from a failed build.
  fs.mkdirSync(outputDirectory);
  const sourceDirectory = path.join(outputDirectory, "source");
  fs.mkdirSync(sourceDirectory);
  const sourceManifest = [...new Set([...TLS_ADAPTER_SOURCES, ...TLS_IMAGE_GUARD_SOURCES, ...FILE_EXECUTOR_SOURCES, ...STDIO_EXECUTOR_SOURCES,
    ...CELL_PROVISIONING_SOURCES, ...CELL_PROVISIONING_HOST_SOURCES])].map((name) => {
    const source = path.join(repository, CELL_PROVISIONING_HOST_SOURCES.includes(name) ? "apps/remote-worker-windows-host-native/src"
      : FILE_EXECUTOR_SOURCES.includes(name) || STDIO_EXECUTOR_SOURCES.includes(name) || CELL_PROVISIONING_SOURCES.includes(name)
      ? "apps/remote-worker-windows-cell-native/src" : "apps/remote-worker-windows-tls-native/src", name);
    if (
      !fs.lstatSync(source).isFile() ||
      fs.lstatSync(source).isSymbolicLink() ||
      fs.realpathSync.native(source).toLowerCase() !== source.toLowerCase()
    )
      throw new Error("Native TLS source is not a regular canonical file.");
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(sourceDirectory, name), bytes, { flag: "wx" });
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const dll = compileTlsNative({
    target,
    outputDirectory,
    sources: TLS_ADAPTER_SOURCES.filter((name) => name.endsWith(".cpp")).map((name) =>
      path.join(sourceDirectory, name),
    ),
    outputName: TLS_ADAPTER_DLL,
    dll: true,
  });
  const bytes = fs.readFileSync(dll);
  assertNoRemoteWorkerBuildPathLeak(bytes, [repository, outputDirectory]);
  const adapterSha256 = createHash("sha256").update(bytes).digest("hex");
  const fileExecutor = compileTlsNative({ target, outputDirectory, outputName: FILE_EXECUTOR_EXE,
    sources: FILE_EXECUTOR_SOURCES.filter((name) => name.endsWith(".cpp")).map((name) => path.join(sourceDirectory, name)) });
  const fileBytes = fs.readFileSync(fileExecutor);
  assertNoRemoteWorkerBuildPathLeak(fileBytes, [repository, outputDirectory]);
  const fileSha256 = createHash("sha256").update(fileBytes).digest("hex");
  const stdioExecutor = compileTlsNative({ target, outputDirectory, outputName: STDIO_EXECUTOR_EXE,
    sources: STDIO_EXECUTOR_SOURCES.filter((name) => name.endsWith(".cpp")).map((name) => path.join(sourceDirectory, name)) });
  const stdioBytes = fs.readFileSync(stdioExecutor);
  assertNoRemoteWorkerBuildPathLeak(stdioBytes, [repository, outputDirectory]);
  const stdioSha256 = createHash("sha256").update(stdioBytes).digest("hex");
  const cellProvisioningExecutor = compileTlsNative({ target, outputDirectory, outputName: CELL_PROVISIONING_EXE,
    sources: [...CELL_PROVISIONING_SOURCES, ...CELL_PROVISIONING_HOST_SOURCES]
      .filter((name) => name.endsWith(".cpp")).map((name) => path.join(sourceDirectory, name)) });
  const cellProvisioningBytes = fs.readFileSync(cellProvisioningExecutor);
  assertNoRemoteWorkerBuildPathLeak(cellProvisioningBytes, [repository, outputDirectory]);
  const cellProvisioningSha256 = createHash("sha256").update(cellProvisioningBytes).digest("hex");
  const pinSource = `#pragma once\n#include <array>\n#include <cstdint>\nnamespace goatcitadel::worker_tls {\nconstexpr std::array<std::uint8_t,32> kExpectedTlsAdapterDigest{${[...Buffer.from(adapterSha256, "hex")].join(",")}};\nconstexpr std::array<std::uint8_t,32> kExpectedFileExecutorDigest{${[...Buffer.from(fileSha256, "hex")].join(",")}};\nconstexpr std::array<std::uint8_t,32> kExpectedStdioExecutorDigest{${[...Buffer.from(stdioSha256, "hex")].join(",")}};\nconstexpr std::array<std::uint8_t,32> kExpectedCellProvisioningDigest{${[...Buffer.from(cellProvisioningSha256, "hex")].join(",")}};\n}\n`;
  fs.writeFileSync(path.join(sourceDirectory, "tls_adapter_pin.hpp"), pinSource, { flag: "wx" });
  sourceManifest.push({
    name: "tls_adapter_pin.hpp",
    bytes: Buffer.byteLength(pinSource),
    sha256: createHash("sha256").update(pinSource).digest("hex"),
  });
  const guardAddon = compileTlsNative({
    target,
    outputDirectory,
    outputName: TLS_IMAGE_GUARD_ADDON,
    sources: ["node_image_guard.cpp", "helper_process.cpp", "tls_key_codec.cpp"].map((name) =>
      path.join(sourceDirectory, name),
    ),
    includes: [sourceDirectory],
    dll: true,
  });
  const guardBytes = fs.readFileSync(guardAddon);
  assertNoRemoteWorkerBuildPathLeak(guardBytes, [repository, outputDirectory]);
  const receipt = {
    schemaVersion: 1,
    target,
    runtime: { node: "24.19.0", openssl: "3.5.7", interface: "privateKeyEngine" },
    sourceManifest,
    artifact: { name: TLS_ADAPTER_DLL, bytes: bytes.length, sha256: adapterSha256 },
    fileExecutor: { name: FILE_EXECUTOR_EXE, bytes: fileBytes.length, sha256: fileSha256 },
    stdioExecutor: { name: STDIO_EXECUTOR_EXE, bytes: stdioBytes.length, sha256: stdioSha256 },
    cellProvisioningExecutor: { name: CELL_PROVISIONING_EXE, bytes: cellProvisioningBytes.length, sha256: cellProvisioningSha256 },
    guardAddon: {
      name: TLS_IMAGE_GUARD_ADDON,
      bytes: guardBytes.length,
      sha256: createHash("sha256").update(guardBytes).digest("hex"),
      adapterSha256,
      nodeApiVersion: 8,
    },
    acceptance: { installedService: "unproven", protectedCustody: "unproven", physicalWorker: "unproven" },
  };
  fs.writeFileSync(
    path.join(outputDirectory, "tls-key-adapter-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  return { dll, guardAddon, fileExecutor, stdioExecutor, cellProvisioningExecutor, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--target" || args[2] !== "--output-dir")
      throw new Error("Usage: --target windows-x64|windows-arm64 --output-dir <fresh absolute directory>");
    const result = buildWindowsTlsKeyAdapter({ target: args[1], outputDirectory: args[3] });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
