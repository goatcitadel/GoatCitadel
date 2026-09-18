import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSelfConfigurationProofMatrix,
  SELF_CONFIGURATION_COMMANDS,
  SELF_CONFIGURATION_HELD_ROWS,
  runSelfConfigurationLane,
} from "./self-configuration-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("self-configuration lane exercises distinct owner, fault, UI, redaction, and typecheck rows", () => {
  const ids = SELF_CONFIGURATION_COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    "self-configuration.policy-owner-tests",
    "self-configuration.gateway-owner-fault-tests",
    "self-configuration.comparison-owner-tests",
    "self-configuration.storage-durable-tests",
    "self-configuration.ui-secure-control-tests",
    "self-configuration.comparison-ui-tests",
    "self-configuration.threaded-prompt-tests",
    "self-configuration.contract-redaction-tests",
    "self-configuration.owner-typechecks",
  ]);
  assert.ok(SELF_CONFIGURATION_COMMANDS.every((command) => !command.args.join(" ").includes("API_KEY")));
});

test("self-configuration proof matrix is fail-closed about evidence not produced by hermetic tests", () => {
  const proof = buildSelfConfigurationProofMatrix(
    SELF_CONFIGURATION_COMMANDS.map((command) => ({ scenarioId: command.id, exitCode: 0 })),
  );
  assert.equal(proof.result, "foundation_only");
  assert.equal(proof.secretMaterialAccepted, false);
  assert.deepEqual(
    proof.heldRows.map((row) => row.id),
    ["live-provider-probe", "packaged-process-restart", "browser-secure-input-journey", "live-workflow-skill-reuse", "fresh-workspace-browser-qa-pack"],
  );
  assert.ok(proof.heldRows.every((row) => row.status === "held"));
  assert.ok(proof.claimBoundary.includes("cannot be satisfied by mocks"));
  assert.equal(proof.commandOutcomes.length, SELF_CONFIGURATION_COMMANDS.length);
  assert.equal(SELF_CONFIGURATION_HELD_ROWS.length, 5);
});

test("comparison proof rows reference runnable owners and never replace live acceptance", () => {
  const ids = new Set(SELF_CONFIGURATION_COMMANDS.map(command => command.id));
  const proof = buildSelfConfigurationProofMatrix();
  const row = proof.hermeticRows.find(row => row.id === "comparison-onboarding-capture-packs");
  assert.ok(row);
  assert.ok(row.scenarioRefs.every(id => ids.has(id)));
  for (const command of SELF_CONFIGURATION_COMMANDS) {
    for (const file of command.args.filter(argument => /\.test\.tsx?$/u.test(argument))) {
      assert.ok(fs.existsSync(path.join(repoRoot, command.cwd ?? "", file)), `missing named test ${file}`);
    }
  }
  assert.ok(proof.heldRows.some(row => row.id === "live-workflow-skill-reuse"));
  assert.ok(proof.heldRows.some(row => row.id === "fresh-workspace-browser-qa-pack"));
});

test("every self-configuration command excludes configured secret environment keys", async () => {
  const commands = [];
  const ids = new Set(SELF_CONFIGURATION_COMMANDS.map(command => command.id));
  await runSelfConfigurationLane({ artifactRoot: "unused-self-configuration-fixture" }, {}, {
    path, repoRoot, pnpmCommand: () => "pnpm", clampString: value => value,
    emptyArtifacts: value => value, relativeToRun: (_context, value) => value,
    collectVerificationSecretEnvKeys: async root => { assert.equal(root, path.join(repoRoot, "config")); return ["FIXTURE_PROVIDER_TOKEN", "DATABASE_URL"]; },
    runCommand: async (_command, _args, options) => {
      commands.push(options);
      const definition = SELF_CONFIGURATION_COMMANDS.find(command => command.id === options.logName);
      assert.deepEqual(options.env, definition.env);
      return { code: 0, stdoutPath: "fixture.stdout.log", stderrPath: "fixture.stderr.log", durationMs: 0 };
    },
    runScenario: async (_context, scenario, operation) => { if (ids.has(scenario.id)) await operation(); },
  });
  assert.equal(commands.length, SELF_CONFIGURATION_COMMANDS.length);
  for (const command of commands) assert.deepEqual(command.omitEnv, ["FIXTURE_PROVIDER_TOKEN", "DATABASE_URL"]);
  const gateway = commands.find(command => command.logName === "self-configuration.gateway-owner-fault-tests");
  assert.deepEqual(gateway.env, { GOATCITADEL_SQLITE_SCHEMA_TEMPLATE: "1" });
  // Migration correctness keeps the ordinary fresh-database path in its own row.
  const storage = commands.find(command => command.logName === "self-configuration.storage-durable-tests");
  assert.equal(storage.env, undefined);
});

test("self-configuration lane is wired as a degraded reviewed lane and package command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const runner = fs.readFileSync(path.join(repoRoot, "scripts", "verification", "run.mjs"), "utf8");
  const scenarios = fs.readFileSync(path.join(repoRoot, "scripts", "verification", "lib", "scenarios.mjs"), "utf8");
  const lane = fs.readFileSync(
    path.join(repoRoot, "scripts", "verification", "lib", "scenarios", "self-configuration-lane.mjs"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["verify:self-configuration"],
    "node scripts/verification/run.mjs self-configuration",
  );
  assert.match(runner, /"self-configuration"/u);
  assert.match(runner, /runSelfConfigurationLane\(context/u);
  assert.match(scenarios, /runSelfConfigurationLaneImpl/u);
  assert.match(lane, /status: "degraded"/u);
  assert.match(lane, /runtime-configuration-approval-binding\.test\.ts/u);
  assert.match(lane, /evolution-control-plane-service\.test\.ts/u);
  assert.match(lane, /chat-change-plan-compatibility-service\.test\.ts/u);
  assert.match(lane, /chat\.change-plans\.test\.ts/u);
  assert.match(lane, /chat-change-plan-repo\.test\.ts/u);
  assert.match(lane, /change-plan\.test\.ts/u);
  assert.match(lane, /chat-secure-configuration-recovery-service\.test\.ts/u);
  assert.match(lane, /browser-tools\.manual-chromium\.test\.ts/u);
  assert.match(lane, /browser-tools-load-failure\.coverage\.test\.ts/u);
  assert.match(lane, /governed-remediation-managed-browser-adapter\.test\.ts/u);
  assert.match(lane, /governed-remediation-owned-gateway-service-adapter\.test\.ts/u);
  assert.match(lane, /governed-file-windows-handle-port\.test\.ts/u);
  assert.match(lane, /governed-remediation-budgets-mirror-recipe\.test\.ts/u);
  assert.doesNotMatch(lane, /exact-original-turn-crash-prompt-regeneration/u);
  assert.match(lane, /assertArtifactRedactionGate\(context\.artifactRoot\)/u);
});
