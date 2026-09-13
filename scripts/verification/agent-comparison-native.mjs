import path from "node:path";
import {
  assertNativeApprovalTerminal,
  startNativeApprovalConsole,
} from "./lib/agent-comparison-native-approval-console.mjs";
import { readComparisonJson } from "./lib/agent-comparison-session.mjs";
import {
  prepareNativeComparisonLaunch,
  runNativeComparison,
  writeNativeComparisonJson,
} from "./lib/agent-comparison-native-driver.mjs";

const [command, manifestFile, optionsFile, ...args] = process.argv.slice(2);
if (!manifestFile || !optionsFile || !["prepare", "run"].includes(command))
  throw new Error(
    "Usage: agent-comparison-native.mjs prepare MANIFEST OPTIONS NATIVE_EXECUTABLE NEW_LAUNCH_JSON | run MANIFEST OPTIONS LAUNCH_JSON REVIEW_JSON NEW_CELL_DIRECTORY",
  );
const manifest = await readComparisonJson(path.resolve(manifestFile));
const options = await readComparisonJson(path.resolve(optionsFile));
if (command === "prepare") {
  if (args.length !== 2)
    throw new Error("Prepare requires the native Node/Python executable and a new launch JSON filename.");
  const launch = await prepareNativeComparisonLaunch({
    manifest,
    cellId: options.cellId,
    checkoutRoot: options.checkoutRoot,
    executablePath: path.resolve(args[0]),
    approvalGateway: options.nativeApprovalGateway ?? false,
    interactiveCli: options.nativeInteractiveCli ?? false,
    skillWorkflow: options.nativeSkillWorkflow ?? false,
  });
  await writeNativeComparisonJson(path.resolve(args[1]), launch);
  process.stdout.write(
    `Native launch prepared: ${path.resolve(args[1])}\nLaunch SHA-256: ${launch.launchSha256}\nNo product process or provider request was started.\n`,
  );
  process.stdout.write(
    "Review the native config and permissions. A run requires a separate review JSON with schemaVersion, launchSha256, effectiveConfigSha256, nativePolicyReviewed: true, credentialIsolationReviewed: true, reviewedBy, and reviewedAt.\n",
  );
} else {
  if (args.length !== 3)
    throw new Error("Run requires the retained launch, operator review, and a new cell directory.");
  const launch = await readComparisonJson(path.resolve(args[0]));
  const review = await readComparisonJson(path.resolve(args[1]));
  if (options.nativeApprovalGateway === true || options.nativeInteractiveCli === true) assertNativeApprovalTerminal();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runNativeComparison({
      manifest,
      campaignDirectory: path.dirname(path.resolve(manifestFile)),
      outputDirectory: path.resolve(args[2]),
      options,
      launch,
      review,
      upstreamApiKey: process.env[options.apiKeyEnv],
      signal: controller.signal,
      ...(options.nativeApprovalGateway === true ? { onApprovalReady: startNativeApprovalConsole } : {}),
      ...((options.nativeApprovalGateway === true &&
        (options.cellId.startsWith("goatcitadel:") || options.nativeSkillWorkflow === true)) ||
      options.nativeInteractiveCli === true
        ? { onNativeOutput: (chunk) => process.stdout.write(chunk) }
        : {}),
    });
    process.stdout.write(
      `Native process finished: ${result.receipt.stopReason}; exit ${result.receipt.exitCode}.\nEvidence: ${result.evidenceDirectory}\nTask outcome remains unverified until the independent verifier is run.\n`,
    );
    if (
      result.receipt.exitCode !== 0 ||
      result.receipt.stopReason !== "process_exit" ||
      result.transport.status === "unsettled_provider_cost"
    )
      process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
