import assert from "node:assert/strict";
import { test } from "node:test";

import { USAGE_RECONCILIATION_GATEWAY_CORE_ACCOUNTING_ARGS } from "./usage-reconciliation-lane.mjs";

test("usage reconciliation runs the gateway-core Vitest suite through Vitest", () => {
  assert.deepEqual(USAGE_RECONCILIATION_GATEWAY_CORE_ACCOUNTING_ARGS, [
    "--filter",
    "@goatcitadel/gateway-core",
    "exec",
    "vitest",
    "run",
    "src/model-usage-accounting.test.ts",
  ]);
});
