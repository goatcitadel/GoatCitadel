import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHAT_EVOLUTION_COMMANDS,
  CHAT_EVOLUTION_HELD_ROWS,
  buildChatEvolutionProofMatrix,
  runChatEvolutionLane,
} from "./chat-evolution-lane.mjs";
import { runSelfConfigurationLane } from "./self-configuration-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

test("chat evolution lane extends self-configuration with every governed vertical", () => {
  const ids = CHAT_EVOLUTION_COMMANDS.map((command) => command.id);
  assert.deepEqual(ids, [
    "chat-evolution.contract-and-model-tool",
    "chat-evolution.policy-model-tool",
    "chat-evolution.gateway-control-plane",
    "chat-evolution.storage-parity",
    "chat-evolution.chat-controls",
    "chat-evolution.settings-channel-controls",
    "chat-evolution.desktop-and-installer-boundary",
  ]);
  const serialized = JSON.stringify(CHAT_EVOLUTION_COMMANDS);
  for (const required of [
    "evolution-control-plane-service.test.ts",
    "channel-secret-custody-service.test.ts",
    "capability-candidate-change-plan-adapter.test.ts",
    "product-source-apply-supervisor.test.ts",
    "change-plan-repo.test.ts",
    "ChatChangePlanActionDialog.test.tsx",
    "SettingsNativePage.test.tsx",
    "packaged-update-guard.test.mjs",
  ]) {
    assert.match(serialized, new RegExp(required.replaceAll(".", "\\."), "u"));
  }
});

test("chat evolution proof remains held at real runtime and signing boundaries", () => {
  assert.deepEqual(CHAT_EVOLUTION_HELD_ROWS.map((row) => row.id), [
    "real-provider-onboarding",
    "browser-secure-input",
    "windows-source-restart-rollback",
    "signed-packaged-update",
  ]);
  const proof = buildChatEvolutionProofMatrix([{ scenarioId: "probe", exitCode: 0 }]);
  assert.equal(proof.extends, "verify:self-configuration");
  assert.equal(proof.result, "foundation_only");
  assert.equal(proof.heldRows.length, 4);
  assert.equal(proof.commandOutcomes[0]?.exitCode, 0);
});

test("chat evolution lane is wired into the package command, verification runner, and release gate", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const runner = fs.readFileSync(path.join(repoRoot, "scripts", "verification", "run.mjs"), "utf8");
  const scenarios = fs.readFileSync(path.join(repoRoot, "scripts", "verification", "lib", "scenarios.mjs"), "utf8");
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "verification-1-0-release-proof.yml"),
    "utf8",
  );
  assert.equal(packageJson.scripts["verify:chat-evolution"], "node scripts/verification/run.mjs chat-evolution");
  assert.match(runner, /"chat-evolution"/u);
  assert.match(runner, /runChatEvolutionLane/u);
  assert.match(scenarios, /runChatEvolutionLaneImpl/u);
  assert.match(workflow, /laneScript: verify:chat-evolution\s+artifactSlug: chat-evolution/u);
});

const hermeticCases = [
  { label: "all commands pass", chatStatus: "passed", selfConfigurationStatus: "passed" },
  {
    label: "a Chat Evolution command fails",
    failedCommand: "chat-evolution.gateway-control-plane",
    chatStatus: "failed",
    selfConfigurationStatus: "passed",
  },
  {
    label: "a self-configuration command fails",
    failedCommand: "self-configuration.policy-owner-tests",
    chatStatus: "passed",
    selfConfigurationStatus: "failed",
  },
  {
    label: "a command outcome is missing",
    omittedCommand: "chat-evolution.storage-parity",
    chatStatus: "failed",
    selfConfigurationStatus: "passed",
  },
];

for (const { label, failedCommand, omittedCommand, chatStatus, selfConfigurationStatus } of hermeticCases) {
  test(`Chat Evolution gate keeps live acceptance held when ${label}`, async () => {
    const results = new Map();
    const matrices = [];
    const secretEnvKeys = ["FIXTURE_PROVIDER_TOKEN", "DATABASE_URL"];
    const deps = {
      path,
      repoRoot,
      pnpmCommand: () => "pnpm",
      collectVerificationSecretEnvKeys: async () => secretEnvKeys,
      clampString: (value) => value,
      emptyArtifacts: (value = {}) => value,
      relativeToRun: (_context, value) => value,
      writeJson: async (_file, value) => matrices.push(value),
      runCommand: async (_command, _args, options) => {
        assert.deepEqual(options.omitEnv, secretEnvKeys);
        return {
          code: options.logName === failedCommand ? 1 : 0,
          stderr: "command diagnostic",
          stdoutPath: "stdout.log",
          stderrPath: "stderr.log",
          durationMs: 1,
        };
      },
      runScenario: async (_context, scenario, run) => {
        // Exact-root redaction is exercised separately from proof orchestration.
        if (!scenario.id.endsWith(".artifact-redaction") && scenario.id !== omittedCommand) {
          results.set(scenario.id, await run());
        }
      },
    };
    const context = { artifactRoot: "proof" };
    await runChatEvolutionLane(context, {}, deps);
    assert.equal(results.get("chat-evolution.acceptance-boundary")?.status, chatStatus);
    assert.equal(results.get("self-configuration.acceptance-boundary")?.status, selfConfigurationStatus);
    if (failedCommand) assert.equal(results.get(failedCommand)?.status, "failed");
    assert.deepEqual(
      matrices.map((matrix) => matrix.result),
      ["foundation_only", "foundation_only"],
    );
    assert.deepEqual(
      matrices.map((matrix) => matrix.heldRows.length),
      [5, 4],
    );
    assert.ok(matrices.every((matrix) => matrix.heldRows.every((row) => row.status === "held")));

    if (!failedCommand && !omittedCommand) {
      await runSelfConfigurationLane(context, {}, deps);
      assert.equal(results.get("self-configuration.acceptance-boundary")?.status, "degraded");
    }
  });
}
