import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, lstat } from "node:fs/promises";
import { readComparisonJson, startComparisonSession } from "./lib/agent-comparison-session.mjs";
import { readNativeComparisonCheckout } from "./lib/agent-comparison-native-driver.mjs";
import { runFeatureAcceptance } from "./lib/agent-comparison-acceptance.mjs";
import { FEATURE_ACCEPTANCE_SUITE } from "./lib/agent-comparison-acceptance-fixtures.mjs";
import { sha256 } from "./lib/agent-comparison.mjs";
import { readFeatureAcceptanceAvailability } from "./lib/agent-comparison-acceptance-profile.mjs";
import {
  createAcceptanceSupervisor,
  prepareFeatureAcceptanceLaunch,
} from "./lib/agent-comparison-acceptance-supervisor.mjs";
import { writeNativeComparisonJson } from "./lib/agent-comparison-native-driver.mjs";

if (process.argv[2] === "--prepare-launch") {
  const [manifestPath, optionsPath, executablePath, operatorId, settingsPath, ...rest] = process.argv.slice(3);
  if (!settingsPath || rest.length || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(operatorId ?? ""))
    throw new Error("Usage: --prepare-launch MANIFEST OPTIONS NATIVE_EXECUTABLE OPERATOR_ID NEW_SETTINGS_JSON");
  const launch = await prepareFeatureAcceptanceLaunch({
    manifest: await readComparisonJson(path.resolve(manifestPath)),
    options: await readComparisonJson(path.resolve(optionsPath)),
    executablePath: path.resolve(executablePath),
  });
  await writeNativeComparisonJson(path.resolve(settingsPath), {
    executablePath: launch.executable.path,
    expectedLaunchSha256: launch.launchSha256,
    operatorId,
  });
  process.stdout.write(`Prepared launch ${launch.launchSha256}; no runtime or model was started.\n`);
  process.exit(0);
}

// Adapter code is explicitly selected and hash-reviewed by the operator. It
// must use the product's native owners; no model output selects this module.
const [
  manifestFile,
  optionsFile,
  outputDirectory,
  adapterFile,
  adapterSha256,
  supervisorFile,
  supervisorSha256,
  supervisorSettingsFile,
  ...extra
] = process.argv.slice(2);
if (
  !adapterSha256 ||
  extra.length ||
  !/^[a-f0-9]{64}$/u.test(adapterSha256) ||
  (supervisorFile === "--shipped-supervisor"
    ? !supervisorSha256 || Boolean(supervisorSettingsFile)
    : Boolean(supervisorFile) !== Boolean(supervisorSha256))
)
  throw new Error(
    "Usage: node scripts/verification/agent-comparison-acceptance.mjs MANIFEST OPTIONS NEW_CELL_DIRECTORY REVIEWED_ADAPTER_MJS ADAPTER_SHA256 --shipped-supervisor SETTINGS_JSON (or REVIEWED_SUPERVISOR_MJS SUPERVISOR_SHA256 SETTINGS_JSON)",
  );
const manifest = await readComparisonJson(path.resolve(manifestFile));
const options = await readComparisonJson(path.resolve(optionsFile));
if (manifest.suite !== FEATURE_ACCEPTANCE_SUITE)
  throw new Error("Prepare the explicit feature acceptance suite first.");
async function reviewedModule(moduleFile, expectedHash) {
  const filename = path.resolve(moduleFile),
    stat = await lstat(filename);
  if (
    !/^[a-f0-9]{64}$/u.test(expectedHash ?? "") ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 1024 * 1024 ||
    !filename.endsWith(".mjs") ||
    sha256(await readFile(filename)) !== expectedHash
  )
    throw new Error("The reviewed native module changed or is not an ordinary bounded module.");
  return import(pathToFileURL(filename).href);
}
const adapter = await reviewedModule(adapterFile, adapterSha256);
const shippedSupervisor = supervisorFile === "--shipped-supervisor";
const supervisorModule = shippedSupervisor
  ? { createAcceptanceSupervisor }
  : supervisorFile
    ? await reviewedModule(supervisorFile, supervisorSha256)
    : undefined;
const settingsFile = shippedSupervisor ? supervisorSha256 : supervisorSettingsFile;
const supervisorSettings = settingsFile ? await readComparisonJson(path.resolve(settingsFile)) : undefined;
const product = options.cellId.split(":")[0],
  taskId = options.cellId.split(":")[1];
if (
  adapter.product !== product ||
  adapter.revision !== manifest.products[product]?.revision ||
  typeof adapter.createAcceptanceActions !== "function"
)
  throw new Error("Acceptance adapter does not match the pinned product revision.");
const session = await startComparisonSession({
  manifest,
  options,
  campaignDirectory: path.dirname(path.resolve(manifestFile)),
  outputDirectory: path.resolve(outputDirectory),
  upstreamApiKey: process.env[options.apiKeyEnv],
  checkout: await readNativeComparisonCheckout(options.checkoutRoot),
});
try {
  if (supervisorModule && typeof supervisorModule.createAcceptanceSupervisor !== "function")
    throw new Error("The reviewed supervisor has no native lifecycle factory.");
  const availability = readFeatureAcceptanceAvailability(product, taskId, manifest.products[product]);
  const supervisor =
    availability.status === "supported"
      ? await supervisorModule?.createAcceptanceSupervisor({ session, manifest, options, settings: supervisorSettings })
      : undefined;
  const actions =
    availability.status === "supported"
      ? await adapter.createAcceptanceActions({ session, manifest, options, supervisor })
      : { availability };
  const result = await runFeatureAcceptance({ taskId, session, actions, source: "native_receipts" });
  process.stdout.write(
    `Retained ${result.execution.nativeReceipts.length} native phases. Run agent-comparison-record.mjs with the exported campaign and pilot journals; no task is passed by this runner.\n`,
  );
} finally {
  await session.close();
}
