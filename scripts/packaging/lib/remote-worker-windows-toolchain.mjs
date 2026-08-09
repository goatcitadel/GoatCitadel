import fs from "node:fs";
import path from "node:path";

export const REMOTE_WORKER_WINDOWS_MSVC_VERSION = "14.44.35207";
export const REMOTE_WORKER_WINDOWS_SDK_VERSION = "10.0.26100.0";

const targetDefinitions = Object.freeze({
  "windows-x64": Object.freeze({
    msbuildPlatform: "x64",
    toolArchitecture: "x64",
    peMachine: 0x8664,
  }),
  "windows-arm64": Object.freeze({
    msbuildPlatform: "ARM64",
    toolArchitecture: "arm64",
    peMachine: 0xaa64,
  }),
});

const visualStudioCandidates = Object.freeze([
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools",
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Enterprise",
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Professional",
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Community",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community",
]);

const windowsSdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10";

export function resolveExactWindowsToolchain(target) {
  if (process.platform !== "win32") {
    throw new Error("The remote-worker Windows native tools must be built on Windows.");
  }
  const definition = targetDefinitions[target];
  if (!definition) {
    throw new Error(`Unsupported remote-worker Windows target: ${String(target)}`);
  }

  const matchingInstallations = visualStudioCandidates
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => realpath(candidate))
    .filter((candidate) => {
      const toolsRoot = path.join(candidate, "VC", "Tools", "MSVC", REMOTE_WORKER_WINDOWS_MSVC_VERSION);
      return fs.existsSync(toolsRoot);
    });
  if (matchingInstallations.length === 0) {
    throw new Error(
      `MSVC v143 tools ${REMOTE_WORKER_WINDOWS_MSVC_VERSION} were not found in the closed Visual Studio 2022 installation set.`,
    );
  }

  const visualStudioRoot = matchingInstallations[0];
  const vcToolsRoot = checkedDescendant(
    visualStudioRoot,
    path.join(visualStudioRoot, "VC", "Tools", "MSVC", REMOTE_WORKER_WINDOWS_MSVC_VERSION),
    "MSVC tools root",
  );
  const vcTargetsRoot = checkedDescendant(
    visualStudioRoot,
    path.join(visualStudioRoot, "MSBuild", "Microsoft", "VC", "v170"),
    "MSVC targets root",
  );
  const msbuildPath = checkedFile(
    visualStudioRoot,
    path.join(visualStudioRoot, "MSBuild", "Current", "Bin", "MSBuild.exe"),
    "MSBuild executable",
  );
  const compilerPath = checkedFile(
    vcToolsRoot,
    path.join(vcToolsRoot, "bin", "Hostx64", definition.toolArchitecture, "cl.exe"),
    "MSVC compiler",
  );
  const linkerPath = checkedFile(
    vcToolsRoot,
    path.join(vcToolsRoot, "bin", "Hostx64", definition.toolArchitecture, "link.exe"),
    "MSVC linker",
  );
  const vcLibraryRoot = checkedDescendant(
    vcToolsRoot,
    path.join(vcToolsRoot, "lib", definition.toolArchitecture),
    "MSVC library root",
  );

  const sdkRoot = realpath(windowsSdkRoot);
  const sdkIncludeRoot = checkedDescendant(
    sdkRoot,
    path.join(sdkRoot, "Include", REMOTE_WORKER_WINDOWS_SDK_VERSION),
    "Windows SDK include root",
  );
  const sdkLibraryRoot = checkedDescendant(
    sdkRoot,
    path.join(sdkRoot, "Lib", REMOTE_WORKER_WINDOWS_SDK_VERSION),
    "Windows SDK library root",
  );
  const sdkBinaryRoot = checkedDescendant(
    sdkRoot,
    path.join(sdkRoot, "bin", REMOTE_WORKER_WINDOWS_SDK_VERSION, definition.toolArchitecture),
    "Windows SDK binary root",
  );

  for (const requiredDirectory of [
    path.join(sdkIncludeRoot, "shared"),
    path.join(sdkIncludeRoot, "ucrt"),
    path.join(sdkIncludeRoot, "um"),
    path.join(sdkLibraryRoot, "ucrt", definition.toolArchitecture),
    path.join(sdkLibraryRoot, "um", definition.toolArchitecture),
  ]) {
    checkedDescendant(sdkRoot, requiredDirectory, "Windows SDK component");
  }

  return Object.freeze({
    target,
    definition,
    visualStudioRoot,
    vcToolsRoot,
    vcTargetsRoot,
    msbuildPath,
    compilerPath,
    linkerPath,
    vcLibraryRoot,
    sdkRoot,
    sdkIncludeRoot,
    sdkLibraryRoot,
    sdkBinaryRoot,
  });
}

export function assertNoRemoteWorkerBuildPathLeak(bytes, candidates) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError("PE bytes must be a Buffer.");
  }
  const caseFoldedBytes = foldAsciiCase(bytes);
  const normalizedCandidates = [...new Set(candidates)]
    .filter((candidate) => typeof candidate === "string" && candidate.length >= 3)
    .flatMap((candidate) => [candidate, candidate.replaceAll("\\", "/")]);
  for (const candidate of normalizedCandidates) {
    const ascii = foldAsciiCase(Buffer.from(candidate, "utf8"));
    const utf16 = foldAsciiCase(Buffer.from(candidate, "utf16le"));
    if (caseFoldedBytes.indexOf(ascii) >= 0 || caseFoldedBytes.indexOf(utf16) >= 0) {
      throw new Error("The remote-worker PE contains a forbidden build-identity string.");
    }
  }
}

function checkedFile(root, candidate, description) {
  const resolved = checkedDescendant(root, candidate, description);
  if (!fs.statSync(resolved, { bigint: false }).isFile()) {
    throw new Error(`${description} is not a regular file.`);
  }
  return resolved;
}

function checkedDescendant(root, candidate, description) {
  const resolvedRoot = realpath(root);
  const resolvedCandidate = realpath(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }
  throw new Error(`${description} escaped its pinned root.`);
}

function realpath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    throw new Error(`Required pinned toolchain path is missing: ${candidate}`);
  }
}

function foldAsciiCase(bytes) {
  const folded = Buffer.from(bytes);
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] >= 0x41 && folded[index] <= 0x5a) {
      folded[index] += 0x20;
    }
  }
  return folded;
}
