import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { canonicalJsonString } from "../../packages/contracts/src/index.js";
import { RemoteWorkerInstalledTreeScanner } from "../../apps/gateway/src/services/remote-worker-installed-tree-scanner.js";
const packageSha256 = "d80b8d70375b40962947689e2cfc4787ae28aa9dc64a8ebc9e0fed3c5559256b";
const root = "C:\\ProgramData\\GoatCitadel\\RemoteWorker\\payload";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function main(): Promise<void> {
  if (process.platform !== "win32" || hostname() !== "GOATBOX") throw new Error("GOATBOX only.");
  const output = process.argv[2];
  if (
    !output ||
    !/^C:\\worker-evidence\\installed-survey-[0-9-]+\\installed-survey\.json$/u.test(output) ||
    win32.normalize(output) !== output
  )
    throw new Error("Unexpected survey output path.");
  // This digest binds the preliminary survey to its package, NOT to an issued runtime manifest.
  const survey = await new RemoteWorkerInstalledTreeScanner(packageSha256, () => new Date(), {
    windowsPackageManifestSha256: packageSha256,
  }).scan({ root, maxFileCount: 10000, maxFileBytes: 536870912, maxTotalBytes: 2147483648 });
  const summary = {
    schemaVersion: "goatcitadel.goatbox-installed-survey.v1",
    purpose: "pre-signing inventory survey",
    admissionReady: false,
    packageSha256,
    treeSha256: survey.treeSha256,
    rootIdentitySha256: hash(survey.rootIdentity),
    fileCount: survey.files.length,
    totalBytes: survey.totalBytes,
    bundleSha256: survey.files.find((f) => f.role === "bundle")!.sha256,
    dependencyLockSha256: survey.files.find((f) => f.role === "dependency_lock")!.sha256,
    launcherSha256: survey.files.find((f) => f.role === "launcher")!.sha256,
    vendorTreeSha256: hash(
      canonicalJsonString({
        schemaVersion: "goatcitadel.remote-worker-vendor-tree.v1",
        files: survey.files.filter((f) => f.role === "vendor"),
      }),
    ),
  };
  await writeFile(output, JSON.stringify({ ...summary, survey }, null, 2), { flag: "wx" });
  console.log(JSON.stringify(summary, null, 2));
  console.log("Public evidence: " + output);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Survey failed.");
  process.exitCode = 1;
});
