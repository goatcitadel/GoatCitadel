import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHAT_EVOLUTION_COMMANDS,
  CHAT_EVOLUTION_HELD_ROWS,
  buildChatEvolutionProofMatrix,
} from "./chat-evolution-lane.mjs";

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

test("chat evolution lane is wired into the package command and verification runner", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const runner = fs.readFileSync(path.join(repoRoot, "scripts", "verification", "run.mjs"), "utf8");
  const scenarios = fs.readFileSync(path.join(repoRoot, "scripts", "verification", "lib", "scenarios.mjs"), "utf8");
  assert.equal(packageJson.scripts["verify:chat-evolution"], "node scripts/verification/run.mjs chat-evolution");
  assert.match(runner, /"chat-evolution"/u);
  assert.match(runner, /runChatEvolutionLane/u);
  assert.match(scenarios, /runChatEvolutionLaneImpl/u);
});
