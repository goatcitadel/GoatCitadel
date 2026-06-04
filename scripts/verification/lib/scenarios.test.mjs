import assert from "node:assert/strict";
import { test } from "node:test";
import { A2A_FULL_LANE_COMMANDS, FAST_LANE_COMMANDS } from "./scenarios.mjs";

test("fast verification lane keeps required fast commands", () => {
  const commandArgs = new Set(FAST_LANE_COMMANDS.map((command) => command.args.join(" ")));

  for (const expected of [
    "verify:repo:hygiene",
    "verify:storage:migration-parity",
    "--filter @goatcitadel/extensions-sdk build",
    "typecheck",
    "-r --workspace-concurrency=1 test",
    "smoke",
    "build",
    "docs:check",
  ]) {
    assert.ok(commandArgs.has(expected), `fast lane should include ${expected}`);
  }
});

test("A2A full lane keeps governed gateway and contract proof commands", () => {
  const commandArgs = new Set(A2A_FULL_LANE_COMMANDS.map((command) => command.args.join(" ")));

  for (const expected of [
    "--filter @goatcitadel/contracts build",
    "--filter @goatcitadel/storage build",
    "verify:storage:migration-parity",
    "--filter @goatcitadel/mission-control-shared build",
    "--filter @goatcitadel/gateway typecheck",
    "--filter @goatcitadel/gateway exec vitest run src/services/a2a-grpc-service.test.ts src/services/a2a-route-service.test.ts src/routes/tasks.test.ts",
  ]) {
    assert.ok(commandArgs.has(expected), `A2A full lane should include ${expected}`);
  }
});
