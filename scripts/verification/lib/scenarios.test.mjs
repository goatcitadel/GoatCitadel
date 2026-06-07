import assert from "node:assert/strict";
import { test } from "node:test";
import { A2A_FULL_LANE_COMMANDS, FAST_LANE_COMMANDS, deriveProviderStatus } from "./scenarios.mjs";

test("fast verification lane keeps required fast commands", () => {
  const commandArgs = new Set(FAST_LANE_COMMANDS.map((command) => command.args.join(" ")));

  for (const expected of [
    "verify:repo:hygiene",
    "verify:storage:migration-parity",
    "--filter @goatcitadel/extensions-sdk build",
    "verify:extensions:package",
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

test("provider truth status fails configured auth, route, and protocol errors", () => {
  assert.equal(deriveProviderStatus({ ok: true }), "passed");
  assert.equal(deriveProviderStatus({ error: "missing OpenAI API key" }), "not_configured");
  assert.equal(
    deriveProviderStatus({ error: "missing OpenAI API key" }, { providerConfigured: true }),
    "failed",
  );

  for (const error of [
    "invalid API key",
    "authentication_error: unauthorized",
    "404 model not found",
    "response_format protocol mismatch",
    "bad request: tools are not available",
  ]) {
    assert.equal(deriveProviderStatus({ error }, { providerConfigured: true }), "failed");
  }

  for (const error of ["unsupported provider feature", "model not supported", "model unavailable now"]) {
    assert.equal(deriveProviderStatus({ error }, { providerConfigured: true }), "degraded");
  }
});
