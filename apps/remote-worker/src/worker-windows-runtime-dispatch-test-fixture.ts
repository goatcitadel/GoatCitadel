import { remoteWorkerRuntimeBundleManifestSha256 } from "@goatcitadel/contracts";

export function windowsRuntimeDispatchFixture() {
  const jobName = `gc-cell-${"1".repeat(32)}`, root = `C:\\cells\\${jobName}`;
  const identity = (digit: string) => "1".repeat(16) + digit.repeat(32);
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
    files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }] };
  return { nonce: "9".repeat(64), anchor: { fileIdentity: identity("6"), preparedSha256: "7".repeat(64) }, checkpointSha256: "8".repeat(64),
    inventoryLimits: { maxEntries: 20000, maxDepth: 64, wallMs: 10000 },
    launch: { jobName, appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`, image: `${root}\\runtime\\entry.exe`,
      commandLine: `"${root}\\runtime\\entry.exe" serve`, directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`,
      imageSha256: "a".repeat(64), directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"), runtimeBundle,
      runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { SystemRoot: "C:\\Windows" },
      limits: { processLimit: 1, memoryBytes: 64 * 1024 * 1024, cpuMilli: 1000, wallMs: 150000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 4096 },
      protectedWorkspace: { parentPath: "C:\\cells", parentIdentity: identity("1"), rootIdentity: identity("2"), controlIdentity: identity("3"),
        runtimeIdentity: identity("4"), workIdentity: identity("5"), ownerSid: "S-1-5-21-1-2-3-1001", controllerSid: "S-1-5-80-1-2-3-4-5" } } };
}
