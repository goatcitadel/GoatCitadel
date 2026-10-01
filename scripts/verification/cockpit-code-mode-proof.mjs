import { execFileSync } from "node:child_process";
import path from "node:path";

import { runUsabilityBrowserActionBundles } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { createRunContext, finalizeRunContext, releaseRunContext, repoRoot } from "./lib/shared.mjs";

// Reuses the governed Code Mode owner probes in an isolated runtime while
// exercising the cockpit Chat controls in Chromium.
const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const context = await createRunContext("usability", { commandSelection: "cockpit-code-mode" });
try {
  await runUsabilityBrowserActionBundles(context, {
    baseSha,
    browserActionBundleIds: ["chat-agentic-durable-code"],
    cockpitCodeModeOnly: true,
    secretEnvKeys: await collectVerificationSecretEnvKeys(path.join(repoRoot, "config")),
  });
  const manifest = await finalizeRunContext(context);
  console.log(`Cockpit Code Mode proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally {
  await releaseRunContext(context);
}
