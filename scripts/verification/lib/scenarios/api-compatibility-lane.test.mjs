import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runApiCompatibilityLane } from "./api-compatibility-lane.mjs";

test("API compatibility proof starts its isolated stack with local operator authentication", async () => {
  let stackOptions;
  let stackStopped = false;

  await runApiCompatibilityLane(
    { artifactRoot: "C:/verification-artifacts" },
    {},
    {
      API_COMPAT_ALLOWLIST_PATH: "allowlist.json",
      API_COMPAT_BASELINE_PATH: "baseline.json",
      assertOk(response) {
        assert.equal(response.ok, true);
      },
      compareRealtimeContract: () => [],
      compareRestContract: () => [],
      emptyArtifacts: (artifacts) => artifacts,
      path,
      readJson: async () => ({}),
      relativeToRun: (_context, artifactPath) => artifactPath,
      requestJson: async () => ({ ok: true, status: 200, body: { paths: {} } }),
      runScenario: async (_context, _definition, scenario) => await scenario(),
      snapshotApiCompatibilityCurrentShellFacts: async () => ({ routes: {} }),
      snapshotRealtimeContract: async () => ({ eventTypes: [], envelopeFields: [] }),
      snapshotRestContract: () => ({}),
      startVerificationStack: async (_context, options) => {
        stackOptions = options;
        return { gatewayUrl: "http://gateway" };
      },
      stopVerificationStack: async () => {
        stackStopped = true;
      },
      writeJson: async () => undefined,
    },
  );

  assert.deepEqual(stackOptions, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: "verification-api-compat-operator-token",
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
    },
  });
  assert.equal(stackStopped, true);
});
