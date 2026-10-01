import { execFileSync } from "node:child_process";
import path from "node:path";

import { runUsabilityBrowserActionBundles } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { createRunContext, finalizeRunContext, releaseRunContext, repoRoot } from "./lib/shared.mjs";

const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const context = await createRunContext("usability", { commandSelection: "cockpit-chat-stream-reload" });
try {
  await runUsabilityBrowserActionBundles(context, {
    baseSha,
    browserActionBundleIds: ["chat-lifecycle"],
    cockpitStreamReloadOnly: true,
    secretEnvKeys: await collectVerificationSecretEnvKeys(path.join(repoRoot, "config")),
  });
  const manifest = await finalizeRunContext(context);
  console.log(`Cockpit Chat stream reload proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally {
  await releaseRunContext(context);
}
