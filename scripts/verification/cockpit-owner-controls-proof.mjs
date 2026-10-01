import path from "node:path";
import { runUxBudgetsLane } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { selectCockpitOwnerProofs } from "./lib/scenarios/ux-budgets-lane.mjs";
import { createRunContext, finalizeRunContext, releaseRunContext, repoRoot } from "./lib/shared.mjs";

const selected = process.argv.slice(2);
const ownerControlSubset = selected.length ? selected : undefined;
selectCockpitOwnerProofs(ownerControlSubset);
const context = await createRunContext("ux-budgets", {
  commandSelection: ownerControlSubset ? `cockpit-owner-controls:${ownerControlSubset.join(",")}` : "cockpit-owner-controls",
});
try {
  await runUxBudgetsLane(context, {
    ownerControlsOnly: true,
    ownerControlSubset,
    secretEnvKeys: await collectVerificationSecretEnvKeys(path.join(repoRoot, "config")),
  });
  const manifest = await finalizeRunContext(context);
  console.log(`Cockpit owner controls proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally {
  await releaseRunContext(context);
}
