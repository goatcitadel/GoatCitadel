import fs from "node:fs";
import path from "node:path";

/**
 * Script tests that compile, sign or launch the native Windows remote-worker
 * toolchain (MSVC/ASan builds, AppContainer launches, real pipes and volumes).
 * Each costs 12s-300s on Windows and together they were ~95% of repo hygiene's
 * test time (~68 of ~73 test-minutes on the 2026-10-02 fast run). Every native
 * body skips off win32, so Linux CI keeps running these files in the hygiene
 * suite for their portable tests; only Windows hosts move them to the dedicated
 * `verify:remote-worker:windows` suite.
 *
 * Add a file here when it drives the native toolchain; the partition test fails
 * when a listed file disappears so this list cannot silently go stale.
 */
export const NATIVE_WINDOWS_SCRIPT_TEST_FILES = Object.freeze([
  "scripts/packaging/build-remote-worker-provisioner-windows-native.test.mjs",
  "scripts/packaging/build-remote-worker-windows-cell-controller.test.mjs",
  "scripts/packaging/build-remote-worker-windows-tls.test.mjs",
  "scripts/packaging/remote-worker-runtime-install-authority.test.mjs",
  "scripts/packaging/remote-worker-runtime-install-wire.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-backing-capacity.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-capacity.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-controller-client-identity.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-controller-identity.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-controller-protocol.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-controller-transport.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-format.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-helper-protocol.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-installed-pool.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-joined-capacity-wire.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-mount-target.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-mount.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-mounted-capacity.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-mounted-workspace.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-protection.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-provisioning.test.mjs",
  "scripts/packaging/remote-worker-windows-cell-volume.test.mjs",
  "scripts/packaging/remote-worker-windows-cell.test.mjs",
  "scripts/packaging/remote-worker-windows-files.test.mjs",
  "scripts/packaging/remote-worker-windows-host.test.mjs",
  "scripts/packaging/remote-worker-windows-install-capacity-challenge.test.mjs",
  "scripts/packaging/remote-worker-windows-install-capacity-pipe.test.mjs",
  "scripts/packaging/remote-worker-windows-install-capacity.test.mjs",
  "scripts/packaging/remote-worker-windows-install-client.test.mjs",
  "scripts/packaging/remote-worker-windows-runtime-helper-build.test.mjs",
  "scripts/packaging/remote-worker-windows-runtime-result.test.mjs",
  "scripts/packaging/remote-worker-windows-runtime-retention.test.mjs",
  "scripts/packaging/remote-worker-windows-runtime-session.test.mjs",
  "scripts/packaging/remote-worker-windows-runtime-streams.test.mjs",
  "scripts/packaging/remote-worker-windows-runtime-transfer.test.mjs",
  "scripts/packaging/remote-worker-windows-state-layout.test.mjs",
  "scripts/packaging/remote-worker-windows-stdio.test.mjs",
  "scripts/remote-worker/worker-service-install.test.mjs",
]);

export const SCRIPT_TEST_SUITES = Object.freeze(["hygiene", "native-windows"]);

/** Every `scripts/**\/*.test.mjs` file as a sorted, forward-slash, repo-relative path. */
export function listScriptTestFiles(repoRoot) {
  const files = [];
  const visit = (relativeDir) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(relative);
    }
  };
  visit("scripts");
  return files.sort();
}

/**
 * Selects one suite's files. On win32 the native files belong only to the
 * native suite; elsewhere hygiene keeps every file (native bodies skip there)
 * and the native suite is empty, so no host loses a portable test.
 */
export function selectScriptTestFiles(allFiles, suite, platform = process.platform) {
  if (!SCRIPT_TEST_SUITES.includes(suite)) {
    throw new Error(`Unknown script test suite "${suite}". Expected one of: ${SCRIPT_TEST_SUITES.join(", ")}.`);
  }
  const native = new Set(NATIVE_WINDOWS_SCRIPT_TEST_FILES);
  const missing = NATIVE_WINDOWS_SCRIPT_TEST_FILES.filter((file) => !allFiles.includes(file));
  if (missing.length > 0) {
    throw new Error(`Native Windows script test list names missing file(s): ${missing.join(", ")}.`);
  }
  if (suite === "native-windows") {
    return platform === "win32" ? allFiles.filter((file) => native.has(file)) : [];
  }
  return platform === "win32" ? allFiles.filter((file) => !native.has(file)) : [...allFiles];
}
