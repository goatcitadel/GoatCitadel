import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_LANE_COMMANDS } from "./scenarios.mjs";

test("fast verification lane keeps required fast commands", () => {
  const commandArgs = new Set(FAST_LANE_COMMANDS.map((command) => command.args.join(" ")));

  for (const expected of [
    "verify:repo:hygiene",
    "verify:storage:migration-parity",
    "--filter @goatcitadel/extensions-sdk build",
    "typecheck",
    "test",
    "smoke",
    "build",
    "docs:check",
  ]) {
    assert.ok(commandArgs.has(expected), `fast lane should include ${expected}`);
  }
});
