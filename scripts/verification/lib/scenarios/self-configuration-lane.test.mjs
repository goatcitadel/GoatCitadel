import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSelfConfigurationProofMatrix,
  SELF_CONFIGURATION_COMMANDS,
  SELF_CONFIGURATION_HELD_ROWS,
} from "./self-configuration-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("self-configuration lane exercises distinct owner, fault, UI, redaction, and typecheck rows", () => {
  const ids = SELF_CONFIGURATION_COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    "self-configuration.policy-owner-tests",
    "self-configuration.gateway-owner-fault-tests",
    "self-configuration.storage-durable-tests",
    "self-configuration.ui-secure-control-tests",
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
    ["live-provider-probe", "packaged-process-restart", "browser-secure-input-journey"],
  );
  assert.ok(proof.heldRows.every((row) => row.status === "held"));
  assert.ok(proof.claimBoundary.includes("cannot be satisfied by mocks"));
  assert.equal(proof.commandOutcomes.length, SELF_CONFIGURATION_COMMANDS.length);
  assert.equal(SELF_CONFIGURATION_HELD_ROWS.length, 3);
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
  assert.match(lane, /chat-secure-configuration-recovery-service\.test\.ts/u);
  assert.match(lane, /browser-tools\.manual-chromium\.test\.ts/u);
  assert.match(lane, /browser-tools-load-failure\.coverage\.test\.ts/u);
  assert.match(lane, /governed-remediation-managed-browser-adapter\.test\.ts/u);
  assert.doesNotMatch(lane, /exact-original-turn-crash-prompt-regeneration/u);
  assert.match(lane, /assertArtifactRedactionGate\(context\.artifactRoot\)/u);
});
