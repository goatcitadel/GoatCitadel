import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { comparisonTasks } from "./lib/agent-comparison.mjs";
import { FEATURE_ACCEPTANCE_SUITE } from "./lib/agent-comparison-acceptance-fixtures.mjs";
import { readComparisonJson } from "./lib/agent-comparison-session.mjs";
import {
  createComparisonPilot,
  pilotFeatureAcceptance,
  preparePilotComparison,
} from "./lib/agent-comparison-pilot.mjs";

const [operation, first, second, third, ...extra] = process.argv.slice(2);
if (
  extra.length ||
  !first ||
  (operation === "init" ? second || third : !["prepare", "prepare-acceptance"].includes(operation) || !second || !third)
)
  throw new Error(
    "Usage: node scripts/verification/agent-comparison-pilot.mjs init NEW_PILOT_DIRECTORY | prepare|prepare-acceptance PILOT_JSON CONFIG_JSON NEW_CAMPAIGN_DIRECTORY",
  );
const write = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
if (operation === "init") {
  const directory = path.resolve(first);
  const pilot = createComparisonPilot({
    pilotId: randomUUID(),
    hostedBudgetDirectory: path.join(directory, "hosted-budget"),
  });
  await mkdir(directory, { recursive: false });
  await mkdir(pilot.hostedBudget.directory);
  await mkdir(path.join(directory, "local-budget"));
  await write(path.join(directory, "pilot.json"), pilot);
  await write(path.join(directory, "feature-acceptance.json"), pilotFeatureAcceptance(pilot));
  process.stdout.write(
    "Prepared the $25/450-request hosted pilot and separate 450-request local track. No model was contacted. Reuse this pilot for every baseline and retest; do not initialize another budget.\n",
  );
} else {
  const pilot = await readComparisonJson(path.resolve(first));
  const config = await readComparisonJson(path.resolve(second));
  const manifest = preparePilotComparison(pilot, {
    ...config,
    ...(operation === "prepare-acceptance" ? { suite: FEATURE_ACCEPTANCE_SUITE } : {}),
  });
  if (manifest.localPilotBudget) await mkdir(manifest.localPilotBudget.directory, { recursive: true });
  const directory = path.resolve(third);
  await mkdir(directory, { recursive: false });
  await write(path.join(directory, "manifest.json"), manifest);
  await write(path.join(directory, "fixtures.json"), comparisonTasks(manifest));
  await write(path.join(directory, "receipts.json"), []);
  process.stdout.write(
    `Prepared ${manifest.cells.length} unrun cells. Hosted campaigns retain the shared pilot budget; local provider dollars are zero.\n`,
  );
}
